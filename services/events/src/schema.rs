//! The events database as the migrations make it, for tests: SQLite (which
//! D1 is), each migration in a transaction of its own as D1 applies it.

use rusqlite::Connection;

/// The migrations, in order: each file's name and SQL.
pub(crate) fn migrations() -> Vec<(String, String)> {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| name.ends_with(".sql"))
        .collect();
    names.sort();
    names.into_iter().map(|name| (name.clone(), std::fs::read_to_string(dir.join(&name)).unwrap())).collect()
}

/// Applies one migration as D1 does: in one transaction.
pub(crate) fn apply(db: &Connection, name: &str, sql: &str) {
    db.execute_batch(&format!("BEGIN;\n{sql}\nCOMMIT;")).unwrap_or_else(|error| panic!("{name}: {error}"));
}

/// An in-memory database with the migrations before `name` applied, for
/// filling with what that migration then moves.
pub(crate) fn database_before(name: &str) -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    for (file, sql) in migrations() {
        if file.as_str() >= name {
            break;
        }
        apply(&db, &file, &sql);
    }
    db
}

/// Applies the migrations from `name` on.
pub(crate) fn migrate_from(db: &Connection, name: &str) {
    for (file, sql) in migrations() {
        if file.as_str() >= name {
            apply(db, &file, &sql);
        }
    }
}
