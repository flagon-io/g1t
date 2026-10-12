//! Archive links: what lets a download of a branch, tag or commit as a
//! tarball or zip (the site's `/<owner>/<repo>/archive/<commit>.tar.gz`)
//! work with no session or access token, for the REST API's
//! `GET /repos/{owner}/{repo}/tarball/{ref}` and `/zipball/{ref}`, which
//! answer with a redirect to it as GitHub's do to codeload.
//!
//! The token is the commit and when it ends, sealed (AES-256-GCM) under
//! the service's `REPOS_KEY` with the repository's id as associated data:
//! it opens only for that repository, whatever it is called by then, and
//! only for that commit, for [`ARCHIVE_LINK_SECONDS`]. Made only for
//! someone who can read the repository; whoever holds it may download that
//! one commit until it ends.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use g1t_contracts::repos::ARCHIVE_LINK_SECONDS;
use g1t_secrets::Sealer;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct Sealed {
    /// The commit.
    c: String,
    /// When it ends, in milliseconds since the epoch.
    e: u64,
}

fn bound_to(repo_id: &str) -> String {
    format!("archive link:{repo_id}")
}

/// A token for `commit` of the repository `repo_id`, and when it ends.
pub fn seal(sealer: &Sealer, repo_id: &str, commit: &str, now_ms: u64) -> (String, u64) {
    let expires = now_ms + ARCHIVE_LINK_SECONDS * 1000;
    let plain = serde_json::to_vec(&Sealed { c: commit.to_owned(), e: expires }).expect("serializable");
    (URL_SAFE_NO_PAD.encode(sealer.seal_bytes(&plain, &bound_to(repo_id))), expires)
}

/// The commit a token lets anyone download from the repository `repo_id`,
/// while it has not ended.
pub fn open(sealer: &Sealer, repo_id: &str, token: &str, now_ms: u64) -> Option<String> {
    if token.len() > 1024 {
        return None;
    }
    let sealed = URL_SAFE_NO_PAD.decode(token.trim()).ok()?;
    let plain = sealer.open_bytes(&sealed, &bound_to(repo_id))?;
    let Sealed { c, e } = serde_json::from_slice(&plain).ok()?;
    (e > now_ms && is_commit(&c)).then_some(c)
}

fn is_commit(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sealer() -> Sealer {
        Sealer::new(&"ab".repeat(32)).unwrap()
    }

    const COMMIT: &str = "4807077b296e6edbf410d55e72749d3e1170c291";

    #[test]
    fn a_token_opens_for_its_repository_and_commit_until_it_ends() {
        let sealer = sealer();
        let (token, expires) = seal(&sealer, "repo_1", COMMIT, 1_000);
        assert_eq!(expires, 1_000 + 600_000);
        // Safe in a query string as it is.
        assert!(token.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'));
        assert_eq!(open(&sealer, "repo_1", &token, 2_000).as_deref(), Some(COMMIT));
        // Not for another repository, nor once it has ended.
        assert_eq!(open(&sealer, "repo_2", &token, 2_000), None);
        assert_eq!(open(&sealer, "repo_1", &token, expires), None);
        // Nor under another key, nor changed.
        let other = Sealer::new(&"cd".repeat(32)).unwrap();
        assert_eq!(open(&other, "repo_1", &token, 2_000), None);
        let mut changed = token.clone().into_bytes();
        let last = changed.len() - 2;
        changed[last] = if changed[last] == b'A' { b'B' } else { b'A' };
        assert_eq!(open(&sealer, "repo_1", &String::from_utf8(changed).unwrap(), 2_000), None);
        assert_eq!(open(&sealer, "repo_1", "not a token", 2_000), None);
    }
}
