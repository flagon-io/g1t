//! The plan (`g1t_contracts::work::plan`): where each open work item of a
//! workspace stands, its place there, and what to take next
//! (migrations/0056_plan.sql). `plan_work_item` moves one, `get_plan`
//! reads a workspace's within its bounds, `next_work_item` picks what is
//! ready, and `configure_plan` sets Now's cap. `list_work_items` with a
//! `horizon` reads one horizon in the plan's order (reading.rs).

use g1t_contracts::access::{self, Capability};
use g1t_contracts::events::WorkItemEvent;
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, User, Viewer};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use super::rows::{Held, ITEM_COLUMNS, ItemRow, no_item, workspace_of};
use crate::{Work, optional};

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

/// Later, by the repository each work item is filed in.
const LATER_GROUPS: &str = "SELECT (SELECT COALESCE(rw.path, o.path) FROM work_item_repos o
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
        .map(|user| user.grants.iter().filter(|grant| grant.workspace.eq_ignore_ascii_case(workspace)).map(|grant| grant.repo_id.as_str()).collect())
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
        Ok(self.db.prepare("SELECT rank FROM work_items WHERE id = ?").bind(&[id.into()])?.first::<Rank>(None).await?.and_then(|row| row.rank))
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
        let commits = (horizon.committed() && reranked) || (from.committed() && horizon != from) || a.urgent.is_some_and(|urgent| urgent != held.item.urgent);
        if commits && !access::can_item(Some(&a.actor), &workspace, None, Capability::ManageLabels) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                format!("Deciding what is in Now takes the right to manage milestones. {}", access::needs_on_item(Capability::ManageLabels, &workspace)),
            ));
        }
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
                "UPDATE work_items SET horizon = ?, rank = ?, appetite = ?, budget_usd = ?, urgent = ?, planned_at = ?
                 WHERE id = ? AND state = 'open'",
            )
            .bind(&[
                horizon.as_str().into(),
                optional(&rank),
                optional(&appetite.map(|appetite| appetite.as_str().to_owned())),
                budget.map_or(JsValue::NULL, JsValue::from),
                u32::from(urgent).into(),
                optional(&planned_at),
                held.item.id.as_str().into(),
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
                    return Ok(Outcome::Ok(Plan { workspace, now_cap: self.now_cap(&repo.namespace.to_lowercase()).await?, ..Plan::default() }));
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
        let statements = vec![
            self.db.prepare(open_items(&format!("{HORIZON} = 'now'"), crate::LIST_PAGE)).bind(&bound(None))?,
            self.db.prepare(open_items(&format!("{HORIZON} = 'next'"), shown)).bind(&bound(None))?,
            self.db.prepare(COUNTS.replace("{OPEN_VISIBLE}", OPEN_VISIBLE)).bind(&bound(None))?,
            self.db.prepare(LATER_GROUPS.replace("{OPEN_VISIBLE}", OPEN_VISIBLE)).bind(&bound(None))?,
        ];
        let results = self.timing.db(4, self.db.batch(statements)).await?;
        let rows = |index: usize| results.get(index).ok_or_else(|| worker::Error::RustError("short batch".into()));
        let now = shown_rows(rows(0)?.results::<ItemRow>()?, &a.viewer);
        let next = shown_rows(rows(1)?.results::<ItemRow>()?, &a.viewer);
        let counts = rows(2)?.results::<Count>()?;
        let total = |horizon: Horizon| {
            counts.iter().filter(|row| row.horizon.as_deref().and_then(Horizon::parse).unwrap_or_default() == horizon).map(|row| row.count).sum()
        };
        let later = rows(3)?.results::<Group>()?.into_iter().map(|group| PlanGroup { repo: group.repo, count: group.count }).collect();
        Ok(Outcome::Ok(Plan {
            now_cap: self.now_cap(&workspace).await?,
            now,
            next,
            next_total: total(Horizon::Next),
            triage_total: total(Horizon::Triage),
            later_total: total(Horizon::Later),
            later,
            set_aside_total: total(Horizon::SetAside),
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
            .bind(&[
                workspace.as_str().into(),
                member,
                granted,
                optional(&repo_id),
                rfc3339(now_ms()).into(),
                username.into(),
            ])?
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
    fn neighbours(db: &Connection, horizon: &str, leaving_out: &str, upper: Option<&str>, lower: Option<&str>) -> (Option<String>, Option<String>) {
        db.query_row(NEIGHBOURS, rusqlite::params!["acme", horizon, leaving_out, upper, lower], |row| Ok((row.get(0)?, row.get(1)?))).unwrap()
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
    }

    #[test]
    fn a_move_says_what_changed() {
        assert_eq!(move_note(Horizon::Triage, Horizon::Next, false, false).as_deref(), Some("moved this from Triage to Next"));
        assert_eq!(move_note(Horizon::Next, Horizon::Now, false, true).as_deref(), Some("moved this from Next to Now and marked this urgent"));
        assert_eq!(move_note(Horizon::Next, Horizon::Next, false, false), None);
        assert_eq!(valid_budget(Some(12.345)), Ok(Some(12.35)));
        assert!(valid_budget(Some(0.0)).is_err());
        assert!(valid_budget(Some(f64::NAN)).is_err());
    }
}
