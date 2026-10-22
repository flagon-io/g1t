//! Cycles (`g1t_contracts::work::cycles`, migrations/0062_cycles.sql): a
//! workspace's time boxes, and Now as the current one.
//!
//! While a workspace has cycles on it has one open cycle, and every work
//! item in Now is in it (`work_items.cycle_number`): plan.rs puts a work
//! item moved into Now in the current cycle and takes one moved out of Now
//! out of it. A work item in Next may carry the next cycle's number: it is
//! planned into the coming cycle, and moves into Now when the current one
//! closes. The cron (`settle_cycles`) closes each cycle whose last day is
//! over, carries what is still open in it into the next (one
//! `cycle_carries` row each), and opens that one, one cycle at a time and
//! never twice: each step is one batch whose statements do nothing once
//! the cycle is closed.
//!
//! Reading cycles is for whoever may see the workspace's work items
//! (`workspace_visible`); changing the settings needs the right to manage
//! milestones, as the plan's do (`labelled_workspace`); moving a work item
//! into a cycle needs what moving it into Now needs, and is refused to
//! agents.

use g1t_contracts::access::Capability;
use g1t_contracts::events::WorkItemEvent;
use g1t_contracts::rules::is_agent;
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use super::plan::PLAN_ORDER;
use super::rows::{ITEM_COLUMNS, ItemRow, no_item, workspace_of};
use crate::Work;

/// A workspace's cycle settings, `?1` its slug.
const SETTINGS: &str = "SELECT enabled, length_days, starts_weekday, cooldown_days, updated_at FROM cycle_settings WHERE workspace = ?1";

/// A cycle's columns (`c`), with what it holds: the work items in it now
/// (leaving out those closed as not planned), those closed as completed,
/// those carried in and out, and those added after its first day.
const CYCLE_COLUMNS: &str = "c.workspace, c.number, c.starts_on, c.ends_on, c.closed_at,
  (SELECT count(*) FROM work_items w WHERE w.workspace = c.workspace AND w.cycle_number = c.number AND w.number IS NOT NULL
     AND NOT (w.state = 'closed' AND w.reason = 'not_planned')) AS members,
  (SELECT count(*) FROM work_items w WHERE w.workspace = c.workspace AND w.cycle_number = c.number AND w.number IS NOT NULL
     AND w.state = 'closed' AND COALESCE(w.reason, 'completed') = 'completed') AS done,
  (SELECT count(*) FROM cycle_carries k WHERE k.workspace = c.workspace AND k.cycle_number = c.number - 1) AS carried_in,
  (SELECT count(*) FROM cycle_carries k WHERE k.workspace = c.workspace AND k.cycle_number = c.number) AS carried_out,
  (SELECT count(*) FROM work_items w WHERE w.workspace = c.workspace AND w.number IS NOT NULL
     AND (w.cycle_number = c.number
          OR EXISTS (SELECT 1 FROM cycle_carries k WHERE k.workspace = c.workspace AND k.cycle_number = c.number AND k.item_number = w.number))
     AND NOT (w.cycle_number = c.number AND w.state = 'closed' AND w.reason = 'not_planned')
     AND substr(w.cycle_added_at, 1, 10) > c.starts_on AND substr(w.cycle_added_at, 1, 10) <= c.ends_on) AS added";

/// The open cycle of workspace `?1`, whether or not cycles are on.
const OPEN_CYCLE: &str = "SELECT {CYCLE_COLUMNS} FROM cycles c WHERE c.workspace = ?1 AND c.closed_at IS NULL";

/// The current cycle of workspace `?1`: its open cycle while cycles are on.
pub(crate) const CURRENT_CYCLE: &str = "SELECT {CYCLE_COLUMNS} FROM cycles c
   JOIN cycle_settings s ON s.workspace = c.workspace AND s.enabled = 1
   WHERE c.workspace = ?1 AND c.closed_at IS NULL";

/// The cycle of workspace `?1` numbered `?2`.
const CYCLE_BY_NUMBER: &str = "SELECT {CYCLE_COLUMNS} FROM cycles c WHERE c.workspace = ?1 AND c.number = ?2";

/// Workspace `?1`'s closed cycles, the latest first, at most `?2`.
const PAST: &str = "SELECT {CYCLE_COLUMNS} FROM cycles c WHERE c.workspace = ?1 AND c.closed_at IS NOT NULL ORDER BY c.number DESC LIMIT ?2";

/// Whether work item `w` belongs to cycle `?2` of workspace `?1`: it is in
/// it, or the cycle carried it out.
const MEMBER: &str = "w.workspace = ?1 AND w.number IS NOT NULL
   AND (w.cycle_number = ?2 OR EXISTS (SELECT 1 FROM cycle_carries k WHERE k.workspace = ?1 AND k.cycle_number = ?2 AND k.item_number = w.number))";

/// Cycle `?2`'s work items: open ones in the plan's order, then closed
/// ones, the latest closed first.
const ITEMS: &str = "SELECT {ITEM_COLUMNS} FROM work_items
   WHERE work_items.id IN (SELECT w.id FROM work_items w WHERE {MEMBER})
   ORDER BY work_items.state = 'closed', CASE WHEN work_items.state = 'closed' THEN work_items.closed_at END DESC, {PLAN_ORDER}
   LIMIT {LIMIT}";

/// What cycle `?2` says of each of its work items, `?3` now (RFC 3339):
/// when it joined, whether it was carried in or out, whether someone is on
/// it, and its own pull requests by status.
const MEMBERS: &str = "SELECT w.number, w.cycle_added_at AS added_at, w.cycle_number = ?2 AS current_member,
   (SELECT c.starts_on FROM cycles c WHERE c.workspace = ?1 AND c.number = ?2) AS starts_on,
   EXISTS (SELECT 1 FROM cycle_carries k WHERE k.workspace = ?1 AND k.cycle_number = ?2 - 1 AND k.item_number = w.number) AS carried_in,
   EXISTS (SELECT 1 FROM cycle_carries k WHERE k.workspace = ?1 AND k.cycle_number = ?2 AND k.item_number = w.number) AS carried_out,
   EXISTS (SELECT 1 FROM claims cl WHERE cl.item_id = w.id AND cl.state = 'active' AND cl.expires_at > ?3) AS claimed,
   EXISTS (SELECT 1 FROM sessions s WHERE s.item_id = w.id AND s.state = 'active') AS live,
   (SELECT p.agent FROM pulls p WHERE p.item_id = w.id AND p.fork_repo_id IS NOT NULL ORDER BY p.created_at DESC LIMIT 1) AS agent,
   (SELECT count(*) FROM pulls p WHERE p.item_id = w.id AND p.status = 'draft') AS draft_pulls,
   (SELECT count(*) FROM pulls p WHERE p.item_id = w.id AND p.status = 'open') AS open_pulls,
   (SELECT count(*) FROM pulls p WHERE p.item_id = w.id AND p.status = 'merged') AS merged_pulls
 FROM work_items w WHERE {MEMBER}";

/// The work items in Next planned into the cycle after `?2`, in rank order.
const PLANNED: &str = "SELECT {ITEM_COLUMNS} FROM work_items
   WHERE work_items.workspace = ?1 AND work_items.state = 'open' AND work_items.number IS NOT NULL
     AND work_items.horizon = 'next' AND work_items.cycle_number = ?2 + 1
   ORDER BY {PLAN_ORDER} LIMIT 100";

// --- Rolling over -------------------------------------------------------------
//
// Closing cycle `?2` of workspace `?1` at `?3` (RFC 3339), one batch in
// this order. Each statement before the close does something only while
// the cycle is open, and the next cycle is opened once, so running the
// batch again, or two runs at once, changes nothing more.

/// Whether cycle `?2` of `?1` is still open.
const STILL_OPEN: &str = "EXISTS (SELECT 1 FROM cycles c WHERE c.workspace = ?1 AND c.number = ?2 AND c.closed_at IS NULL)";

/// Records each work item still open in Now in the cycle as carried.
pub(crate) const CARRY: &str = "INSERT OR IGNORE INTO cycle_carries (workspace, cycle_number, item_number, carried_at)
   SELECT ?1, ?2, w.number, ?3 FROM work_items w
   WHERE w.workspace = ?1 AND w.cycle_number = ?2 AND w.state = 'open' AND w.number IS NOT NULL
     AND COALESCE(w.horizon, 'triage') = 'now' AND {STILL_OPEN}";

/// Moves them into the next cycle; they stay in Now, keeping when they
/// first joined.
pub(crate) const ROLL: &str = "UPDATE work_items SET cycle_number = ?2 + 1
   WHERE workspace = ?1 AND cycle_number = ?2 AND state = 'open' AND COALESCE(horizon, 'triage') = 'now' AND {STILL_OPEN}";

/// Takes the cycle off any open work item no longer in Now.
pub(crate) const STRAYS: &str = "UPDATE work_items SET cycle_number = NULL, cycle_added_at = NULL
   WHERE workspace = ?1 AND cycle_number = ?2 AND state = 'open' AND COALESCE(horizon, 'triage') <> 'now' AND {STILL_OPEN}";

/// Moves one work item planned into the next cycle from Next into Now:
/// `?4` its id, `?5` its rank in Now, `?6` when it joins (the next cycle's
/// first day, so it counts as planned, not added).
pub(crate) const PULL_PLANNED: &str = "UPDATE work_items SET horizon = 'now', rank = ?5, planned_at = ?3, cycle_added_at = ?6
   WHERE workspace = ?1 AND id = ?4 AND state = 'open' AND horizon = 'next' AND cycle_number = ?2 + 1 AND {STILL_OPEN}";

/// Closes the cycle.
pub(crate) const CLOSE: &str = "UPDATE cycles SET closed_at = ?3 WHERE workspace = ?1 AND number = ?2 AND closed_at IS NULL";

/// Opens the next one, `?4` to `?5`.
pub(crate) const OPEN_NEXT: &str =
    "INSERT OR IGNORE INTO cycles (workspace, number, starts_on, ends_on, opened_at) VALUES (?1, ?2 + 1, ?4, ?5, ?3)";

/// The open cycles of workspaces with cycles on whose last day is before
/// `?1` (today), with their settings.
const DUE: &str = "SELECT c.workspace, c.number, c.ends_on, s.length_days, s.starts_weekday, s.cooldown_days
   FROM cycles c JOIN cycle_settings s ON s.workspace = c.workspace AND s.enabled = 1
   WHERE c.closed_at IS NULL AND c.ends_on < ?1 ORDER BY c.ends_on LIMIT 50";

/// Workspaces with cycles on and no open cycle, which the cron opens one
/// for (none should be: turning cycles on opens one).
const WITHOUT_OPEN: &str = "SELECT s.workspace FROM cycle_settings s
   WHERE s.enabled = 1 AND NOT EXISTS (SELECT 1 FROM cycles c WHERE c.workspace = s.workspace AND c.closed_at IS NULL) LIMIT 20";

// --- Turning cycles on and off --------------------------------------------------

/// Opens workspace `?1`'s first cycle (after any it had), `?2` to `?3`, at
/// `?4`, unless one is open.
pub(crate) const OPEN_FIRST: &str = "INSERT INTO cycles (workspace, number, starts_on, ends_on, opened_at)
   SELECT ?1, next, ?2, ?3, ?4 FROM (SELECT COALESCE(max(number), 0) + 1 AS next FROM cycles WHERE workspace = ?1)
   WHERE NOT EXISTS (SELECT 1 FROM cycles WHERE workspace = ?1 AND closed_at IS NULL)";

/// Puts everything open in workspace `?1`'s Now in its open cycle, as if
/// there from its first day (`?2`, RFC 3339).
pub(crate) const NOW_JOINS: &str = "UPDATE work_items
   SET cycle_number = (SELECT number FROM cycles WHERE workspace = ?1 AND closed_at IS NULL), cycle_added_at = ?2
   WHERE workspace = ?1 AND state = 'open' AND number IS NOT NULL AND COALESCE(horizon, 'triage') = 'now'";

/// Takes the cycle off every open work item of workspace `?1` outside Now
/// (planned into a cycle that is no more).
pub(crate) const UNPLAN_REST: &str = "UPDATE work_items SET cycle_number = NULL, cycle_added_at = NULL
   WHERE workspace = ?1 AND state = 'open' AND cycle_number IS NOT NULL AND COALESCE(horizon, 'triage') <> 'now'";

/// Turning cycles off: the open work items of workspace `?1`'s open cycle
/// leave it (the closed ones keep it, for its report).
pub(crate) const LEAVE_OPEN: &str = "UPDATE work_items SET cycle_number = NULL, cycle_added_at = NULL
   WHERE workspace = ?1 AND state = 'open' AND cycle_number IS NOT NULL";

/// Turning cycles off: closes workspace `?1`'s open cycle at `?2`.
pub(crate) const CLOSE_OPEN: &str = "UPDATE cycles SET closed_at = ?2 WHERE workspace = ?1 AND closed_at IS NULL";

/// Reopened in Now (`?1` its id, `?2` now): it joins the current cycle when
/// the cycle it was in is over.
pub(crate) const REJOIN: &str = "UPDATE work_items
   SET cycle_number = (SELECT c.number FROM cycles c JOIN cycle_settings s ON s.workspace = c.workspace AND s.enabled = 1
                       WHERE c.workspace = work_items.workspace AND c.closed_at IS NULL),
       cycle_added_at = ?2
   WHERE id = ?1 AND COALESCE(horizon, 'triage') = 'now'
     AND cycle_number IS NOT (SELECT c.number FROM cycles c JOIN cycle_settings s ON s.workspace = c.workspace AND s.enabled = 1
                              WHERE c.workspace = work_items.workspace AND c.closed_at IS NULL)";

// --- Workspaces and accounts --------------------------------------------------

/// A workspace renamed (`g1t_kit::rename`, `?1` its slug now, `?2` before):
/// its cycles follow.
pub(crate) const RENAMED: &[&str] = &[
    "UPDATE OR IGNORE cycle_settings SET workspace = ?1 WHERE workspace = ?2",
    "UPDATE OR IGNORE cycles SET workspace = ?1 WHERE workspace = ?2",
    "UPDATE OR IGNORE cycle_carries SET workspace = ?1 WHERE workspace = ?2",
];

/// A workspace deleted (`?1` its slug): its cycles go.
pub(crate) const DELETED: &[&str] = &[
    "DELETE FROM cycle_carries WHERE workspace = ?1",
    "DELETE FROM cycles WHERE workspace = ?1",
    "DELETE FROM cycle_settings WHERE workspace = ?1",
];

/// An account purged (ghost.rs, `?1` its id): who last changed the
/// settings shows as ghost.
pub(crate) fn user_deleted() -> Vec<String> {
    use g1t_contracts::account_deletion::GHOST_ID;
    vec![format!("UPDATE cycle_settings SET updated_by = '{GHOST_ID}' WHERE updated_by = ?1")]
}

// --- Rows ------------------------------------------------------------------------

#[derive(Deserialize)]
struct SettingsRow {
    #[serde(default)]
    enabled: u8,
    length_days: u32,
    starts_weekday: u32,
    #[serde(default)]
    cooldown_days: u32,
    #[serde(default)]
    updated_at: Option<String>,
}

impl From<SettingsRow> for CycleSettings {
    fn from(row: SettingsRow) -> Self {
        CycleSettings {
            enabled: row.enabled != 0,
            length_days: row.length_days,
            starts_weekday: row.starts_weekday,
            cooldown_days: row.cooldown_days,
            updated_at: row.updated_at,
        }
    }
}

#[derive(Deserialize)]
pub(crate) struct CycleRow {
    workspace: String,
    number: u32,
    starts_on: String,
    ends_on: String,
    #[serde(default)]
    closed_at: Option<String>,
    #[serde(default)]
    members: u32,
    #[serde(default)]
    done: u32,
    #[serde(default)]
    carried_in: u32,
    #[serde(default)]
    carried_out: u32,
    #[serde(default)]
    added: u32,
}

impl CycleRow {
    /// The cycle, as it stands on `today`.
    pub(crate) fn cycle(self, today: &str) -> Cycle {
        Cycle {
            state: CycleState::of(&self.starts_on, self.closed_at.is_some(), today),
            workspace: self.workspace,
            number: self.number,
            starts_on: self.starts_on,
            ends_on: self.ends_on,
            closed_at: self.closed_at,
            // What it carried out is no longer in it, and was in its scope.
            scope: self.members + self.carried_out,
            done: self.done,
            carried_in: self.carried_in,
            carried_out: self.carried_out,
            added: self.added,
        }
    }
}

#[derive(Deserialize)]
struct MemberRow {
    number: u32,
    #[serde(default)]
    added_at: Option<String>,
    #[serde(default)]
    starts_on: Option<String>,
    #[serde(default)]
    carried_in: u8,
    #[serde(default)]
    carried_out: u8,
    #[serde(default)]
    claimed: u8,
    #[serde(default)]
    live: u8,
    #[serde(default)]
    agent: Option<String>,
    #[serde(default)]
    draft_pulls: u32,
    #[serde(default)]
    open_pulls: u32,
    #[serde(default)]
    merged_pulls: u32,
}

impl From<MemberRow> for CycleMember {
    fn from(row: MemberRow) -> Self {
        let added = match (&row.added_at, &row.starts_on) {
            (Some(at), Some(start)) => at.get(..10).is_some_and(|day| day > start.as_str()),
            _ => false,
        };
        CycleMember {
            number: row.number,
            added_at: row.added_at,
            added,
            carried_in: row.carried_in != 0,
            carried_out: row.carried_out != 0,
            claimed: row.claimed != 0,
            live: row.live != 0,
            agent: row.agent.filter(|agent| !agent.is_empty()),
            draft_pulls: row.draft_pulls,
            open_pulls: row.open_pulls,
            merged_pulls: row.merged_pulls,
        }
    }
}

#[derive(Deserialize)]
struct DueRow {
    workspace: String,
    number: u32,
    ends_on: String,
    length_days: u32,
    starts_weekday: u32,
    #[serde(default)]
    cooldown_days: u32,
}

/// One cycle to close: its number, and the days of the one it opens.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Rollover {
    pub closing: u32,
    pub starts_on: String,
    pub ends_on: String,
}

/// The cycles to close, in order, when the open one is `number`, ending
/// on `ends_on`, and it is `today`: each whose last day is before today,
/// the ones a late cron missed included, at most `max`.
pub(crate) fn rollovers(number: u32, ends_on: &str, settings: &CycleSettings, today: &str, max: u32) -> Vec<Rollover> {
    let mut steps = Vec::new();
    let (mut number, mut ends_on) = (number, ends_on.to_owned());
    while ends_on.as_str() < today && steps.len() < max as usize {
        let (starts, ends) = following_cycle(&ends_on, settings);
        steps.push(Rollover { closing: number, starts_on: starts, ends_on: ends.clone() });
        number += 1;
        ends_on = ends;
    }
    steps
}

/// The first day of a workspace's first cycle when it turns cycles on
/// `today`, after the cycle it last closed (on `last_closed`, a day) if
/// that was this week.
pub(crate) fn first_start(today: &str, weekday: u32, last_closed: Option<&str>) -> String {
    let start = first_cycle_start(today, weekday);
    match last_closed {
        Some(closed) if closed > start.as_str() => closed.min(today).to_owned(),
        _ => start,
    }
}

/// Today, `YYYY-MM-DD` in UTC.
fn today(now: u64) -> String {
    rfc3339(now)[..10].to_owned()
}

/// What a move into or out of a cycle says in the work item's
/// conversation.
pub(crate) fn cycle_note(before: Option<u32>, after: Option<u32>) -> Option<String> {
    match (before, after) {
        (Some(old), Some(new)) if old == new => None,
        (Some(old), Some(new)) => Some(format!("moved this from Cycle {old} to Cycle {new}")),
        (None, Some(new)) => Some(format!("planned this into Cycle {new}")),
        (Some(old), None) => Some(format!("took this out of Cycle {old}")),
        (None, None) => None,
    }
}

fn off<T>(workspace: &str) -> Outcome<T> {
    Outcome::fail(FailureCode::Conflict, format!("Cycles are off in {workspace}. Turn them on in Work's settings."))
}

impl Work {
    /// A workspace's cycle settings, the defaults when it has none.
    pub(crate) async fn cycle_settings(&self, workspace: &str) -> Result<CycleSettings> {
        Ok(self.db.prepare(SETTINGS).bind(&[workspace.into()])?.first::<SettingsRow>(None).await?.map_or_else(CycleSettings::default, CycleSettings::from))
    }

    /// The number of a workspace's current cycle: none while cycles are off.
    pub(crate) async fn current_cycle_number(&self, workspace: &str) -> Result<Option<u32>> {
        #[derive(Deserialize)]
        struct Number {
            number: u32,
        }
        Ok(self
            .db
            .prepare(
                "SELECT c.number FROM cycles c JOIN cycle_settings s ON s.workspace = c.workspace AND s.enabled = 1
                 WHERE c.workspace = ?1 AND c.closed_at IS NULL",
            )
            .bind(&[workspace.into()])?
            .first::<Number>(None)
            .await?
            .map(|row| row.number))
    }

    /// A statement reading a workspace's current cycle, for a batch (plan.rs).
    pub(crate) fn current_cycle_statement(&self, workspace: &str) -> Result<worker::D1PreparedStatement> {
        self.db.prepare(CURRENT_CYCLE.replace("{CYCLE_COLUMNS}", CYCLE_COLUMNS)).bind(&[workspace.into()])
    }

    async fn cycle_row(&self, sql: &str, values: &[JsValue]) -> Result<Option<CycleRow>> {
        self.db.prepare(sql.replace("{CYCLE_COLUMNS}", CYCLE_COLUMNS)).bind(values)?.first::<CycleRow>(None).await
    }

    // --- RPC methods ----------------------------------------------------------

    pub(crate) async fn list_cycles(&self, a: ListCyclesArgs) -> Result<Outcome<Cycles>> {
        let workspace = workspace_of(&a.workspace, None);
        if !self.workspace_visible(&a.viewer, &workspace).await? {
            return Ok(Outcome::fail(FailureCode::NotFound, "Workspace not found."));
        }
        Ok(Outcome::Ok(self.cycles_of(&workspace, a.limit.unwrap_or(CYCLES_LISTED).min(MAX_CYCLES_LISTED)).await?))
    }

    /// A workspace's settings, current cycle, the next one's days and its
    /// last `limit` closed cycles.
    async fn cycles_of(&self, workspace: &str, limit: u32) -> Result<Cycles> {
        let key = [JsValue::from(workspace)];
        let mut statements = vec![
            self.db.prepare(SETTINGS).bind(&key)?,
            self.db.prepare(OPEN_CYCLE.replace("{CYCLE_COLUMNS}", CYCLE_COLUMNS)).bind(&key)?,
        ];
        if limit > 0 {
            statements.push(self.db.prepare(PAST.replace("{CYCLE_COLUMNS}", CYCLE_COLUMNS)).bind(&[workspace.into(), limit.into()])?);
        }
        let results = self.timing.db(statements.len() as u32, self.db.batch(statements)).await?;
        let rows = |index: usize| results.get(index).ok_or_else(|| worker::Error::RustError("short batch".into()));
        let settings = rows(0)?.results::<SettingsRow>()?.into_iter().next().map_or_else(CycleSettings::default, CycleSettings::from);
        let today = today(now_ms());
        let current = if settings.enabled { rows(1)?.results::<CycleRow>()?.into_iter().next().map(|row| row.cycle(&today)) } else { None };
        let past = if limit > 0 { rows(2)?.results::<CycleRow>()?.into_iter().map(|row| row.cycle(&today)).collect() } else { Vec::new() };
        let next = current.as_ref().map(|cycle| {
            let (starts_on, ends_on) = following_cycle(&cycle.ends_on, &settings);
            CycleDates { number: cycle.number + 1, starts_on, ends_on }
        });
        Ok(Cycles { workspace: workspace.to_owned(), settings, current, next, past })
    }

    /// A cycle and its report: its work items the viewer may see, what the
    /// cycle says of each, and for the current one what is planned into the
    /// next.
    pub(crate) async fn get_cycle(&self, a: GetCycleArgs) -> Result<Outcome<CycleDetail>> {
        let workspace = workspace_of(&a.workspace, None);
        if !self.workspace_visible(&a.viewer, &workspace).await? {
            return Ok(Outcome::fail(FailureCode::NotFound, "Workspace not found."));
        }
        let settings = self.cycle_settings(&workspace).await?;
        let found = match a.number {
            Some(number) => self.cycle_row(CYCLE_BY_NUMBER, &[workspace.as_str().into(), number.into()]).await?,
            None if settings.enabled => self.cycle_row(OPEN_CYCLE, &[workspace.as_str().into()]).await?,
            None => return Ok(off(&workspace)),
        };
        let now = now_ms();
        let today = today(now);
        let Some(cycle) = found.map(|row| row.cycle(&today)) else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Cycle not found."));
        };
        let current = settings.enabled && cycle.state != CycleState::Closed;
        let values = [JsValue::from(workspace.as_str()), JsValue::from(cycle.number), JsValue::from(rfc3339(now))];
        let items_sql = ITEMS
            .replace("{ITEM_COLUMNS}", ITEM_COLUMNS)
            .replace("{MEMBER}", MEMBER)
            .replace("{PLAN_ORDER}", PLAN_ORDER)
            .replace("{LIMIT}", &MAX_CYCLE_ITEMS.to_string());
        let mut statements = vec![
            self.db.prepare(items_sql).bind(&values[..2])?,
            self.db.prepare(MEMBERS.replace("{MEMBER}", MEMBER)).bind(&values)?,
        ];
        if current {
            statements.push(self.db.prepare(PLANNED.replace("{ITEM_COLUMNS}", ITEM_COLUMNS).replace("{PLAN_ORDER}", PLAN_ORDER)).bind(&values[..2])?);
        }
        let results = self.timing.db(statements.len() as u32, self.db.batch(statements)).await?;
        let rows = |index: usize| results.get(index).ok_or_else(|| worker::Error::RustError("short batch".into()));
        let viewer = a.viewer.as_ref();
        let items: Vec<WorkItem> = rows(0)?
            .results::<ItemRow>()?
            .into_iter()
            .filter_map(ItemRow::held)
            .filter(|held| held.may(viewer, Capability::Read))
            .map(|held| held.shown(viewer))
            .collect();
        let mut facts: Vec<MemberRow> = rows(1)?.results::<MemberRow>()?;
        let members = items
            .iter()
            .map(|item| match facts.iter().position(|row| row.number == item.number) {
                Some(at) => CycleMember::from(facts.swap_remove(at)),
                None => CycleMember { number: item.number, ..CycleMember::default() },
            })
            .collect();
        let planned = if current {
            rows(2)?
                .results::<ItemRow>()?
                .into_iter()
                .filter_map(ItemRow::held)
                .filter(|held| held.may(viewer, Capability::Read))
                .map(|held| held.shown(viewer))
                .collect()
        } else {
            Vec::new()
        };
        let next = current.then(|| {
            let (starts_on, ends_on) = following_cycle(&cycle.ends_on, &settings);
            CycleDates { number: cycle.number + 1, starts_on, ends_on }
        });
        Ok(Outcome::Ok(CycleDetail { cycle, settings, items, members, planned, next }))
    }

    pub(crate) async fn configure_cycles(&self, a: ConfigureCyclesArgs) -> Result<Outcome<Cycles>> {
        let workspace = check!(self.labelled_workspace(&a.actor, &a.workspace).await?);
        let before = self.cycle_settings(&workspace).await?;
        let settings = CycleSettings {
            enabled: a.enabled.unwrap_or(before.enabled),
            length_days: a.length_days.unwrap_or(before.length_days),
            starts_weekday: a.starts_weekday.unwrap_or(before.starts_weekday),
            cooldown_days: a.cooldown_days.unwrap_or(before.cooldown_days),
            updated_at: before.updated_at.clone(),
        };
        if let Err(message) = check_cycle_settings(&settings) {
            return Ok(Outcome::fail(FailureCode::Invalid, message));
        }
        let now = now_ms();
        let at = rfc3339(now);
        let key = [JsValue::from(workspace.as_str())];
        let mut statements = vec![self
            .db
            .prepare(
                "INSERT INTO cycle_settings (workspace, enabled, length_days, starts_weekday, cooldown_days, updated_at, updated_by)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT (workspace) DO UPDATE SET enabled = excluded.enabled, length_days = excluded.length_days,
                   starts_weekday = excluded.starts_weekday, cooldown_days = excluded.cooldown_days,
                   updated_at = excluded.updated_at, updated_by = excluded.updated_by",
            )
            .bind(&[
                workspace.as_str().into(),
                u32::from(settings.enabled).into(),
                settings.length_days.into(),
                settings.starts_weekday.into(),
                settings.cooldown_days.into(),
                at.as_str().into(),
                a.actor.id.as_str().into(),
            ])?];
        match (before.enabled, settings.enabled) {
            (false, true) => statements.extend(self.open_first_statements(&workspace, &settings, now).await?),
            (true, false) => {
                statements.push(self.db.prepare(LEAVE_OPEN).bind(&key)?);
                statements.push(self.db.prepare(CLOSE_OPEN).bind(&[workspace.as_str().into(), at.as_str().into()])?);
            }
            _ => {}
        }
        self.db.batch(statements).await?;
        Ok(Outcome::Ok(self.cycles_of(&workspace, 0).await?))
    }

    /// The statements that open a workspace's first cycle (after any it
    /// had) with everything in Now in it.
    async fn open_first_statements(&self, workspace: &str, settings: &CycleSettings, now: u64) -> Result<Vec<worker::D1PreparedStatement>> {
        #[derive(Deserialize)]
        struct Closed {
            closed_at: Option<String>,
        }
        let last = self
            .db
            .prepare("SELECT closed_at FROM cycles WHERE workspace = ?1 ORDER BY number DESC LIMIT 1")
            .bind(&[workspace.into()])?
            .first::<Closed>(None)
            .await?
            .and_then(|row| row.closed_at);
        let today = today(now);
        let starts_on = first_start(&today, settings.starts_weekday, last.as_deref().and_then(|at| at.get(..10)));
        let ends_on = cycle_end(&starts_on, settings.length_days);
        let at = rfc3339(now);
        let joined = format!("{starts_on}T00:00:00.000Z");
        Ok(vec![
            self.db.prepare(OPEN_FIRST).bind(&[workspace.into(), starts_on.as_str().into(), ends_on.as_str().into(), at.as_str().into()])?,
            self.db.prepare(NOW_JOINS).bind(&[workspace.into(), joined.as_str().into()])?,
            self.db.prepare(UNPLAN_REST).bind(&[workspace.into()])?,
        ])
    }

    pub(crate) async fn cycle_work_item(&self, a: CycleWorkItemArgs) -> Result<Outcome<WorkItem>> {
        let workspace = a.workspace.trim().to_lowercase();
        let held = check!(self.item_for(&Some(a.actor.clone()), &workspace, a.number, Capability::Read).await?);
        if held.item.state == State::Closed {
            return Ok(Outcome::fail(FailureCode::Conflict, "This work item is closed, so it is in no cycle now. Reopen it first."));
        }
        let Some(current) = self.current_cycle_number(&workspace).await? else {
            return Ok(off(&workspace));
        };
        if a.cycle != CycleChoice::None && is_agent(&a.actor) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Agents can't commit a cycle: a person decides what goes into one. A work item an agent files waits in Triage.",
            ));
        }
        if !g1t_contracts::access::can_item(Some(&a.actor), &workspace, None, Capability::ManageLabels) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                format!(
                    "Deciding what is in a cycle takes the right to manage milestones. {}",
                    g1t_contracts::access::needs_on_item(Capability::ManageLabels, &workspace)
                ),
            ));
        }
        let plan = |horizon: Horizon, top: bool| PlanWorkItemArgs {
            actor: a.actor.clone(),
            workspace: workspace.clone(),
            number: a.number,
            horizon: Some(horizon),
            top,
            ..PlanWorkItemArgs::default()
        };
        let in_now = held.item.horizon == Horizon::Now;
        let coming = current + 1;
        match a.cycle {
            // Now is the current cycle: plan.rs puts it in.
            CycleChoice::Current => return self.plan_work_item(plan(Horizon::Now, false)).await,
            CycleChoice::None if in_now => return self.plan_work_item(plan(Horizon::Next, true)).await,
            CycleChoice::None if held.item.cycle.is_none() => return Ok(Outcome::Ok(held.shown(Some(&a.actor)))),
            CycleChoice::Next if held.item.horizon == Horizon::Next && held.item.cycle == Some(coming) => {
                return Ok(Outcome::Ok(held.shown(Some(&a.actor))));
            }
            _ => {}
        }
        // Into Next first (from Now, at its top: it was in the cycle), then
        // planned into the coming cycle, or out of it.
        if held.item.horizon != Horizon::Next {
            check!(self.plan_work_item(plan(Horizon::Next, in_now)).await?);
        }
        let after = (a.cycle == CycleChoice::Next).then_some(coming);
        let at = rfc3339(now_ms());
        self.db
            .prepare("UPDATE work_items SET cycle_number = ?2, cycle_added_at = ?3, updated_at = ?4 WHERE id = ?1 AND state = 'open'")
            .bind(&[
                held.item.id.as_str().into(),
                after.map_or(JsValue::NULL, JsValue::from),
                after.map_or(JsValue::NULL, |_| JsValue::from(at.as_str())),
                at.as_str().into(),
            ])?
            .run()
            .await?;
        let Some(moved) = self.item_by_id(&held.item.id).await? else {
            return Ok(no_item());
        };
        let before = if in_now { None } else { held.item.cycle };
        if let Some(note) = cycle_note(before, after) {
            self.note_item(&moved.item.id, &a.actor, &note).await?;
        }
        self.publish_item(
            "work_item.planned",
            &moved,
            Some(&a.actor),
            WorkItemEvent { horizon: Some(moved.item.horizon), appetite: moved.item.appetite, urgent: Some(moved.item.urgent), ..Self::item_event(&moved) },
        )
        .await?;
        Ok(Outcome::Ok(moved.shown(Some(&a.actor))))
    }

    // --- The cron ---------------------------------------------------------------

    /// One run of the cycles' upkeep: opens a cycle for any workspace with
    /// cycles on and none open, then closes every cycle whose last day is
    /// over, oldest first, carrying what is open into the next.
    pub(crate) async fn settle_cycles(&self) -> Result<()> {
        let now = now_ms();
        let today = today(now);
        #[derive(Deserialize)]
        struct Workspace {
            workspace: String,
        }
        let unopened = self.db.prepare(WITHOUT_OPEN).bind(&[])?.all().await?.results::<Workspace>()?;
        for row in unopened {
            let settings = self.cycle_settings(&row.workspace).await?;
            self.db.batch(self.open_first_statements(&row.workspace, &settings, now).await?).await?;
        }
        let due = self.db.prepare(DUE).bind(&[today.as_str().into()])?.all().await?.results::<DueRow>()?;
        for row in due {
            let settings = CycleSettings {
                enabled: true,
                length_days: row.length_days,
                starts_weekday: row.starts_weekday,
                cooldown_days: row.cooldown_days,
                updated_at: None,
            };
            for step in rollovers(row.number, &row.ends_on, &settings, &today, MAX_ROLLOVERS_PER_RUN) {
                if let Err(error) = self.roll_over(&row.workspace, &step, now).await {
                    // The next run picks it up where this one stopped.
                    worker::console_error!("{}: closing cycle {}: {error}", row.workspace, step.closing);
                    break;
                }
            }
        }
        Ok(())
    }

    /// Closes one cycle, carries what is open in it into the next, moves
    /// what was planned into the next from Next into Now, and opens it.
    async fn roll_over(&self, workspace: &str, step: &Rollover, now: u64) -> Result<()> {
        #[derive(Deserialize)]
        struct Planned {
            id: String,
        }
        #[derive(Deserialize)]
        struct Last {
            rank: Option<String>,
        }
        let at = rfc3339(now);
        let base = [JsValue::from(workspace), JsValue::from(step.closing), JsValue::from(at.as_str())];
        let planned = self
            .db
            .prepare(format!(
                "SELECT work_items.id FROM work_items WHERE work_items.workspace = ?1 AND work_items.state = 'open'
                   AND work_items.horizon = 'next' AND work_items.cycle_number = ?2 + 1 ORDER BY {PLAN_ORDER}"
            ))
            .bind(&base[..2])?
            .all()
            .await?
            .results::<Planned>()?;
        let mut last = self
            .db
            .prepare("SELECT max(rank) AS rank FROM work_items WHERE workspace = ?1 AND state = 'open' AND horizon = 'now' AND rank IS NOT NULL")
            .bind(&base[..1])?
            .first::<Last>(None)
            .await?
            .and_then(|row| row.rank);
        let joined = format!("{}T00:00:00.000Z", step.starts_on);
        let still = |sql: &str| sql.replace("{STILL_OPEN}", STILL_OPEN);
        let mut statements = vec![
            self.db.prepare(still(CARRY)).bind(&base)?,
            self.db.prepare(still(ROLL)).bind(&base[..2])?,
            self.db.prepare(still(STRAYS)).bind(&base[..2])?,
        ];
        for item in &planned {
            let rank = rank_between(last.as_deref(), None);
            statements.push(self.db.prepare(still(PULL_PLANNED)).bind(&[
                base[0].clone(),
                base[1].clone(),
                base[2].clone(),
                item.id.as_str().into(),
                rank.as_str().into(),
                joined.as_str().into(),
            ])?);
            last = Some(rank);
        }
        statements.push(self.db.prepare(CLOSE).bind(&base)?);
        statements.push(self.db.prepare(OPEN_NEXT).bind(&[
            base[0].clone(),
            base[1].clone(),
            base[2].clone(),
            step.starts_on.as_str().into(),
            step.ends_on.as_str().into(),
        ])?);
        self.db.batch(statements).await?;
        // What moved into Now is said, so pages showing the plan refresh.
        for item in planned {
            let Some(held) = self.item_by_id(&item.id).await? else {
                continue;
            };
            if held.item.horizon != Horizon::Now {
                continue;
            }
            self.publish_item(
                "work_item.planned",
                &held,
                None,
                WorkItemEvent {
                    horizon: Some(Horizon::Now),
                    from_horizon: Some(Horizon::Next),
                    appetite: held.item.appetite,
                    urgent: Some(held.item.urgent),
                    ..Self::item_event(&held)
                },
            )
            .await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::{Connection, params};

    use super::*;
    use crate::migrated::database;

    /// acme with cycles on (two weeks from Mondays), cycle 1 from
    /// 2026-10-05 to 2026-10-18 open, and work items: #1 and #2 open in Now
    /// in it, #3 closed in it, #4 in Next planned into cycle 2, #5 in Next
    /// unplanned, #6 open in Now of another workspace.
    fn acme() -> Connection {
        let db = database();
        db.execute_batch(
            "INSERT INTO cycle_settings (workspace, enabled, length_days, starts_weekday, cooldown_days, updated_at)
               VALUES ('acme', 1, 14, 1, 0, ''), ('globex', 1, 14, 1, 0, '');
             INSERT INTO cycles (workspace, number, starts_on, ends_on, opened_at)
               VALUES ('acme', 1, '2026-10-05', '2026-10-18', ''), ('globex', 3, '2026-10-05', '2026-10-18', '');
             INSERT INTO work_items (id, workspace, number, title, body, labels, author_id, author_name, created_at, updated_at,
                                     state, reason, horizon, rank, cycle_number, cycle_added_at)
             VALUES ('wki_1', 'acme', 1, 'One', '', '[]', 'usr_1', 'ana', '', '', 'open', NULL, 'now', 'a', 1, '2026-10-05T00:00:00.000Z'),
                    ('wki_2', 'acme', 2, 'Two', '', '[]', 'usr_1', 'ana', '', '', 'open', NULL, 'now', 'b', 1, '2026-10-09T10:00:00.000Z'),
                    ('wki_3', 'acme', 3, 'Three', '', '[]', 'usr_1', 'ana', '', '', 'closed', 'completed', 'now', 'c', 1, '2026-10-05T00:00:00.000Z'),
                    ('wki_4', 'acme', 4, 'Four', '', '[]', 'usr_1', 'ana', '', '', 'open', NULL, 'next', 'a', 2, '2026-10-12T00:00:00.000Z'),
                    ('wki_5', 'acme', 5, 'Five', '', '[]', 'usr_1', 'ana', '', '', 'open', NULL, 'next', 'b', NULL, NULL),
                    ('wki_6', 'globex', 6, 'Six', '', '[]', 'usr_1', 'ana', '', '', 'open', NULL, 'now', 'a', 3, '');",
        )
        .unwrap();
        db
    }

    fn still(sql: &str) -> String {
        sql.replace("{STILL_OPEN}", STILL_OPEN)
    }

    /// Runs the roll-over batch for cycle `closing` of acme, as roll_over
    /// builds it, in one transaction as D1 runs a batch.
    fn roll(db: &Connection, closing: u32, starts_on: &str, ends_on: &str, at: &str) {
        let planned: Vec<String> = db
            .prepare("SELECT id FROM work_items WHERE workspace = 'acme' AND state = 'open' AND horizon = 'next' AND cycle_number = ?1 + 1 ORDER BY rank")
            .unwrap()
            .query_map([closing], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let mut last: Option<String> = db
            .query_row("SELECT max(rank) FROM work_items WHERE workspace = 'acme' AND state = 'open' AND horizon = 'now' AND rank IS NOT NULL", [], |row| row.get(0))
            .unwrap();
        let joined = format!("{starts_on}T00:00:00.000Z");
        db.execute_batch("BEGIN").unwrap();
        db.execute(&still(CARRY), params!["acme", closing, at]).unwrap();
        db.execute(&still(ROLL), params!["acme", closing]).unwrap();
        db.execute(&still(STRAYS), params!["acme", closing]).unwrap();
        for id in planned {
            let rank = rank_between(last.as_deref(), None);
            db.execute(&still(PULL_PLANNED), params!["acme", closing, at, id, rank, joined]).unwrap();
            last = Some(rank);
        }
        db.execute(CLOSE, params!["acme", closing, at]).unwrap();
        db.execute(OPEN_NEXT, params!["acme", closing, at, starts_on, ends_on]).unwrap();
        db.execute_batch("COMMIT").unwrap();
    }

    fn cycle_of(db: &Connection, number: u32) -> Cycle {
        let sql = format!("SELECT {CYCLE_COLUMNS} FROM cycles c WHERE c.workspace = 'acme' AND c.number = ?1");
        db.query_row(&sql, [number], |row| {
            Ok(CycleRow {
                workspace: row.get("workspace")?,
                number: row.get("number")?,
                starts_on: row.get("starts_on")?,
                ends_on: row.get("ends_on")?,
                closed_at: row.get("closed_at")?,
                members: row.get("members")?,
                done: row.get("done")?,
                carried_in: row.get("carried_in")?,
                carried_out: row.get("carried_out")?,
                added: row.get("added")?,
            })
        })
        .unwrap()
        .cycle("2026-10-21")
    }

    /// (number, horizon, cycle) of acme's open work items.
    fn open_items(db: &Connection) -> Vec<(u32, String, Option<u32>)> {
        db.prepare("SELECT number, horizon, cycle_number FROM work_items WHERE workspace = 'acme' AND state = 'open' ORDER BY number")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    fn carries(db: &Connection) -> Vec<(u32, u32)> {
        db.prepare("SELECT cycle_number, item_number FROM cycle_carries WHERE workspace = 'acme' ORDER BY 1, 2")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    #[test]
    fn a_cycle_counts_what_it_holds() {
        let db = acme();
        let one = cycle_of(&db, 1);
        // #1, #2 and #3 are in it; #2 joined after its first day; #3 is done.
        assert_eq!((one.scope, one.done, one.added, one.carried_in, one.carried_out), (3, 1, 1, 0, 0));
        assert_eq!(one.state, CycleState::Running);
        // Closed as not planned: out of its scope.
        db.execute("UPDATE work_items SET reason = 'not_planned' WHERE number = 3", []).unwrap();
        assert_eq!((cycle_of(&db, 1).scope, cycle_of(&db, 1).done), (2, 0));
    }

    #[test]
    fn closing_a_cycle_carries_what_is_open_into_the_next() {
        let db = acme();
        roll(&db, 1, "2026-10-19", "2026-11-01", "2026-10-19T00:05:00.000Z");
        // #1 and #2 carried into cycle 2, still in Now; #4, planned, moved into Now; #5 untouched.
        assert_eq!(
            open_items(&db),
            [(1, "now".into(), Some(2)), (2, "now".into(), Some(2)), (4, "now".into(), Some(2)), (5, "next".into(), None)]
        );
        assert_eq!(carries(&db), [(1, 1), (1, 2)]);
        // #4 comes after what was in Now already.
        let ranks: Vec<String> = db
            .prepare("SELECT rank FROM work_items WHERE workspace = 'acme' AND horizon = 'now' AND state = 'open' ORDER BY rank")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(ranks.last().map(String::as_str), Some(rank_between(Some("b"), None).as_str()));
        let one = cycle_of(&db, 1);
        assert!(one.closed_at.is_some());
        // Its report: three taken on, one done, two carried out, #2 added mid-cycle.
        assert_eq!((one.scope, one.done, one.carried_out, one.added), (3, 1, 2, 1));
        let two = cycle_of(&db, 2);
        assert_eq!((two.starts_on.as_str(), two.ends_on.as_str(), two.closed_at), ("2026-10-19", "2026-11-01", None));
        // Carried in and planned: none added mid-cycle.
        assert_eq!((two.scope, two.carried_in, two.added, two.done), (3, 2, 0, 0));
        // The other workspace's cycle is left alone.
        let other: Option<String> = db.query_row("SELECT closed_at FROM cycles WHERE workspace = 'globex'", [], |row| row.get(0)).unwrap();
        assert_eq!(other, None);
    }

    #[test]
    fn closing_a_cycle_twice_carries_nothing_twice() {
        let db = acme();
        roll(&db, 1, "2026-10-19", "2026-11-01", "2026-10-19T00:05:00.000Z");
        let first = (open_items(&db), carries(&db));
        // A second run, or one that read the cycle before the first closed it.
        roll(&db, 1, "2026-10-19", "2026-11-01", "2026-10-19T00:10:00.000Z");
        assert_eq!((open_items(&db), carries(&db)), first);
        let count: u32 = db.query_row("SELECT count(*) FROM cycles WHERE workspace = 'acme'", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 2);
        let closed: String = db.query_row("SELECT closed_at FROM cycles WHERE workspace = 'acme' AND number = 1", [], |row| row.get(0)).unwrap();
        assert_eq!(closed, "2026-10-19T00:05:00.000Z", "closed once, when it first closed");
    }

    #[test]
    fn a_late_cron_closes_every_cycle_it_missed_in_order() {
        let db = acme();
        let settings = CycleSettings { enabled: true, ..CycleSettings::default() };
        // Five weeks late: cycle 1 ended on 10-18, cycle 2 would have ended on 11-01, cycle 3 on 11-15.
        let steps = rollovers(1, "2026-10-18", &settings, "2026-11-22", MAX_ROLLOVERS_PER_RUN);
        assert_eq!(
            steps,
            [
                Rollover { closing: 1, starts_on: "2026-10-19".into(), ends_on: "2026-11-01".into() },
                Rollover { closing: 2, starts_on: "2026-11-02".into(), ends_on: "2026-11-15".into() },
                Rollover { closing: 3, starts_on: "2026-11-16".into(), ends_on: "2026-11-29".into() },
            ]
        );
        for step in &steps {
            roll(&db, step.closing, &step.starts_on, &step.ends_on, "2026-11-22T00:00:00.000Z");
        }
        // No cycle skipped: 1 to 4, with 4 open and today in it.
        let cycles: Vec<(u32, bool)> = db
            .prepare("SELECT number, closed_at IS NULL FROM cycles WHERE workspace = 'acme' ORDER BY number")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(cycles, [(1, false), (2, false), (3, false), (4, true)]);
        // Each carried what was open through every cycle, once each.
        assert_eq!(carries(&db), [(1, 1), (1, 2), (2, 1), (2, 2), (2, 4), (3, 1), (3, 2), (3, 4)]);
        assert!(open_items(&db).iter().filter(|(_, horizon, _)| horizon == "now").all(|(_, _, cycle)| *cycle == Some(4)));
        // Run again on the same day: nothing left to close.
        assert!(rollovers(4, "2026-11-29", &settings, "2026-11-22", MAX_ROLLOVERS_PER_RUN).is_empty());
        // On a cycle's last day it is not over yet.
        assert!(rollovers(1, "2026-10-18", &settings, "2026-10-18", MAX_ROLLOVERS_PER_RUN).is_empty());
        // And a long stop catches up a bounded number of cycles a run.
        assert_eq!(rollovers(1, "2026-10-18", &settings, "2030-01-01", 5).len(), 5);
    }

    #[test]
    fn turning_cycles_on_puts_now_in_the_first_cycle() {
        let db = database();
        db.execute_batch(
            "INSERT INTO cycles (workspace, number, starts_on, ends_on, opened_at, closed_at)
               VALUES ('acme', 1, '2026-09-07', '2026-09-20', '', '2026-09-15T00:00:00.000Z');
             INSERT INTO work_items (id, workspace, number, title, body, labels, author_id, author_name, created_at, updated_at,
                                     state, horizon, cycle_number)
             VALUES ('wki_1', 'acme', 1, 'One', '', '[]', 'usr_1', 'ana', '', '', 'open', 'now', NULL),
                    ('wki_2', 'acme', 2, 'Two', '', '[]', 'usr_1', 'ana', '', '', 'open', 'next', 2),
                    ('wki_3', 'acme', 3, 'Three', '', '[]', 'usr_1', 'ana', '', '', 'closed', 'now', 1);",
        )
        .unwrap();
        let start = first_start("2026-10-21", 1, Some("2026-09-15"));
        assert_eq!(start, "2026-10-19");
        db.execute(OPEN_FIRST, params!["acme", start, cycle_end(&start, 14), "2026-10-21T00:00:00.000Z"]).unwrap();
        db.execute(NOW_JOINS, params!["acme", "2026-10-19T00:00:00.000Z"]).unwrap();
        db.execute(UNPLAN_REST, params!["acme"]).unwrap();
        // Numbered after the one it had; #1 joins it; #2's stale plan goes; #3 keeps its old cycle.
        let numbers: Vec<(u32, Option<u32>)> = db
            .prepare("SELECT number, cycle_number FROM work_items ORDER BY number")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(numbers, [(1, Some(2)), (2, None), (3, Some(1))]);
        // Opening again while one is open does nothing.
        db.execute(OPEN_FIRST, params!["acme", "2026-10-26", "2026-11-08", ""]).unwrap();
        let open: u32 = db.query_row("SELECT count(*) FROM cycles WHERE closed_at IS NULL", [], |row| row.get(0)).unwrap();
        assert_eq!(open, 1);
        // Turned off: the open work items leave it, the cycle closes.
        db.execute(LEAVE_OPEN, params!["acme"]).unwrap();
        db.execute(CLOSE_OPEN, params!["acme", "2026-10-22T00:00:00.000Z"]).unwrap();
        let left: Option<u32> = db.query_row("SELECT cycle_number FROM work_items WHERE number = 1", [], |row| row.get(0)).unwrap();
        assert_eq!(left, None);
        // Turned back on the same week: the new cycle starts after the one it closed.
        assert_eq!(first_start("2026-10-23", 1, Some("2026-10-22")), "2026-10-22");
    }

    #[test]
    fn a_reopened_work_item_in_now_joins_the_current_cycle() {
        let db = acme();
        roll(&db, 1, "2026-10-19", "2026-11-01", "2026-10-19T00:05:00.000Z");
        db.execute("UPDATE work_items SET state = 'open', reason = NULL WHERE number = 3", []).unwrap();
        db.execute(REJOIN, params!["wki_3", "2026-10-21T00:00:00.000Z"]).unwrap();
        let cycle: Option<u32> = db.query_row("SELECT cycle_number FROM work_items WHERE number = 3", [], |row| row.get(0)).unwrap();
        assert_eq!(cycle, Some(2));
        // With cycles off it is in none.
        db.execute("UPDATE cycle_settings SET enabled = 0 WHERE workspace = 'acme'", []).unwrap();
        db.execute(REJOIN, params!["wki_3", "2026-10-21T00:00:00.000Z"]).unwrap();
        let cycle: Option<u32> = db.query_row("SELECT cycle_number FROM work_items WHERE number = 3", [], |row| row.get(0)).unwrap();
        assert_eq!(cycle, None);
    }

    #[test]
    fn a_cycles_report_reads_its_work_items_and_what_it_says_of_each() {
        let db = acme();
        roll(&db, 1, "2026-10-19", "2026-11-01", "2026-10-19T00:05:00.000Z");
        let items = ITEMS.replace("{ITEM_COLUMNS}", ITEM_COLUMNS).replace("{MEMBER}", MEMBER).replace("{PLAN_ORDER}", PLAN_ORDER).replace("{LIMIT}", "200");
        let numbers: Vec<u32> =
            db.prepare(&items).unwrap().query_map(params!["acme", 1], |row| row.get("number")).unwrap().map(Result::unwrap).collect();
        // Open ones carried out first, in the plan's order, then the closed one.
        assert_eq!(numbers, [1, 2, 3]);
        let sql = MEMBERS.replace("{MEMBER}", MEMBER);
        let facts: Vec<(u32, bool, bool, bool)> = db
            .prepare(&sql)
            .unwrap()
            .query_map(params!["acme", 2, "2026-10-21T00:00:00.000Z"], |row| {
                Ok((row.get("number")?, row.get("carried_in")?, row.get("carried_out")?, row.get("claimed")?))
            })
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let mut facts = facts;
        facts.sort();
        assert_eq!(facts, [(1, true, false, false), (2, true, false, false), (4, false, false, false)]);
        let planned = PLANNED.replace("{ITEM_COLUMNS}", ITEM_COLUMNS).replace("{PLAN_ORDER}", PLAN_ORDER);
        db.execute("UPDATE work_items SET cycle_number = 3 WHERE number = 5", []).unwrap();
        let planned: Vec<u32> =
            db.prepare(&planned).unwrap().query_map(params!["acme", 2], |row| row.get("number")).unwrap().map(Result::unwrap).collect();
        assert_eq!(planned, [5]);
    }

    #[test]
    fn a_renamed_or_deleted_workspace_takes_its_cycles() {
        let db = acme();
        roll(&db, 1, "2026-10-19", "2026-11-01", "2026-10-19T00:05:00.000Z");
        db.execute("DELETE FROM cycles WHERE workspace = 'globex'", []).unwrap();
        db.execute("DELETE FROM cycle_settings WHERE workspace = 'globex'", []).unwrap();
        for sql in RENAMED {
            db.execute(sql, ["initech", "acme"]).unwrap();
        }
        let moved: u32 = db.query_row("SELECT count(*) FROM cycle_carries WHERE workspace = 'initech'", [], |row| row.get(0)).unwrap();
        assert_eq!(moved, 2);
        for sql in DELETED {
            db.execute(sql, ["initech"]).unwrap();
        }
        let left: u32 = db.query_row("SELECT (SELECT count(*) FROM cycles) + (SELECT count(*) FROM cycle_carries) + (SELECT count(*) FROM cycle_settings)", [], |row| row.get(0)).unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn moves_say_which_cycle() {
        assert_eq!(cycle_note(None, Some(15)).as_deref(), Some("planned this into Cycle 15"));
        assert_eq!(cycle_note(Some(15), None).as_deref(), Some("took this out of Cycle 15"));
        assert_eq!(cycle_note(Some(14), Some(15)).as_deref(), Some("moved this from Cycle 14 to Cycle 15"));
        assert_eq!(cycle_note(Some(15), Some(15)), None);
    }
}
