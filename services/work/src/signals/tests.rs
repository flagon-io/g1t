use g1t_contracts::work::{
    SignalAuthor, SignalDay, SignalHarness, SignalPull, SignalSessionSpend, SignalWeek, WaitingPull, WorkspaceSignalsArgs,
};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, ToSql, params};
use serde::de::DeserializeOwned;

use super::{AUTHORS, DAYS, HARNESSES, PULLS, PullRow, SESSIONS, WAITING, WEEKS, WaitingRow, Window, is_person};

const IDS: &str = r#"["a"]"#;

/// D1 takes at most five terms in one compound SELECT; SQLite allows 500.
const D1_COMPOUND_SELECT: i32 = 5;

fn schema() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    // Refuse what D1 refuses, so a statement these tests pass also runs there.
    db.set_limit(rusqlite::limits::Limit::SQLITE_LIMIT_COMPOUND_SELECT, D1_COMPOUND_SELECT);
    db.execute_batch(
        "CREATE TABLE pulls (id TEXT, repo_id TEXT, number INTEGER, title TEXT DEFAULT 'A change', status TEXT,
           item_id TEXT, milestone INTEGER, agent TEXT DEFAULT 'person', author_id TEXT DEFAULT 'usr_ana',
           author_name TEXT DEFAULT 'ana', requested_by_id TEXT, requested_by_name TEXT,
           source_branch TEXT, fork_repo_id TEXT, head_repo_id TEXT, head_commit TEXT, head_pushed_at TEXT,
           created_at TEXT, updated_at TEXT, merged_at TEXT, agent_rule TEXT, agent_name TEXT, agent_by_id TEXT,
           agent_by_name TEXT);
         CREATE TABLE agent_commits (repo_id TEXT, sha TEXT, agent TEXT, rule TEXT, person_id TEXT, person_name TEXT,
           at TEXT);
         CREATE TABLE comments (repo_id TEXT, number INTEGER, author_id TEXT, agent_id TEXT, verdict TEXT, created_at TEXT,
           kind TEXT NOT NULL DEFAULT 'comment');
         CREATE TABLE sessions (id TEXT, repo_id TEXT, pull INTEGER, started_at TEXT, parent_id TEXT,
           actor_id TEXT DEFAULT 'usr_ana', actor_name TEXT DEFAULT 'ana', harness TEXT DEFAULT 'claude_code',
           last_seen_at TEXT, cost_usd REAL, item_id TEXT);
         CREATE TABLE session_entries (pull_id TEXT, seq INTEGER, at TEXT);
         CREATE TABLE check_runs (id TEXT, pull_id TEXT, head_commit TEXT, created_at TEXT, finished_at TEXT);
         CREATE TABLE commit_statuses (repo_id TEXT, sha TEXT, context TEXT, updated_at TEXT);
         CREATE TABLE commit_check_runs (id TEXT, repo_id TEXT, head_sha TEXT, created_at TEXT, updated_at TEXT);
         CREATE TABLE session_links (session_id TEXT, repo_id TEXT, kind TEXT, number INTEGER, item_id TEXT DEFAULT '',
           via TEXT DEFAULT 'ref');
         CREATE TABLE session_touches (session_id TEXT, repo_id TEXT, kind TEXT, value TEXT, at TEXT);
         CREATE TABLE work_items (id TEXT, workspace TEXT, number INTEGER, title TEXT, state TEXT,
           blocked_by TEXT DEFAULT '[]', milestone INTEGER);
         CREATE TABLE milestones (workspace TEXT, number INTEGER, title TEXT, state TEXT, due_on TEXT,
           created_at TEXT, closed_at TEXT);",
    )
    .unwrap();
    db
}

/// A pull request of repository `a`, by `ana` unless changed afterwards.
fn pull(db: &Connection, number: u32, status: &str, created: &str, merged: Option<&str>, updated: &str) {
    db.execute(
        "INSERT INTO pulls (id, repo_id, number, status, created_at, merged_at, updated_at, source_branch)
         VALUES (?1, 'a', ?2, ?3, ?4, ?5, ?6, ?7)",
        params![format!("pr_{number}"), number, status, created, merged, updated, format!("branch-{number}")],
    )
    .unwrap();
}

fn comment(db: &Connection, number: u32, author: &str, agent: Option<&str>, verdict: Option<&str>, at: &str) {
    db.execute(
        "INSERT INTO comments (repo_id, number, author_id, agent_id, verdict, created_at) VALUES ('a', ?1, ?2, ?3, ?4, ?5)",
        params![number, author, agent, verdict, at],
    )
    .unwrap();
}

/// Every row `sql` returns, read as `T` the way D1's rows are.
fn rows<T: DeserializeOwned>(db: &Connection, sql: &str, binds: &[&dyn ToSql]) -> Vec<T> {
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
        out.push(serde_json::from_value(object.into()).unwrap());
    }
    out
}

fn args(until: &str, weeks: u32, days: u32, since: &str) -> WorkspaceSignalsArgs {
    WorkspaceSignalsArgs {
        workspace: "acme".into(),
        repo_ids: vec!["a".into()],
        viewer: None,
        until: until.into(),
        weeks,
        days,
        since: since.into(),
    }
}

fn ms(at: &str) -> u64 {
    g1t_contracts::time::parse_rfc3339(at).unwrap()
}

/// Two weeks ending with Sunday 2026-10-11 (Mondays 09-28 and 10-05),
/// read on `now`.
fn window(now: &str) -> Window {
    super::window(&args("2026-10-11", 2, 7, "2026-09-01"), ms(now)).unwrap()
}

fn weeks(db: &Connection, now: &str) -> Vec<SignalWeek> {
    rows(db, WEEKS, &[&IDS, &window(now).weeks])
}

fn in_week(found: &[SignalWeek], start: &str) -> SignalWeek {
    found.iter().find(|week| week.start == start).cloned().unwrap()
}

fn pulls(db: &Connection) -> Vec<SignalPull> {
    rows::<PullRow>(db, PULLS, &[&IDS, &"acme", &"2026-01-01T00:00:00"]).into_iter().map(Into::into).collect()
}

fn waiting(db: &Connection) -> Vec<WaitingPull> {
    rows::<WaitingRow>(db, WAITING, &[&IDS, &"acme"]).into_iter().map(Into::into).collect()
}

#[test]
fn checks_the_arguments() {
    let now = ms("2026-10-18T00:00:00Z");
    let valid = |a: WorkspaceSignalsArgs| super::window(&a, now).is_some();
    assert!(valid(args("2026-10-11", 13, 28, "2025-09-06")), "400 days back");
    assert!(!valid(args("2026-10-11", 13, 28, "2025-09-05")), "401 days back");
    assert!(!valid(args("2026-10-11", 0, 7, "2026-10-01")));
    assert!(!valid(args("2026-10-11", 14, 7, "2026-10-01")));
    assert!(!valid(args("2026-10-11", 1, 0, "2026-10-01")));
    assert!(!valid(args("2026-10-11", 1, 29, "2026-10-01")));
    assert!(!valid(args("2026-10-11", 1, 7, "2026-10-12")), "since after until");
    assert!(valid(args("2026-10-11", 1, 7, "2026-10-11")));
    assert!(!valid(args("2026-02-30", 1, 7, "2026-02-01")));
    assert!(!valid(args("2026-10-11", 1, 7, "2026-10-1")));
    let mut many = args("2026-10-11", 1, 7, "2026-10-01");
    many.repo_ids = (0..101).map(|n| format!("r{n}")).collect();
    assert!(!valid(many));

    let window = super::window(&args("2026-10-11", 2, 3, "2026-09-01"), now).unwrap();
    let weeks: serde_json::Value = serde_json::from_str(&window.weeks).unwrap();
    assert_eq!(weeks[0]["start"], "2026-09-28");
    assert_eq!(weeks[1]["start"], "2026-10-05");
    assert_eq!(weeks[1]["to"], "2026-10-12T00:00:00.000Z");
    assert_eq!(weeks[1]["cut"], "2026-10-12T00:00:00.000Z", "a week already over ends at its end");
    assert_eq!(
        (window.days_from.as_str(), window.end.as_str(), window.since.as_str(), window.recent_from.as_str()),
        ("2026-10-09T00:00:00", "2026-10-12T00:00:00", "2026-09-01T00:00:00", "2026-07-14T00:00:00")
    );
}

#[test]
fn an_agents_pull_request_is_one_a_session_is_tied_to() {
    let db = schema();
    for number in 1..=6 {
        pull(&db, number, "open", "2026-10-06T12:00:00Z", None, "2026-10-06T12:00:00Z");
    }
    db.execute_batch(
        "UPDATE pulls SET agent = 'agent' WHERE number = 1;
         UPDATE pulls SET author_id = 'usr_g1t_agent', requested_by_id = 'usr_ana', requested_by_name = 'ana' WHERE number = 2;
         -- 3 by a link, 4 by the session saying so, 5 by a push to its branch.
         INSERT INTO sessions (id, repo_id, pull, started_at) VALUES ('ses_3', 'a', NULL, '2026-10-06T11:00:00Z');
         INSERT INTO session_links (session_id, repo_id, kind, number) VALUES ('ses_3', 'a', 'pull', 3);
         INSERT INTO sessions (id, repo_id, pull, started_at) VALUES ('ses_4', 'a', 4, '2026-10-06T13:00:00Z');
         INSERT INTO sessions (id, repo_id, pull, started_at) VALUES ('ses_5', 'a', NULL, '2026-10-06T11:30:00Z');
         INSERT INTO sessions (id, repo_id, pull, started_at) VALUES ('ses_5b', 'a', NULL, '2026-10-06T10:00:00.500Z');
         INSERT INTO session_touches (session_id, repo_id, kind, value) VALUES ('ses_5', 'a', 'branch', 'branch-5');
         INSERT INTO session_touches (session_id, repo_id, kind, value) VALUES ('ses_5b', 'a', 'branch', 'branch-5');
         -- 6's branch is on a fork: a push to the same name is not its.
         UPDATE pulls SET fork_repo_id = 'fork' WHERE number = 6;
         INSERT INTO sessions (id, repo_id, pull, started_at) VALUES ('ses_6', 'a', NULL, '2026-10-06T11:00:00Z');
         INSERT INTO session_touches (session_id, repo_id, kind, value) VALUES ('ses_6', 'a', 'branch', 'branch-6');
         -- A session of another repository with the same number is not its.
         INSERT INTO sessions (id, repo_id, pull, started_at) VALUES ('ses_x', 'b', 6, '2026-10-06T11:00:00Z');",
    )
    .unwrap();
    pull(&db, 7, "open", "2026-10-06T12:00:00Z", None, "2026-10-06T12:00:00Z");
    let mut agents: Vec<(u32, bool)> = pulls(&db).iter().map(|p| (p.number, p.agent)).collect();
    agents.sort();
    assert_eq!(agents, [(1, true), (2, true), (3, true), (4, true), (5, true), (6, false), (7, false)]);
    assert_eq!(pulls(&db).iter().find(|p| p.number == 2).unwrap().owner_id, "usr_ana", "whose g1t's is");

    let mut drafts: Vec<(u32, Option<f64>)> = waiting(&db).iter().map(|p| (p.number, p.draft_seconds)).collect();
    drafts.sort_by_key(|(number, _)| *number);
    // 4's session started after it opened: no draft time. 5's first
    // session started 2 hours less half a second before.
    assert!(drafts[2].0 == 3 && (drafts[2].1.unwrap() - 3600.0).abs() < 0.01);
    assert_eq!(drafts[3], (4, None));
    assert!(drafts[4].0 == 5 && (drafts[4].1.unwrap() - 7199.5).abs() < 0.01);
    assert_eq!((drafts[0].1, drafts[5].1), (None, None));

    let week = in_week(&weeks(&db, "2026-10-18T00:00:00Z"), "2026-10-05");
    assert_eq!(week.agent_drafted, 2);
    assert!((week.agent_draft_seconds - 10799.5).abs() < 0.01);
}

#[test]
fn rework_is_a_persons_request_for_changes_before_it_merged() {
    let db = schema();
    pull(&db, 1, "merged", "2026-10-05T00:00:00Z", Some("2026-10-07T00:00:00Z"), "2026-10-07T00:00:00Z");
    pull(&db, 2, "merged", "2026-10-05T00:00:00Z", Some("2026-10-07T00:00:00Z"), "2026-10-07T00:00:00Z");
    db.execute_batch("UPDATE pulls SET agent = 'agent'").unwrap();
    // None of these is a person's, before it merged, on 1.
    comment(&db, 1, "usr_ana", None, Some("request_changes"), "2026-10-06T00:00:00Z");
    comment(&db, 1, "usr_g1t_agent", None, Some("request_changes"), "2026-10-06T00:00:00Z");
    comment(&db, 1, "agt_margo", Some("agt_margo"), Some("request_changes"), "2026-10-06T00:00:00Z");
    comment(&db, 1, "usr_bo", None, Some("approve"), "2026-10-06T00:00:00Z");
    comment(&db, 1, "usr_bo", None, Some("request_changes"), "2026-10-08T00:00:00Z");
    comment(&db, 2, "usr_bo", None, Some("request_changes"), "2026-10-06T00:00:00Z");
    let found = weeks(&db, "2026-10-18T00:00:00Z");
    assert_eq!(found.len(), 1);
    let week = &found[0];
    assert_eq!((week.start.as_str(), week.merged, week.agent_merged, week.agent_reworked), ("2026-10-05", 2, 2, 1));
    // A person's pull request asked for changes is not an agent's rework.
    db.execute("UPDATE pulls SET agent = 'person' WHERE number = 2", []).unwrap();
    let week = in_week(&weeks(&db, "2026-10-18T00:00:00Z"), "2026-10-05");
    assert_eq!((week.merged, week.agent_merged, week.agent_reworked), (2, 1, 0));
}

#[test]
fn a_first_review_is_a_persons_other_than_the_owner() {
    let db = schema();
    pull(&db, 1, "open", "2026-10-06T00:00:00Z", None, "2026-10-06T00:00:00Z");
    db.execute_batch("UPDATE pulls SET author_id = 'usr_g1t_agent', requested_by_id = 'owner', requested_by_name = 'owner'").unwrap();
    comment(&db, 1, "usr_g1t_agent", None, Some("approve"), "2026-10-06T01:00:00Z");
    comment(&db, 1, "owner", None, Some("approve"), "2026-10-06T02:00:00Z");
    comment(&db, 1, "agt_margo", Some("agt_margo"), Some("approve"), "2026-10-06T03:00:00Z");
    comment(&db, 1, "usr_bo", None, None, "2026-10-06T03:30:00Z");
    assert!(weeks(&db, "2026-10-18T00:00:00Z").iter().all(|w| w.reviewed == 0));
    assert_eq!(waiting(&db).len(), 1, "g1t, an agent, the owner and a plain comment are no review");
    comment(&db, 1, "usr_bo", None, Some("request_changes"), "2026-10-06T04:00:00Z");
    comment(&db, 1, "usr_cy", None, Some("approve"), "2026-10-06T05:00:00Z");
    let week = in_week(&weeks(&db, "2026-10-18T00:00:00Z"), "2026-10-05");
    assert_eq!(week.reviewed, 1);
    assert!((week.review_seconds - 4.0 * 3600.0).abs() < 1.0);
    assert!(waiting(&db).is_empty());
}

#[test]
fn waiting_pull_requests_name_the_work_they_block() {
    let db = schema();
    pull(&db, 10, "open", "2026-10-02T00:00:00Z", None, "2026-10-02T00:00:00Z");
    pull(&db, 11, "open", "2026-10-01T00:00:00Z", None, "2026-10-01T00:00:00Z");
    pull(&db, 12, "draft", "2026-09-01T00:00:00Z", None, "2026-09-01T00:00:00Z");
    db.execute_batch(
        "UPDATE pulls SET item_id = 'wki_1' WHERE number = 10;
         INSERT INTO work_items VALUES ('wki_1', 'acme', 1, 'Login', 'open', '[]', 3);
         INSERT INTO work_items VALUES ('wki_2', 'acme', 2, 'Signup', 'open', '[\"wki_9\", \"wki_1\"]', NULL);
         INSERT INTO work_items VALUES ('wki_4', 'acme', 4, 'Billing', 'open', '[\"wki_1\"]', NULL);
         INSERT INTO work_items VALUES ('wki_5', 'acme', 5, 'Done', 'closed', '[\"wki_1\"]', NULL);
         INSERT INTO work_items VALUES ('wki_6', 'other', 6, 'Elsewhere', 'open', '[\"wki_1\"]', NULL);
         INSERT INTO work_items VALUES ('wki_7', 'acme', 7, 'Unrelated', 'open', '[\"wki_2\"]', NULL);",
    )
    .unwrap();
    let found = waiting(&db);
    let shown: Vec<(u32, Option<u32>, Vec<u32>)> = found.iter().map(|p| (p.number, p.item, p.blocks.clone())).collect();
    assert_eq!(shown, [(11, None, vec![]), (10, Some(1), vec![2, 4])], "oldest first; drafts wait on no one");
    // Its milestone is its work item's.
    let pull = pulls(&db).into_iter().find(|p| p.number == 10).unwrap();
    assert_eq!((pull.item, pull.milestone), (Some(1), Some(3)));
}

#[test]
fn a_pull_requests_own_milestone_counts_only_when_it_is_the_workspaces() {
    let db = schema();
    pull(&db, 1, "open", "2026-10-02T00:00:00Z", None, "2026-10-02T00:00:00Z");
    pull(&db, 2, "open", "2026-10-02T00:00:00Z", None, "2026-10-02T00:00:00Z");
    pull(&db, 3, "merged", "2025-01-01T00:00:00Z", Some("2026-10-03T00:00:00Z"), "2026-10-03T00:00:00Z");
    pull(&db, 4, "closed", "2025-01-01T00:00:00Z", None, "2026-10-03T00:00:00Z");
    db.execute_batch(
        "UPDATE pulls SET milestone = 1 WHERE number = 1;
         UPDATE pulls SET milestone = 8 WHERE number = 2;
         INSERT INTO milestones VALUES ('acme', 1, 'Launch', 'open', NULL, '2026-01-01T00:00:00Z', NULL);
         INSERT INTO milestones VALUES ('other', 8, 'Not ours', 'open', NULL, '2026-01-01T00:00:00Z', NULL);",
    )
    .unwrap();
    let mut found: Vec<(u32, Option<u32>)> = pulls(&db).iter().map(|p| (p.number, p.milestone)).collect();
    found.sort();
    assert_eq!(found, [(1, Some(1)), (2, None), (3, None)], "merged since counts; closed long-opened does not");
}

#[test]
fn authors_are_people_with_merged_work() {
    let db = schema();
    pull(&db, 1, "merged", "2025-01-01T00:00:00Z", Some("2025-01-02T00:00:00Z"), "2025-01-02T00:00:00Z");
    pull(&db, 2, "merged", "2026-10-01T00:00:00Z", Some("2026-10-02T00:00:00Z"), "2026-10-02T00:00:00Z");
    pull(&db, 3, "open", "2026-10-01T00:00:00Z", None, "2026-10-01T00:00:00Z");
    for (number, author) in [(4, "usr_g1t_agent"), (5, "agt_margo"), (6, "wsp_acme"), (7, "g1t"), (8, "svc_runner")] {
        pull(&db, number, "merged", "2026-10-01T00:00:00Z", Some("2026-10-02T00:00:00Z"), "2026-10-02T00:00:00Z");
        db.execute("UPDATE pulls SET author_id = ?1 WHERE number = ?2", params![author, number]).unwrap();
    }
    // g1t's agent's work for a person is theirs, under their name now.
    pull(&db, 9, "merged", "2026-10-01T00:00:00Z", Some("2026-10-03T00:00:00Z"), "2026-10-03T00:00:00Z");
    db.execute_batch(
        "UPDATE pulls SET author_id = 'usr_g1t_agent', requested_by_id = 'usr_ana', requested_by_name = 'ana-renamed' WHERE number = 9",
    )
    .unwrap();
    let found: Vec<SignalAuthor> = rows::<SignalAuthor>(&db, AUTHORS, &[&IDS, &"2026-07-14T00:00:00", &"2026-10-12T00:00:00"])
        .into_iter()
        .filter(|author| is_person(&author.owner_id))
        .collect();
    assert_eq!(found.len(), 1);
    let ana = &found[0];
    assert_eq!(
        (ana.owner_id.as_str(), ana.owner_name.as_str(), ana.first_merged_at.as_str(), ana.last_merged_at.as_str()),
        ("usr_ana", "ana-renamed", "2025-01-02T00:00:00Z", "2026-10-03T00:00:00Z")
    );
    assert_eq!((ana.merged, ana.recent), (3, 2));
}

#[test]
fn days_count_what_happened_on_each() {
    let db = schema();
    pull(&db, 1, "merged", "2026-10-09T10:00:00Z", Some("2026-10-10T10:00:00Z"), "2026-10-10T10:00:00Z");
    pull(&db, 2, "open", "2026-10-08T10:00:00Z", None, "2026-10-08T10:00:00Z");
    db.execute_batch(
        "UPDATE pulls SET agent = 'agent' WHERE number = 1;
         INSERT INTO sessions (id, repo_id, pull, started_at) VALUES ('ses_1', 'a', NULL, '2026-10-10T09:00:00Z');
         INSERT INTO sessions (id, repo_id, pull, started_at) VALUES ('ses_2', 'b', NULL, '2026-10-10T09:00:00Z');",
    )
    .unwrap();
    comment(&db, 1, "usr_bo", None, Some("request_changes"), "2026-10-10T01:00:00Z");
    comment(&db, 1, "usr_bo", None, None, "2026-10-10T02:00:00Z");
    comment(&db, 1, "usr_ana", None, None, "2026-10-10T03:00:00Z");
    comment(&db, 1, "g1t", None, None, "2026-10-10T03:00:00Z");
    comment(&db, 1, "agt_margo", Some("agt_margo"), None, "2026-10-10T03:00:00Z");
    let window = window("2026-10-18T00:00:00Z");
    let days: Vec<SignalDay> = rows(&db, DAYS, &[&IDS, &window.days_from, &window.end]);
    let shown: Vec<(&str, u32, u32, u32, u32, u32, u32)> =
        days.iter().map(|d| (d.day.as_str(), d.opened, d.merged, d.agent_merged, d.reworked, d.reviews, d.sessions)).collect();
    assert_eq!(
        shown,
        [("2026-10-08", 1, 0, 0, 0, 0, 0), ("2026-10-09", 1, 0, 0, 0, 0, 0), ("2026-10-10", 0, 1, 1, 1, 2, 1)],
        "the owner, g1t and an agent are not reviewers; another repository's session is not counted"
    );
}

#[test]
fn days_leave_out_g1t_as_its_system_ids_say() {
    let mut ids = vec![g1t_contracts::system::ID];
    ids.extend(g1t_contracts::system::LEGACY_IDS);
    for id in ids {
        assert!(DAYS.contains(&format!("'{id}'")), "{id}");
        assert!(!is_person(id));
    }
    assert!(is_person("usr_ana"));
}

/// Whether pull request 1 (open since 09-01, head `abc`) is stalled in the
/// week of 10-05, read on `now`, after `setup`.
fn stalled_after(now: &str, setup: &str) -> u32 {
    let db = schema();
    pull(&db, 1, "open", "2026-09-01T00:00:00Z", None, "2026-09-01T00:00:00Z");
    db.execute_batch("UPDATE pulls SET head_commit = 'abc'").unwrap();
    db.execute_batch(setup).unwrap();
    // A week with nothing in it is left out.
    weeks(&db, now).iter().find(|week| week.start == "2026-10-05").map_or(0, |week| week.stalled)
}

#[test]
fn stalled_is_open_with_nothing_in_the_three_days_before_the_cut() {
    // The week of 10-05 is over on 10-18: its cut is 10-12T00:00, and the
    // three days before it start 10-09T00:00.
    let at = |setup: &str| stalled_after("2026-10-18T00:00:00Z", setup);
    assert_eq!(at(""), 1, "nothing at all");
    let comment = |kind: &str, when: &str| {
        format!("INSERT INTO comments (repo_id, number, author_id, kind, created_at) VALUES ('a', 1, 'usr_bo', '{kind}', '{when}')")
    };
    assert_eq!(at(&comment("comment", "2026-10-10T00:00:00Z")), 0, "a comment");
    assert_eq!(at(&comment("event", "2026-10-09T00:00:00Z")), 0, "an event exactly three days before");
    assert_eq!(at(&comment("comment", "2026-10-08T23:59:59Z")), 1, "only before the three days");
    assert_eq!(at(&comment("comment", "2026-10-12T00:00:00Z")), 1, "only at the cut");
    assert_eq!(
        at("INSERT INTO comments (repo_id, number, author_id, created_at) VALUES ('a', 2, 'usr_bo', '2026-10-10T00:00:00Z')"),
        1,
        "another pull request's comment"
    );
    assert_eq!(at("UPDATE pulls SET head_pushed_at = '2026-10-11T00:00:00Z'"), 0, "a push");
    assert_eq!(at("UPDATE pulls SET head_pushed_at = '2026-10-01T00:00:00Z'"), 1, "an old push");
    assert_eq!(at("INSERT INTO session_entries VALUES ('pr_1', 1, '2026-10-10T00:00:00Z')"), 0, "a session entry");
    assert_eq!(
        at("INSERT INTO check_runs VALUES ('chk', 'pr_1', 'abc', '2026-10-05T00:00:00Z', '2026-10-10T00:00:00Z')"),
        0,
        "acceptance checks running then"
    );
    assert_eq!(at("INSERT INTO commit_statuses VALUES ('a', 'abc', 'CI', '2026-10-10T00:00:00Z')"), 0, "a status on its head");
    assert_eq!(at("INSERT INTO commit_statuses VALUES ('a', 'old', 'CI', '2026-10-10T00:00:00Z')"), 1, "a status on another commit");
    assert_eq!(
        at("INSERT INTO commit_check_runs VALUES ('ck', 'a', 'abc', '2026-10-08T00:00:00Z', '2026-10-09T06:00:00Z')"),
        0,
        "a check run on its head"
    );
    let session = "INSERT INTO sessions (id, repo_id, pull, started_at, last_seen_at)
                   VALUES ('ses_1', 'a', 1, '2026-10-01T00:00:00Z',";
    assert_eq!(at(&format!("{session} '2026-10-09T12:00:00Z')")), 0, "a session running then");
    assert_eq!(at(&format!("{session} '2026-10-08T00:00:00Z')")), 1, "a session over before");
    assert_eq!(
        at(&format!(
            "{session} '2026-10-01T00:00:00Z');
             INSERT INTO sessions (id, repo_id, parent_id, started_at, last_seen_at)
               VALUES ('ses_2', 'a', 'ses_1', '2026-10-09T00:00:00Z', '2026-10-10T00:00:00Z');"
        )),
        0,
        "its session's subagent running then"
    );

    // Opened at least three days before the cut.
    assert_eq!(at("UPDATE pulls SET created_at = '2026-10-09T00:00:00Z'"), 1, "exactly three days");
    assert_eq!(at("UPDATE pulls SET created_at = '2026-10-09T00:00:01Z'"), 0, "a second less");
    // Open at the cut; drafts count.
    assert_eq!(at("UPDATE pulls SET status = 'draft'"), 1, "a draft");
    assert_eq!(at("UPDATE pulls SET status = 'merged', merged_at = '2026-10-11T00:00:00Z'"), 0, "merged before the cut");
    assert_eq!(at("UPDATE pulls SET status = 'merged', merged_at = '2026-10-12T00:00:00Z'"), 1, "merged at the cut");
    assert_eq!(at("UPDATE pulls SET status = 'closed', updated_at = '2026-10-11T00:00:00Z'"), 0, "closed before");
    assert_eq!(at("UPDATE pulls SET status = 'closed', updated_at = '2026-10-13T00:00:00Z'"), 1, "closed after");

    // Read mid-week, the cut is now, 10-08T12:00: the three days before it
    // start 10-05T12:00.
    let mid = |setup: &str| stalled_after("2026-10-08T12:00:00Z", setup);
    assert_eq!(mid(&comment("comment", "2026-10-05T12:00:00Z")), 0);
    assert_eq!(mid(&comment("comment", "2026-10-05T11:59:59Z")), 1);
    assert_eq!(mid("UPDATE pulls SET created_at = '2026-10-05T12:00:00Z'"), 1);
    assert_eq!(mid("UPDATE pulls SET created_at = '2026-10-05T12:00:01Z'"), 0);
}

#[test]
fn stalled_counts_each_week_at_its_own_cut() {
    let db = schema();
    pull(&db, 1, "open", "2026-09-01T00:00:00Z", None, "2026-09-01T00:00:00Z");
    pull(&db, 2, "open", "2026-09-01T00:00:00Z", None, "2026-09-01T00:00:00Z");
    // 1 was busy before the first week's cut (10-05), 2 before the second's.
    comment(&db, 1, "usr_bo", None, None, "2026-10-04T00:00:00Z");
    comment(&db, 2, "usr_bo", None, None, "2026-10-11T00:00:00Z");
    let found = weeks(&db, "2026-10-18T00:00:00Z");
    let stalled: Vec<(&str, u32)> = found.iter().map(|w| (w.start.as_str(), w.stalled)).collect();
    assert_eq!(stalled, [("2026-09-28", 1), ("2026-10-05", 1)]);
}

#[test]
fn a_weeks_session_cost_is_what_its_sessions_cost() {
    let db = schema();
    db.execute_batch(
        "INSERT INTO sessions (id, repo_id, started_at, cost_usd) VALUES ('ses_1', 'a', '2026-10-06T00:00:00.000Z', 1.5);
         INSERT INTO sessions (id, repo_id, parent_id, started_at, cost_usd)
           VALUES ('ses_2', 'a', 'ses_1', '2026-10-07T00:00:00.000Z', 0.25);
         INSERT INTO sessions (id, repo_id, started_at, cost_usd) VALUES ('ses_3', 'a', '2026-10-08T00:00:00.000Z', NULL);
         INSERT INTO sessions (id, repo_id, started_at, cost_usd) VALUES ('ses_4', 'a', '2026-10-04T23:59:59.999Z', 2);
         INSERT INTO sessions (id, repo_id, started_at, cost_usd) VALUES ('ses_5', 'a', '2026-10-05T00:00:00.000Z', 0.5);
         INSERT INTO sessions (id, repo_id, started_at, cost_usd) VALUES ('ses_6', 'a', '2026-10-12T00:00:00.000Z', 7);
         INSERT INTO sessions (id, repo_id, started_at, cost_usd) VALUES ('ses_7', 'b', '2026-10-06T00:00:00.000Z', 100);",
    )
    .unwrap();
    let found = weeks(&db, "2026-10-18T00:00:00Z");
    let costs: Vec<(&str, f64, u32)> = found.iter().map(|w| (w.start.as_str(), w.session_cost_usd, w.merged)).collect();
    // No pull requests at all: the weeks show for their cost alone. A
    // subagent's counts; one of no known cost counts as nothing.
    assert_eq!(costs, [("2026-09-28", 2.0, 0), ("2026-10-05", 2.25, 0)]);

    // A week whose sessions cost nothing known is left out.
    db.execute_batch("UPDATE sessions SET cost_usd = NULL WHERE id = 'ses_4'").unwrap();
    let found = weeks(&db, "2026-10-18T00:00:00Z");
    assert_eq!(found.iter().map(|w| w.start.as_str()).collect::<Vec<_>>(), ["2026-10-05"]);
}

#[test]
fn a_pull_requests_session_cost_is_its_share() {
    let db = schema();
    for number in 1..=4 {
        pull(&db, number, "open", "2026-10-06T00:00:00Z", None, "2026-10-06T00:00:00Z");
    }
    db.execute_batch(
        "-- A root session tied to 1 by saying so and to 2 by a link.
         INSERT INTO sessions (id, repo_id, pull, started_at, cost_usd) VALUES ('ses_r', 'a', 1, '2026-10-06T00:00:00Z', 4);
         INSERT INTO session_links (session_id, repo_id, kind, number) VALUES ('ses_r', 'a', 'pull', 2);
         -- Its subagent tied to nothing counts with it; so does that one's.
         INSERT INTO sessions (id, repo_id, parent_id, started_at, cost_usd)
           VALUES ('ses_a', 'a', 'ses_r', '2026-10-06T00:00:00Z', 1);
         INSERT INTO sessions (id, repo_id, parent_id, started_at, cost_usd)
           VALUES ('ses_c', 'a', 'ses_a', '2026-10-06T00:00:00Z', 2);
         -- A subagent tied itself, by a push to 3's branch, counts with that.
         INSERT INTO sessions (id, repo_id, parent_id, started_at, cost_usd)
           VALUES ('ses_b', 'a', 'ses_r', '2026-10-06T00:00:00Z', 3);
         INSERT INTO session_touches (session_id, repo_id, kind, value) VALUES ('ses_b', 'a', 'branch', 'branch-3');
         -- A session whose cost is not known.
         INSERT INTO sessions (id, repo_id, pull, started_at, cost_usd) VALUES ('ses_n', 'a', 3, '2026-10-06T00:00:00Z', NULL);
         -- A session tied to nothing counts with nothing.
         INSERT INTO sessions (id, repo_id, started_at, cost_usd) VALUES ('ses_x', 'a', '2026-10-06T00:00:00Z', 9);",
    )
    .unwrap();
    let mut costs: Vec<(u32, f64)> = pulls(&db).iter().map(|p| (p.number, p.session_cost_usd)).collect();
    costs.sort_by_key(|(number, _)| *number);
    assert_eq!(costs, [(1, 3.5), (2, 3.5), (3, 3.0), (4, 0.0)]);
}

fn session_spend(db: &Connection) -> Vec<(Option<u32>, String, f64)> {
    let mut found: Vec<(Option<u32>, String, f64)> = rows::<SignalSessionSpend>(db, SESSIONS, &[&IDS, &"acme", &"2026-10-01T00:00:00"])
        .into_iter()
        .map(|row| (row.item, row.day, row.session_cost_usd))
        .collect();
    found.sort_by(|a, b| (a.0, &a.1).cmp(&(b.0, &b.1)));
    found
}

#[test]
fn session_spend_with_no_pull_request_counts_by_work_item_else_repository() {
    let db = schema();
    pull(&db, 1, "open", "2026-10-06T00:00:00Z", None, "2026-10-06T00:00:00Z");
    db.execute_batch(
        "INSERT INTO work_items (id, workspace, number, title, state) VALUES ('wki_7', 'acme', 7, 'Seven', 'open');
         INSERT INTO work_items (id, workspace, number, title, state) VALUES ('wki_8', 'acme', 8, 'Eight', 'closed');
         INSERT INTO work_items (id, workspace, number, title, state) VALUES ('wki_x', 'other', 9, 'Theirs', 'open');
         -- Tied to a pull request: pulls.sql counts it, and its untied subagent with it.
         INSERT INTO sessions (id, repo_id, pull, started_at, cost_usd) VALUES ('ses_p', 'a', 1, '2026-10-06T09:00:00Z', 5);
         INSERT INTO sessions (id, repo_id, parent_id, started_at, cost_usd) VALUES ('ses_pa', 'a', 'ses_p', '2026-10-06T09:00:00Z', 1);
         -- Claimed 7, and landed 8 by a push whose commit named it: split between them.
         INSERT INTO sessions (id, repo_id, started_at, cost_usd) VALUES ('ses_c', 'a', '2026-10-06T10:00:00Z', 4);
         INSERT INTO session_links (session_id, repo_id, kind, number, item_id, via) VALUES ('ses_c', 'a', 'item', 0, 'wki_7', 'claim');
         INSERT INTO session_links (session_id, repo_id, kind, number, item_id, via) VALUES ('ses_c', 'a', 'item', 0, 'wki_8', 'trailer');
         -- Its subagent with none of its own counts with its root's work items.
         INSERT INTO sessions (id, repo_id, parent_id, started_at, cost_usd) VALUES ('ses_ca', 'a', 'ses_c', '2026-10-07T10:00:00Z', 2);
         -- Said it works on 7 when it started.
         INSERT INTO sessions (id, repo_id, item_id, started_at, cost_usd) VALUES ('ses_i', 'a', 'wki_7', '2026-10-06T11:00:00Z', 0.5);
         -- Only named 8 in a prompt, or works on another workspace's: its repository's.
         INSERT INTO sessions (id, repo_id, started_at, cost_usd) VALUES ('ses_r', 'a', '2026-10-06T12:00:00Z', 3);
         INSERT INTO session_links (session_id, repo_id, kind, number, item_id, via) VALUES ('ses_r', 'a', 'item', 0, 'wki_8', 'ref');
         INSERT INTO sessions (id, repo_id, item_id, started_at, cost_usd) VALUES ('ses_o', 'a', 'wki_x', '2026-10-06T13:00:00Z', 1);
         -- Of no known cost, before since, or another repository's: left out.
         INSERT INTO sessions (id, repo_id, started_at, cost_usd) VALUES ('ses_n', 'a', '2026-10-06T14:00:00Z', NULL);
         INSERT INTO sessions (id, repo_id, started_at, cost_usd) VALUES ('ses_e', 'a', '2026-09-30T23:00:00Z', 8);
         INSERT INTO sessions (id, repo_id, started_at, cost_usd) VALUES ('ses_b', 'b', '2026-10-06T14:00:00Z', 8);",
    )
    .unwrap();
    assert_eq!(
        session_spend(&db),
        [
            (None, "2026-10-06".to_owned(), 4.0),
            (Some(7), "2026-10-06".to_owned(), 2.5),
            (Some(7), "2026-10-07".to_owned(), 1.0),
            (Some(8), "2026-10-06".to_owned(), 2.0),
            (Some(8), "2026-10-07".to_owned(), 1.0),
        ]
    );
}

#[test]
fn harnesses_are_peoples_root_sessions() {
    let db = schema();
    db.execute_batch(
        "INSERT INTO sessions (id, repo_id, started_at, harness, actor_name)
           VALUES ('s1', 'a', '2026-01-01T00:00:00Z', 'claude_code', 'ana');
         INSERT INTO sessions (id, repo_id, started_at, harness, actor_name)
           VALUES ('s2', 'a', '2026-05-01T00:00:00Z', 'claude_code', 'ana-new');
         INSERT INTO sessions (id, repo_id, started_at, harness, actor_name)
           VALUES ('s3', 'a', '2026-03-01T00:00:00Z', 'codex', 'ana');
         -- A subagent is its parent's: not counted, and not when they first used it.
         INSERT INTO sessions (id, repo_id, parent_id, started_at, harness)
           VALUES ('s4', 'a', 's1', '2025-12-01T00:00:00Z', 'claude_code');
         INSERT INTO sessions (id, repo_id, parent_id, started_at, harness)
           VALUES ('s5', 'a', 's1', '2025-12-01T00:00:00Z', 'cursor');
         -- Robots, and another repository.
         INSERT INTO sessions (id, repo_id, started_at, actor_id) VALUES ('s6', 'a', '2026-01-01T00:00:00Z', 'usr_g1t_agent');
         INSERT INTO sessions (id, repo_id, started_at, actor_id) VALUES ('s7', 'a', '2026-01-01T00:00:00Z', 'agt_margo');
         INSERT INTO sessions (id, repo_id, started_at) VALUES ('s8', 'b', '2025-01-01T00:00:00Z');",
    )
    .unwrap();
    let found: Vec<SignalHarness> =
        rows::<SignalHarness>(&db, HARNESSES, &[&IDS]).into_iter().filter(|harness| is_person(&harness.owner_id)).collect();
    let shown: Vec<(&str, &str, &str, &str, &str, u32)> = found
        .iter()
        .map(|h| (h.repo_id.as_str(), h.owner_id.as_str(), h.owner_name.as_str(), h.harness.as_str(), h.first_at.as_str(), h.sessions))
        .collect();
    assert_eq!(
        shown,
        [
            ("a", "usr_ana", "ana-new", "claude_code", "2026-01-01T00:00:00Z", 2),
            ("a", "usr_ana", "ana-new", "codex", "2026-03-01T00:00:00Z", 1)
        ]
    );
}

#[test]
fn agent_commits_are_a_sessions_own_outside_any_pull_request() {
    let db = schema();
    pull(&db, 1, "open", "2026-10-06T00:00:00Z", None, "2026-10-06T00:00:00Z");
    db.execute_batch(
        "UPDATE pulls SET source_branch = 'feature' WHERE number = 1;
         INSERT INTO sessions (id, repo_id, started_at) VALUES ('ses_main', 'a', '2026-10-06T00:00:00Z');
         INSERT INTO sessions (id, repo_id, started_at) VALUES ('ses_pr', 'a', '2026-10-06T00:00:00Z');
         INSERT INTO session_touches VALUES ('ses_main', 'a', 'commit', 'c1', '2026-10-06T10:00:00Z');
         INSERT INTO session_touches VALUES ('ses_main', 'a', 'commit', 'c1', '2026-10-06T10:00:01Z');
         INSERT INTO session_touches VALUES ('ses_main', 'a', 'commit', 'c2', '2026-10-01T10:00:00Z');
         INSERT INTO session_touches VALUES ('ses_main', 'b', 'commit', 'c9', '2026-10-06T10:00:00Z');
         INSERT INTO session_touches VALUES ('ses_pr', 'a', 'branch', 'feature', '2026-10-06T09:00:00Z');
         INSERT INTO session_touches VALUES ('ses_pr', 'a', 'commit', 'c3', '2026-10-06T10:00:00Z');",
    )
    .unwrap();
    let found = weeks(&db, "2026-10-18T00:00:00Z");
    // c1 once, in its week; c2 in the week before; c3 belongs to a pull request's session; c9 to another repository.
    assert_eq!(in_week(&found, "2026-10-05").agent_commits, 1);
    assert_eq!(in_week(&found, "2026-09-28").agent_commits, 1);
    let window = window("2026-10-18T00:00:00Z");
    let days: Vec<SignalDay> = rows(&db, DAYS, &[&IDS, &window.days_from, &window.end]);
    let commits: Vec<(&str, u32)> = days.iter().filter(|d| d.agent_commits > 0).map(|d| (d.day.as_str(), d.agent_commits)).collect();
    assert_eq!(commits, [("2026-10-06", 1)], "the days read are the last two weeks; c2 is before them");
}

#[test]
fn a_cloud_agents_pull_request_is_an_agents_for_whoever_started_it() {
    let db = schema();
    for number in 1..=4 {
        pull(&db, number, "merged", "2026-10-06T12:00:00Z", Some("2026-10-07T12:00:00Z"), "2026-10-07T12:00:00Z");
    }
    db.execute_batch(
        "-- 1: Copilot's commits, for bo, opened by a token of the workspace.
         UPDATE pulls SET author_id = 'wsp_acme', author_name = 'acme', agent_rule = 'trailer:agent-logs-url',
           agent_name = 'copilot', agent_by_id = 'usr_bo', agent_by_name = 'bo' WHERE number = 1;
         -- 2: Cursor beside a person g1t can't match: an agent's, still ana's.
         UPDATE pulls SET agent_rule = 'coauthor:cursor', agent_name = 'cursor' WHERE number = 2;
         -- 3: Claude's address on it, and a session tied too: the session says it.
         UPDATE pulls SET agent_rule = 'coauthor:claude', agent_name = 'claude' WHERE number = 3;
         INSERT INTO sessions (id, repo_id, pull, started_at) VALUES ('ses_3', 'a', 3, '2026-10-06T11:00:00Z');
         -- 4: someone asked for it: theirs, whoever started the agent.
         UPDATE pulls SET agent_rule = 'author:devin', agent_name = 'devin', agent_by_id = 'usr_bo', agent_by_name = 'bo',
           requested_by_id = 'usr_cy', requested_by_name = 'cy' WHERE number = 4;",
    )
    .unwrap();
    pull(&db, 5, "merged", "2026-10-06T12:00:00Z", Some("2026-10-07T12:00:00Z"), "2026-10-07T12:00:00Z");
    let mut found: Vec<(u32, bool, Option<String>, String)> =
        pulls(&db).into_iter().map(|p| (p.number, p.agent, p.agent_rule, p.owner_name)).collect();
    found.sort();
    let rule = |r: &str| Some(r.to_owned());
    assert_eq!(
        found,
        [
            (1, true, rule("trailer:agent-logs-url"), "bo".to_owned()),
            (2, true, rule("coauthor:cursor"), "ana".to_owned()),
            (3, true, rule("session"), "ana".to_owned()),
            (4, true, rule("author:devin"), "cy".to_owned()),
            (5, false, None, "ana".to_owned()),
        ]
    );
    assert_eq!(in_week(&weeks(&db, "2026-10-18T00:00:00Z"), "2026-10-05").agent_merged, 4);
    // Merged work counts for the person who started the agent.
    let authors: Vec<SignalAuthor> = rows::<SignalAuthor>(&db, AUTHORS, &[&IDS, &"2026-07-14T00:00:00", &"2026-10-12T00:00:00"]);
    let mut owners: Vec<(String, u32)> = authors.into_iter().map(|a| (a.owner_name, a.merged)).collect();
    owners.sort();
    assert_eq!(owners, [("ana".to_owned(), 3), ("bo".to_owned(), 1), ("cy".to_owned(), 1)]);
}

#[test]
fn a_cloud_agents_direct_commits_count_once_beside_sessions() {
    let db = schema();
    db.execute_batch(
        "INSERT INTO sessions (id, repo_id, started_at) VALUES ('ses_main', 'a', '2026-10-06T00:00:00Z');
         INSERT INTO session_touches VALUES ('ses_main', 'a', 'commit', 'c1', '2026-10-06T10:00:00Z');
         -- c1 a session recorded: once. c4 is in another repository.
         INSERT INTO agent_commits VALUES ('a', 'c1', 'claude', 'coauthor:claude', NULL, NULL, '2026-10-06T10:00:02Z');
         INSERT INTO agent_commits VALUES ('a', 'c2', 'copilot', 'trailer:agent-logs-url', 'usr_bo', 'bo', '2026-10-06T11:00:00Z');
         INSERT INTO agent_commits VALUES ('a', 'c3', 'cursor', 'author:cursor', NULL, NULL, '2026-10-07T09:00:00Z');
         INSERT INTO agent_commits VALUES ('a', 'c0', 'cursor', 'trailer:made-with-cursor', NULL, NULL, '2026-10-01T09:00:00Z');
         INSERT INTO agent_commits VALUES ('b', 'c4', 'devin', 'author:devin', NULL, NULL, '2026-10-06T11:00:00Z');",
    )
    .unwrap();
    let found = weeks(&db, "2026-10-18T00:00:00Z");
    assert_eq!(in_week(&found, "2026-10-05").agent_commits, 3);
    assert_eq!(in_week(&found, "2026-09-28").agent_commits, 1);
    let window = window("2026-10-18T00:00:00Z");
    let days: Vec<SignalDay> = rows(&db, DAYS, &[&IDS, &window.days_from, &window.end]);
    let commits: Vec<(&str, u32)> = days.iter().filter(|d| d.agent_commits > 0).map(|d| (d.day.as_str(), d.agent_commits)).collect();
    assert_eq!(commits, [("2026-10-06", 2), ("2026-10-07", 1)]);
}
