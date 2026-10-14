//! Dependency alerts from the latest scan, on Git's progress channel.
//! Never turn a successful push into a failure when security is unavailable.

use g1t_contracts::repos::{Repo, RepoPath};
use g1t_contracts::security::{OverviewArgs, SeverityCounts};
use g1t_contracts::{Outcome, User};
use worker::Fetcher;

use crate::git_http::pkt_line;

/// Strict packets with a terminal flush. Plain report-status and malformed
/// responses must remain untouched: only negotiated side-band carries text.
fn packets(mut bytes: &[u8]) -> Option<Vec<&[u8]>> {
    let mut result = Vec::new();
    loop {
        let size = usize::from_str_radix(std::str::from_utf8(bytes.get(..4)?).ok()?, 16).ok()?;
        if size == 0 {
            return (bytes.len() == 4).then_some(result);
        }
        if size <= 4 {
            return None;
        }
        result.push(bytes.get(4..size)?);
        bytes = bytes.get(size..)?;
    }
}

fn successful(report: &[u8]) -> bool {
    let Some(bands) = packets(report) else {
        return false;
    };
    let mut status = Vec::new();
    for band in bands {
        match band[0] {
            1 => status.extend_from_slice(&band[1..]),
            2 => {}
            _ => return false,
        }
    }
    let Some(lines) = packets(&status) else {
        return false;
    };
    lines.first() == Some(&b"unpack ok\n".as_slice())
        && lines.iter().any(|line| line.starts_with(b"ok "))
}

fn message(counts: &SeverityCounts, namespace: &str, name: &str) -> Option<String> {
    let severities = [
        (counts.critical, "critical"),
        (counts.high, "high"),
        (counts.medium, "moderate"),
        (counts.low, "low"),
        (counts.unknown, "unrated"),
    ];
    let total: u64 = severities.iter().map(|(n, _)| u64::from(*n)).sum();
    if total == 0 {
        return None;
    }
    let details = severities
        .iter()
        .filter(|(n, _)| *n > 0)
        .map(|(n, label)| format!("{n} {label}"))
        .collect::<Vec<_>>()
        .join(", ");
    let noun = if total == 1 {
        "vulnerability"
    } else {
        "vulnerabilities"
    };
    Some(format!(
        "\ng1t found {total} {noun} on {namespace}/{name}'s default branch ({details}).\nLatest completed scan; default-branch pushes are re-scanned in the background.\nTo find out more, visit:\n     https://g1t.sh/{namespace}/{name}/security/vulnerabilities\n\n"
    ))
}

fn append(report: &mut Vec<u8>, text: &str) {
    report.truncate(report.len() - 4);
    // Also fits the original side-band capability's 1000-byte limit.
    for chunk in text.as_bytes().chunks(990) {
        let mut payload = vec![2];
        payload.extend_from_slice(chunk);
        report.extend(pkt_line(&payload));
    }
    report.extend_from_slice(b"0000");
}

pub(crate) async fn add(
    report: &mut Vec<u8>,
    security: Option<&Fetcher>,
    repo: &Repo,
    viewer: &Option<User>,
) {
    if !successful(report) {
        return;
    }
    let Some(security) = security else { return };
    let args = OverviewArgs {
        repo: RepoPath {
            namespace: repo.namespace.clone(),
            name: repo.name.clone(),
        },
        viewer: viewer.clone(),
    };
    match g1t_kit::call_within::<_, Outcome<SeverityCounts>>(
        security,
        "push_summary",
        &args,
        std::time::Duration::from_secs(2),
    )
    .await
    {
        Ok(Some(Outcome::Ok(counts))) => {
            if let Some(text) = message(&counts, &repo.namespace, &repo.name) {
                append(report, &text);
            }
        }
        Ok(Some(Outcome::Fail(_)) | None) => {}
        Err(error) => worker::console_warn!("push security summary unavailable: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(lines: &[&str]) -> Vec<u8> {
        let mut status: Vec<u8> = lines
            .iter()
            .flat_map(|line| pkt_line(line.as_bytes()))
            .collect();
        status.extend_from_slice(b"0000");
        // Split inside a status packet to exercise reassembly.
        let mut answer = Vec::new();
        for chunk in status.chunks(7) {
            let mut band = vec![1];
            band.extend_from_slice(chunk);
            answer.extend(pkt_line(&band));
        }
        answer.extend_from_slice(b"0000");
        answer
    }

    #[test]
    fn progress_preserves_status_and_terminal_flush() {
        let mut answer = report(&[
            "unpack ok\n",
            "ok refs/heads/main\n",
            "ng refs/pull/1/head hidden\n",
        ]);
        assert!(successful(&answer));
        let original = answer[..answer.len() - 4].to_vec();
        append(&mut answer, &"hello\n".repeat(400));
        assert!(answer.starts_with(&original));
        assert!(successful(&answer));
        let bands = packets(&answer).unwrap();
        let progress: Vec<u8> = bands
            .iter()
            .filter(|band| band[0] == 2)
            .flat_map(|band| band[1..].iter().copied())
            .collect();
        assert_eq!(progress, "hello\n".repeat(400).as_bytes());
        assert!(bands.iter().all(|band| band.len() + 4 <= 1000));
    }

    #[test]
    fn refusals_plain_and_malformed_reports_are_unchanged() {
        assert!(!successful(&report(&[
            "unpack ok\n",
            "ng refs/heads/main denied\n"
        ])));
        assert!(!successful(&report(&[
            "unpack failed\n",
            "ok refs/heads/main\n"
        ])));
        assert!(!successful(b"000eunpack ok\n0000"));
        assert!(!successful(b"0000"));
        let answer = report(&["unpack ok\n", "ok refs/heads/main\n"]);
        for end in 0..answer.len() {
            assert!(!successful(&answer[..end]));
        }
    }

    #[test]
    fn counts_are_explicit_about_scan_freshness() {
        assert_eq!(message(&SeverityCounts::default(), "acme", "repo"), None);
        let text = message(
            &SeverityCounts {
                high: 2,
                medium: 1,
                ..Default::default()
            },
            "acme",
            "repo",
        )
        .unwrap();
        assert!(text.contains("3 vulnerabilities"));
        assert!(text.contains("2 high, 1 moderate"));
        assert!(text.contains("Latest completed scan"));
        assert!(text.contains("https://g1t.sh/acme/repo/security/vulnerabilities"));
        assert!(
            message(
                &SeverityCounts {
                    unknown: 1,
                    ..Default::default()
                },
                "acme",
                "repo"
            )
            .unwrap()
            .contains("1 vulnerability")
        );
    }
}
