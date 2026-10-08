//! Keeping the index current: from events as things change, from queued
//! jobs for anything bigger than one event should do, and from a backfill
//! of everything that was there before.
//!
//! The cost of a push is capped. A push lists only the files it changed
//! (up to [`MAX_PUSH_FILES`]; more than that and the repository is compared
//! whole instead), queues them, and each job reads at most
//! [`DRAIN_FILES`] files and [`DRAIN_BYTES`] of text before handing the
//! rest to the next. A repository is indexed up to [`MAX_REPO_FILES`]
//! files; past that it is marked partial.

use std::collections::{HashMap, HashSet};

use g1t_contracts::events::Event;
use g1t_contracts::identity::{DirectoryArgs, DirectoryEntry, DirectoryPage, Profile, SlugArgs, UsernameArgs, Workspace};
use g1t_contracts::repos::{
    AllIdsArgs, BlobText, ChangedFilesArgs, FileList, IdPage, ListFilesArgs, PathByIdArgs, ReadBlobsArgs, RepoPath, TreeArgs,
    TreeView,
};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::{
    Issue, IssueDetail, ListIssuesArgs, ListPullsArgs, Pull, PullDetail, State, ViewArgs,
};
use g1t_contracts::{Membership, Outcome, PrincipalKind, User};
use g1t_kit::now_ms;
use serde::{Deserialize, Serialize};
use worker::Result;

use crate::Search;
use crate::rules::{self, MAX_FILE_BYTES, SKIP_DIRS};
use crate::sql::{Param, Sql};
use crate::store;

/// Files a push may change and still be indexed from its own list; more,
/// and the repository is compared whole.
pub const MAX_PUSH_FILES: u32 = 300;
/// Files indexed in one repository, at most.
pub const MAX_REPO_FILES: u32 = 5000;
/// Files one job reads, at most.
pub const DRAIN_FILES: usize = 60;
/// Text one job reads, at most.
pub const DRAIN_BYTES: u64 = 3 * 1024 * 1024;
/// Blobs asked of the repos service at once.
const READ_GROUP: usize = 20;
/// Pieces of a file written in one statement.
const PIECES_PER_STATEMENT: usize = 8;
/// The most of an issue's or pull request's body indexed.
const BODY_CHARS: usize = 32 * 1024;
/// The most of a README indexed.
const README_CHARS: usize = 4000;
/// Repositories listed per backfill job.
const BACKFILL_PAGE: u32 = 100;
/// Accounts or workspaces per directory job.
const DIRECTORY_PAGE: u32 = 200;

/// Work queued for later, one job per message.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Job {
    /// Lists every repository a page at a time, queueing one `repo` job each.
    Backfill {
        #[serde(default)]
        after: Option<String>,
    },
    /// Compares a repository's default branch with the index, whole, and
    /// indexes its issues and pull requests.
    Repo { repo_id: String },
    /// Indexes what a push to the default branch changed.
    Push {
        repo_id: String,
        #[serde(default)]
        before: Option<String>,
        after: String,
    },
    /// Reads the next files waiting for a repository.
    Drain { repo_id: String },
    /// Indexes every account or workspace, a page at a time.
    Directory {
        kind: String,
        #[serde(default)]
        after: Option<String>,
    },
}

/// What this service reads of the events it handles.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepoEvent {
    repo_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PushEvent {
    repo_id: String,
    #[serde(default)]
    before: Option<String>,
    after: String,
    #[serde(default)]
    default_branch: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NumberEvent {
    repo_id: String,
    number: u32,
}

#[derive(Deserialize)]
struct UserEvent {
    username: String,
}

#[derive(Deserialize)]
struct WorkspaceEvent {
    slug: String,
}

#[derive(Deserialize)]
struct Stored {
    path: String,
    blob: String,
}

#[derive(Deserialize)]
struct Waiting {
    path: String,
    blob: Option<String>,
}

#[derive(Deserialize)]
struct RepoState {
    state: String,
}

fn now() -> String {
    rfc3339(now_ms())
}

fn p(text: &str) -> Param {
    Param::Text(text.to_owned())
}

/// A commit id that means "nothing": git's forty zeros.
fn is_null_commit(hash: &str) -> bool {
    hash.is_empty() || hash.bytes().all(|b| b == b'0')
}

fn labels_of(labels: &[String]) -> String {
    let mut out = String::from("|");
    for label in labels {
        out.push_str(&label.to_lowercase());
        out.push('|');
    }
    out
}

fn clip(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

impl Search {
    /// The workspace itself, through no one: how this service reads a
    /// repository, private or not, to index it.
    async fn actor(&self, slug: &str) -> Result<Option<User>> {
        let slug = slug.to_lowercase();
        if let Some(found) = self.actors.borrow().get(&slug) {
            return Ok(found.clone());
        }
        let workspace: Option<Workspace> = g1t_kit::call(&self.identity, "get_workspace", &SlugArgs { slug: slug.clone() }).await?;
        let actor = workspace.map(|workspace| User {
            id: workspace.id,
            username: workspace.slug.clone(),
            kind: PrincipalKind::Workspace,
            verified: true,
            workspaces: vec![Membership::member(workspace.slug)],
            ..User::default()
        });
        self.actors.borrow_mut().insert(slug, actor.clone());
        Ok(actor)
    }

    async fn path_of(&self, repo_id: &str) -> Result<Option<RepoPath>> {
        g1t_kit::call(&self.repos, "path_by_id", &PathByIdArgs { id: repo_id.to_owned() }).await
    }

    pub async fn enqueue(&self, jobs: Vec<Job>) -> Result<()> {
        let queue = self.env.queue("JOBS")?;
        for batch in jobs.chunks(100) {
            queue.send_batch(batch.to_vec()).await?;
        }
        Ok(())
    }

    // ---- Repositories --------------------------------------------------------

    /// Reads a repository's details and README again and stores them.
    /// `None`, and the repository forgotten, when it is gone or a fork.
    pub async fn refresh_repo(&self, repo_id: &str) -> Result<Option<TreeView>> {
        let Some(path) = self.path_of(repo_id).await? else {
            self.purge(repo_id).await?;
            return Ok(None);
        };
        let Some(actor) = self.actor(&path.namespace).await? else {
            return Ok(None);
        };
        let tree: Outcome<TreeView> = g1t_kit::call(
            &self.repos,
            "tree",
            &TreeArgs { path, viewer: Some(actor), git_ref: None, tree_path: String::new() },
        )
        .await?;
        let Outcome::Ok(tree) = tree else {
            return Ok(None);
        };
        let repo = &tree.repo;
        let readme = tree.readme.as_ref().and_then(|readme| readme.text.as_deref()).map(|text| clip(text, README_CHARS));
        let topics = repo.topics.join(" ");
        let mut statements = vec![store::prepare(
            &self.db,
            "INSERT INTO repos (repo_id, namespace, name, description, topics, readme, private, default_branch, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (repo_id) DO UPDATE SET namespace = excluded.namespace, name = excluded.name,
               description = excluded.description, topics = excluded.topics, readme = excluded.readme,
               private = excluded.private, default_branch = excluded.default_branch, updated_at = excluded.updated_at",
            vec![
                p(&repo.id),
                p(&repo.namespace.to_lowercase()),
                p(&repo.name.to_lowercase()),
                Param::opt(repo.description.as_deref()),
                p(&topics),
                Param::opt(readme.as_deref()),
                Param::Int(i64::from(repo.is_private)),
                p(&repo.default_branch),
                p(&repo.created_at),
                p(&now()),
            ],
        )?];
        statements.push(store::prepare(&self.db, "DELETE FROM repo_topics WHERE repo_id = ?", vec![p(&repo.id)])?);
        for topic in &repo.topics {
            statements.push(store::prepare(
                &self.db,
                "INSERT OR IGNORE INTO repo_topics (topic, repo_id) VALUES (?, ?)",
                vec![p(topic), p(&repo.id)],
            )?);
        }
        store::run_all(&self.db, statements).await?;
        Ok(Some(tree))
    }

    /// Forgets a repository and everything indexed from it.
    pub async fn purge(&self, repo_id: &str) -> Result<()> {
        let id = || vec![p(repo_id)];
        store::run_all(
            &self.db,
            vec![
                store::prepare(&self.db, "DELETE FROM chunks WHERE fid IN (SELECT fid FROM files WHERE repo_id = ?)", id())?,
                store::prepare(&self.db, "DELETE FROM files WHERE repo_id = ?", id())?,
                store::prepare(&self.db, "DELETE FROM pending WHERE repo_id = ?", id())?,
                store::prepare(&self.db, "DELETE FROM items WHERE repo_id = ?", id())?,
                store::prepare(&self.db, "DELETE FROM repo_topics WHERE repo_id = ?", id())?,
                store::prepare(&self.db, "DELETE FROM repos WHERE repo_id = ?", id())?,
            ],
        )
        .await
    }

    /// Queues files to read (or, with no blob, to remove).
    async fn queue_files(&self, repo_id: &str, files: &[(String, Option<String>)]) -> Result<()> {
        let at = now();
        let mut statements = Vec::new();
        for group in files.chunks(20) {
            let rows = vec!["(?, ?, ?, ?)"; group.len()].join(", ");
            let mut params = Vec::with_capacity(group.len() * 4);
            for (path, blob) in group {
                params.extend([p(repo_id), p(path), Param::opt(blob.as_deref()), p(&at)]);
            }
            statements.push(store::prepare(
                &self.db,
                &format!(
                    "INSERT INTO pending (repo_id, path, blob, queued_at) VALUES {rows}
                     ON CONFLICT (repo_id, path) DO UPDATE SET blob = excluded.blob, queued_at = excluded.queued_at"
                ),
                params,
            )?);
        }
        store::run_all(&self.db, statements).await
    }

    fn skip_dirs() -> Vec<String> {
        SKIP_DIRS.iter().map(|dir| (*dir).to_owned()).collect()
    }

    /// Compares a repository's default branch with the index, whole, and
    /// queues what differs.
    async fn reconcile(&self, repo_id: &str) -> Result<()> {
        let listed: FileList = g1t_kit::call(
            &self.repos,
            "list_files",
            &ListFilesArgs { repo_id: repo_id.to_owned(), git_ref: None, skip_dirs: Self::skip_dirs(), limit: MAX_REPO_FILES },
        )
        .await?;
        let stored: HashMap<String, String> = store::all::<Stored>(
            &self.db,
            &Sql { text: "SELECT path, blob FROM files WHERE repo_id = ?".into(), params: vec![p(repo_id)] },
        )
        .await?
        .into_iter()
        .map(|row| (row.path, row.blob))
        .collect();
        let mut changes: Vec<(String, Option<String>)> = Vec::new();
        let present: HashSet<&str> = listed.files.iter().map(|file| file.path.as_str()).collect();
        for file in &listed.files {
            if let Some(hash) = &file.hash
                && stored.get(&file.path) != Some(hash)
            {
                changes.push((file.path.clone(), Some(hash.clone())));
            }
        }
        // Files the branch no longer has; unknowable when the list was cut short.
        if !listed.truncated {
            for path in stored.keys().filter(|path| !present.contains(path.as_str())) {
                changes.push((path.clone(), None));
            }
        }
        self.queue_files(repo_id, &changes).await?;
        store::run_all(
            &self.db,
            vec![store::prepare(
                &self.db,
                "UPDATE repos SET state = ?, head = ? WHERE repo_id = ?",
                vec![p(if listed.truncated { "partial" } else { "indexing" }), Param::opt(listed.commit.as_deref()), p(repo_id)],
            )?],
        )
        .await?;
        self.drain(repo_id).await
    }

    /// Reads the next files waiting for a repository, within this job's
    /// allowance, and queues another job for the rest.
    pub async fn drain(&self, repo_id: &str) -> Result<()> {
        let waiting = store::all::<Waiting>(
            &self.db,
            &Sql {
                text: "SELECT path, blob FROM pending WHERE repo_id = ? ORDER BY path LIMIT ?".into(),
                params: vec![p(repo_id), Param::Int(DRAIN_FILES as i64 + 1)],
            },
        )
        .await?;
        let more = waiting.len() > DRAIN_FILES;
        let mut statements = Vec::new();
        let mut done: Vec<&Waiting> = Vec::new();
        let mut to_read: Vec<&Waiting> = Vec::new();
        for file in waiting.iter().take(DRAIN_FILES) {
            match &file.blob {
                None => {
                    statements.extend(self.remove_file(repo_id, &file.path)?);
                    done.push(file);
                }
                Some(blob) => match rules::skip_path(&file.path) {
                    Some(reason) => {
                        statements.extend(self.skip_file(repo_id, &file.path, blob, 0, reason)?);
                        done.push(file);
                    }
                    None => to_read.push(file),
                },
            }
        }
        let mut bytes = 0u64;
        let mut stopped = false;
        for group in to_read.chunks(READ_GROUP) {
            if bytes >= DRAIN_BYTES {
                stopped = true;
                break;
            }
            let hashes: Vec<String> = group.iter().filter_map(|file| file.blob.clone()).collect();
            let texts: Vec<BlobText> = g1t_kit::call(
                &self.repos,
                "read_blobs",
                &ReadBlobsArgs { repo_id: repo_id.to_owned(), hashes, max_bytes: MAX_FILE_BYTES },
            )
            .await?;
            let by_hash: HashMap<&str, &BlobText> = texts.iter().map(|text| (text.hash.as_str(), text)).collect();
            for file in group {
                let blob = file.blob.as_deref().unwrap_or_default();
                let read = by_hash.get(blob);
                let size = read.map_or(0, |read| read.size);
                match read.and_then(|read| read.text.as_deref()) {
                    None => {
                        let reason = if size > u64::from(MAX_FILE_BYTES) { "too large" } else { "binary" };
                        statements.extend(self.skip_file(repo_id, &file.path, blob, size, reason)?);
                    }
                    Some(text) => match rules::skip_text(text) {
                        Some(reason) => statements.extend(self.skip_file(repo_id, &file.path, blob, size, reason)?),
                        None => {
                            statements.extend(self.index_file(repo_id, &file.path, blob, text)?);
                            bytes += text.len() as u64;
                        }
                    },
                }
                done.push(file);
            }
        }
        // Each queued file leaves the queue only if no newer push replaced it.
        for file in &done {
            statements.push(store::prepare(
                &self.db,
                "DELETE FROM pending WHERE repo_id = ? AND path = ? AND blob IS ?",
                vec![p(repo_id), p(&file.path), Param::opt(file.blob.as_deref())],
            )?);
        }
        store::run_all(&self.db, statements).await?;
        if more || stopped {
            return self.enqueue(vec![Job::Drain { repo_id: repo_id.to_owned() }]).await;
        }
        self.finish(repo_id).await
    }

    /// Records a repository's size and language once its queue is empty.
    async fn finish(&self, repo_id: &str) -> Result<()> {
        let data: Vec<&str> = rules::DATA_LANGUAGES.to_vec();
        let state = store::all::<RepoState>(
            &self.db,
            &Sql { text: "SELECT state FROM repos WHERE repo_id = ?".into(), params: vec![p(repo_id)] },
        )
        .await?;
        let partial = state.first().is_some_and(|row| row.state == "partial");
        store::run_all(
            &self.db,
            vec![store::prepare(
                &self.db,
                "UPDATE repos SET
                   files = (SELECT count(*) FROM files WHERE repo_id = ?1 AND skipped IS NULL),
                   bytes = (SELECT COALESCE(sum(bytes), 0) FROM files WHERE repo_id = ?1 AND skipped IS NULL),
                   language = (SELECT language FROM files WHERE repo_id = ?1 AND skipped IS NULL AND language IS NOT NULL
                               AND language NOT IN (SELECT value FROM json_each(?2))
                               GROUP BY language ORDER BY sum(bytes) DESC LIMIT 1),
                   state = ?3
                 WHERE repo_id = ?1",
                vec![p(repo_id), Param::Text(serde_json::to_string(&data)?), p(if partial { "partial" } else { "done" })],
            )?],
        )
        .await
    }

    fn remove_file(&self, repo_id: &str, path: &str) -> Result<Vec<worker::D1PreparedStatement>> {
        Ok(vec![
            store::prepare(
                &self.db,
                "DELETE FROM chunks WHERE fid = (SELECT fid FROM files WHERE repo_id = ? AND path = ?)",
                vec![p(repo_id), p(path)],
            )?,
            store::prepare(&self.db, "DELETE FROM files WHERE repo_id = ? AND path = ?", vec![p(repo_id), p(path)])?,
        ])
    }

    fn upsert_file(&self, repo_id: &str, path: &str, blob: &str, bytes: u64, skipped: Option<&str>) -> Result<worker::D1PreparedStatement> {
        store::prepare(
            &self.db,
            "INSERT INTO files (repo_id, path, blob, language, bytes, skipped) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (repo_id, path) DO UPDATE SET blob = excluded.blob, language = excluded.language,
               bytes = excluded.bytes, skipped = excluded.skipped",
            vec![p(repo_id), p(path), p(blob), Param::opt(rules::language(path)), Param::Int(bytes as i64), Param::opt(skipped)],
        )
    }

    /// Records a file as not indexed, and why, so it is not read again
    /// until its blob changes.
    fn skip_file(&self, repo_id: &str, path: &str, blob: &str, bytes: u64, reason: &str) -> Result<Vec<worker::D1PreparedStatement>> {
        Ok(vec![
            store::prepare(
                &self.db,
                "DELETE FROM chunks WHERE fid = (SELECT fid FROM files WHERE repo_id = ? AND path = ?)",
                vec![p(repo_id), p(path)],
            )?,
            self.upsert_file(repo_id, path, blob, bytes, Some(reason))?,
        ])
    }

    fn index_file(&self, repo_id: &str, path: &str, blob: &str, text: &str) -> Result<Vec<worker::D1PreparedStatement>> {
        let mut statements = vec![
            self.upsert_file(repo_id, path, blob, text.len() as u64, None)?,
            store::prepare(
                &self.db,
                "DELETE FROM chunks WHERE fid = (SELECT fid FROM files WHERE repo_id = ? AND path = ?)",
                vec![p(repo_id), p(path)],
            )?,
        ];
        let pieces = rules::chunks(text);
        for group in pieces.chunks(PIECES_PER_STATEMENT) {
            let rows = vec!["((SELECT fid FROM files WHERE repo_id = ? AND path = ?), ?, ?, ?)"; group.len()].join(", ");
            let mut params = Vec::with_capacity(group.len() * 5);
            for (start, content) in group {
                params.extend([p(repo_id), p(path), Param::Int(i64::from(*start)), p(path), p(content)]);
            }
            statements.push(store::prepare(
                &self.db,
                &format!("INSERT INTO chunks (fid, start_line, path, content) VALUES {rows}"),
                params,
            )?);
        }
        Ok(statements)
    }

    // ---- Issues and pull requests ------------------------------------------

    fn issue_row(&self, repo_id: &str, issue: &Issue) -> Result<worker::D1PreparedStatement> {
        let status = match issue.state {
            State::Open => "open",
            State::Closed => issue.reason.map_or("completed", |reason| reason.as_str()),
        };
        self.item_row(
            repo_id,
            "issue",
            issue.number,
            &issue.title,
            &issue.body,
            if issue.state == State::Open { "open" } else { "closed" },
            status,
            (&issue.author.username, issue.requested_by.as_ref().map(|user| user.username.as_str())),
            &issue.labels,
            &issue.created_at,
            &issue.updated_at,
        )
    }

    fn pull_row(&self, repo_id: &str, pull: &Pull, labels: &[String]) -> Result<worker::D1PreparedStatement> {
        self.item_row(
            repo_id,
            "pull",
            pull.number,
            &pull.title,
            pull.body.as_deref().unwrap_or_default(),
            if pull.status.is_active() { "open" } else { "closed" },
            pull.status.as_str(),
            (&pull.author.username, pull.requested_by.as_ref().map(|user| user.username.as_str())),
            labels,
            &pull.created_at,
            &pull.updated_at,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn item_row(
        &self,
        repo_id: &str,
        kind: &str,
        number: u32,
        title: &str,
        body: &str,
        state: &str,
        status: &str,
        // Who opened it, and for g1t's work, who asked for it.
        (author, requested_by): (&str, Option<&str>),
        labels: &[String],
        created_at: &str,
        updated_at: &str,
    ) -> Result<worker::D1PreparedStatement> {
        store::prepare(
            &self.db,
            "INSERT INTO items (repo_id, kind, number, title, body, state, status, author, requested_by, labels, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (repo_id, kind, number) DO UPDATE SET title = excluded.title, body = excluded.body,
               state = excluded.state, status = excluded.status, author = excluded.author,
               requested_by = excluded.requested_by, labels = excluded.labels, updated_at = excluded.updated_at",
            vec![
                p(repo_id),
                p(kind),
                Param::Int(i64::from(number)),
                p(title),
                p(&clip(body, BODY_CHARS)),
                p(state),
                p(status),
                p(&author.to_lowercase()),
                requested_by.map_or(Param::Null, |name| p(&name.to_lowercase())),
                p(&labels_of(labels)),
                p(created_at),
                p(updated_at),
            ],
        )
    }

    /// Indexes one issue or pull request as it is now.
    async fn index_item(&self, pull: bool, repo_id: &str, number: u32) -> Result<()> {
        let Some(path) = self.path_of(repo_id).await? else {
            return Ok(());
        };
        let Some(actor) = self.actor(&path.namespace).await? else {
            return Ok(());
        };
        // An issue on a repository not yet indexed brings the repository in.
        let known = store::count(
            &self.db,
            &Sql { text: "SELECT count(*) AS n FROM repos WHERE repo_id = ?".into(), params: vec![p(repo_id)] },
        )
        .await?;
        if known == 0 && self.refresh_repo(repo_id).await?.is_none() {
            return Ok(());
        }
        let view = ViewArgs { repo: path, number, viewer: Some(actor), after_seq: 0 };
        let statement = if pull {
            let found: Outcome<PullDetail> = g1t_kit::call(&self.work, "get_pull", &view).await?;
            let Outcome::Ok(detail) = found else { return Ok(()) };
            let labels = detail.issue.as_ref().map(|issue| issue.labels.clone()).unwrap_or_default();
            self.pull_row(repo_id, &detail.pull, &labels)?
        } else {
            let found: Outcome<IssueDetail> = g1t_kit::call(&self.work, "get_issue", &view).await?;
            let Outcome::Ok(detail) = found else { return Ok(()) };
            self.issue_row(repo_id, &detail.issue)?
        };
        store::run_all(&self.db, vec![statement]).await
    }

    /// Indexes a repository's issues and pull requests, newest first, as
    /// many as one list returns.
    async fn index_items(&self, repo_id: &str, path: &RepoPath) -> Result<()> {
        let Some(actor) = self.actor(&path.namespace).await? else {
            return Ok(());
        };
        let issues: Outcome<Vec<Issue>> = g1t_kit::call(
            &self.work,
            "list_issues",
            &ListIssuesArgs { repo: path.clone(), viewer: Some(actor.clone()), state: None, label: None, milestone: None },
        )
        .await?;
        let pulls: Outcome<Vec<Pull>> = g1t_kit::call(
            &self.work,
            "list_pulls",
            &ListPullsArgs { repo: path.clone(), viewer: Some(actor), state: None, label: None, milestone: None, base: None },
        )
        .await?;
        let issues = match issues {
            Outcome::Ok(issues) => issues,
            Outcome::Fail(_) => Vec::new(),
        };
        let labels: HashMap<u32, &Vec<String>> = issues.iter().map(|issue| (issue.number, &issue.labels)).collect();
        let mut statements = Vec::new();
        for issue in &issues {
            statements.push(self.issue_row(repo_id, issue)?);
        }
        if let Outcome::Ok(pulls) = pulls {
            for pull in &pulls {
                let labels = pull.issue.and_then(|number| labels.get(&number)).map(|l| l.as_slice()).unwrap_or_default();
                statements.push(self.pull_row(repo_id, pull, labels)?);
            }
        }
        store::run_all(&self.db, statements).await
    }

    // ---- People and workspaces ---------------------------------------------

    fn person_row(&self, kind: &str, reference: &str, entry: &DirectoryEntry) -> Result<worker::D1PreparedStatement> {
        store::prepare(
            &self.db,
            "INSERT INTO people (kind, ref, slug, name, bio, avatar, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (kind, ref) DO UPDATE SET slug = excluded.slug, name = excluded.name, bio = excluded.bio,
               avatar = excluded.avatar",
            vec![
                p(kind),
                p(reference),
                p(&entry.slug.to_lowercase()),
                Param::opt(entry.name.as_deref()),
                Param::opt(entry.bio.as_deref()),
                Param::opt(entry.avatar.as_deref()),
                p(&entry.created_at),
            ],
        )
    }

    async fn index_user(&self, username: &str) -> Result<()> {
        let username = username.to_lowercase();
        let profile: Option<Profile> = g1t_kit::call(&self.identity, "profile", &UsernameArgs { username: username.clone() }).await?;
        let statement = match profile {
            Some(profile) => self.person_row(
                "user",
                &username,
                &DirectoryEntry {
                    id: String::new(),
                    slug: profile.username,
                    name: profile.name,
                    bio: profile.bio,
                    avatar: profile.avatar,
                    created_at: profile.created_at,
                },
            )?,
            None => store::prepare(&self.db, "DELETE FROM people WHERE kind = 'user' AND ref = ?", vec![p(&username)])?,
        };
        store::run_all(&self.db, vec![statement]).await
    }

    async fn index_workspace(&self, slug: &str) -> Result<()> {
        let workspace: Option<Workspace> = g1t_kit::call(&self.identity, "get_workspace", &SlugArgs { slug: slug.to_lowercase() }).await?;
        let Some(workspace) = workspace else {
            return Ok(());
        };
        let entry = DirectoryEntry {
            id: workspace.id.clone(),
            slug: workspace.slug,
            name: Some(workspace.name),
            bio: workspace.description,
            avatar: workspace.avatar,
            created_at: workspace.created_at,
        };
        store::run_all(&self.db, vec![self.person_row("workspace", &workspace.id, &entry)?]).await
    }

    // ---- Events and jobs -----------------------------------------------------

    /// Starts the backfill the first time the service hears anything, so a
    /// new deployment fills itself without anyone asking.
    pub async fn ensure_backfill(&self) -> Result<()> {
        #[derive(Deserialize)]
        struct Started {
            #[allow(dead_code)]
            key: String,
        }
        let started = store::all::<Started>(
            &self.db,
            &Sql {
                text: "INSERT INTO meta (key, value) VALUES ('backfill', ?) ON CONFLICT (key) DO NOTHING RETURNING key".into(),
                params: vec![p(&now())],
            },
        )
        .await?;
        if !started.is_empty() {
            self.enqueue(vec![
                Job::Backfill { after: None },
                Job::Directory { kind: "user".into(), after: None },
                Job::Directory { kind: "workspace".into(), after: None },
            ])
            .await?;
        }
        Ok(())
    }

    pub async fn on_event(&self, event: &Event) -> Result<()> {
        let data = &event.data;
        match event.kind.as_str() {
            "git.push" => {
                let Ok(push) = serde_json::from_value::<PushEvent>(data.clone()) else { return Ok(()) };
                if push.default_branch {
                    self.enqueue(vec![Job::Push { repo_id: push.repo_id, before: push.before, after: push.after }]).await?;
                }
            }
            // A transfer changes the repository's path; refreshing reads it
            // again by id, issues and pull requests with it.
            // Archiving changes nothing searched, but the details are read again.
            "repo.created"
            | "repo.updated"
            | "repo.visibility_changed"
            | "repo.renamed"
            | "repo.transferred"
            | "repo.archived"
            | "repo.unarchived" => {
                if let Ok(repo) = serde_json::from_value::<RepoEvent>(data.clone()) {
                    self.refresh_repo(&repo.repo_id).await?;
                }
            }
            // A deleted repository is forgotten at once (repos hides it, so a
            // refresh would forget it too), and purged for good later.
            "repo.deleted" | "repo.purged" => {
                if let Ok(repo) = serde_json::from_value::<RepoEvent>(data.clone()) {
                    self.purge(&repo.repo_id).await?;
                }
            }
            // A restored one is indexed again, whole: its code, issues and
            // pull requests.
            "repo.restored" => {
                if let Ok(repo) = serde_json::from_value::<RepoEvent>(data.clone()) {
                    self.enqueue(vec![Job::Repo { repo_id: repo.repo_id }]).await?;
                }
            }
            "issue.opened" | "issue.updated" | "issue.closed" | "issue.reopened" | "issue.assigned" => {
                if let Ok(item) = serde_json::from_value::<NumberEvent>(data.clone()) {
                    self.index_item(false, &item.repo_id, item.number).await?;
                }
            }
            "pull.opened" | "pull.ready" | "pull.updated" | "pull.closed" | "pull.reopened"
            | "pull.converted_to_draft" | "pull.merged" => {
                if let Ok(item) = serde_json::from_value::<NumberEvent>(data.clone()) {
                    self.index_item(true, &item.repo_id, item.number).await?;
                }
            }
            "user.updated" => {
                if let Ok(user) = serde_json::from_value::<UserEvent>(data.clone()) {
                    self.index_user(&user.username).await?;
                }
            }
            "workspace.updated" => {
                if let Ok(workspace) = serde_json::from_value::<WorkspaceEvent>(data.clone()) {
                    self.index_workspace(&workspace.slug).await?;
                }
            }
            // A deleted workspace drops out of results at once, and comes
            // back if staff restore it. Its repositories come and go with
            // their own `repo.deleted` and `repo.restored`.
            "workspace.deleting" => {
                if let Ok(workspace) = serde_json::from_value::<WorkspaceEvent>(data.clone()) {
                    self.db
                        .prepare("DELETE FROM people WHERE kind = 'workspace' AND slug = ?1")
                        .bind(&[workspace.slug.to_lowercase().into()])?
                        .run()
                        .await?;
                }
            }
            "workspace.restored" => {
                if let Ok(workspace) = serde_json::from_value::<WorkspaceEvent>(data.clone()) {
                    self.index_workspace(&workspace.slug).await?;
                }
            }
            "workspace.deleted" => {
                g1t_kit::deleted::on_event(
                    &self.db,
                    event,
                    &["DELETE FROM people WHERE kind = 'workspace' AND slug = ?1"],
                )
                .await?;
            }
            "workspace.renamed" => {
                g1t_kit::rename::on_event(
                    &self.env,
                    &self.db,
                    event,
                    &[
                        "UPDATE repos SET namespace = ?1 WHERE namespace = ?2",
                        "UPDATE people SET slug = ?1 WHERE kind = 'workspace' AND slug = ?2",
                    ],
                )
                .await?;
            }
            _ => {}
        }
        Ok(())
    }

    pub async fn run_job(&self, job: Job) -> Result<()> {
        match job {
            Job::Backfill { after } => {
                let page: IdPage = g1t_kit::call(&self.repos, "all_ids", &AllIdsArgs { after, limit: BACKFILL_PAGE }).await?;
                let mut jobs: Vec<Job> = page.ids.into_iter().map(|repo_id| Job::Repo { repo_id }).collect();
                if let Some(next) = page.next {
                    jobs.push(Job::Backfill { after: Some(next) });
                }
                self.enqueue(jobs).await
            }
            Job::Repo { repo_id } => {
                let Some(tree) = self.refresh_repo(&repo_id).await? else { return Ok(()) };
                let path = RepoPath { namespace: tree.repo.namespace.clone(), name: tree.repo.name.clone() };
                if let Some(head) = &tree.head {
                    store::run_all(
                        &self.db,
                        vec![store::prepare(
                            &self.db,
                            "UPDATE repos SET pushed_at = COALESCE(pushed_at, ?) WHERE repo_id = ?",
                            vec![p(&head.authored_at), p(&repo_id)],
                        )?],
                    )
                    .await?;
                }
                self.index_items(&repo_id, &path).await?;
                self.reconcile(&repo_id).await
            }
            Job::Push { repo_id, before, after } => {
                if self.refresh_repo(&repo_id).await?.is_none() {
                    return Ok(());
                }
                store::run_all(
                    &self.db,
                    vec![store::prepare(&self.db, "UPDATE repos SET pushed_at = ? WHERE repo_id = ?", vec![p(&now()), p(&repo_id)])?],
                )
                .await?;
                let Some(before) = before.filter(|before| !is_null_commit(before)) else {
                    return self.reconcile(&repo_id).await;
                };
                let changed: FileList = g1t_kit::call(
                    &self.repos,
                    "changed_files",
                    &ChangedFilesArgs {
                        repo_id: repo_id.clone(),
                        base: Some(before),
                        head: after.clone(),
                        skip_dirs: Self::skip_dirs(),
                        limit: MAX_PUSH_FILES,
                    },
                )
                .await?;
                // A push too large to list, or one whose base is unknown
                // (a force push over history the store no longer has): compare whole.
                if changed.truncated || changed.commit.is_none() {
                    return self.reconcile(&repo_id).await;
                }
                let files: Vec<(String, Option<String>)> =
                    changed.files.into_iter().map(|file| (file.path, file.hash)).collect();
                self.queue_files(&repo_id, &files).await?;
                store::run_all(
                    &self.db,
                    vec![store::prepare(&self.db, "UPDATE repos SET head = ? WHERE repo_id = ?", vec![p(&after), p(&repo_id)])?],
                )
                .await?;
                self.drain(&repo_id).await
            }
            Job::Drain { repo_id } => self.drain(&repo_id).await,
            Job::Directory { kind, after } => {
                let page: DirectoryPage = g1t_kit::call(
                    &self.identity,
                    "directory",
                    &DirectoryArgs { kind: kind.clone(), after, limit: DIRECTORY_PAGE },
                )
                .await?;
                let mut statements = Vec::new();
                for entry in &page.entries {
                    let reference = if kind == "workspace" { entry.id.clone() } else { entry.slug.to_lowercase() };
                    statements.push(self.person_row(&kind, &reference, entry)?);
                }
                store::run_all(&self.db, statements).await?;
                if let Some(next) = page.next {
                    self.enqueue(vec![Job::Directory { kind, after: Some(next) }]).await?;
                }
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use g1t_contracts::work::PullStatus;

    use super::*;

    #[test]
    fn jobs_are_sent_tagged() {
        let job = Job::Push { repo_id: "rep_1".into(), before: None, after: "abc".into() };
        let value = serde_json::to_value(&job).unwrap();
        assert_eq!(value["type"], "push");
        assert_eq!(serde_json::from_value::<Job>(value).unwrap(), job);
        let backfill: Job = serde_json::from_str(r#"{"type":"backfill"}"#).unwrap();
        assert_eq!(backfill, Job::Backfill { after: None });
    }

    #[test]
    fn a_push_from_nothing_is_a_whole_comparison() {
        assert!(is_null_commit("0000000000000000000000000000000000000000"));
        assert!(is_null_commit(""));
        assert!(!is_null_commit("0a1b"));
    }

    #[test]
    fn labels_are_kept_between_bars() {
        assert_eq!(labels_of(&["Bug".into(), "good first issue".into()]), "|bug|good first issue|");
        assert_eq!(labels_of(&[]), "|");
    }

    #[test]
    fn pull_statuses_have_names() {
        assert_eq!(PullStatus::Merged.as_str(), "merged");
    }
}
