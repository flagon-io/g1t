//! Exercise the production transition SQL with interleaved attempts.
use rusqlite::{Connection, OptionalExtension, params};

use super::{
    ABANDON_LANDING, ACCEPT_BUILD, BEGIN_LANDING, CLAIM_BUILD, ENQUEUE, FINISH_CHECKS,
    FINISH_LANDING, LEAVE, PUBLISHING, REPORT_BUILD, RETEST, RETESTED, STILL_LANDING,
    attempt_branch,
};
use crate::integration::{FINISH_PROBE, REPORT_PROBE, RESOLVE_HELD};

fn database() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("PRAGMA foreign_keys = ON").unwrap();
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let mut paths: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "sql"))
        .collect();
    paths.sort();
    for path in paths {
        db.execute_batch(&std::fs::read_to_string(path).unwrap())
            .unwrap();
    }
    db.execute_batch("INSERT INTO pulls (id, repo_id, number, title, agent, runtime, author_id, author_name, status, created_at, updated_at)
        VALUES ('pull', 'repo', 1, 'Change', 'codex', 'external', 'user', 'user', 'open', 'now', 'now');
        INSERT INTO queue_entries (id, state, repo_id, pull_id, number, enqueued_by, created_at)
        VALUES ('entry', 'waiting', 'repo', 'pull', 1, '{}', 'now');").unwrap();
    db
}

#[test]
fn repeated_admission_is_atomic() {
    let db = database();
    db.execute("DELETE FROM queue_entries", []).unwrap();
    let enqueue = |id: &str| {
        db.query_row(
            ENQUEUE,
            params![id, "repo", "pull", 1, "{}", 0, "later", 0],
            |_| Ok(()),
        )
        .optional()
        .unwrap()
        .is_some()
    };
    assert!(enqueue("first"));
    assert!(!enqueue("second"));
    db.execute(
        "UPDATE queue_entries SET state = 'removed' WHERE id = 'first'",
        [],
    )
    .unwrap();
    assert!(enqueue("third"));
}

#[test]
fn stale_reset_and_held_failure_cannot_touch_a_replacement_attempt() {
    let db = database();
    assert!(claim(&db, "old"));
    assert!(report(&db, "old", "old-commit"));
    db.execute("UPDATE queue_entries SET held = 'failure'", [])
        .unwrap();
    assert_eq!(
        db.execute(RETEST, params!["entry", "old"])
            .unwrap(),
        1
    );
    assert!(claim(&db, "new"));
    assert!(report(&db, "new", "new-commit"));
    db.execute("UPDATE queue_entries SET held = 'failure'", [])
        .unwrap();
    assert_eq!(
        db.execute(RETEST, params!["entry", "old"])
            .unwrap(),
        0
    );
    assert!(
        db.query_row(
            RESOLVE_HELD,
            params!["now", "entry", "failure", "old"],
            |_| Ok(())
        )
        .optional()
        .unwrap()
        .is_none()
    );
    assert!(
        db.query_row(
            RESOLVE_HELD,
            params!["now", "entry", "failure", "new"],
            |_| Ok(())
        )
        .optional()
        .unwrap()
        .is_some()
    );
    assert_ne!(
        attempt_branch("entry", Some("old")),
        attempt_branch("entry", Some("new"))
    );
}

#[test]
fn removal_and_publication_have_one_winner_and_recovery_keeps_the_commit() {
    let db = database();
    assert!(claim(&db, "attempt"));
    assert!(report(&db, "attempt", "tested"));
    assert!(finish(&db, "tested"));
    let publish = || {
        db.query_row(BEGIN_LANDING, params!["entry", "tested", "attempt"], |_| {
            Ok(())
        })
        .optional()
        .unwrap()
        .is_some()
    };
    assert!(publish());
    assert!(publish(), "a crash resumes the same immutable publication");
    assert!(
        db.query_row(
            LEAVE,
            params!["removed", None::<String>, "now", "entry"],
            |_| Ok(())
        )
        .optional()
        .unwrap()
        .is_none()
    );
    assert_eq!(
        db.execute(RETEST, params!["entry", "attempt"])
            .unwrap(),
        0
    );
    assert!(
        db.query_row(
            BEGIN_LANDING,
            params!["entry", "different", "attempt"],
            |_| Ok(())
        )
        .optional()
        .unwrap()
        .is_none()
    );
    db.execute("UPDATE queue_entries SET landing_commit = NULL", [])
        .unwrap();
    assert!(
        db.query_row(
            LEAVE,
            params!["removed", None::<String>, "now", "entry"],
            |_| Ok(())
        )
        .optional()
        .unwrap()
        .is_some()
    );
    assert!(!publish());
}

#[test]
fn removing_a_predecessor_invalidates_the_same_attempt_even_if_it_just_passed() {
    let db = database();
    assert!(claim(&db, "attempt"));
    // Removal read this attempt while it was building; its result arrives
    // before the dependent entry's reset reaches the database.
    assert!(report(&db, "attempt", "includes-removed-predecessor"));
    assert!(finish(&db, "includes-removed-predecessor"));
    assert_eq!(db.execute(RETEST, params!["entry", "attempt"]).unwrap(), 1);
    assert!(!finish(&db, "includes-removed-predecessor"));
    assert!(claim(&db, "replacement"));
    assert_eq!(db.execute(RETEST, params!["entry", "attempt"]).unwrap(), 0);
}

#[test]
fn a_passing_entry_cannot_publish_ahead_of_an_unfinished_predecessor() {
    let db = database();
    assert!(claim(&db, "attempt"));
    assert!(report(&db, "attempt", "tested"));
    assert!(finish(&db, "tested"));
    db.execute("INSERT INTO queue_entries (id, repo_id, pull_id, number, enqueued_by, state, created_at) VALUES ('earlier', 'repo', 'other', 2, '{}', 'testing', 'before')", []).unwrap();
    db.execute("UPDATE queue_entries SET ahead = '[2]' WHERE id = 'entry'", []).unwrap();
    assert!(
        db.query_row(
            BEGIN_LANDING,
            params!["entry", "tested", "attempt"],
            |_| Ok(())
        )
        .optional()
        .unwrap()
        .is_none()
    );
    db.execute("UPDATE queue_entries SET state = 'removed' WHERE id = 'earlier'", []).unwrap();
    assert!(db.query_row(BEGIN_LANDING, params!["entry", "tested", "attempt"], |_| Ok(())).optional().unwrap().is_none(),
        "removing the predecessor cannot publish a combination that still contains it");
    db.execute(
        "UPDATE queue_entries SET state = 'landed' WHERE id = 'earlier'",
        [],
    )
    .unwrap();
    assert!(
        db.query_row(
            BEGIN_LANDING,
            params!["entry", "tested", "attempt"],
            |_| Ok(())
        )
        .optional()
        .unwrap()
        .is_some()
    );
}

#[test]
fn delayed_probe_reports_and_timeouts_cannot_replace_accepted_results() {
    let db = database();
    db.execute("INSERT INTO queue_probes (id, repo_id, entry_id, number, subset, state, token_hash, created_at) VALUES ('probe', 'repo', 'entry', 1, '[]', 'testing', 'token', 'now')", []).unwrap();
    assert!(
        db.query_row(
            REPORT_PROBE,
            params!["tested", "probe", "token"],
            |_| Ok(())
        )
        .optional()
        .unwrap()
        .is_some()
    );
    assert!(
        db.query_row(
            REPORT_PROBE,
            params!["different", "probe", "token"],
            |_| Ok(())
        )
        .optional()
        .unwrap()
        .is_none()
    );
    let finish = |token: Option<&str>, commit: Option<&str>| {
        db.query_row(
            FINISH_PROBE,
            params![
                "passed",
                None::<String>,
                "now",
                "probe",
                "testing",
                token,
                commit
            ],
            |_| Ok(()),
        )
        .optional()
        .unwrap()
        .is_some()
    };
    assert!(
        !finish(Some("token"), None),
        "timeout from before report acceptance"
    );
    assert!(!finish(None, Some("different")));
    assert!(finish(None, Some("tested")));
    assert!(!finish(None, Some("tested")));
}

fn claim(db: &Connection, token: &str) -> bool {
    db.query_row(
        CLAIM_BUILD,
        params![token, "head", "base", "[]", "now", "entry", "[]"],
        |_| Ok(()),
    )
    .optional()
    .unwrap()
    .is_some()
}

fn report(db: &Connection, token: &str, commit: &str) -> bool {
    if db
        .query_row(ACCEPT_BUILD, params![commit, "entry", token], |_| Ok(()))
        .optional()
        .unwrap()
        .is_none()
    {
        return false;
    }
    db.query_row(
        REPORT_BUILD,
        params![
            "testing",
            commit,
            "[]",
            None::<String>,
            None::<String>,
            0,
            "testing",
            "now",
            "entry",
            token,
            commit
        ],
        |_| Ok(()),
    )
    .optional()
    .unwrap()
    .is_some()
}

#[test]
fn a_workflow_finishing_during_dispatch_finds_the_accepted_commit() {
    let db = database();
    assert!(claim(&db, "attempt"));
    assert!(
        db.query_row(ACCEPT_BUILD, params!["tested", "entry", "attempt"], |_| Ok(
            ()
        ))
        .optional()
        .unwrap()
        .is_some()
    );
    assert!(
        !finish(&db, "tested"),
        "callbacks wait until every workflow is registered"
    );
    assert!(
        db.query_row(
            REPORT_BUILD,
            params![
                "testing",
                "tested",
                "[]",
                None::<String>,
                None::<String>,
                0,
                "testing",
                "now",
                "entry",
                "attempt",
                "tested"
            ],
            |_| Ok(())
        )
        .optional()
        .unwrap()
        .is_some()
    );
    // report_queue rereads the group's facts after opening this fence.
    assert!(finish(&db, "tested"));
    assert!(
        db.query_row(
            REPORT_BUILD,
            params![
                "testing",
                "tested",
                "[]",
                None::<String>,
                None::<String>,
                0,
                "testing",
                "now",
                "entry",
                "attempt",
                "tested"
            ],
            |_| Ok(())
        )
        .optional()
        .unwrap()
        .is_none()
    );
}

fn finish(db: &Connection, commit: &str) -> bool {
    db.query_row(
        FINISH_CHECKS,
        // As merge_group_finished binds it: the attempt of the row it read.
        params!["passed", None::<String>, "passed", "now", "entry", commit, current_attempt(db)],
        |_| Ok(()),
    )
    .optional()
    .unwrap()
    .is_some()
}

#[test]
fn only_the_scheduler_that_claimed_an_entry_may_start_its_build() {
    let db = database();
    assert!(claim(&db, "first"));
    assert!(!claim(&db, "second"));
    assert!(!report(&db, "second", "wrong"));
    assert!(report(&db, "first", "combined"));
    assert!(!report(&db, "first", "combined"));
    assert!(finish(&db, "combined"));
    assert!(!finish(&db, "combined"));
}

#[test]
fn a_result_read_before_removal_cannot_resurrect_the_entry() {
    let db = database();
    assert!(claim(&db, "first"));
    // report_queue has read the token, then the user removes the entry.
    db.execute("UPDATE queue_entries SET state = 'removed'", [])
        .unwrap();
    assert!(!report(&db, "first", "combined"));
    assert_eq!(
        db.query_row("SELECT state FROM queue_entries", [], |row| row
            .get::<_, String>(0))
            .unwrap(),
        "removed"
    );
}

#[test]
fn an_old_build_cannot_overwrite_a_retry() {
    let db = database();
    assert!(claim(&db, "old"));
    db.execute(
        "UPDATE queue_entries SET state = 'waiting', token_hash = NULL",
        [],
    )
    .unwrap();
    assert!(!report(&db, "old", "old-commit"));
    assert!(claim(&db, "new"));
    assert!(!report(&db, "old", "old-commit"));
    assert!(report(&db, "new", "new-commit"));
    assert!(finish(&db, "new-commit"));
}

#[test]
fn old_workflow_callbacks_cannot_pass_a_new_attempt() {
    let db = database();
    assert!(claim(&db, "old"));
    assert!(report(&db, "old", "old-commit"));
    // The callback read this row before a retry reset it.
    db.execute(
        "UPDATE queue_entries SET state = 'waiting', combined_commit = NULL",
        [],
    )
    .unwrap();
    assert!(claim(&db, "new"));
    assert!(!finish(&db, "old-commit"));
    assert!(report(&db, "new", "new-commit"));
    assert!(!finish(&db, "old-commit"));
    assert!(finish(&db, "new-commit"));
}

fn exists(db: &Connection, sql: &str, args: impl rusqlite::Params) -> bool {
    db.query_row(sql, args, |_| Ok(())).optional().unwrap().is_some()
}

#[test]
fn a_publisher_that_lost_the_race_cannot_undo_the_winners_landing() {
    let db = database();
    assert!(claim(&db, "attempt"));
    assert!(report(&db, "attempt", "tested"));
    assert!(finish(&db, "tested"));
    // Two settle passes (a poll and a callback) both take the intent: it is
    // resumable by design, so it is not exclusive.
    assert!(exists(&db, BEGIN_LANDING, params!["entry", "tested", "attempt"]));
    assert!(exists(&db, BEGIN_LANDING, params!["entry", "tested", "attempt"]));
    // Mid-flight, the loser's failed compare-and-swap cannot tell it apart
    // from the winner: it must ask Git again (settle) before abandoning.
    assert!(exists(&db, STILL_LANDING, params!["entry", "tested"]));
    // The winner records the merge and finishes, dropping the tested branch;
    // the loser's retry then fails for want of that branch.
    assert_eq!(db.execute(FINISH_LANDING, params!["now", "entry"]).unwrap(), 1);
    assert!(!exists(&db, STILL_LANDING, params!["entry", "tested"]));
    assert!(
        !exists(&db, ABANDON_LANDING, params!["entry", "tested"]),
        "only a holder of the intent may give it up, so nothing is retested"
    );
    assert_eq!(db.execute(RETEST, params!["entry", "attempt"]).unwrap(), 0);
    assert_eq!(
        db.query_row("SELECT state FROM queue_entries", [], |row| row.get::<_, String>(0)).unwrap(),
        "landed"
    );
}

#[test]
fn a_genuinely_refused_publication_is_abandoned_once() {
    let db = database();
    assert!(claim(&db, "attempt"));
    assert!(report(&db, "attempt", "tested"));
    assert!(finish(&db, "tested"));
    assert!(exists(&db, BEGIN_LANDING, params!["entry", "tested", "attempt"]));
    assert!(exists(&db, PUBLISHING, params!["pull"]), "removal, closing and rebasing are refused");
    assert!(exists(&db, ABANDON_LANDING, params!["entry", "tested"]));
    assert!(!exists(&db, ABANDON_LANDING, params!["entry", "tested"]));
    assert!(!exists(&db, PUBLISHING, params!["pull"]));
    assert_eq!(db.execute(RETEST, params!["entry", "attempt"]).unwrap(), 1);
}

#[test]
fn only_a_reset_attempt_gives_up_its_branch() {
    let db = database();
    assert!(claim(&db, "attempt"));
    assert!(report(&db, "attempt", "tested"));
    assert!(finish(&db, "tested"));
    assert!(exists(&db, BEGIN_LANDING, params!["entry", "tested", "attempt"]));
    // Being published: the reset does nothing and the branch must stay.
    assert_eq!(db.execute(RETEST, params!["entry", "attempt"]).unwrap(), 0);
    assert!(!exists(&db, RETESTED, params!["entry", "attempt"]));
    assert!(exists(&db, ABANDON_LANDING, params!["entry", "tested"]));
    assert_eq!(db.execute(RETEST, params!["entry", "attempt"]).unwrap(), 1);
    assert!(exists(&db, RETESTED, params!["entry", "attempt"]));
    // A newer attempt's branch is never the reset one's.
    assert!(claim(&db, "next"));
    assert!(!exists(&db, RETESTED, params!["entry", "attempt"]));
}

#[test]
fn a_bypass_asked_for_at_admission_is_kept_for_landing() {
    let db = database();
    db.execute("DELETE FROM queue_entries", []).unwrap();
    assert!(exists(&db, ENQUEUE, params!["first", "repo", "pull", 1, "{}", 0, "later", 1]));
    assert_eq!(
        db.query_row("SELECT bypass_rules FROM queue_entries", [], |row| row.get::<_, u32>(0)).unwrap(),
        1
    );
    let person = g1t_contracts::User { id: "u".into(), username: "u".into(), ..Default::default() };
    assert!(crate::rulesets::landing_honors_bypass(&person, true));
    assert!(!crate::rulesets::landing_honors_bypass(&person, false));
    assert!(crate::rulesets::landing_honors_bypass(&g1t_contracts::User::system("ns"), false));
}

fn current_attempt(db: &Connection) -> Option<String> {
    db.query_row("SELECT attempt_id FROM queue_entries WHERE id = 'entry'", [], |row| row.get(0)).unwrap()
}

#[test]
fn a_callback_read_for_an_earlier_attempt_cannot_finish_a_retry_on_the_same_commit() {
    let db = database();
    assert!(claim(&db, "old"));
    assert!(report(&db, "old", "same"));
    assert_eq!(db.execute(RETEST, params!["entry", "old"]).unwrap(), 1);
    assert!(claim(&db, "new"));
    assert!(report(&db, "new", "same"));
    let finish_as = |attempt: &str| {
        exists(&db, FINISH_CHECKS, params!["failed", None::<String>, "failed", "now", "entry", "same", attempt])
    };
    assert!(!finish_as("old"), "the row it read belonged to the earlier attempt");
    assert!(finish_as("new"));
}

#[test]
fn each_attempt_records_exactly_the_stack_it_built() {
    let db = database();
    let stack = |commit: &str| {
        serde_json::json!([{ "number": 1, "title": "Change", "source": { "namespace": "ns", "name": "repo" },
            "branch": "feature", "commit": commit }])
        .to_string()
    };
    let claim_with = |token: &str, built: &str| {
        exists(&db, CLAIM_BUILD, params![token, built, "base", "[]", "now", "entry", stack(built)])
    };
    assert!(claim_with("first", "c1"));
    assert_eq!(db.execute(RETEST, params!["entry", "first"]).unwrap(), 1);
    assert!(claim_with("second", "c2"));
    let row: super::EntryRow = {
        let mut statement = db.prepare("SELECT * FROM queue_entries WHERE id = 'entry'").unwrap();
        let names: Vec<String> = statement.column_names().iter().map(|name| (*name).to_owned()).collect();
        statement
            .query_row([], |row| {
                let mut object = serde_json::Map::new();
                for (index, name) in names.iter().enumerate() {
                    let value: rusqlite::types::Value = row.get(index)?;
                    object.insert(name.clone(), match value {
                        rusqlite::types::Value::Null => serde_json::Value::Null,
                        rusqlite::types::Value::Integer(n) => n.into(),
                        rusqlite::types::Value::Real(n) => n.into(),
                        rusqlite::types::Value::Text(text) => text.into(),
                        rusqlite::types::Value::Blob(_) => serde_json::Value::Null,
                    });
                }
                Ok(serde_json::from_value(serde_json::Value::Object(object)).unwrap())
            })
            .unwrap()
    };
    let recorded = row.tested_stack().unwrap();
    assert_eq!(recorded[0].commit, "c2", "the second attempt's own commits");
    assert!(crate::integration::recorded_stack(recorded.clone(), 1, &[]).is_some());
    assert!(crate::integration::recorded_stack(recorded, 1, &[7]).is_none(), "not the combination that failed");
}

#[test]
fn an_entry_whose_branch_is_gone_leaves_instead_of_blocking_those_behind() {
    let db = database();
    db.execute("INSERT INTO pulls (id, repo_id, number, title, agent, runtime, author_id, author_name, status, created_at, updated_at)
        VALUES ('later-pull', 'repo', 2, 'Next', 'codex', 'external', 'user', 'user', 'open', 'now', 'now')", []).unwrap();
    db.execute("INSERT INTO queue_entries (id, state, repo_id, pull_id, number, enqueued_by, created_at, attempt_id, combined_commit)
        VALUES ('later', 'passed', 'repo', 'later-pull', 2, '{}', 'then', 'a2', 'tested2')", []).unwrap();
    // 'entry' is waiting at the front and can never be built.
    assert!(!exists(&db, BEGIN_LANDING, params!["later", "tested2", "a2"]));
    assert!(exists(&db, LEAVE, params!["removed", super::BRANCH_GONE, "now", "entry"]));
    assert_eq!(
        db.query_row("SELECT error FROM queue_entries WHERE id = 'entry'", [], |row| row.get::<_, String>(0)).unwrap(),
        "Its branch no longer exists."
    );
    assert!(exists(&db, BEGIN_LANDING, params!["later", "tested2", "a2"]));
    assert_eq!(
        super::gone_note(super::BRANCH_GONE),
        "its branch no longer exists, so it cannot be tested or landed. Push the branch again and merge to rejoin."
    );
}
