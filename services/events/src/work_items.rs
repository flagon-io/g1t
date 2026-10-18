//! Issues became work items (migrations/0013_work_items.sql): what this
//! service kept by a repository's issue number is rewritten to the work
//! item it became when the work service announces where each went
//! (`work.migrated`, a page of `MigratedItem`s at a time).
//!
//! Each page is recorded in `work_migrated`, then:
//!
//! - inbox threads `<repo_id>#<number>` become `item:<item_id>`, with the
//!   work item's workspace and number; a person who already has the work
//!   item's thread keeps that one, with the old one's history;
//! - subscriptions follow their threads the same way;
//! - the log's `issue.*` events become `work_item.*`, and its events about
//!   an issue (comments on it, and `issue` / `otherIssue` in coordination
//!   and pull request events) name the work item and its number.
//!
//! Every statement leaves what it already rewrote alone, so a page
//! delivered again, or out of order, changes nothing more. The cron
//! catches up on pages that never arrived ([`catch_up`]).

use g1t_contracts::events::{Event, WorkMigrated};
use worker::{D1Database, D1PreparedStatement, Fetcher, Result};

/// The issue events of the log, by their old names.
pub const ISSUE_EVENTS: [&str; 9] = [
    "issue.opened",
    "issue.updated",
    "issue.assigned",
    "issue.labeled",
    "issue.unlabeled",
    "issue.milestoned",
    "issue.demilestoned",
    "issue.closed",
    "issue.reopened",
];

/// What one page does, in order: `?1` the event's id, `?2` its items as
/// JSON, `?3` [`ISSUE_EVENTS`] as JSON.
pub const MOVED: [&str; 12] = [
    // The page, kept.
    "INSERT OR REPLACE INTO work_migrated (repo_id, legacy_number, workspace, number, item_id, event_id)
     SELECT json_extract(value, '$.repoId'), json_extract(value, '$.legacyNumber'), lower(json_extract(value, '$.workspace')),
            json_extract(value, '$.number'), json_extract(value, '$.itemId'), ?1
     FROM json_each(?2)",
    // Threads the work item's own events started before it had its number.
    "UPDATE inbox_items SET number = m.number, workspace = m.workspace
     FROM work_migrated m
     WHERE m.event_id = ?1 AND inbox_items.thread = 'item:' || m.item_id AND inbox_items.number IS NOT m.number",
    // Someone with both threads: the old one's history joins the new one.
    "UPDATE inbox_activity SET item_id = n.id
     FROM work_migrated m, inbox_items o, inbox_items n
     WHERE m.event_id = ?1 AND o.thread = m.repo_id || '#' || m.legacy_number
       AND n.username = o.username AND n.thread = 'item:' || m.item_id AND inbox_activity.item_id = o.id",
    "UPDATE inbox_items AS n SET activity = n.activity + o.activity, created_at = min(n.created_at, o.created_at),
       saved = max(n.saved, o.saved)
     FROM work_migrated m, inbox_items o
     WHERE m.event_id = ?1 AND o.thread = m.repo_id || '#' || m.legacy_number
       AND n.username = o.username AND n.thread = 'item:' || m.item_id",
    "DELETE FROM inbox_items WHERE id IN (
       SELECT o.id FROM work_migrated m
       JOIN inbox_items o ON o.thread = m.repo_id || '#' || m.legacy_number
       JOIN inbox_items n ON n.username = o.username AND n.thread = 'item:' || m.item_id
       WHERE m.event_id = ?1)",
    // The rest of the old threads become the work item's.
    "UPDATE inbox_items SET thread = 'item:' || m.item_id, subject = 'item', number = m.number, workspace = m.workspace
     FROM work_migrated m
     WHERE m.event_id = ?1 AND inbox_items.thread = m.repo_id || '#' || m.legacy_number",
    // Subscriptions: one chosen on the work item already stands.
    "DELETE FROM inbox_subscriptions WHERE (thread, username) IN (
       SELECT o.thread, o.username FROM work_migrated m
       JOIN inbox_subscriptions o ON o.thread = m.repo_id || '#' || m.legacy_number
       JOIN inbox_subscriptions n ON n.username = o.username AND n.thread = 'item:' || m.item_id
       WHERE m.event_id = ?1)",
    "UPDATE inbox_subscriptions SET thread = 'item:' || m.item_id
     FROM work_migrated m
     WHERE m.event_id = ?1 AND inbox_subscriptions.thread = m.repo_id || '#' || m.legacy_number",
    // The log. Each statement reads the page's repositories' events once,
    // and finds each one's work item by its repository and old number.
    "UPDATE events SET type = 'work_item.' || substr(type, 7),
       data = json_set(json_remove(data, '$.issueId', '$.repoId'),
         '$.itemId', (SELECT m.item_id FROM work_migrated m WHERE m.repo_id = events.repo_id AND m.legacy_number = json_extract(events.data, '$.number')),
         '$.workspace', (SELECT m.workspace FROM work_migrated m WHERE m.repo_id = events.repo_id AND m.legacy_number = json_extract(events.data, '$.number')),
         '$.repoIds', json_array(events.repo_id),
         '$.number', (SELECT m.number FROM work_migrated m WHERE m.repo_id = events.repo_id AND m.legacy_number = json_extract(events.data, '$.number')))
     WHERE repo_id IN (SELECT repo_id FROM work_migrated WHERE event_id = ?1)
       AND type IN (SELECT value FROM json_each(?3))
       AND EXISTS (SELECT 1 FROM work_migrated m WHERE m.repo_id = events.repo_id AND m.legacy_number = json_extract(events.data, '$.number'))",
    // Comments on an issue: on no pull request, and naming no work item yet.
    "UPDATE events SET
       data = json_set(data,
         '$.itemId', (SELECT m.item_id FROM work_migrated m WHERE m.repo_id = events.repo_id AND m.legacy_number = json_extract(events.data, '$.number')),
         '$.workspace', (SELECT m.workspace FROM work_migrated m WHERE m.repo_id = events.repo_id AND m.legacy_number = json_extract(events.data, '$.number')),
         '$.repoIds', json_array(events.repo_id),
         '$.number', (SELECT m.number FROM work_migrated m WHERE m.repo_id = events.repo_id AND m.legacy_number = json_extract(events.data, '$.number')))
     WHERE repo_id IN (SELECT repo_id FROM work_migrated WHERE event_id = ?1)
       AND type IN ('comment.created', 'comment.edited', 'comment.deleted')
       AND json_extract(data, '$.pullId') IS NULL AND json_extract(data, '$.itemId') IS NULL
       AND EXISTS (SELECT 1 FROM work_migrated m WHERE m.repo_id = events.repo_id AND m.legacy_number = json_extract(events.data, '$.number'))",
    // What names an issue it is about, or overlaps with: `issue`, `otherIssue`.
    "UPDATE events SET
       data = json_set(json_remove(data, '$.issue'),
         '$.item', (SELECT m.number FROM work_migrated m WHERE m.repo_id = events.repo_id AND m.legacy_number = json_extract(events.data, '$.issue')))
     WHERE repo_id IN (SELECT repo_id FROM work_migrated WHERE event_id = ?1)
       AND json_extract(data, '$.issue') IS NOT NULL
       AND EXISTS (SELECT 1 FROM work_migrated m WHERE m.repo_id = events.repo_id AND m.legacy_number = json_extract(events.data, '$.issue'))",
    "UPDATE events SET
       data = json_set(json_remove(data, '$.otherIssue'),
         '$.otherItem', (SELECT m.number FROM work_migrated m WHERE m.repo_id = events.repo_id AND m.legacy_number = json_extract(events.data, '$.otherIssue')))
     WHERE repo_id IN (SELECT repo_id FROM work_migrated WHERE event_id = ?1)
       AND json_extract(data, '$.otherIssue') IS NOT NULL
       AND EXISTS (SELECT 1 FROM work_migrated m WHERE m.repo_id = events.repo_id AND m.legacy_number = json_extract(events.data, '$.otherIssue'))",
];

/// How many of `?1`, `?2`, `?3` a statement reads: D1 takes no more values
/// than it has.
fn bound(sql: &str) -> usize {
    (1..=3).rev().find(|n| sql.contains(&format!("?{n}"))).unwrap_or(0)
}

/// The statements a `work.migrated` event from the work service calls for;
/// none for any other event.
pub fn moved(db: &D1Database, event: &Event) -> Result<Vec<D1PreparedStatement>> {
    if event.kind != "work.migrated" || event.source != "work" {
        return Ok(Vec::new());
    }
    let Ok(page) = serde_json::from_value::<WorkMigrated>(event.data.clone()) else {
        worker::console_error!("work.migrated {} could not be read", event.id);
        return Ok(Vec::new());
    };
    if event.data["truncated"].as_bool() == Some(true) {
        worker::console_error!("work.migrated {} (page {}) was cut short: some issue numbers are left as they were", event.id, page.page);
    }
    page_statements(db, &event.id, &page)
}

/// The statements for one page, recorded as `id`'s.
fn page_statements(db: &D1Database, id: &str, page: &WorkMigrated) -> Result<Vec<D1PreparedStatement>> {
    if page.items.is_empty() {
        return Ok(Vec::new());
    }
    let items = serde_json::to_string(&page.items)?;
    let issue_events = serde_json::to_string(&ISSUE_EVENTS)?;
    let values: [worker::wasm_bindgen::JsValue; 3] = [id.into(), items.as_str().into(), issue_events.as_str().into()];
    MOVED.iter().map(|sql| db.prepare(*sql).bind(&values[..bound(sql)])).collect()
}

/// The cron: pages of `work.migrated` that never arrived, read from the
/// work service (`g1t_kit::work_migrated`) and applied as the event's
/// would have been, each recorded as `catch-up:<page>`.
pub async fn catch_up(db: &D1Database, work: &Fetcher) {
    let caught = g1t_kit::work_migrated::catch_up(db, work, |page| async move {
        let statements = page_statements(db, &format!("catch-up:{}", page.page), &page)?;
        if !statements.is_empty() {
            db.batch(statements).await?;
        }
        Ok(())
    })
    .await;
    if let Err(error) = caught {
        worker::console_error!("catching up on work.migrated: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{database_before, migrate_from};
    use rusqlite::{Connection, params};

    const ITEM: &str = "INSERT INTO inbox_items (id, username, event_id, reason, severity, title, body, workspace, repo_id, repo,
                          subject, number, created_at, thread, updated_at, bumped, activity, read_at, saved)
                        VALUES (?1, ?2, ?3, 'author', 'info', 't', 'b', 'acme', ?4, 'acme/rocket', ?5, ?6, ?7, ?8, ?7, ?1, ?9, ?10, ?11)";
    const EVENT: &str = "INSERT INTO events (id, type, source, time, repo_id, data, seq) VALUES (?1, ?2, 'work', 't', ?3, ?4, ?5)";

    /// One page: rep_1's issue 3 is acme#40, its issue 5 acme#41.
    fn page() -> String {
        serde_json::json!([
            { "repoId": "rep_1", "legacyNumber": 3, "workspace": "Acme", "number": 40, "itemId": "iss_3" },
            { "repoId": "rep_1", "legacyNumber": 5, "workspace": "Acme", "number": 41, "itemId": "iss_5" },
        ])
        .to_string()
    }

    fn run(db: &Connection, event_id: &str, items: &str) {
        let issue_events = serde_json::to_string(&ISSUE_EVENTS).unwrap();
        let values = [event_id, items, issue_events.as_str()];
        for sql in MOVED {
            db.execute(sql, rusqlite::params_from_iter(&values[..bound(sql)])).unwrap_or_else(|error| panic!("{sql}: {error}"));
        }
    }

    fn logged(db: &Connection, id: &str) -> (String, serde_json::Value) {
        let (kind, data): (String, String) =
            db.query_row("SELECT type, data FROM events WHERE id = ?1", [id], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
        (kind, serde_json::from_str(&data).unwrap())
    }

    type ItemState = (String, String, String, Option<u32>, String, u32, Option<String>);

    fn items(db: &Connection) -> Vec<ItemState> {
        let mut statement = db
            .prepare("SELECT id, username, thread, number, workspace, activity, read_at FROM inbox_items ORDER BY id")
            .unwrap();
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    #[test]
    fn what_was_kept_by_issue_number_follows_the_work_item() {
        let db = database_before("0013_work_items.sql");
        // ana: a thread on issue 3, and one on pull request 4.
        db.execute(ITEM, params!["ntf_1", "ana", "evt_1", "rep_1", "issue", 3, "2026-01-01", "rep_1#3", 2, None::<String>, 0]).unwrap();
        db.execute(ITEM, params!["ntf_2", "ana", "evt_2", "rep_1", "pull", 4, "2026-01-02", "rep_1#4", 1, None::<String>, 0]).unwrap();
        // bo: a thread on issue 5, and the work item's own since, read, before it had its number.
        db.execute(ITEM, params!["ntf_3", "bo", "evt_3", "rep_1", "issue", 5, "2026-01-01", "rep_1#5", 3, None::<String>, 1]).unwrap();
        db.execute(ITEM, params!["ntf_4", "bo", "evt_4", "rep_1", "item", None::<u32>, "2026-02-01", "item:iss_5", 1, "2026-02-02", 0])
            .unwrap();
        for (id, item, event) in [("act_1", "ntf_3", "evt_3"), ("act_2", "ntf_4", "evt_4")] {
            db.execute(
                "INSERT INTO inbox_activity (id, item_id, username, event_id, reason, severity, title, body, created_at)
                 VALUES (?1, ?2, 'bo', ?3, 'author', 'info', 't', 'b', 't')",
                params![id, item, event],
            )
            .unwrap();
        }
        for (user, thread, state) in
            [("ana", "rep_1#3", "subscribed"), ("ana", "rep_1#4", "ignored"), ("bo", "rep_1#5", "ignored"), ("bo", "item:iss_5", "subscribed")]
        {
            db.execute(
                "INSERT INTO inbox_subscriptions (username, thread, repo_id, state, created_at) VALUES (?1, ?2, 'rep_1', ?3, 't')",
                params![user, thread, state],
            )
            .unwrap();
        }
        db.execute(
            "INSERT INTO inbox_watching (username, repo_id, level, events, updated_at)
             VALUES ('cy', 'rep_1', 'custom', '[\"issues\",\"deployments\"]', 't')",
            [],
        )
        .unwrap();
        let events = [
            ("evt_1", "issue.opened", r#"{"issueId":"iss_3","repoId":"rep_1","number":3}"#),
            ("evt_2", "pull.opened", r#"{"repoId":"rep_1","number":4,"issue":3}"#),
            ("evt_3", "comment.created", r#"{"commentId":"cmt_1","repoId":"rep_1","number":5}"#),
            ("evt_5", "comment.created", r#"{"commentId":"cmt_2","repoId":"rep_1","number":4,"pullId":"pr_4"}"#),
            ("evt_6", "work.overlap", r#"{"issue":5,"otherIssue":3}"#),
            ("evt_7", "issue.closed", r#"{"issueId":"iss_9","repoId":"rep_1","number":9}"#),
        ];
        for (seq, (id, kind, json)) in events.iter().enumerate() {
            db.execute(EVENT, params![id, kind, "rep_1", json, seq as i64 + 1]).unwrap();
        }

        migrate_from(&db, "0013_work_items.sql");
        // What needs only names is done at once.
        let subject: String = db.query_row("SELECT subject FROM inbox_items WHERE id = 'ntf_1'", [], |row| row.get(0)).unwrap();
        assert_eq!(subject, "item");
        let watched: String = db.query_row("SELECT events FROM inbox_watching WHERE username = 'cy'", [], |row| row.get(0)).unwrap();
        assert_eq!(watched, r#"["work_items","deployments"]"#);
        // A subscription to a work item with no origin has no repository.
        db.execute(
            "INSERT INTO inbox_subscriptions (username, thread, repo_id, state, created_at) VALUES ('dee', 'item:wki_9', NULL, 'subscribed', 't')",
            [],
        )
        .unwrap();

        // The page, twice: the second time changes nothing.
        run(&db, "evt_9", &page());
        let first = items(&db);
        run(&db, "evt_9", &page());
        assert_eq!(items(&db), first);
        // And again as the cron's catch-up reads it: nothing more either.
        let log = |db: &Connection| -> Vec<(String, serde_json::Value)> {
            ["evt_1", "evt_2", "evt_3", "evt_5", "evt_6", "evt_7"].iter().map(|id| logged(db, id)).collect()
        };
        let logged_once = log(&db);
        run(&db, "catch-up:1", &page());
        assert_eq!(items(&db), first);
        assert_eq!(log(&db), logged_once);
        assert_eq!(
            first,
            vec![
                ("ntf_1".into(), "ana".into(), "item:iss_3".into(), Some(40), "acme".into(), 2, None),
                ("ntf_2".into(), "ana".into(), "rep_1#4".into(), Some(4), "acme".into(), 1, None),
                // bo's old thread joined the work item's, with its history.
                ("ntf_4".into(), "bo".into(), "item:iss_5".into(), Some(41), "acme".into(), 4, Some("2026-02-02".into())),
            ]
        );
        let moved: u32 = db.query_row("SELECT count(*) FROM inbox_activity WHERE item_id = 'ntf_4'", [], |row| row.get(0)).unwrap();
        assert_eq!(moved, 2);
        let since: String = db.query_row("SELECT created_at FROM inbox_items WHERE id = 'ntf_4'", [], |row| row.get(0)).unwrap();
        assert_eq!(since, "2026-01-01");

        let mut statement = db.prepare("SELECT username, thread, state FROM inbox_subscriptions ORDER BY username, thread").unwrap();
        let subscriptions: Vec<(String, String, String)> =
            statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).unwrap().map(Result::unwrap).collect();
        assert_eq!(
            subscriptions,
            vec![
                ("ana".into(), "item:iss_3".into(), "subscribed".into()),
                ("ana".into(), "rep_1#4".into(), "ignored".into()),
                // What bo chose on the work item stands.
                ("bo".into(), "item:iss_5".into(), "subscribed".into()),
                ("dee".into(), "item:wki_9".into(), "subscribed".into()),
            ]
        );

        // The log names the work items.
        let (kind, opened) = logged(&db, "evt_1");
        assert_eq!(kind, "work_item.opened");
        assert_eq!(opened, serde_json::json!({ "itemId": "iss_3", "workspace": "acme", "number": 40, "repoIds": ["rep_1"] }));
        assert_eq!(logged(&db, "evt_2").1, serde_json::json!({ "repoId": "rep_1", "number": 4, "item": 40 }));
        let comment = logged(&db, "evt_3").1;
        assert_eq!((comment["number"].as_u64(), comment["itemId"].as_str()), (Some(41), Some("iss_5")));
        assert_eq!(logged(&db, "evt_6").1, serde_json::json!({ "item": 41, "otherItem": 40 }));
        // A pull request's comment, and an issue no page has named yet, stay.
        assert_eq!(logged(&db, "evt_5").1["number"], 4);
        assert_eq!(logged(&db, "evt_7").0, "issue.closed");
    }
}
