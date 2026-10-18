//! Issues moving into work items, against the schema the migrations leave:
//! what migrations/0049_work_items.sql moves, what the job then numbers and
//! merges (work_migration.rs), how `#N` is read (items.rs `REF_SQL`), what
//! landing does (closing.rs) and where new numbers come from.

use rusqlite::{Connection, OptionalExtension, params};

use crate::closing::{LAND_SQL, PART_SQL};
use crate::items::{NEXT_NUMBER, Named, REF_SQL, REMEMBER_REPO, RefRow};
use crate::migrated::{database, database_before, migrate_from};
use crate::work_migration::{RECORD_REPO, TRANSFERRED, finish_sql};

const MIGRATION: &str = "0049_work_items.sql";

/// Binds `sql` with the first of `values` it names (`?1` up to its
/// highest), as D1 is bound.
fn run(db: &Connection, sql: &str, values: &[&dyn rusqlite::ToSql]) -> usize {
    db.execute(sql, &values[..g1t_kit::rename::parameters(sql)]).unwrap()
}

fn strings(db: &Connection, sql: &str) -> Vec<String> {
    let mut statement = db.prepare(sql).unwrap();
    statement.query_map([], |row| row.get::<_, String>(0)).unwrap().map(Result::unwrap).collect()
}

fn numbers(db: &Connection, sql: &str) -> Vec<(String, Option<u32>)> {
    let mut statement = db.prepare(sql).unwrap();
    statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?))).unwrap().map(Result::unwrap).collect()
}

/// Two repositories of `acme` whose issue and pull request numbers collide
/// (web: issues 1, 3 and 5, pull requests 2 and 4; api: issues 1 and 2,
/// pull request 3), and one of `globex`, as they were before work items.
fn legacy() -> Connection {
    let db = database_before(MIGRATION);
    db.execute_batch(
        "INSERT INTO counters (repo_id, last) VALUES ('rep_web', 5), ('rep_api', 3), ('rep_site', 2);
         INSERT INTO issues (id, repo_id, number, title, body, labels, state, reason, resolved_by, blocked_by, milestone,
                             author_id, author_name, created_at, updated_at, closed_at)
         VALUES ('iss_web1', 'rep_web', 1, 'Header', '', '[\"bug\"]', 'open', NULL, NULL, '[]', NULL, 'usr_1', 'ana', '2026-01-01', '2026-01-01', NULL),
                ('iss_api1', 'rep_api', 1, 'Rate limits', '', '[]', 'open', NULL, NULL, '[]', NULL, 'usr_1', 'ana', '2026-01-02', '2026-01-02', NULL),
                ('iss_web3', 'rep_web', 3, 'Footer', '', '[]', 'closed', 'completed', 4, '[1]', NULL, 'usr_1', 'ana', '2026-01-03', '2026-01-06', '2026-01-06'),
                ('iss_api2', 'rep_api', 2, 'Tokens', '', '[]', 'open', NULL, NULL, '[1]', 1, 'usr_2', 'bo', '2026-01-04', '2026-01-04', NULL),
                ('iss_web5', 'rep_web', 5, 'Logo', '', '[\"docs\"]', 'open', NULL, NULL, '[1, 3]', 1, 'usr_2', 'bo', '2026-01-05', '2026-01-05', NULL),
                ('iss_site1', 'rep_site', 1, 'Site', '', '[]', 'open', NULL, NULL, '[]', NULL, 'usr_1', 'ana', '2026-01-01', '2026-01-01', NULL);
         INSERT INTO pulls (id, repo_id, number, issue_id, issue_number, title, agent, runtime, status, closes, milestone,
                            author_id, author_name, created_at, updated_at)
         VALUES ('pr_web2', 'rep_web', 2, NULL, NULL, 'Tidy', 'ana', 'external', 'open', '[]', NULL, 'usr_1', 'ana', '', ''),
                ('pr_web4', 'rep_web', 4, 'iss_web3', 3, 'Fix footer', 'ana', 'external', 'merged', '[3, 1]', 1, 'usr_1', 'ana', '', ''),
                ('pr_api3', 'rep_api', 3, NULL, NULL, 'Limits', 'ana', 'external', 'open', '[]', NULL, 'usr_1', 'ana', '', ''),
                ('pr_site2', 'rep_site', 2, NULL, NULL, 'Site', 'ana', 'external', 'open', '[]', NULL, 'usr_1', 'ana', '', '');
         INSERT INTO comments (id, repo_id, number, author_id, author_name, body, created_at)
         VALUES ('cmt_issue', 'rep_web', 3, 'usr_1', 'ana', 'On the footer', ''),
                ('cmt_pull', 'rep_web', 4, 'usr_1', 'ana', 'On the fix', '');
         INSERT INTO sessions (id, repo_id, issue, actor_id, actor_name, harness, started_at, last_seen_at)
         VALUES ('ses_1', 'rep_api', 2, 'usr_1', 'ana', 'codex', '', '');
         INSERT INTO claims (id, repo_id, issue, actor_id, actor_name, ttl_minutes, created_at, expires_at)
         VALUES ('clm_1', 'rep_api', 2, 'usr_1', 'ana', 30, '', '');
         INSERT INTO labels (repo_id, name, color, description, created_at)
         VALUES ('rep_web', 'bug', 'd73a4a', 'Broken', '2026-01-01'), ('rep_web', 'docs', '0075ca', 'Words', '2026-01-03'),
                ('rep_api', 'bug', '0e8a16', 'Something broke', '2025-12-01');
         INSERT INTO milestones (repo_id, number, title, created_at, updated_at)
         VALUES ('rep_web', 1, 'Launch', '2026-01-02', '2026-01-02'), ('rep_api', 1, 'Beta', '2026-01-01', '2026-01-01');",
    )
    .unwrap();
    migrate_from(&db, MIGRATION);
    db
}

/// What the job records of each repository, then its last step.
fn finish(db: &Connection) {
    for (id, workspace, path) in [("rep_web", "acme", "acme/web"), ("rep_api", "acme", "acme/api"), ("rep_site", "globex", "globex/site")] {
        for sql in RECORD_REPO {
            run(db, sql, &[&id, &workspace, &path, &0]);
        }
    }
    for sql in finish_sql() {
        run(db, &sql, &[&"2026-10-17T00:00:00Z"]);
    }
}

fn reference(db: &Connection, repo: Option<&str>, workspace: &str, number: u32) -> Option<Named> {
    let row: RefRow = db
        .query_row(REF_SQL, params![repo, workspace, number], |row| {
            Ok(RefRow { pull_here: row.get(0)?, legacy: row.get(1)?, item: row.get(2)?, pull_there: row.get(3)? })
        })
        .unwrap();
    row.named(repo.is_some())
}

#[test]
fn the_migration_moves_every_issue_and_what_named_it_by_number() {
    let db = legacy();
    // Every issue is a work item, not yet in a workspace, filed from its
    // repository under its old number.
    assert_eq!(numbers(&db, "SELECT id, number FROM work_items ORDER BY id").len(), 6);
    assert!(strings(&db, "SELECT id FROM work_items WHERE workspace IS NOT NULL OR number IS NOT NULL").is_empty());
    let origins: Vec<(String, Option<u32>)> =
        numbers(&db, "SELECT item_id, legacy_number FROM work_item_repos WHERE role = 'origin' ORDER BY item_id");
    assert_eq!(origins.len(), 6);
    assert!(origins.contains(&("iss_web3".to_owned(), Some(3))) && origins.contains(&("iss_api1".to_owned(), Some(1))));
    // Blockers by id, in the same repository: web's #1 and #3, never api's #1.
    assert_eq!(strings(&db, "SELECT blocked_by FROM work_items WHERE id = 'iss_web5'"), [r#"["iss_web1","iss_web3"]"#]);
    assert_eq!(strings(&db, "SELECT blocked_by FROM work_items WHERE id = 'iss_api2'"), [r#"["iss_api1"]"#]);
    // What resolved it, and that it landed where it was filed.
    assert_eq!(
        strings(&db, "SELECT resolutions FROM work_items WHERE id = 'iss_web3'"),
        [r#"[{"repo_id":"rep_web","pull":4,"commit":null,"pushed_by":null}]"#]
    );
    assert_eq!(strings(&db, "SELECT landed_at FROM work_item_repos WHERE item_id = 'iss_web3'"), ["2026-01-06"]);
    // A pull request names its work item and what it closes by id.
    assert_eq!(strings(&db, "SELECT item_id FROM pulls WHERE id = 'pr_web4'"), ["iss_web3"]);
    assert_eq!(strings(&db, "SELECT closes_items FROM pulls WHERE id = 'pr_web4'"), [r#"["iss_web3","iss_web1"]"#]);
    // An issue's comment is the work item's; a pull request's stays its own.
    assert_eq!(strings(&db, "SELECT item_id FROM comments WHERE id = 'cmt_issue' AND repo_id IS NULL"), ["iss_web3"]);
    assert_eq!(strings(&db, "SELECT repo_id FROM comments WHERE id = 'cmt_pull' AND item_id IS NULL"), ["rep_web"]);
    // Sessions and claims follow the issue by id; the claim keeps its checkout.
    assert_eq!(strings(&db, "SELECT item_id FROM sessions WHERE id = 'ses_1'"), ["iss_api2"]);
    assert_eq!(strings(&db, "SELECT item_id || ' ' || repo_id FROM claims WHERE id = 'clm_1'"), ["iss_api2 rep_api"]);
    // Nothing points at a work item that is not there.
    assert!(db.prepare("PRAGMA foreign_key_check").unwrap().query_map([], |_| Ok(())).unwrap().next().is_none());
    // Until the job runs, an old #N is read by its old number.
    assert_eq!(reference(&db, Some("rep_web"), "acme", 3), Some(Named::Item("iss_web3".into())));
    assert_eq!(reference(&db, Some("rep_web"), "acme", 4), Some(Named::PullHere));
    assert_eq!(reference(&db, Some("rep_api"), "acme", 1), Some(Named::Item("iss_api1".into())));
}

#[test]
fn the_job_numbers_each_workspace_after_everything_it_used_oldest_first() {
    let db = legacy();
    finish(&db);
    // acme's repositories used up to 5: its work items go on from 6, in
    // the order they were opened, whichever repository they came from.
    assert_eq!(
        numbers(&db, "SELECT id, number FROM work_items WHERE workspace = 'acme' ORDER BY number"),
        [
            ("iss_web1".to_owned(), Some(6)),
            ("iss_api1".to_owned(), Some(7)),
            ("iss_web3".to_owned(), Some(8)),
            ("iss_api2".to_owned(), Some(9)),
            ("iss_web5".to_owned(), Some(10)),
        ]
    );
    assert_eq!(numbers(&db, "SELECT id, number FROM work_items WHERE workspace = 'globex'"), [("iss_site1".to_owned(), Some(3))]);
    assert_eq!(numbers(&db, "SELECT workspace, last FROM work_counters ORDER BY workspace"), [
        ("acme".to_owned(), Some(10)),
        ("globex".to_owned(), Some(3)),
    ]);
    // The per-repository counters are emptied; the job is done, and running
    // its last step again changes nothing.
    assert!(strings(&db, "SELECT repo_id FROM counters").is_empty());
    assert_eq!(strings(&db, "SELECT done_at FROM work_jobs WHERE name = 'work_items'"), ["2026-10-17T00:00:00Z"]);
    finish(&db);
    assert_eq!(numbers(&db, "SELECT id, number FROM work_items WHERE id = 'iss_web5'"), [("iss_web5".to_owned(), Some(10))]);
    assert_eq!(numbers(&db, "SELECT workspace, last FROM work_counters WHERE workspace = 'acme'"), [("acme".to_owned(), Some(10))]);
    // A pull request's own number and its paths follow.
    assert_eq!(strings(&db, "SELECT path FROM work_item_repos WHERE item_id = 'iss_api2'"), ["acme/api"]);
}

#[test]
fn labels_merge_by_name_and_the_first_made_keeps_its_color() {
    let db = legacy();
    finish(&db);
    let labels: Vec<(String, String, String)> = {
        let mut statement = db.prepare("SELECT name, color, description FROM labels WHERE workspace = 'acme' ORDER BY name").unwrap();
        statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).unwrap().map(Result::unwrap).collect()
    };
    assert_eq!(
        labels,
        [
            ("bug".to_owned(), "0e8a16".to_owned(), "Something broke".to_owned()),
            ("docs".to_owned(), "0075ca".to_owned(), "Words".to_owned()),
        ]
    );
    assert!(strings(&db, "SELECT name FROM repo_labels").is_empty());
}

#[test]
fn milestones_are_renumbered_in_the_workspace_and_what_was_in_them_follows() {
    let db = legacy();
    finish(&db);
    // Beta (api's, made first) is 1 and Launch (web's) 2 in acme.
    let milestones: Vec<(u32, String, String)> = {
        let mut statement =
            db.prepare("SELECT number, title, origin_repo_id FROM milestones WHERE workspace = 'acme' ORDER BY number").unwrap();
        statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).unwrap().map(Result::unwrap).collect()
    };
    assert_eq!(milestones, [(1, "Beta".to_owned(), "rep_api".to_owned()), (2, "Launch".to_owned(), "rep_web".to_owned())]);
    // web's #5 was in web's milestone 1, api's #2 in api's: Launch and Beta.
    assert_eq!(
        numbers(&db, "SELECT id, milestone FROM work_items WHERE milestone IS NOT NULL ORDER BY id"),
        [("iss_api2".to_owned(), Some(1)), ("iss_web5".to_owned(), Some(2))]
    );
    assert_eq!(numbers(&db, "SELECT id, milestone FROM pulls WHERE id = 'pr_web4'"), [("pr_web4".to_owned(), Some(2))]);
    // Run again, nothing moves twice.
    finish(&db);
    assert_eq!(numbers(&db, "SELECT id, milestone FROM pulls WHERE id = 'pr_web4'"), [("pr_web4".to_owned(), Some(2))]);
    assert_eq!(strings(&db, "SELECT title FROM milestones WHERE workspace = 'acme'").len(), 2);
}

#[test]
fn a_reference_is_a_pull_request_here_then_an_old_issue_then_the_workspace() {
    let db = legacy();
    finish(&db);
    // In web, #4 is its own pull request; #3 its old issue (now #8); #8 is
    // that item by its new number; #7 is api's old #1; #3 in api is api's
    // pull request.
    assert_eq!(reference(&db, Some("rep_web"), "acme", 4), Some(Named::PullHere));
    assert_eq!(reference(&db, Some("rep_web"), "acme", 3), Some(Named::Item("iss_web3".into())));
    assert_eq!(reference(&db, Some("rep_web"), "acme", 8), Some(Named::Item("iss_web3".into())));
    assert_eq!(reference(&db, Some("rep_web"), "acme", 7), Some(Named::Item("iss_api1".into())));
    assert_eq!(reference(&db, Some("rep_api"), "acme", 3), Some(Named::PullHere));
    // An old number of another repository is not this one's: web's #2 is
    // its own pull request, api's #2 (now #9) needs api or its new number.
    assert_eq!(reference(&db, Some("rep_web"), "acme", 2), Some(Named::PullHere));
    // In the workspace alone: its item, else a pull request of one of its
    // repositories.
    assert_eq!(reference(&db, None, "acme", 9), Some(Named::Item("iss_api2".into())));
    assert_eq!(reference(&db, None, "acme", 3), Some(Named::PullThere("rep_api".into())));
    assert_eq!(reference(&db, None, "acme", 42), None);
    assert_eq!(reference(&db, None, "acme", 2), Some(Named::PullThere("rep_web".into())));
    // Another workspace's numbers are its own: globex's #3 is its item,
    // and its pull request #2 is nothing of acme's.
    assert_eq!(reference(&db, None, "globex", 3), Some(Named::Item("iss_site1".into())));
    assert_eq!(reference(&db, None, "globex", 2), Some(Named::PullThere("rep_site".into())));
}

/// A work item of acme, filed from web, meant to land in web and api.
fn two_targets(db: &Connection) {
    db.execute_batch(
        "INSERT INTO repo_workspaces (repo_id, workspace, path, private) VALUES
           ('rep_web', 'acme', 'acme/web', 0), ('rep_api', 'acme', 'acme/api', 1), ('rep_docs', 'acme', 'acme/docs', 0);
         INSERT INTO work_items (id, workspace, number, title, body, author_id, author_name, created_at, updated_at)
         VALUES ('wki_1', 'acme', 12, 'Sign in with passkeys', '', 'usr_1', 'ana', '', ''),
                ('wki_2', 'acme', 13, 'Typo', '', 'usr_1', 'ana', '', '');
         INSERT INTO work_item_repos (item_id, repo_id, role, added_at) VALUES
           ('wki_1', 'rep_web', 'origin', ''), ('wki_1', 'rep_web2', 'target', ''), ('wki_1', 'rep_api', 'target', ''),
           ('wki_2', 'rep_docs', 'origin', '');",
    )
    .unwrap();
}

/// Lands `item` in `repo` by `pull` or `commit`: whether it closed.
fn land(db: &Connection, item: &str, repo: &str, pull: Option<u32>, commit: Option<&str>) -> bool {
    let resolution = serde_json::json!({ "repo_id": repo, "pull": pull, "commit": commit, "pushed_by": "ana" }).to_string();
    for sql in &LAND_SQL[..3] {
        run(db, sql, &[&item, &repo, &"2026-10-17", &"usr_1", &resolution, &pull, &commit]);
    }
    db.query_row(LAND_SQL[3], params![item, repo, "2026-10-17"], |row| row.get::<_, String>(0)).optional().unwrap().is_some()
}

#[test]
fn a_work_item_closes_once_every_target_has_landed() {
    let db = database();
    two_targets(&db);
    // Landing where it was filed is not where it was meant to land.
    assert!(!land(&db, "wki_1", "rep_web", Some(14), None));
    assert!(!land(&db, "wki_1", "rep_web2", Some(3), None), "one target of two");
    // The same merge told again records nothing twice.
    assert!(!land(&db, "wki_1", "rep_web2", Some(3), None));
    assert_eq!(strings(&db, "SELECT state FROM work_items WHERE id = 'wki_1'"), ["open"]);
    assert!(land(&db, "wki_1", "rep_api", None, Some("abc123")), "the last target closes it");
    assert_eq!(strings(&db, "SELECT state || ' ' || reason FROM work_items WHERE id = 'wki_1'"), ["closed completed"]);
    let resolutions: Vec<serde_json::Value> =
        serde_json::from_str(&strings(&db, "SELECT resolutions FROM work_items WHERE id = 'wki_1'")[0]).unwrap();
    let landed: Vec<&str> = resolutions.iter().map(|r| r["repo_id"].as_str().unwrap()).collect();
    assert_eq!(landed, ["rep_web", "rep_web2", "rep_api"]);
    assert_eq!(
        strings(&db, "SELECT repo_id FROM work_item_repos WHERE item_id = 'wki_1' AND landed_at IS NOT NULL ORDER BY repo_id"),
        ["rep_api", "rep_web", "rep_web2"]
    );
    // Closed already: landing again closes nothing.
    assert!(!land(&db, "wki_1", "rep_api", Some(20), None));
}

#[test]
fn with_no_targets_what_closes_it_closes_it_and_another_repository_is_touched() {
    let db = database();
    two_targets(&db);
    // Fixed from api, which it was not linked to: linked as touched, and,
    // with no targets, closed.
    assert!(land(&db, "wki_2", "rep_api", Some(5), None));
    assert_eq!(
        strings(&db, "SELECT repo_id || ' ' || role FROM work_item_repos WHERE item_id = 'wki_2' ORDER BY repo_id"),
        ["rep_api touched", "rep_docs origin"]
    );
}

#[test]
fn part_of_links_without_closing() {
    let db = database();
    two_targets(&db);
    let part = |item: &str, repo: &str| -> bool {
        db.query_row(PART_SQL, params![item, repo, "2026-10-17", "usr_1"], |row| row.get::<_, String>(0)).optional().unwrap().is_some()
    };
    assert!(part("wki_1", "rep_docs"), "linked the first time");
    assert!(!part("wki_1", "rep_docs"), "and once");
    assert!(!part("wki_1", "rep_api"), "a target stays a target");
    assert_eq!(strings(&db, "SELECT role FROM work_item_repos WHERE item_id = 'wki_1' AND repo_id = 'rep_api'"), ["target"]);
    assert_eq!(strings(&db, "SELECT state FROM work_items WHERE id = 'wki_1'"), ["open"]);
    assert!(strings(&db, "SELECT landed_at FROM work_item_repos WHERE item_id = 'wki_1' AND landed_at IS NOT NULL").is_empty());
}

fn next(db: &Connection, workspace: &str, repo: Option<&str>) -> u32 {
    db.query_row(NEXT_NUMBER, params![workspace, repo], |row| row.get(0)).unwrap()
}

#[test]
fn new_numbers_go_on_from_the_workspace_and_never_reuse_a_repositorys() {
    let db = legacy();
    finish(&db);
    // A pull request of web, then a work item: acme's sequence.
    assert_eq!(next(&db, "acme", Some("rep_web")), 11);
    assert_eq!(next(&db, "acme", None), 12);
    // A repository with pull requests up to #50 moves into acme.
    db.execute_batch(
        "INSERT INTO pulls (id, repo_id, number, title, agent, runtime, author_id, author_name, created_at, updated_at)
         VALUES ('pr_big', 'rep_big', 50, 'Old', 'ana', 'external', 'usr_1', 'ana', '', '');",
    )
    .unwrap();
    run(&db, REMEMBER_REPO, &[&"rep_big", &"globex", &"globex/big", &0]);
    let values = g1t_kit::transfer::values("acme/big", "globex/big", "rep_big");
    for sql in TRANSFERRED {
        let binds: Vec<&dyn rusqlite::ToSql> = values.iter().map(|value| value as &dyn rusqlite::ToSql).collect();
        run(&db, sql, &binds);
    }
    assert_eq!(strings(&db, "SELECT workspace || ' ' || path FROM repo_workspaces WHERE repo_id = 'rep_big'"), ["acme acme/big"]);
    assert_eq!(numbers(&db, "SELECT workspace, last FROM work_counters WHERE workspace = 'acme'"), [("acme".to_owned(), Some(50))]);
    assert_eq!(next(&db, "acme", Some("rep_big")), 51);
    // Even had the transfer not been heard of, its own pull requests'
    // numbers are never taken again.
    db.execute("UPDATE work_counters SET last = 20 WHERE workspace = 'acme'", []).unwrap();
    assert_eq!(next(&db, "acme", Some("rep_big")), 51);
    assert_eq!(next(&db, "acme", Some("rep_web")), 52);
}

#[test]
fn a_workspaces_first_number_is_after_its_repositories_before_the_job_runs() {
    let db = legacy();
    // Pull requests opened while the job runs: after web's own numbers.
    assert_eq!(next(&db, "acme", Some("rep_web")), 6);
    assert_eq!(next(&db, "acme", Some("rep_api")), 7);
    finish(&db);
    // The job numbers the moved issues after those.
    assert_eq!(numbers(&db, "SELECT id, number FROM work_items WHERE id = 'iss_web1'"), [("iss_web1".to_owned(), Some(8))]);
    // Whichever repository opens one first, none takes a number another
    // already used for an issue: api's first is 4, and web's after its #5.
    let db = legacy();
    assert_eq!(next(&db, "acme", Some("rep_api")), 4);
    assert_eq!(next(&db, "acme", Some("rep_web")), 6);
}
