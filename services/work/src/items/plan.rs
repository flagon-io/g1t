//! The plan (`g1t_contracts::work::plan`): where each open work item of a
//! workspace stands, its place there, and what to take next
//! (migrations/0056_plan.sql). `plan_work_item` moves one, `get_plan`
//! reads a workspace's within its bounds, `next_work_item` picks what is
//! ready, and `configure_plan` sets Now's cap. `list_work_items` with a
//! `horizon` reads one horizon in the plan's order (reading.rs).

use g1t_contracts::access::{self, Capability};
use g1t_contracts::events::WorkItemEvent;
use g1t_contracts::rules::is_agent;
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, User, Viewer};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use super::rows::{Held, ITEM_COLUMNS, ItemRow, no_item, workspace_of};
use crate::{Work, optional, optional_number};

/// An open work item's horizon, with NULL (rows from before the plan, and
/// ones opened since) read as Triage.
pub(crate) const HORIZON: &str = "COALESCE(work_items.horizon, 'triage')";

/// The plan's order within a horizon: urgent first, then by rank, those
/// with none last, newest first among them. Triage has no ranks, so it is
/// newest first.
pub(crate) const PLAN_ORDER: &str = "work_items.urgent DESC, work_items.rank IS NULL, work_items.rank, work_items.number DESC";

/// The open, numbered work items of workspace `?1` a viewer may see: all
/// of them for a member (`?2` = 1), else those filed in a public
/// repository or one of `?3` (a JSON array of repository ids they have a
/// role on). With `?4`, only those linked to that repository.
const OPEN_VISIBLE: &str = "work_items.workspace = ?1 AND work_items.state = 'open' AND work_items.number IS NOT NULL
   AND (?4 IS NULL OR EXISTS (SELECT 1 FROM work_item_repos r WHERE r.item_id = work_items.id AND r.repo_id = ?4))
   AND (?2 = 1 OR EXISTS (SELECT 1 FROM work_item_repos o JOIN repo_workspaces rw ON rw.repo_id = o.repo_id
         WHERE o.item_id = work_items.id AND o.role = 'origin'
           AND (rw.private = 0 OR o.repo_id IN (SELECT value FROM json_each(?3)))))";

/// What is ready to take, given `?5` (now, RFC 3339) and `?6` (the
/// viewer's username, lowercase): nobody holds a live claim on it, nothing
/// it is blocked by is open, and it is assigned to nobody or to them.
const READY: &str = "NOT EXISTS (SELECT 1 FROM claims c WHERE c.item_id = work_items.id AND c.state = 'active' AND c.expires_at > ?5)
   AND NOT EXISTS (SELECT 1 FROM json_each(work_items.blocked_by) j JOIN work_items b ON b.id = j.value WHERE b.state = 'open')
   AND (json_array_length(work_items.assignees) = 0
        OR EXISTS (SELECT 1 FROM json_each(work_items.assignees) WHERE lower(json_each.value) = ?6))";

fn open_items(condition: &str, limit: u32) -> String {
    format!("SELECT {ITEM_COLUMNS} FROM work_items WHERE {OPEN_VISIBLE} AND {condition} ORDER BY {PLAN_ORDER} LIMIT {limit}")
}

/// How many open work items each horizon holds.
const COUNTS: &str = "SELECT COALESCE(work_items.horizon, 'triage') AS horizon, count(*) AS count FROM work_items
   WHERE {OPEN_VISIBLE} GROUP BY 1";

/// Later, by the repository each work item is filed in. One filed in a
/// deleted repository is counted with those filed in the workspace: its
/// repository has nothing to open, so a group of its own would not open.
const LATER_GROUPS: &str = "SELECT (SELECT CASE WHEN rw.deleted_at IS NULL THEN COALESCE(rw.path, o.path) END FROM work_item_repos o
     LEFT JOIN repo_workspaces rw ON rw.repo_id = o.repo_id
     WHERE o.item_id = work_items.id AND o.role = 'origin') AS repo, count(*) AS count
   FROM work_items WHERE {OPEN_VISIBLE} AND COALESCE(work_items.horizon, 'triage') = 'later'
   GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 50";

/// The ranks on horizon `?2` of workspace `?1` around a place, leaving out
/// work item `?3`: the last one ahead of `?4` (none: no bound) and the
/// first one after `?5`.
const NEIGHBOURS: &str = "SELECT
   (SELECT max(rank) FROM work_items WHERE workspace = ?1 AND state = 'open' AND COALESCE(horizon, 'triage') = ?2
      AND id <> ?3 AND rank IS NOT NULL AND (?4 IS NULL OR rank < ?4)) AS ahead,
   (SELECT min(rank) FROM work_items WHERE workspace = ?1 AND state = 'open' AND COALESCE(horizon, 'triage') = ?2
      AND id <> ?3 AND rank IS NOT NULL AND (?5 IS NULL OR rank > ?5)) AS behind";

/// What the record says of each work item in the JSON array of ids `?1`:
/// its hill's facts, when anything last happened on it, and where g1t
/// last said it stands.
pub(crate) const FACTS: &str = "SELECT w.number,
   (SELECT count(*) FROM decisions d WHERE d.item_id = w.id
      AND d.kind NOT IN ('claim', 'merge', 'integration_failure', 'integration_passed')) AS decisions,
   (SELECT count(*) FROM pulls p WHERE p.item_id = w.id AND p.status = 'draft') AS draft_pulls,
   (SELECT count(*) FROM session_touches t JOIN sessions s ON s.id = t.session_id
      WHERE s.item_id = w.id AND t.kind = 'commit') AS commits,
   (SELECT count(*) FROM pulls p WHERE p.item_id = w.id AND p.status = 'open') AS open_pulls,
   (SELECT count(*) FROM pulls p WHERE p.item_id = w.id AND p.status = 'merged') AS merged_pulls,
   (SELECT count(*) FROM work_item_repos r WHERE r.item_id = w.id AND r.landed_at IS NOT NULL) AS landed_targets,
   max(w.updated_at,
       COALESCE((SELECT max(s.last_seen_at) FROM sessions s WHERE s.item_id = w.id), ''),
       COALESCE((SELECT max(d.created_at) FROM decisions d WHERE d.item_id = w.id), ''),
       COALESCE((SELECT max(p.updated_at) FROM pulls p WHERE p.item_id = w.id), '')) AS active_at,
   w.standing, w.standing_at
 FROM work_items w WHERE w.id IN (SELECT value FROM json_each(?1))";

#[derive(Deserialize)]
pub(crate) struct FactsRow {
    pub number: u32,
    #[serde(default)]
    pub decisions: u32,
    #[serde(default)]
    pub draft_pulls: u32,
    #[serde(default)]
    pub commits: u32,
    #[serde(default)]
    pub open_pulls: u32,
    #[serde(default)]
    pub merged_pulls: u32,
    #[serde(default)]
    pub landed_targets: u32,
    #[serde(default)]
    pub active_at: Option<String>,
    #[serde(default)]
    pub standing: Option<String>,
    #[serde(default)]
    pub standing_at: Option<String>,
}

impl FactsRow {
    pub(crate) fn hill(&self) -> Hill {
        hill_of(&HillFacts {
            decisions: self.decisions,
            draft_pulls: self.draft_pulls,
            commits: self.commits,
            open_pulls: self.open_pulls,
            merged_pulls: self.merged_pulls,
            landed_targets: self.landed_targets,
        })
    }

    /// How it stands, quiet when nothing has happened since `quiet_before`
    /// (RFC 3339).
    pub(crate) fn progress(self, quiet_before: &str) -> Progress {
        let hill = self.hill();
        let active_at = self.active_at.filter(|at| !at.is_empty());
        Progress {
            number: self.number,
            hill,
            quiet: active_at.as_deref().is_some_and(|at| at < quiet_before),
            active_at,
            standing: self.standing,
            standing_at: self.standing_at,
        }
    }
}

/// The RFC 3339 time `days` before `now_ms`.
pub(crate) fn days_before(now_ms: u64, days: u32) -> String {
    rfc3339(now_ms.saturating_sub(u64::from(days) * 86_400_000))
}

/// What closed from Now since `?5`, the most recently closed first.
const LANDED: &str = "SELECT {ITEM_COLUMNS} FROM work_items
   WHERE work_items.workspace = ?1 AND work_items.state = 'closed' AND work_items.number IS NOT NULL
     AND work_items.horizon = 'now' AND work_items.closed_at >= ?5
     AND (?4 IS NULL OR EXISTS (SELECT 1 FROM work_item_repos r WHERE r.item_id = work_items.id AND r.repo_id = ?4))
     AND (?2 = 1 OR EXISTS (SELECT 1 FROM work_item_repos o JOIN repo_workspaces rw ON rw.repo_id = o.repo_id
           WHERE o.item_id = work_items.id AND o.role = 'origin'
             AND (rw.private = 0 OR o.repo_id IN (SELECT value FROM json_each(?3)))))
   ORDER BY work_items.closed_at DESC LIMIT 10";

/// How many have waited in Triage since before `?5`, and how many were set
/// aside since `?6`.
const WAITING: &str = "SELECT
   (SELECT count(*) FROM work_items WHERE {OPEN_VISIBLE} AND COALESCE(work_items.horizon, 'triage') = 'triage'
      AND work_items.created_at < ?5) AS triage_waiting,
   (SELECT count(*) FROM work_items WHERE {OPEN_VISIBLE} AND work_items.horizon = 'set_aside'
      AND work_items.planned_at >= ?6) AS set_aside_recent";

#[derive(Deserialize)]
struct Waiting {
    #[serde(default)]
    triage_waiting: u32,
    #[serde(default)]
    set_aside_recent: u32,
}

#[derive(Deserialize)]
struct Neighbours {
    ahead: Option<String>,
    behind: Option<String>,
}

#[derive(Deserialize)]
struct Count {
    horizon: Option<String>,
    count: u32,
}

#[derive(Deserialize)]
struct Group {
    repo: Option<String>,
    count: u32,
}

/// Who a viewer is in a workspace, for the queries above: whether they
/// are a member, and the repositories they were given a role on.
fn standing(viewer: Option<&User>, workspace: &str) -> Result<(JsValue, JsValue)> {
    let member = viewer.and_then(|user| access::workspace_role(user, workspace)).is_some();
    let granted: Vec<&str> = viewer
        .map(|user| {
            user.grants.iter().filter(|grant| grant.workspace.eq_ignore_ascii_case(workspace)).map(|grant| grant.repo_id.as_str()).collect()
        })
        .unwrap_or_default();
    Ok((u32::from(member).into(), serde_json::to_string(&granted)?.into()))
}

/// What placing a work item asks for, once read: its horizon after, and
/// where on it.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Place<'a> {
    /// Leave its rank as it is.
    Stay,
    /// Last on the horizon.
    Bottom,
    Top,
    /// Just before the work item of this rank.
    Before(&'a str),
    /// Just after the work item of this rank.
    After(&'a str),
}

/// What a move says in the work item's conversation, if anything: a new
/// horizon, and a change to urgent.
pub(crate) fn move_note(from: Horizon, to: Horizon, urgent_before: bool, urgent: bool) -> Option<String> {
    let mut parts = Vec::new();
    if from != to {
        parts.push(format!("moved this from {} to {}", from.label(), to.label()));
    }
    match (urgent_before, urgent) {
        (false, true) => parts.push("marked this urgent".to_owned()),
        (true, false) => parts.push("said this is no longer urgent".to_owned()),
        _ => {}
    }
    (!parts.is_empty()).then(|| parts.join(" and "))
}

/// A budget as given: a positive number of dollars up to the most.
pub(crate) fn valid_budget(budget: Option<f64>) -> std::result::Result<Option<f64>, String> {
    match budget {
        None => Ok(None),
        Some(dollars) if dollars.is_finite() && dollars > 0.0 && dollars <= MAX_BUDGET_USD => Ok(Some((dollars * 100.0).round() / 100.0)),
        Some(_) => Err(format!("A budget is a number of dollars above 0 and up to {MAX_BUDGET_USD}.")),
    }
}

impl Work {
    /// How many work items Now holds before workspace `workspace`'s plan
    /// says it is over.
    async fn now_cap(&self, workspace: &str) -> Result<u32> {
        #[derive(Deserialize)]
        struct Cap {
            now_cap: u32,
        }
        Ok(self
            .db
            .prepare("SELECT now_cap FROM plan_settings WHERE workspace = ?")
            .bind(&[workspace.into()])?
            .first::<Cap>(None)
            .await?
            .map_or(DEFAULT_NOW_CAP, |row| row.now_cap))
    }

    /// The open work item numbered `number`, to place another next to.
    async fn anchor(&self, held: &Held, number: u32) -> Result<Outcome<Held>> {
        if number == held.item.number {
            return Ok(Outcome::fail(FailureCode::Invalid, "A work item can't be placed next to itself."));
        }
        match self.item(&held.item.workspace, number).await? {
            Some(anchor) if anchor.item.state == State::Open => Ok(Outcome::Ok(anchor)),
            Some(_) => Ok(Outcome::fail(FailureCode::Invalid, format!("#{number} is closed, so it has no place in the plan."))),
            None => Ok(Outcome::fail(FailureCode::NotFound, format!("#{number} is not a work item of {}.", held.item.workspace))),
        }
    }

    /// The rank `place` gives work item `held` on `horizon`.
    async fn rank_for(&self, held: &Held, horizon: Horizon, place: &Place<'_>) -> Result<Option<String>> {
        if horizon == Horizon::Triage {
            return Ok(None);
        }
        if *place == Place::Stay {
            // A rank it already has there; one with none goes last.
            if held.item.horizon == horizon {
                if let Some(rank) = self.stored_rank(&held.item.id).await? {
                    return Ok(Some(rank));
                }
            }
            return Box::pin(self.rank_for(held, horizon, &Place::Bottom)).await;
        }
        // With no bound given, `ahead` is the last rank there and `behind`
        // the first.
        let (upper, lower): (JsValue, JsValue) = match place {
            Place::Before(rank) => ((*rank).into(), JsValue::NULL),
            Place::After(rank) => (JsValue::NULL, (*rank).into()),
            _ => (JsValue::NULL, JsValue::NULL),
        };
        let found = self
            .db
            .prepare(NEIGHBOURS)
            .bind(&[held.item.workspace.as_str().into(), horizon.as_str().into(), held.item.id.as_str().into(), upper, lower])?
            .first::<Neighbours>(None)
            .await?
            .unwrap_or(Neighbours { ahead: None, behind: None });
        Ok(Some(match place {
            Place::Before(rank) => rank_between(found.ahead.as_deref(), Some(rank)),
            Place::After(rank) => rank_between(Some(rank), found.behind.as_deref()),
            Place::Top => rank_between(None, found.behind.as_deref()),
            Place::Bottom | Place::Stay => rank_between(found.ahead.as_deref(), None),
        }))
    }

    async fn stored_rank(&self, id: &str) -> Result<Option<String>> {
        #[derive(Deserialize)]
        struct Rank {
            rank: Option<String>,
        }
        Ok(self
            .db
            .prepare("SELECT rank FROM work_items WHERE id = ?")
            .bind(&[id.into()])?
            .first::<Rank>(None)
            .await?
            .and_then(|row| row.rank))
    }

    /// Gives `anchor` a rank, last on its horizon, if it has none, so
    /// another can be placed next to it. Returns its rank.
    async fn ranked(&self, anchor: &Held) -> Result<String> {
        if let Some(rank) = self.stored_rank(&anchor.item.id).await? {
            return Ok(rank);
        }
        let rank = self.rank_for(anchor, anchor.item.horizon, &Place::Bottom).await?.unwrap_or_else(|| rank_between(None, None));
        self.db
            .prepare("UPDATE work_items SET rank = ? WHERE id = ? AND rank IS NULL")
            .bind(&[rank.as_str().into(), anchor.item.id.as_str().into()])?
            .run()
            .await?;
        Ok(rank)
    }

    // --- RPC methods ----------------------------------------------------------

    pub(crate) async fn plan_work_item(&self, a: PlanWorkItemArgs) -> Result<Outcome<WorkItem>> {
        let workspace = a.workspace.trim().to_lowercase();
        let held = check!(self.item_for(&Some(a.actor.clone()), &workspace, a.number, Capability::Read).await?);
        if held.item.state == State::Closed {
            return Ok(Outcome::fail(FailureCode::Conflict, "This work item is closed, so it has no place in the plan. Reopen it first."));
        }
        let positions = usize::from(a.before.is_some()) + usize::from(a.after.is_some()) + usize::from(a.top);
        if positions > 1 {
            return Ok(Outcome::fail(FailureCode::Invalid, "Say one of before, after or top."));
        }
        let budget = match a.budget_usd {
            Some(budget) => match valid_budget(budget) {
                Ok(budget) => Some(budget),
                Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
            },
            None => None,
        };
        // Next to another: on that one's horizon.
        let anchor = match a.before.or(a.after) {
            Some(number) => Some(check!(self.anchor(&held, number).await?)),
            None => None,
        };
        let from = held.item.horizon;
        // Urgent is first in Now.
        let mut horizon = a.horizon.or(anchor.as_ref().map(|anchor| anchor.item.horizon)).unwrap_or(from);
        if a.urgent == Some(true) {
            if a.horizon.is_some_and(|asked| asked != Horizon::Now) {
                return Ok(Outcome::fail(FailureCode::Invalid, "An urgent work item is in Now."));
            }
            horizon = Horizon::Now;
        }
        if let (Some(anchor), Some(asked)) = (&anchor, a.horizon) {
            if anchor.item.horizon != asked {
                return Ok(Outcome::fail(
                    FailureCode::Invalid,
                    format!("#{} is in {}, not {}.", anchor.item.number, anchor.item.horizon.label(), asked.label()),
                ));
            }
        }
        if horizon == Horizon::Triage && positions > 0 {
            return Ok(Outcome::fail(FailureCode::Invalid, "Triage is in the order work items came in, so nothing is placed in it."));
        }
        // Who may: the Triage role to plan; the right to manage milestones
        // for what the workspace commits to.
        check!(held.allowed(Some(&a.actor), Capability::Triage));
        let reranked = positions > 0 || horizon != from;
        let commits = (horizon.committed() && reranked)
            || (from.committed() && horizon != from)
            || a.urgent.is_some_and(|urgent| urgent != held.item.urgent);
        if commits && !access::can_item(Some(&a.actor), &workspace, None, Capability::ManageLabels) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                format!(
                    "Deciding what is in Now takes the right to manage milestones. {}",
                    access::needs_on_item(Capability::ManageLabels, &workspace)
                ),
            ));
        }
        // While cycles are on, Now is the current cycle (cycles.rs): moving
        // into Now puts a work item in it, and out of Now takes it out. An
        // agent never commits a cycle.
        let current = self.current_cycle_number(&workspace).await?;
        if let Some(number) = current
            && horizon == Horizon::Now
            && held.item.horizon != Horizon::Now
            && is_agent(&a.actor)
        {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                format!(
                    "Agents can't commit a cycle: a person moves work into Cycle {number}. A work item an agent files waits in Triage."
                ),
            ));
        }
        let (cycle_changed, cycle_number) = match (horizon, current) {
            (Horizon::Now, Some(number)) => (held.item.cycle != Some(number), Some(number)),
            _ if horizon != from => (held.item.cycle.is_some(), None),
            _ => (false, held.item.cycle),
        };
        let anchor_rank = match &anchor {
            Some(anchor) => Some(self.ranked(anchor).await?),
            None => None,
        };
        let place = match (&anchor_rank, a.before.is_some(), a.top) {
            (Some(rank), true, _) => Place::Before(rank),
            (Some(rank), false, _) => Place::After(rank),
            (None, _, true) => Place::Top,
            (None, _, false) if horizon != from => Place::Bottom,
            _ => Place::Stay,
        };
        let rank = self.rank_for(&held, horizon, &place).await?;
        let urgent = a.urgent.unwrap_or(held.item.urgent) && horizon == Horizon::Now;
        let appetite = a.appetite.unwrap_or(held.item.appetite);
        let budget = budget.unwrap_or(held.item.budget_usd);
        let now = rfc3339(now_ms());
        let planned_at = if reranked { Some(now.clone()) } else { held.item.planned_at.clone() };
        self.db
            .prepare(
                "UPDATE work_items SET horizon = ?1, rank = ?2, appetite = ?3, budget_usd = ?4, urgent = ?5, planned_at = ?6,
                   cycle_number = CASE WHEN ?8 THEN ?9 ELSE cycle_number END,
                   cycle_added_at = CASE WHEN ?8 THEN ?10 ELSE cycle_added_at END
                 WHERE id = ?7 AND state = 'open'",
            )
            .bind(&[
                horizon.as_str().into(),
                optional(&rank),
                optional(&appetite.map(|appetite| appetite.as_str().to_owned())),
                budget.map_or(JsValue::NULL, JsValue::from),
                u32::from(urgent).into(),
                optional(&planned_at),
                held.item.id.as_str().into(),
                cycle_changed.into(),
                optional_number(cycle_number),
                if cycle_number.is_some() { now.as_str().into() } else { JsValue::NULL },
            ])?
            .run()
            .await?;
        let Some(after) = self.item_by_id(&held.item.id).await? else {
            return Ok(no_item());
        };
        self.publish_item(
            "work_item.planned",
            &after,
            Some(&a.actor),
            WorkItemEvent {
                horizon: Some(horizon),
                from_horizon: (horizon != from).then_some(from),
                appetite: after.item.appetite,
                urgent: Some(urgent),
                ..Self::item_event(&after)
            },
        )
        .await?;
        if let Some(note) = move_note(from, horizon, held.item.urgent, urgent) {
            self.note_item(&after.item.id, &a.actor, &note).await?;
        }
        Ok(Outcome::Ok(after.shown(Some(&a.actor))))
    }

    pub(crate) async fn get_plan(&self, a: GetPlanArgs) -> Result<Outcome<Plan>> {
        let workspace = workspace_of(&a.workspace, a.repo.as_ref());
        if workspace.is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Say which workspace."));
        }
        let repo_id = match &a.repo {
            Some(path) => {
                let repo = check!(self.repo(path, &a.viewer).await?);
                if !repo.namespace.eq_ignore_ascii_case(&workspace) {
                    return Ok(Outcome::Ok(Plan {
                        workspace,
                        now_cap: self.now_cap(&repo.namespace.to_lowercase()).await?,
                        ..Plan::default()
                    }));
                }
                Some(repo.id)
            }
            None => None,
        };
        let (member, granted) = standing(a.viewer.as_ref(), &workspace)?;
        let bound = |extra: Option<JsValue>| {
            let mut values = vec![workspace.as_str().into(), member.clone(), granted.clone(), optional(&repo_id)];
            values.extend(extra);
            values
        };
        let shown = if a.all { crate::LIST_PAGE } else { NEXT_SHOWN };
        let now_ms = now_ms();
        let week = days_before(now_ms, WEEK_DAYS);
        let mut waiting_values = bound(Some(days_before(now_ms, TRIAGE_NUDGE_DAYS).into()));
        waiting_values.push(days_before(now_ms, 30).into());
        let statements = vec![
            self.db.prepare(open_items(&format!("{HORIZON} = 'now'"), crate::LIST_PAGE)).bind(&bound(None))?,
            self.db.prepare(open_items(&format!("{HORIZON} = 'next'"), shown)).bind(&bound(None))?,
            self.db.prepare(COUNTS.replace("{OPEN_VISIBLE}", OPEN_VISIBLE)).bind(&bound(None))?,
            self.db.prepare(LATER_GROUPS.replace("{OPEN_VISIBLE}", OPEN_VISIBLE)).bind(&bound(None))?,
            self.db.prepare(LANDED.replace("{ITEM_COLUMNS}", ITEM_COLUMNS)).bind(&bound(Some(week.as_str().into())))?,
            self.db.prepare(WAITING.replace("{OPEN_VISIBLE}", OPEN_VISIBLE)).bind(&waiting_values)?,
            self.current_cycle_statement(&workspace)?,
        ];
        let results = self.timing.db(7, self.db.batch(statements)).await?;
        let rows = |index: usize| results.get(index).ok_or_else(|| worker::Error::RustError("short batch".into()));
        let now = shown_rows(rows(0)?.results::<ItemRow>()?, &a.viewer);
        let next = shown_rows(rows(1)?.results::<ItemRow>()?, &a.viewer);
        let counts = rows(2)?.results::<Count>()?;
        let total = |horizon: Horizon| {
            counts
                .iter()
                .filter(|row| row.horizon.as_deref().and_then(Horizon::parse).unwrap_or_default() == horizon)
                .map(|row| row.count)
                .sum()
        };
        let later = rows(3)?.results::<Group>()?.into_iter().map(|group| PlanGroup { repo: group.repo, count: group.count }).collect();
        let landed = shown_rows(rows(4)?.results::<ItemRow>()?, &a.viewer);
        let waiting = rows(5)?.results::<Waiting>()?.into_iter().next().unwrap_or(Waiting { triage_waiting: 0, set_aside_recent: 0 });
        let today = rfc3339(now_ms)[..10].to_owned();
        let cycle = rows(6)?.results::<super::cycles::CycleRow>()?.into_iter().next().map(|row| row.cycle(&today));
        // How each in Now stands, in Now's order.
        let ids: Vec<&str> = now.iter().map(|item| item.id.as_str()).collect();
        let mut facts: Vec<FactsRow> = if ids.is_empty() {
            Vec::new()
        } else {
            self.db.prepare(FACTS).bind(&[serde_json::to_string(&ids)?.into()])?.all().await?.results::<FactsRow>()?
        };
        let quiet_before = days_before(now_ms, QUIET_DAYS);
        let progress = now
            .iter()
            .filter_map(|item| {
                let at = facts.iter().position(|row| row.number == item.number)?;
                Some(facts.swap_remove(at).progress(&quiet_before))
            })
            .collect();
        Ok(Outcome::Ok(Plan {
            progress,
            landed,
            triage_waiting: waiting.triage_waiting,
            set_aside_recent: waiting.set_aside_recent,
            now_cap: self.now_cap(&workspace).await?,
            now,
            next,
            next_total: total(Horizon::Next),
            triage_total: total(Horizon::Triage),
            later_total: total(Horizon::Later),
            later,
            set_aside_total: total(Horizon::SetAside),
            cycle,
            workspace,
        }))
    }

    pub(crate) async fn next_work_item(&self, a: NextWorkItemArgs) -> Result<Outcome<Option<WorkItem>>> {
        let workspace = workspace_of(&a.workspace, a.repo.as_ref());
        let repo_id = match &a.repo {
            Some(path) => {
                let repo = check!(self.repo(path, &a.viewer).await?);
                if !repo.namespace.eq_ignore_ascii_case(&workspace) {
                    return Ok(Outcome::Ok(None));
                }
                Some(repo.id)
            }
            None => None,
        };
        let (member, granted) = standing(a.viewer.as_ref(), &workspace)?;
        let username = a.viewer.as_ref().map(|user| user.username.to_lowercase()).unwrap_or_default();
        let sql = format!(
            "SELECT {ITEM_COLUMNS} FROM work_items WHERE {OPEN_VISIBLE} AND {HORIZON} IN ('now', 'next') AND {READY}
             ORDER BY CASE {HORIZON} WHEN 'now' THEN 0 ELSE 1 END, {PLAN_ORDER} LIMIT 20"
        );
        let rows = self
            .db
            .prepare(sql)
            .bind(&[workspace.as_str().into(), member, granted, optional(&repo_id), rfc3339(now_ms()).into(), username.into()])?
            .all()
            .await?
            .results::<ItemRow>()?;
        Ok(Outcome::Ok(shown_rows(rows, &a.viewer).into_iter().next()))
    }

    pub(crate) async fn configure_plan(&self, a: ConfigurePlanArgs) -> Result<Outcome<Plan>> {
        let workspace = a.workspace.trim().to_lowercase();
        if !access::can_item(Some(&a.actor), &workspace, None, Capability::ManageLabels) {
            return Ok(Outcome::fail(FailureCode::Forbidden, access::needs_on_item(Capability::ManageLabels, &workspace)));
        }
        if !(1..=MAX_NOW_CAP).contains(&a.now_cap) {
            return Ok(Outcome::fail(FailureCode::Invalid, format!("Now's cap is a number from 1 to {MAX_NOW_CAP}.")));
        }
        self.db
            .prepare(
                "INSERT INTO plan_settings (workspace, now_cap, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (workspace) DO UPDATE SET now_cap = excluded.now_cap, updated_at = excluded.updated_at,
                   updated_by = excluded.updated_by",
            )
            .bind(&[workspace.as_str().into(), a.now_cap.into(), rfc3339(now_ms()).into(), a.actor.id.as_str().into()])?
            .run()
            .await?;
        Ok(Outcome::Ok(Plan { workspace, now_cap: a.now_cap, ..Plan::default() }))
    }
}

/// The rows a viewer may see, as they are shown them.
fn shown_rows(rows: Vec<ItemRow>, viewer: &Viewer) -> Vec<WorkItem> {
    rows.into_iter()
        .filter_map(ItemRow::held)
        .filter(|held| held.may(viewer.as_ref(), Capability::Read))
        .map(|held| held.shown(viewer.as_ref()))
        .collect()
}

#[cfg(test)]
mod tests {
    use rusqlite::{Connection, ToSql};

    use super::super::rows::ITEM_COLUMNS;
    use super::*;
    use crate::migrated::database;

    /// acme's open work items 1 to 6 (2 private to rep_secret), 7 closed.
    fn acme() -> Connection {
        let db = database();
        db.execute_batch(
            "INSERT INTO repo_workspaces (repo_id, workspace, path, private)
             VALUES ('rep_web', 'acme', 'acme/web', 0), ('rep_secret', 'acme', 'acme/secret', 1);
             INSERT INTO work_items (id, workspace, number, title, body, labels, author_id, author_name, created_at, updated_at, state)
             VALUES ('wki_1', 'acme', 1, 'One', '', '[]', 'usr_1', 'ana', '', '', 'open'),
                    ('wki_2', 'acme', 2, 'Two', '', '[]', 'usr_1', 'ana', '', '', 'open'),
                    ('wki_3', 'acme', 3, 'Three', '', '[]', 'usr_1', 'ana', '', '', 'open'),
                    ('wki_4', 'acme', 4, 'Four', '', '[]', 'usr_1', 'ana', '', '', 'open'),
                    ('wki_5', 'acme', 5, 'Five', '', '[]', 'usr_1', 'ana', '', '', 'open'),
                    ('wki_6', 'acme', 6, 'Six', '', '[]', 'usr_1', 'ana', '', '', 'open'),
                    ('wki_7', 'acme', 7, 'Seven', '', '[]', 'usr_1', 'ana', '', '', 'closed');
             INSERT INTO work_item_repos (item_id, repo_id, role, path, added_at)
             VALUES ('wki_1', 'rep_web', 'origin', 'acme/web', ''), ('wki_2', 'rep_secret', 'origin', 'acme/secret', ''),
                    ('wki_3', 'rep_web', 'origin', 'acme/web', ''), ('wki_4', 'rep_web', 'origin', 'acme/web', ''),
                    ('wki_5', 'rep_web', 'origin', 'acme/web', ''), ('wki_6', 'rep_web', 'origin', 'acme/web', ''),
                    ('wki_7', 'rep_web', 'origin', 'acme/web', '');",
        )
        .unwrap();
        db
    }

    fn place(db: &Connection, number: u32, horizon: &str, rank: Option<&str>) {
        db.execute("UPDATE work_items SET horizon = ?1, rank = ?2 WHERE number = ?3", rusqlite::params![horizon, rank, number]).unwrap();
    }

    /// The numbers on `horizon`, in the plan's order, as a member or not.
    fn on(db: &Connection, horizon: &str, member: bool) -> Vec<u32> {
        let sql = open_items(&format!("{HORIZON} = ?5"), 100).replace("{ITEM_COLUMNS}", ITEM_COLUMNS);
        let values: [&dyn ToSql; 5] = [&"acme", &u32::from(member), &"[]", &None::<String>, &horizon];
        let mut statement = db.prepare(&sql).unwrap();
        statement.query_map(&values[..], |row| row.get::<_, u32>("number")).unwrap().map(Result::unwrap).collect()
    }

    #[test]
    fn open_work_items_start_in_triage_newest_first() {
        let db = acme();
        assert_eq!(on(&db, "triage", true), [6, 5, 4, 3, 2, 1]);
        // Someone outside sees only what is filed in a public repository.
        assert_eq!(on(&db, "triage", false), [6, 5, 4, 3, 1]);
    }

    #[test]
    fn a_horizon_reads_urgent_first_then_by_rank() {
        let db = acme();
        place(&db, 1, "next", Some("V"));
        place(&db, 3, "next", Some("F"));
        place(&db, 4, "next", None);
        place(&db, 5, "now", Some("k"));
        place(&db, 6, "now", Some("x"));
        db.execute("UPDATE work_items SET urgent = 1 WHERE number = 6", []).unwrap();
        assert_eq!(on(&db, "next", true), [3, 1, 4]);
        assert_eq!(on(&db, "now", true), [6, 5]);
        assert_eq!(on(&db, "triage", true), [2]);
    }

    /// The ranks around a place, as `rank_for` reads them.
    fn neighbours(
        db: &Connection,
        horizon: &str,
        leaving_out: &str,
        upper: Option<&str>,
        lower: Option<&str>,
    ) -> (Option<String>, Option<String>) {
        db.query_row(NEIGHBOURS, rusqlite::params!["acme", horizon, leaving_out, upper, lower], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
    }

    #[test]
    fn a_place_is_found_between_its_neighbours() {
        let db = acme();
        place(&db, 1, "next", Some("F"));
        place(&db, 3, "next", Some("V"));
        place(&db, 4, "next", Some("k"));
        // Before #3 (V): after F.
        assert_eq!(neighbours(&db, "next", "wki_5", Some("V"), None), (Some("F".into()), Some("F".into())));
        // After #3: ahead of k.
        assert_eq!(neighbours(&db, "next", "wki_5", None, Some("V")).1, Some("k".into()));
        // Moving #4 itself to the bottom: it is left out.
        assert_eq!(neighbours(&db, "next", "wki_4", None, None).0, Some("V".into()));
        let rank = rank_between(Some("F"), Some("V"));
        place(&db, 5, "next", Some(&rank));
        assert_eq!(on(&db, "next", true), [1, 5, 3, 4]);
    }

    #[test]
    fn what_is_ready_leaves_out_claimed_blocked_and_others_work() {
        let db = acme();
        place(&db, 1, "next", Some("a"));
        place(&db, 3, "next", Some("b"));
        place(&db, 4, "now", Some("c"));
        place(&db, 5, "next", Some("d"));
        place(&db, 6, "next", Some("e"));
        // #4 in Now is claimed; #1 is blocked by open #2; #3 is someone else's.
        db.execute_batch(
            "INSERT INTO claims (id, item_id, actor_id, actor_name, state, ttl_minutes, created_at, expires_at)
               VALUES ('clm_1', 'wki_4', 'usr_2', 'bo', 'active', 30, '', '2999-01-01T00:00:00Z');
             UPDATE work_items SET blocked_by = '[\"wki_2\"]' WHERE number = 1;
             UPDATE work_items SET assignees = '[\"bo\"]' WHERE number = 3;",
        )
        .unwrap();
        let sql = format!(
            "SELECT number FROM work_items WHERE {OPEN_VISIBLE} AND {HORIZON} IN ('now', 'next') AND {READY}
             ORDER BY CASE {HORIZON} WHEN 'now' THEN 0 ELSE 1 END, {PLAN_ORDER}"
        );
        let ready = |who: &str| -> Vec<u32> {
            let values: [&dyn ToSql; 6] = [&"acme", &1, &"[]", &None::<String>, &"2026-10-19T00:00:00Z", &who];
            let mut statement = db.prepare(&sql).unwrap();
            statement.query_map(&values[..], |row| row.get::<_, u32>(0)).unwrap().map(Result::unwrap).collect()
        };
        assert_eq!(ready("ana"), [5, 6]);
        assert_eq!(ready("bo"), [3, 5, 6]);
        // The claim expires: #4, in Now, comes first.
        db.execute("UPDATE claims SET expires_at = '2026-10-18T00:00:00Z'", []).unwrap();
        assert_eq!(ready("ana"), [4, 5, 6]);
    }

    #[test]
    fn counts_and_later_groups_cover_every_horizon() {
        let db = acme();
        place(&db, 1, "later", Some("a"));
        place(&db, 3, "later", Some("b"));
        place(&db, 4, "set_aside", Some("c"));
        let values: [&dyn ToSql; 4] = [&"acme", &1, &"[]", &None::<String>];
        let mut counts: Vec<(String, u32)> = db
            .prepare(&COUNTS.replace("{OPEN_VISIBLE}", OPEN_VISIBLE))
            .unwrap()
            .query_map(&values[..], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        counts.sort();
        assert_eq!(counts, [("later".into(), 2), ("set_aside".into(), 1), ("triage".into(), 3)]);
        let groups: Vec<(Option<String>, u32)> = db
            .prepare(&LATER_GROUPS.replace("{OPEN_VISIBLE}", OPEN_VISIBLE))
            .unwrap()
            .query_map(&values[..], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(groups, [(Some("acme/web".into()), 2)]);
        // A deleted repository's work items are counted with the workspace's.
        db.execute("UPDATE repo_workspaces SET deleted_at = '2026-10-15T00:00:00Z' WHERE repo_id = 'rep_web'", []).unwrap();
        let groups: Vec<(Option<String>, u32)> = db
            .prepare(&LATER_GROUPS.replace("{OPEN_VISIBLE}", OPEN_VISIBLE))
            .unwrap()
            .query_map(&values[..], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(groups, [(None, 2)]);
    }

    /// The facts `FACTS` reads for work item `number`.
    fn facts(db: &Connection, number: u32) -> FactsRow {
        let ids = format!("[\"wki_{number}\"]");
        db.query_row(FACTS, [ids], |row| {
            Ok(FactsRow {
                number: row.get("number")?,
                decisions: row.get("decisions")?,
                draft_pulls: row.get("draft_pulls")?,
                commits: row.get("commits")?,
                open_pulls: row.get("open_pulls")?,
                merged_pulls: row.get("merged_pulls")?,
                landed_targets: row.get("landed_targets")?,
                active_at: row.get("active_at")?,
                standing: row.get("standing")?,
                standing_at: row.get("standing_at")?,
            })
        })
        .unwrap()
    }

    #[test]
    fn the_record_says_how_far_along_each_is() {
        let db = acme();
        db.execute_batch(
            "UPDATE work_items SET horizon = 'now', updated_at = '2026-10-01T00:00:00Z' WHERE number IN (1, 3, 4);
             INSERT INTO decisions (id, repo_id, item_id, kind, confidence, summary, created_at)
               VALUES ('dec_1', 'rep_web', 'wki_3', 'proposal', 'approved', 'Rank by fractional keys', '2026-10-10T00:00:00Z'),
                      ('dec_2', 'rep_web', 'wki_1', 'claim', 'approved', 'Scope: tests', '2026-10-11T00:00:00Z');
             INSERT INTO sessions (id, repo_id, actor_id, actor_name, harness, state, started_at, last_seen_at, item_id)
               VALUES ('ses_1', 'rep_web', 'usr_1', 'ana', 'claude_code', 'active', '2026-10-12T00:00:00Z', '2026-10-15T00:00:00Z', 'wki_4');
             INSERT INTO session_touches (session_id, repo_id, kind, value, at) VALUES ('ses_1', 'rep_web', 'commit', 'abc1234', '2026-10-15T00:00:00Z');",
        )
        .unwrap();
        // A claim's note is not a decision; nothing else has happened on #1.
        let one = facts(&db, 1);
        assert_eq!((one.hill(), one.active_at.as_deref()), (Hill::FiguringOut, Some("2026-10-11T00:00:00Z")));
        assert_eq!(facts(&db, 3).hill(), Hill::Decided);
        let four = facts(&db, 4);
        assert_eq!((four.hill(), four.active_at.as_deref()), (Hill::Building, Some("2026-10-15T00:00:00Z")));
        // Quiet: nothing since before the line.
        assert!(facts(&db, 3).progress("2026-10-14T00:00:00Z").quiet);
        assert!(!facts(&db, 4).progress("2026-10-14T00:00:00Z").quiet);
    }

    #[test]
    fn the_plan_says_what_waits_too_long() {
        let db = acme();
        db.execute_batch(
            "UPDATE work_items SET created_at = '2026-10-01T00:00:00Z' WHERE number IN (1, 3);
             UPDATE work_items SET created_at = '2026-10-18T00:00:00Z' WHERE number = 4;
             UPDATE work_items SET horizon = 'set_aside', planned_at = '2026-10-15T00:00:00Z' WHERE number = 5;
             UPDATE work_items SET horizon = 'set_aside', planned_at = '2026-08-01T00:00:00Z' WHERE number = 6;",
        )
        .unwrap();
        let values: [&dyn ToSql; 6] = [&"acme", &1, &"[]", &None::<String>, &"2026-10-12T00:00:00Z", &"2026-09-20T00:00:00Z"];
        let (waiting, recent): (u32, u32) =
            db.query_row(&WAITING.replace("{OPEN_VISIBLE}", OPEN_VISIBLE), &values[..], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
        // #1 and #3 (and #2, made with no date) in Triage since before the line; #5 set aside lately.
        assert_eq!((waiting, recent), (3, 1));
    }

    #[test]
    fn a_move_says_what_changed() {
        assert_eq!(move_note(Horizon::Triage, Horizon::Next, false, false).as_deref(), Some("moved this from Triage to Next"));
        assert_eq!(
            move_note(Horizon::Next, Horizon::Now, false, true).as_deref(),
            Some("moved this from Next to Now and marked this urgent")
        );
        assert_eq!(move_note(Horizon::Next, Horizon::Next, false, false), None);
        assert_eq!(valid_budget(Some(12.345)), Ok(Some(12.35)));
        assert!(valid_budget(Some(0.0)).is_err());
        assert!(valid_budget(Some(f64::NAN)).is_err());
    }
}
