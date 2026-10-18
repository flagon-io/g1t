//! The search database as the migrations make it, for tests: SQLite (which
//! D1 is), each migration in a transaction of its own as D1 applies it.
//! What each search asks of it is run here too.

use rusqlite::Connection;
use rusqlite::types::Value;

use crate::sql::{Param, Sql};

/// The migrations, in order: each file's name and SQL.
fn migrations() -> Vec<(String, String)> {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| name.ends_with(".sql"))
        .collect();
    names.sort();
    names.into_iter().map(|name| (name.clone(), std::fs::read_to_string(dir.join(&name)).unwrap())).collect()
}

fn apply(db: &Connection, name: &str, sql: &str) {
    db.execute_batch(&format!("BEGIN;\n{sql}\nCOMMIT;")).unwrap_or_else(|error| panic!("{name}: {error}"));
}

/// A database with the migrations before `name` applied.
fn database_before(name: &str) -> Connection {
    let db = Connection::open_in_memory().unwrap();
    for (file, sql) in migrations() {
        if file.as_str() >= name {
            break;
        }
        apply(&db, &file, &sql);
    }
    db
}

fn migrate_from(db: &Connection, name: &str) {
    for (file, sql) in migrations() {
        if file.as_str() >= name {
            apply(db, &file, &sql);
        }
    }
}

fn database() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    for (file, sql) in migrations() {
        apply(&db, &file, &sql);
    }
    db
}

fn values(params: &[Param]) -> Vec<Value> {
    params
        .iter()
        .map(|param| match param {
            Param::Text(text) => Value::Text(text.clone()),
            Param::Int(number) => Value::Integer(*number),
            Param::Null => Value::Null,
        })
        .collect()
}

fn run(db: &Connection, text: &str, params: Vec<Param>) {
    db.execute(text, rusqlite::params_from_iter(values(&params))).unwrap_or_else(|error| panic!("{text}: {error}"));
}

/// The `number` column of every row `sql` returns, in order.
fn numbers(db: &Connection, sql: &Sql) -> Vec<i64> {
    let mut statement = db.prepare(&sql.text).unwrap_or_else(|error| panic!("{}: {error}", sql.text));
    let index = statement.column_index("number").unwrap();
    statement
        .query_map(rusqlite::params_from_iter(values(&sql.params)), |row| row.get::<_, i64>(index))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

#[cfg(test)]
mod tests {
    use g1t_contracts::access::{BasePermission, RepoGrant, RepoRole};
    use g1t_contracts::{Membership, User, Viewer};

    use super::*;
    use crate::index::UPSERT_ITEM;
    use crate::query::{ItemKind, Query};
    use crate::sql::{Page, items_count, items_page};
    use crate::visibility::Reader;

    const PAGE: Page = Page { limit: 20, offset: 0 };

    fn repo(db: &Connection, id: &str, namespace: &str, name: &str, private: bool) {
        run(
            db,
            "INSERT INTO repos (repo_id, namespace, name, private, created_at, updated_at) VALUES (?, ?, ?, ?, '', '')",
            vec![Param::from(id), Param::from(namespace), Param::from(name), Param::Int(i64::from(private))],
        );
    }

    /// A work item of acme numbered `number`, filed in `origin`, linked to `repos`.
    fn item(db: &Connection, number: i64, origin: Option<&str>, repos: &str, title: &str) {
        run(
            db,
            UPSERT_ITEM,
            vec![
                Param::from("item"),
                Param::Text(format!("wki_{number}")),
                Param::opt(origin),
                Param::from("acme"),
                Param::Int(number),
                Param::from(repos),
                Param::from(title),
                Param::from("the body"),
                Param::from("open"),
                Param::from("open"),
                Param::from("ana"),
                Param::Null,
                Param::from("|bug|"),
                Param::from("2026-10-01T00:00:00Z"),
                Param::Text(format!("2026-10-01T00:00:{number:02}Z")),
            ],
        );
    }

    fn member(base: BasePermission) -> Viewer {
        Some(User {
            id: "usr_1".into(),
            username: "ana".into(),
            workspaces: vec![Membership { base_permission: Some(base), ..Membership::member("acme") }],
            ..User::default()
        })
    }

    fn outsider(grants: &[&str]) -> Viewer {
        Some(User {
            id: "usr_2".into(),
            username: "bo".into(),
            grants: grants
                .iter()
                .map(|id| RepoGrant { repo_id: (*id).into(), workspace: "acme".into(), role: RepoRole::Read, team: None })
                .collect(),
            ..User::default()
        })
    }

    /// acme/web is public, acme/api private; item 1 was filed in web, 2 in
    /// api (and targets web), 3 in no repository (and targets web).
    fn filled() -> Connection {
        let db = database();
        repo(&db, "rep_web", "acme", "web", false);
        repo(&db, "rep_api", "acme", "api", true);
        item(&db, 1, Some("rep_web"), "|rep_web|", "crash on login");
        item(&db, 2, Some("rep_api"), "|rep_api|rep_web|", "crash in the api");
        item(&db, 3, None, "|rep_web|", "crash everywhere");
        db
    }

    fn found(db: &Connection, text: &str, viewer: &Viewer) -> Vec<i64> {
        let query = Query::parse(text);
        let reader = Reader::of(viewer);
        let mut page = numbers(db, &items_page(&query, &reader, ItemKind::Item, PAGE));
        page.sort();
        page
    }

    #[test]
    fn issues_are_dropped_and_pull_requests_kept() {
        let db = database_before("0003");
        repo(&db, "rep_web", "acme", "web", false);
        for (kind, number, title) in [("issue", 1, "crash on login"), ("pull", 2, "fix the crash")] {
            run(
                &db,
                "INSERT INTO items (repo_id, kind, number, title, body, state, status, author, labels, created_at, updated_at, requested_by)
                 VALUES ('rep_web', ?, ?, ?, 'body', 'open', 'open', 'ana', '|bug|', '', '', 'bo')",
                vec![Param::from(kind), Param::Int(number), Param::from(title)],
            );
        }
        migrate_from(&db, "0003");
        let rows: Vec<(String, String, Option<String>, String, String)> = db
            .prepare("SELECT kind, key, workspace, repos, requested_by FROM items")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(rows, vec![("pull".into(), "rep_web/2".into(), None, "|".into(), "bo".into())]);
        // The full-text index holds the pull request, and nothing of the issue.
        let pulls = numbers(&db, &items_page(&Query::parse("crash"), &Reader::default(), ItemKind::Pull, PAGE));
        assert_eq!(pulls, vec![2]);
        let matched: i64 = db.query_row("SELECT count(*) FROM items_fts WHERE items_fts MATCH 'login'", [], |row| row.get(0)).unwrap();
        assert_eq!(matched, 0);
    }

    #[test]
    fn a_work_item_indexed_again_is_updated_in_place() {
        let db = filled();
        item(&db, 1, Some("rep_web"), "|rep_web|rep_api|", "a new title");
        let rows: i64 = db.query_row("SELECT count(*) FROM items WHERE key = 'wki_1'", [], |row| row.get(0)).unwrap();
        assert_eq!(rows, 1);
        assert_eq!(found(&db, "title", &None), vec![1]);
        assert!(found(&db, "login", &None).is_empty());
    }

    #[test]
    fn members_see_every_work_item() {
        let db = filled();
        // Even a member whose base permission reads no repository.
        assert_eq!(found(&db, "crash", &member(BasePermission::None)), vec![1, 2, 3]);
        assert_eq!(found(&db, "crash", &member(BasePermission::Read)), vec![1, 2, 3]);
    }

    #[test]
    fn others_see_what_was_filed_where_they_read() {
        let db = filled();
        // Signed out, or in no way part of acme: what was filed in its public repository.
        assert_eq!(found(&db, "crash", &None), vec![1]);
        assert_eq!(found(&db, "crash", &outsider(&[])), vec![1]);
        // Given a role on the private one: what was filed there too, never
        // what was filed in no repository.
        assert_eq!(found(&db, "crash", &outsider(&["rep_api"])), vec![1, 2]);
        let count = items_count(&Query::parse("crash"), &Reader::of(&None), ItemKind::Item);
        assert_eq!(numbers_count(&db, &count), 1);
    }

    #[test]
    fn repo_matches_any_linked_repository_and_org_the_workspace() {
        let db = filled();
        let viewer = member(BasePermission::Read);
        assert_eq!(found(&db, "crash repo:acme/web", &viewer), vec![1, 2, 3]);
        assert_eq!(found(&db, "crash repo:acme/api", &viewer), vec![2]);
        assert_eq!(found(&db, "crash -repo:acme/api", &viewer), vec![1, 3]);
        assert_eq!(found(&db, "crash org:acme", &viewer), vec![1, 2, 3]);
        assert_eq!(found(&db, "workspace:other", &viewer), Vec::<i64>::new());
        // Public: filed in a public repository. Private: anything else.
        assert_eq!(found(&db, "crash is:public", &viewer), vec![1]);
        assert_eq!(found(&db, "crash is:private", &viewer), vec![2, 3]);
        // Without words, by qualifiers alone.
        assert_eq!(found(&db, "is:open label:bug", &viewer), vec![1, 2, 3]);
    }

    #[test]
    fn repo_names_a_private_repository_only_to_who_may_read_it() {
        let db = filled();
        // A member who reads none of acme's private repositories sees every
        // work item, but repo: answers of acme/api as of one that is not there.
        let viewer = member(BasePermission::None);
        assert_eq!(found(&db, "crash repo:acme/api", &viewer), found(&db, "crash repo:acme/nope", &viewer));
        assert_eq!(found(&db, "crash -repo:acme/api", &viewer), found(&db, "crash -repo:acme/nope", &viewer));
        assert_eq!(found(&db, "crash -repo:acme/api", &viewer), vec![1, 2, 3]);
        // Given a role on it, it is there.
        let granted = Some(User { workspaces: vec![Membership::member("acme")], ..outsider(&["rep_api"]).unwrap() });
        assert_eq!(found(&db, "crash repo:acme/api", &granted), vec![2]);
        assert_eq!(found(&db, "crash -repo:acme/api", &granted), vec![1, 3]);
    }

    fn numbers_count(db: &Connection, sql: &Sql) -> i64 {
        db.query_row(&sql.text, rusqlite::params_from_iter(values(&sql.params)), |row| row.get(0)).unwrap()
    }
}
