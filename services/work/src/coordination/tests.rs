//! The statements coordination runs, against the schema every migration
//! leaves, in SQLite (which D1 is), with foreign keys on as D1 has them.

use rusqlite::{Connection, OptionalExtension, params};

use super::links::{BRANCH_SESSIONS, FAMILY, FIRST_PROMPTS, INSERT_LINK, INSERT_OVERLAP, INSERT_TOUCH, TOUCHED_BY_OTHERS, end_tree_sql, tree_sql};
use super::sessions::{INSERT_ENTRY, MOVE_ENTRIES, RENEW_CLAIM, harness_session_sql, insert_session_sql, refresh_sql, renewal, resume_sql};
use super::{after_minutes, expire_claims_sql, time_out_sessions_sql};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::{claim_is_mine, session_overlaps, session_pair, subagent_harness_id};
use std::collections::HashSet;

const NOW: u64 = 1_791_800_000_000;

/// Starts a subagent of `parent` the way `start_session` does, on issue 4.
fn start_child(db: &Connection, id: &str, parent: &str, harness_id: &str, agent: &str) -> Option<String> {
    let at = rfc3339(NOW);
    db.query_row(
        &insert_session_sql(),
        params![
            id, "rep_1", 4, None::<u32>, "main", "usr_1", "ana", "claude_code", harness_id, None::<String>, None::<String>, at, at,
            parent, agent, "Find the endpoints", "Find every API endpoint and list them", None::<String>
        ],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .unwrap()
}

fn column(db: &Connection, sql: &str, params: impl rusqlite::Params) -> Vec<String> {
    let mut statement = db.prepare(sql).unwrap();
    statement.query_map(params, |row| row.get::<_, String>(0)).unwrap().map(Result::unwrap).collect()
}

fn touch(db: &Connection, session: &str, kind: &str, value: &str) -> bool {
    db.query_row(INSERT_TOUCH, params![session, "rep_1", kind, value, rfc3339(NOW)], |_| Ok(())).optional().unwrap().is_some()
}

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
        params![
            id, "rep_1", 4, None::<u32>, "main", "usr_1", "ana", "claude_code", harness_id, None::<String>, None::<String>, at, at,
            None::<String>, None::<String>, None::<String>, None::<String>, None::<String>
        ],
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
        .query_row(
            &resume_sql(),
            params![
                None::<u32>, 9, None::<String>, "abc123", None::<String>, None::<String>, None::<String>, None::<String>,
                None::<String>, None::<String>, late, "ses_1"
            ],
            |row| row.get(10),
        )
        .unwrap();
    assert_eq!(state, "active");
}

#[test]
fn a_subagent_starts_once_and_once_finished_stays_finished() {
    let db = database();
    start(&db, "ses_parent", Some("claude-abc"));
    let child = subagent_harness_id("claude-abc", "agent-def456");
    assert_eq!(start_child(&db, "ses_c1", "ses_parent", &child, "Explore").as_deref(), Some("ses_c1"));
    // SubagentStart, then the Agent tool's answer naming it without its prefix.
    assert_eq!(start_child(&db, "ses_c2", "ses_parent", &subagent_harness_id("claude-abc", "def456"), "Explore"), None);
    let found: String = db.query_row(&harness_session_sql(), params!["rep_1", "usr_1", "claude_code", child], |row| row.get(0)).unwrap();
    assert_eq!(found, "ses_c1");
    // SubagentStop ended it with its result.
    db.execute("UPDATE sessions SET state = 'ended', end_reason = 'done', result = 'Found 12 endpoints' WHERE id = 'ses_c1'", [])
        .unwrap();
    // A late hook only fills in what it says: it stays ended, its result kept.
    let (state, task, result): (String, String, String) = db
        .query_row(
            &refresh_sql(),
            params![
                None::<u32>, None::<u32>, None::<String>, None::<String>, None::<String>, None::<String>, "List endpoints",
                None::<String>, None::<String>, None::<String>, rfc3339(NOW), "ses_c1"
            ],
            |row| Ok((row.get(10)?, row.get(18)?, row.get(20)?)),
        )
        .unwrap();
    assert_eq!((state.as_str(), task.as_str(), result.as_str()), ("ended", "List endpoints", "Found 12 endpoints"));
    // Its tree, from the parent.
    assert_eq!(column(&db, &tree_sql(), params!["ses_parent"]), ["ses_c1"]);
}

#[test]
fn ending_a_session_ends_the_subagents_it_left_going() {
    let db = database();
    start(&db, "ses_parent", Some("p"));
    start_child(&db, "ses_c1", "ses_parent", "p/agent/1", "Explore");
    start_child(&db, "ses_c2", "ses_parent", "p/agent/2", "Plan");
    // A subagent of a subagent.
    start_child(&db, "ses_c3", "ses_c1", "p/agent/3", "Explore");
    db.execute("UPDATE sessions SET state = 'ended', end_reason = 'done' WHERE id = 'ses_c2'", []).unwrap();
    let mut ended = column(&db, &end_tree_sql(), params!["ses_parent", rfc3339(NOW), "parent ended"]);
    ended.sort();
    assert_eq!(ended, ["ses_c1", "ses_c3"], "the one already done keeps its own end");
    let reason: String = db.query_row("SELECT end_reason FROM sessions WHERE id = 'ses_c2'", [], |row| row.get(0)).unwrap();
    assert_eq!(reason, "done");
    let mut family = column(&db, FAMILY, params!["ses_c1"]);
    family.sort();
    assert_eq!(family, ["ses_c1", "ses_c3", "ses_parent"], "its parents up and its subagents down, not its sibling");
}

#[test]
fn links_and_touches_are_kept_once_each() {
    let db = database();
    start(&db, "ses_1", Some("a"));
    assert!(touch(&db, "ses_1", "file", "src/lib.rs"));
    assert!(!touch(&db, "ses_1", "file", "src/lib.rs"), "said again: nothing new");
    assert!(touch(&db, "ses_1", "branch", "4-greet"));
    let link = |via: &str| db.execute(INSERT_LINK, params!["ses_1", "rep_1", "issue", 4, via, rfc3339(NOW)]).unwrap();
    assert_eq!(link("claim"), 1);
    assert_eq!(link("claim"), 0);
    assert_eq!(link("ref"), 1);
    // A pull request opened on the branch after the push finds the session.
    db.execute("UPDATE pulls SET source_branch = '4-greet' WHERE id = 'pr_9'", []).unwrap();
    assert_eq!(column(&db, BRANCH_SESSIONS, params!["rep_1", "[9]"]), ["ses_1"]);
    assert!(column(&db, BRANCH_SESSIONS, params!["rep_1", "[10]"]).is_empty());
}

/// Twelve subagents of one session work on one issue, some on the same
/// files: each is listed on the issue beside the others, each is told of
/// every other that touched a file it touched (once per pair, for both
/// sides), and each holds a claim of its own that the others see.
#[test]
fn twelve_subagents_on_one_issue_see_each_other() {
    let db = database();
    start(&db, "ses_parent", Some("lead"));
    let children: Vec<String> = (1..=12).map(|n| format!("ses_c{n:02}")).collect();
    for (n, id) in children.iter().enumerate() {
        start_child(&db, id, "ses_parent", &subagent_harness_id("lead", &format!("agent-{n}")), "general-purpose").unwrap();
        // Every one edits the shared router; each pair also shares a file.
        touch(&db, id, "file", "src/router.rs");
        touch(&db, id, "file", &format!("src/part{}.rs", n / 2));
        touch(&db, id, "file", &format!("src/only{n}.rs"));
    }
    // All twelve, and their parent, are on the issue.
    let on_issue = column(&db, "SELECT id FROM sessions WHERE repo_id = 'rep_1' AND issue = 4 ORDER BY id", []);
    assert_eq!(on_issue.len(), 13);
    let mut announced = 0;
    for id in &children {
        let n: usize = id[5..].parse().unwrap();
        let mine = vec!["src/router.rs".to_owned(), format!("src/part{}.rs", (n - 1) / 2), format!("src/only{}.rs", n - 1)];
        let touched: Vec<(String, String)> = {
            let mut statement = db.prepare(TOUCHED_BY_OTHERS).unwrap();
            statement
                .query_map(params!["rep_1", serde_json::to_string(&mine).unwrap(), id], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .map(Result::unwrap)
                .collect()
        };
        let family: HashSet<String> = column(&db, FAMILY, params![id]).into_iter().collect();
        let overlaps = session_overlaps(id, &family, &touched);
        // Every sibling, and never its own parent.
        assert_eq!(overlaps.len(), 11, "{id} sees its eleven siblings");
        assert!(overlaps.iter().all(|(other, _)| other != "ses_parent" && other != id));
        let partner = overlaps.iter().find(|(_, files)| files.len() == 2).expect("the sibling sharing a part file");
        assert_eq!(partner.1, vec![format!("src/part{}.rs", (n - 1) / 2), "src/router.rs".to_owned()]);
        for (other, files) in overlaps {
            let (low, high) = session_pair(id, &other);
            let new = db
                .query_row(INSERT_OVERLAP, params!["rep_1", low, high, serde_json::to_string(&files).unwrap(), rfc3339(NOW)], |_| Ok(()))
                .optional()
                .unwrap()
                .is_some();
            // Each new pair is two overlap.detected events, one for each side.
            if new {
                announced += 2;
            }
        }
    }
    assert_eq!(announced, 12 * 11, "66 pairs, each announced to both sides once");
    // Each claims the issue from its own session: the others see eleven.
    let claims: Vec<(&str, Option<&str>)> = children.iter().map(|id| ("usr_1", Some(id.as_str()))).collect();
    for id in &children {
        let others = claims.iter().filter(|(actor, session)| !claim_is_mine(actor, *session, "usr_1", Some(id))).count();
        assert_eq!(others, 11, "{id}");
    }
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

#[test]
fn an_untitled_sessions_first_prompt_is_found_by_its_own_numbering() {
    let db = database();
    start(&db, "ses_1", Some("claude-1")).unwrap();
    start(&db, "ses_2", Some("claude-2")).unwrap();
    let entry = |session: &str, kind: &str, text: &str| {
        db.query_row(INSERT_ENTRY, params![None::<String>, kind, text, None::<String>, None::<String>, rfc3339(NOW), session, None::<String>], |_| Ok(()))
            .unwrap();
    };
    entry("ses_1", "tool_call", "Bash: ls");
    entry("ses_1", "prompt", "Fix the preview builds that time out");
    entry("ses_1", "prompt", "and the second one");
    // ses_2 recorded no prompt.
    entry("ses_2", "note", "a note");
    let mut statement = db.prepare(FIRST_PROMPTS).unwrap();
    let found: Vec<(String, String)> = statement
        .query_map(params![r#"["ses_1","ses_2","ses_none"]"#, 12], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(found, vec![("ses_1".to_owned(), "Fix the prev".to_owned())]);
}
