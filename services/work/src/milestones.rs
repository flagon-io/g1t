//! Milestones: goals, with an optional due date, that issues and pull
//! requests are gathered under. An issue or a pull request is in at most
//! one, by number (`milestone` on its row).

use g1t_contracts::access::Capability;
use g1t_contracts::events::{IssueEvent, PullEvent};
use g1t_contracts::repos::Repo;
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, User};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::labels::Item;
use crate::rows::{IssueRow, PULL_COLUMNS, PullRow};
use crate::{ISSUE_COLUMNS, Work, allowed};

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
        }
    }
}

/// A repository's milestones with how many items are open and closed in
/// each. `?1` is its id.
const MILESTONES: &str = "SELECT milestones.*,
   (SELECT count(*) FROM issues WHERE issues.repo_id = ?1 AND issues.milestone = milestones.number
      AND issues.state = 'open')
   + (SELECT count(*) FROM pulls WHERE pulls.repo_id = ?1 AND pulls.milestone = milestones.number
      AND pulls.status IN ('draft', 'open')) AS open_items,
   (SELECT count(*) FROM issues WHERE issues.repo_id = ?1 AND issues.milestone = milestones.number
      AND issues.state = 'closed')
   + (SELECT count(*) FROM pulls WHERE pulls.repo_id = ?1 AND pulls.milestone = milestones.number
      AND pulls.status IN ('merged', 'closed')) AS closed_items
 FROM milestones WHERE repo_id = ?1";

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
    async fn milestones_in(&self, repo_id: &str, number: Option<u32>, state: Option<State>) -> Result<Vec<Milestone>> {
        let state = crate::state_name(state).map_or(JsValue::NULL, JsValue::from);
        let number = crate::optional_number(number);
        let rows = self
            .db
            .prepare(format!(
                "{MILESTONES} AND (?2 IS NULL OR number = ?2) AND (?3 IS NULL OR state = ?3) {ORDER} LIMIT {MAX_LISTED}"
            ))
            .bind(&[repo_id.into(), number, state])?
            .all()
            .await?;
        Ok(rows.results::<MilestoneRow>()?.into_iter().map(Milestone::from).collect())
    }

    pub(crate) async fn milestone_by_number(&self, repo_id: &str, number: u32) -> Result<Option<Milestone>> {
        Ok(self.milestones_in(repo_id, Some(number), None).await?.pop())
    }

    pub(crate) async fn list_milestones(&self, a: ListMilestonesArgs) -> Result<Outcome<Vec<Milestone>>> {
        let state = a.state;
        let read = |repo_id: String| async move { self.milestones_in(&repo_id, None, state).await };
        let (_, milestones) = check!(self.repo_then(&a.repo, &a.viewer, read).await?);
        Ok(Outcome::Ok(milestones))
    }

    /// One milestone with its issues and pull requests, newest first.
    pub(crate) async fn get_milestone(&self, a: ViewArgs) -> Result<Outcome<MilestoneDetail>> {
        let number = a.number;
        let read = |repo_id: String| async move {
            let key = [JsValue::from(repo_id.as_str()), JsValue::from(number)];
            let results = self
                .db
                .batch(vec![
                    self.db
                        .prepare(format!(
                            "SELECT {ISSUE_COLUMNS} FROM issues WHERE repo_id = ?1 AND milestone = ?2
                             ORDER BY number DESC LIMIT 500"
                        ))
                        .bind(&key)?,
                    self.db
                        .prepare(format!(
                            "SELECT {PULL_COLUMNS} FROM pulls WHERE repo_id = ?1 AND milestone = ?2
                             ORDER BY number DESC LIMIT 500"
                        ))
                        .bind(&key)?,
                ])
                .await?;
            let milestone = self.milestone_by_number(&repo_id, number).await?;
            let issues = match results.first() {
                Some(rows) => rows.results::<IssueRow>()?.into_iter().map(Issue::from).collect(),
                None => Vec::new(),
            };
            let pulls = match results.get(1) {
                Some(rows) => rows.results::<PullRow>()?.into_iter().map(Pull::from).collect(),
                None => Vec::new(),
            };
            Ok::<_, worker::Error>((milestone, issues, pulls))
        };
        let (repo, (milestone, issues, mut pulls)) = check!(self.repo_then(&a.repo, &a.viewer, read).await?);
        let Some(milestone) = milestone else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Milestone not found."));
        };
        for pull in &mut pulls {
            crate::fill_base(pull, &repo);
        }
        Ok(Outcome::Ok(MilestoneDetail { milestone, issues, pulls }))
    }

    /// Creates a milestone, or changes the fields given of one.
    pub(crate) async fn save_milestone(&self, a: SaveMilestoneArgs) -> Result<Outcome<Milestone>> {
        let repo = check!(self.triaged_repo(&a.actor, &a.repo).await?);
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
        // Titles are unique in a repository, whatever their case.
        if let Some(title) = &title {
            let clash = self
                .db
                .prepare(
                    "SELECT number AS n FROM milestones
                     WHERE repo_id = ?1 AND lower(title) = lower(?2) AND (?3 IS NULL OR number != ?3)",
                )
                .bind(&[repo.id.as_str().into(), title.as_str().into(), crate::optional_number(a.number)])?
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
                           (repo_id, number, title, description, due_on, state, created_at, updated_at, closed_at)
                         SELECT ?1, COALESCE(MAX(number), 0) + 1, ?2, ?3, ?4, ?5, ?6, ?6,
                                CASE WHEN ?5 = 'closed' THEN ?6 END
                         FROM milestones WHERE repo_id = ?1
                         RETURNING number AS n",
                    )
                    .bind(&[
                        repo.id.as_str().into(),
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
                if self.milestone_by_number(&repo.id, number).await?.is_none() {
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
                         WHERE repo_id = ?1 AND number = ?2",
                    )
                    .bind(&[
                        repo.id.as_str().into(),
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
        Ok(match self.milestone_by_number(&repo.id, number).await? {
            Some(milestone) => Outcome::Ok(milestone),
            None => Outcome::fail(FailureCode::NotFound, "Milestone not found."),
        })
    }

    /// Removes a milestone. What was in it is in none afterwards.
    pub(crate) async fn delete_milestone(&self, a: DeleteMilestoneArgs) -> Result<Outcome<bool>> {
        let repo = check!(self.triaged_repo(&a.actor, &a.repo).await?);
        if self.milestone_by_number(&repo.id, a.number).await?.is_none() {
            return Ok(Outcome::fail(FailureCode::NotFound, "Milestone not found."));
        }
        let key = [JsValue::from(repo.id.as_str()), JsValue::from(a.number)];
        self.db
            .batch(vec![
                self.db.prepare("DELETE FROM milestones WHERE repo_id = ?1 AND number = ?2").bind(&key)?,
                self.db.prepare("UPDATE issues SET milestone = NULL WHERE repo_id = ?1 AND milestone = ?2").bind(&key)?,
                self.db.prepare("UPDATE pulls SET milestone = NULL WHERE repo_id = ?1 AND milestone = ?2").bind(&key)?,
            ])
            .await?;
        Ok(Outcome::Ok(true))
    }

    /// The milestone of this number, as an item would name it, if the
    /// repository has it. `Some(None)` for 0, which names none.
    pub(crate) async fn milestone_ref(&self, repo_id: &str, number: u32) -> Result<Outcome<Option<MilestoneRef>>> {
        if number == 0 {
            return Ok(Outcome::Ok(None));
        }
        Ok(match self.milestone_by_number(repo_id, number).await? {
            Some(milestone) => Outcome::Ok(Some(MilestoneRef { number, title: milestone.title })),
            None => Outcome::fail(FailureCode::Invalid, format!("There is no milestone #{number}.")),
        })
    }

    /// Puts an issue or a pull request in the milestone numbered `number`,
    /// or with 0 in none, and says so: in its conversation, and as
    /// `demilestoned` from the old one and `milestoned` into the new.
    /// Needs the Triage role.
    pub(crate) async fn set_milestone(&self, actor: &User, repo: &Repo, item: &Item, number: u32) -> Result<Outcome<()>> {
        check!(allowed(Some(actor), repo, Capability::Triage));
        let after = check!(self.milestone_ref(&repo.id, number).await?);
        let before = item.milestone().cloned();
        if before.as_ref().map(|m| m.number) == after.as_ref().map(|m| m.number) {
            return Ok(Outcome::Ok(()));
        }
        self.db
            .prepare(format!("UPDATE {} SET milestone = ?, updated_at = ? WHERE repo_id = ? AND number = ?", item.table()))
            .bind(&[
                crate::optional_number(after.as_ref().map(|m| m.number)),
                rfc3339(now_ms()).into(),
                repo.id.as_str().into(),
                item.number().into(),
            ])?
            .run()
            .await?;
        if let Some(text) = milestone_note(before.as_ref(), after.as_ref()) {
            self.note(&repo.id, item.number(), (&actor.id, &actor.username), &text).await?;
        }
        for (what, milestone) in [("demilestoned", before), ("milestoned", after)] {
            let Some(milestone) = milestone else { continue };
            let milestone = Some(milestone);
            match item {
                Item::Issue(issue) => {
                    self.publish(item.kind(what), &repo.id, actor, IssueEvent { milestone, ..Self::issue_event(issue) })
                        .await?;
                }
                Item::Pull(pull) => {
                    self.publish(item.kind(what), &repo.id, actor, PullEvent { milestone, ..Self::pull_event(pull) })
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
