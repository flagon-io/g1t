use g1t_contracts::work::{SignalAuthor, SignalDay, SignalPull, SignalWeek, WaitingPull, WorkspaceSignalsArgs};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, ToSql, params};
use serde::de::DeserializeOwned;

use super::{AUTHORS, DAYS, PULLS, PullRow, WAITING, WEEKS, WaitingRow, Window, is_person};

const IDS: &str = r#"["a"]"#;

fn schema() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(
        "CREATE TABLE pulls (id TEXT, repo_id TEXT, number INTEGER, title TEXT DEFAULT 'A change', status TEXT,
           item_id TEXT, milestone INTEGER, agent TEXT DEFAULT 'person', author_id TEXT DEFAULT 'usr_ana',
           author_name TEXT DEFAULT 'ana', requested_by_id TEXT, requested_by_name TEXT,
           source_branch TEXT, fork_repo_id TEXT, head_repo_id TEXT,
           created_at TEXT, updated_at TEXT, merged_at TEXT);
         CREATE TABLE comments (repo_id TEXT, number INTEGER, author_id TEXT, agent_id TEXT, verdict TEXT, created_at TEXT);
         CREATE TABLE sessions (id TEXT, repo_id TEXT, pull INTEGER, started_at TEXT);
         CREATE TABLE session_links (session_id TEXT, repo_id TEXT, kind TEXT, number INTEGER);
         CREATE TABLE session_touches (session_id TEXT, repo_id TEXT, kind TEXT, value TEXT);
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
        params![
            format!("pr_{number}"),
            number,
            status,
            created,
            merged,
            updated,
            format!("branch-{number}")
        ],
    )
    .unwrap();
}

fn comment(db: &Connection, number: u32, author: &str, agent: Option<&str>, verdict: Option<&str>, at: &str) {
    db.execute(
        "INSERT INTO comments VALUES ('a', ?1, ?2, ?3, ?4, ?5)",
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
    rows::<PullRow>(db, PULLS, &[&IDS, &"acme", &"2026-01-01T00:00:00"])
        .into_iter()
        .map(Into::into)
        .collect()
}

fn waiting(db: &Connection) -> Vec<WaitingPull> {
    rows::<WaitingRow>(db, WAITING, &[&IDS, &"acme"])
        .into_iter()
        .map(Into::into)
        .collect()
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
    assert_eq!(
        weeks[1]["cut"], "2026-10-12T00:00:00.000Z",
        "a week already over ends at its end"
    );
    assert_eq!(
        (
            window.days_from.as_str(),
            window.end.as_str(),
            window.since.as_str(),
            window.recent_from.as_str()
        ),
        (
            "2026-10-09T00:00:00",
            "2026-10-12T00:00:00",
            "2026-09-01T00:00:00",
            "2026-07-14T00:00:00"
        )
    );
}

#[test]
fn an_agents_pull_request_is_one_a_session_is_tied_to() {
    let db = schema();
    for number in 1..=6 {
        pull(
            &db,
            number,
            "open",
            "2026-10-06T12:00:00Z",
            None,
            "2026-10-06T12:00:00Z",
        );
    }
    db.execute_batch(
        "UPDATE pulls SET agent = 'agent' WHERE number = 1;
         UPDATE pulls SET author_id = 'usr_g1t_agent', requested_by_id = 'usr_ana', requested_by_name = 'ana' WHERE number = 2;
         -- 3 by a link, 4 by the session saying so, 5 by a push to its branch.
         INSERT INTO sessions VALUES ('ses_3', 'a', NULL, '2026-10-06T11:00:00Z');
         INSERT INTO session_links VALUES ('ses_3', 'a', 'pull', 3);
         INSERT INTO sessions VALUES ('ses_4', 'a', 4, '2026-10-06T13:00:00Z');
         INSERT INTO sessions VALUES ('ses_5', 'a', NULL, '2026-10-06T11:30:00Z');
         INSERT INTO sessions VALUES ('ses_5b', 'a', NULL, '2026-10-06T10:00:00.500Z');
         INSERT INTO session_touches VALUES ('ses_5', 'a', 'branch', 'branch-5');
         INSERT INTO session_touches VALUES ('ses_5b', 'a', 'branch', 'branch-5');
         -- 6's branch is on a fork: a push to the same name is not its.
         UPDATE pulls SET fork_repo_id = 'fork' WHERE number = 6;
         INSERT INTO sessions VALUES ('ses_6', 'a', NULL, '2026-10-06T11:00:00Z');
         INSERT INTO session_touches VALUES ('ses_6', 'a', 'branch', 'branch-6');
         -- A session of another repository with the same number is not its.
         INSERT INTO sessions VALUES ('ses_x', 'b', 6, '2026-10-06T11:00:00Z');",
    )
    .unwrap();
    pull(&db, 7, "open", "2026-10-06T12:00:00Z", None, "2026-10-06T12:00:00Z");
    let mut agents: Vec<(u32, bool)> = pulls(&db).iter().map(|p| (p.number, p.agent)).collect();
    agents.sort();
    assert_eq!(
        agents,
        [
            (1, true),
            (2, true),
            (3, true),
            (4, true),
            (5, true),
            (6, false),
            (7, false)
        ]
    );
    assert_eq!(
        pulls(&db).iter().find(|p| p.number == 2).unwrap().owner_id,
        "usr_ana",
        "whose g1t's is"
    );

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
    pull(
        &db,
        1,
        "merged",
        "2026-10-05T00:00:00Z",
        Some("2026-10-07T00:00:00Z"),
        "2026-10-07T00:00:00Z",
    );
    pull(
        &db,
        2,
        "merged",
        "2026-10-05T00:00:00Z",
        Some("2026-10-07T00:00:00Z"),
        "2026-10-07T00:00:00Z",
    );
    db.execute_batch("UPDATE pulls SET agent = 'agent'").unwrap();
    // None of these is a person's, before it merged, on 1.
    comment(&db, 1, "usr_ana", None, Some("request_changes"), "2026-10-06T00:00:00Z");
    comment(
        &db,
        1,
        "usr_g1t_agent",
        None,
        Some("request_changes"),
        "2026-10-06T00:00:00Z",
    );
    comment(
        &db,
        1,
        "agt_margo",
        Some("agt_margo"),
        Some("request_changes"),
        "2026-10-06T00:00:00Z",
    );
    comment(&db, 1, "usr_bo", None, Some("approve"), "2026-10-06T00:00:00Z");
    comment(&db, 1, "usr_bo", None, Some("request_changes"), "2026-10-08T00:00:00Z");
    comment(&db, 2, "usr_bo", None, Some("request_changes"), "2026-10-06T00:00:00Z");
    let found = weeks(&db, "2026-10-18T00:00:00Z");
    assert_eq!(found.len(), 1);
    let week = &found[0];
    assert_eq!(
        (week.start.as_str(), week.merged, week.agent_merged, week.agent_reworked),
        ("2026-10-05", 2, 2, 1)
    );
    // A person's pull request asked for changes is not an agent's rework.
    db.execute("UPDATE pulls SET agent = 'person' WHERE number = 2", [])
        .unwrap();
    let week = in_week(&weeks(&db, "2026-10-18T00:00:00Z"), "2026-10-05");
    assert_eq!((week.merged, week.agent_merged, week.agent_reworked), (2, 1, 0));
}

#[test]
fn stalled_is_open_over_a_week_when_the_week_ended() {
    let db = schema();
    // The second week ends at 2026-10-12T00:00:00Z: over seven days open
    // by then is opened before 10-05.
    pull(&db, 1, "open", "2026-10-05T00:00:00Z", None, "2026-10-05T00:00:00Z");
    pull(&db, 2, "open", "2026-10-04T23:59:59Z", None, "2026-10-04T23:59:59Z");
    // Merged after the week ended: still open when it did.
    pull(
        &db,
        3,
        "merged",
        "2026-09-01T00:00:00Z",
        Some("2026-10-12T00:00:00Z"),
        "2026-10-12T00:00:00Z",
    );
    // Merged and closed before it ended.
    pull(
        &db,
        4,
        "merged",
        "2026-09-01T00:00:00Z",
        Some("2026-10-11T23:00:00Z"),
        "2026-10-11T23:00:00Z",
    );
    pull(&db, 5, "closed", "2026-09-01T00:00:00Z", None, "2026-10-11T23:00:00Z");
    // Closed after it ended.
    pull(&db, 6, "closed", "2026-09-01T00:00:00Z", None, "2026-10-13T00:00:00Z");
    pull(&db, 7, "draft", "2026-09-27T00:00:00Z", None, "2026-09-27T00:00:00Z");
    let found = weeks(&db, "2026-10-18T00:00:00Z");
    let stalled: Vec<(&str, u32)> = found.iter().map(|w| (w.start.as_str(), w.stalled)).collect();
    // The first week ends on 10-05: 3 to 6 open since 09-01, and 7 opened
    // a second over seven days before. The second: 2, 3, 6 and 7.
    assert_eq!(stalled, [("2026-09-28", 5), ("2026-10-05", 4)]);

    // Read mid-week, the current week ends now, 10-08T12:00: 3, 4, 5 and
    // 6 were not finished by then, 7 is old enough, 2 is not, and 1 at
    // exactly seven days is not either.
    db.execute(
        "UPDATE pulls SET created_at = '2026-10-01T12:00:00Z' WHERE number = 1",
        [],
    )
    .unwrap();
    assert_eq!(in_week(&weeks(&db, "2026-10-08T12:00:00Z"), "2026-10-05").stalled, 5);
    db.execute(
        "UPDATE pulls SET created_at = '2026-10-01T11:59:59Z' WHERE number = 1",
        [],
    )
    .unwrap();
    assert_eq!(in_week(&weeks(&db, "2026-10-08T12:00:00Z"), "2026-10-05").stalled, 6);
}

#[test]
fn a_first_review_is_a_persons_other_than_the_owner() {
    let db = schema();
    pull(&db, 1, "open", "2026-10-06T00:00:00Z", None, "2026-10-06T00:00:00Z");
    db.execute_batch(
        "UPDATE pulls SET author_id = 'usr_g1t_agent', requested_by_id = 'owner', requested_by_name = 'owner'",
    )
    .unwrap();
    comment(&db, 1, "usr_g1t_agent", None, Some("approve"), "2026-10-06T01:00:00Z");
    comment(&db, 1, "owner", None, Some("approve"), "2026-10-06T02:00:00Z");
    comment(
        &db,
        1,
        "agt_margo",
        Some("agt_margo"),
        Some("approve"),
        "2026-10-06T03:00:00Z",
    );
    comment(&db, 1, "usr_bo", None, None, "2026-10-06T03:30:00Z");
    assert!(weeks(&db, "2026-10-18T00:00:00Z").iter().all(|w| w.reviewed == 0));
    assert_eq!(
        waiting(&db).len(),
        1,
        "g1t, an agent, the owner and a plain comment are no review"
    );
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
    assert_eq!(
        shown,
        [(11, None, vec![]), (10, Some(1), vec![2, 4])],
        "oldest first; drafts wait on no one"
    );
    // Its milestone is its work item's.
    let pull = pulls(&db).into_iter().find(|p| p.number == 10).unwrap();
    assert_eq!((pull.item, pull.milestone), (Some(1), Some(3)));
}

#[test]
fn a_pull_requests_own_milestone_counts_only_when_it_is_the_workspaces() {
    let db = schema();
    pull(&db, 1, "open", "2026-10-02T00:00:00Z", None, "2026-10-02T00:00:00Z");
    pull(&db, 2, "open", "2026-10-02T00:00:00Z", None, "2026-10-02T00:00:00Z");
    pull(
        &db,
        3,
        "merged",
        "2025-01-01T00:00:00Z",
        Some("2026-10-03T00:00:00Z"),
        "2026-10-03T00:00:00Z",
    );
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
    assert_eq!(
        found,
        [(1, Some(1)), (2, None), (3, None)],
        "merged since counts; closed long-opened does not"
    );
}

#[test]
fn authors_are_people_with_merged_work() {
    let db = schema();
    pull(
        &db,
        1,
        "merged",
        "2025-01-01T00:00:00Z",
        Some("2025-01-02T00:00:00Z"),
        "2025-01-02T00:00:00Z",
    );
    pull(
        &db,
        2,
        "merged",
        "2026-10-01T00:00:00Z",
        Some("2026-10-02T00:00:00Z"),
        "2026-10-02T00:00:00Z",
    );
    pull(&db, 3, "open", "2026-10-01T00:00:00Z", None, "2026-10-01T00:00:00Z");
    for (number, author) in [
        (4, "usr_g1t_agent"),
        (5, "agt_margo"),
        (6, "wsp_acme"),
        (7, "g1t"),
        (8, "svc_runner"),
    ] {
        pull(
            &db,
            number,
            "merged",
            "2026-10-01T00:00:00Z",
            Some("2026-10-02T00:00:00Z"),
            "2026-10-02T00:00:00Z",
        );
        db.execute(
            "UPDATE pulls SET author_id = ?1 WHERE number = ?2",
            params![author, number],
        )
        .unwrap();
    }
    // g1t's agent's work for a person is theirs, under their name now.
    pull(
        &db,
        9,
        "merged",
        "2026-10-01T00:00:00Z",
        Some("2026-10-03T00:00:00Z"),
        "2026-10-03T00:00:00Z",
    );
    db.execute_batch(
        "UPDATE pulls SET author_id = 'usr_g1t_agent', requested_by_id = 'usr_ana', requested_by_name = 'ana-renamed' WHERE number = 9",
    )
    .unwrap();
    let found: Vec<SignalAuthor> =
        rows::<SignalAuthor>(&db, AUTHORS, &[&IDS, &"2026-07-14T00:00:00", &"2026-10-12T00:00:00"])
            .into_iter()
            .filter(|author| is_person(&author.owner_id))
            .collect();
    assert_eq!(found.len(), 1);
    let ana = &found[0];
    assert_eq!(
        (
            ana.owner_id.as_str(),
            ana.owner_name.as_str(),
            ana.first_merged_at.as_str(),
            ana.last_merged_at.as_str()
        ),
        ("usr_ana", "ana-renamed", "2025-01-02T00:00:00Z", "2026-10-03T00:00:00Z")
    );
    assert_eq!((ana.merged, ana.recent), (3, 2));
}

#[test]
fn days_count_what_happened_on_each() {
    let db = schema();
    pull(
        &db,
        1,
        "merged",
        "2026-10-09T10:00:00Z",
        Some("2026-10-10T10:00:00Z"),
        "2026-10-10T10:00:00Z",
    );
    pull(&db, 2, "open", "2026-10-08T10:00:00Z", None, "2026-10-08T10:00:00Z");
    db.execute_batch(
        "UPDATE pulls SET agent = 'agent' WHERE number = 1;
         INSERT INTO sessions VALUES ('ses_1', 'a', NULL, '2026-10-10T09:00:00Z');
         INSERT INTO sessions VALUES ('ses_2', 'b', NULL, '2026-10-10T09:00:00Z');",
    )
    .unwrap();
    comment(&db, 1, "usr_bo", None, Some("request_changes"), "2026-10-10T01:00:00Z");
    comment(&db, 1, "usr_bo", None, None, "2026-10-10T02:00:00Z");
    comment(&db, 1, "usr_ana", None, None, "2026-10-10T03:00:00Z");
    comment(&db, 1, "g1t", None, None, "2026-10-10T03:00:00Z");
    comment(&db, 1, "agt_margo", Some("agt_margo"), None, "2026-10-10T03:00:00Z");
    let window = window("2026-10-18T00:00:00Z");
    let days: Vec<SignalDay> = rows(&db, DAYS, &[&IDS, &window.days_from, &window.end]);
    let shown: Vec<(&str, u32, u32, u32, u32, u32, u32)> = days
        .iter()
        .map(|d| {
            (
                d.day.as_str(),
                d.opened,
                d.merged,
                d.agent_merged,
                d.reworked,
                d.reviews,
                d.sessions,
            )
        })
        .collect();
    assert_eq!(
        shown,
        [
            ("2026-10-08", 1, 0, 0, 0, 0, 0),
            ("2026-10-09", 1, 0, 0, 0, 0, 0),
            ("2026-10-10", 0, 1, 1, 1, 2, 1)
        ],
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
