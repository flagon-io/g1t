//! What a workspace's work says over the last weeks (`workspace_signals`):
//! the reads behind Home's daily signal and the Workspace overview, one
//! row per repository the viewer can read, as `delivery_insights` reads
//! them (insights.rs).
//!
//! The definitions, which the SQL beside this file (signals/) holds:
//!
//! - A pull request is an **agent's** when its `agent` is `agent` (opened
//!   as an agent's), g1t's agent ([`AGENT_ID`]) opened it, or a harness
//!   session is tied to it, tied as `PULL_SESSIONS` (coordination/links.rs)
//!   ties them: a `pull` session link, the session's own `pull`, or a push
//!   to its branch when it is not on a fork.
//! - Its **owner** is the person it was requested by, else its author.
//! - A **person's verdict** is an approval or request for changes by
//!   someone other than the owner, not g1t's agent and not a workspace
//!   agent (`agent_id` set). The first is its **first review**, as
//!   insights.sql has it.
//! - **Rework**: an agent's pull request merged in the week that a person
//!   asked for changes on before it merged.
//! - **Draft time**: for an agent's pull request whose first tied session
//!   started before it opened, the seconds from that start to its opening,
//!   counted in the week it opened.
//! - **Stalled** in a week: at its cut (when the week ended, or now when
//!   that is earlier), open (not merged, and not closed, before it: a
//!   closed one's `updated_at` stands in for when it closed), opened at
//!   least three days before, and with no activity in the three days
//!   before it. Drafts count. Activity is a comment of any kind on it
//!   (timeline events among them: labels, assignees, review requests,
//!   milestones, ready, draft, closed, reopened, base changes, the merge
//!   queue, auto-merge, branches; a push is no timeline event), its
//!   latest push (the only one `head_pushed_at` keeps), its acceptance
//!   checks (`check_runs`, from created to finished), statuses and check
//!   runs on its head commit (the only commit a pull keeps, so a past
//!   week reads the current head's), entries recorded on it, and a
//!   session tied to it or a subagent of one running then (from its start
//!   to its last heartbeat: an approximation, busy or not).
//! - A week's **session cost**: what the sessions started in it cost,
//!   subagents and all (each reports only its own transcript's).
//! - A pull request's **session cost**: each session's own cost (unknown
//!   as 0), split evenly among the pull requests it counts with: the ones
//!   it is tied to, as above, or, for a subagent tied to none, the ones its
//!   root session is tied to. Only the repositories read count.
//! - **Session spend** with no pull request: what the sessions that count
//!   with none (neither they nor their root session is tied to one) cost,
//!   by repository, work item and day started. A session's work items are
//!   the ones it claimed, landed by a push whose commit names it in a
//!   `G1t-Session` trailer, or said it works on, else its root's; its cost
//!   is split evenly among them, and with none it counts with its
//!   repository alone. Sessions of unknown cost are left out.
//! - A day's **reviews** are comments of any kind on a pull request by a
//!   person other than its owner (not g1t's agent, a workspace agent or g1t
//!   itself); **reworked**, the ones of them asking for changes.
//! - **Waiting**: open (not draft) pull requests with no first review.
//! - **Authors** are owners who are people: not g1t's agent, a workspace
//!   agent (`agt_…`), a workspace (`wsp_…`) or g1t.
//! - **Harnesses**: people's root sessions (`parent_id` unset) by
//!   repository and harness over all history, under the name on their
//!   latest; robots are left out as for authors.
use std::collections::BTreeSet;

use g1t_contracts::identity::AGENT_ID;
use g1t_contracts::repos::{ReadableArgs, Repo};
use g1t_contracts::time::{parse_rfc3339, rfc3339};
use g1t_contracts::work::{
    SignalAuthor, SignalDay, SignalHarness, SignalItem, SignalMilestone, SignalPull, SignalSessionSpend, SignalWeek, State, WaitingPull,
    WorkspaceSignals, WorkspaceSignalsArgs,
};
use serde::{Deserialize, Serialize};
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Work;
use crate::insights::valid_day;
use crate::items;

const DAY_MS: u64 = 86_400_000;
/// How far `since` may reach back before `until`.
const MAX_SINCE_DAYS: u64 = 400;
/// `pulls` returns at most this many; pulls.sql asks for one more.
const PULLS_LIMIT: usize = 3000;
/// `session_spend` returns at most this many; sessions.sql asks for one more.
const SESSION_SPEND_LIMIT: usize = 3000;
/// `recent` in authors: the days ending with `until`.
const RECENT_DAYS: u64 = 90;

pub(crate) const WEEKS: &str = concat!(include_str!("signals/base.sql"), include_str!("signals/weeks.sql"));
pub(crate) const DAYS: &str = concat!(include_str!("signals/base.sql"), include_str!("signals/days.sql"));
pub(crate) const WAITING: &str = concat!(include_str!("signals/base.sql"), include_str!("signals/waiting.sql"));
pub(crate) const PULLS: &str = concat!(include_str!("signals/base.sql"), include_str!("signals/pulls.sql"));
pub(crate) const SESSIONS: &str = concat!(include_str!("signals/base.sql"), include_str!("signals/sessions.sql"));
pub(crate) const AUTHORS: &str = include_str!("signals/authors.sql");
pub(crate) const HARNESSES: &str = include_str!("signals/harnesses.sql");
/// ?1 the workspace.
pub(crate) const MILESTONES: &str = "SELECT number, title, state, due_on, created_at, closed_at
   FROM milestones WHERE workspace = ?1 ORDER BY number";

/// One week's bounds, as weeks.sql reads them from JSON.
#[derive(Debug, Serialize)]
struct WeekBounds {
    /// Its first UTC day, `YYYY-MM-DD`.
    start: String,
    from: String,
    to: String,
    /// When it is read as ended for stalled pull requests: `to`, or now
    /// when that is earlier.
    cut: String,
}

/// What the queries are bound to, worked out from the arguments.
#[derive(Debug)]
struct Window {
    /// JSON array of [`WeekBounds`], oldest first.
    weeks: String,
    /// The first of `days`, and the day after `until`, as `YYYY-MM-DDT00:00:00`.
    days_from: String,
    end: String,
    /// The start of `since`.
    since: String,
    /// The first of the 90 days ending with `until`.
    recent_from: String,
}

fn day_start(day: &str) -> Option<u64> {
    parse_rfc3339(&format!("{day}T00:00:00Z"))
}

fn day_of(ms: u64) -> String {
    rfc3339(ms)[..10].to_owned()
}

fn bound(ms: u64) -> String {
    format!("{}T00:00:00", day_of(ms))
}

/// The bounds `a` asks for at `now`, or `None` when it asks for too many
/// repositories or an invalid range.
fn window(a: &WorkspaceSignalsArgs, now: u64) -> Option<Window> {
    if a.repo_ids.len() > 100
        || !(1..=13).contains(&a.weeks)
        || !(1..=28).contains(&a.days)
        || !valid_day(&a.until)
        || !valid_day(&a.since)
        || a.since > a.until
    {
        return None;
    }
    let until = day_start(&a.until)?;
    let since = day_start(&a.since)?;
    if until - since > MAX_SINCE_DAYS * DAY_MS {
        return None;
    }
    let end = until + DAY_MS;
    let first = end.checked_sub(u64::from(a.weeks) * 7 * DAY_MS)?;
    let weeks: Vec<WeekBounds> = (0..u64::from(a.weeks))
        .map(|i| {
            let from = first + i * 7 * DAY_MS;
            let to = from + 7 * DAY_MS;
            WeekBounds {
                start: day_of(from),
                from: rfc3339(from),
                to: rfc3339(to),
                cut: rfc3339(to.min(now)),
            }
        })
        .collect();
    Some(Window {
        weeks: serde_json::to_string(&weeks).ok()?,
        days_from: bound(end.checked_sub(u64::from(a.days) * DAY_MS)?),
        end: bound(end),
        since: bound(since),
        recent_from: bound(end.checked_sub(RECENT_DAYS * DAY_MS)?),
    })
}

/// Whether an owner is a person: not g1t's agent, a workspace agent, a
/// workspace or g1t itself.
fn is_person(id: &str) -> bool {
    id != AGENT_ID && !id.starts_with("agt_") && !id.starts_with("wsp_") && !g1t_contracts::system::is_system_id(id)
}

/// A row of waiting.sql.
#[derive(Deserialize)]
struct WaitingRow {
    repo_id: String,
    number: u32,
    title: String,
    created_at: String,
    agent: u32,
    draft_seconds: Option<f64>,
    item: Option<u32>,
    /// JSON array of numbers.
    blocks: String,
}

impl From<WaitingRow> for WaitingPull {
    fn from(row: WaitingRow) -> Self {
        WaitingPull {
            repo_id: row.repo_id,
            number: row.number,
            title: row.title,
            created_at: row.created_at,
            agent: row.agent != 0,
            draft_seconds: row.draft_seconds,
            item: row.item,
            blocks: serde_json::from_str(&row.blocks).unwrap_or_default(),
        }
    }
}

/// A row of pulls.sql.
#[derive(Deserialize)]
struct PullRow {
    repo_id: String,
    number: u32,
    title: String,
    status: String,
    agent: u32,
    owner_id: String,
    owner_name: String,
    created_at: String,
    merged_at: Option<String>,
    item: Option<u32>,
    milestone: Option<u32>,
    session_cost_usd: f64,
}

impl From<PullRow> for SignalPull {
    fn from(row: PullRow) -> Self {
        SignalPull {
            repo_id: row.repo_id,
            number: row.number,
            title: row.title,
            status: row.status,
            agent: row.agent != 0,
            owner_id: row.owner_id,
            owner_name: row.owner_name,
            created_at: row.created_at,
            merged_at: row.merged_at,
            item: row.item,
            milestone: row.milestone,
            session_cost_usd: row.session_cost_usd,
        }
    }
}

/// The work item numbers `pulls`, `waiting` and `spend` name, each once.
fn named_items(pulls: &[SignalPull], waiting: &[WaitingPull], spend: &[SignalSessionSpend]) -> Vec<u32> {
    let mut numbers: BTreeSet<u32> = pulls.iter().filter_map(|pull| pull.item).collect();
    numbers.extend(spend.iter().filter_map(|row| row.item));
    for pull in waiting {
        numbers.extend(pull.item);
        numbers.extend(pull.blocks.iter().copied());
    }
    numbers.into_iter().collect()
}

impl Work {
    pub(crate) async fn workspace_signals(&self, a: WorkspaceSignalsArgs) -> Result<WorkspaceSignals> {
        // The web loader batches larger workspaces, as it does for insights.
        let Some(window) = window(&a, g1t_kit::now_ms()) else {
            return Err(worker::Error::RustError(
                "Invalid signals range or repository batch".into(),
            ));
        };
        let viewer = a.viewer.clone();
        let readable: Vec<Repo> = g1t_kit::call(
            &self.repos,
            "readable",
            &ReadableArgs {
                ids: a.repo_ids,
                viewer: a.viewer,
            },
        )
        .await?;
        let ids: Vec<&str> = readable.iter().map(|repo| repo.id.as_str()).collect();
        if ids.is_empty() {
            return Ok(WorkspaceSignals::default());
        }
        // The workspace's own milestones and work items, only for a viewer
        // who can read one of its repositories.
        let in_workspace = readable.iter().any(|repo| repo.namespace == a.workspace);
        let ids: JsValue = serde_json::to_string(&ids)?.into();
        let workspace: JsValue = a.workspace.as_str().into();
        let results = self
            .timing
            .db(
                8,
                self.db.batch(vec![
                    self.db.prepare(WEEKS).bind(&[ids.clone(), window.weeks.into()])?,
                    self.db.prepare(DAYS).bind(&[
                        ids.clone(),
                        window.days_from.as_str().into(),
                        window.end.as_str().into(),
                    ])?,
                    self.db.prepare(WAITING).bind(&[ids.clone(), workspace.clone()])?,
                    self.db
                        .prepare(PULLS)
                        .bind(&[ids.clone(), workspace.clone(), window.since.as_str().into()])?,
                    self.db
                        .prepare(SESSIONS)
                        .bind(&[ids.clone(), workspace.clone(), window.since.into()])?,
                    self.db
                        .prepare(AUTHORS)
                        .bind(&[ids.clone(), window.recent_from.into(), window.end.into()])?,
                    self.db.prepare(HARNESSES).bind(&[ids])?,
                    self.db.prepare(MILESTONES).bind(&[workspace])?,
                ]),
            )
            .await?;
        let [weeks, days, waiting, pulls, session_spend, authors, harnesses, milestones] = results.as_slice() else {
            return Err(worker::Error::RustError("workspace_signals: missing results".into()));
        };
        let mut waiting: Vec<WaitingPull> = waiting
            .results::<WaitingRow>()?
            .into_iter()
            .map(WaitingPull::from)
            .collect();
        let mut pulls: Vec<SignalPull> = pulls.results::<PullRow>()?.into_iter().map(SignalPull::from).collect();
        let pulls_capped = pulls.len() > PULLS_LIMIT;
        pulls.truncate(PULLS_LIMIT);
        let mut session_spend: Vec<SignalSessionSpend> = session_spend.results::<SignalSessionSpend>()?;
        let session_spend_capped = session_spend.len() > SESSION_SPEND_LIMIT;
        session_spend.truncate(SESSION_SPEND_LIMIT);
        let authors: Vec<SignalAuthor> = authors
            .results::<SignalAuthor>()?
            .into_iter()
            .filter(|author| is_person(&author.owner_id))
            .collect();
        let harnesses: Vec<SignalHarness> = harnesses
            .results::<SignalHarness>()?
            .into_iter()
            .filter(|harness| is_person(&harness.owner_id))
            .collect();
        let (items, milestones) = if in_workspace {
            let numbers = named_items(&pulls, &waiting, &session_spend);
            let visible = items::visible_numbered(self, &a.workspace, &numbers, viewer.as_ref()).await?;
            let mut items: Vec<SignalItem> = visible
                .into_iter()
                .map(|held| SignalItem {
                    number: held.item.number,
                    title: held.item.title,
                    state: match held.item.state {
                        State::Open => "open",
                        State::Closed => "closed",
                    }
                    .into(),
                    milestone: held.item.milestone.map(|milestone| milestone.number),
                })
                .collect();
            items.sort_by_key(|item| item.number);
            (items, milestones.results::<SignalMilestone>()?)
        } else {
            (Vec::new(), Vec::new())
        };
        // A work item the viewer may not see is not named: its sessions'
        // cost counts with their repository.
        for row in &mut session_spend {
            if row.item.is_some_and(|number| !items.iter().any(|item| item.number == number)) {
                row.item = None;
            }
        }
        // A blocked work item the viewer may not see is not named.
        for pull in &mut waiting {
            pull.blocks
                .retain(|number| items.iter().any(|item| item.number == *number));
        }
        Ok(WorkspaceSignals {
            weeks: weeks.results::<SignalWeek>()?,
            days: days.results::<SignalDay>()?,
            waiting,
            pulls,
            pulls_capped,
            session_spend,
            session_spend_capped,
            authors,
            harnesses,
            items,
            milestones,
        })
    }
}

#[cfg(test)]
mod tests;
