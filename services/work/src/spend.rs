//! What a person's harness sessions cost in a workspace (`get_spend`),
//! and who may see someone else's (`configure_spend`, `spend_settings`).
//!
//! Everyone sees their own spend in full. Someone else's needs the
//! workspace's [`SpendVisibility`] to allow it, is checked before anything
//! about them is read, and leaves out the repositories (and their work
//! items) the viewer cannot read, though it still counts there. People are
//! listed by name, never ranked by what they spent, and the workspace's
//! total over others shows only to whoever may see each person's, or once
//! it covers [`MIN_ROLLUP_PEOPLE`] people. See rows.sql for how a session's
//! cost is shared out and when it landed.
use std::collections::BTreeSet;

use g1t_contracts::repos::{ReadableArgs, Repo};
use g1t_contracts::time::{parse_rfc3339, rfc3339};
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, Role};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::Work;
use crate::insights::valid_day;
use crate::rows::ValueRow;

const DAY_MS: u64 = 86_400_000;
/// The span when `since` is left out: this many days ending with `until`.
const DEFAULT_DAYS: u64 = 30;
/// `rows` returns at most this many; rows.sql asks for one more.
const ROWS_LIMIT: usize = 5000;

pub(crate) const ROWS: &str = include_str!("spend/rows.sql");

/// ?1 the workspace, ?2 and ?3 the span as rows.sql has it, ?4 the person:
/// how many sessions they started in it, and how many of no known cost.
pub(crate) const TOTALS: &str = "SELECT COUNT(*) AS sessions, COALESCE(SUM(s.cost_usd IS NULL), 0) AS unknown_sessions
   FROM sessions s JOIN repo_workspaces rw ON rw.repo_id = s.repo_id AND rw.workspace = ?1
   WHERE s.actor_id = ?4 AND s.started_at >= ?2 AND s.started_at < ?3";

/// ?1 the workspace, ?2 and ?3 the span: each person with sessions in it,
/// by name.
pub(crate) const PEOPLE: &str = "SELECT s.actor_id AS id, MAX(s.actor_name) AS username, COUNT(*) AS sessions,
     TOTAL(s.cost_usd) AS cost_usd
   FROM sessions s JOIN repo_workspaces rw ON rw.repo_id = s.repo_id AND rw.workspace = ?1
   WHERE s.started_at >= ?2 AND s.started_at < ?3
   GROUP BY s.actor_id ORDER BY lower(MAX(s.actor_name)), s.actor_id LIMIT 1000";

/// ?1 the workspace, ?2 a username: the id of whoever started sessions
/// there under that name, the latest first.
pub(crate) const PERSON: &str = "SELECT s.actor_id AS value
   FROM sessions s JOIN repo_workspaces rw ON rw.repo_id = s.repo_id AND rw.workspace = ?1
   WHERE lower(s.actor_name) = lower(?2) ORDER BY s.started_at DESC LIMIT 1";

pub(crate) const VISIBILITY: &str = "SELECT visibility AS value FROM spend_settings WHERE workspace = ?1";

/// A row of rows.sql, with the repository's id for who may read it.
#[derive(Deserialize)]
struct Row {
    day: String,
    repo_id: String,
    repo: String,
    item: Option<u32>,
    harness: String,
    model: Option<String>,
    landed: u32,
    sessions: u32,
    cost_usd: f64,
}

#[derive(Deserialize)]
struct Totals {
    sessions: u32,
    unknown_sessions: u32,
}

/// The span `a` asks for at `now`: its first and last days, and the bounds
/// rows.sql takes. An error when it is not a valid span.
fn span(since: Option<&str>, until: Option<&str>, now: u64) -> std::result::Result<(String, String, String, String), String> {
    let day = |ms: u64| rfc3339(ms)[..10].to_owned();
    let parse = |value: &str| if valid_day(value) { parse_rfc3339(&format!("{value}T00:00:00Z")) } else { None };
    let until_ms = match until {
        Some(value) => parse(value).ok_or("until is a day, YYYY-MM-DD.")?,
        None => parse(&day(now)).ok_or("today could not be read")?,
    };
    let since_ms = match since {
        Some(value) => parse(value).ok_or("since is a day, YYYY-MM-DD.")?,
        None => until_ms.saturating_sub((DEFAULT_DAYS - 1) * DAY_MS),
    };
    if since_ms > until_ms {
        return Err("since is after until.".into());
    }
    if (until_ms - since_ms) / DAY_MS >= u64::from(MAX_SPEND_DAYS) {
        return Err(format!("A span is at most {MAX_SPEND_DAYS} days."));
    }
    let end = until_ms + DAY_MS;
    Ok((day(since_ms), day(until_ms), format!("{}T00:00:00", day(since_ms)), format!("{}T00:00:00", day(end))))
}

/// Whether a session's actor is a person, as signals counts people.
fn is_person(id: &str) -> bool {
    crate::signals::is_person(id)
}

impl Work {
    /// The workspace's setting: owners when it has none.
    pub(crate) async fn spend_visibility(&self, workspace: &str) -> Result<SpendVisibility> {
        let found = self.db.prepare(VISIBILITY).bind(&[workspace.into()])?.first::<ValueRow>(None).await?;
        Ok(found.and_then(|row| SpendVisibility::parse(&row.value)).unwrap_or_default())
    }

    pub(crate) async fn get_spend(&self, a: GetSpendArgs) -> Result<Outcome<Spend>> {
        let Some(viewer) = a.viewer.as_ref() else {
            return Ok(Outcome::fail(FailureCode::Unauthenticated, "Sign in to see spend."));
        };
        let workspace = a.workspace.trim().to_lowercase();
        if workspace.is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Say which workspace."));
        }
        let (since, until, from, to) = match span(a.since.as_deref(), a.until.as_deref(), now_ms()) {
            Ok(span) => span,
            Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
        };
        let visibility = self.spend_visibility(&workspace).await?;
        let can_see_people = visibility.shows_people_to(viewer, &workspace);
        let asked = a.person.as_deref().map(str::trim).filter(|name| !name.is_empty());
        let own = asked.is_none_or(|name| name.eq_ignore_ascii_case(&viewer.username));
        // Someone else's: refused before anything about them is read.
        if !own && !can_see_people {
            let why = match visibility {
                SpendVisibility::Nobody => "This workspace shows each person only their own spend.",
                _ if viewer.is_member(&workspace) => "Only owners and billing managers see other people's spend in this workspace.",
                _ => "Only the workspace's members can see its spend.",
            };
            return Ok(Outcome::fail(FailureCode::Forbidden, why));
        }
        let person = if own {
            SpendPerson { id: viewer.id.clone(), username: viewer.username.clone(), own: true }
        } else {
            let name = asked.unwrap_or_default();
            let found = self.db.prepare(PERSON).bind(&[workspace.as_str().into(), name.into()])?.first::<ValueRow>(None).await?;
            SpendPerson { id: found.map(|row| row.value).unwrap_or_default(), username: name.to_owned(), own: false }
        };
        let bounds = [workspace.as_str().into(), from.as_str().into(), to.as_str().into(), person.id.as_str().into()];
        let results = self
            .timing
            .db(
                3,
                self.db.batch(vec![
                    self.db.prepare(ROWS).bind(&bounds)?,
                    self.db.prepare(TOTALS).bind(&bounds)?,
                    self.db.prepare(PEOPLE).bind(&bounds[..3])?,
                ]),
            )
            .await?;
        let [rows, totals, people] = results.as_slice() else {
            return Err(worker::Error::RustError("get_spend: missing results".into()));
        };
        let mut rows = rows.results::<Row>()?;
        rows.truncate(ROWS_LIMIT);
        let totals = totals.results::<Totals>()?.into_iter().next().unwrap_or(Totals { sessions: 0, unknown_sessions: 0 });
        // Someone else's: only the repositories the viewer can read are named.
        let readable: Option<BTreeSet<String>> = if own {
            None
        } else {
            let ids: BTreeSet<String> = rows.iter().map(|row| row.repo_id.clone()).collect();
            let found: Vec<Repo> = if ids.is_empty() {
                Vec::new()
            } else {
                g1t_kit::call(&self.repos, "readable", &ReadableArgs { ids: ids.into_iter().collect(), viewer: a.viewer.clone() }).await?
            };
            Some(found.into_iter().map(|repo| repo.id).collect())
        };
        let rows: Vec<SpendRow> = rows
            .into_iter()
            .map(|row| {
                let named = readable.as_ref().is_none_or(|ids| ids.contains(&row.repo_id));
                SpendRow {
                    day: row.day,
                    repo: named.then_some(row.repo),
                    item: if named { row.item } else { None },
                    harness: row.harness,
                    model: row.model,
                    landed: row.landed != 0,
                    sessions: row.sessions,
                    cost_usd: row.cost_usd,
                }
            })
            .collect();
        let cost_usd = rows.iter().map(|row| row.cost_usd).sum();
        let landed_usd = rows.iter().filter(|row| row.landed).map(|row| row.cost_usd).sum();
        let everyone: Vec<PersonSpend> = people.results::<PersonSpend>()?.into_iter().filter(|row| is_person(&row.id)).collect();
        let workspace_people = u32::try_from(everyone.len()).unwrap_or(u32::MAX);
        let members = viewer.is_member(&workspace);
        let workspace_usd = (members && (can_see_people || workspace_people >= MIN_ROLLUP_PEOPLE))
            .then(|| everyone.iter().map(|row| row.cost_usd).sum());
        Ok(Outcome::Ok(Spend {
            workspace,
            person,
            since,
            until,
            cost_usd,
            landed_usd,
            sessions: totals.sessions,
            unknown_sessions: totals.unknown_sessions,
            rows,
            visibility,
            can_see_people,
            people: if can_see_people { everyone } else { Vec::new() },
            workspace_usd,
            workspace_people: if workspace_usd.is_some() { workspace_people } else { 0 },
        }))
    }

    pub(crate) async fn configure_spend(&self, a: ConfigureSpendArgs) -> Result<Outcome<SpendSettings>> {
        let workspace = a.workspace.trim().to_lowercase();
        if a.actor.role_in(&workspace) != Some(Role::Owner) {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only an owner can change who sees each person's spend."));
        }
        self.db
            .prepare(
                "INSERT INTO spend_settings (workspace, visibility, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (workspace) DO UPDATE SET visibility = excluded.visibility, updated_at = excluded.updated_at,
                   updated_by = excluded.updated_by",
            )
            .bind(&[workspace.as_str().into(), a.visibility.as_str().into(), rfc3339(now_ms()).into(), a.actor.id.as_str().into()])?
            .run()
            .await?;
        Ok(Outcome::Ok(SpendSettings { workspace, visibility: a.visibility }))
    }
}

#[cfg(test)]
mod tests;
