//! What landing a work item does, and closing one by a commit.
//!
//! When a pull request merges into the default branch, or a commit naming
//! a work item is pushed there, where the repository closes work items
//! that way (`RepoSettings::auto_close_items`), the repository's link to
//! each work item it closes is marked landed and the resolution recorded
//! ([`LAND_SQL`]); the work item closes once it has landed in every target
//! it has, or at once when it has none. What it is part of is linked
//! (`touched`), and closes nothing.

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
const CLOSED_BY_COMMIT: &str = "SELECT i.workspace, i.number, i.title, i.state = 'closed' AS closed
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
        let what = landing_note(&path, landing.pull, landing.commit.as_deref());
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
                self.item_resolved(&held, actor, true, landing.pull).await;
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
                // Merged for it: what it blocks hears, though it stays open.
                self.item_resolved(&held, actor, false, landing.pull).await;
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
    /// of `repo`, whose message names work item `held` after a closing
    /// keyword, with the session it names, if it names one of this
    /// repository's. Anything else is refused, saying why.
    pub(super) async fn closing_commit(
        &self,
        repo: &Repo,
        held: &Held,
        commit: &str,
        actor: &User,
    ) -> Result<Outcome<(String, Option<String>)>> {
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
        if !names {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                format!("Commit {short} does not close #{number}: its message names it after no closing keyword (Fixes #{number})."),
            ));
        }
        let head = match head? {
            Outcome::Ok(commits) => commits.into_iter().next(),
            Outcome::Fail(_) => None,
        };
        let Some(head) = head else {
            return Ok(Outcome::fail(FailureCode::Invalid, format!("Commit {short} is not on {}.", repo.default_branch)));
        };
        if head.hash != found.hash {
            let drifts: Outcome<BranchDrifts> = g1t_kit::call(
                &self.repos,
                "branch_drift",
                &BranchDriftArgs { path: path.clone(), viewer: Some(actor.clone()), base: head.hash, heads: vec![found.hash.clone()] },
            )
            .await?;
            let drift = match drifts {
                Outcome::Ok(drifts) => drifts.branches.into_iter().next().and_then(|branch| branch.drift),
                Outcome::Fail(_) => None,
            };
            match drift {
                Some(drift) if drift.ahead == 0 => {}
                Some(_) => {
                    return Ok(Outcome::fail(
                        FailureCode::Invalid,
                        format!("Commit {short} is not on {}, the default branch: only a commit there closes a work item.", repo.default_branch),
                    ));
                }
                None => {
                    return Ok(Outcome::fail(
                        FailureCode::Invalid,
                        format!("Could not tell whether commit {short} is on {}: it is too far back.", repo.default_branch),
                    ));
                }
            }
        }
        let session = self.trailer_session(&repo.id, &found.message).await?;
        Ok(Outcome::Ok((found.hash, session)))
    }

    /// `closed_by_commit`: the work items a commit pushed to a repository
    /// resolved, for anyone who may read the repository.
    pub(crate) async fn closed_by_commit(&self, a: ClosedByCommitArgs) -> Result<Outcome<Vec<ClosedItem>>> {
        let Some(commit) = crate::commit_comments::valid_commit(&a.commit).filter(|commit| commit.len() >= 40) else {
            return Ok(Outcome::Ok(Vec::new()));
        };
        let repo = match self.repo(&a.repo, &a.viewer).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        Ok(Outcome::Ok(
            self.db
                .prepare(CLOSED_BY_COMMIT)
                .bind(&[repo.id.as_str().into(), commit.into()])?
                .all()
                .await?
                .results::<ClosedRow>()?
                .into_iter()
                .map(|row| ClosedItem { workspace: row.workspace, number: row.number, title: row.title, closed: row.closed != 0 })
                .collect(),
        ))
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
    fn a_landing_is_named_by_its_pull_request_or_commit() {
        assert_eq!(landing_note("acme/web", Some(12), None), "acme/web#12");
        assert_eq!(landing_note("acme/web", None, Some("abcdef1234")), "acme/web@abcdef1");
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
