//! The work items a pull request or a commit says it closes or is part of,
//! and what landing them does.
//!
//! A closing keyword followed by a reference (`Fixes #12`, `closes: #3`,
//! `Resolves flagon-io/g1t#40`) names a work item to close; `Part of #12`
//! or `Refs #12` one it is part of (`g1t_contracts::work::refs`). Each is
//! read in the repository the pull request or commit is in, and only work
//! items of that repository's workspace count: another workspace's are
//! never closed from here.
//!
//! When a pull request merges into the default branch, or a commit naming
//! a work item is pushed there, where the repository closes work items
//! that way (`RepoSettings::auto_close_items`), the repository's link to
//! each work item it closes is marked landed and the resolution recorded
//! ([`LAND_SQL`]); the work item closes once it has landed in every target
//! it has, or at once when it has none. What it is part of is linked
//! (`touched`), and closes nothing.

use g1t_contracts::events::WorkItemEvent;
use g1t_contracts::repos::Repo;
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::refs::{self, Ref, RefScope};
use g1t_contracts::work::*;
use g1t_contracts::User;
use g1t_kit::now_ms;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Work;
use crate::items::{Held, Named, StoredResolution, landing_note, path_of};
use crate::rows::{By, ValueRow};

/// The most work items one pull request or commit closes this way.
pub(crate) const MAX_CLOSES: usize = refs::MAX_REFS;

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

/// Linking a work item (`?1`) that a change in repository `?2` is part of,
/// at `?3`, by `?4`, unless it is linked already.
pub(crate) const PART_SQL: &str = "INSERT INTO work_item_repos (item_id, repo_id, role, added_at, added_by)
     VALUES (?1, ?2, 'touched', ?3, ?4) ON CONFLICT (item_id, repo_id) DO NOTHING RETURNING item_id AS value";

/// The work items a text names, by id and number, in the order named.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct NamedItems {
    pub closes: Vec<(String, u32)>,
    pub parts: Vec<(String, u32)>,
}

impl NamedItems {
    pub(crate) fn close_ids(&self) -> Vec<String> {
        self.closes.iter().map(|(id, _)| id.clone()).collect()
    }

    pub(crate) fn part_ids(&self) -> Vec<String> {
        self.parts.iter().map(|(id, _)| id.clone()).collect()
    }

    pub(crate) fn close_numbers(&self) -> Vec<u32> {
        self.closes.iter().map(|(_, number)| *number).collect()
    }

    pub(crate) fn part_numbers(&self) -> Vec<u32> {
        self.parts.iter().map(|(_, number)| *number).collect()
    }
}

impl Work {
    /// The work item `reference` names, read in `repo`: its id, when it is
    /// one of the workspace's work items.
    pub(crate) async fn ref_item(&self, repo: &Repo, reference: &Ref) -> Result<Option<String>> {
        let workspace = repo.namespace.to_lowercase();
        let (repo_id, in_repo) = match &reference.scope {
            RefScope::Here => (Some(repo.id.clone()), true),
            RefScope::Workspace(named) => {
                if *named != workspace {
                    return Ok(None);
                }
                (None, false)
            }
            RefScope::Repo(path) => {
                if !path.namespace.eq_ignore_ascii_case(&workspace) {
                    return Ok(None);
                }
                let named = format!("{}/{}", path.namespace, path.name);
                if named.eq_ignore_ascii_case(&path_of(repo)) {
                    (Some(repo.id.clone()), true)
                } else {
                    let known = self
                        .db
                        .prepare("SELECT repo_id AS value FROM repo_workspaces WHERE lower(path) = lower(?)")
                        .bind(&[named.as_str().into()])?
                        .first::<ValueRow>(None)
                        .await?;
                    match known {
                        Some(row) => (Some(row.value), true),
                        None => (None, false),
                    }
                }
            }
        };
        let found = self.lookup_ref(repo_id.as_deref(), &workspace, reference.number).await?;
        Ok(match found.named(in_repo) {
            Some(Named::Item(id)) => Some(id),
            _ => None,
        })
    }

    /// The work items `text`, written in `repo`, closes and is part of,
    /// with `own` (a pull request's own work item) closed first.
    pub(crate) async fn named_items(&self, repo: &Repo, own: Option<&str>, text: &str) -> Result<NamedItems> {
        let named = refs::named(text);
        let mut closes: Vec<String> = own.map(str::to_owned).into_iter().collect();
        for reference in &named.closes {
            if let Some(id) = self.ref_item(repo, reference).await?
                && !closes.contains(&id)
            {
                closes.push(id);
            }
        }
        let mut parts: Vec<String> = Vec::new();
        for reference in &named.parts {
            if let Some(id) = self.ref_item(repo, reference).await?
                && !closes.contains(&id)
                && !parts.contains(&id)
            {
                parts.push(id);
            }
        }
        closes.truncate(MAX_CLOSES);
        parts.truncate(MAX_CLOSES);
        let mut all = closes.clone();
        all.extend(parts.iter().cloned());
        let held = self.items_by_ids(&all).await?;
        let number = |id: &String| held.iter().find(|held| held.item.id == *id).map(|held| (id.clone(), held.item.number));
        Ok(NamedItems { closes: closes.iter().filter_map(number).collect(), parts: parts.iter().filter_map(number).collect() })
    }

    /// The work items a pull request closes and is part of as its title and
    /// description say now: none closed where it does not merge into the
    /// default branch, where the repository does not close work items that
    /// way, or where it is kept open (`keep_open`), when its own work item
    /// is only something it is part of.
    pub(crate) async fn items_to_close(&self, pull: &Pull, repo: &Repo, settings: &RepoSettings, keep_open: bool) -> Result<NamedItems> {
        let own = self.pull_item_id(&pull.id).await?;
        let text = format!("{}\n{}", pull.title, pull.body.as_deref().unwrap_or_default());
        let mut named = self.named_items(repo, own.as_deref(), &text).await?;
        if keep_open || !settings.auto_close_items || !pull.targets_default(&repo.default_branch) {
            let closed = std::mem::take(&mut named.closes);
            let mut parts = if keep_open { closed } else { Vec::new() };
            parts.extend(named.parts);
            named.parts = parts;
        }
        Ok(named)
    }

    /// The id of a pull request's own work item, if it has one.
    pub(crate) async fn pull_item_id(&self, pull_id: &str) -> Result<Option<String>> {
        Ok(self
            .db
            .prepare("SELECT item_id AS value FROM pulls WHERE id = ? AND item_id IS NOT NULL")
            .bind(&[pull_id.into()])?
            .first::<ValueRow>(None)
            .await?
            .map(|row| row.value))
    }

    /// Lands `closes` (work items, by id) in `repo` by `landing`, and links
    /// `parts`: see the module's notes. Says so on each, with the session
    /// it was done in when one is known; `agent` when an agent pushed for
    /// `actor` (the note is then g1t's, for them). Returns the work items
    /// it closed.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn land(
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn landing_statements_take_the_item_repository_and_what_landed() {
        let counts: Vec<usize> = LAND_SQL.iter().map(|sql| g1t_kit::rename::parameters(sql)).collect();
        assert_eq!(counts, vec![4, 3, 7, 3]);
        assert_eq!(g1t_kit::rename::parameters(PART_SQL), 4);
    }
}
