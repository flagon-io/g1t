//! What landing a work item does, and closing one by a commit.
//!
//! When a pull request merges into the default branch, or a commit naming
//! a work item is pushed there, where the repository closes work items
//! that way (`RepoSettings::auto_close_items`), the repository's link to
//! each work item it closes is marked landed and the resolution recorded
//! ([`LAND_SQL`]); the work item closes once it has landed in every target
//! it has, or at once when it has none. What it is part of is linked
//! (`touched`), and closes nothing.
//!
//! Closing a work item by hand with a commit (`close_work_item` with
//! `commit`) lands it too, for a commit on the default branch that is tied
//! to it ([`tie`]): one whose message names it after a closing keyword, the
//! commit a pull request merged as whose own work item, `closes` or
//! `parts` names it, or, for someone with the Write role, any commit, the
//! explicit request standing for its message. Automatic closing, from
//! pushes and merges, still needs the closing keyword.

use g1t_contracts::events::WorkItemEvent;
use g1t_contracts::repos::{BranchDriftArgs, BranchDrifts, Commit, LogArgs, Repo, RepoPath};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, User};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use super::links::PART_SQL;
use super::rows::{Held, StoredResolution, path_of};
use crate::Work;
use crate::rows::{By, ValueRow};

/// What landed: a pull request merged, or a commit pushed.
#[derive(Clone, Debug, Default)]
pub(crate) struct Landing {
    pub pull: Option<u32>,
    pub commit: Option<String>,
    pub pushed_by: Option<String>,
    /// For a commit tied to a work item by hand: how it was.
    pub tie: Option<Tie>,
}

/// How a commit closing a work item by hand (`close_work_item` with
/// `commit`) is tied to it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Tie {
    /// Its message names the work item after a closing keyword.
    Named,
    /// A pull request (this number) merged as it, and names the work item:
    /// as its own, in its `closes` or `parts`, or in its title or
    /// description.
    Merged(u32),
    /// Nothing names the work item: someone with the Write role tied it.
    ByHand,
}

/// How a commit is tied to a work item for an explicit close: whether its
/// message `names` it, the pull request it is the merge of that names it
/// (`merged`), and whether the actor `may_push` (has the Write role). None
/// when it may not be: nothing names it and the actor lacks Write.
pub(crate) fn tie(names: bool, merged: Option<u32>, may_push: bool) -> Option<Tie> {
    match (names, merged) {
        (true, _) => Some(Tie::Named),
        (false, Some(pull)) => Some(Tie::Merged(pull)),
        (false, None) => may_push.then_some(Tie::ByHand),
    }
}

/// Where a commit stands against the default branch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OnBranch {
    On,
    Off,
    /// Too far back to tell.
    Unknown,
}

/// Where a commit stands against the default branch: on it when it is its
/// head (`at_tip`), else by how far `ahead` of the head it is, when that
/// could be told. Ahead of it by any commit, it is not on it.
pub(crate) fn on_branch(at_tip: bool, ahead: Option<u32>) -> OnBranch {
    match (at_tip, ahead) {
        (true, _) => OnBranch::On,
        (false, Some(0)) => OnBranch::On,
        (false, Some(_)) => OnBranch::Off,
        (false, None) => OnBranch::Unknown,
    }
}

/// What a note of a landing by hand adds after `what` (landing_note):
/// what tied the commit; the note's author is who did.
pub(crate) fn tie_note(path: &str, tie: Option<Tie>) -> String {
    match tie {
        None => String::new(),
        Some(Tie::Named) => ", which names it".to_owned(),
        Some(Tie::Merged(pull)) => format!(", which merged {path}#{pull}"),
        Some(Tie::ByHand) => ", tied by hand: the commit does not name it".to_owned(),
    }
}

/// The pull requests of repository `?1` that merged as commit `?2`, and
/// whether each names work item `?3` as its own or in what it closed or
/// was part of when it merged.
const MERGED_AS: &str = "SELECT number, title, body,
       (item_id IS ?3 OR EXISTS (SELECT 1 FROM json_each(pulls.closes_items) WHERE value = ?3)
         OR EXISTS (SELECT 1 FROM json_each(pulls.parts) WHERE value = ?3)) AS names
     FROM pulls WHERE repo_id = ?1 AND status = 'merged' AND merge_commit = ?2
     ORDER BY number LIMIT 5";

#[derive(Deserialize)]
struct MergedAs {
    number: u32,
    title: String,
    body: Option<String>,
    names: u8,
}

/// Landing a work item (`?1`) in repository `?2` at `?3`, by `?4` (an
/// account id), resolved by `?5` (a stored resolution, JSON), whose pull
/// request and commit are `?6` and `?7`, in one batch: linked (as touched,
/// unless it is already), marked landed there, the resolution recorded
/// once, and closed when no target is left to land.
pub(crate) const LAND_SQL: [&str; 4] = [
    "INSERT INTO work_item_repos (item_id, repo_id, role, added_at, added_by)
     VALUES (?1, ?2, 'touched', ?3, ?4) ON CONFLICT (item_id, repo_id) DO NOTHING",
    "UPDATE work_item_repos SET landed_at = COALESCE(landed_at, ?3) WHERE item_id = ?1 AND repo_id = ?2",
    "UPDATE work_items SET resolutions = json_insert(resolutions, '$[#]', json(?5)), updated_at = ?3
     WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM json_each(work_items.resolutions) j
       WHERE json_extract(j.value, '$.repo_id') = ?2 AND json_extract(j.value, '$.pull') IS ?6
         AND json_extract(j.value, '$.commit') IS ?7)",
    "UPDATE work_items SET state = 'closed', reason = 'completed', closed_at = ?3, updated_at = ?3
     WHERE id = ?1 AND state = 'open'
       AND NOT EXISTS (SELECT 1 FROM work_item_repos WHERE item_id = ?1 AND role = 'target' AND landed_at IS NULL)
     RETURNING id AS value",
];

/// The work items a commit (`?2`) pushed to repository `?1` resolved.
const CLOSED_BY_COMMIT: &str = "SELECT i.workspace, i.number, i.title, i.state = 'closed' AS closed, i.id AS id
     FROM work_item_repos r JOIN work_items i ON i.id = r.item_id
     WHERE r.repo_id = ?1 AND i.number IS NOT NULL
       AND EXISTS (SELECT 1 FROM json_each(i.resolutions) j
         WHERE json_extract(j.value, '$.repo_id') = ?1 AND json_extract(j.value, '$.commit') = ?2)
     ORDER BY i.number LIMIT 50";

/// The repositories of workspace `?1` with what earlier work items (not
/// `?2`) landed in them, newest first.
const LANDED_BEFORE: &str = "SELECT r.repo_id AS repo_id, i.title AS title, i.labels AS labels
     FROM work_item_repos r JOIN work_items i ON i.id = r.item_id
     WHERE i.workspace = ?1 AND i.id <> ?2 AND r.landed_at IS NOT NULL
     ORDER BY r.landed_at DESC LIMIT ?3";

#[derive(Deserialize)]
struct ClosedRow {
    id: String,
    workspace: String,
    number: u32,
    title: String,
    closed: u8,
}

/// A repository another work item of the workspace landed in.
#[derive(Clone, Debug, Deserialize)]
pub(crate) struct PastLanding {
    pub repo_id: String,
    pub title: String,
    /// JSON array of label names.
    pub labels: String,
}

/// Those of `rows` (what a commit resolved) that `viewer` may see.
fn seen_closed(rows: Vec<ClosedRow>, held: &[Held], viewer: Option<&User>) -> Vec<ClosedItem> {
    rows.into_iter()
        .filter(|row| held.iter().any(|held| held.item.id == row.id && held.may(viewer, g1t_contracts::access::Capability::Read)))
        .map(|row| ClosedItem { workspace: row.workspace, number: row.number, title: row.title, closed: row.closed != 0 })
        .collect()
}

/// A note of a landing: where, and by what.
pub(crate) fn landing_note(path: &str, pull: Option<u32>, commit: Option<&str>) -> String {
    match (pull, commit) {
        (Some(pull), _) => format!("{path}#{pull}"),
        (None, Some(commit)) => format!("{path}@{}", &commit[..7.min(commit.len())]),
        (None, None) => path.to_owned(),
    }
}

impl Work {
    /// Lands `closes` (work items, by id) in `repo` by `landing`, and links
    /// `parts`: see the module's notes. Says so on each, with the session
    /// it was done in when one is known; `agent` when an agent pushed for
    /// `actor` (the note is then g1t's, for them). Returns the work items
    /// it closed.
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn land(
        &self,
        repo: &Repo,
        landing: &Landing,
        actor: &User,
        closes: &[String],
        parts: &[String],
        session: Option<&str>,
        agent: bool,
    ) -> Result<Vec<Held>> {
        let now = rfc3339(now_ms());
        let path = path_of(repo);
        let by = match By::from(actor) {
            by if agent && by.acting_for.is_none() && by.id == actor.id => By {
                id: g1t_contracts::identity::AGENT_ID,
                name: g1t_contracts::identity::AGENT_NAME,
                acting_for: Some((&actor.id, &actor.username)),
            },
            by => by,
        };
        let stored = StoredResolution {
            repo_id: repo.id.clone(),
            pull: landing.pull,
            commit: landing.commit.clone(),
            pushed_by: landing.pushed_by.clone(),
        };
        let resolution = Resolution {
            repo: path.clone(),
            pull: landing.pull,
            commit: landing.commit.clone(),
            pushed_by: landing.pushed_by.clone(),
        };
        let what = landing_note(&path, landing.pull, landing.commit.as_deref()) + &tie_note(&path, landing.tie);
        let mut closed = Vec::new();
        for id in closes {
            let Some(before) = self.item_by_id(id).await? else { continue };
            let binds: [JsValue; 7] = [
                id.as_str().into(),
                repo.id.as_str().into(),
                now.as_str().into(),
                actor.id.as_str().into(),
                serde_json::to_string(&stored)?.into(),
                landing.pull.map_or(JsValue::NULL, JsValue::from),
                landing.commit.as_deref().map_or(JsValue::NULL, JsValue::from),
            ];
            let statements = LAND_SQL
                .iter()
                .map(|sql| self.db.prepare(*sql).bind(&binds[..g1t_kit::rename::parameters(sql)]))
                .collect::<Result<Vec<_>>>()?;
            let results = self.db.batch(statements).await?;
            let closed_now = results
                .get(3)
                .map(|result| result.results::<ValueRow>())
                .transpose()?
                .is_some_and(|rows| !rows.is_empty());
            let Some(held) = self.item_by_id(id).await? else { continue };
            if closed_now {
                self.publish_item(
                    "work_item.closed",
                    &held,
                    Some(actor),
                    WorkItemEvent {
                        reason: Some(CloseReason::Completed.as_str()),
                        resolution: Some(resolution.clone()),
                        missing: Some(Vec::new()),
                        session: session.map(str::to_owned),
                        ..Self::item_event(&held)
                    },
                )
                .await?;
                let text = match landing.pull {
                    Some(_) => format!("closed this by merging {what}"),
                    None => format!("closed this in {what}"),
                };
                self.note_item(id, by, &crate::pushed::closed_note(&text, session)).await?;
                self.item_resolved(&held, actor, true, Some(landing)).await;
                closed.push(held);
                continue;
            }
            self.publish_item(
                "work_item.landed",
                &held,
                Some(actor),
                WorkItemEvent {
                    resolution: Some(resolution.clone()),
                    missing: Some(held.item.missing()),
                    session: session.map(str::to_owned),
                    ..Self::item_event(&held)
                },
            )
            .await?;
            if before.item.state == State::Open {
                let missing = held.item.missing();
                let text = if missing.is_empty() {
                    format!("landed {what}")
                } else {
                    format!("landed {what}; still to land in {}", missing.join(", "))
                };
                self.note_item(id, by, &crate::pushed::closed_note(&text, session)).await?;
                // Landed for it: what it blocks hears, though it stays open
                // and they still wait on it.
                self.item_resolved(&held, actor, false, Some(landing)).await;
            }
        }
        for id in parts {
            let linked = self
                .db
                .prepare(PART_SQL)
                .bind(&[id.as_str().into(), repo.id.as_str().into(), now.as_str().into(), actor.id.as_str().into()])?
                .first::<ValueRow>(None)
                .await?;
            if linked.is_none() {
                continue;
            }
            let Some(held) = self.item_by_id(id).await? else { continue };
            self.publish_item(
                "work_item.linked",
                &held,
                Some(actor),
                WorkItemEvent { repo: Some(path.clone()), role: Some(LinkRole::Touched), ..Self::item_event(&held) },
            )
            .await?;
            self.note_item(id, by, &format!("linked {path}: {what} is part of this")).await?;
        }
        Ok(closed)
    }

    /// `close_work_item` with a commit: the commit, on the default branch
    /// of `repo`, tied to work item `held` (see [`tie`]), with the session
    /// it names, if it names one of this repository's, and how it is tied.
    /// Anything else is refused, saying why.
    pub(super) async fn closing_commit(
        &self,
        repo: &Repo,
        held: &Held,
        commit: &str,
        actor: &User,
    ) -> Result<Outcome<(String, Option<String>, Tie)>> {
        let number = held.item.number;
        let commit = commit.trim().to_lowercase();
        if !(4..=64).contains(&commit.len()) || !commit.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Ok(Outcome::fail(FailureCode::Invalid, "commit is a commit's hash."));
        }
        let path = RepoPath { namespace: repo.namespace.clone(), name: repo.name.clone() };
        let log = |at: Option<String>| LogArgs { path: path.clone(), viewer: Some(actor.clone()), git_ref: at, limit: 1 };
        let (named, tip) = (log(Some(commit.clone())), log(None));
        let (found, head) = futures_util::future::join(
            g1t_kit::call::<_, Outcome<Vec<Commit>>>(&self.repos, "log", &named),
            g1t_kit::call::<_, Outcome<Vec<Commit>>>(&self.repos, "log", &tip),
        )
        .await;
        let found = match found? {
            Outcome::Ok(commits) => commits.into_iter().next().filter(|found| found.hash.starts_with(&commit)),
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let Some(found) = found else {
            return Ok(Outcome::fail(
                FailureCode::NotFound,
                format!("There is no commit {commit} in {}/{}; give its full hash.", repo.namespace, repo.name),
            ));
        };
        let short = &found.hash[..7.min(found.hash.len())];
        let mut names = false;
        for reference in refs::named(&found.message).closes {
            if self.ref_item(repo, &reference).await?.as_deref() == Some(held.item.id.as_str()) {
                names = true;
                break;
            }
        }
        let merged = if names { None } else { self.merged_naming(repo, held, &found.hash).await? };
        let may_push = matches!(crate::allowed(Some(actor), repo, g1t_contracts::access::Capability::Push), Outcome::Ok(()));
        let Some(tie) = tie(names, merged, may_push) else {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                format!(
                    "Commit {short} does not name #{number} (Fixes #{number}), nor is it the merge of a pull request that does: \
                     tying it to #{number} by hand takes the Write role on {}/{}.",
                    repo.namespace, repo.name
                ),
            ));
        };
        let head = match head? {
            Outcome::Ok(commits) => commits.into_iter().next(),
            Outcome::Fail(_) => None,
        };
        let Some(head) = head else {
            return Ok(Outcome::fail(FailureCode::Invalid, format!("Commit {short} is not on {}.", repo.default_branch)));
        };
        let at_tip = head.hash == found.hash;
        let ahead = if at_tip {
            None
        } else {
            let drifts: Outcome<BranchDrifts> = g1t_kit::call(
                &self.repos,
                "branch_drift",
                &BranchDriftArgs { path: path.clone(), viewer: Some(actor.clone()), base: head.hash, heads: vec![found.hash.clone()] },
            )
            .await?;
            match drifts {
                Outcome::Ok(drifts) => drifts.branches.into_iter().next().and_then(|branch| branch.drift).map(|drift| drift.ahead),
                Outcome::Fail(_) => None,
            }
        };
        match on_branch(at_tip, ahead) {
            OnBranch::On => {}
            OnBranch::Off => {
                return Ok(Outcome::fail(
                    FailureCode::Invalid,
                    format!("Commit {short} is not on {}, the default branch: only a commit there closes a work item.", repo.default_branch),
                ));
            }
            OnBranch::Unknown => {
                return Ok(Outcome::fail(
                    FailureCode::Invalid,
                    format!("Could not tell whether commit {short} is on {}: it is too far back.", repo.default_branch),
                ));
            }
        }
        let session = self.trailer_session(&repo.id, &found.message).await?;
        Ok(Outcome::Ok((found.hash, session, tie)))
    }

    /// The pull request of `repo` that merged as commit `hash` and names
    /// work item `held`: as its own, in what it closed or was part of when
    /// it merged, or after `Closes` or `Part of` in its title or
    /// description as they read now.
    async fn merged_naming(&self, repo: &Repo, held: &Held, hash: &str) -> Result<Option<u32>> {
        let pulls = self
            .db
            .prepare(MERGED_AS)
            .bind(&[repo.id.as_str().into(), hash.into(), held.item.id.as_str().into()])?
            .all()
            .await?
            .results::<MergedAs>()?;
        for pull in pulls {
            if pull.names != 0 {
                return Ok(Some(pull.number));
            }
            let named = refs::named(&format!("{}\n{}", pull.title, pull.body.as_deref().unwrap_or_default()));
            for reference in named.closes.iter().chain(&named.parts) {
                if self.ref_item(repo, reference).await?.as_deref() == Some(held.item.id.as_str()) {
                    return Ok(Some(pull.number));
                }
            }
        }
        Ok(None)
    }

    /// `closed_by_commit`: the work items a commit pushed to a repository
    /// resolved, for anyone who may read the repository: those of them
    /// they may see.
    pub(crate) async fn closed_by_commit(&self, a: ClosedByCommitArgs) -> Result<Outcome<Vec<ClosedItem>>> {
        let Some(commit) = crate::commit_comments::valid_commit(&a.commit).filter(|commit| commit.len() >= 40) else {
            return Ok(Outcome::Ok(Vec::new()));
        };
        let repo = match self.repo(&a.repo, &a.viewer).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let rows = self.db.prepare(CLOSED_BY_COMMIT).bind(&[repo.id.as_str().into(), commit.into()])?.all().await?.results::<ClosedRow>()?;
        let ids: Vec<String> = rows.iter().map(|row| row.id.clone()).collect();
        let held = self.items_by_ids(&ids).await?;
        let viewer = a.viewer.as_ref();
        Ok(Outcome::Ok(seen_closed(rows, &held, viewer)))
    }

    /// Where the other work items of `held`'s workspace landed, newest
    /// first, at most `limit`.
    pub(super) async fn landed_before(&self, held: &Held, limit: u32) -> Result<Vec<PastLanding>> {
        Ok(self
            .db
            .prepare(LANDED_BEFORE)
            .bind(&[held.item.workspace.as_str().into(), held.item.id.as_str().into(), limit.into()])?
            .all()
            .await?
            .results()?)
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::params;

    use super::*;

    #[test]
    fn a_commit_names_only_the_work_items_the_viewer_may_see() {
        use crate::items::rows_for_test::{held_for_test, person_for_test};
        let row = |id: &str, number: u32| ClosedRow { id: id.into(), workspace: "acme".into(), number, title: format!("Item {number}"), closed: 1 };
        // #1 filed in a public repository, #2 a members-only one.
        let held = vec![held_for_test(1, &[("rep_web", "origin", "acme", false)], &[]), held_for_test(2, &[], &[])];
        let numbers = |viewer: Option<&User>| -> Vec<u32> {
            seen_closed(vec![row("wki_1", 1), row("wki_2", 2)], &held, viewer).iter().map(|item| item.number).collect()
        };
        assert_eq!(numbers(None), vec![1]);
        assert_eq!(numbers(Some(&person_for_test("usr_9", None))), vec![1]);
        assert_eq!(numbers(Some(&person_for_test("usr_2", Some("acme")))), vec![1, 2]);
    }

    #[test]
    fn a_landing_is_named_by_its_pull_request_or_commit() {
        assert_eq!(landing_note("acme/web", Some(12), None), "acme/web#12");
        assert_eq!(landing_note("acme/web", None, Some("abcdef1234")), "acme/web@abcdef1");
    }

    #[test]
    fn an_explicit_close_ties_any_commit_for_someone_with_write() {
        // A commit that names the work item, or the merge of a pull request
        // that does, needs nothing more.
        assert_eq!(tie(true, None, false), Some(Tie::Named));
        assert_eq!(tie(true, Some(14), true), Some(Tie::Named));
        assert_eq!(tie(false, Some(14), false), Some(Tie::Merged(14)));
        // One that does not is tied by hand, only with the Write role.
        assert_eq!(tie(false, None, true), Some(Tie::ByHand));
        assert_eq!(tie(false, None, false), None);
    }

    #[test]
    fn only_a_commit_on_the_default_branch_closes_a_work_item() {
        assert_eq!(on_branch(true, None), OnBranch::On);
        assert_eq!(on_branch(false, Some(0)), OnBranch::On);
        assert_eq!(on_branch(false, Some(2)), OnBranch::Off);
        assert_eq!(on_branch(false, None), OnBranch::Unknown);
    }

    #[test]
    fn the_note_says_what_tied_the_commit() {
        let what = |tie| landing_note("acme/web", None, Some("abcdef1234")) + &tie_note("acme/web", tie);
        assert_eq!(what(None), "acme/web@abcdef1");
        assert_eq!(what(Some(Tie::Named)), "acme/web@abcdef1, which names it");
        assert_eq!(what(Some(Tie::Merged(14))), "acme/web@abcdef1, which merged acme/web#14");
        assert_eq!(what(Some(Tie::ByHand)), "acme/web@abcdef1, tied by hand: the commit does not name it");
    }

    #[test]
    fn a_merge_commit_names_what_its_pull_request_landed() {
        let db = crate::migrated::database();
        db.execute_batch(
            "INSERT INTO work_items (id, workspace, number, title, body, state, resolutions, author_id, author_name, created_at, updated_at)
             VALUES ('wki_1', 'acme', 1, 'One', '', 'open', '[]', 'user', 'user', 'now', 'now'),
                    ('wki_2', 'acme', 2, 'Two', '', 'open', '[]', 'user', 'user', 'now', 'now');",
        )
        .unwrap();
        let pull = |id: &str, repo: &str, number: u32, status: &str, merge: &str, item: Option<&str>, closes: &str, parts: &str| {
            db.execute(
                "INSERT INTO pulls (id, repo_id, number, title, body, agent, runtime, status, merge_commit, item_id, closes_items, parts,
                   author_id, author_name, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 'Fix', NULL, 'a', 'r', ?4, ?5, ?6, ?7, ?8, 'user', 'user', 'now', 'now')",
                params![id, repo, number, status, merge, item, closes, parts],
            )
            .unwrap();
        };
        pull("pr_own", "repo", 14, "merged", "m14", Some("wki_1"), "[]", "[]");
        pull("pr_closes", "repo", 15, "merged", "m15", None, r#"["wki_1"]"#, "[]");
        pull("pr_part", "repo", 16, "merged", "m16", None, "[]", r#"["wki_2","wki_1"]"#);
        pull("pr_other", "repo", 17, "merged", "m17", Some("wki_2"), r#"["wki_2"]"#, "[]");
        pull("pr_open", "repo", 18, "open", "m18", Some("wki_1"), "[]", "[]");
        pull("pr_away", "away", 14, "merged", "m14b", Some("wki_1"), "[]", "[]");
        let merged = |repo: &str, commit: &str| -> Vec<(u32, u8)> {
            db.prepare(MERGED_AS)
                .unwrap()
                .query_map(params![repo, commit, "wki_1"], |row| Ok((row.get(0)?, row.get(3)?)))
                .unwrap()
                .map(Result::unwrap)
                .collect()
        };
        assert_eq!(merged("repo", "m14"), vec![(14, 1)]);
        assert_eq!(merged("repo", "m15"), vec![(15, 1)]);
        assert_eq!(merged("repo", "m16"), vec![(16, 1)]);
        // Another work item's merge is found, naming nothing of #1's.
        assert_eq!(merged("repo", "m17"), vec![(17, 0)]);
        // Not merged, or merged elsewhere: nothing.
        assert_eq!(merged("repo", "m18"), vec![]);
        assert_eq!(merged("repo", "m14b"), vec![]);
        assert_eq!(g1t_kit::rename::parameters(MERGED_AS), 3);
    }

    #[test]
    fn landing_statements_take_the_item_repository_and_what_landed() {
        let counts: Vec<usize> = LAND_SQL.iter().map(|sql| g1t_kit::rename::parameters(sql)).collect();
        assert_eq!(counts, vec![4, 3, 7, 3]);
        assert_eq!(g1t_kit::rename::parameters(PART_SQL), 4);
    }

    #[test]
    fn a_commit_names_what_it_resolved_in_its_repository() {
        let db = crate::migrated::database();
        let resolved = |repo: &str| format!(r#"[{{"repo_id":"{repo}","pull":null,"commit":"c1","pushed_by":"ana"}}]"#);
        let item = |id: &str, number: u32, title: &str, state: &str, repo: &str| {
            db.execute(
                "INSERT INTO work_items (id, workspace, number, title, body, state, resolutions, author_id, author_name, created_at, updated_at)
                 VALUES (?1, 'acme', ?2, ?3, '', ?4, ?5, 'user', 'user', 'now', 'now')",
                params![id, number, title, state, resolved(repo)],
            )
            .unwrap();
        };
        item("wki_1", 7, "Broken header", "closed", "repo");
        item("wki_2", 8, "Footer", "open", "repo");
        item("wki_3", 9, "Elsewhere", "closed", "other");
        db.execute_batch(
            "INSERT INTO work_item_repos (item_id, repo_id, role, added_at) VALUES
               ('wki_1', 'repo', 'origin', 'now'), ('wki_2', 'repo', 'touched', 'now'), ('wki_3', 'other', 'origin', 'now');",
        )
        .unwrap();
        let closed: Vec<(String, u32, String, u8)> = db
            .prepare(CLOSED_BY_COMMIT)
            .unwrap()
            .query_map(params!["repo", "c1"], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(closed, vec![("acme".to_owned(), 7, "Broken header".to_owned(), 1), ("acme".to_owned(), 8, "Footer".to_owned(), 0)]);
    }
}
