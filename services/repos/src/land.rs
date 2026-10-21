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

/// Bind publication to the immutable commit approved by the caller. The
/// returned object ID, never a second branch lookup, is used for the push.
pub(crate) fn checked_commit(observed: &str, expected: Option<&str>) -> Option<String> {
    expected.is_none_or(|expected| expected == observed).then(|| observed.to_owned())
}
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
    send_metered(access, service, meter(service), body, sent).await
}

/// [`send`], counted under `meter`: a request on g1t's own account
/// (storage drift) is not one of the workspace's operations.
async fn send_metered(access: &GitAccess, service: &str, meter: &str, body: JsValue, sent: u64) -> Result<Response> {
    let headers = Headers::new();
    headers.set("authorization", &format!("Bearer {}", access.token))?;
    headers.set("content-type", &format!("application/x-{service}-request"))?;
    headers.set("accept", &format!("application/x-{service}-result"))?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post).with_headers(headers).with_body(Some(body));
    let request = Request::new_with_init(&format!("{}/{service}", access.remote), &init)?;
    let mut response = Fetch::Request(request).send().await?;
    meters::record_remote(meter, &access.remote, sent, 0);
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

/// What the store's report-status says of a write to one ref.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Verdict {
    /// The ref moved: the store took the pack.
    Moved,
    /// The store said no: its unpack failed, or it answered `ng` for the
    /// ref (most often because the ref was no longer at `old`).
    Refused(String),
    /// The report says neither: whether the store took the pack is not
    /// known.
    Unclear(String),
}

impl Verdict {
    /// As the callers of [`push_ref`] read it: anything but a move is the
    /// reason the ref did not move.
    pub(crate) fn into_result(self) -> std::result::Result<(), String> {
        match self {
            Verdict::Moved => Ok(()),
            Verdict::Refused(reason) | Verdict::Unclear(reason) => Err(reason),
        }
    }

    /// Why the ref did not move: empty when it did.
    pub(crate) fn reason(&self) -> &str {
        match self {
            Verdict::Moved => "",
            Verdict::Refused(reason) | Verdict::Unclear(reason) => reason,
        }
    }
}

/// The lines of a receive-pack report-status, plain or inside side-band
/// channel 1, as the store sends either. `None` when the answer is not a
/// report this can read, or carries a fatal error (channel 3).
pub(crate) fn report_lines(answer: &[u8]) -> Option<Vec<String>> {
    let (packets, _) = read_pkt_lines(answer);
    let banded = packets.first().is_some_and(|packet| matches!(packet.first(), Some(1..=3)));
    let status = if banded {
        let mut status = Vec::new();
        for packet in &packets {
            match packet.first() {
                Some(1) => status.extend_from_slice(&packet[1..]),
                Some(2) => {}
                _ => return None,
            }
        }
        status
    } else {
        answer.to_vec()
    };
    let (lines, _) = read_pkt_lines(&status);
    let lines: Vec<String> = lines.into_iter().map(|line| String::from_utf8_lossy(line).trim_end().to_owned()).collect();
    (!lines.is_empty()).then_some(lines)
}

/// What a report-status says of `reference`.
pub(crate) fn verdict(report: &[u8], reference: &str, sent_pack: bool) -> Verdict {
    // What was unclear, said whole: it is the outcome staff read on an
    // ended reservation.
    let unclear = |said: &str| {
        let said = if said.is_empty() { "it said nothing" } else { said };
        Verdict::Unclear(format!("The store's answer said neither that {reference} moved nor that it was refused: {said}"))
    };
    let Some(lines) = report_lines(report) else {
        return unclear(String::from_utf8_lossy(report).trim());
    };
    let reason = lines.join("; ");
    if lines.iter().any(|line| line.starts_with("unpack ") && line != "unpack ok") {
        return Verdict::Refused(reason);
    }
    // With nothing to unpack a server may not say so.
    let unpacked = !sent_pack || lines.iter().any(|line| line == "unpack ok");
    if unpacked && lines.iter().any(|line| *line == format!("ok {reference}")) {
        return Verdict::Moved;
    }
    let ng = format!("ng {reference}");
    if lines.iter().any(|line| *line == ng || line.starts_with(&format!("{ng} "))) {
        return Verdict::Refused(reason);
    }
    unclear(&reason)
}

/// Whether a report-status says `reference` moved.
#[cfg(test)]
fn reported(report: &[u8], reference: &str, sent_pack: bool) -> std::result::Result<(), String> {
    verdict(report, reference, sent_pack).into_result()
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
    Ok(push_ref_judged(target, reference, old, new, pack).await?.into_result())
}

/// [`push_pack`], with the store's [`Verdict`]: whether it took the pack,
/// refused it, or answered neither, for a write that settles a storage
/// reservation by it (public_storage.rs `push_reserved`).
pub(crate) async fn push_pack_judged(
    target: &GitAccess,
    branch: &str,
    old: Option<&str>,
    new: &str,
    pack: Vec<u8>,
) -> Result<Verdict> {
    push_ref_judged(target, &format!("refs/heads/{branch}"), old, new, Some(pack)).await
}

async fn push_ref_judged(
    target: &GitAccess,
    reference: &str,
    old: Option<&str>,
    new: &str,
    pack: Option<Vec<u8>>,
) -> Result<Verdict> {
    let sends_pack = pack.is_some();
    let mut body = command(reference, old, new, sends_pack);
    if let Some(pack) = pack {
        body.extend(pack);
    }
    let response = post(target, "git-receive-pack", body).await?;
    Ok(verdict(&response, reference, sends_pack))
}

/// Moves `branch` on `target` from `old` to `new`, a commit that exists in
/// `source`. The caller must have checked that `new` descends from `old`.
/// The pack goes from the source's answer into the push as it arrives.
pub(crate) async fn fast_forward(
    source: &GitAccess, target: &GitAccess, branch: &str, old: Option<&str>, new: &str,
    quota: Option<Rc<crate::public_storage::StreamQuota>>,
) -> Result<std::result::Result<(), String>> {
    let request = want_request(new, old);
    let sent = request.len() as u64;
    let mut fetched = send(source, "git-upload-pack", Uint8Array::from(request.as_slice()).into(), sent).await?;
    let reference = format!("refs/heads/{branch}");
    let failure: Rc<RefCell<Option<String>>> = Rc::default();
    let demux = Rc::new(RefCell::new(Sideband::default()));
    // Set once every pack byte has been passed on to the store.
    let delivered = Rc::new(std::cell::Cell::new(false));
    let pack = {
        let failure = failure.clone();
        let demux = demux.clone();
        let quota = quota.clone();
        let delivered = delivered.clone();
        fetched.stream()?.then(move |chunk| {
            let failure = failure.clone();
            let demux = demux.clone();
            let quota = quota.clone();
            let delivered = delivered.clone();
            async move {
            let chunk = chunk?;
            let pack = demux.borrow_mut().feed(&chunk).map_err(|why| {
                *failure.borrow_mut() = Some(why.clone());
                Error::RustError(why)
            })?;
            if let Some(quota) = quota
                && needs_grant(&pack)
            {
                // Refused past the copy's lease too: cut short, the push
                // is refused whole (public_storage.rs).
                if let Err(refusal) = quota.grow(pack.len() as u64).await? {
                    let why = refusal.message();
                    *failure.borrow_mut() = Some(why.clone());
                    return Err(Error::RustError(why));
                }
            }
            if demux.borrow().complete() {
                delivered.set(true);
            }
            Ok(pack)
            }
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
        if let Some(quota) = &quota {
            match cut_short(delivered.get()) {
                // Cut short before its end, so the store refused the push
                // whole, as a push over a limit is (git_http.rs).
                CutShort::Release => quota.release().await?,
                CutShort::End => quota.end(&why).await,
            }
        }
        return Err(Error::RustError(why));
    }
    let report = match pushed {
        Ok(mut pushed) => pushed.bytes().await,
        Err(error) => Err(error),
    };
    let report = match report {
        Ok(report) => report,
        Err(error) => {
            // Whether the store kept any of it is not known: the
            // reservation stays, ended, for staff (storage_holds.rs).
            if let Some(quota) = quota {
                quota.end(&error.to_string()).await;
            }
            return Err(error);
        }
    };
    let moved = demux.borrow().pack_bytes;
    let verdict = verdict(&report, &reference, true);
    if let Some(quota) = quota {
        // Counted only when the branch moved (public_storage.rs
        // `write_settlement`).
        quota.settle(&verdict, moved, (&reference, new)).await?;
    }
    if let (Some(from), Some(to)) = (crate::store::key_from_remote(&source.remote), crate::store::key_from_remote(&target.remote)) {
        meters::record_bytes("internal.git.fetch", &from, 0, moved);
        meters::record_bytes("internal.git.receive_pack", &to, moved, 0);
    }
    Ok(verdict.into_result())
}

/// The size of the pack `source` sends for everything `wants` reaches that
/// `haves` do not, counted as it streams past and never held (storage
/// drift, storage_holds.rs). What a mirror clone downloads: the store's
/// own measure of what it keeps, as near as git can ask for it. Counted
/// under `meter`, and given up past `limit` bytes.
pub(crate) async fn pack_size(source: &GitAccess, wants: &[String], haves: &[String], meter: &str, limit: u64) -> Result<u64> {
    if wants.is_empty() {
        return Ok(0);
    }
    let request = crate::copy::upload_request(wants, haves);
    let sent = request.len() as u64;
    let mut fetched = send_metered(source, "git-upload-pack", meter, Uint8Array::from(request.as_slice()).into(), sent).await?;
    let mut demux = Sideband::default();
    let mut stream = fetched.stream()?;
    while let Some(chunk) = stream.next().await {
        demux.count(&chunk?).map_err(Error::RustError)?;
        if demux.pack_bytes > limit {
            return Err(Error::RustError(format!("over the {limit} bytes left to measure")));
        }
    }
    demux.finish().map_err(Error::RustError)?;
    if let Some(key) = crate::store::key_from_remote(&source.remote) {
        meters::record_bytes(meter, &key, 0, demux.pack_bytes);
    }
    Ok(demux.pack_bytes)
}

/// Whether a chunk of a streamed copy needs more of its reservation: only
/// one that carries pack bytes. Progress lines and the flush after the
/// pack carry none, and must not be refused after the pack is whole.
pub(crate) fn needs_grant(pack: &[u8]) -> bool {
    !pack.is_empty()
}

/// What a streamed copy cut short does with its reservation.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CutShort {
    /// The pack never went out whole, so the store refused the push whole.
    Release,
    /// The whole pack had gone out: whether the store kept it is not known.
    End,
}

pub(crate) fn cut_short(pack_delivered: bool) -> CutShort {
    if pack_delivered { CutShort::End } else { CutShort::Release }
}

/// The commands at the start of a receive-pack request for many refs:
/// `(name, old, new)`, `new` the zero id to delete.
fn commands_block(commands: &[crate::copy::Command]) -> Vec<u8> {
    let deletes = commands.iter().any(|(_, _, new)| new == ZERO_ID);
    let capabilities = if deletes { "report-status delete-refs" } else { "report-status" };
    let mut body = Vec::new();
    for (index, (name, old, new)) in commands.iter().enumerate() {
        let old = old.as_deref().unwrap_or(ZERO_ID);
        let line = if index == 0 { format!("{old} {new} {name}\0 {capabilities}\n") } else { format!("{old} {new} {name}\n") };
        body.extend(pkt_line(&line));
    }
    body.extend_from_slice(FLUSH);
    body
}

/// Makes `target`'s refs match `commands`, fetching from `source` the
/// objects `wants` names that `haves` (commits the target holds) do not
/// reach. The pack streams from one into the other, never held whole, so
/// a whole repository can be copied this way (moves.rs). `Err` in the
/// inner result says which refs the target refused, and why.
pub(crate) async fn copy_refs(
    source: &GitAccess,
    target: &GitAccess,
    commands: &[crate::copy::Command],
    wants: &[String],
    haves: &[String],
) -> Result<std::result::Result<(), String>> {
    if commands.is_empty() {
        return Ok(Ok(()));
    }
    let head = commands_block(commands);
    let sends_pack = commands.iter().any(|(_, _, new)| new != ZERO_ID);
    let report = if wants.is_empty() {
        // Every object is there already: only refs move.
        let mut body = head;
        if sends_pack {
            body.extend_from_slice(EMPTY_PACK);
        }
        post(target, "git-receive-pack", body).await?
    } else {
        let request = crate::copy::upload_request(wants, haves);
        let sent = request.len() as u64;
        let mut fetched = send(source, "git-upload-pack", Uint8Array::from(request.as_slice()).into(), sent).await?;
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
        report
    };
    let problems = crate::copy::refused(&report, commands);
    Ok(if problems.is_empty() { Ok(()) } else { Err(problems.join("; ")) })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A side-band packet on `band`.
    fn band(band: u8, payload: &[u8]) -> Vec<u8> {
        let mut out = format!("{:04x}", payload.len() + 5).into_bytes();
        out.push(band);
        out.extend_from_slice(payload);
        out
    }

    #[test]
    fn a_copy_asks_more_of_its_reservation_only_for_pack_bytes() {
        let mut demux = Sideband::default();
        // A progress line before the pack: nothing to reserve.
        let progress = demux.feed(&band(2, b"Counting objects: 3\n")).unwrap();
        assert!(!needs_grant(&progress));
        let pack = demux.feed(&band(1, b"PACK\x00\x00\x00\x02rest")).unwrap();
        assert!(needs_grant(&pack));
        assert!(!demux.complete());
        // The flush after the pack: the pack is whole, and this chunk asks
        // for nothing, so a full workspace or a passed lease cannot turn a
        // whole pack into a refused one.
        let flush = demux.feed(b"0000").unwrap();
        assert!(!needs_grant(&flush));
        assert!(demux.complete());
    }

    #[test]
    fn a_copy_cut_short_after_its_whole_pack_went_out_keeps_its_reservation_ended() {
        assert_eq!(cut_short(false), CutShort::Release);
        assert_eq!(cut_short(true), CutShort::End);
    }

    #[test]
    fn a_measured_pack_is_counted_without_being_kept() {
        let mut kept = Sideband::default();
        let mut counted = Sideband::default();
        let answer = [band(1, b"PACK0123456789"), band(2, b"progress"), b"0000".to_vec()].concat();
        let pack = kept.feed(&answer).unwrap();
        counted.count(&answer).unwrap();
        assert_eq!(counted.pack_bytes, pack.len() as u64);
        assert!(counted.complete());
    }

    #[test]
    fn landing_rejects_a_branch_replaced_after_checks() {
        assert_eq!(checked_commit("tested", Some("tested")).as_deref(), Some("tested"));
        assert_eq!(checked_commit("replacement", Some("tested")), None);
        // Compatibility for callers that have no checked-state contract.
        assert_eq!(checked_commit("tip", None).as_deref(), Some("tip"));
        let commit = checked_commit("tested", Some("tested")).unwrap();
        let command = String::from_utf8(commands_block(&[("refs/heads/main".into(), Some("base".into()), commit)])).unwrap();
        assert!(command.contains("base tested refs/heads/main"));
    }

    #[test]
    fn many_refs_are_moved_by_one_block_of_commands() {
        let a = "c71546fcd893ef8b0f57388b65e620d759705dda".to_owned();
        let b = "4807077b296e6edbf410d55e72749d3e1170c291".to_owned();
        let block = String::from_utf8(commands_block(&[
            ("refs/heads/main".to_owned(), None, a.clone()),
            ("refs/tags/v1".to_owned(), Some(a.clone()), b.clone()),
        ]))
        .unwrap();
        // Capabilities ride on the first command only.
        assert!(block.contains(&format!("{ZERO_ID} {a} refs/heads/main\0 report-status\n")));
        assert!(block.contains(&format!("{a} {b} refs/tags/v1\n")));
        assert!(block.ends_with("0000"));
        let deleting = String::from_utf8(commands_block(&[("refs/heads/old".to_owned(), Some(a), ZERO_ID.to_owned())])).unwrap();
        assert!(deleting.contains("delete-refs"));
    }

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
    fn a_report_tells_a_refusal_from_an_answer_that_says_neither() {
        let lines = |lines: &[&str]| {
            let mut report: Vec<u8> = lines.iter().flat_map(|line| pkt_line(&format!("{line}\n"))).collect();
            report.extend_from_slice(FLUSH);
            report
        };
        let main = "refs/heads/main";
        assert_eq!(verdict(&lines(&["unpack ok", "ok refs/heads/main"]), main, true), Verdict::Moved);
        assert!(matches!(verdict(&lines(&["unpack ok", "ng refs/heads/main non-fast-forward"]), main, true), Verdict::Refused(_)));
        assert!(matches!(verdict(&lines(&["unpack ok", "ng refs/heads/main"]), main, true), Verdict::Refused(_)));
        assert!(matches!(verdict(&lines(&["unpack error: bad pack", "ng refs/heads/main unpacker error"]), main, true), Verdict::Refused(_)));
        // A failed unpack is a refusal even where the ref says ok.
        assert!(matches!(verdict(&lines(&["unpack error: bad pack", "ok refs/heads/main"]), main, true), Verdict::Refused(_)));
        // Another ref's refusal, or none at all, says nothing of this one.
        assert!(matches!(verdict(&lines(&["unpack ok", "ng refs/heads/main2 x"]), main, true), Verdict::Unclear(_)));
        assert!(matches!(verdict(&lines(&["unpack ok"]), main, true), Verdict::Unclear(_)));
        assert_eq!(
            verdict(b"", main, true),
            Verdict::Unclear("The store's answer said neither that refs/heads/main moved nor that it was refused: it said nothing".to_owned())
        );
        assert_eq!(
            verdict(&lines(&["unpack ok"]), main, true).reason(),
            "The store's answer said neither that refs/heads/main moved nor that it was refused: unpack ok"
        );
        assert!(matches!(verdict(b"garbage", main, true), Verdict::Unclear(_)));
        // The same report inside side-band channel 1 reads the same.
        let mut banded = pkt_line("\u{2}remote: working\n");
        for chunk in lines(&["unpack ok", "ng refs/heads/main fetch first"]).chunks(5) {
            let mut packet = vec![1u8];
            packet.extend_from_slice(chunk);
            banded.extend(format!("{:04x}", packet.len() + 4).into_bytes());
            banded.extend(packet);
        }
        banded.extend_from_slice(FLUSH);
        assert!(matches!(verdict(&banded, main, true), Verdict::Refused(reason) if reason.contains("fetch first")));
        assert_eq!(Verdict::Refused("no".into()).into_result(), Err("no".to_owned()));
        assert_eq!(Verdict::Moved.reason(), "");
    }

    #[test]
    fn the_empty_pack_is_a_pack_of_nothing() {
        let pack = g1t_scan::pack::write_pack(&[]);
        assert_eq!(pack, EMPTY_PACK);
    }
}
