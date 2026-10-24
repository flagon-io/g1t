//! Refs g1t keeps for itself, which nobody pushes to: a pull request's
//! `refs/pull/<number>/head` and `refs/pull/<number>/merge` (test_merge.rs,
//! forks.rs). As on GitHub, they are hidden refs: fetched like any other,
//! left out of the advertisement a push reads, and refused in a push with
//! `deny updating a hidden ref`, ref by ref, while the rest of the push is
//! applied. So `git push --mirror` of a repository cloned with `--mirror`
//! from GitHub moves every branch and tag and reports only its
//! `refs/pull/*` as rejected.
//!
//! g1t moves them itself straight on the git store (land.rs `push_ref`),
//! never through the git remote people push to, so none of this touches
//! that.

use crate::git_http::{Packet, encode, framed, packets, pkt_line};

/// The refs g1t keeps.
pub const HIDDEN_PREFIX: &str = "refs/pull/";

/// What git is told for each of them, as GitHub (and git's own
/// `receive.hideRefs`) tells it.
pub const HIDDEN_REASON: &str = "deny updating a hidden ref";

/// What the other refs of an `--atomic` push are told, as git's
/// receive-pack tells them.
const ATOMIC_REASON: &str = "atomic transaction failed";

pub fn is_hidden(name: &str) -> bool {
    name.starts_with(HIDDEN_PREFIX)
}

/// A push's commands with those to hidden refs taken out.
#[derive(Debug, PartialEq, Eq)]
pub enum Split {
    /// No command names a hidden ref: the push goes on as it came.
    Untouched,
    /// The push without them, to send on, and the refs that were taken
    /// out, to report as refused once the store has answered for the rest.
    Without { body: Vec<u8>, hidden: Vec<String> },
    /// Nothing is sent on: every command names a hidden ref, or the push is
    /// atomic and one of them does. The report to answer with.
    Refused { report: Vec<u8>, hidden: Vec<String> },
}

/// One pkt-line of a push's command list, as it came.
struct Line {
    data: Vec<u8>,
    /// The ref, when the line is a command (`<old> <new> <ref>`).
    name: Option<String>,
}

fn command_name(data: &[u8]) -> Option<String> {
    let command = data.split(|byte| *byte == 0).next()?;
    let command = std::str::from_utf8(command).ok()?.trim_end();
    let mut parts = command.splitn(3, ' ');
    let (old, new, name) = (parts.next()?, parts.next()?, parts.next()?);
    let oid = |value: &str| matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit());
    (oid(old) && oid(new) && !name.is_empty()).then(|| name.to_owned())
}

/// The command lines at the start of a receive-pack request, up to the
/// flush that ends them, and where the rest (push options, the pack)
/// starts. `None` when they do not end within `body`.
fn command_lines(body: &[u8]) -> Option<(Vec<Line>, usize)> {
    let mut lines = Vec::new();
    let mut position = 0;
    loop {
        let header = body.get(position..position + 4)?;
        let length = usize::from_str_radix(std::str::from_utf8(header).ok()?, 16).ok()?;
        if length == 0 {
            return Some((lines, position + 4));
        }
        let data = body.get(position + 4..position + length)?.to_vec();
        position += length;
        let name = command_name(&data);
        lines.push(Line { data, name });
    }
}

/// The capabilities on the first command, after its NUL, as sent
/// (with the newline, when there is one).
fn capabilities_of(lines: &[Line]) -> Option<Vec<u8>> {
    let first = lines.iter().find(|line| line.name.is_some())?;
    let nul = first.data.iter().position(|byte| *byte == 0)?;
    Some(first.data[nul + 1..].to_vec())
}

fn has_capability(capabilities: &[u8], wanted: &str) -> bool {
    String::from_utf8_lossy(capabilities).split_ascii_whitespace().any(|capability| capability == wanted)
}

/// Takes the commands to hidden refs out of a receive-pack request (see
/// [`Split`]). The capabilities stay on the first command that is left.
pub fn split(body: &[u8]) -> Split {
    let Some((lines, rest)) = command_lines(body) else {
        return Split::Untouched;
    };
    let hidden: Vec<String> =
        lines.iter().filter_map(|line| line.name.as_deref()).filter(|name| is_hidden(name)).map(str::to_owned).collect();
    if hidden.is_empty() {
        return Split::Untouched;
    }
    let capabilities = capabilities_of(&lines).unwrap_or_default();
    let caps_text = String::from_utf8_lossy(&capabilities).trim().to_owned();
    let kept: Vec<&Line> = lines.iter().filter(|line| line.name.as_deref().is_some_and(|name| !is_hidden(name))).collect();
    if kept.is_empty() || has_capability(&capabilities, "atomic") {
        let mut report = pkt_line(b"unpack ok\n");
        for line in lines.iter().filter_map(|line| line.name.as_deref()) {
            let reason = if is_hidden(line) { HIDDEN_REASON } else { ATOMIC_REASON };
            report.extend(pkt_line(format!("ng {line} {reason}\n").as_bytes()));
        }
        report.extend_from_slice(b"0000");
        return Split::Refused { report: framed(report, &caps_text, &[]), hidden };
    }
    let mut out = Vec::with_capacity(body.len());
    let mut capabilities_placed = false;
    for line in &lines {
        match line.name.as_deref() {
            Some(name) if is_hidden(name) => continue,
            Some(_) => {
                // `<old> <new> <ref>` without what followed a NUL, then the
                // capabilities on the first command that is sent.
                let command = line.data.split(|byte| *byte == 0).next().unwrap_or_default();
                let command = command.strip_suffix(b"\n").unwrap_or(command);
                let mut data = command.to_vec();
                if !capabilities_placed && !capabilities.is_empty() {
                    data.push(0);
                    data.extend_from_slice(&capabilities);
                } else {
                    data.push(b'\n');
                }
                capabilities_placed = true;
                out.extend(pkt_line(&data));
            }
            // `shallow` lines and the like stay where they were.
            None => out.extend(pkt_line(&line.data)),
        }
    }
    out.extend_from_slice(b"0000");
    out.extend_from_slice(&body[rest..]);
    Split::Without { body: out, hidden }
}

fn ng_lines(hidden: &[String]) -> Vec<Packet> {
    hidden.iter().map(|name| Packet::Data(format!("ng {name} {HIDDEN_REASON}\n").into_bytes())).collect()
}

/// A report-status (bare packets ending in a flush) with `ng` lines for
/// `hidden` before its flush.
fn report_with(report: &[u8], hidden: &[String]) -> Option<Vec<u8>> {
    let mut packets = packets(report)?;
    let flush = packets.iter().rposition(|packet| *packet == Packet::Special(*b"0000"))?;
    let ng = ng_lines(hidden);
    packets.splice(flush..flush, ng);
    Some(encode(&packets))
}

/// The store's answer to a push it was sent without the commands to
/// hidden refs, with each of those refused in its report, so git prints
/// `! [remote rejected] refs/pull/1/head (deny updating a hidden ref)`
/// beside the refs that moved. Inside channel 1 when the client asked for
/// side-band; progress and errors on the other channels are kept as they
/// were. `None` when the answer is not a report this can read.
pub fn with_refused(answer: &[u8], hidden: &[String], sideband: bool) -> Option<Vec<u8>> {
    if !sideband {
        return report_with(answer, hidden);
    }
    let packets = packets(answer)?;
    let mut report = Vec::new();
    let mut others = Vec::new();
    for packet in packets {
        match &packet {
            Packet::Data(data) if data.first() == Some(&1) => report.extend_from_slice(&data[1..]),
            Packet::Special([b'0', b'0', b'0', b'0']) => {}
            _ => others.push(packet),
        }
    }
    let report = report_with(&report, hidden)?;
    let mut out = encode(&others);
    // side-band (not -64k) packets carry at most 1000 bytes.
    for chunk in report.chunks(990) {
        let mut packet = vec![1u8];
        packet.extend_from_slice(chunk);
        out.extend(pkt_line(&packet));
    }
    out.extend_from_slice(b"0000");
    Some(out)
}

/// The receive-pack ref advertisement without hidden refs, as GitHub
/// advertises it, so `git push --mirror` does not try to delete what g1t
/// keeps. The capabilities move to the first ref left, or to a
/// `capabilities^{}` line when none is. `None` when there is nothing to
/// change or the answer is not a whole advertisement.
pub fn advertisement_without_hidden(body: &[u8]) -> Option<Vec<u8>> {
    let packets = packets(body)?;
    let name_of = |data: &[u8]| -> Option<String> {
        let line = data.split(|byte| *byte == 0).next()?;
        let (oid, name) = std::str::from_utf8(line).ok()?.trim_end().split_once(' ')?;
        (matches!(oid.len(), 40 | 64) && oid.bytes().all(|byte| byte.is_ascii_hexdigit())).then(|| name.to_owned())
    };
    let is_ref = |packet: &Packet| matches!(packet, Packet::Data(data) if !data.starts_with(b"# service=") && !data.starts_with(b"version ") && name_of(data).is_some());
    if !packets
        .iter()
        .any(|packet| matches!(packet, Packet::Data(data) if is_ref(packet) && name_of(data).is_some_and(|name| is_hidden(&name))))
    {
        return None;
    }
    let first = packets.iter().position(is_ref)?;
    let Packet::Data(first_line) = &packets[first] else { return None };
    let nul = first_line.iter().position(|byte| *byte == 0)?;
    let capabilities = first_line[nul + 1..].to_vec();
    let mut out: Vec<Packet> = Vec::with_capacity(packets.len());
    let mut placed = false;
    let mut end_of_refs = None;
    for (index, packet) in packets.into_iter().enumerate() {
        if index < first || !is_ref(&packet) {
            if index > first && end_of_refs.is_none() {
                end_of_refs = Some(out.len());
            }
            out.push(packet);
            continue;
        }
        let Packet::Data(data) = packet else { continue };
        let name = name_of(&data).unwrap_or_default();
        if is_hidden(&name) {
            continue;
        }
        let command = data.split(|byte| *byte == 0).next().unwrap_or_default();
        let command = command.strip_suffix(b"\n").unwrap_or(command).to_vec();
        let mut line = command;
        if placed {
            line.push(b'\n');
        } else {
            line.push(0);
            line.extend_from_slice(&capabilities);
            placed = true;
        }
        out.push(Packet::Data(line));
    }
    if !placed {
        let zero = "0".repeat(40);
        let mut line = format!("{zero} capabilities^{{}}").into_bytes();
        line.push(0);
        line.extend_from_slice(&capabilities);
        out.insert(end_of_refs.unwrap_or(out.len()).min(out.len()), Packet::Data(line));
    }
    Some(encode(&out))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ZERO: &str = "0000000000000000000000000000000000000000";
    const OLD: &str = "c71546fcd893ef8b0f57388b65e620d759705dda";
    const NEW: &str = "4807077b296e6edbf410d55e72749d3e1170c291";

    fn pkt(payload: &str) -> Vec<u8> {
        format!("{:04x}{payload}", payload.len() + 4).into_bytes()
    }

    fn text(bytes: &[u8]) -> String {
        String::from_utf8_lossy(bytes).into_owned()
    }

    const PACK: &[u8] = b"PACK\0\0\0\x02\0\0\0\0";

    #[test]
    fn a_push_without_hidden_refs_is_untouched() {
        let body = [pkt(&format!("{OLD} {NEW} refs/heads/main\0 report-status\n")), b"0000".to_vec(), PACK.to_vec()].concat();
        assert_eq!(split(&body), Split::Untouched);
    }

    #[test]
    fn hidden_refs_are_taken_out_and_the_rest_sent_on() {
        // A mirror push: refs/pull first, carrying the capabilities.
        let body = [
            pkt(&format!("{ZERO} {NEW} refs/pull/1/head\0 report-status side-band-64k quiet\n")),
            pkt(&format!("{OLD} {NEW} refs/heads/main\n")),
            pkt(&format!("{ZERO} {NEW} refs/pull/1/merge\n")),
            pkt(&format!("{ZERO} {NEW} refs/tags/v1\n")),
            b"0000".to_vec(),
            PACK.to_vec(),
        ]
        .concat();
        let Split::Without { body: sent, hidden } = split(&body) else { panic!("expected a split") };
        assert_eq!(hidden, ["refs/pull/1/head", "refs/pull/1/merge"]);
        let expected = [
            pkt(&format!("{OLD} {NEW} refs/heads/main\0 report-status side-band-64k quiet\n")),
            pkt(&format!("{ZERO} {NEW} refs/tags/v1\n")),
            b"0000".to_vec(),
            PACK.to_vec(),
        ]
        .concat();
        assert_eq!(text(&sent), text(&expected));
    }

    #[test]
    fn a_push_of_hidden_refs_alone_is_answered_here() {
        let body = [pkt(&format!("{OLD} {ZERO} refs/pull/7/head\0 report-status\n")), b"0000".to_vec()].concat();
        let Split::Refused { report, hidden } = split(&body) else { panic!("expected a refusal") };
        assert_eq!(hidden, ["refs/pull/7/head"]);
        assert_eq!(
            text(&report),
            text(&[pkt("unpack ok\n"), pkt("ng refs/pull/7/head deny updating a hidden ref\n"), b"0000".to_vec()].concat())
        );
    }

    #[test]
    fn an_atomic_push_with_a_hidden_ref_is_refused_whole() {
        let body = [
            pkt(&format!("{OLD} {NEW} refs/heads/main\0 report-status atomic side-band-64k\n")),
            pkt(&format!("{ZERO} {NEW} refs/pull/1/head\n")),
            b"0000".to_vec(),
            PACK.to_vec(),
        ]
        .concat();
        let Split::Refused { report, .. } = split(&body) else { panic!("expected a refusal") };
        let report = text(&report);
        // Framed on channel 1 for side-band.
        assert!(report.contains("ng refs/heads/main atomic transaction failed\n"));
        assert!(report.contains("ng refs/pull/1/head deny updating a hidden ref\n"));
        assert!(report.ends_with("0000"));
    }

    #[test]
    fn the_stores_report_gains_the_refusals() {
        let hidden = vec!["refs/pull/1/head".to_owned()];
        let bare = [pkt("unpack ok\n"), pkt("ok refs/heads/main\n"), b"0000".to_vec()].concat();
        let changed = with_refused(&bare, &hidden, false).unwrap();
        assert_eq!(
            text(&changed),
            text(
                &[
                    pkt("unpack ok\n"),
                    pkt("ok refs/heads/main\n"),
                    pkt("ng refs/pull/1/head deny updating a hidden ref\n"),
                    b"0000".to_vec()
                ]
                .concat()
            )
        );
        // Side-band: progress kept, the report re-framed on channel 1.
        let inner = [pkt("unpack ok\n"), pkt("ok refs/heads/main\n"), b"0000".to_vec()].concat();
        let mut channel_one = vec![1u8];
        channel_one.extend_from_slice(&inner);
        let framed_answer = [pkt("\x02Resolving deltas: 100%\n"), pkt(&text(&channel_one)), b"0000".to_vec()].concat();
        let changed = with_refused(&framed_answer, &hidden, true).unwrap();
        let packets = packets(&changed).unwrap();
        assert_eq!(packets[0], Packet::Data(b"\x02Resolving deltas: 100%\n".to_vec()));
        let Packet::Data(report) = &packets[1] else { panic!() };
        assert_eq!(report[0], 1);
        assert!(text(&report[1..]).contains("ng refs/pull/1/head deny updating a hidden ref\n"));
        assert!(text(&report[1..]).ends_with("0000"));
        assert_eq!(packets.last(), Some(&Packet::Special(*b"0000")));
        // Not a report: left alone.
        assert_eq!(with_refused(b"garbage", &hidden, false), None);
    }

    #[test]
    fn the_push_advertisement_leaves_hidden_refs_out() {
        let advertisement = [
            pkt("# service=git-receive-pack\n"),
            b"0000".to_vec(),
            pkt(&format!("{OLD} refs/heads/main\0report-status delete-refs side-band-64k ofs-delta\n")),
            pkt(&format!("{NEW} refs/pull/1/head\n")),
            pkt(&format!("{NEW} refs/pull/1/merge\n")),
            pkt(&format!("{OLD} refs/tags/v1\n")),
            b"0000".to_vec(),
        ]
        .concat();
        let changed = advertisement_without_hidden(&advertisement).unwrap();
        assert_eq!(
            text(&changed),
            text(
                &[
                    pkt("# service=git-receive-pack\n"),
                    b"0000".to_vec(),
                    pkt(&format!("{OLD} refs/heads/main\0report-status delete-refs side-band-64k ofs-delta\n")),
                    pkt(&format!("{OLD} refs/tags/v1\n")),
                    b"0000".to_vec(),
                ]
                .concat()
            )
        );
        // Nothing hidden: nothing to change.
        let plain = [
            pkt("# service=git-receive-pack\n"),
            b"0000".to_vec(),
            pkt(&format!("{OLD} refs/heads/main\0report-status\n")),
            b"0000".to_vec(),
        ]
        .concat();
        assert_eq!(advertisement_without_hidden(&plain), None);
        // Only hidden refs: the capabilities stay, on capabilities^{}.
        let only = [
            pkt("# service=git-receive-pack\n"),
            b"0000".to_vec(),
            pkt(&format!("{NEW} refs/pull/1/head\0report-status\n")),
            b"0000".to_vec(),
        ]
        .concat();
        let changed = advertisement_without_hidden(&only).unwrap();
        assert_eq!(
            text(&changed),
            text(
                &[
                    pkt("# service=git-receive-pack\n"),
                    b"0000".to_vec(),
                    pkt(&format!("{ZERO} capabilities^{{}}\0report-status\n")),
                    b"0000".to_vec()
                ]
                .concat()
            )
        );
    }
}
