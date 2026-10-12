//! The statements coordination runs, against the schema every migration
//! leaves, in SQLite (which D1 is), with foreign keys on as D1 has them.

use rusqlite::{Connection, OptionalExtension, params};

use super::sessions::{INSERT_ENTRY, MOVE_ENTRIES, RENEW_CLAIM, harness_session_sql, insert_session_sql, renewal, resume_sql};
use super::{after_minutes, expire_claims_sql, time_out_sessions_sql};
use g1t_contracts::time::rfc3339;

const NOW: u64 = 1_791_800_000_000;

fn database() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/migrations");
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| name.ends_with(".sql"))
        .collect();
    names.sort();
    for name in names {
        let sql = std::fs::read_to_string(format!("{dir}/{name}")).unwrap();
        db.execute_batch(&sql).unwrap_or_else(|error| panic!("{name}: {error}"));
    }
    db.execute(
        "INSERT INTO pulls (id, repo_id, number, title, agent, runtime, author_id, author_name, created_at, updated_at)
         VALUES ('pr_9', 'rep_1', 9, 'Greet', 'claude-code', 'external', 'usr_1', 'ana', '', '')",
        [],
    )
    .unwrap();
    db
}

fn start(db: &Connection, id: &str, harness_id: Option<&str>) -> Option<String> {
    let at = rfc3339(NOW);
    db.query_row(
        &insert_session_sql(),
        params![id, "rep_1", 4, None::<u32>, "main", "usr_1", "ana", "claude_code", harness_id, None::<String>, None::<String>, at, at],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .unwrap()
}

/// Records an entry the way `record_session_entries` does: the session
/// number it took, or none when its key was recorded before.
fn record(db: &Connection, pull: Option<&str>, session: &str, text: &str, key: Option<&str>) -> Option<u32> {
    db.query_row(INSERT_ENTRY, params![pull, "note", text, None::<String>, None::<String>, rfc3339(NOW), session, key], |row| {
        row.get(0)
    })
    .optional()
    .unwrap()
}

fn pull_entries(db: &Connection) -> Vec<(u32, String)> {
    let mut rows = db.prepare("SELECT seq, text FROM session_entries WHERE pull_id = 'pr_9' ORDER BY seq").unwrap();
    rows.query_map([], |row| Ok((row.get(0)?, row.get(1)?))).unwrap().map(Result::unwrap).collect()
}

#[test]
fn starting_a_harness_session_again_returns_the_first() {
    let db = database();
    assert_eq!(start(&db, "ses_1", Some("claude-abc")).as_deref(), Some("ses_1"));
    // The hook fired twice: nothing new, and the first is found by its id.
    assert_eq!(start(&db, "ses_2", Some("claude-abc")), None);
    let found: String = db
        .query_row(&harness_session_sql(), params!["rep_1", "usr_1", "claude_code", "claude-abc"], |row| row.get(0))
        .unwrap();
    assert_eq!(found, "ses_1");
    // Without a harness id every start is a session of its own.
    assert_eq!(start(&db, "ses_3", None).as_deref(), Some("ses_3"));
    assert_eq!(start(&db, "ses_4", None).as_deref(), Some("ses_4"));
}

#[test]
fn a_quiet_session_times_out_and_a_heartbeat_brings_it_back() {
    let db = database();
    start(&db, "ses_1", Some("a"));
    // Two hours and more without a heartbeat.
    let late = rfc3339(NOW + g1t_contracts::work::SESSION_TIMEOUT_MS);
    let ended: Vec<String> = db
        .prepare(&time_out_sessions_sql())
        .unwrap()
        .query_map(params!["rep_1", late], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(ended, ["ses_1"]);
    let reason: String = db.query_row("SELECT end_reason FROM sessions WHERE id = 'ses_1'", [], |row| row.get(0)).unwrap();
    assert_eq!(reason, "timed_out");
    // Noticed once only.
    assert_eq!(db.prepare(&time_out_sessions_sql()).unwrap().query_map(params!["rep_1", late], |_| Ok(())).unwrap().count(), 0);
    // The harness reconnects.
    let state: String = db
        .query_row(&resume_sql(), params![None::<u32>, 9, None::<String>, "abc123", None::<String>, late, "ses_1"], |row| row.get(10))
        .unwrap();
    assert_eq!(state, "active");
}

#[test]
fn entries_are_recorded_once_per_key_and_numbered_in_the_session() {
    let db = database();
    start(&db, "ses_1", Some("a"));
    assert_eq!(record(&db, None, "ses_1", "planning", Some("k1")), Some(1));
    // The hook retried: skipped.
    assert_eq!(record(&db, None, "ses_1", "planning", Some("k1")), None);
    assert_eq!(record(&db, None, "ses_1", "no key", None), Some(2));
    assert_eq!(record(&db, None, "ses_1", "no key", None), Some(3));
    // Another session numbers its own, and may reuse a key.
    start(&db, "ses_2", Some("b"));
    assert_eq!(record(&db, None, "ses_2", "other", Some("k1")), Some(1));
}

#[test]
fn a_sessions_entries_join_its_pull_request_after_what_it_has() {
    let db = database();
    // Recorded on the pull request the old way.
    db.execute(
        "INSERT INTO session_entries (pull_id, seq, kind, text, at) VALUES ('pr_9', 1, 'note', 'legacy', '')",
        [],
    )
    .unwrap();
    start(&db, "ses_1", Some("a"));
    record(&db, None, "ses_1", "before the pull request", Some("k1"));
    record(&db, None, "ses_1", "still before", Some("k2"));
    // The session names #9: what it recorded moves onto it, in order.
    let base: u32 = db.query_row("SELECT COALESCE(MAX(seq), 0) FROM session_entries WHERE pull_id = 'pr_9'", [], |row| row.get(0)).unwrap();
    db.execute(MOVE_ENTRIES, params!["pr_9", base, "ses_1"]).unwrap();
    // Then it records on the pull request as it goes.
    assert_eq!(record(&db, Some("pr_9"), "ses_1", "after", Some("k3")), Some(3));
    assert_eq!(record(&db, Some("pr_9"), "ses_1", "after", Some("k3")), None);
    assert_eq!(
        pull_entries(&db),
        [(1, "legacy".into()), (2, "before the pull request".into()), (3, "still before".into()), (4, "after".into())]
    );
}

#[test]
fn claims_expire_when_due_and_heartbeats_only_extend_them() {
    let db = database();
    let insert = |id: &str, expires_at: &str| {
        db.execute(
            "INSERT INTO claims (id, repo_id, issue, actor_id, actor_name, state, ttl_minutes, created_at, expires_at)
             VALUES (?1, 'rep_1', 4, 'usr_1', 'ana', 'active', 30, '', ?2)",
            params![id, expires_at],
        )
        .unwrap();
    };
    insert("clm_due", &rfc3339(NOW - 1));
    insert("clm_live", &after_minutes(NOW, 10));
    let expired: Vec<String> = db
        .prepare(&expire_claims_sql())
        .unwrap()
        .query_map(params!["rep_1", rfc3339(NOW)], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(expired, ["clm_due"]);
    let (state, ended_at): (String, String) =
        db.query_row("SELECT state, ended_at FROM claims WHERE id = 'clm_due'", [], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
    assert_eq!((state.as_str(), ended_at), ("expired", rfc3339(NOW - 1)));
    // A heartbeat renews the live one by its own length.
    let renewed = renewal(NOW, 30, &after_minutes(NOW, 10)).unwrap();
    assert_eq!(renewed, after_minutes(NOW, 30));
    assert_eq!(db.execute(RENEW_CLAIM, params![renewed, "clm_live"]).unwrap(), 1);
    // Never an expired one, and never shorter than it is.
    assert_eq!(db.execute(RENEW_CLAIM, params![renewed, "clm_due"]).unwrap(), 0);
    assert_eq!(renewal(NOW, 30, &after_minutes(NOW, 240)), None);
}
