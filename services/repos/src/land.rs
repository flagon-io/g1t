//! Landing a pull request: moving a repository's branch forward to a commit
//! from a fork, or from another of its own branches.
//!
//! The Artifacts binding cannot write, so this speaks git's smart HTTP
//! protocol directly. It asks the fork for a pack holding exactly the
//! objects the target is missing, then pushes that pack to the target
//! unchanged. No object is parsed or rebuilt along the way. When landing,
//! the pack streams from one to the other as it arrives
//! ([`fast_forward`]): it is never held whole, however large the pull
//! request (pack_limits.rs `Sideband`).

use std::cell::RefCell;
use std::rc::Rc;

use futures_util::StreamExt;
use g1t_contracts::repos::GitAccess;
use worker::js_sys::Uint8Array;
use worker::wasm_bindgen::JsValue;
use worker::{Error, Fetch, Headers, Method, Request, RequestInit, Response, Result};

use crate::meters;
use crate::pack_limits::Sideband;

const ZERO_ID: &str = "0000000000000000000000000000000000000000";
const FLUSH: &[u8] = b"0000";
/// Side-band channels: pack data, and fatal errors.
const PACK_BAND: u8 = 1;
const ERROR_BAND: u8 = 3;

/// A pack with no objects: what a push that only points a ref at a commit
/// the repository already has sends.
pub const EMPTY_PACK: &[u8] = &[
    b'P', b'A', b'C', b'K', 0, 0, 0, 2, 0, 0, 0, 0, 0x02, 0x9d, 0x08, 0x82, 0x3b, 0xd8, 0xa8,
    0xea, 0xb5, 0x10, 0xad, 0x6a, 0xc7, 0x5c, 0x82, 0x3c, 0xfd, 0x3e, 0xd3, 0x1e,
];

fn pkt_line(payload: &str) -> Vec<u8> {
    format!("{:04x}{payload}", payload.len() + 4).into_bytes()
}

/// The meter for g1t's own request to `service` (meters.rs).
fn meter(service: &str) -> &'static str {
    if service == "git-receive-pack" { "internal.git.receive_pack" } else { "internal.git.fetch" }
}

/// Sends `body` to `service` on the store, answered in full or an error.
async fn send(access: &GitAccess, service: &str, body: JsValue, sent: u64) -> Result<Response> {
    let headers = Headers::new();
    headers.set("authorization", &format!("Bearer {}", access.token))?;
    headers.set("content-type", &format!("application/x-{service}-request"))?;
    headers.set("accept", &format!("application/x-{service}-result"))?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post).with_headers(headers).with_body(Some(body));
    let request = Request::new_with_init(&format!("{}/{service}", access.remote), &init)?;
    let mut response = Fetch::Request(request).send().await?;
    meters::record_remote(meter(service), &access.remote, sent, 0);
    if response.status_code() != 200 {
        let text = response.text().await.unwrap_or_default();
        return Err(Error::RustError(format!("{service} returned {}: {text}", response.status_code())));
    }
    Ok(response)
}

async fn post(access: &GitAccess, service: &str, body: Vec<u8>) -> Result<Vec<u8>> {
    let sent = body.len() as u64;
    let mut response = send(access, service, Uint8Array::from(body.as_slice()).into(), sent).await?;
    let bytes = response.bytes().await?;
    if let Some(key) = crate::store::key_from_remote(&access.remote) {
        meters::record_bytes(meter(service), &key, 0, bytes.len() as u64);
    }
    Ok(bytes)
}

/// The payloads of the pkt-lines in `bytes`, and the offset where they stop.
pub(crate) fn read_pkt_lines(bytes: &[u8]) -> (Vec<&[u8]>, usize) {
    let mut lines = Vec::new();
    let mut position = 0;
    while position + 4 <= bytes.len() {
        let Some(length) = std::str::from_utf8(&bytes[position..position + 4])
            .ok()
            .and_then(|hex| usize::from_str_radix(hex, 16).ok())
        else {
            break;
        };
        if length < 4 {
            // Flush, delimiter and response-end packets carry no payload.
            position += 4;
            continue;
        }
        let end = (position + length).min(bytes.len());
        lines.push(&bytes[position + 4..end]);
        position = end;
    }
    (lines, position)
}

/// The upload-pack request for everything reachable from `want` that is
/// not reachable from `have`.
fn want_request(want: &str, have: Option<&str>) -> Vec<u8> {
    // Side-band framing puts the pack in its own channel, so its exact bytes
    // can be recovered. Without it the response ends in a stray flush packet
    // that a receiver rejects as junk after the pack.
    let mut body = pkt_line(&format!("want {want} side-band-64k\n"));
    body.extend_from_slice(FLUSH);
    if let Some(have) = have {
        body.extend(pkt_line(&format!("have {have}\n")));
    }
    body.extend(pkt_line("done\n"));
    body
}

/// A pack holding everything reachable from `want` that is not reachable
/// from `have`.
pub(crate) async fn fetch_pack(source: &GitAccess, want: &str, have: Option<&str>) -> Result<Vec<u8>> {
    let response = post(source, "git-upload-pack", want_request(want, have)).await?;
    unpack_sideband(&response)
}

/// The pack in an upload-pack response that used side-band framing.
pub(crate) fn unpack_sideband(response: &[u8]) -> Result<Vec<u8>> {
    let (lines, _) = read_pkt_lines(response);
    let mut pack = Vec::new();
    for line in lines {
        match line.first() {
            Some(&PACK_BAND) => pack.extend_from_slice(&line[1..]),
            Some(&ERROR_BAND) => {
                return Err(Error::RustError(format!(
                    "the source refused the fetch: {}",
                    String::from_utf8_lossy(&line[1..])
                )));
            }
            // ACK and NAK lines, and progress messages.
            _ => {}
        }
    }
    if !pack.starts_with(b"PACK") {
        return Err(Error::RustError(format!(
            "the source did not send a pack: {}",
            String::from_utf8_lossy(response)
        )));
    }
    Ok(pack)
}

/// Updates `branch` on the target from `old` to `new`, sending `pack`.
/// `Err(reason)` in the inner result means git refused the update, for
/// example because the branch is no longer at `old`.
pub(crate) async fn push_pack(
    target: &GitAccess,
    branch: &str,
    old: Option<&str>,
    new: &str,
    pack: Vec<u8>,
) -> Result<std::result::Result<(), String>> {
    push_ref(target, &format!("refs/heads/{branch}"), old, new, Some(pack)).await
}

/// Removes `branch` from the target, if it is still at `old`.
pub(crate) async fn delete_ref(
    target: &GitAccess,
    branch: &str,
    old: &str,
) -> Result<std::result::Result<(), String>> {
    push_ref(target, &format!("refs/heads/{branch}"), Some(old), ZERO_ID, None).await
}

/// The commands at the start of a receive-pack request for one ref.
fn command(reference: &str, old: Option<&str>, new: &str, sends_pack: bool) -> Vec<u8> {
    let capabilities = if sends_pack { "report-status" } else { "report-status delete-refs" };
    let mut body = pkt_line(&format!("{} {new} {reference}\0 {capabilities}\n", old.unwrap_or(ZERO_ID)));
    body.extend_from_slice(FLUSH);
    body
}

/// Whether a report-status says `reference` moved.
fn reported(report: &[u8], reference: &str, sent_pack: bool) -> std::result::Result<(), String> {
    let (lines, _) = read_pkt_lines(report);
    let lines: Vec<String> = lines
        .into_iter()
        .map(|line| String::from_utf8_lossy(line).trim_end().to_owned())
        .collect();
    // With nothing to unpack a server may not say so.
    let unpacked = !sent_pack || lines.iter().any(|line| line == "unpack ok");
    let updated = lines.iter().any(|line| *line == format!("ok {reference}"));
    if unpacked && updated { Ok(()) } else { Err(lines.join("; ")) }
}

/// Moves one ref (`refs/heads/main`, `refs/pull/<id>/head`) on the target
/// from `old` to `new`; a deletion sends no pack.
pub(crate) async fn push_ref(
    target: &GitAccess,
    reference: &str,
    old: Option<&str>,
    new: &str,
    pack: Option<Vec<u8>>,
) -> Result<std::result::Result<(), String>> {
    let sends_pack = pack.is_some();
    let mut body = command(reference, old, new, sends_pack);
    if let Some(pack) = pack {
        body.extend(pack);
    }
    let response = post(target, "git-receive-pack", body).await?;
    Ok(reported(&response, reference, sends_pack))
}

/// Moves `branch` on `target` from `old` to `new`, a commit that exists in
/// `source`. The caller must have checked that `new` descends from `old`.
/// The pack goes from the source's answer into the push as it arrives.
pub async fn fast_forward(
    source: &GitAccess,
    target: &GitAccess,
    branch: &str,
    old: Option<&str>,
    new: &str,
) -> Result<std::result::Result<(), String>> {
    let request = want_request(new, old);
    let sent = request.len() as u64;
    let mut fetched = send(source, "git-upload-pack", Uint8Array::from(request.as_slice()).into(), sent).await?;
    let reference = format!("refs/heads/{branch}");
    let failure: Rc<RefCell<Option<String>>> = Rc::default();
    let demux = Rc::new(RefCell::new(Sideband::default()));
    let pack = {
        let failure = failure.clone();
        let demux = demux.clone();
        fetched.stream()?.map(move |chunk| {
            let chunk = chunk?;
            demux.borrow_mut().feed(&chunk).map_err(|why| {
                *failure.borrow_mut() = Some(why.clone());
                Error::RustError(why)
            })
        })
    };
    // The source said all it had: a pack must have come.
    let end = {
        let failure = failure.clone();
        let demux = demux.clone();
        futures_util::stream::once(async move {
            demux.borrow().finish().map(|()| Vec::new()).map_err(|why| {
                *failure.borrow_mut() = Some(why.clone());
                Error::RustError(why)
            })
        })
    };
    let head = command(&reference, old, new, true);
    let body = futures_util::stream::once(async move { Ok::<Vec<u8>, Error>(head) })
        .chain(pack)
        .chain(end)
        .filter(|chunk| futures_util::future::ready(!matches!(chunk, Ok(bytes) if bytes.is_empty())));
    let pushed = send(target, "git-receive-pack", crate::git_http::stream_body(body)?, 0).await;
    if let Some(why) = failure.borrow_mut().take() {
        return Err(Error::RustError(why));
    }
    let report = pushed?.bytes().await?;
    let moved = demux.borrow().pack_bytes;
    if let (Some(from), Some(to)) = (crate::store::key_from_remote(&source.remote), crate::store::key_from_remote(&target.remote)) {
        meters::record_bytes("internal.git.fetch", &from, 0, moved);
        meters::record_bytes("internal.git.receive_pack", &to, moved, 0);
    }
    Ok(reported(&report, &reference, true))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_ref_is_moved_by_one_command() {
        let new = "4807077b296e6edbf410d55e72749d3e1170c291";
        let body = String::from_utf8(command("refs/pull/pul_1/head", None, new, true)).unwrap();
        assert!(body.starts_with(&format!("{:04x}", body.len() - 4)));
        assert!(body.contains(&format!("{ZERO_ID} {new} refs/pull/pul_1/head\0 report-status\n")));
        assert!(body.ends_with("0000"));
        let deletion = String::from_utf8(command("refs/heads/x", Some(new), ZERO_ID, false)).unwrap();
        assert!(deletion.contains("delete-refs"));
    }

    #[test]
    fn a_report_says_whether_the_ref_moved() {
        let ok = [pkt_line("unpack ok\n"), pkt_line("ok refs/heads/main\n"), FLUSH.to_vec()].concat();
        assert_eq!(reported(&ok, "refs/heads/main", true), Ok(()));
        let refused = [pkt_line("unpack ok\n"), pkt_line("ng refs/heads/main non-fast-forward\n"), FLUSH.to_vec()].concat();
        assert!(reported(&refused, "refs/heads/main", true).unwrap_err().contains("non-fast-forward"));
        // Nothing unpacked: a server may not say so.
        let bare = [pkt_line("ok refs/heads/main\n"), FLUSH.to_vec()].concat();
        assert_eq!(reported(&bare, "refs/heads/main", false), Ok(()));
        assert!(reported(&bare, "refs/heads/main", true).is_err());
    }

    #[test]
    fn the_empty_pack_is_a_pack_of_nothing() {
        let pack = g1t_scan::pack::write_pack(&[]);
        assert_eq!(pack, EMPTY_PACK);
    }
}
