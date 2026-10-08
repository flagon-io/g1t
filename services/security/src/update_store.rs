//! Version updates' tables in D1 (migration 0004): when each entry runs,
//! the update pull requests g1t makes, and ignore conditions from comments.

use g1t_contracts::new_id;
use g1t_contracts::security::{BumpArgs, UpdateState};
use g1t_contracts::updates::{IgnoreCondition, UpdatePull, UpdatedDependency};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::store::{Store, now, optional};

/// Where one `updates` entry's checks stand.
#[derive(Clone, Debug, Deserialize)]
pub struct RunRow {
    pub repo_id: String,
    pub entry: String,
    pub next_run_at: Option<String>,
    pub last_checked_at: Option<String>,
    pub last_result: Option<String>,
    pub last_error: Option<String>,
}

/// An update pull request, as stored.
#[derive(Clone, Debug, Deserialize)]
pub struct PullRow {
    pub id: String,
    pub repo_id: String,
    pub kind: String,
    pub entry: String,
    pub ecosystem: String,
    pub subject: String,
    pub signature: String,
    pub group_name: Option<String>,
    pub branch: String,
    pub title: String,
    pub body: String,
    pub dependencies: String,
    pub bump: String,
    pub assignees: String,
    pub reviewers: String,
    pub state: String,
    pub pull: Option<i64>,
    pub head: Option<String>,
    pub merge_by: Option<String>,
    pub error: Option<String>,
    pub updated_at: String,
}

impl PullRow {
    pub fn state(&self) -> UpdateState {
        UpdateState::parse(&self.state).unwrap_or(UpdateState::Failed)
    }

    pub fn pull(&self) -> Option<u32> {
        self.pull.map(|n| n.max(0) as u32)
    }

    pub fn dependencies(&self) -> Vec<UpdatedDependency> {
        serde_json::from_str(&self.dependencies).unwrap_or_default()
    }

    pub fn bump(&self) -> Option<BumpArgs> {
        serde_json::from_str(&self.bump).ok()
    }

    pub fn names(&self, column: &str) -> Vec<String> {
        serde_json::from_str(if column == "assignees" { &self.assignees } else { &self.reviewers }).unwrap_or_default()
    }

    /// Who asked for it to merge, by username.
    pub fn merge_requested_by(&self) -> Option<String> {
        self.merge_by.clone()
    }

    pub fn to_contract(&self) -> UpdatePull {
        UpdatePull {
            kind: self.kind.clone(),
            entry: self.entry.clone(),
            ecosystem: self.ecosystem.clone(),
            group: self.group_name.clone(),
            branch: self.branch.clone(),
            title: self.title.clone(),
            state: self.state.clone(),
            pull: self.pull(),
            dependencies: self.dependencies(),
            merge_requested_by: self.merge_requested_by(),
            error: self.error.clone(),
            updated_at: self.updated_at.clone(),
        }
    }
}

/// A pull request to record before its sandbox starts.
pub struct NewPull<'a> {
    pub repo_id: &'a str,
    pub kind: &'a str,
    pub entry: &'a str,
    pub ecosystem: &'a str,
    pub subject: &'a str,
    pub signature: &'a str,
    pub group: Option<&'a str>,
    pub branch: &'a str,
    pub title: &'a str,
    pub body: &'a str,
    pub dependencies: &'a [UpdatedDependency],
    /// Without registries: credentials are never stored.
    pub bump: &'a BumpArgs,
    pub assignees: &'a [String],
    pub reviewers: &'a [String],
}

#[derive(Deserialize)]
struct IgnoreRow {
    ecosystem: String,
    dependency: String,
    versions: Option<String>,
    update_type: Option<String>,
    by: String,
    pull: Option<i64>,
    at: String,
}

#[derive(Deserialize)]
struct Claimed {
    #[allow(dead_code)]
    entry: String,
}

/// What clears a repository's version update rows when it is purged.
pub const PURGED: &[&str] = &[
    "DELETE FROM update_runs WHERE repo_id = ?1",
    "DELETE FROM update_pulls WHERE repo_id = ?1",
    "DELETE FROM update_ignores WHERE repo_id = ?1",
];

/// A run claimed this long ago and never finished is taken to have died.
const RUN_CLAIM_MS: u64 = 30 * 60 * 1000;

impl Store {
    pub async fn runs(&self, repo_id: &str) -> Result<Vec<RunRow>> {
        self.db.prepare("SELECT * FROM update_runs WHERE repo_id = ?").bind(&[repo_id.into()])?.all().await?.results::<RunRow>()
    }

    /// Keeps a row for each of `entries` (id, next run) and removes the rest.
    pub async fn set_runs(&self, repo_id: &str, entries: &[(String, Option<String>)]) -> Result<()> {
        let mut statements = Vec::new();
        for (entry, next) in entries {
            statements.push(
                self.db
                    .prepare(
                        "INSERT INTO update_runs (repo_id, entry, next_run_at) VALUES (?1, ?2, ?3)
                         ON CONFLICT (repo_id, entry) DO UPDATE SET next_run_at = ?3",
                    )
                    .bind(&[repo_id.into(), entry.as_str().into(), optional(next.as_deref())])?,
            );
        }
        let keep: Vec<JsValue> = entries.iter().map(|(entry, _)| JsValue::from(entry.as_str())).collect();
        let marks = vec!["?"; keep.len()].join(", ");
        let mut binds = vec![JsValue::from(repo_id)];
        binds.extend(keep);
        let sql = if entries.is_empty() {
            "DELETE FROM update_runs WHERE repo_id = ?".to_owned()
        } else {
            format!("DELETE FROM update_runs WHERE repo_id = ? AND entry NOT IN ({marks})")
        };
        statements.push(self.db.prepare(sql).bind(&binds)?);
        self.db.batch(statements).await?;
        Ok(())
    }

    /// Entries whose next run has come, oldest first, not being run now.
    pub async fn due_runs(&self, at: &str, limit: u32) -> Result<Vec<RunRow>> {
        let stale = g1t_contracts::time::rfc3339(now_ms().saturating_sub(RUN_CLAIM_MS));
        self.db
            .prepare(
                "SELECT * FROM update_runs WHERE next_run_at IS NOT NULL AND next_run_at <= ?
                   AND (running_at IS NULL OR running_at < ?) ORDER BY next_run_at LIMIT ?",
            )
            .bind(&[at.into(), stale.into(), limit.into()])?
            .all()
            .await?
            .results::<RunRow>()
    }

    /// Takes an entry's run, unless another sweep already has.
    pub async fn claim_run(&self, repo_id: &str, entry: &str) -> Result<bool> {
        let stale = g1t_contracts::time::rfc3339(now_ms().saturating_sub(RUN_CLAIM_MS));
        let claimed = self
            .db
            .prepare(
                "INSERT INTO update_runs (repo_id, entry, running_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT (repo_id, entry) DO UPDATE SET running_at = ?3
                   WHERE update_runs.running_at IS NULL OR update_runs.running_at < ?4
                 RETURNING entry",
            )
            .bind(&[repo_id.into(), entry.into(), now().into(), stale.into()])?
            .first::<Claimed>(None)
            .await?;
        Ok(claimed.is_some())
    }

    pub async fn finish_run(&self, repo_id: &str, entry: &str, next: Option<&str>, result: Option<&str>, error: Option<&str>) -> Result<()> {
        self.db
            .prepare(
                "UPDATE update_runs SET running_at = NULL, last_checked_at = ?, next_run_at = ?, last_result = ?, last_error = ?
                 WHERE repo_id = ? AND entry = ?",
            )
            .bind(&[now().into(), optional(next), optional(result), optional(error), repo_id.into(), entry.into()])?
            .run()
            .await?;
        Ok(())
    }

    // --- Update pull requests -------------------------------------------------

    pub async fn update_pulls(&self, repo_id: &str) -> Result<Vec<PullRow>> {
        self.db
            .prepare("SELECT * FROM update_pulls WHERE repo_id = ? ORDER BY requested_at DESC LIMIT 500")
            .bind(&[repo_id.into()])?
            .all()
            .await?
            .results::<PullRow>()
    }

    /// The latest update pull request made on `branch`.
    pub async fn update_pull_by_branch(&self, repo_id: &str, branch: &str) -> Result<Option<PullRow>> {
        self.db
            .prepare("SELECT * FROM update_pulls WHERE repo_id = ? AND branch = ? ORDER BY requested_at DESC LIMIT 1")
            .bind(&[repo_id.into(), branch.into()])?
            .first::<PullRow>(None)
            .await
    }

    pub async fn update_pull_by_number(&self, repo_id: &str, number: u32) -> Result<Option<PullRow>> {
        self.db
            .prepare("SELECT * FROM update_pulls WHERE repo_id = ? AND pull = ? ORDER BY requested_at DESC LIMIT 1")
            .bind(&[repo_id.into(), number.into()])?
            .first::<PullRow>(None)
            .await
    }

    /// Open update pull requests, the least recently looked at first.
    pub async fn open_update_pulls(&self, limit: u32) -> Result<Vec<PullRow>> {
        self.db
            .prepare("SELECT * FROM update_pulls WHERE state = 'open' ORDER BY updated_at LIMIT ?")
            .bind(&[limit.into()])?
            .all()
            .await?
            .results::<PullRow>()
    }

    /// Update pull requests asked of a sandbox before `before` that never pushed.
    pub async fn stalled_update_pulls(&self, before: &str, limit: u32) -> Result<Vec<PullRow>> {
        self.db
            .prepare("SELECT * FROM update_pulls WHERE state = 'requested' AND updated_at < ? ORDER BY updated_at LIMIT ?")
            .bind(&[before.into(), limit.into()])?
            .all()
            .await?
            .results::<PullRow>()
    }

    pub async fn add_update_pull(&self, new: &NewPull<'_>) -> Result<String> {
        let id = new_id("upd", now_ms());
        let at = now();
        self.db
            .prepare(
                "INSERT INTO update_pulls (id, repo_id, kind, entry, ecosystem, subject, signature, group_name, branch, title,
                   body, dependencies, bump, assignees, reviewers, state, requested_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 'requested', ?16, ?16)",
            )
            .bind(&[
                id.as_str().into(),
                new.repo_id.into(),
                new.kind.into(),
                new.entry.into(),
                new.ecosystem.into(),
                new.subject.into(),
                new.signature.into(),
                optional(new.group),
                new.branch.into(),
                new.title.into(),
                new.body.into(),
                serde_json::to_string(new.dependencies)?.into(),
                serde_json::to_string(new.bump)?.into(),
                serde_json::to_string(new.assignees)?.into(),
                serde_json::to_string(new.reviewers)?.into(),
                at.as_str().into(),
            ])?
            .run()
            .await?;
        Ok(id)
    }

    pub async fn set_update_pull(&self, id: &str, state: UpdateState, pull: Option<u32>, issue: Option<u32>, error: Option<&str>) -> Result<()> {
        self.db
            .prepare("UPDATE update_pulls SET state = ?, pull = ?, issue = ?, error = ?, updated_at = ? WHERE id = ?")
            .bind(&[
                state.as_str().into(),
                pull.map_or(JsValue::NULL, JsValue::from),
                issue.map_or(JsValue::NULL, JsValue::from),
                optional(error),
                now().into(),
                id.into(),
            ])?
            .run()
            .await?;
        Ok(())
    }

    /// Asks for the pull request to be made again on its branch (a rebase
    /// or a recreate): it stays open while its sandbox works.
    pub async fn remake_update_pull(&self, id: &str, bump: &BumpArgs) -> Result<()> {
        self.db
            .prepare("UPDATE update_pulls SET bump = ?, head = NULL, error = NULL, updated_at = ? WHERE id = ?")
            .bind(&[serde_json::to_string(bump)?.into(), now().into(), id.into()])?
            .run()
            .await?;
        Ok(())
    }

    pub async fn set_update_pull_head(&self, id: &str, head: &str) -> Result<()> {
        self.db
            .prepare("UPDATE update_pulls SET head = ?, updated_at = ? WHERE id = ?")
            .bind(&[head.into(), now().into(), id.into()])?
            .run()
            .await?;
        Ok(())
    }

    /// Marks it looked at, so the sweep moves on to others.
    pub async fn touch_update_pull(&self, id: &str) -> Result<()> {
        self.db.prepare("UPDATE update_pulls SET updated_at = ? WHERE id = ?").bind(&[now().into(), id.into()])?.run().await?;
        Ok(())
    }

    pub async fn set_merge_by(&self, id: &str, by: Option<&str>) -> Result<()> {
        self.db.prepare("UPDATE update_pulls SET merge_by = ? WHERE id = ?").bind(&[optional(by), id.into()])?.run().await?;
        Ok(())
    }

    // --- Ignore conditions ----------------------------------------------------

    pub async fn ignores(&self, repo_id: &str) -> Result<Vec<IgnoreCondition>> {
        Ok(self
            .db
            .prepare("SELECT * FROM update_ignores WHERE repo_id = ? ORDER BY dependency, at")
            .bind(&[repo_id.into()])?
            .all()
            .await?
            .results::<IgnoreRow>()?
            .into_iter()
            .map(|row| IgnoreCondition {
                ecosystem: row.ecosystem,
                dependency: row.dependency,
                versions: row.versions,
                update_type: row.update_type,
                by: row.by,
                pull: row.pull.map(|n| n.max(0) as u32),
                at: row.at,
            })
            .collect())
    }

    pub async fn add_ignore(&self, repo_id: &str, condition: &IgnoreCondition) -> Result<()> {
        let key = condition.versions.clone().or_else(|| condition.update_type.clone()).unwrap_or_default();
        self.db
            .prepare(
                "INSERT INTO update_ignores (repo_id, ecosystem, dependency, condition, versions, update_type, by, pull, at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (repo_id, ecosystem, dependency, condition) DO UPDATE SET by = excluded.by, pull = excluded.pull, at = excluded.at",
            )
            .bind(&[
                repo_id.into(),
                condition.ecosystem.as_str().into(),
                condition.dependency.to_lowercase().as_str().into(),
                key.as_str().into(),
                optional(condition.versions.as_deref()),
                optional(condition.update_type.as_deref()),
                condition.by.as_str().into(),
                condition.pull.map_or(JsValue::NULL, JsValue::from),
                now().into(),
            ])?
            .run()
            .await?;
        Ok(())
    }

    /// Removes the conditions on `dependency` (`*` for every one) in
    /// `ecosystem`, or only those `keep` refuses. Returns how many went.
    pub async fn remove_ignores(&self, repo_id: &str, ecosystem: &str, dependency: &str, condition: Option<&str>) -> Result<usize> {
        let found = self.ignores(repo_id).await?;
        let mut removed = 0;
        for item in found {
            let named = dependency == "*" || item.dependency.eq_ignore_ascii_case(dependency);
            let key = item.versions.clone().or_else(|| item.update_type.clone()).unwrap_or_default();
            if item.ecosystem != ecosystem || !named || condition.is_some_and(|wanted| wanted != key) {
                continue;
            }
            self.db
                .prepare("DELETE FROM update_ignores WHERE repo_id = ? AND ecosystem = ? AND dependency = ? AND condition = ?")
                .bind(&[repo_id.into(), ecosystem.into(), item.dependency.as_str().into(), key.as_str().into()])?
                .run()
                .await?;
            removed += 1;
        }
        Ok(removed)
    }
}
