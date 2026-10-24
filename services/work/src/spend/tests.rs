use rusqlite::types::ValueRef;
use rusqlite::{Connection, ToSql, params};

use super::{PEOPLE, PERSON, ROWS, TOTALS, span};

/// D1 takes at most five terms in one compound SELECT; SQLite allows 500.
const D1_COMPOUND_SELECT: i32 = 5;

/// Two repositories of acme and one of another workspace, two work items,
/// and a merged pull request for one of them.
fn database() -> Connection {
    let db = crate::migrated::database();
    // Refuse what D1 refuses, so a statement these tests pass also runs there.
    db.set_limit(rusqlite::limits::Limit::SQLITE_LIMIT_COMPOUND_SELECT, D1_COMPOUND_SELECT);
    db.execute_batch(
        "INSERT INTO repo_workspaces (repo_id, workspace, path, private) VALUES
           ('rep_web', 'acme', 'acme/web', 1), ('rep_api', 'acme', 'acme/api', 1), ('rep_x', 'other', 'other/x', 0);
         INSERT INTO work_items (id, workspace, number, title, body, author_id, author_name, created_at, updated_at) VALUES
           ('wki_4', 'acme', 4, 'Greet people', '', 'usr_1', 'ana', '', ''),
           ('wki_5', 'acme', 5, 'Wave', '', 'usr_1', 'ana', '', '');
         INSERT INTO pulls (id, repo_id, number, title, agent, runtime, author_id, author_name, created_at, updated_at, item_id, status)
           VALUES ('pr_web_9', 'rep_web', 9, 'Say hello', 'claude-code', 'external', 'usr_1', 'ana', '', '', 'wki_4', 'merged');",
    )
    .unwrap();
    db
}

#[allow(clippy::too_many_arguments)]
fn session(
    db: &Connection,
    id: &str,
    repo: &str,
    actor: &str,
    started: &str,
    cost: Option<f64>,
    pull: Option<u32>,
    parent: Option<&str>,
    model: &str,
) {
    db.execute(
        "INSERT INTO sessions (id, repo_id, pull, branch, actor_id, actor_name, harness, harness_session_id,
           state, started_at, last_seen_at, parent_id, model, cost_usd)
         VALUES (?1, ?2, ?3, 'main', ?4, ?4, 'claude_code', ?1, 'ended', ?5, ?5, ?6, ?7, ?8)",
        params![id, repo, pull, actor, started, parent, model, cost],
    )
    .unwrap();
}

fn link_item(db: &Connection, session: &str, item: &str, via: &str) {
    db.execute(
        "INSERT INTO session_links (session_id, repo_id, kind, number, via, at, item_id) VALUES (?1, 'rep_api', 'item', 0, ?3, '', ?2)",
        params![session, item, via],
    )
    .unwrap();
}

/// Every row `sql` returns, as JSON objects the way D1 gives them.
fn rows(db: &Connection, sql: &str, binds: &[&dyn ToSql]) -> Vec<serde_json::Value> {
    let mut statement = db.prepare(sql).unwrap();
    let names: Vec<String> = statement.column_names().into_iter().map(str::to_owned).collect();
    let mut found = statement.query(binds).unwrap();
    let mut out = Vec::new();
    while let Some(row) = found.next().unwrap() {
        let mut object = serde_json::Map::new();
        for (i, name) in names.iter().enumerate() {
            let value = match row.get_ref(i).unwrap() {
                ValueRef::Null => serde_json::Value::Null,
                ValueRef::Integer(n) => n.into(),
                ValueRef::Real(n) => n.into(),
                ValueRef::Text(text) => String::from_utf8_lossy(text).into_owned().into(),
                ValueRef::Blob(_) => panic!("no blobs here"),
            };
            object.insert(name.clone(), value);
        }
        out.push(object.into());
    }
    out
}

const FROM: &str = "2026-10-01T00:00:00";
const TO: &str = "2026-10-23T00:00:00";

#[test]
fn a_persons_spend_is_shared_out_by_work_and_says_what_landed() {
    let db = database();
    // Tied to the merged pull request 9 (work item 4), with an untied subagent on another model.
    session(&db, "ses_pr", "rep_web", "usr_1", "2026-10-20T09:00:00Z", Some(4.0), Some(9), None, "claude-opus-5-5");
    session(&db, "ses_sub", "rep_web", "usr_1", "2026-10-20T09:30:00Z", Some(1.0), None, Some("ses_pr"), "claude-haiku-5-5");
    // No pull request: claimed 4 and landed it by a push naming it; also claimed 5, which never landed.
    session(&db, "ses_push", "rep_api", "usr_1", "2026-10-21T09:00:00Z", Some(2.0), None, None, "claude-opus-5-5");
    link_item(&db, "ses_push", "wki_4", "claim");
    link_item(&db, "ses_push", "wki_4", "trailer");
    link_item(&db, "ses_push", "wki_5", "claim");
    // Tied to nothing, and of no known cost.
    session(&db, "ses_loose", "rep_api", "usr_1", "2026-10-21T10:00:00Z", Some(3.0), None, None, "claude-opus-5-5");
    session(&db, "ses_unknown", "rep_api", "usr_1", "2026-10-21T11:00:00Z", None, None, None, "claude-opus-5-5");
    // Someone else's, another workspace's, and before the span: not ana's here.
    session(&db, "ses_bo", "rep_api", "usr_2", "2026-10-21T09:00:00Z", Some(7.0), None, None, "claude-opus-5-5");
    session(&db, "ses_x", "rep_x", "usr_1", "2026-10-21T09:00:00Z", Some(50.0), None, None, "claude-opus-5-5");
    session(&db, "ses_old", "rep_api", "usr_1", "2026-09-30T23:00:00Z", Some(9.0), None, None, "claude-opus-5-5");

    let found = rows(&db, ROWS, &[&"acme", &FROM, &TO, &"usr_1"]);
    let mut got: Vec<(String, Option<i64>, String, i64, i64, f64)> = found
        .iter()
        .map(|row| {
            (
                row["repo"].as_str().unwrap().to_owned(),
                row["item"].as_i64(),
                row["model"].as_str().unwrap().to_owned(),
                row["landed"].as_i64().unwrap(),
                row["sessions"].as_i64().unwrap(),
                row["cost_usd"].as_f64().unwrap(),
            )
        })
        .collect();
    got.sort_by(|a, b| (&a.0, a.1, &a.2, a.3).cmp(&(&b.0, b.1, &b.2, b.3)));
    let opus = "claude-opus-5-5".to_owned();
    assert_eq!(
        got,
        [
            ("acme/api".to_owned(), None, opus.clone(), 0, 2, 3.0),
            ("acme/api".to_owned(), Some(4), opus.clone(), 1, 1, 1.0),
            ("acme/api".to_owned(), Some(5), opus.clone(), 0, 1, 1.0),
            ("acme/web".to_owned(), Some(4), "claude-haiku-5-5".to_owned(), 1, 1, 1.0),
            ("acme/web".to_owned(), Some(4), opus, 1, 1, 4.0),
        ]
    );
    assert_eq!(found[0]["day"], "2026-10-20", "the costliest first");

    let totals = rows(&db, TOTALS, &[&"acme", &FROM, &TO, &"usr_1"]);
    assert_eq!((totals[0]["sessions"].as_i64(), totals[0]["unknown_sessions"].as_i64()), (Some(5), Some(1)));

    // Everyone, by name, not by what they spent.
    let people = rows(&db, PEOPLE, &[&"acme", &FROM, &TO]);
    let people: Vec<(&str, i64, f64)> = people
        .iter()
        .map(|p| (p["username"].as_str().unwrap(), p["sessions"].as_i64().unwrap(), p["cost_usd"].as_f64().unwrap()))
        .collect();
    assert_eq!(people, [("usr_1", 5, 10.0), ("usr_2", 1, 7.0)]);

    let person = rows(&db, PERSON, &[&"acme", &"USR_2"]);
    assert_eq!(person[0]["value"], "usr_2");
    assert!(rows(&db, PERSON, &[&"other", &"usr_2"]).is_empty(), "only names with sessions in the workspace");
}

#[test]
fn a_span_is_whole_days_and_bounded() {
    let now = g1t_contracts::time::parse_rfc3339("2026-10-22T15:00:00Z").unwrap();
    assert_eq!(
        span(None, None, now).unwrap(),
        ("2026-09-23".into(), "2026-10-22".into(), "2026-09-23T00:00:00".into(), "2026-10-23T00:00:00".into())
    );
    assert_eq!(span(Some("2026-10-01"), Some("2026-10-07"), now).unwrap().3, "2026-10-08T00:00:00");
    assert!(span(Some("2026-10-08"), Some("2026-10-07"), now).is_err());
    assert!(span(Some("2025-01-01"), Some("2026-10-07"), now).is_err());
    assert!(span(Some("10/01/2026"), None, now).is_err());
}
