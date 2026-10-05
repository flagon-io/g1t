//! Landing a pull request: moving a repository's branch forward to a commit
//! from a fork, or from another of its own branches.
//!
//! The Artifacts binding cannot write, so this speaks git's smart HTTP
//! protocol directly. It asks the fork for a pack holding exactly the
//! objects the target is missing, then pushes that pack to the target
//! unchanged. No object is parsed or rebuilt along the way.

use g1t_contracts::repos::GitAccess;
use worker::js_sys::Uint8Array;
use worker::{Error, Fetch, Headers, Method, Request, RequestInit, Result};

const ZERO_ID: &str = "0000000000000000000000000000000000000000";
const FLUSH: &[u8] = b"0000";
/// Side-band channels: pack data, and fatal errors.
const PACK_BAND: u8 = 1;
const ERROR_BAND: u8 = 3;

fn pkt_line(payload: &str) -> Vec<u8> {
    format!("{:04x}{payload}", payload.len() + 4).into_bytes()
}

async fn post(access: &GitAccess, service: &str, body: Vec<u8>) -> Result<Vec<u8>> {
    let headers = Headers::new();
    headers.set("authorization", &format!("Bearer {}", access.token))?;
    headers.set("content-type", &format!("application/x-{service}-request"))?;
    headers.set("accept", &format!("application/x-{service}-result"))?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(Uint8Array::from(body.as_slice()).into()));
    let request = Request::new_with_init(&format!("{}/{service}", access.remote), &init)?;
    let mut response = Fetch::Request(request).send().await?;
    let bytes = response.bytes().await?;
    if response.status_code() != 200 {
        return Err(Error::RustError(format!(
            "{service} returned {}: {}",
            response.status_code(),
            String::from_utf8_lossy(&bytes)
        )));
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

/// A pack holding everything reachable from `want` that is not reachable
/// from `have`.
pub(crate) async fn fetch_pack(source: &GitAccess, want: &str, have: Option<&str>) -> Result<Vec<u8>> {
    // Side-band framing puts the pack in its own channel, so its exact bytes
    // can be recovered. Without it the response ends in a stray flush packet
    // that a receiver rejects as junk after the pack.
    let mut body = pkt_line(&format!("want {want} side-band-64k\n"));
    body.extend_from_slice(FLUSH);
    if let Some(have) = have {
        body.extend(pkt_line(&format!("have {have}\n")));
    }
    body.extend(pkt_line("done\n"));

    let response = post(source, "git-upload-pack", body).await?;
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
    update_ref(target, branch, old, new, Some(pack)).await
}

/// Removes `branch` from the target, if it is still at `old`.
pub(crate) async fn delete_ref(
    target: &GitAccess,
    branch: &str,
    old: &str,
) -> Result<std::result::Result<(), String>> {
    update_ref(target, branch, Some(old), ZERO_ID, None).await
}

/// One receive-pack command; a deletion sends no pack.
async fn update_ref(
    target: &GitAccess,
    branch: &str,
    old: Option<&str>,
    new: &str,
    pack: Option<Vec<u8>>,
) -> Result<std::result::Result<(), String>> {
    let reference = format!("refs/heads/{branch}");
    let sends_pack = pack.is_some();
    let capabilities = if sends_pack { "report-status" } else { "report-status delete-refs" };
    let mut body = pkt_line(&format!(
        "{} {new} {reference}\0 {capabilities}\n",
        old.unwrap_or(ZERO_ID)
    ));
    body.extend_from_slice(FLUSH);
    if let Some(pack) = pack {
        body.extend(pack);
    }

    let response = post(target, "git-receive-pack", body).await?;
    let (lines, _) = read_pkt_lines(&response);
    let lines: Vec<String> = lines
        .into_iter()
        .map(|line| String::from_utf8_lossy(line).trim_end().to_owned())
        .collect();
    // With nothing to unpack a server may not say so.
    let unpacked = !sends_pack || lines.iter().any(|line| line == "unpack ok");
    let updated = lines.iter().any(|line| *line == format!("ok {reference}"));
    Ok(if unpacked && updated {
        Ok(())
    } else {
        Err(lines.join("; "))
    })
}

/// Moves `branch` on `target` from `old` to `new`, a commit that exists in
/// `source`. The caller must have checked that `new` descends from `old`.
pub async fn fast_forward(
    source: &GitAccess,
    target: &GitAccess,
    branch: &str,
    old: Option<&str>,
    new: &str,
) -> Result<std::result::Result<(), String>> {
    let pack = fetch_pack(source, new, old).await?;
    push_pack(target, branch, old, new, pack).await
}
