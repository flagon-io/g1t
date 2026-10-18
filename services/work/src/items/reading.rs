//! Reading work items: one by number or id, as a viewer may see it, and
//! `list_work_items` and `get_work_item`.

use g1t_contracts::access::{self, Capability};
use g1t_contracts::repos::{ReadableArgs, Repo};
use g1t_contracts::work::*;
use g1t_contracts::{Outcome, User, Viewer};
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use super::rows::{Held, ITEM_COLUMNS, ItemRow, no_item, workspace_of};
use crate::rows::{CommentRow, PULL_COLUMNS, PullRow};
use crate::{LIST_PAGE, Work, optional, optional_number, state_name};

/// What `list_work_items` reads: `?1` the workspace, then the filters, and
/// `?8` whether the viewer is a member (else only work items filed in a
/// public repository or one in `?9`, the repositories they were given a
/// role on).
const LIST_SQL: &str = "SELECT {ITEM_COLUMNS} FROM work_items
     WHERE workspace = ?1 AND (?2 IS NULL OR state = ?2)
       AND (?3 IS NULL OR EXISTS (SELECT 1 FROM json_each(work_items.labels) WHERE json_each.value = ?3))
       AND (?4 IS NULL OR milestone = ?4)
       AND (?5 IS NULL OR EXISTS (SELECT 1 FROM json_each(work_items.assignees) WHERE json_each.value = ?5))
       AND (?6 IS NULL OR EXISTS (SELECT 1 FROM work_item_repos r
             WHERE r.item_id = work_items.id AND r.repo_id = ?6 AND (?7 IS NULL OR r.role = ?7)))
       AND (?8 = 1 OR EXISTS (SELECT 1 FROM work_item_repos o JOIN repo_workspaces rw ON rw.repo_id = o.repo_id
             WHERE o.item_id = work_items.id AND o.role = 'origin'
               AND (rw.private = 0 OR o.repo_id IN (SELECT value FROM json_each(?9)))))
     ORDER BY number DESC LIMIT ?10";

/// The work items matching `condition` (on `work_items`), with everything
/// they are read with.
pub(crate) fn select(condition: &str) -> String {
    format!("SELECT {ITEM_COLUMNS} FROM work_items WHERE {condition}")
}

/// The work items a statement made by [`select`] read.
pub(crate) fn held_rows(result: &worker::D1Result) -> Result<Vec<Held>> {
    Ok(result.results::<ItemRow>()?.into_iter().filter_map(ItemRow::held).collect())
}

impl Work {
    /// A work item by workspace and number, whoever is asking.
    pub(super) async fn item(&self, workspace: &str, number: u32) -> Result<Option<Held>> {
        Ok(self
            .db
            .prepare(select("workspace = ? AND number = ?"))
            .bind(&[workspace.to_lowercase().into(), number.into()])?
            .first::<ItemRow>(None)
            .await?
            .and_then(ItemRow::held))
    }

    /// A work item by id, whoever is asking.
    pub(super) async fn item_by_id(&self, id: &str) -> Result<Option<Held>> {
        Ok(self
            .db
            .prepare(select("id = ?"))
            .bind(&[id.into()])?
            .first::<ItemRow>(None)
            .await?
            .and_then(ItemRow::held))
    }

    /// The work items of these ids, in no particular order.
    pub(super) async fn items_by_ids(&self, ids: &[String]) -> Result<Vec<Held>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        held_rows(
            &self
                .db
                .prepare(select("id IN (SELECT value FROM json_each(?))"))
                .bind(&[serde_json::to_string(ids)?.into()])?
                .all()
                .await?,
        )
    }

    /// A work item, if `viewer` may do `capability` on it.
    pub(super) async fn item_for(&self, viewer: &Viewer, workspace: &str, number: u32, capability: Capability) -> Result<Outcome<Held>> {
        let Some(held) = self.item(workspace, number).await? else {
            return Ok(no_item());
        };
        check!(held.allowed(viewer.as_ref(), capability));
        Ok(Outcome::Ok(held))
    }

    /// A work item `actor` may change: theirs (`WorkItem::owner`), or one
    /// they may triage.
    pub(super) async fn manageable_item(&self, actor: &User, workspace: &str, number: u32) -> Result<Outcome<Held>> {
        let held = check!(self.item_for(&Some(actor.clone()), workspace, number, Capability::Read).await?);
        if held.item.owner().id != actor.id {
            check!(held.allowed(Some(actor), Capability::Triage));
        }
        Ok(Outcome::Ok(held))
    }

    /// The ids of the work items of `workspace` with these numbers, in the
    /// order given.
    pub(super) async fn item_ids(&self, workspace: &str, numbers: &[u32]) -> Result<Vec<String>> {
        #[derive(Deserialize)]
        struct IdNumber {
            id: String,
            number: u32,
        }
        if numbers.is_empty() {
            return Ok(Vec::new());
        }
        let rows = self
            .db
            .prepare("SELECT id, number FROM work_items WHERE workspace = ? AND number IN (SELECT value FROM json_each(?))")
            .bind(&[workspace.into(), serde_json::to_string(numbers)?.into()])?
            .all()
            .await?
            .results::<IdNumber>()?;
        Ok(numbers.iter().filter_map(|number| rows.iter().find(|row| row.number == *number).map(|row| row.id.clone())).collect())
    }

    pub(crate) async fn list_work_items(&self, a: ListWorkItemsArgs) -> Result<Outcome<Vec<WorkItem>>> {
        let workspace = workspace_of(&a.workspace, a.repo.as_ref());
        let repo = match &a.repo {
            Some(path) => {
                let repo = check!(self.repo(path, &a.viewer).await?);
                if !repo.namespace.eq_ignore_ascii_case(&workspace) {
                    return Ok(Outcome::Ok(Vec::new()));
                }
                Some(repo)
            }
            None => None,
        };
        let viewer = a.viewer.as_ref();
        let member = viewer.and_then(|user| access::workspace_role(user, &workspace)).is_some();
        let granted: Vec<&str> = viewer
            .map(|user| user.grants.iter().filter(|grant| grant.workspace.eq_ignore_ascii_case(&workspace)).map(|grant| grant.repo_id.as_str()).collect())
            .unwrap_or_default();
        let label = a
            .label
            .map(|label| label.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase())
            .filter(|label| !label.is_empty());
        let assignee = a.assignee.map(|name| name.trim().trim_start_matches('@').to_lowercase()).filter(|name| !name.is_empty());
        let state = state_name(a.state).map_or(JsValue::NULL, JsValue::from);
        let query = self
            .db
            .prepare(LIST_SQL.replace("{ITEM_COLUMNS}", ITEM_COLUMNS))
            .bind(&[
                workspace.as_str().into(),
                state,
                optional(&label),
                optional_number(a.milestone),
                optional(&assignee),
                optional(&repo.as_ref().map(|repo| repo.id.clone())),
                a.role.map_or(JsValue::NULL, |role| role.as_str().into()),
                u32::from(member).into(),
                serde_json::to_string(&granted)?.into(),
                LIST_PAGE.into(),
            ])?;
        let rows = self.timing.db(1, query.all()).await?.results::<ItemRow>()?;
        Ok(Outcome::Ok(
            rows.into_iter()
                .filter_map(ItemRow::held)
                .filter(|held| held.may(viewer, Capability::Read))
                .map(|held| held.item)
                .collect(),
        ))
    }

    /// A work item, the pull requests for it the viewer may see, and its
    /// comments and reactions.
    pub(crate) async fn get_work_item(&self, a: WorkItemViewArgs) -> Result<Outcome<WorkItemDetail>> {
        let held = check!(self.item_for(&a.viewer, &a.workspace, a.number, Capability::Read).await?);
        let key = [JsValue::from(held.item.id.as_str())];
        let statements = vec![
            self.db.prepare(format!("SELECT {PULL_COLUMNS} FROM pulls WHERE item_id = ?1 ORDER BY created_at")).bind(&key)?,
            self.db.prepare("SELECT * FROM comments WHERE item_id = ?1 ORDER BY id LIMIT 500").bind(&key)?,
            self.db.prepare(crate::reactions::ITEM_THREAD_SQL).bind(&key)?,
        ];
        let results = self.timing.db(3, self.db.batch(statements)).await?;
        let rows = |index: usize| results.get(index).ok_or_else(|| worker::Error::RustError("short batch".into()));
        let pulls: Vec<Pull> = rows(0)?.results::<PullRow>()?.into_iter().map(Pull::from).collect();
        let mut comments: Vec<Comment> = rows(1)?.results::<CommentRow>()?.into_iter().map(Comment::from).collect();
        let reacted = rows(2)?.results::<crate::reactions::ReactionRow>()?;
        let reactions = crate::reactions::attach(&reacted, &held.item.id, &mut comments);
        let pulls = self.readable_pulls(&a.viewer, pulls).await?;
        Ok(Outcome::Ok(WorkItemDetail { item: held.item, pulls, comments, reactions }))
    }

    /// Those of `pulls` whose repositories `viewer` may read, each naming
    /// the branch it merges into.
    pub(super) async fn readable_pulls(&self, viewer: &Viewer, pulls: Vec<Pull>) -> Result<Vec<Pull>> {
        if pulls.is_empty() {
            return Ok(pulls);
        }
        let mut ids: Vec<String> = pulls.iter().map(|pull| pull.repo_id.clone()).collect();
        ids.sort();
        ids.dedup();
        let readable: Vec<Repo> = g1t_kit::call(&self.repos, "readable", &ReadableArgs { ids, viewer: viewer.clone() }).await?;
        Ok(pulls
            .into_iter()
            .filter_map(|mut pull| {
                let repo = readable.iter().find(|repo| repo.id == pull.repo_id)?;
                crate::fill_base(&mut pull, repo);
                Some(pull)
            })
            .collect())
    }
}
