//! Moving a repository from one git store namespace to another,
//! keeping its id, its path and everything g1t knows about it. Only its
//! store key changes.
//!
//! A move is asked for (`move_repository`, or a row an operator inserts
//! with `scripts/ops/gitstore-namespaces.mjs move`) and run by the hourly
//! sweep, one at a time:
//!
//! 1. **Paused.** Writes to the repository and its pull requests' working
//!    copies wait (`writes_paused_until`, at most [`PAUSE_MS`]): pushes wait
//!    up to 20 seconds and are then told to try again, as are merges,
//!    commits from the web and push credentials for sandboxes. A move
//!    waits for push credentials already handed out to expire (they reach
//!    the store directly), then a few seconds for pushes in flight.
//! 2. **Copied.** Each one is made in the new namespace under the same
//!    name, and every ref is copied over git: one upload-pack from the old
//!    copy streamed into one receive-pack to the new (land.rs `copy_refs`),
//!    so its size is bounded by time, not memory. Until both copies list the
//!    same refs and the old one has not moved since, it is copied again,
//!    three times at most.
//! 3. **Switched.** Every row's `store` names the new key in one batch, and
//!    its `refs_version` moves, so nothing kept for the old copy is used
//!    again. Writes go on. Removed working copies (forks.rs) need no
//!    copying: their rows follow, so one made again is made in the new
//!    namespace.
//! 4. **Cleaned.** After [`MOVE_KEEP_DAYS`] the old copies are deleted, each
//!    only while its refs still say what was copied. One that changed (a
//!    push that slipped past the pause) is kept, and the move marked
//!    `diverged` for an operator.
//!
//! A failure before the switch deletes what was made in the new namespace
//! and lifts the pause; the repository stays where it was.

use std::collections::BTreeMap;

use g1t_contracts::repos::Repo;
use g1t_contracts::{FailureCode, Outcome, new_id};
use g1t_kit::now_ms;
use serde::{Deserialize, Serialize};
use worker::wasm_bindgen::JsValue;
use worker::Result;

use crate::registry::{Registry, store_key};
use crate::store::{GitRepo, GitStore, Scope, locate};
use crate::{Repos, land, mirror, refs, shards};

/// The longest writes wait for one move.
pub const PAUSE_MS: u64 = 20 * 60 * 1000;
/// How long a write waits for a pause to end before it is told to try again.
pub const PAUSE_WAIT_MS: u64 = 20_000;
const PAUSE_POLL_MS: u64 = 2_000;
/// How long a move waits for push credentials already handed out; longer
/// and it is tried again in the next sweep.
const OPEN_WAIT_MS: u64 = 7 * 60 * 1000;
/// Pushes already past the pause get this long to finish.
const SETTLE_MS: u64 = 5_000;
/// Rounds of copying before a move that keeps changing gives up.
const ROUNDS: u32 = 3;
/// Days the old copies are kept after a move.
pub const MOVE_KEEP_DAYS: u64 = 7;
const DAY_MS: u64 = 24 * 3600 * 1000;
/// Moves run per sweep, and old copies cleaned.
const MOVES_PER_SWEEP: u32 = 1;
const CLEANS_PER_SWEEP: u32 = 10;
/// Tries before a move that keeps failing is left failed.
const MAX_ATTEMPTS: u32 = 3;
const ZERO_ID: &str = "0000000000000000000000000000000000000000";

/// `move_repository`: services and operators only.
#[derive(Debug, Deserialize)]
pub struct MoveArgs {
    pub repo_id: String,
    /// The namespace it goes to.
    pub namespace: String,
    #[serde(default)]
    pub requested_by: Option<String>,
}

/// One move, as `repository_moves` answers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MoveRow {
    pub id: String,
    pub repo_id: String,
    pub to_namespace: String,
    pub status: String,
    #[serde(default)]
    pub requested_by: Option<String>,
    pub queued_ms: f64,
    #[serde(default)]
    pub started_ms: Option<f64>,
    #[serde(default)]
    pub finished_ms: Option<f64>,
    #[serde(default)]
    pub cleaned_ms: Option<f64>,
    #[serde(default)]
    pub attempts: f64,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ListMovesArgs {
    #[serde(default)]
    pub limit: Option<u32>,
}

/// What one copy holds, as copied.
#[derive(Debug, Deserialize)]
struct CopyRow {
    repo_id: String,
    from_key: String,
    refs: String,
}

/// Every ref worth copying, by name: peeled tag lines are the
/// advertisement's, not refs.
pub fn ref_map(all: Vec<(String, String)>) -> BTreeMap<String, String> {
    all.into_iter().filter(|(name, _)| !name.ends_with("^{}")).collect()
}

/// What makes `target`'s refs `source`'s: the commands, the objects to
/// fetch, and what the target holds already.
pub fn plan(source: &BTreeMap<String, String>, target: &BTreeMap<String, String>) -> (Vec<mirror::Command>, Vec<String>, Vec<String>) {
    let mut commands: Vec<mirror::Command> = Vec::new();
    for (name, hash) in source {
        if target.get(name) != Some(hash) {
            commands.push((name.clone(), target.get(name).cloned(), hash.clone()));
        }
    }
    for (name, hash) in target {
        if !source.contains_key(name) {
            commands.push((name.clone(), Some(hash.clone()), ZERO_ID.to_owned()));
        }
    }
    let held: std::collections::BTreeSet<&String> = target.values().collect();
    let mut wants: Vec<String> = commands
        .iter()
        .map(|(_, _, new)| new.clone())
        .filter(|new| new != ZERO_ID && !held.contains(new))
        .collect();
    wants.sort();
    wants.dedup();
    let mut haves: Vec<String> = held.into_iter().cloned().collect();
    haves.dedup();
    (commands, wants, haves)
}

/// What a writer is told while writes wait.
pub fn paused_message(repo: &Repo, reason: &str) -> String {
    format!(
        "{}/{} is paused for maintenance ({reason}); changes to it wait a few minutes. Try again shortly.",
        repo.namespace, repo.name
    )
}

/// Why a move cannot start, if it cannot.
pub fn refusal(repo: Option<&Repo>, to: &str, bound: &[String], writable: bool, from: &str) -> Option<String> {
    let Some(repo) = repo else {
        return Some("the repository is gone".to_owned());
    };
    if repo.fork_of.is_some() {
        return Some("a pull request's working copy moves with its repository".to_owned());
    }
    if !shards::valid_namespace(to) || !bound.iter().any(|name| name == to) {
        return Some(format!("{to} is not a bound namespace"));
    }
    if !writable {
        return Some(format!("{to} does not take writes now"));
    }
    if from == to {
        return Some(format!("it is in {to} already"));
    }
    None
}

impl Registry {
    pub async fn queue_move(&self, a: &MoveArgs, now: u64) -> Result<MoveRow> {
        let id = new_id("mov", now);
        self.db
            .prepare(
                "INSERT INTO repo_moves (id, repo_id, to_namespace, status, requested_by, queued_ms)
                 VALUES (?1, ?2, ?3, 'queued', ?4, ?5)",
            )
            .bind(&[
                id.as_str().into(),
                a.repo_id.as_str().into(),
                a.namespace.as_str().into(),
                a.requested_by.as_deref().map_or(JsValue::NULL, JsValue::from),
                (now as f64).into(),
            ])?
            .run()
            .await?;
        self.move_by_id(&id).await?.ok_or_else(|| worker::Error::RustError("the move was not recorded".to_owned()))
    }

    async fn move_by_id(&self, id: &str) -> Result<Option<MoveRow>> {
        self.db.prepare("SELECT * FROM repo_moves WHERE id = ?").bind(&[id.into()])?.first::<MoveRow>(None).await
    }

    pub async fn moves(&self, limit: u32) -> Result<Vec<MoveRow>> {
        self.db
            .prepare("SELECT * FROM repo_moves ORDER BY queued_ms DESC LIMIT ?")
            .bind(&[limit.clamp(1, 200).into()])?
            .all()
            .await?
            .results::<MoveRow>()
    }

    async fn queued_moves(&self, limit: u32) -> Result<Vec<MoveRow>> {
        self.db
            .prepare("SELECT * FROM repo_moves WHERE status = 'queued' ORDER BY queued_ms LIMIT ?")
            .bind(&[limit.into()])?
            .all()
            .await?
            .results::<MoveRow>()
    }

    async fn set_move(&self, id: &str, status: &str, note: Option<&str>, now: u64) -> Result<()> {
        let finished = matches!(status, "moved" | "failed");
        let cleaned = status == "cleaned";
        self.db
            .prepare(
                "UPDATE repo_moves SET status = ?2, note = ?3,
                   started_ms = CASE WHEN ?2 = 'moving' THEN ?4 ELSE started_ms END,
                   attempts = attempts + CASE WHEN ?2 = 'moving' THEN 1 ELSE 0 END,
                   finished_ms = CASE WHEN ?5 THEN ?4 ELSE finished_ms END,
                   cleaned_ms = CASE WHEN ?6 THEN ?4 ELSE cleaned_ms END
                 WHERE id = ?1",
            )
            .bind(&[id.into(), status.into(), note.map_or(JsValue::NULL, JsValue::from), (now as f64).into(), finished.into(), cleaned.into()])?
            .run()
            .await?;
        Ok(())
    }

    /// Writes to these repositories wait until `until`.
    async fn pause(&self, ids: &[String], until: u64, reason: &str) -> Result<()> {
        let statements = ids
            .iter()
            .map(|id| {
                self.db
                    .prepare("UPDATE repos SET writes_paused_until = ?, writes_paused_for = ? WHERE id = ?")
                    .bind(&[(until as f64).into(), reason.into(), id.as_str().into()])
            })
            .collect::<Result<Vec<_>>>()?;
        self.db.batch(statements).await?;
        for id in ids {
            crate::registry::note_paused(id, Some(until), Some(reason));
        }
        Ok(())
    }

    async fn resume(&self, ids: &[String]) -> Result<()> {
        let statements = ids
            .iter()
            .map(|id| {
                self.db
                    .prepare("UPDATE repos SET writes_paused_until = NULL, writes_paused_for = NULL WHERE id = ?")
                    .bind(&[id.as_str().into()])
            })
            .collect::<Result<Vec<_>>>()?;
        self.db.batch(statements).await?;
        for id in ids {
            crate::registry::note_paused(id, None, None);
        }
        Ok(())
    }

    /// A repository's pull requests' working copies, removed ones too.
    async fn all_forks_of(&self, id: &str) -> Result<Vec<Repo>> {
        let rows = self
            .db
            .prepare("SELECT * FROM repos WHERE fork_of = ? AND deleted_at IS NULL")
            .bind(&[id.into()])?
            .all()
            .await?
            .results::<crate::registry::RepoRow>()?;
        Ok(rows.into_iter().map(Repo::from).collect())
    }

    /// The switch: every row names its new key, its refs version moves,
    /// writes go on, and what was copied is recorded, in one batch.
    async fn switch(&self, move_id: &str, switched: &[(Repo, String, String, BTreeMap<String, String>)], now: u64) -> Result<()> {
        let mut statements = Vec::new();
        for (repo, from, to, refs) in switched {
            statements.push(
                self.db
                    .prepare(
                        "UPDATE repos SET store = ?2, refs_version = coalesce(refs_version, 0) + 1,
                           writes_paused_until = NULL, writes_paused_for = NULL
                         WHERE id = ?1",
                    )
                    .bind(&[repo.id.as_str().into(), to.as_str().into()])?,
            );
            let (_, name) = crate::shards::split(from);
            statements.push(
                self.db
                    .prepare(
                        "INSERT OR REPLACE INTO repo_move_copies (move_id, repo_id, from_key, to_key, name, refs)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    )
                    .bind(&[
                        move_id.into(),
                        repo.id.as_str().into(),
                        from.as_str().into(),
                        to.as_str().into(),
                        name.into(),
                        serde_json::to_string(refs)?.into(),
                    ])?,
            );
        }
        statements.push(
            self.db
                .prepare("UPDATE repo_moves SET status = 'moved', finished_ms = ?2, note = NULL WHERE id = ?1")
                .bind(&[move_id.into(), (now as f64).into()])?,
        );
        self.db.batch(statements).await?;
        for (repo, _, to, _) in switched {
            crate::registry::remember_store(repo, to);
            crate::registry::note_paused(&repo.id, None, None);
        }
        Ok(())
    }

    async fn copies_of(&self, move_id: &str) -> Result<Vec<CopyRow>> {
        self.db
            .prepare("SELECT repo_id, from_key, refs FROM repo_move_copies WHERE move_id = ? AND cleaned_ms IS NULL")
            .bind(&[move_id.into()])?
            .all()
            .await?
            .results::<CopyRow>()
    }

    async fn copy_cleaned(&self, move_id: &str, repo_id: &str, now: u64) -> Result<()> {
        self.db
            .prepare("UPDATE repo_move_copies SET cleaned_ms = ?3 WHERE move_id = ?1 AND repo_id = ?2")
            .bind(&[move_id.into(), repo_id.into(), (now as f64).into()])?
            .run()
            .await?;
        Ok(())
    }

    async fn moved_before(&self, before: u64, limit: u32) -> Result<Vec<MoveRow>> {
        self.db
            .prepare("SELECT * FROM repo_moves WHERE status = 'moved' AND finished_ms < ? ORDER BY finished_ms LIMIT ?")
            .bind(&[(before as f64).into(), limit.into()])?
            .all()
            .await?
            .results::<MoveRow>()
    }
}

/// How a move went.
enum Ran {
    Moved,
    /// Not yet: back in the queue, with why.
    Later(String),
    Failed(String),
}

impl<S: GitStore> Repos<S> {
    /// `move_repository`: queues a move, checked now so a mistake is said
    /// at once.
    pub(crate) async fn move_repository(&self, a: MoveArgs) -> Result<Outcome<MoveRow>> {
        let repo = self.registry.by_id(&a.repo_id).await?;
        let from = repo.as_ref().map(|repo| locate(&store_key(repo)).0).unwrap_or_default();
        let bound = self.store.namespaces();
        if let Some(why) = refusal(repo.as_ref(), &a.namespace, &bound, self.store.writable(&a.namespace), &from) {
            return Ok(Outcome::fail(FailureCode::Invalid, format!("It cannot be moved: {why}.")));
        }
        match self.registry.queue_move(&a, now_ms()).await {
            Ok(row) => Ok(Outcome::Ok(row)),
            // The partial unique index: one in hand already.
            Err(error) if error.to_string().contains("UNIQUE") => {
                Ok(Outcome::fail(FailureCode::Conflict, "A move of this repository is already queued or running."))
            }
            Err(error) => Err(error),
        }
    }

    /// The sweep's part: runs the queued moves, then cleans old copies.
    pub(crate) async fn run_moves(&self) -> Result<u32> {
        let mut moved = 0;
        for row in self.registry.queued_moves(MOVES_PER_SWEEP).await? {
            let now = now_ms();
            self.registry.set_move(&row.id, "moving", None, now).await?;
            let ran = match self.run_move(&row).await {
                Ok(ran) => ran,
                Err(error) => Ran::Failed(error.to_string()),
            };
            match ran {
                Ran::Moved => moved += 1,
                Ran::Later(why) => self.registry.set_move(&row.id, "queued", Some(&why), now_ms()).await?,
                Ran::Failed(why) if (row.attempts as u32) + 1 < MAX_ATTEMPTS => {
                    worker::console_error!("move {} of {} failed, to be tried again: {why}", row.id, row.repo_id);
                    self.registry.set_move(&row.id, "queued", Some(&why), now_ms()).await?;
                }
                Ran::Failed(why) => {
                    worker::console_error!("move {} of {} failed: {why}", row.id, row.repo_id);
                    self.registry.set_move(&row.id, "failed", Some(&why), now_ms()).await?;
                }
            }
        }
        self.clean_moves().await?;
        Ok(moved)
    }

    async fn run_move(&self, row: &MoveRow) -> Result<Ran> {
        let repo = self.registry.by_id(&row.repo_id).await?;
        let from_key = repo.as_ref().map(store_key).unwrap_or_default();
        let (from_ns, _) = locate(&from_key);
        let bound = self.store.namespaces();
        if let Some(why) = refusal(repo.as_ref(), &row.to_namespace, &bound, self.store.writable(&row.to_namespace), &from_ns) {
            return Ok(Ran::Failed(why));
        }
        let Some(repo) = repo else { return Ok(Ran::Failed("the repository is gone".to_owned())) };
        if !self.store.writable(&from_ns) {
            return Ok(Ran::Later(format!("{from_ns} does not take writes now")));
        }
        let forks = self.registry.all_forks_of(&repo.id).await?;
        let mut items = vec![repo.clone()];
        items.extend(forks);
        let ids: Vec<String> = items.iter().map(|item| item.id.clone()).collect();
        let reason = format!("moving to {}", row.to_namespace);
        self.registry.pause(&ids, now_ms() + PAUSE_MS, &reason).await?;
        match self.copy_and_switch(row, &items).await {
            Ok(Ran::Moved) => Ok(Ran::Moved),
            other => {
                // Writes go on where they were.
                self.registry.resume(&ids).await?;
                other
            }
        }
    }

    async fn copy_and_switch(&self, row: &MoveRow, items: &[Repo]) -> Result<Ran> {
        // Push credentials already handed out reach the store directly.
        let mut open_until = 0;
        for item in items {
            if let Some(read) = self.registry.by_id(&item.id).await?
                && let Some(state) = crate::registry::refs_state(&read.id)
            {
                open_until = open_until.max(state.open_until);
            }
        }
        let now = now_ms();
        if open_until > now {
            if open_until - now > OPEN_WAIT_MS {
                return Ok(Ran::Later("push credentials handed out have not expired yet".to_owned()));
            }
            worker::Delay::from(std::time::Duration::from_millis(open_until - now + 1_000)).await;
        }
        worker::Delay::from(std::time::Duration::from_millis(SETTLE_MS)).await;

        let default = self.store.default_namespace();
        let mut made: Vec<String> = Vec::new();
        let mut switched = Vec::new();
        let result = async {
            for item in items {
                let from = store_key(item);
                let (_, name) = locate(&from);
                let to = shards::compose(Some(&row.to_namespace), &name, &default);
                // A removed working copy has nothing to copy: its row follows.
                if crate::registry::retired(&item.id).is_some() {
                    switched.push((item.clone(), from, to, BTreeMap::new()));
                    continue;
                }
                self.store.create(&to, item.description.as_deref(), &item.default_branch).await?;
                made.push(to.clone());
                match self.copy_until_same(&from, &to).await? {
                    Ok(refs) => switched.push((item.clone(), from, to, refs)),
                    Err(why) => return Ok(Err(why)),
                }
            }
            Ok::<_, worker::Error>(Ok(()))
        }
        .await;
        let failure = match result {
            Ok(Ok(())) => None,
            Ok(Err(why)) => Some(why),
            Err(error) => Some(error.to_string()),
        };
        if let Some(why) = failure {
            // Nothing half made is left in the new namespace.
            for key in made {
                if let Err(error) = self.store.delete(&key).await {
                    worker::console_error!("move {}: {key} was left behind: {error}", row.id);
                }
            }
            return Ok(Ran::Failed(why));
        }
        self.registry.switch(&row.id, &switched, now_ms()).await?;
        for (_, from, _, _) in &switched {
            self.store.forget_access(from).await;
        }
        worker::console_log!("move {}: {} is in {} now", row.id, row.repo_id, row.to_namespace);
        Ok(Ran::Moved)
    }

    /// Copies `from`'s refs to `to` until both say the same and `from` has
    /// not moved since; the refs as copied.
    async fn copy_until_same(&self, from: &str, to: &str) -> Result<std::result::Result<BTreeMap<String, String>, String>> {
        let source = self.store.open(from).await?.access(Scope::Read).await?;
        let target_git = self.store.open(to).await?;
        let target = target_git.access(Scope::Write).await?;
        for _ in 0..ROUNDS {
            let theirs = ref_map(refs::all(&source).await?);
            let ours = ref_map(refs::all(&target).await?);
            if theirs == ours {
                return Ok(Ok(theirs));
            }
            let (commands, wants, haves) = plan(&theirs, &ours);
            if let Err(why) = land::copy_refs(&source, &target, &commands, &wants, &haves).await? {
                return Ok(Err(format!("{to} refused the copy: {why}")));
            }
            let again = ref_map(refs::all(&source).await?);
            let copied = ref_map(refs::all(&target).await?);
            if again == theirs && copied == theirs {
                return Ok(Ok(theirs));
            }
        }
        Ok(Err(format!("{from} kept changing while it was copied")))
    }

    /// Deletes old copies kept past `MOVE_KEEP_DAYS`, each only while it
    /// still says what was copied.
    async fn clean_moves(&self) -> Result<()> {
        let before = now_ms().saturating_sub(MOVE_KEEP_DAYS * DAY_MS);
        for row in self.registry.moved_before(before, CLEANS_PER_SWEEP).await? {
            let mut diverged = Vec::new();
            for copy in self.registry.copies_of(&row.id).await? {
                let kept: BTreeMap<String, String> = serde_json::from_str(&copy.refs).unwrap_or_default();
                let now_refs = match self.store.open(&copy.from_key).await {
                    Ok(git) => match git.access(Scope::Read).await {
                        Ok(access) => refs::all(&access).await.map(ref_map),
                        Err(error) => Err(error),
                    },
                    Err(error) => Err(error),
                };
                let same = match now_refs {
                    Ok(refs) => refs == kept,
                    // Gone already.
                    Err(error) if error.to_string().contains("NOT_FOUND") => true,
                    Err(error) => return Err(error),
                };
                if !same {
                    diverged.push(copy.from_key.clone());
                    continue;
                }
                self.store.delete(&copy.from_key).await?;
                self.registry.copy_cleaned(&row.id, &copy.repo_id, now_ms()).await?;
            }
            if diverged.is_empty() {
                self.registry.set_move(&row.id, "cleaned", None, now_ms()).await?;
            } else {
                let note = format!("kept, changed after the move: {}", diverged.join(", "));
                worker::console_error!("move {}: {note}", row.id);
                self.registry.set_move(&row.id, "diverged", Some(&note), now_ms()).await?;
            }
        }
        Ok(())
    }

    /// `repo`, once writes to it no longer wait: the row is read again
    /// every two seconds for up to [`PAUSE_WAIT_MS`]. `Err` with what to
    /// tell the writer if they still wait.
    pub(crate) async fn unpaused(&self, repo: Repo) -> Result<std::result::Result<Repo, (FailureCode, String)>> {
        let started = now_ms();
        let mut repo = repo;
        while let Some(reason) = crate::registry::paused(&repo.id, now_ms()) {
            if now_ms().saturating_sub(started) >= PAUSE_WAIT_MS {
                return Ok(Err((FailureCode::Conflict, paused_message(&repo, &reason))));
            }
            worker::Delay::from(std::time::Duration::from_millis(PAUSE_POLL_MS)).await;
            match self.registry.by_id(&repo.id).await? {
                Some(read) => repo = read,
                None => return Ok(Err((FailureCode::NotFound, "Repository not found.".to_owned()))),
            }
        }
        Ok(Ok(repo))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refs(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(name, hash)| ((*name).to_owned(), (*hash).to_owned())).collect()
    }

    #[test]
    fn a_first_copy_sends_everything_and_a_second_only_what_changed() {
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        let c = "c".repeat(40);
        let source = refs(&[("refs/heads/main", &a), ("refs/heads/dev", &b), ("refs/tags/v1", &a)]);
        let (commands, wants, haves) = plan(&source, &BTreeMap::new());
        assert_eq!(commands.len(), 3);
        assert!(commands.iter().all(|(_, old, _)| old.is_none()));
        // Each object once.
        assert_eq!(wants, vec![a.clone(), b.clone()]);
        assert!(haves.is_empty());
        // A push landed during the copy: only it travels, with what the
        // copy already holds named as had.
        let moved = refs(&[("refs/heads/main", &c), ("refs/heads/dev", &b), ("refs/tags/v1", &a)]);
        let (commands, wants, haves) = plan(&moved, &source);
        assert_eq!(commands, vec![("refs/heads/main".to_owned(), Some(a.clone()), c.clone())]);
        assert_eq!(wants, vec![c.clone()]);
        assert_eq!(haves, vec![a.clone(), b.clone()]);
        // A branch deleted during the copy is deleted from the copy too.
        let deleted = refs(&[("refs/heads/main", &a)]);
        let (commands, wants, _) = plan(&deleted, &source);
        assert!(commands.iter().any(|(name, _, new)| name == "refs/heads/dev" && new == ZERO_ID));
        assert!(wants.is_empty());
        assert_eq!(plan(&source, &source).0, Vec::new());
    }

    #[test]
    fn peeled_tags_are_not_refs() {
        let map = ref_map(vec![("refs/tags/v1".into(), "t".into()), ("refs/tags/v1^{}".into(), "c".into()), ("refs/heads/main".into(), "m".into())]);
        assert_eq!(map.len(), 2);
        assert_eq!(map.get("refs/tags/v1").map(String::as_str), Some("t"));
    }

    fn repo(fork_of: Option<&str>) -> Repo {
        serde_json::from_value(serde_json::json!({
            "id": "rep_1", "namespace": "acme", "name": "rocket", "description": null, "isPrivate": true,
            "ownerId": "usr_1", "defaultBranch": "main", "forkOf": fork_of, "protected": false,
            "createdAt": "2026-10-07T00:00:00Z"
        }))
        .unwrap()
    }

    #[test]
    fn a_move_is_refused_when_it_cannot_work() {
        let bound = vec!["g1t".to_owned(), "g1t-us-1".to_owned()];
        assert_eq!(refusal(Some(&repo(None)), "g1t-us-1", &bound, true, "g1t"), None);
        assert!(refusal(None, "g1t-us-1", &bound, true, "g1t").unwrap().contains("gone"));
        assert!(refusal(Some(&repo(Some("rep_0"))), "g1t-us-1", &bound, true, "g1t").unwrap().contains("working copy"));
        assert!(refusal(Some(&repo(None)), "g1t-us-9", &bound, true, "g1t").unwrap().contains("not a bound"));
        assert!(refusal(Some(&repo(None)), "g1t-us-1", &bound, false, "g1t").unwrap().contains("writes"));
        assert!(refusal(Some(&repo(None)), "g1t", &bound, true, "g1t").unwrap().contains("already"));
        assert!(paused_message(&repo(None), "moving to g1t-us-1").starts_with("acme/rocket is paused"));
    }

    #[test]
    fn writes_wait_less_than_a_move_may_take_and_the_pause_ends_on_its_own() {
        assert!(PAUSE_WAIT_MS < PAUSE_MS);
        // A handed-out credential lives five minutes plus a minute's grace.
        assert!(OPEN_WAIT_MS > crate::store::CREDENTIAL_LIFE_MS + 60_000);
        assert!(OPEN_WAIT_MS + SETTLE_MS < PAUSE_MS);
    }
}
