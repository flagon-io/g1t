//! Comments on commits (migrations/0043_commit_comments.sql): on the whole
//! commit, or on one line of a file it changed, as the commit left it.
//!
//! Anyone who can read the repository reads them, and comments unless the
//! repository turned commit comments off (`allow_commit_comments`); those
//! already written stay readable either way. Only its author edits one;
//! its author or a maintainer (`ManageSettings`, as for issue comments)
//! deletes it. Each change is published as `commit_comment.created`,
//! `.edited` or `.deleted` with the comment, and the inbox tells the
//! commit's author (when their address is a g1t account's) and whoever it
//! mentions (events/src/inbox.rs).

use std::collections::HashMap;

use g1t_contracts::access::{self, Capability};
use g1t_contracts::accounts::{EmailOwner, EmailOwnersArgs};
use g1t_contracts::events::{ChangedFrom, CommentChanges, CommitCommentEvent};
use g1t_contracts::repos::{ChangedFilesArgs, Commit, FileList, LogArgs, MAX_LISTED_FILES, Repo, RepoPath};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::{AddCommitCommentArgs, CommitComment, CommitCommentArgs, CommitCommentsArgs};
use g1t_contracts::{FailureCode, Outcome, User, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::wasm_bindgen::JsValue;
use worker::Result;

use crate::Work;
use crate::inbox::{excerpt, people_mentioned, teams_mentioned};
use crate::retired::writable;

/// The longest a comment may be, in characters.
pub(crate) const MAX_BODY_CHARS: usize = 65_536;
/// A repository's comments are listed this many at a time.
const PAGE: u32 = 30;
/// A commit's comments: at most this many are listed.
const MAX_ON_COMMIT: u32 = 1_000;
const MAX_PATH_CHARS: usize = 4_096;

/// `repo.purged`: a repository's commit comments go with it (retired.rs).
pub(crate) const PURGED: &str = "DELETE FROM commit_comments WHERE repo_id = ?1";

/// Unwraps an `Outcome`, returning its failure from the enclosing method.
macro_rules! check {
    ($outcome:expr) => {
        match $outcome {
            Outcome::Ok(value) => value,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        }
    };
}

#[derive(Deserialize)]
struct Row {
    id: String,
    repo_id: String,
    commit_hash: String,
    path: Option<String>,
    line: Option<u32>,
    author_id: String,
    author_name: String,
    body: String,
    created_at: String,
    updated_at: Option<String>,
}

impl From<Row> for CommitComment {
    fn from(row: Row) -> Self {
        CommitComment {
            id: row.id,
            repo_id: row.repo_id,
            commit: row.commit_hash,
            path: row.path,
            line: row.line,
            author: row.author_name,
            body: row.body,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

/// A trimmed body, or why it cannot be used.
pub(crate) fn valid_body(body: &str) -> std::result::Result<&str, &'static str> {
    let body = body.trim();
    if body.is_empty() {
        Err("A comment cannot be empty.")
    } else if body.chars().count() > MAX_BODY_CHARS {
        Err("That comment is too long.")
    } else {
        Ok(body)
    }
}

/// A commit named by its hash, whole or its start (at least 4 hex digits),
/// lowercased; never a branch or tag name.
pub(crate) fn valid_commit(commit: &str) -> Option<String> {
    let commit = commit.trim().to_ascii_lowercase();
    ((4..=64).contains(&commit.len()) && commit.bytes().all(|byte| byte.is_ascii_hexdigit())).then_some(commit)
}

/// Where on the commit a comment is: nowhere in particular, or one line
/// (from 1) of one file. A path and a line come together.
pub(crate) fn valid_place(path: Option<&str>, line: Option<u32>) -> std::result::Result<Option<(String, u32)>, &'static str> {
    let path = path.map(str::trim).filter(|path| !path.is_empty());
    match (path, line) {
        (None, None) => Ok(None),
        (None, Some(_)) => Err("Say which file the line is in."),
        (Some(_), None) => Err("Say which line of the file the comment is on."),
        (Some(_), Some(0)) => Err("Lines are numbered from 1."),
        (Some(path), Some(line)) => {
            let path = path.trim_start_matches('/');
            if path.is_empty()
                || path.chars().count() > MAX_PATH_CHARS
                || path.contains('\0')
                || path.split('/').any(|part| part.is_empty() || part == "." || part == "..")
            {
                return Err("That is not a file's path.");
            }
            Ok(Some((path.to_owned(), line)))
        }
    }
}

/// Whether `actor` may change a comment written by `author_id`: edit it
/// only as its author; delete it as its author or a maintainer.
pub(crate) fn may_change(author_id: &str, actor_id: &str, maintains: bool, deleting: bool) -> std::result::Result<(), &'static str> {
    if author_id == actor_id {
        Ok(())
    } else if deleting && maintains {
        Ok(())
    } else if deleting {
        Err("Only its author or a maintainer can delete this comment.")
    } else {
        Err("Only its author can edit this comment.")
    }
}

/// Whether a commit's changed files (`list`) include `path` as the commit
/// left it. A list cut short cannot say a file is missing.
pub(crate) fn changes_file(list: &FileList, path: &str) -> bool {
    list.truncated || list.files.iter().any(|file| file.path == path && file.hash.is_some())
}

/// Where a commit is on g1t.sh.
fn link(repo: &Repo, commit: &str) -> String {
    format!("/{}/{}/commit/{commit}", repo.namespace, repo.name)
}

fn event(repo: &Repo, comment: &CommitComment) -> CommitCommentEvent {
    CommitCommentEvent {
        comment_id: comment.id.clone(),
        repo_id: repo.id.clone(),
        commit: comment.commit.clone(),
        comment: comment.clone(),
        changes: None,
        link: link(repo, &comment.commit),
        excerpt: None,
        mentions: Vec::new(),
        team_mentions: Vec::new(),
        commit_author: None,
    }
}

impl Work {
    /// `commit_comments`: a commit's comments, oldest first; with no
    /// commit, the repository's, newest first, a page at a time.
    pub(crate) async fn commit_comments(&self, a: CommitCommentsArgs) -> Result<Outcome<Vec<CommitComment>>> {
        let commit = match a.commit.as_deref().map(str::trim).filter(|commit| !commit.is_empty()) {
            Some(commit) => match valid_commit(commit) {
                Some(commit) => Some(commit),
                None => return Ok(Outcome::fail(FailureCode::Invalid, "That is not a commit's hash.")),
            },
            None => None,
        };
        let repo = check!(self.repo(&a.repo, &a.viewer).await?);
        let query = match &commit {
            // A whole hash is matched as it is; the start of one, as a prefix.
            Some(commit) if commit.len() == 40 || commit.len() == 64 => self
                .db
                .prepare(format!(
                    "SELECT * FROM commit_comments WHERE repo_id = ? AND commit_hash = ?
                     ORDER BY created_at, id LIMIT {MAX_ON_COMMIT}"
                ))
                .bind(&[repo.id.as_str().into(), commit.as_str().into()])?,
            Some(commit) => self
                .db
                .prepare(format!(
                    "SELECT * FROM commit_comments WHERE repo_id = ? AND commit_hash LIKE ? || '%'
                     ORDER BY created_at, id LIMIT {MAX_ON_COMMIT}"
                ))
                .bind(&[repo.id.as_str().into(), commit.as_str().into()])?,
            None => {
                let offset = a.page.unwrap_or(1).max(1).saturating_sub(1).saturating_mul(PAGE);
                self.db
                    .prepare(
                        "SELECT * FROM commit_comments WHERE repo_id = ?
                         ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
                    )
                    .bind(&[repo.id.as_str().into(), PAGE.into(), offset.into()])?
            }
        };
        let rows = query.all().await?.results::<Row>()?;
        Ok(Outcome::Ok(rows.into_iter().map(CommitComment::from).collect()))
    }

    /// `add_commit_comment`: comments on a commit of the repository, or on
    /// one line of a file it changed.
    pub(crate) async fn add_commit_comment(&self, a: AddCommitCommentArgs) -> Result<Outcome<CommitComment>> {
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, crate::UNVERIFIED));
        }
        let body = match valid_body(&a.body) {
            Ok(body) => body.to_owned(),
            Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
        };
        let Some(asked) = valid_commit(&a.commit) else {
            return Ok(Outcome::fail(FailureCode::Invalid, "That is not a commit's hash."));
        };
        let place = match valid_place(a.path.as_deref(), a.line) {
            Ok(place) => place,
            Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
        };
        let viewer = Some(a.actor.clone());
        let repo = check!(self.repo(&a.repo, &viewer).await?);
        check!(writable(&repo));
        if !self.settings(&repo.id).await?.allow_commit_comments {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Commit comments are turned off for this repository."));
        }
        let Some(commit) = self.commented_commit(&a.repo, &viewer, &asked).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Commit not found."));
        };
        if let Some((path, _)) = &place {
            let changed: FileList = g1t_kit::call(
                &self.repos,
                "changed_files",
                &ChangedFilesArgs {
                    repo_id: repo.id.clone(),
                    base: commit.parents.first().cloned(),
                    head: commit.hash.clone(),
                    skip_dirs: Vec::new(),
                    limit: MAX_LISTED_FILES,
                },
            )
            .await?;
            if !changes_file(&changed, path) {
                return Ok(Outcome::fail(FailureCode::Invalid, "That file is not one this commit changed."));
            }
        }

        let now = now_ms();
        let comment = CommitComment {
            id: new_id("ccm", now),
            repo_id: repo.id.clone(),
            commit: commit.hash.clone(),
            path: place.as_ref().map(|(path, _)| path.clone()),
            line: place.as_ref().map(|(_, line)| *line),
            author: a.actor.username.clone(),
            body,
            created_at: rfc3339(now),
            updated_at: None,
        };
        self.db
            .prepare(
                "INSERT INTO commit_comments
                   (id, repo_id, commit_hash, path, line, author_id, author_name, body, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                comment.id.as_str().into(),
                repo.id.as_str().into(),
                comment.commit.as_str().into(),
                comment.path.as_deref().map_or(JsValue::NULL, JsValue::from),
                comment.line.map_or(JsValue::NULL, JsValue::from),
                a.actor.id.as_str().into(),
                a.actor.username.as_str().into(),
                comment.body.as_str().into(),
                comment.created_at.as_str().into(),
            ])?
            .run()
            .await?;

        // Who hears of it: whoever it mentions, and the commit's author.
        let mut data = event(&repo, &comment);
        data.excerpt = Some(excerpt(&comment.body));
        data.mentions = people_mentioned(&comment.body);
        let teams = teams_mentioned(&comment.body);
        match self.team_mentions(&repo.id, &teams, &a.actor.id, &a.actor.username).await {
            Ok(told) => data.team_mentions = told,
            Err(error) => worker::console_error!("commit comment team mentions not resolved: {error}"),
        }
        data.commit_author = self.commit_author(&commit, &a.actor).await;
        self.publish_quietly("commit_comment.created", &repo, &a.actor, data).await;
        Ok(Outcome::Ok(comment))
    }

    /// `edit_commit_comment`: its author changes what it says.
    pub(crate) async fn edit_commit_comment(&self, a: CommitCommentArgs) -> Result<Outcome<CommitComment>> {
        let body = match valid_body(&a.body) {
            Ok(body) => body.to_owned(),
            Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
        };
        let (repo, mut comment) = check!(self.changeable_commit_comment(&a, false).await?);
        if comment.body == body {
            return Ok(Outcome::Ok(comment));
        }
        let now = rfc3339(now_ms());
        self.db
            .prepare("UPDATE commit_comments SET body = ?, updated_at = ? WHERE id = ? AND repo_id = ?")
            .bind(&[body.as_str().into(), now.as_str().into(), comment.id.as_str().into(), repo.id.as_str().into()])?
            .run()
            .await?;
        let before = std::mem::replace(&mut comment.body, body);
        comment.updated_at = Some(now);
        let mut data = event(&repo, &comment);
        data.changes = Some(CommentChanges { body: ChangedFrom { from: before } });
        self.publish_quietly("commit_comment.edited", &repo, &a.actor, data).await;
        Ok(Outcome::Ok(comment))
    }

    /// `delete_commit_comment`: its author or a maintainer deletes it.
    pub(crate) async fn delete_commit_comment(&self, a: CommitCommentArgs) -> Result<Outcome<bool>> {
        let (repo, comment) = check!(self.changeable_commit_comment(&a, true).await?);
        self.db
            .prepare("DELETE FROM commit_comments WHERE id = ? AND repo_id = ?")
            .bind(&[comment.id.as_str().into(), repo.id.as_str().into()])?
            .run()
            .await?;
        self.publish_quietly("commit_comment.deleted", &repo, &a.actor, event(&repo, &comment)).await;
        Ok(Outcome::Ok(true))
    }

    /// A comment in the repository, when `actor` may edit it or, with
    /// `deleting`, delete it (`may_change`). Not found for someone who
    /// cannot read the repository.
    async fn changeable_commit_comment(&self, a: &CommitCommentArgs, deleting: bool) -> Result<Outcome<(Repo, CommitComment)>> {
        let repo = check!(self.repo(&a.repo, &Some(a.actor.clone())).await?);
        check!(writable(&repo));
        let Some(row) = self
            .db
            .prepare("SELECT * FROM commit_comments WHERE id = ? AND repo_id = ?")
            .bind(&[a.id.trim().into(), repo.id.as_str().into()])?
            .first::<Row>(None)
            .await?
        else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Comment not found."));
        };
        let maintains = access::can(Some(&a.actor), &repo, Capability::ManageSettings);
        if let Err(refusal) = may_change(&row.author_id, &a.actor.id, maintains, deleting) {
            return Ok(Outcome::fail(FailureCode::Forbidden, refusal));
        }
        Ok(Outcome::Ok((repo, CommitComment::from(row))))
    }

    /// The commit `asked` names (its hash, or the start of it) in the
    /// repository, as `viewer` may read it; none for a branch or tag that
    /// happens to look like a hash.
    async fn commented_commit(&self, repo: &RepoPath, viewer: &g1t_contracts::Viewer, asked: &str) -> Result<Option<Commit>> {
        let found: Outcome<Vec<Commit>> = g1t_kit::call(
            &self.repos,
            "log",
            &LogArgs {
                path: repo.clone(),
                viewer: viewer.clone(),
                git_ref: Some(asked.to_owned()),
                limit: 1,
            },
        )
        .await?;
        Ok(match found {
            Outcome::Ok(commits) => commits.into_iter().next().filter(|commit| commit.hash.to_ascii_lowercase().starts_with(asked)),
            Outcome::Fail(_) => None,
        })
    }

    /// The commit's author's username, when their address is a g1t
    /// account's and it is not `actor` commenting on their own commit.
    /// Best effort: none when it cannot be told.
    async fn commit_author(&self, commit: &Commit, actor: &User) -> Option<String> {
        let email = commit.author.email.trim().to_lowercase();
        if email.is_empty() {
            return None;
        }
        let owners: HashMap<String, EmailOwner> =
            match g1t_kit::call(&self.identity, "email_owners", &EmailOwnersArgs { emails: vec![email.clone()] }).await {
                Ok(owners) => owners,
                Err(error) => {
                    worker::console_error!("commit author not looked up: {error}");
                    return None;
                }
            };
        owners.get(&email).filter(|owner| owner.id != actor.id).map(|owner| owner.username.to_lowercase())
    }

    /// Publishes a change to a comment that is already made: a failure is
    /// logged, never undoes it.
    async fn publish_quietly(&self, kind: &'static str, repo: &Repo, actor: &User, data: CommitCommentEvent) {
        if let Err(error) = self.publish(kind, &repo.id, actor, data).await {
            worker::console_error!("{kind} not published: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::repos::FileEntry;

    #[test]
    fn a_body_says_something_and_not_too_much() {
        assert_eq!(valid_body("  looks good \n"), Ok("looks good"));
        assert!(valid_body(" \n\t").is_err());
        assert!(valid_body(&"a".repeat(MAX_BODY_CHARS)).is_ok());
        assert_eq!(valid_body(&"a".repeat(MAX_BODY_CHARS + 1)), Err("That comment is too long."));
        // Counted in characters, not bytes.
        assert!(valid_body(&"é".repeat(MAX_BODY_CHARS)).is_ok());
    }

    #[test]
    fn a_commit_is_named_by_its_hash_never_a_branch() {
        assert_eq!(valid_commit(" ABCDEF12 "), Some("abcdef12".into()));
        assert_eq!(valid_commit(&"a".repeat(40)), Some("a".repeat(40)));
        assert_eq!(valid_commit(&"b".repeat(64)), Some("b".repeat(64)));
        assert_eq!(valid_commit("abc"), None);
        assert_eq!(valid_commit(&"a".repeat(65)), None);
        assert_eq!(valid_commit("main"), None);
        assert_eq!(valid_commit("HEAD~1"), None);
    }

    #[test]
    fn a_line_comment_names_a_file_and_a_line_from_one() {
        assert_eq!(valid_place(None, None), Ok(None));
        assert_eq!(valid_place(Some("  "), None), Ok(None));
        assert_eq!(valid_place(Some("/src/lib.rs"), Some(3)), Ok(Some(("src/lib.rs".into(), 3))));
        assert!(valid_place(Some("src/lib.rs"), Some(0)).is_err());
        assert!(valid_place(Some("src/lib.rs"), None).is_err());
        assert!(valid_place(None, Some(3)).is_err());
        assert!(valid_place(Some("src/../etc"), Some(1)).is_err());
        assert!(valid_place(Some("src//lib.rs"), Some(1)).is_err());
        assert!(valid_place(Some("src/"), Some(1)).is_err());
    }

    #[test]
    fn authors_edit_and_maintainers_only_delete() {
        assert!(may_change("usr_1", "usr_1", false, false).is_ok());
        assert!(may_change("usr_1", "usr_1", false, true).is_ok());
        assert!(may_change("usr_1", "usr_2", true, true).is_ok());
        assert_eq!(may_change("usr_1", "usr_2", true, false), Err("Only its author can edit this comment."));
        assert!(may_change("usr_1", "usr_2", false, true).is_err());
        assert!(may_change("usr_1", "usr_2", false, false).is_err());
    }

    #[test]
    fn a_line_is_on_a_file_the_commit_changed_and_kept() {
        let entry = |path: &str, hash: Option<&str>| FileEntry { path: path.into(), hash: hash.map(str::to_owned), kind: None };
        let list = FileList {
            commit: Some("c".into()),
            date: None,
            files: vec![entry("src/lib.rs", Some("h1")), entry("old.rs", None)],
            truncated: false,
        };
        assert!(changes_file(&list, "src/lib.rs"));
        assert!(!changes_file(&list, "src/main.rs"));
        // A file the commit deleted has no lines left to comment on.
        assert!(!changes_file(&list, "old.rs"));
        assert!(changes_file(&FileList { truncated: true, ..list }, "src/main.rs"));
    }

    #[test]
    fn events_link_to_the_commit_and_say_only_what_they_have() {
        let comment = CommitComment {
            id: "ccm_1".into(),
            repo_id: "rep_1".into(),
            commit: "abc123".into(),
            path: None,
            line: None,
            author: "ana".into(),
            body: "hi".into(),
            created_at: "2026-10-14T00:00:00Z".into(),
            updated_at: None,
        };
        let mut data = CommitCommentEvent {
            comment_id: comment.id.clone(),
            repo_id: "rep_1".into(),
            commit: comment.commit.clone(),
            comment,
            changes: None,
            link: "/acme/rocket/commit/abc123".into(),
            excerpt: None,
            mentions: Vec::new(),
            team_mentions: Vec::new(),
            commit_author: None,
        };
        let value = serde_json::to_value(&data).unwrap();
        assert_eq!(value["commentId"], "ccm_1");
        assert_eq!(value["comment"]["author"], "ana");
        assert!(value.get("mentions").is_none() && value.get("commitAuthor").is_none() && value.get("changes").is_none());
        data.mentions = vec!["bo".into()];
        data.commit_author = Some("cy".into());
        let value = serde_json::to_value(&data).unwrap();
        assert_eq!(value["mentions"][0], "bo");
        assert_eq!(value["commitAuthor"], "cy");
    }

    /// The table as the migrations leave it, with the statements this
    /// module and a purge run against it.
    #[test]
    fn the_table_holds_comments_by_commit_and_goes_with_its_repository() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/migrations");
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .filter(|name| name.ends_with(".sql"))
            .collect();
        names.sort();
        for name in names {
            db.execute_batch(&std::fs::read_to_string(format!("{dir}/{name}")).unwrap()).unwrap();
        }
        let insert = "INSERT INTO commit_comments
                        (id, repo_id, commit_hash, path, line, author_id, author_name, body, created_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";
        for (id, repo, commit, at) in [
            ("ccm_1", "rep_1", "aaaa1111", "2026-10-14T00:00:01Z"),
            ("ccm_2", "rep_1", "aaaa1111", "2026-10-14T00:00:02Z"),
            ("ccm_3", "rep_1", "bbbb2222", "2026-10-14T00:00:03Z"),
            ("ccm_4", "rep_2", "aaaa1111", "2026-10-14T00:00:04Z"),
        ] {
            db.execute(insert, rusqlite::params![id, repo, commit, None::<String>, None::<u32>, "usr_1", "ana", "hi", at]).unwrap();
        }
        let ids = |sql: &str, params: &[&dyn rusqlite::ToSql]| -> Vec<String> {
            let mut statement = db.prepare(sql).unwrap();
            statement.query_map(params, |row| row.get(0)).unwrap().map(|id| id.unwrap()).collect()
        };
        assert_eq!(
            ids("SELECT id FROM commit_comments WHERE repo_id = ? AND commit_hash LIKE ? || '%' ORDER BY created_at, id", &[&"rep_1", &"aaaa"]),
            ["ccm_1", "ccm_2"]
        );
        assert_eq!(
            ids("SELECT id FROM commit_comments WHERE repo_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?", &[&"rep_1", &2, &0]),
            ["ccm_3", "ccm_2"]
        );
        // An account purged: its comments stay, as ghost's (ghost.rs).
        for sql in crate::ghost::statements().iter().filter(|sql| sql.contains("commit_comments")) {
            db.execute(sql, rusqlite::params!["usr_1"]).unwrap();
        }
        assert_eq!(ids("SELECT DISTINCT author_name FROM commit_comments", &[]), ["ghost"]);
        db.execute(PURGED, rusqlite::params!["rep_1"]).unwrap();
        assert_eq!(ids("SELECT id FROM commit_comments ORDER BY id", &[]), ["ccm_4"]);
    }
}
