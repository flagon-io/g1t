//! Sub-items: the work item of the same workspace a work item is a
//! sub-item of (`work_items.parent_id`, an id; numbers in and out), and
//! what a parent shows of its sub-items.
//!
//! `set_work_item_parent` (and `parent` on `open_work_item` and
//! `update_work_item`) sets it, refusing a work item the actor cannot see,
//! the item itself, or one of its own sub-items however deep. Each change
//! is `work_item.parent_changed` on the sub-item and
//! `work_item.sub_items_changed` on each parent it left or joined, which
//! also hears when one of its sub-items closes or reopens. A parent is not
//! blocked by its sub-items, and closing the last of them leaves it open.

use g1t_contracts::access::Capability;
use g1t_contracts::events::WorkItemEvent;
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, User};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use super::reading::{held_rows, select};
use super::rows::{Held, no_item};
use crate::{Work, optional};

/// The work items above `?1` (an id): its parent, that one's parent, and
/// so on, nearest first, by number. Stops after 100, which no real
/// nesting reaches and a cycle (never written) would.
pub(crate) const ANCESTORS: &str = "WITH RECURSIVE up (id, parent_id, number, depth) AS (
     SELECT p.id, p.parent_id, p.number, 1 FROM work_items c JOIN work_items p ON p.id = c.parent_id WHERE c.id = ?1
     UNION ALL
     SELECT w.id, w.parent_id, w.number, up.depth + 1 FROM work_items w JOIN up ON w.id = up.parent_id WHERE up.depth < 100)
   SELECT number FROM up WHERE number IS NOT NULL ORDER BY depth";

/// The open work items below `?1` (an id), however deep, deepest first:
/// what closing it with `sub_items` `close` closes.
pub(crate) const OPEN_DESCENDANTS: &str = "WITH RECURSIVE down (id, depth) AS (
     SELECT id, 1 FROM work_items WHERE parent_id = ?1
     UNION ALL
     SELECT w.id, down.depth + 1 FROM work_items w JOIN down ON w.parent_id = down.id WHERE down.depth < 100)
   SELECT work_items.number FROM down JOIN work_items ON work_items.id = down.id
   WHERE work_items.state = 'open' AND work_items.number IS NOT NULL
   GROUP BY work_items.id ORDER BY max(down.depth) DESC, work_items.number";

/// A work item's sub-items, by number: `?1` its id.
const SUB_ITEMS: &str = "parent_id = ?1 AND number IS NOT NULL ORDER BY number LIMIT 500";

#[derive(Deserialize)]
struct Numbered {
    number: u32,
}

/// `#1, #2 and #3`.
fn listed(numbers: &[u32]) -> String {
    let named: Vec<String> = numbers.iter().map(|n| format!("#{n}")).collect();
    match named.split_last() {
        Some((last, rest)) if !rest.is_empty() => format!("{} and {last}", rest.join(", ")),
        _ => named.join(""),
    }
}

/// Why closing work item `number` waits: `open`, its sub-items still open.
pub(crate) fn has_open_sub_items(number: u32, open: &[u32]) -> String {
    let (count, them) =
        if open.len() == 1 { ("1 open sub-item".to_owned(), "it") } else { (format!("{} open sub-items", open.len()), "them") };
    format!(
        "#{number} has {count} ({}). Say what to do with {them}: leave {them} open, close {them} too, or move {them} to another \
         work item (sub_items: leave, close or move, with move_to).",
        listed(open)
    )
}

/// `Ok` when `actor` may change `held`: theirs, or one they may triage.
fn manageable(actor: &User, held: &Held) -> Outcome<()> {
    let capability = if held.item.owner().id == actor.id { Capability::Read } else { Capability::Triage };
    held.allowed(Some(actor), capability)
}

impl Work {
    async fn numbers_of(&self, sql: &str, id: &str) -> Result<Vec<u32>> {
        Ok(self.db.prepare(sql).bind(&[id.into()])?.all().await?.results::<Numbered>()?.into_iter().map(|row| row.number).collect())
    }

    /// `held`'s sub-items, whoever is asking.
    async fn sub_items_of(&self, held: &Held) -> Result<Vec<Held>> {
        held_rows(&self.db.prepare(select(SUB_ITEMS)).bind(&[held.item.id.as_str().into()])?.all().await?)
    }

    /// The work item `held` is a sub-item of and its sub-items, as far as
    /// `viewer` may see them.
    pub(super) async fn parent_and_sub_items(&self, held: &Held, viewer: Option<&User>) -> Result<(Option<ItemBrief>, Vec<ItemBrief>)> {
        let brief = |item: Held| ItemBrief { number: item.item.number, title: item.item.title, state: item.item.state };
        let parent = match held.item.parent {
            Some(number) => self.visible_numbered(&held.item.workspace, &[number], viewer).await?.into_iter().next().map(brief),
            None => None,
        };
        let sub_items = if held.item.sub_item_progress.is_some() {
            self.sub_items_of(held).await?.into_iter().filter(|item| item.may(viewer, Capability::Read)).map(brief).collect()
        } else {
            Vec::new()
        };
        Ok((parent, sub_items))
    }

    /// Work item `number` of `held`'s workspace as `held`'s new parent, or
    /// why it cannot be: one `actor` may not see is refused as one that is
    /// not there.
    async fn checked_parent(&self, held: &Held, actor: &User, number: u32) -> Result<Outcome<Held>> {
        let found = self.item(&held.item.workspace, number).await?.filter(|parent| parent.may(Some(actor), Capability::Read));
        let Some(parent) = found else {
            return Ok(Outcome::fail(FailureCode::Invalid, format!("#{number} is not a work item in this workspace.")));
        };
        let ancestors = self.numbers_of(ANCESTORS, &parent.item.id).await?;
        Ok(match check_parent(held.item.number, number, &ancestors) {
            Ok(()) => Outcome::Ok(parent),
            Err(message) => Outcome::fail(FailureCode::Invalid, message),
        })
    }

    /// Checks `parent` (a number, 0 for none) as the parent of a work item
    /// about to be opened in `workspace` by `actor`: its id, if any.
    pub(super) async fn parent_for_new(&self, workspace: &str, actor: &User, parent: Option<u32>) -> Result<Outcome<Option<String>>> {
        let Some(number) = parent.filter(|number| *number > 0) else {
            return Ok(Outcome::Ok(None));
        };
        Ok(match self.item(workspace, number).await?.filter(|parent| parent.may(Some(actor), Capability::Read)) {
            Some(parent) => Outcome::Ok(Some(parent.item.id)),
            None => Outcome::fail(FailureCode::Invalid, format!("#{number} is not a work item in this workspace.")),
        })
    }

    /// Makes `held` a sub-item of `parent` (none: of nothing), as `actor`,
    /// who may manage it; with `only_from`, only when that is its parent
    /// now. Returns it as it is after.
    pub(super) async fn reparent(&self, held: &Held, actor: &User, parent: Option<u32>, only_from: Option<u32>) -> Result<Outcome<Held>> {
        let number = held.item.number;
        if let Some(from) = only_from {
            if held.item.parent != Some(from) {
                return Ok(Outcome::fail(FailureCode::Invalid, format!("#{number} is not a sub-item of #{from}.")));
            }
        }
        if parent == held.item.parent {
            return Ok(Outcome::Ok(held.clone()));
        }
        let joined = match parent {
            Some(number) => Some(check!(self.checked_parent(held, actor, number).await?)),
            None => None,
        };
        let left = match held.item.parent {
            Some(number) => self.item(&held.item.workspace, number).await?,
            None => None,
        };
        let now = rfc3339(now_ms());
        self.db
            .prepare("UPDATE work_items SET parent_id = ?, updated_at = ? WHERE id = ?")
            .bind(&[optional(&joined.as_ref().map(|parent| parent.item.id.clone())), now.as_str().into(), held.item.id.as_str().into()])?
            .run()
            .await?;
        let Some(after) = self.item_by_id(&held.item.id).await? else {
            return Ok(no_item());
        };
        self.publish_item(
            "work_item.parent_changed",
            &after,
            Some(actor),
            WorkItemEvent { parent, from_parent: held.item.parent, ..Self::item_event(&after) },
        )
        .await?;
        match (&left, &joined) {
            (Some(left), Some(joined)) => {
                let text = format!("moved this from #{} to #{}", left.item.number, joined.item.number);
                self.note_item(&after.item.id, actor, &text).await?;
            }
            (None, Some(joined)) => {
                self.note_item(&after.item.id, actor, &format!("added this as a sub-item of #{}", joined.item.number)).await?
            }
            (Some(left), None) => self.note_item(&after.item.id, actor, &format!("removed this from #{}", left.item.number)).await?,
            (None, None) => {}
        }
        if let Some(left) = left {
            self.note_item(&left.item.id, actor, &format!("removed #{number} from this")).await?;
            self.sub_items_changed(&left.item.id, number, "removed", actor).await?;
        }
        if let Some(joined) = joined {
            self.note_item(&joined.item.id, actor, &format!("added #{number} as a sub-item")).await?;
            self.sub_items_changed(&joined.item.id, number, "added", actor).await?;
        }
        Ok(Outcome::Ok(after))
    }

    /// `held` was just opened as a sub-item of the work item of id
    /// `parent_id`: the parent says so.
    pub(super) async fn sub_item_opened(&self, parent_id: &str, held: &Held, actor: &User) -> Result<()> {
        let number = held.item.number;
        self.note_item(parent_id, actor, &format!("added #{number} as a sub-item")).await?;
        self.sub_items_changed(parent_id, number, "added", actor).await?;
        Ok(())
    }

    /// Says on the parent of id `parent_id` that its sub-item `number`
    /// changed (`added`, `removed`, `closed` or `reopened`), with how far
    /// along its sub-items are now; returns that.
    async fn sub_items_changed(&self, parent_id: &str, number: u32, change: &'static str, actor: &User) -> Result<Option<SubItemProgress>> {
        let Some(parent) = self.item_by_id(parent_id).await? else {
            return Ok(None);
        };
        let progress = parent.item.sub_item_progress;
        self.publish_item(
            "work_item.sub_items_changed",
            &parent,
            Some(actor),
            WorkItemEvent { sub_item: Some(number), change: Some(change), progress, ..Self::item_event(&parent) },
        )
        .await?;
        Ok(progress)
    }

    /// `held` closed or reopened (`closed`): its parent, if it has one,
    /// hears. When that closes the last of them, the parent says so, and
    /// stays open. Never fails what caused it: a problem is logged.
    pub(crate) async fn sub_item_resolved(&self, held: &Held, actor: &User, closed: bool) {
        let Some(parent) = held.item.parent else {
            return;
        };
        let number = held.item.number;
        let told = async {
            let Some(found) = self.item(&held.item.workspace, parent).await? else {
                return Ok(());
            };
            let change = if closed { "closed" } else { "reopened" };
            let progress = self.sub_items_changed(&found.item.id, number, change, actor).await?;
            if closed && found.item.state == State::Open && progress.is_some_and(|progress| progress.finished()) {
                let total = progress.map_or(0, |progress| progress.total);
                let all = if total == 1 { "its only sub-item is done".to_owned() } else { format!("all {total} sub-items are done") };
                let text = format!("closed #{number}, the last open sub-item: {all}. This stays open until someone closes it.");
                self.note_item(&found.item.id, actor, &text).await?;
            }
            Ok::<(), worker::Error>(())
        };
        if let Err(error) = told.await {
            worker::console_error!("#{number} closed or reopened, but its parent #{parent} was not told: {error}");
        }
    }

    /// Before closing `held` (as `actor`): what happens to its sub-items
    /// that are still open. Without being told, it is refused while it has
    /// some; `move` moves them now, `close` names them for closing after
    /// (`closing`, deepest first), and `leave` leaves them.
    pub(super) async fn before_closing(
        &self,
        held: &Held,
        actor: &User,
        asked: Option<OpenSubItems>,
        move_to: Option<u32>,
    ) -> Result<Outcome<Vec<Held>>> {
        if held.item.sub_item_progress.is_none_or(|progress| progress.finished()) {
            return Ok(Outcome::Ok(Vec::new()));
        }
        let open: Vec<Held> = self.sub_items_of(held).await?.into_iter().filter(|item| item.item.state == State::Open).collect();
        if open.is_empty() {
            return Ok(Outcome::Ok(Vec::new()));
        }
        let numbers: Vec<u32> = open.iter().map(|item| item.item.number).collect();
        match asked {
            None => Ok(Outcome::fail(FailureCode::Conflict, has_open_sub_items(held.item.number, &numbers))),
            Some(OpenSubItems::Leave) => Ok(Outcome::Ok(Vec::new())),
            Some(OpenSubItems::Move) => {
                let Some(to) = move_to.filter(|to| *to > 0) else {
                    return Ok(Outcome::fail(FailureCode::Invalid, "Say which work item they move to (move_to)."));
                };
                if to == held.item.number {
                    return Ok(Outcome::fail(FailureCode::Invalid, format!("#{to} is the work item being closed.")));
                }
                // Every one checked before any moves.
                for item in &open {
                    check!(manageable(actor, item));
                    check!(self.checked_parent(item, actor, to).await?);
                }
                for item in &open {
                    check!(self.reparent(item, actor, Some(to), None).await?);
                }
                Ok(Outcome::Ok(Vec::new()))
            }
            Some(OpenSubItems::Close) => {
                let below = self.numbers_of(OPEN_DESCENDANTS, &held.item.id).await?;
                let mut closing = Vec::new();
                for number in below {
                    if let Some(item) = self.item(&held.item.workspace, number).await? {
                        check!(manageable(actor, &item));
                        closing.push(item);
                    }
                }
                Ok(Outcome::Ok(closing))
            }
        }
    }

    // --- RPC methods ----------------------------------------------------------

    pub(crate) async fn set_work_item_parent(&self, a: SetParentArgs) -> Result<Outcome<WorkItem>> {
        let held = check!(self.manageable_item(&a.actor, &a.workspace, a.number).await?);
        let after = check!(self.reparent(&held, &a.actor, a.parent.filter(|number| *number > 0), a.only_from).await?);
        Ok(Outcome::Ok(after.shown(Some(&a.actor))))
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::*;
    use crate::migrated::database;

    /// `acme`'s #1 > #2 > #3, and #4 beside #2, with #2 closed; #5 alone.
    fn parent_and_sub_items() -> Connection {
        let db = database();
        db.execute_batch(
            "INSERT INTO work_items (id, workspace, number, title, body, state, author_id, author_name, created_at, updated_at, parent_id)
             VALUES ('wki_1', 'acme', 1, 'Epic', '', 'open', 'usr_1', 'ana', '', '', NULL),
                    ('wki_2', 'acme', 2, 'Part', '', 'closed', 'usr_1', 'ana', '', '', 'wki_1'),
                    ('wki_3', 'acme', 3, 'Piece', '', 'open', 'usr_1', 'ana', '', '', 'wki_2'),
                    ('wki_4', 'acme', 4, 'Other part', '', 'open', 'usr_1', 'ana', '', '', 'wki_1'),
                    ('wki_5', 'acme', 5, 'Alone', '', 'open', 'usr_1', 'ana', '', '', NULL);",
        )
        .unwrap();
        db
    }

    fn numbers(db: &Connection, sql: &str, id: &str) -> Vec<u32> {
        let mut statement = db.prepare(sql).unwrap();
        statement.query_map([id], |row| row.get(0)).unwrap().map(std::result::Result::unwrap).collect()
    }

    #[test]
    fn ancestors_are_read_nearest_first() {
        let db = parent_and_sub_items();
        assert_eq!(numbers(&db, ANCESTORS, "wki_3"), vec![2, 1]);
        assert_eq!(numbers(&db, ANCESTORS, "wki_1"), Vec::<u32>::new());
        // What setting #1's parent to #3 is checked against.
        assert!(check_parent(1, 3, &numbers(&db, ANCESTORS, "wki_3")).is_err());
        assert!(check_parent(5, 3, &numbers(&db, ANCESTORS, "wki_3")).is_ok());
    }

    #[test]
    fn closing_with_close_takes_the_open_ones_below_deepest_first() {
        let db = parent_and_sub_items();
        // #2 is closed, but #3 under it is open.
        assert_eq!(numbers(&db, OPEN_DESCENDANTS, "wki_1"), vec![3, 4]);
        assert_eq!(numbers(&db, OPEN_DESCENDANTS, "wki_5"), Vec::<u32>::new());
    }

    #[test]
    fn a_work_item_is_read_with_its_parent_and_how_far_along_its_sub_items_are() {
        let db = parent_and_sub_items();
        let sql = format!("SELECT parent_number, sub_total, sub_done FROM ({}) ORDER BY number", select("workspace = 'acme'"));
        let mut statement = db.prepare(&sql).unwrap();
        let rows: Vec<(Option<u32>, u32, u32)> =
            statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).unwrap().map(std::result::Result::unwrap).collect();
        assert_eq!(rows, vec![(None, 2, 1), (Some(1), 1, 0), (Some(2), 0, 0), (Some(1), 0, 0), (None, 0, 0)]);
    }

    #[test]
    fn closing_a_parent_with_open_sub_items_asks_what_to_do_with_them() {
        assert_eq!(
            has_open_sub_items(212, &[230, 231, 233]),
            "#212 has 3 open sub-items (#230, #231 and #233). Say what to do with them: leave them open, close them too, or \
             move them to another work item (sub_items: leave, close or move, with move_to)."
        );
        assert!(has_open_sub_items(212, &[230]).starts_with("#212 has 1 open sub-item (#230). Say what to do with it: leave it open"));
    }
}
