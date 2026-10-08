//! What a repository's About reads from its files and history: its
//! license, its security policy, its languages and its contributors.
//!
//! Worked out for the default branch's head in the background, never on
//! the way to a page: a request that finds the kept answer behind the head
//! (or none at all) answers with what is kept and starts the work in its
//! `wait_until` (`lib.rs`, `refresh`). One run at a time per repository,
//! by a lease in `repo_stats.started_ms`. What it reads is kept by hash in
//! the store's cache (trees, blob sizes, history), so working out the next
//! commit reads only what changed. A run that runs out of time keeps what
//! it read, marked `partial`, and the next view starts another.

use std::collections::{HashMap, HashSet};

use g1t_contracts::about::{ABOUT_CONTRIBUTORS, Contributor, Contributors, Freshness, LanguageShare, Languages, License, WeekCommits};
use g1t_contracts::accounts::{EmailOwner, EmailOwnersArgs};
use g1t_contracts::repos::{FileEntry, MAX_LISTED_FILES, Repo};
use g1t_contracts::time::rfc3339;
use g1t_kit::now_ms;
use serde::{Deserialize, Serialize};
use worker::wasm_bindgen::JsValue;
use worker::{D1Database, Fetcher, Result};

use crate::contributors::{Authored, tally};
use crate::languages::{self, Attributes};
use crate::license;
use crate::store::GitRepo;

/// A run older than this is taken to have died.
pub const LEASE_MS: u64 = 120_000;
/// How long a run reads before keeping what it has.
const BUDGET_MS: u64 = 22_000;
/// The most commits of history read for contributors.
pub const MAX_HISTORY: usize = 3_000;
/// Commits read at a time.
const LOG_PAGE: u32 = 200;
/// The most blobs sized for languages.
const MAX_SIZED: usize = 6_000;
/// Blobs sized at once: each is a round trip to the store.
const SIZE_BATCH: usize = 32;
/// The most distinct addresses matched to accounts.
const MAX_MATCHED: usize = 1_000;
/// Directories never read: nothing in them ever counts.
const NEVER_READ: [&str; 3] = ["node_modules", "bower_components", "jspm_packages"];
/// Where a security policy may be.
const POLICY_DIRS: [&str; 4] = ["", ".g1t/", ".github/", "docs/"];

/// How the About is worked out; a row kept by an older version is worked
/// out again. 1: g1t's older commit addresses count as g1t.
pub const STATS_VERSION: f64 = 1.0;

/// What `repo_stats` keeps for the About, without the full contributors.
#[derive(Debug, Default, Deserialize)]
pub struct Kept {
    pub commit_hash: Option<String>,
    pub computed_at: Option<String>,
    pub started_ms: Option<f64>,
    pub partial: f64,
    pub license: Option<String>,
    pub security_policy: Option<String>,
    pub languages: Option<String>,
    pub contributors_total: f64,
    pub contributors_top: Option<String>,
    /// [`STATS_VERSION`] when it was worked out.
    #[serde(default)]
    pub version: f64,
}

impl Kept {
    /// Whether a run is under way now.
    pub fn running(&self, now: u64) -> bool {
        self.started_ms.is_some_and(|started| now.saturating_sub(started as u64) < LEASE_MS)
    }

    /// Whether a new run should start: the head moved past what is kept,
    /// or what is kept is partial, and none is under way.
    pub fn wants_run(&self, head: Option<&str>, now: u64) -> bool {
        let Some(head) = head else { return false };
        let behind = self.commit_hash.as_deref() != Some(head) || self.partial > 0.0 || self.version < STATS_VERSION;
        // A partial answer is tried again at most every lease.
        let rested = self.partial == 0.0 || self.started_ms.is_none_or(|started| now.saturating_sub(started as u64) >= LEASE_MS);
        behind && rested && !self.running(now)
    }

    pub fn freshness(&self, head: Option<String>) -> Freshness {
        Freshness {
            pending: head.is_some() && self.commit_hash.is_none(),
            head,
            commit: self.commit_hash.clone(),
            computed_at: self.computed_at.clone(),
            partial: self.partial > 0.0,
        }
    }

    pub fn license(&self) -> Option<License> {
        self.license.as_deref().and_then(|text| serde_json::from_str(text).ok())
    }

    pub fn languages(&self) -> Vec<LanguageShare> {
        self.languages.as_deref().and_then(|text| serde_json::from_str(text).ok()).unwrap_or_default()
    }

    pub fn top_contributors(&self) -> Vec<Contributor> {
        self.contributors_top.as_deref().and_then(|text| serde_json::from_str(text).ok()).unwrap_or_default()
    }
}

/// What `repo_stats` keeps for a repository; the default when nothing is.
pub async fn kept(db: &D1Database, repo_id: &str) -> Result<Kept> {
    Ok(db
        .prepare(
            "SELECT commit_hash, computed_at, started_ms, partial, license, security_policy, languages, contributors_total, contributors_top, version
             FROM repo_stats WHERE repo_id = ?",
        )
        .bind(&[repo_id.into()])?
        .first::<Kept>(None)
        .await?
        .unwrap_or_default())
}

/// The whole contributors answer kept for a repository.
#[derive(Debug, Default, Serialize, Deserialize)]
struct KeptContributors {
    commits: u32,
    contributors: Vec<Contributor>,
    weeks: Vec<WeekCommits>,
}

/// The Contributors page's answer, as kept.
pub async fn contributors(db: &D1Database, repo_id: &str, head: Option<String>) -> Result<Contributors> {
    #[derive(Deserialize)]
    struct Row {
        contributors: Option<String>,
    }
    let summary = kept(db, repo_id).await?;
    let full: KeptContributors = db
        .prepare("SELECT contributors FROM repo_stats WHERE repo_id = ?")
        .bind(&[repo_id.into()])?
        .first::<Row>(None)
        .await?
        .and_then(|row| row.contributors)
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    Ok(Contributors {
        freshness: summary.freshness(head),
        total: summary.contributors_total as u32,
        commits: full.commits,
        contributors: full.contributors,
        weeks: full.weeks,
    })
}

/// The languages answer, as kept.
pub fn languages_of(kept: &Kept, head: Option<String>) -> Languages {
    Languages { freshness: kept.freshness(head), languages: kept.languages() }
}

/// Takes the lease for a run, unless one is under way. Whether it was taken.
pub async fn claim(db: &D1Database, repo_id: &str, now: u64) -> Result<bool> {
    let taken = db
        .prepare(
            "INSERT INTO repo_stats (repo_id, started_ms) VALUES (?1, ?2)
             ON CONFLICT (repo_id) DO UPDATE SET started_ms = excluded.started_ms
             WHERE repo_stats.started_ms IS NULL OR repo_stats.started_ms < ?3
             RETURNING repo_id",
        )
        .bind(&[repo_id.into(), JsValue::from_f64(now as f64), JsValue::from_f64(now.saturating_sub(LEASE_MS) as f64)])?
        .first::<serde_json::Value>(None)
        .await?;
    Ok(taken.is_some())
}

/// Everything one run worked out.
#[derive(Debug, Default)]
pub struct Worked {
    pub commit: String,
    pub partial: bool,
    pub license: Option<License>,
    pub security_policy: Option<String>,
    pub languages: Vec<LanguageShare>,
    pub contributors: Vec<Contributor>,
    pub contributors_total: u32,
    pub commits: u32,
    pub weeks: Vec<WeekCommits>,
}

/// Keeps a run's answer and lets the lease go. A partial answer keeps its
/// lease's start, so the next is not tried until the lease is over.
pub async fn keep(db: &D1Database, repo_id: &str, worked: &Worked) -> Result<()> {
    let top: Vec<Contributor> = worked
        .contributors
        .iter()
        .take(ABOUT_CONTRIBUTORS)
        .map(|contributor| Contributor { weeks: Vec::new(), ..contributor.clone() })
        .collect();
    let full = KeptContributors { commits: worked.commits, contributors: worked.contributors.clone(), weeks: worked.weeks.clone() };
    db.prepare(
        "UPDATE repo_stats SET commit_hash = ?2, computed_at = ?3, started_ms = CASE WHEN ?4 = 1 THEN started_ms ELSE NULL END,
           partial = ?4, license = ?5, security_policy = ?6, languages = ?7, contributors_total = ?8, contributors_top = ?9,
           contributors = ?10, version = ?11
         WHERE repo_id = ?1",
    )
    .bind(&[
        repo_id.into(),
        worked.commit.as_str().into(),
        rfc3339(now_ms()).into(),
        JsValue::from_f64(if worked.partial { 1.0 } else { 0.0 }),
        match &worked.license {
            Some(license) => json(license).into(),
            None => JsValue::NULL,
        },
        match &worked.security_policy {
            Some(path) => path.as_str().into(),
            None => JsValue::NULL,
        },
        json(&worked.languages).into(),
        JsValue::from_f64(f64::from(worked.contributors_total)),
        json(&top).into(),
        json(&full).into(),
        JsValue::from_f64(STATS_VERSION),
    ])?
    .run()
    .await?;
    Ok(())
}

/// Lets the lease go after a run that failed, so the next view tries again
/// once the lease would have ended anyway.
pub async fn release(db: &D1Database, repo_id: &str) {
    let statement = db
        .prepare("UPDATE repo_stats SET started_ms = ?2 WHERE repo_id = ?1")
        .bind(&[repo_id.into(), JsValue::from_f64(now_ms().saturating_sub(LEASE_MS / 2) as f64)]);
    if let Ok(statement) = statement
        && let Err(error) = statement.run().await
    {
        worker::console_error!("the About's lease of {repo_id} was not let go: {error}");
    }
}

fn json<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_owned())
}

/// The security policy among a repository's files, at the root or in
/// `.g1t`, `.github` or `docs`.
pub fn security_policy(files: &[FileEntry]) -> Option<String> {
    POLICY_DIRS.iter().find_map(|dir| {
        files
            .iter()
            .find(|file| {
                file.path
                    .strip_prefix(dir)
                    .is_some_and(|name| !name.contains('/') && (name.eq_ignore_ascii_case("security.md") || name.eq_ignore_ascii_case("security.txt") && dir.is_empty()))
            })
            .map(|file| file.path.clone())
    })
}

/// Works out the About of `repo` at `head` (a commit). `identity` matches
/// authors' addresses to accounts.
pub async fn work_out<R: GitRepo>(git: &R, head: &str, tree: &str, identity: Option<&Fetcher>) -> Result<Worked> {
    let started = now_ms();
    let out_of_time = move || now_ms().saturating_sub(started) > BUDGET_MS;
    let never: Vec<String> = NEVER_READ.iter().map(|dir| (*dir).to_owned()).collect();
    let files = async {
        let (files, truncated) = crate::listing::changed(git, None, tree, &never, MAX_LISTED_FILES).await?;
        let root: Vec<&FileEntry> = files.iter().filter(|file| !file.path.contains('/')).collect();
        // The license: the best-named license file that reads as text.
        let mut license = None;
        for name in license::candidates(root.iter().map(|file| file.path.as_str())) {
            let Some(hash) = root.iter().find(|file| file.path == name).and_then(|file| file.hash.clone()) else { continue };
            if let Some(text) = git.read_blob(&hash).await?.and_then(|bytes| String::from_utf8(bytes).ok()) {
                license = Some(license::detect(name, &text));
                break;
            }
        }
        let attributes = match root.iter().find(|file| file.path == ".gitattributes").and_then(|file| file.hash.clone()) {
            Some(hash) => git
                .read_blob(&hash)
                .await?
                .map(|bytes| Attributes::parse(&String::from_utf8_lossy(&bytes)))
                .unwrap_or_default(),
            None => Attributes::default(),
        };
        let policy = security_policy(&files);
        // Each counted file's language, its blob sized once.
        let mut counted: Vec<(&'static languages::Language, String)> = Vec::new();
        for file in &files {
            let Some(hash) = &file.hash else { continue };
            if let Some(language) = languages::counted(&file.path, &attributes) {
                counted.push((language, hash.clone()));
            }
        }
        let mut partial = truncated || counted.len() > MAX_SIZED;
        counted.truncate(MAX_SIZED);
        let distinct: Vec<String> = counted.iter().map(|(_, hash)| hash.clone()).collect::<HashSet<_>>().into_iter().collect();
        let mut sizes: HashMap<String, u64> = HashMap::with_capacity(distinct.len());
        for batch in distinct.chunks(SIZE_BATCH) {
            if out_of_time() {
                partial = true;
                break;
            }
            let found = futures_util::future::join_all(batch.iter().map(|hash| git.blob_size(hash))).await;
            for (hash, size) in batch.iter().zip(found) {
                if let Ok(Some(size)) = size {
                    sizes.insert(hash.clone(), size);
                }
            }
        }
        let shares = languages::shares(counted.iter().filter_map(|(language, hash)| Some((*language, *sizes.get(hash)?))));
        Ok::<_, worker::Error>((license, policy, shares, partial))
    };
    let history = async {
        let mut commits: Vec<Authored> = Vec::new();
        let mut next = Some(head.to_owned());
        let mut partial = false;
        while let Some(from) = next.take() {
            let page = git.log(&from, LOG_PAGE).await?;
            let more = page.len() == LOG_PAGE as usize;
            let after = page.last().and_then(|commit| commit.parents.first().cloned());
            for commit in page {
                commits.push(Authored { name: commit.author.name, email: commit.author.email, at: commit.authored_at });
            }
            if more && after.is_some() {
                if commits.len() >= MAX_HISTORY || out_of_time() {
                    partial = true;
                } else {
                    next = after;
                }
            }
        }
        commits.truncate(MAX_HISTORY);
        Ok::<_, worker::Error>((commits, partial))
    };
    let (files, history) = futures_util::future::join(files, history).await;
    let (license, security_policy, languages, files_partial) = files?;
    let (commits, history_partial) = history?;
    let owners = match identity {
        Some(identity) => owners(identity, &commits).await,
        None => HashMap::new(),
    };
    let (contributors, contributors_total, weeks) = tally(&commits, &owners);
    Ok(Worked {
        commit: head.to_owned(),
        partial: files_partial || history_partial,
        license,
        security_policy,
        languages,
        contributors,
        contributors_total,
        commits: commits.len() as u32,
        weeks,
    })
}

/// The accounts behind the commits' addresses, the most frequent first. A
/// failure matches none: the authors show by name.
async fn owners(identity: &Fetcher, commits: &[Authored]) -> HashMap<String, EmailOwner> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for commit in commits.iter().filter(|commit| !crate::contributors::is_g1t(commit)) {
        let email = commit.email.trim().to_ascii_lowercase();
        if !email.is_empty() {
            *counts.entry(email).or_default() += 1;
        }
    }
    let mut emails: Vec<(String, usize)> = counts.into_iter().collect();
    emails.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    emails.truncate(MAX_MATCHED);
    let mut owners = HashMap::new();
    for chunk in emails.chunks(200) {
        let args = EmailOwnersArgs { emails: chunk.iter().map(|(email, _)| email.clone()).collect() };
        match g1t_kit::call::<_, HashMap<String, EmailOwner>>(identity, "email_owners", &args).await {
            Ok(found) => owners.extend(found),
            Err(error) => worker::console_error!("contributors' accounts not matched: {error}"),
        }
    }
    owners
}

/// Whether the repository is one whose About is worked out: not a pull
/// request's working copy.
pub fn has_about(repo: &Repo) -> bool {
    repo.fork_of.is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str) -> FileEntry {
        FileEntry { path: path.into(), hash: Some("h".into()) }
    }

    #[test]
    fn a_security_policy_is_found_where_it_may_be() {
        assert_eq!(security_policy(&[file("src/SECURITY.md"), file(".github/SECURITY.md")]).as_deref(), Some(".github/SECURITY.md"));
        assert_eq!(security_policy(&[file("docs/security.md"), file("SECURITY.md")]).as_deref(), Some("SECURITY.md"));
        assert_eq!(security_policy(&[file(".g1t/SECURITY.md")]).as_deref(), Some(".g1t/SECURITY.md"));
        assert_eq!(security_policy(&[file("SECURITY.txt")]).as_deref(), Some("SECURITY.txt"));
        assert_eq!(security_policy(&[file("docs/guides/SECURITY.md"), file("README.md")]), None);
    }

    #[test]
    fn a_run_starts_when_the_head_moved_and_none_is_under_way() {
        let now = 1_000_000;
        let none = Kept::default();
        assert!(none.wants_run(Some("c2"), now));
        assert!(!none.wants_run(None, now), "an empty repository has nothing to work out");
        let current = Kept { commit_hash: Some("c2".into()), version: STATS_VERSION, ..Kept::default() };
        assert!(!current.wants_run(Some("c2"), now));
        assert!(current.wants_run(Some("c3"), now));
        let older = Kept { commit_hash: Some("c2".into()), version: STATS_VERSION - 1.0, ..Kept::default() };
        assert!(older.wants_run(Some("c2"), now), "an answer worked out the old way is worked out again");
        let running = Kept { commit_hash: Some("c2".into()), started_ms: Some((now - 1_000) as f64), ..Kept::default() };
        assert!(!running.wants_run(Some("c3"), now));
        let died = Kept { commit_hash: Some("c2".into()), started_ms: Some((now - LEASE_MS - 1) as f64), ..Kept::default() };
        assert!(died.wants_run(Some("c3"), now));
        let partial = Kept { commit_hash: Some("c2".into()), partial: 1.0, started_ms: Some((now - 5_000) as f64), ..Kept::default() };
        assert!(!partial.wants_run(Some("c2"), now), "a partial answer rests a lease before the next try");
    }

    #[test]
    fn nothing_kept_is_pending() {
        let freshness = Kept::default().freshness(Some("c1".into()));
        assert!(freshness.pending);
        assert!(!Kept::default().freshness(None).pending, "an empty repository is not waiting on anything");
    }
}
