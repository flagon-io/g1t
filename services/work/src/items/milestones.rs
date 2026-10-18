//! Milestones: goals of a workspace, with an optional due date, that its
//! work items and its repositories' pull requests are gathered under. A
//! work item or a pull request is in at most one, by number (`milestone`
//! on its row).

use g1t_contracts::access::{self, Capability};
use g1t_contracts::events::{PullEvent, WorkItemEvent};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, User};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use super::labels::Labeled;
use super::rows::{ITEM_COLUMNS, ItemRow, workspace_of};
use crate::rows::{PULL_COLUMNS, PullRow};
use crate::Work;

macro_rules! check {
    ($outcome:expr) => {
        match $outcome {
            Outcome::Ok(value) => value,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        }
    };
}

#[derive(Deserialize)]
struct MilestoneRow {
    number: u32,
    title: String,
    description: String,
    due_on: Option<String>,
    state: State,
    created_at: String,
    updated_at: String,
    closed_at: Option<String>,
    #[serde(default)]
    open_items: u32,
    #[serde(default)]
    closed_items: u32,
    #[serde(default)]
    origin_repo_id: Option<String>,
}

impl From<MilestoneRow> for Milestone {
    fn from(row: MilestoneRow) -> Self {
        Milestone {
            number: row.number,
            title: row.title,
            description: row.description,
            due_on: row.due_on,
            state: row.state,
            open_items: row.open_items,
            closed_items: row.closed_items,
            created_at: row.created_at,
            updated_at: row.updated_at,
            closed_at: row.closed_at,
            origin_repo_id: row.origin_repo_id,
        }
    }
}

/// The pull requests of a workspace's (`?1`) repositories.
const WORKSPACE_PULLS: &str = "pulls.repo_id IN (SELECT repo_id FROM repo_workspaces WHERE workspace = ?1)";

/// A workspace's milestones with how many items are open and closed in
/// each. `?1` is its slug.
const MILESTONES: &str = "SELECT milestones.*,
   (SELECT count(*) FROM work_items WHERE work_items.workspace = ?1 AND work_items.milestone = milestones.number
      AND work_items.state = 'open')
   + (SELECT count(*) FROM pulls WHERE {WORKSPACE_PULLS} AND pulls.milestone = milestones.number
      AND pulls.status IN ('draft', 'open')) AS open_items,
   (SELECT count(*) FROM work_items WHERE work_items.workspace = ?1 AND work_items.milestone = milestones.number
      AND work_items.state = 'closed')
   + (SELECT count(*) FROM pulls WHERE {WORKSPACE_PULLS} AND pulls.milestone = milestones.number
      AND pulls.status IN ('merged', 'closed')) AS closed_items
 FROM milestones WHERE workspace = ?1";

fn milestones_sql() -> String {
    MILESTONES.replace("{WORKSPACE_PULLS}", WORKSPACE_PULLS)
}

/// Open ones first, soonest due first and those without a date after;
/// then closed ones, most recently closed first.
const ORDER: &str = "ORDER BY state = 'closed', CASE WHEN state = 'open' THEN due_on IS NULL END,
   CASE WHEN state = 'open' THEN due_on END, CASE WHEN state = 'closed' THEN closed_at END DESC, number";

const MAX_LISTED: u32 = 200;

fn tidy_title(title: &str) -> Result<String, &'static str> {
    let title = title.trim();
    if title.is_empty() {
        Err("A milestone needs a title.")
    } else if title.chars().count() > MAX_MILESTONE_TITLE_CHARS {
        Err("A milestone's title can be at most 100 characters.")
    } else {
        Ok(title.to_owned())
    }
}

/// A due date as given: `Some(None)` clears it.
fn due(given: Option<&str>) -> Result<Option<Option<String>>, &'static str> {
    match given.map(str::trim) {
        None => Ok(None),
        Some("") => Ok(Some(None)),
        Some(value) => match tidy_due_on(value) {
            Some(day) => Ok(Some(Some(day))),
            None => Err("A due date is a day, written YYYY-MM-DD."),
        },
    }
}

/// The sentence for the conversation when an item moves between milestones.
pub(crate) fn milestone_note(before: Option<&MilestoneRef>, after: Option<&MilestoneRef>) -> Option<String> {
    match (before, after) {
        (Some(old), Some(new)) if old.number == new.number => None,
        (Some(old), Some(new)) => Some(format!("moved this from the {} milestone to {}", old.title, new.title)),
        (None, Some(new)) => Some(format!("added this to the {} milestone", new.title)),
        (Some(old), None) => Some(format!("removed this from the {} milestone", old.title)),
        (None, None) => None,
    }
}

impl Work {
    async fn milestones_in(&self, workspace: &str, number: Option<u32>, state: Option<State>) -> Result<Vec<Milestone>> {
        let state = crate::state_name(state).map_or(JsValue::NULL, JsValue::from);
        let number = crate::optional_number(number);
        let rows = self
            .db
            .prepare(format!(
                "{} AND (?2 IS NULL OR number = ?2) AND (?3 IS NULL OR state = ?3) {ORDER} LIMIT {MAX_LISTED}",
                milestones_sql()
            ))
            .bind(&[workspace.into(), number, state])?
            .all()
            .await?;
        Ok(rows.results::<MilestoneRow>()?.into_iter().map(Milestone::from).collect())
    }

    pub(crate) async fn milestone_by_number(&self, workspace: &str, number: u32) -> Result<Option<Milestone>> {
        Ok(self.milestones_in(workspace, Some(number), None).await?.pop())
    }

    pub(crate) async fn list_milestones(&self, a: ListMilestonesArgs) -> Result<Outcome<Vec<Milestone>>> {
        let workspace = workspace_of(&a.workspace, None);
        if !self.workspace_visible(&a.viewer, &workspace).await? {
            return Ok(Outcome::fail(FailureCode::NotFound, "Workspace not found."));
        }
        Ok(Outcome::Ok(self.milestones_in(&workspace, None, a.state).await?))
    }

    /// One milestone with the work items and pull requests in it the viewer
    /// may see, newest first.
    pub(crate) async fn get_milestone(&self, a: WorkItemViewArgs) -> Result<Outcome<MilestoneDetail>> {
        let workspace = workspace_of(&a.workspace, None);
        if !self.workspace_visible(&a.viewer, &workspace).await? {
            return Ok(Outcome::fail(FailureCode::NotFound, "Milestone not found."));
        }
        let Some(milestone) = self.milestone_by_number(&workspace, a.number).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Milestone not found."));
        };
        let key = [JsValue::from(workspace.as_str()), JsValue::from(a.number)];
        let results = self
            .db
            .batch(vec![
                self.db
                    .prepare(format!(
                        "SELECT {ITEM_COLUMNS} FROM work_items WHERE workspace = ?1 AND milestone = ?2
                         ORDER BY number DESC LIMIT 500"
                    ))
                    .bind(&key)?,
                self.db
                    .prepare(format!(
                        "SELECT {PULL_COLUMNS} FROM pulls WHERE {WORKSPACE_PULLS} AND milestone = ?2
                         ORDER BY created_at DESC LIMIT 500"
                    ))
                    .bind(&key)?,
            ])
            .await?;
        let items = match results.first() {
            Some(rows) => rows
                .results::<ItemRow>()?
                .into_iter()
                .filter_map(ItemRow::held)
                .filter(|held| held.may(a.viewer.as_ref(), Capability::Read))
                .map(|held| held.shown(a.viewer.as_ref()))
                .collect(),
            None => Vec::new(),
        };
        let pulls = match results.get(1) {
            Some(rows) => rows.results::<PullRow>()?.into_iter().map(Pull::from).collect(),
            None => Vec::new(),
        };
        let pulls = self.readable_pulls(&a.viewer, pulls).await?;
        Ok(Outcome::Ok(MilestoneDetail { milestone, items, pulls }))
    }

    /// Creates a milestone, or changes the fields given of one.
    pub(crate) async fn save_milestone(&self, a: SaveMilestoneArgs) -> Result<Outcome<Milestone>> {
        let workspace = check!(self.labelled_workspace(&a.actor, &a.workspace).await?);
        let invalid = |message: &str| Ok(Outcome::fail(FailureCode::Invalid, message));
        let title = match a.title.as_deref().map(tidy_title) {
            Some(Err(message)) => return invalid(message),
            Some(Ok(title)) => Some(title),
            None => None,
        };
        let description = a.description.as_deref().map(str::trim).map(str::to_owned);
        if description.as_ref().is_some_and(|text| text.chars().count() > MAX_MILESTONE_DESCRIPTION_CHARS) {
            return invalid("A milestone's description can be at most 4,000 characters.");
        }
        let due_on = match due(a.due_on.as_deref()) {
            Ok(due_on) => due_on,
            Err(message) => return invalid(message),
        };
        // Titles are unique in a workspace, whatever their case.
        if let Some(title) = &title {
            let clash = self
                .db
                .prepare(
                    "SELECT number AS n FROM milestones
                     WHERE workspace = ?1 AND lower(title) = lower(?2) AND (?3 IS NULL OR number != ?3)",
                )
                .bind(&[workspace.as_str().into(), title.as_str().into(), crate::optional_number(a.number)])?
                .first::<crate::rows::NumberRow>(None)
                .await?;
            if clash.is_some() {
                return Ok(Outcome::fail(
                    FailureCode::Conflict,
                    format!("A milestone named {title} already exists."),
                ));
            }
        }
        let now = rfc3339(now_ms());
        let number = match a.number {
            None => {
                let Some(title) = title else {
                    return invalid("A milestone needs a title.");
                };
                let state = crate::state_name(a.state).unwrap_or("open");
                let created = self
                    .db
                    .prepare(
                        "INSERT INTO milestones
                           (workspace, number, title, description, due_on, state, created_at, updated_at, closed_at)
                         SELECT ?1, COALESCE(MAX(number), 0) + 1, ?2, ?3, ?4, ?5, ?6, ?6,
                                CASE WHEN ?5 = 'closed' THEN ?6 END
                         FROM milestones WHERE workspace = ?1
                         RETURNING number AS n",
                    )
                    .bind(&[
                        workspace.as_str().into(),
                        title.as_str().into(),
                        description.unwrap_or_default().into(),
                        due_on.flatten().map_or(JsValue::NULL, JsValue::from),
                        state.into(),
                        now.as_str().into(),
                    ])?
                    .first::<crate::rows::NumberRow>(None)
                    .await?;
                match created {
                    Some(row) => row.n,
                    None => return Ok(Outcome::fail(FailureCode::Conflict, "The milestone could not be created.")),
                }
            }
            Some(number) => {
                if self.milestone_by_number(&workspace, number).await?.is_none() {
                    return Ok(Outcome::fail(FailureCode::NotFound, "Milestone not found."));
                }
                let state = crate::state_name(a.state);
                self.db
                    .prepare(
                        "UPDATE milestones
                         SET title = COALESCE(?3, title), description = COALESCE(?4, description),
                             due_on = CASE WHEN ?5 THEN ?6 ELSE due_on END,
                             closed_at = CASE WHEN ?7 IS NULL OR ?7 = state THEN closed_at
                                              WHEN ?7 = 'closed' THEN ?8 ELSE NULL END,
                             state = COALESCE(?7, state), updated_at = ?8
                         WHERE workspace = ?1 AND number = ?2",
                    )
                    .bind(&[
                        workspace.as_str().into(),
                        number.into(),
                        crate::optional(&title),
                        crate::optional(&description),
                        due_on.is_some().into(),
                        due_on.flatten().map_or(JsValue::NULL, JsValue::from),
                        state.map_or(JsValue::NULL, JsValue::from),
                        now.as_str().into(),
                    ])?
                    .run()
                    .await?;
                number
            }
        };
        Ok(match self.milestone_by_number(&workspace, number).await? {
            Some(milestone) => Outcome::Ok(milestone),
            None => Outcome::fail(FailureCode::NotFound, "Milestone not found."),
        })
    }

    /// Removes a milestone. What was in it is in none afterwards.
    pub(crate) async fn delete_milestone(&self, a: DeleteMilestoneArgs) -> Result<Outcome<bool>> {
        let workspace = check!(self.labelled_workspace(&a.actor, &a.workspace).await?);
        if self.milestone_by_number(&workspace, a.number).await?.is_none() {
            return Ok(Outcome::fail(FailureCode::NotFound, "Milestone not found."));
        }
        let key = [JsValue::from(workspace.as_str()), JsValue::from(a.number)];
        self.db
            .batch(vec![
                self.db.prepare("DELETE FROM milestones WHERE workspace = ?1 AND number = ?2").bind(&key)?,
                self.db.prepare("UPDATE work_items SET milestone = NULL WHERE workspace = ?1 AND milestone = ?2").bind(&key)?,
                self.db
                    .prepare(format!("UPDATE pulls SET milestone = NULL WHERE {WORKSPACE_PULLS} AND milestone = ?2"))
                    .bind(&key)?,
            ])
            .await?;
        Ok(Outcome::Ok(true))
    }

    /// The milestone of this number, as an item would name it, if the
    /// workspace has it. `Some(None)` for 0, which names none.
    pub(crate) async fn milestone_ref(&self, workspace: &str, number: u32) -> Result<Outcome<Option<MilestoneRef>>> {
        if number == 0 {
            return Ok(Outcome::Ok(None));
        }
        Ok(match self.milestone_by_number(workspace, number).await? {
            Some(milestone) => Outcome::Ok(Some(MilestoneRef { number, title: milestone.title })),
            None => Outcome::fail(FailureCode::Invalid, format!("There is no milestone #{number}.")),
        })
    }

    /// Puts a work item or a pull request in its workspace's milestone
    /// numbered `number`, or with 0 in none, and says so: in its
    /// conversation, and as `demilestoned` from the old one and
    /// `milestoned` into the new. Needs the Triage role.
    pub(crate) async fn set_milestone(&self, actor: &User, labeled: &Labeled, number: u32) -> Result<Outcome<()>> {
        let workspace = labeled.workspace();
        if !labeled.may(actor, Capability::Triage) {
            return Ok(Outcome::fail(FailureCode::Forbidden, access::needs_on_item(Capability::Triage, &workspace)));
        }
        let after = check!(self.milestone_ref(&workspace, number).await?);
        let before = labeled.milestone().cloned();
        if before.as_ref().map(|m| m.number) == after.as_ref().map(|m| m.number) {
            return Ok(Outcome::Ok(()));
        }
        let (table, id) = labeled.row();
        self.db
            .prepare(format!("UPDATE {table} SET milestone = ?, updated_at = ? WHERE id = ?"))
            .bind(&[crate::optional_number(after.as_ref().map(|m| m.number)), rfc3339(now_ms()).into(), id.into()])?
            .run()
            .await?;
        if let Some(text) = milestone_note(before.as_ref(), after.as_ref()) {
            self.note_on(labeled.on(), actor.into(), &text).await?;
        }
        for (what, milestone) in [("demilestoned", before), ("milestoned", after)] {
            let Some(milestone) = milestone else { continue };
            let milestone = Some(milestone);
            match labeled {
                Labeled::Item(held) => {
                    self.publish_item(labeled.kind(what), held, Some(actor), WorkItemEvent { milestone, ..Self::item_event(held) })
                        .await?;
                }
                Labeled::Pull(repo, pull) => {
                    self.publish(labeled.kind(what), &repo.id, actor, PullEvent { milestone, ..Self::pull_event(pull) })
                        .await?;
                }
            }
        }
        Ok(Outcome::Ok(()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn named(number: u32, title: &str) -> MilestoneRef {
        MilestoneRef { number, title: title.into() }
    }

    #[test]
    fn moving_between_milestones_is_said_once() {
        assert_eq!(milestone_note(None, Some(&named(1, "Launch"))).as_deref(), Some("added this to the Launch milestone"));
        assert_eq!(
            milestone_note(Some(&named(1, "Launch")), None).as_deref(),
            Some("removed this from the Launch milestone")
        );
        assert_eq!(
            milestone_note(Some(&named(1, "Launch")), Some(&named(2, "1.1"))).as_deref(),
            Some("moved this from the Launch milestone to 1.1")
        );
        assert_eq!(milestone_note(Some(&named(1, "Launch")), Some(&named(1, "Launch"))), None);
    }

    #[test]
    fn titles_and_due_dates_are_checked() {
        assert_eq!(tidy_title("  Launch ").unwrap(), "Launch");
        assert!(tidy_title("").is_err());
        assert!(tidy_title(&"x".repeat(101)).is_err());
        assert_eq!(due(None), Ok(None));
        assert_eq!(due(Some("")), Ok(Some(None)));
        assert_eq!(due(Some("2026-10-14")), Ok(Some(Some("2026-10-14".into()))));
        assert!(due(Some("next week")).is_err());
    }
}
