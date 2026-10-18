//! The statements coordination runs, against the schema every migration
//! leaves, in SQLite (which D1 is), with foreign keys on as D1 has them.

use rusqlite::{Connection, OptionalExtension, params};

use super::links::{
    BRANCH_SESSIONS, FAMILY, FIRST_PROMPTS, INSERT_LINK, INSERT_OVERLAP, INSERT_TOUCH, PULL_SESSIONS, PullSessionRow, TOUCHED_BY_OTHERS, end_tree_sql,
    pull_sessions_of, tree_sql,
};
use super::sessions::{INSERT_ENTRY, MOVE_ENTRIES, RENEW_CLAIM, harness_session_sql, insert_session_sql, refresh_sql, renewal, resume_sql};
use super::{after_minutes, expire_claims_sql, time_out_sessions_sql};
use super::updates::deliver_sql;
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::{claim_is_mine, session_overlaps, session_pair, subagent_harness_id};
use std::collections::HashSet;

const NOW: u64 = 1_791_800_000_000;

/// The repositories an update is delivered to.
const REPO: &str = r#"["rep_1"]"#;

/// Starts a subagent of `parent` the way `start_session` does, on work
/// item 4 of the repository's workspace.
fn start_child(db: &Connection, id: &str, parent: &str, harness_id: &str, agent: &str) -> Option<String> {
    let at = rfc3339(NOW);
    db.query_row(
        &insert_session_sql(),
        params![
            id, "rep_1", "wki_4", None::<u32>, "main", "usr_1", "ana", "claude_code", harness_id, None::<String>, None::<String>, at, at,
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
    database_at(":memory:")
}

fn database_at(path: impl AsRef<std::path::Path>) -> Connection {
    let db = crate::migrated::database_at(path);
    db.execute_batch(
        "INSERT INTO pulls (id, repo_id, number, title, agent, runtime, author_id, author_name, created_at, updated_at)
         VALUES ('pr_9', 'rep_1', 9, 'Greet', 'claude-code', 'external', 'usr_1', 'ana', '', '');
         INSERT INTO repo_workspaces (repo_id, workspace, path, private) VALUES ('rep_1', 'acme', 'acme/web', 1);
         INSERT INTO work_items (id, workspace, number, title, body, author_id, author_name, created_at, updated_at)
         VALUES ('wki_4', 'acme', 4, 'Greet', '', 'usr_1', 'ana', '', ''), ('wki_9', 'acme', 9, 'Other', '', 'usr_1', 'ana', '', '');",
    )
    .unwrap();
    db
}

fn claim(db: &Connection, id: &str, session: Option<&str>, actor: &str) -> String {
    db.query_row(
        &super::claims::upsert_claim_sql(),
        params![id, "wki_4", "rep_1", session, actor, "ana", "codex", "Working on it", 30, rfc3339(NOW), after_minutes(NOW, 30)],
        |row| row.get(0),
    ).unwrap()
}

#[test]
fn simultaneous_claims_converge_without_locking_out_other_agents() {
    let path = std::env::temp_dir().join(format!("g1t-claims-{}-{}.sqlite", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let db = database_at(&path);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(16));
    let threads: Vec<_> = (0..16).map(|n| {
        let path = path.clone();
        let barrier = barrier.clone();
        std::thread::spawn(move || {
            let db = Connection::open(path).unwrap();
            db.busy_timeout(std::time::Duration::from_secs(10)).unwrap();
            // Every caller's preliminary read precedes every write.
            assert_eq!(db.query_row("SELECT COUNT(*) FROM claims", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
            barrier.wait();
            claim(&db, &format!("clm_{n}"), Some("ses_a"), "usr_1")
        })
    }).collect();
    let ids: HashSet<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert_eq!(ids.len(), 1);
    let first = ids.into_iter().next().unwrap();
    assert_ne!(claim(&db, "sibling", Some("ses_b"), "usr_1"), first);
    assert_ne!(claim(&db, "person", Some("ses_a"), "usr_2"), first);
    db.execute("UPDATE claims SET state = 'released' WHERE id = ?", [&first]).unwrap();
    assert_eq!(claim(&db, "replacement", Some("ses_a"), "usr_1"), "replacement");
    assert_eq!(db.query_row("SELECT COUNT(*) FROM claims WHERE state = 'active'", [], |r| r.get::<_, i64>(0)).unwrap(), 3);
    drop(db);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn a_session_adopts_a_sessionless_claim_and_handoff_allows_a_new_claim() {
    let db = database();
    assert_eq!(claim(&db, "first", None, "usr_1"), "first");
    assert_eq!(claim(&db, "retry", None, "usr_1"), "first");
    assert_eq!(claim(&db, "attached", Some("ses_a"), "usr_1"), "first");
    assert_eq!(claim(&db, "sibling", Some("ses_b"), "usr_1"), "sibling");
    db.execute("UPDATE claims SET state = 'handed_off' WHERE id = 'first'", []).unwrap();
    assert_eq!(claim(&db, "successor", Some("ses_a"), "usr_1"), "successor");
    db.execute("UPDATE claims SET state = 'expired' WHERE id = 'successor'", []).unwrap();
    assert_eq!(claim(&db, "after_expiry", Some("ses_a"), "usr_1"), "after_expiry");
}

fn start(db: &Connection, id: &str, harness_id: Option<&str>) -> Option<String> {
    let at = rfc3339(NOW);
    db.query_row(
        &insert_session_sql(),
        params![
            id, "rep_1", "wki_4", None::<u32>, "main", "usr_1", "ana", "claude_code", harness_id, None::<String>, None::<String>, at, at,
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
    // 30 minutes and more without a heartbeat.
    let late = rfc3339(NOW + g1t_contracts::work::SESSION_TIMEOUT_MS);
    let ended: Vec<String> = db
        .prepare(&time_out_sessions_sql())
        .unwrap()
        .query_map(params!["rep_1", late, "ses_1"], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(ended, ["ses_1"]);
    let reason: String = db.query_row("SELECT end_reason FROM sessions WHERE id = 'ses_1'", [], |row| row.get(0)).unwrap();
    assert_eq!(reason, "timed_out");
    // Noticed once only.
    assert_eq!(db.prepare(&time_out_sessions_sql()).unwrap().query_map(params!["rep_1", late, "ses_1"], |_| Ok(())).unwrap().count(), 0);
    // The harness reconnects.
    let state: String = db
        .query_row(
            &resume_sql(),
            params![
                None::<String>, 9, None::<String>, "abc123", None::<String>, None::<String>, None::<String>, None::<String>,
                None::<String>, None::<String>, late, "ses_1", None::<String>
            ],
            |row| row.get(11),
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
                None::<String>, None::<u32>, None::<String>, None::<String>, None::<String>, None::<String>, "List endpoints",
                None::<String>, None::<String>, None::<String>, rfc3339(NOW), "ses_c1", None::<String>
            ],
            |row| Ok((row.get(11)?, row.get(19)?, row.get(21)?)),
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
    // Not before the parent itself ended, at that moment.
    assert!(column(&db, &end_tree_sql(), params!["ses_parent", rfc3339(NOW), "parent ended"]).is_empty());
    db.execute("UPDATE sessions SET state = 'ended', ended_at = ?1 WHERE id = 'ses_parent'", [rfc3339(NOW)]).unwrap();
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
    let link = |via: &str| db.execute(INSERT_LINK, params!["ses_1", "rep_1", "item", 0, via, rfc3339(NOW), "wki_4"]).unwrap();
    assert_eq!(link("claim"), 1);
    assert_eq!(link("claim"), 0);
    assert_eq!(link("ref"), 1);
    // A pull request opened on the branch after the push finds the session.
    db.execute("UPDATE pulls SET source_branch = '4-greet' WHERE id = 'pr_9'", []).unwrap();
    assert_eq!(column(&db, BRANCH_SESSIONS, params!["rep_1", "[9]"]), ["ses_1"]);
    assert!(column(&db, BRANCH_SESSIONS, params!["rep_1", "[10]"]).is_empty());
}

/// Home marks what landed with the sessions that made it: tied by a link,
/// by the pull request a session named, or by pushing its branch, and a
/// subagent's as the session that started it.
#[test]
fn a_pull_requests_sessions_are_found_every_way_they_are_tied() {
    let db = database();
    start(&db, "ses_1", Some("a"));
    start(&db, "ses_2", Some("b"));
    start_child(&db, "ses_2c", "ses_2", "b/agent/1", "general-purpose");
    db.execute("UPDATE pulls SET source_branch = '9-fix' WHERE id = 'pr_9'", []).unwrap();
    // ses_1 pushed the branch; ses_2's subagent named the pull request in a trailer.
    touch(&db, "ses_1", "branch", "9-fix");
    db.execute(INSERT_LINK, params!["ses_2c", "rep_1", "pull", 9, "trailer", rfc3339(NOW), ""]).unwrap();
    let rows = |numbers: &str| -> Vec<PullSessionRow> {
        let mut statement = db.prepare(PULL_SESSIONS).unwrap();
        statement
            .query_map(params!["rep_1", numbers], |row| {
                Ok(PullSessionRow {
                    number: row.get(0)?,
                    id: row.get(1)?,
                    harness: row.get(2)?,
                    parent_id: row.get(3)?,
                    parent_harness: row.get(5)?,
                })
            })
            .unwrap()
            .map(Result::unwrap)
            .collect()
    };
    let found = pull_sessions_of(rows("[9, 10]"));
    assert_eq!(found.len(), 1, "only pull requests with sessions");
    assert_eq!(found[0].number, 9);
    let mut ids: Vec<&str> = found[0].sessions.iter().map(|session| session.id.as_str()).collect();
    ids.sort_unstable();
    assert_eq!(ids, ["ses_1", "ses_2"], "the subagent counts as its parent, once");
    assert!(pull_sessions_of(rows("[10]")).is_empty());
}

/// Twelve subagents of one session work on one work item, some on the
/// same files: each is listed on it beside the others, each is told of
/// every other that touched a file it touched (once per pair, for both
/// sides), and each holds a claim of its own that the others see.
#[test]
fn twelve_subagents_on_one_work_item_see_each_other() {
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
    // All twelve, and their parent, are on the work item.
    let on_item = column(&db, "SELECT id FROM sessions WHERE repo_id = 'rep_1' AND item_id = 'wki_4' ORDER BY id", []);
    assert_eq!(on_item.len(), 13);
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
    // Each claims the work item from its own session: the others see eleven.
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
            "INSERT INTO claims (id, item_id, repo_id, actor_id, actor_name, state, ttl_minutes, created_at, expires_at)
             VALUES (?1, 'wki_4', 'rep_1', 'usr_1', 'ana', 'active', 30, '', ?2)",
            params![id, expires_at],
        )
        .unwrap();
    };
    insert("clm_due", &rfc3339(NOW - 1));
    insert("clm_live", &after_minutes(NOW, 10));
    let expire = |id: &str| -> Vec<String> {
        db.prepare(&expire_claims_sql())
            .unwrap()
            .query_map(params!["rep_1", rfc3339(NOW), id], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    };
    assert!(expire("clm_live").is_empty(), "a claim not yet due stays");
    assert_eq!(expire("clm_due"), ["clm_due"]);
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

#[test]
fn inbox_delivery_acknowledgement_and_reconnect_are_session_scoped() {
    use super::updates::{PENDING, ACK};
    let db = database();
    start(&db, "ses_a", Some("a"));
    start(&db, "ses_b", Some("b"));
    start(&db, "ses_ended", Some("ended"));
    start(&db, "ses_other", Some("other"));
    db.execute("UPDATE sessions SET state = 'ended' WHERE id = 'ses_ended'", []).unwrap();
    db.execute("UPDATE sessions SET repo_id = 'other' WHERE id = 'ses_other'", []).unwrap();
    let event = params!["upd_1", "overlap.detected", "{}", rfc3339(NOW), REPO, "[]"];
    assert_eq!(db.execute(&deliver_sql("1"), event).unwrap(), 2);
    assert_eq!(db.execute(&deliver_sql("1"), event).unwrap(), 0);
    assert_eq!(column(&db, PENDING, ["ses_a"]), ["upd_1"]);
    // Reading repeatedly, including after a reconnect, never clears updates.
    assert_eq!(column(&db, PENDING, ["ses_a"]), ["upd_1"]);
    assert!(column(&db, PENDING, ["ses_other"]).is_empty());
    assert!(column(&db, PENDING, ["ses_ended"]).is_empty());
    db.execute(ACK, params!["first", "ses_a", "upd_1"]).unwrap();
    db.execute(ACK, params!["retry", "ses_a", "upd_1"]).unwrap();
    assert!(column(&db, PENDING, ["ses_a"]).is_empty());
    assert_eq!(column(&db, PENDING, ["ses_b"]), ["upd_1"]);
    assert_eq!(column(&db, "SELECT acknowledged_at FROM session_updates WHERE session_id = 'ses_a'", []), ["first"]);
    db.execute(&deliver_sql("1"), params!["upd_2", "dependency.changed", "{}", rfc3339(NOW+1), REPO, "[]"]).unwrap();
    // An old acknowledgement cannot swallow a later update.
    db.execute(ACK, params!["retry", "ses_a", "upd_1"]).unwrap();
    assert_eq!(column(&db, PENDING, ["ses_a"]), ["upd_2"]);
}

#[test]
fn inbox_drains_bounded_pages_without_skipping_updates() {
    use super::updates::{PENDING, ACK};
    let db = database();
    start(&db, "ses_a", Some("a"));
    for i in 0..105 {
        db.execute(&deliver_sql("1"), params![format!("upd_{i:03}"), "work.claimed", "{}", rfc3339(NOW), REPO, "[]"]).unwrap();
    }
    let first = column(&db, PENDING, ["ses_a"]);
    assert_eq!(first.len(), 100);
    for id in first { db.execute(ACK, params!["now", "ses_a", id]).unwrap(); }
    assert_eq!(column(&db, PENDING, ["ses_a"]), ["upd_100", "upd_101", "upd_102", "upd_103", "upd_104"]);
}

#[test]
fn pending_updates_and_receipts_survive_database_reopen() {
    use super::updates::{PENDING, ACK};
    let path = std::env::temp_dir().join(format!("g1t-updates-{}-{}.sqlite", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let db = database_at(&path);
    start(&db, "ses_a", Some("a"));
    db.execute(&deliver_sql("1"), params!["upd_1", "overlap.detected", "{}", rfc3339(NOW), REPO, "[]"]).unwrap();
    drop(db);
    let db = Connection::open(&path).unwrap();
    assert_eq!(column(&db, PENDING, ["ses_a"]), ["upd_1"]);
    db.execute(ACK, params!["considered", "ses_a", "upd_1"]).unwrap();
    drop(db);
    let db = Connection::open(&path).unwrap();
    assert!(column(&db, PENDING, ["ses_a"]).is_empty());
    assert_eq!(column(&db, "SELECT acknowledged_at FROM session_updates", []), ["considered"]);
    drop(db);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn inbox_targets_session_overlaps_and_excludes_own_lifecycle_events() {
    use super::updates::{PENDING};
    let db = database();
    start(&db, "ses_a", Some("a"));
    start(&db, "ses_b", Some("b"));
    db.execute(&deliver_sql("1"), params!["upd_overlap", "overlap.detected", r#"{"sessionId":"ses_a","otherSessionId":"ses_b"}"#, rfc3339(NOW), REPO, "[]"]).unwrap();
    assert_eq!(column(&db, PENDING, ["ses_a"]), ["upd_overlap"]);
    assert!(column(&db, PENDING, ["ses_b"]).is_empty());
    db.execute(&deliver_sql("1"), params!["upd_start", "session.started", r#"{"session":{"id":"ses_b"}}"#, rfc3339(NOW+1), REPO, "[]"]).unwrap();
    assert_eq!(column(&db, PENDING, ["ses_a"]), ["upd_overlap", "upd_start"]);
    assert!(column(&db, PENDING, ["ses_b"]).is_empty());
}

#[test]
fn a_session_is_not_told_of_its_own_claims_but_others_are() {
    use super::updates::{PENDING};
    let db = database();
    start(&db, "ses_a", Some("a"));
    start(&db, "ses_b", Some("b"));
    for (id, kind) in [("upd_claim", "work.claimed"), ("upd_release", "work.released"), ("upd_handoff", "work.handoff_requested")] {
        db.execute(&deliver_sql("1"), params![id, kind, r#"{"claim":{"sessionId":"ses_a"}}"#, rfc3339(NOW), REPO, "[]"]).unwrap();
    }
    // An expiry happened to the session; it hears of it.
    db.execute(&deliver_sql("1"), params!["upd_expired", "work.claim_expired", r#"{"claim":{"sessionId":"ses_a"}}"#, rfc3339(NOW + 1), REPO, "[]"]).unwrap();
    // A sessionless claim is news to every session.
    db.execute(&deliver_sql("1"), params!["upd_bare", "work.claimed", r#"{"claim":{"sessionId":null}}"#, rfc3339(NOW + 2), REPO, "[]"]).unwrap();
    assert_eq!(column(&db, PENDING, ["ses_a"]), ["upd_expired", "upd_bare"]);
    assert_eq!(column(&db, PENDING, ["ses_b"]), ["upd_claim", "upd_handoff", "upd_release", "upd_expired", "upd_bare"]);
}

#[test]
fn acknowledging_counts_only_this_sessions_updates() {
    use super::updates::{ACK, KNOWN};
    let db = database();
    start(&db, "ses_a", Some("a"));
    start(&db, "ses_b", Some("b"));
    db.execute(&deliver_sql("1"), params!["upd_1", "dependency.changed", "{}", rfc3339(NOW), REPO, "[]"]).unwrap();
    let known = |session: &str, ids: &str| db.query_row(KNOWN, params![session, ids], |row| row.get::<_, u32>(0)).unwrap();
    assert_eq!(known("ses_a", r#"["upd_1","upd_typo"]"#), 1);
    db.execute(ACK, params!["now", "ses_a", "upd_1"]).unwrap();
    // A receipt still counts on a retry, and never for another session.
    assert_eq!(known("ses_a", r#"["upd_1"]"#), 1);
    assert_eq!(known("ses_b", r#"["upd_x"]"#), 0);
}

#[test]
fn updates_reach_the_sessions_on_their_subject_and_those_not_on_anything_yet() {
    use super::updates::{PENDING, deliver_sql, subjects};
    let db = database();
    for id in ["ses_on4", "ses_on9", "ses_free", "ses_linked", "ses_pull"] {
        start(&db, id, Some(id));
    }
    // start() puts a session on #4: only ses_on4 stays there.
    db.execute("UPDATE sessions SET item_id = NULL WHERE id <> 'ses_on4'", []).unwrap();
    db.execute("UPDATE sessions SET item_id = 'wki_9' WHERE id = 'ses_on9'", []).unwrap();
    db.execute("UPDATE sessions SET pull = 14 WHERE id = 'ses_pull'", []).unwrap();
    // Tied to #4 another way (it named it), though attached to nothing.
    db.execute(INSERT_LINK, params!["ses_linked", "rep_1", "item", 0, "ref", rfc3339(NOW), "wki_4"]).unwrap();
    let data = serde_json::json!({ "number": 14, "item": 4, "claim": { "sessionId": null } });
    assert_eq!(subjects(&data), [4, 14]);
    db.execute(&deliver_sql("1"), params!["upd_claim", "work.claimed", data.to_string(), rfc3339(NOW), REPO, "[4,14]"]).unwrap();
    let heard: Vec<&str> = ["ses_on4", "ses_on9", "ses_free", "ses_linked", "ses_pull"]
        .into_iter()
        .filter(|id| !column(&db, PENDING, [*id]).is_empty())
        .collect();
    assert_eq!(heard, ["ses_on4", "ses_free", "ses_linked", "ses_pull"], "the session on #9 is not interrupted");
    // Tied to another work item only, a session is on something: not told of #4.
    start(&db, "ses_elsewhere", Some("elsewhere"));
    db.execute("UPDATE sessions SET item_id = NULL WHERE id = 'ses_elsewhere'", []).unwrap();
    db.execute(INSERT_LINK, params!["ses_elsewhere", "rep_1", "item", 0, "claim", rfc3339(NOW), "wki_9"]).unwrap();
    db.execute(&deliver_sql("1"), params!["upd_claim_2", "work.claimed", data.to_string(), rfc3339(NOW), REPO, "[4,14]"]).unwrap();
    assert!(column(&db, PENDING, ["ses_elsewhere"]).is_empty());
    // An event about nothing in particular reaches everyone.
    db.execute(&deliver_sql("1"), params!["upd_any", "session.started", r#"{"session":{"id":"ses_x"}}"#, rfc3339(NOW + 1), REPO, "[]"]).unwrap();
    assert_eq!(column(&db, PENDING, ["ses_on9"]), ["upd_any"]);
}

#[test]
fn an_update_is_written_only_with_its_change_and_once() {
    use super::claims::upsert_claim_sql;
    use super::updates::{PENDING, deliver_sql, update_id};
    let mut db = database();
    start(&db, "ses_a", Some("a"));
    start(&db, "ses_b", Some("b"));
    let guard = deliver_sql("EXISTS (SELECT 1 FROM claims WHERE id = ?7)");
    let claim_with_update = |db: &mut Connection, proposed: &str| {
        // As one D1 batch: the claim and its update commit together.
        let tx = db.transaction().unwrap();
        let id: String = tx
            .query_row(
                &upsert_claim_sql(),
                params![proposed, "wki_4", "rep_1", "ses_a", "usr_1", "ana", "codex", "Scope: api", 30, rfc3339(NOW), after_minutes(NOW, 30)],
                |row| row.get(0),
            )
            .unwrap();
        let update = update_id("work.claimed", &format!("{proposed}:claimed"));
        tx.execute(&guard, params![update, "work.claimed", r#"{"item":4,"claim":{"sessionId":"ses_a"}}"#, rfc3339(NOW), REPO, "[4]", proposed]).unwrap();
        tx.commit().unwrap();
        id
    };
    assert_eq!(claim_with_update(&mut db, "clm_first"), "clm_first");
    assert_eq!(column(&db, PENDING, ["ses_b"]).len(), 1);
    assert!(column(&db, PENDING, ["ses_a"]).is_empty(), "not told of its own claim");
    // Claiming again renews: no new claim, so no update.
    assert_eq!(claim_with_update(&mut db, "clm_retry"), "clm_first");
    assert_eq!(column(&db, PENDING, ["ses_b"]).len(), 1);
    // The same change written twice (a retried or concurrent request) is one update.
    let update = update_id("work.claimed", "clm_first:claimed");
    db.execute(&guard, params![update, "work.claimed", "{}", rfc3339(NOW), REPO, "[4]", "clm_first"]).unwrap();
    assert_eq!(column(&db, PENDING, ["ses_b"]).len(), 1);
    // A transaction that fails takes its update with it.
    {
        let tx = db.transaction().unwrap();
        tx.execute(&guard, params!["upd_lost", "work.claimed", "{}", rfc3339(NOW), REPO, "[4]", "clm_first"]).unwrap();
        drop(tx);
    }
    assert_eq!(column(&db, PENDING, ["ses_b"]), [update]);
}

#[test]
fn a_pair_is_told_again_when_it_starts_changing_another_file_in_common() {
    let db = database();
    let announce = |files: &[&str], at: u64| {
        db.query_row(INSERT_OVERLAP, params!["rep_1", "ses_a", "ses_b", serde_json::to_string(files).unwrap(), rfc3339(at)], |_| Ok(()))
            .optional()
            .unwrap()
            .is_some()
    };
    assert!(announce(&["CLAUDE.md"], NOW), "first met on a harness file");
    assert!(!announce(&["CLAUDE.md"], NOW + 1), "the same file again is not news");
    assert!(announce(&["src/report.ts"], NOW + 2), "the code they both change is");
    assert!(!announce(&["src/report.ts", "CLAUDE.md"], NOW + 3));
    let (files, noticed): (String, String) = db
        .query_row("SELECT files, noticed_at FROM session_overlaps WHERE low = 'ses_a'", [], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap();
    let mut files: Vec<String> = serde_json::from_str(&files).unwrap();
    files.sort();
    assert_eq!(files, ["CLAUDE.md", "src/report.ts"]);
    assert_eq!(noticed, rfc3339(NOW + 2), "noticed when it last grew, which guards its delivery");
}

#[test]
fn a_queue_result_told_twice_reaches_each_session_once() {
    use super::updates::{PENDING, deliver_sql, update_id};
    let db = database();
    start(&db, "ses_a", Some("a"));
    let id = update_id("integration.failed", "qe_1:att_2:abc123");
    for _ in 0..2 {
        db.execute(&deliver_sql("1"), params![id, "integration.failed", r#"{"number":14,"item":4}"#, rfc3339(NOW), REPO, "[4,14]"]).unwrap();
    }
    assert_eq!(column(&db, PENDING, ["ses_a"]), [id.clone()]);
    // A later attempt's result is news of its own.
    let next = update_id("integration.failed", "qe_1:att_3:abc123");
    assert_ne!(next, id);
}

// --- Titles that settle (titles.rs) ----------------------------------------

/// A session's title as stored: its text, source and when it is due.
fn titled(db: &Connection, id: &str) -> (Option<String>, Option<String>, Option<String>) {
    db.query_row("SELECT title, title_source, title_due_at FROM sessions WHERE id = ?", [id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
}

/// Records `n` prompts the first of which is for `intent`, at `at`.
fn prompted(db: &Connection, id: &str, n: u32, intent: Option<&str>, at: u64) {
    db.execute(&super::titles::prompted_sql(), params![id, n, intent, rfc3339(at), after_minutes(at, super::titles::SETTLE_AFTER_MINUTES)]).unwrap();
}

/// A heartbeat giving the title `title` from `source`, at `at`.
fn heartbeat_titled(db: &Connection, id: &str, title: &str, source: &str, at: u64) {
    db.query_row(
        &resume_sql(),
        params![
            None::<String>, None::<u32>, None::<String>, None::<String>, title, None::<String>, None::<String>, None::<String>,
            None::<String>, None::<String>, rfc3339(at), id, source
        ],
        |_| Ok(()),
    )
    .unwrap();
}

const MINUTE: u64 = 60_000;

#[test]
fn the_first_prompt_names_a_session_for_now_and_enough_of_them_settle_it() {
    let db = database();
    start(&db, "ses_1", Some("a"));
    prompted(&db, "ses_1", 1, Some("This project used to be in syntaqx/g1t"), NOW);
    let due_later = after_minutes(NOW, super::titles::SETTLE_AFTER_MINUTES);
    assert_eq!(titled(&db, "ses_1"), (Some("This project used to be in syntaqx/g1t".into()), Some("prompt".into()), Some(due_later.clone())));
    // A later prompt does not rename it, nor bring it forward yet.
    prompted(&db, "ses_1", 1, Some("Fix the remotes"), NOW + MINUTE);
    assert_eq!(titled(&db, "ses_1").0.as_deref(), Some("This project used to be in syntaqx/g1t"));
    assert_eq!(titled(&db, "ses_1").2, Some(due_later));
    // The third: due now.
    prompted(&db, "ses_1", 1, None, NOW + 2 * MINUTE);
    assert_eq!(titled(&db, "ses_1").2, Some(rfc3339(NOW + 2 * MINUTE)));
    // A subagent is never titled from prompts.
    start_child(&db, "ses_c", "ses_1", "a/agent/1", "Explore");
    prompted(&db, "ses_c", 3, Some("Look around"), NOW);
    assert_eq!(titled(&db, "ses_c"), (None, None, None));
}

#[test]
fn an_agents_title_is_kept_and_a_pinned_one_never_replaced() {
    let db = database();
    start(&db, "ses_1", Some("a"));
    prompted(&db, "ses_1", 1, Some("Fix login"), NOW);
    heartbeat_titled(&db, "ses_1", "Rewrite the auth flow", "agent", NOW + MINUTE);
    assert_eq!(titled(&db, "ses_1"), (Some("Rewrite the auth flow".into()), Some("agent".into()), None));
    // Its prompts and links leave it be until it ends.
    prompted(&db, "ses_1", 5, None, NOW + 2 * MINUTE);
    db.execute(&super::titles::linked_sql(), params!["ses_1", rfc3339(NOW + 2 * MINUTE)]).unwrap();
    assert_eq!(titled(&db, "ses_1").2, None);
    // A person pins it: neither the agent nor g1t replaces it.
    db.execute(super::titles::PIN_TITLE, params!["Auth, rewritten", rfc3339(NOW + 3 * MINUTE), "ses_1"]).unwrap();
    heartbeat_titled(&db, "ses_1", "Something else", "agent", NOW + 4 * MINUTE);
    prompted(&db, "ses_1", 5, None, NOW + 4 * MINUTE);
    db.execute(&super::titles::linked_sql(), params!["ses_1", rfc3339(NOW + 4 * MINUTE)]).unwrap();
    assert_eq!(titled(&db, "ses_1"), (Some("Auth, rewritten".into()), Some("person".into()), None));
    // Not even as it ends.
    let late = rfc3339(NOW + g1t_contracts::work::SESSION_TIMEOUT_MS * 2);
    db.prepare(&time_out_sessions_sql()).unwrap().query_map(params!["rep_1", late, "ses_1"], |_| Ok(())).unwrap().count();
    assert_eq!(titled(&db, "ses_1").2, None);
    // Unpinned: g1t names it again.
    db.execute(super::titles::UNPIN_TITLE, params![rfc3339(NOW + 5 * MINUTE), "ses_1"]).unwrap();
    assert_eq!(titled(&db, "ses_1"), (Some("Auth, rewritten".into()), Some("prompt".into()), Some(rfc3339(NOW + 5 * MINUTE))));
}

#[test]
fn an_agent_echoing_the_provisional_title_keeps_it_provisional() {
    let db = database();
    start(&db, "ses_1", Some("a"));
    prompted(&db, "ses_1", 1, Some("Fix login"), NOW);
    heartbeat_titled(&db, "ses_1", "Fix login", "prompt", NOW + MINUTE);
    let (_, source, due) = titled(&db, "ses_1");
    assert_eq!((source.as_deref(), due), (Some("prompt"), Some(after_minutes(NOW, super::titles::SETTLE_AFTER_MINUTES))));
}

#[test]
fn a_settled_title_is_due_again_only_after_a_while_and_a_change() {
    let db = database();
    start(&db, "ses_1", Some("a"));
    let settled = rfc3339(NOW);
    db.execute(
        "UPDATE sessions SET title = 'Move issues to Work items', title_source = 'item', title_settled_at = ?1, title_due_at = NULL,
           title_prompts = 3, prompts = 3 WHERE id = 'ses_1'",
        [settled.as_str()],
    )
    .unwrap();
    // Tied to more work five minutes on: due, but not before twenty minutes after it settled.
    db.execute(&super::titles::linked_sql(), params!["ses_1", rfc3339(NOW + 5 * MINUTE)]).unwrap();
    assert_eq!(titled(&db, "ses_1").2, Some(rfc3339(NOW + 20 * MINUTE)));
    // Later still: as soon as it is tied.
    db.execute("UPDATE sessions SET title_due_at = NULL WHERE id = 'ses_1'", []).unwrap();
    db.execute(&super::titles::linked_sql(), params!["ses_1", rfc3339(NOW + 45 * MINUTE)]).unwrap();
    assert_eq!(titled(&db, "ses_1").2, Some(rfc3339(NOW + 45 * MINUTE)));
    // Prompts: due again only once they grew past more_prompts(3) = 8.
    db.execute("UPDATE sessions SET title_due_at = NULL WHERE id = 'ses_1'", []).unwrap();
    prompted(&db, "ses_1", 4, None, NOW + 50 * MINUTE);
    assert_eq!(titled(&db, "ses_1").2, None);
    prompted(&db, "ses_1", 1, None, NOW + 51 * MINUTE);
    assert_eq!(titled(&db, "ses_1").2, Some(rfc3339(NOW + 51 * MINUTE)));
    // Settled for good as it ended: nothing makes it due but ending again.
    db.execute("UPDATE sessions SET title_due_at = NULL, title_final = 1, state = 'ended' WHERE id = 'ses_1'", []).unwrap();
    db.execute(&super::titles::linked_sql(), params!["ses_1", rfc3339(NOW + 90 * MINUTE)]).unwrap();
    assert_eq!(titled(&db, "ses_1").2, None);
    // Brought back, it is named again as it ends again.
    heartbeat_titled(&db, "ses_1", "x", "agent", NOW + 91 * MINUTE);
    let kept: u32 = db.query_row("SELECT title_final FROM sessions WHERE id = 'ses_1'", [], |row| row.get(0)).unwrap();
    assert_eq!(kept, 0);
}

#[test]
fn a_session_timing_out_is_named_a_last_time_its_subagents_not() {
    let db = database();
    start(&db, "ses_1", Some("a"));
    start_child(&db, "ses_c", "ses_1", "a/agent/1", "Explore");
    let late = rfc3339(NOW + g1t_contracts::work::SESSION_TIMEOUT_MS);
    for id in ["ses_1", "ses_c"] {
        db.prepare(&time_out_sessions_sql()).unwrap().query_map(params!["rep_1", late, id], |_| Ok(())).unwrap().count();
    }
    assert_eq!(titled(&db, "ses_1").2, Some(rfc3339(NOW)));
    assert_eq!(titled(&db, "ses_c").2, None);
}

#[test]
fn sessions_from_before_titles_settled_are_settled_once() {
    let db = crate::migrated::database_before("0051_session_titles.sql");
    let at = rfc3339(NOW);
    db.execute(
        "INSERT INTO sessions (id, repo_id, actor_id, actor_name, harness, title, state, started_at, last_seen_at, ended_at)
         VALUES ('ses_old', 'rep_1', 'usr_1', 'ana', 'claude_code', 'This project used to be in syntaqx/g1t', 'ended', ?1, ?1, ?1)",
        [at.as_str()],
    )
    .unwrap();
    db.execute(
        "INSERT INTO sessions (id, repo_id, actor_id, actor_name, harness, state, started_at, last_seen_at, parent_id)
         VALUES ('ses_sub', 'rep_1', 'usr_1', 'ana', 'claude_code', 'ended', ?1, ?1, 'ses_old')",
        [at.as_str()],
    )
    .unwrap();
    for n in 1..=2u32 {
        db.execute(
            "INSERT INTO session_entries (seq, kind, text, at, session_id, session_seq) VALUES (?1, 'prompt', 'hi', ?2, 'ses_old', ?1)",
            params![n, at],
        )
        .unwrap();
    }
    crate::migrated::migrate_from(&db, "0051_session_titles.sql");
    let (prompts, due): (u32, Option<String>) =
        db.query_row("SELECT prompts, title_due_at FROM sessions WHERE id = 'ses_old'", [], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
    assert_eq!((prompts, due), (2, Some(at)));
    assert_eq!(titled(&db, "ses_sub").2, None);
}
