//! Ticking a box of a task list (`g1t_contracts::work::tasks`):
//! `check_work_item_task` on a work item's body and `check_pull_task` on a
//! pull request's description. Whoever may change the text may tick its
//! boxes.
//!
//! Only the character between the box's brackets changes, and the write
//! is a compare and swap on the whole body: when someone else changed it
//! in between (ticked another box), the body is read again and the box
//! found again, so neither change is lost.

use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome};
use g1t_kit::now_ms;
use worker::Result;

use super::rows::no_item;
use crate::rows::ValueRow;
use crate::{UNVERIFIED, Work};

/// How many times a box is ticked against a body someone else keeps
/// changing before giving up.
const ATTEMPTS: usize = 5;

/// A work item's body: `?1` its id.
const ITEM_BODY: &str = "SELECT body AS value FROM work_items WHERE id = ?1";

/// A work item's body changed from `?4` to `?1` at `?2`, only if it is
/// still `?4`: `?3` its id.
const ITEM_WRITE: &str = "UPDATE work_items SET body = ?1, updated_at = ?2 WHERE id = ?3 AND body = ?4 RETURNING id AS value";

/// A pull request's description, empty for none: `?1` its id.
const PULL_BODY: &str = "SELECT COALESCE(body, '') AS value FROM pulls WHERE id = ?1";

/// As [`ITEM_WRITE`], for a pull request's description.
const PULL_WRITE: &str =
    "UPDATE pulls SET body = ?1, updated_at = ?2 WHERE id = ?3 AND COALESCE(body, '') = ?4 RETURNING id AS value";

/// What ticking a box in a body comes to: the box, and the body after,
/// unless it already was as asked.
struct Ticked {
    task: Task,
    after: Option<String>,
    done: u32,
    total: u32,
}

/// Ticks the box `check` names in `body`, or says why there is none.
fn tick(body: &str, check: &TaskCheck) -> std::result::Result<Ticked, (FailureCode, String)> {
    let tasks = task_list(body);
    let task = pick_task(&tasks, check)?.clone();
    let total = tasks.len() as u32;
    let done = tasks.iter().filter(|task| task.checked).count() as u32;
    if task.checked == check.checked {
        return Ok(Ticked { task, after: None, done, total });
    }
    let after = set_task(body, &task, check.checked);
    let done = if check.checked { done + 1 } else { done - 1 };
    Ok(Ticked { task: Task { checked: check.checked, ..task }, after: Some(after), done, total })
}

impl Work {
    /// `check_work_item_task`: see [`CheckWorkItemTaskArgs`].
    pub(crate) async fn check_work_item_task(&self, a: CheckWorkItemTaskArgs) -> Result<Outcome<CheckedTask>> {
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, UNVERIFIED));
        }
        let held = check!(self.manageable_item(&a.actor, &a.workspace, a.number).await?);
        let Some(checked) = self.check_task((ITEM_BODY, ITEM_WRITE), &held.item.id, &a.check).await? else {
            return Ok(no_item());
        };
        let checked = check!(checked);
        if checked.changed {
            let Some(held) = self.item_by_id(&held.item.id).await? else {
                return Ok(no_item());
            };
            self.publish_item("work_item.updated", &held, Some(&a.actor), Self::item_event(&held)).await?;
        }
        Ok(Outcome::Ok(checked))
    }

    /// `check_pull_task`: see [`CheckPullTaskArgs`]. A merged or closed
    /// pull request's boxes can still be ticked: a checklist is often
    /// finished after the merge.
    pub(crate) async fn check_pull_task(&self, a: CheckPullTaskArgs) -> Result<Outcome<CheckedTask>> {
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, UNVERIFIED));
        }
        let pull = check!(self.managed_pull(&a.actor, &a.repo, a.number).await?);
        Ok(self
            .check_task((PULL_BODY, PULL_WRITE), &pull.id, &a.check)
            .await?
            .unwrap_or_else(|| Outcome::fail(FailureCode::NotFound, "That pull request could not be found.")))
    }

    /// Ticks the box `check` names in the body `sql` reads and writes,
    /// against the body as it is; none when the row is gone.
    async fn check_task(&self, (read, write): (&str, &str), id: &str, check: &TaskCheck) -> Result<Option<Outcome<CheckedTask>>> {
        for _ in 0..ATTEMPTS {
            let Some(ValueRow { value: body }) = self.db.prepare(read).bind(&[id.into()])?.first::<ValueRow>(None).await? else {
                return Ok(None);
            };
            let ticked = match tick(&body, check) {
                Ok(ticked) => ticked,
                Err((code, message)) => return Ok(Some(Outcome::fail(code, message))),
            };
            let Ticked { task, after, done, total } = ticked;
            let Some(after) = after else {
                return Ok(Some(Outcome::Ok(CheckedTask { task, changed: false, body, done, total })));
            };
            let written = self
                .db
                .prepare(write)
                .bind(&[after.as_str().into(), rfc3339(now_ms()).into(), id.into(), body.as_str().into()])?
                .first::<ValueRow>(None)
                .await?;
            if written.is_some() {
                return Ok(Some(Outcome::Ok(CheckedTask { task, changed: true, body: after, done, total })));
            }
        }
        Ok(Some(Outcome::fail(
            FailureCode::Conflict,
            "The text kept changing while the box was being ticked. Try again in a moment.",
        )))
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::{Connection, OptionalExtension, params};

    use super::*;
    use crate::migrated::database;

    fn read(db: &Connection, sql: &str, id: &str) -> String {
        db.query_row(sql, params![id], |row| row.get(0)).unwrap()
    }

    /// Ticks as `check_task` does, but with the body read at `seen`: what
    /// someone whose read came before another's write would do.
    fn tick_from(db: &Connection, (read_sql, write_sql): (&str, &str), id: &str, mut seen: String, check: &TaskCheck) -> Option<Task> {
        for _ in 0..ATTEMPTS {
            let ticked = tick(&seen, check).ok()?;
            let Some(after) = ticked.after else { return Some(ticked.task) };
            let written: Option<String> = db
                .query_row(write_sql, params![after, "2026-10-21", id, seen], |row| row.get(0))
                .optional()
                .unwrap();
            if written.is_some() {
                return Some(ticked.task);
            }
            seen = read(db, read_sql, id);
        }
        None
    }

    fn box_number(task: u32, checked: bool, expected: &str) -> TaskCheck {
        TaskCheck { task: Some(task), text: None, checked, expected: Some(expected.to_owned()) }
    }

    #[test]
    fn two_people_ticking_at_once_both_keep_their_box() {
        let db = database();
        db.execute_batch(
            "INSERT INTO work_items (id, workspace, number, title, body, author_id, author_name, created_at, updated_at)
             VALUES ('itm_1', 'acme', 12, 'Launch', 'Steps:\n- [ ] docs\n- [ ] tests\n- [x] ship', 'usr_1', 'ana', '', '');
             INSERT INTO pulls (id, repo_id, number, title, agent, runtime, author_id, author_name, created_at, updated_at)
             VALUES ('pr_1', 'rep_web', 13, 'Launch', 'ana', 'external', 'usr_1', 'ana', '', '');",
        )
        .unwrap();
        // Both read the body; Ana ticks docs and writes first, then Bo's
        // write of tests finds it changed, reads it again and ticks tests
        // in that.
        let seen = read(&db, ITEM_BODY, "itm_1");
        let ana = tick_from(&db, (ITEM_BODY, ITEM_WRITE), "itm_1", seen.clone(), &box_number(1, true, "docs")).unwrap();
        let bo = tick_from(&db, (ITEM_BODY, ITEM_WRITE), "itm_1", seen, &box_number(2, true, "tests")).unwrap();
        assert_eq!((ana.number, bo.number), (1, 2));
        assert_eq!(read(&db, ITEM_BODY, "itm_1"), "Steps:\n- [x] docs\n- [x] tests\n- [x] ship");

        // Someone adds a box above while Bo unticks ship: his box is found
        // where it went.
        let seen = read(&db, ITEM_BODY, "itm_1");
        db.execute("UPDATE work_items SET body = 'Steps:\n- [ ] plan\n- [x] docs\n- [x] tests\n- [x] ship' WHERE id = 'itm_1'", []).unwrap();
        let bo = tick_from(&db, (ITEM_BODY, ITEM_WRITE), "itm_1", seen, &box_number(3, false, "ship")).unwrap();
        assert_eq!(bo.number, 4);
        assert_eq!(read(&db, ITEM_BODY, "itm_1"), "Steps:\n- [ ] plan\n- [x] docs\n- [x] tests\n- [ ] ship");

        // A pull request with no description has no boxes; one with them
        // is ticked the same way.
        assert_eq!(read(&db, PULL_BODY, "pr_1"), "");
        assert!(tick(&read(&db, PULL_BODY, "pr_1"), &box_number(1, true, "docs")).is_err());
        db.execute("UPDATE pulls SET body = '- [ ] reviewed' WHERE id = 'pr_1'", []).unwrap();
        let seen = read(&db, PULL_BODY, "pr_1");
        tick_from(&db, (PULL_BODY, PULL_WRITE), "pr_1", seen, &box_number(1, true, "reviewed")).unwrap();
        assert_eq!(read(&db, PULL_BODY, "pr_1"), "- [x] reviewed");
    }

    #[test]
    fn a_box_already_as_asked_writes_nothing() {
        let ticked = tick("- [x] done\n- [ ] not", &box_number(1, true, "done")).ok().unwrap();
        assert!(ticked.after.is_none() && ticked.task.checked);
        assert_eq!((ticked.done, ticked.total), (1, 2));
        let ticked = tick("- [x] done\n- [ ] not", &box_number(2, true, "not")).ok().unwrap();
        assert_eq!(ticked.after.as_deref(), Some("- [x] done\n- [x] not"));
        assert_eq!((ticked.done, ticked.total), (2, 2));
    }
}
