//! Actions from GitHub, kept on g1t.
//!
//! An action `uses:` names that g1t does not host (reach.rs) comes from
//! GitHub. Before a job fetches it, g1t resolves its ref to a commit, as
//! GitHub's runner does, from the repository's advertisement
//! (`info/refs`, which no API rate limit applies to), and keeps that
//! commit's archive in R2. Every later job that uses the action at that
//! commit downloads it from g1t: faster than GitHub, the same bytes
//! whatever happens to the tag, and there while GitHub is not.
//!
//! - A ref is looked up again once `REF_FRESH_MS` has passed, so a moved
//!   tag (`v4` moving to a new release) is followed within minutes. When
//!   GitHub does not answer, the commit the ref last named is used, and
//!   the job says so.
//! - A commit's archive is the one GitHub serves for it, which never
//!   changes. One larger than `ARCHIVE_MAX_BYTES` is not kept: the job
//!   fetches it from GitHub itself.
//! - An archive no job has used for `ARCHIVE_UNUSED_DAYS` is deleted by
//!   the hourly sweep. Archives are g1t's own, shared by every workspace,
//!   and charged to none.

use futures_util::StreamExt;
use g1t_contracts::time::rfc3339;
use g1t_kit::now_ms;
use serde::Deserialize;
use serde_json::{Value, json};
use worker::Result;

use crate::Actions;
use crate::reach::UsesRef;

/// The largest archive kept: the Worker holds it whole while saving it.
pub(crate) const ARCHIVE_MAX_BYTES: usize = 32 * 1024 * 1024;
/// How long a ref's commit is trusted before GitHub is asked again.
pub(crate) const REF_FRESH_MS: u64 = 5 * 60 * 1000;
/// An archive unused this long is deleted.
pub(crate) const ARCHIVE_UNUSED_DAYS: u64 = 30;
/// An advertisement larger than this is not read: a ref is never worth it.
const ADVERTISEMENT_MAX_BYTES: usize = 8 * 1024 * 1024;
const DAY_MS: u64 = 24 * 60 * 60 * 1000;

/// Whether `text` is a whole commit id.
pub(crate) fn is_sha(text: &str) -> bool {
    text.len() == 40 && text.chars().all(|c| c.is_ascii_hexdigit())
}

/// The refs a smart HTTP advertisement (`info/refs?service=git-upload-pack`)
/// lists, as (commit, name). Peeled tags keep their `^{}`.
pub(crate) fn parse_advertisement(bytes: &[u8]) -> Vec<(String, String)> {
    let mut refs = Vec::new();
    let mut at = 0;
    while at + 4 <= bytes.len() {
        let Some(length) = std::str::from_utf8(&bytes[at..at + 4]).ok().and_then(|hex| usize::from_str_radix(hex, 16).ok()) else {
            break;
        };
        // A flush or delimiter packet.
        if length < 4 {
            at += 4;
            continue;
        }
        if at + length > bytes.len() {
            break;
        }
        let line = String::from_utf8_lossy(&bytes[at + 4..at + length]);
        at += length;
        let line = line.trim_end_matches('\n');
        if line.starts_with('#') {
            continue;
        }
        // The first ref carries the capabilities after a NUL.
        let line = line.split('\0').next().unwrap_or_default();
        if let Some((sha, name)) = line.split_once(' ')
            && is_sha(sha)
        {
            refs.push((sha.to_ascii_lowercase(), name.to_owned()));
        }
    }
    refs
}

/// The commit `wanted` names among `refs`, as git reads a short name: a
/// commit id as it is, else a tag, else a branch (`refs/…` names one
/// exactly). A tag's commit is its peeled one.
pub(crate) fn pick(refs: &[(String, String)], wanted: &str) -> Option<String> {
    if is_sha(wanted) {
        return Some(wanted.to_ascii_lowercase());
    }
    let names: Vec<String> = if wanted.starts_with("refs/") {
        vec![wanted.to_owned()]
    } else {
        vec![format!("refs/tags/{wanted}"), format!("refs/heads/{wanted}")]
    };
    names.iter().find_map(|name| {
        let peeled = format!("{name}^{{}}");
        refs.iter()
            .find(|(_, listed)| *listed == peeled)
            .or_else(|| refs.iter().find(|(_, listed)| listed == name))
            .map(|(sha, _)| sha.clone())
    })
}

/// Where a commit's archive is kept in R2.
pub(crate) fn archive_object(repository: &str, sha: &str) -> String {
    format!("action-archives/{}/{sha}.tar.gz", repository.to_ascii_lowercase())
}

/// A GET to GitHub, whose body is read up to `max` bytes. None when it
/// does not answer 200, or sends more.
async fn fetch_capped(url: &str, max: usize) -> Option<Vec<u8>> {
    let headers = worker::Headers::new();
    // GitHub answers a smart HTTP advertisement to git, which it knows by
    // its agent.
    headers.set("user-agent", "git/2.47.0 (g1t)").ok()?;
    let mut init = worker::RequestInit::new();
    init.with_method(worker::Method::Get).with_headers(headers);
    let request = worker::Request::new_with_init(url, &init).ok()?;
    let mut response = worker::Fetch::Request(request).send().await.ok()?;
    if response.status_code() != 200 {
        return None;
    }
    let mut stream = response.stream().ok()?;
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        body.extend_from_slice(&chunk.ok()?);
        if body.len() > max {
            return None;
        }
    }
    Some(body)
}

/// The status GitHub answers a GET with, or None when it doesn't answer.
async fn status_of(url: &str) -> Option<u16> {
    let headers = worker::Headers::new();
    headers.set("user-agent", "git/2.47.0 (g1t)").ok()?;
    let mut init = worker::RequestInit::new();
    init.with_method(worker::Method::Get).with_headers(headers);
    let request = worker::Request::new_with_init(url, &init).ok()?;
    let response = worker::Fetch::Request(request).send().await.ok()?;
    Some(response.status_code())
}

/// What GitHub's answer to a repository's advertisement says about it:
/// Some(true) when it publishes the repository, Some(false) when it says
/// there is none it will show (GitHub answers 401 for a repository that
/// doesn't exist as for a private one), None for anything else, such as a
/// rate limit or an error.
pub(crate) fn published_by(status: Option<u16>) -> Option<bool> {
    match status? {
        200 => Some(true),
        401 | 404 => Some(false),
        _ => None,
    }
}

#[derive(Deserialize)]
struct RefRow {
    sha: String,
    resolved_at: String,
}

impl Actions {
    /// Where a job gets `used`, an action g1t does not host:
    /// `{"source": "github", "sha", "archive", "note"}`. `sha` is the commit
    /// its ref names (absent when GitHub does not know it, or never
    /// answered), `archive` whether g1t keeps that commit's archive for the
    /// job to download, and `note` anything the job should say about it.
    pub(crate) async fn github_action(&self, used: &UsesRef) -> Result<Value> {
        let repository = used.full_name().to_ascii_lowercase();
        let now = now_ms();
        let (sha, note) = self.resolve_github(&repository, &used.git_ref, now).await?;
        let Some(sha) = sha else {
            return Ok(json!({ "source": "github", "note": note }));
        };
        let archive = self.keep_archive(&repository, &sha, now).await?;
        Ok(json!({ "source": "github", "sha": sha, "archive": archive, "note": note }))
    }

    /// Whether GitHub publishes `repository` (`owner/repo`): Some(true) when
    /// it does, or once named a commit of it for a job; Some(false) when it
    /// says it has no such repository; None when it could not say.
    pub(crate) async fn github_publishes(&self, repository: &str) -> Result<Option<bool>> {
        let repository = repository.to_ascii_lowercase();
        let seen = self
            .db
            .prepare("SELECT sha FROM action_refs WHERE repository = ? LIMIT 1")
            .bind(&[repository.as_str().into()])?
            .first::<Value>(None)
            .await?;
        if seen.is_some() {
            return Ok(Some(true));
        }
        Ok(published_by(status_of(&format!("https://github.com/{repository}.git/info/refs?service=git-upload-pack")).await))
    }

    /// The commit `git_ref` names in GitHub's `repository`, and a note when
    /// it is the one it last named because GitHub did not answer.
    async fn resolve_github(&self, repository: &str, git_ref: &str, now: u64) -> Result<(Option<String>, Option<String>)> {
        if is_sha(git_ref) {
            return Ok((Some(git_ref.to_ascii_lowercase()), None));
        }
        let known = self
            .db
            .prepare("SELECT sha, resolved_at FROM action_refs WHERE repository = ? AND ref = ?")
            .bind(&[repository.into(), git_ref.into()])?
            .first::<RefRow>(None)
            .await?;
        if let Some(row) = &known
            && row.resolved_at >= rfc3339(now.saturating_sub(REF_FRESH_MS))
        {
            return Ok((Some(row.sha.clone()), None));
        }
        let url = format!("https://github.com/{repository}.git/info/refs?service=git-upload-pack");
        match fetch_capped(&url, ADVERTISEMENT_MAX_BYTES).await {
            Some(advertisement) => {
                let Some(sha) = pick(&parse_advertisement(&advertisement), git_ref) else {
                    return Ok((None, None));
                };
                self.db
                    .prepare(
                        "INSERT INTO action_refs (repository, ref, sha, resolved_at) VALUES (?1, ?2, ?3, ?4)
                         ON CONFLICT (repository, ref) DO UPDATE SET sha = ?3, resolved_at = ?4",
                    )
                    .bind(&[repository.into(), git_ref.into(), sha.as_str().into(), rfc3339(now).into()])?
                    .run()
                    .await?;
                Ok((Some(sha), None))
            }
            None => Ok(match known {
                Some(row) => {
                    let note = format!(
                        "GitHub did not say which commit {repository}@{git_ref} is; using {}, which it named on {}.",
                        &row.sha,
                        row.resolved_at.get(..10).unwrap_or(&row.resolved_at)
                    );
                    (Some(row.sha), Some(note))
                }
                None => (None, None),
            }),
        }
    }

    /// Whether g1t keeps the archive of `repository` at `sha`, fetching it
    /// from GitHub the first time.
    async fn keep_archive(&self, repository: &str, sha: &str, now: u64) -> Result<bool> {
        let Some(bucket) = &self.cache else { return Ok(false) };
        #[derive(Deserialize)]
        struct Kept {
            used_at: String,
        }
        let kept = self
            .db
            .prepare("SELECT used_at FROM action_archives WHERE repository = ? AND sha = ?")
            .bind(&[repository.into(), sha.into()])?
            .first::<Kept>(None)
            .await?;
        if let Some(kept) = kept {
            // Marked used at most once a day: the sweep needs no more.
            if kept.used_at < rfc3339(now.saturating_sub(DAY_MS)) {
                self.db
                    .prepare("UPDATE action_archives SET used_at = ? WHERE repository = ? AND sha = ?")
                    .bind(&[rfc3339(now).into(), repository.into(), sha.into()])?
                    .run()
                    .await?;
            }
            return Ok(true);
        }
        let url = format!("https://codeload.github.com/{repository}/tar.gz/{sha}");
        let Some(archive) = fetch_capped(&url, ARCHIVE_MAX_BYTES).await else {
            return Ok(false);
        };
        let object = archive_object(repository, sha);
        let size = archive.len();
        if let Err(error) = bucket.put(&object, archive).execute().await {
            worker::console_error!("actions: the archive of {repository}@{sha} was not kept: {error}");
            return Ok(false);
        }
        let at = rfc3339(now);
        self.db
            .prepare(
                "INSERT INTO action_archives (repository, sha, object, size, stored_at, used_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
                 ON CONFLICT (repository, sha) DO UPDATE SET used_at = ?5",
            )
            .bind(&[repository.into(), sha.into(), object.into(), (size as f64).into(), at.into()])?
            .run()
            .await?;
        Ok(true)
    }

    /// `job_action_archive`: a running job downloads an action's archive
    /// g1t keeps, by `report.repository` and `report.sha`. Answers the R2
    /// object to send, `{"object", "size"}`. Any job may: they are public
    /// repositories' code.
    pub async fn job_action_archive(&self, a: g1t_contracts::actions::JobCallArgs) -> Result<g1t_contracts::Outcome<Value>> {
        crate::check!(self.job_for_token(&a).await?);
        let repository = a.report["repository"].as_str().unwrap_or_default().to_ascii_lowercase();
        let sha = a.report["sha"].as_str().unwrap_or_default().to_ascii_lowercase();
        if !is_sha(&sha) || crate::reach::parse_uses(&format!("{repository}@{sha}")).is_none() {
            return Ok(crate::fail(g1t_contracts::FailureCode::Invalid, "Name the action's repository as owner/repo, and its commit."));
        }
        #[derive(Deserialize)]
        struct Kept {
            object: String,
            size: f64,
        }
        let kept = self
            .db
            .prepare("SELECT object, size FROM action_archives WHERE repository = ? AND sha = ?")
            .bind(&[repository.as_str().into(), sha.as_str().into()])?
            .first::<Kept>(None)
            .await?;
        Ok(match kept {
            Some(kept) => g1t_contracts::Outcome::Ok(json!({ "object": kept.object, "size": kept.size })),
            None => crate::fail(g1t_contracts::FailureCode::NotFound, format!("g1t does not keep {repository}@{sha}.")),
        })
    }

    /// Hourly: archives no job has used for `ARCHIVE_UNUSED_DAYS`, and refs
    /// not looked up as long.
    pub async fn sweep_action_archives(&self, now: u64) -> Result<()> {
        let before = rfc3339(now.saturating_sub(ARCHIVE_UNUSED_DAYS * DAY_MS));
        #[derive(Deserialize)]
        struct Gone {
            repository: String,
            sha: String,
            object: String,
        }
        let gone = self
            .db
            .prepare("SELECT repository, sha, object FROM action_archives WHERE used_at < ? LIMIT 100")
            .bind(&[before.as_str().into()])?
            .all()
            .await?
            .results::<Gone>()?;
        if let Some(bucket) = &self.cache
            && !gone.is_empty()
        {
            bucket.delete_multiple(gone.iter().map(|g| g.object.as_str()).collect()).await?;
            for archive in &gone {
                self.db
                    .prepare("DELETE FROM action_archives WHERE repository = ? AND sha = ?")
                    .bind(&[archive.repository.as_str().into(), archive.sha.as_str().into()])?
                    .run()
                    .await?;
            }
        }
        self.db.prepare("DELETE FROM action_refs WHERE resolved_at < ?").bind(&[before.into()])?.run().await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pkt(payload: &str) -> Vec<u8> {
        let mut out = format!("{:04x}", payload.len() + 4).into_bytes();
        out.extend_from_slice(payload.as_bytes());
        out
    }

    const MAIN: &str = "1111111111111111111111111111111111111111";
    const V4_TAG: &str = "2222222222222222222222222222222222222222";
    const V4_COMMIT: &str = "3333333333333333333333333333333333333333";
    const V1_BRANCH: &str = "4444444444444444444444444444444444444444";
    const V1_TAG: &str = "5555555555555555555555555555555555555555";

    fn advertisement() -> Vec<u8> {
        let mut bytes = pkt("# service=git-upload-pack\n");
        bytes.extend_from_slice(b"0000");
        bytes.extend(pkt(&format!("{MAIN} HEAD\0multi_ack thin-pack symref=HEAD:refs/heads/main\n")));
        bytes.extend(pkt(&format!("{MAIN} refs/heads/main\n")));
        bytes.extend(pkt(&format!("{V1_BRANCH} refs/heads/v1\n")));
        bytes.extend(pkt(&format!("{V1_TAG} refs/tags/v1\n")));
        bytes.extend(pkt(&format!("{V4_TAG} refs/tags/v4\n")));
        bytes.extend(pkt(&format!("{V4_COMMIT} refs/tags/v4^{{}}\n")));
        bytes.extend_from_slice(b"0000");
        bytes
    }

    #[test]
    fn only_an_answer_from_github_says_it_has_no_such_repository() {
        assert_eq!(published_by(Some(200)), Some(true));
        assert_eq!(published_by(Some(401)), Some(false));
        assert_eq!(published_by(Some(404)), Some(false));
        // A rate limit, an error or no answer says nothing, so the name stays GitHub's.
        assert_eq!(published_by(Some(429)), None);
        assert_eq!(published_by(Some(503)), None);
        assert_eq!(published_by(None), None);
    }

    #[test]
    fn an_advertisement_lists_its_refs_capabilities_aside() {
        let refs = parse_advertisement(&advertisement());
        assert_eq!(refs.len(), 6);
        assert_eq!(refs[0], (MAIN.to_owned(), "HEAD".to_owned()));
        assert_eq!(refs[5], (V4_COMMIT.to_owned(), "refs/tags/v4^{}".to_owned()));
        // Cut short: what came whole is kept.
        let whole = advertisement();
        assert_eq!(parse_advertisement(&whole[..whole.len() - 30]).len(), 5);
        assert!(parse_advertisement(b"not git").is_empty());
    }

    #[test]
    fn a_ref_is_read_as_git_reads_a_short_name() {
        let refs = parse_advertisement(&advertisement());
        // A tag's commit, not the tag object.
        assert_eq!(pick(&refs, "v4").as_deref(), Some(V4_COMMIT));
        // A tag before a branch of the same name.
        assert_eq!(pick(&refs, "v1").as_deref(), Some(V1_TAG));
        assert_eq!(pick(&refs, "refs/heads/v1").as_deref(), Some(V1_BRANCH));
        assert_eq!(pick(&refs, "main").as_deref(), Some(MAIN));
        // A commit is itself, known or not.
        let other = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";
        assert_eq!(pick(&refs, other).as_deref(), Some("abcdef0123456789abcdef0123456789abcdef01"));
        assert_eq!(pick(&refs, "v9"), None);
        assert_eq!(pick(&refs, "abc123"), None);
    }

    #[test]
    fn archives_are_kept_by_repository_and_commit() {
        assert_eq!(archive_object("Actions/Checkout", V4_COMMIT), format!("action-archives/actions/checkout/{V4_COMMIT}.tar.gz"));
        assert!(is_sha(MAIN));
        assert!(!is_sha("v4"));
    }
}
