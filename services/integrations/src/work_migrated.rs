//! `work.migrated`: where repositories' issues went when they became work
//! items. Links and deliveries kept by an issue's repository and number
//! (`legacy_repo_id`, `legacy_number`, from migrations/0013_work_items.sql)
//! take the work item's id, workspace and number, and lose the old pair.
//! Each page is applied on its own, and a page seen again changes nothing.

use g1t_contracts::events::{Event, WorkMigrated};
use worker::{D1Database, Result};

/// The page's moves, from `?1` (its `items` as JSON), as rows.
const MOVES: &str = "SELECT json_extract(value, '$.repoId') AS repo_id, json_extract(value, '$.legacyNumber') AS legacy_number,
        json_extract(value, '$.workspace') AS workspace, json_extract(value, '$.number') AS number,
        json_extract(value, '$.itemId') AS item_id
 FROM json_each(?1)";

/// What one page rewrites, each taking the page's `items` as `?1`.
pub fn statements() -> [String; 2] {
    [
        format!(
            "UPDATE links SET item_id = m.item_id, workspace = m.workspace, number = m.number, legacy_repo_id = NULL, legacy_number = NULL
             FROM ({MOVES}) AS m
             WHERE links.legacy_repo_id = m.repo_id AND links.legacy_number = m.legacy_number"
        ),
        format!(
            "UPDATE deliveries SET item = m.workspace || '#' || m.number, legacy_repo_id = NULL, legacy_number = NULL
             FROM ({MOVES}) AS m
             WHERE deliveries.legacy_repo_id = m.repo_id AND deliveries.legacy_number = m.legacy_number"
        ),
    ]
}

/// Applies `event` when it is `work.migrated`. Whether it was.
pub async fn on_event(db: &D1Database, event: &Event) -> Result<bool> {
    if event.kind != "work.migrated" {
        return Ok(false);
    }
    let Ok(page) = serde_json::from_value::<WorkMigrated>(event.data.clone()) else {
        return Ok(true);
    };
    if page.items.is_empty() {
        return Ok(true);
    }
    let items = serde_json::to_string(&page.items)?;
    let mut batch = Vec::new();
    for sql in statements() {
        batch.push(db.prepare(&sql).bind(&[items.as_str().into()])?);
    }
    db.batch(batch).await?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use rusqlite::{Connection, params};

    use g1t_contracts::work::MigratedItem;

    use super::statements;

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

    /// Applies the migrations before `name` (or from it on, with `from`),
    /// each in a transaction of its own as D1 does.
    fn apply(db: &Connection, name: &str, from: bool) {
        for (file, sql) in migrations() {
            if (file.as_str() >= name) == from {
                db.execute_batch(&format!("BEGIN;\n{sql}\nCOMMIT;")).unwrap_or_else(|error| panic!("{file}: {error}"));
            }
        }
    }

    fn page(items: &[MigratedItem]) -> String {
        serde_json::to_string(items).unwrap()
    }

    #[test]
    fn links_and_deliveries_kept_by_issue_number_move_to_the_work_item() {
        let db = Connection::open_in_memory().unwrap();
        apply(&db, "0013", false);
        db.execute_batch(
            "INSERT INTO links (id, workspace, connection_id, provider, external_id, key, title, url, repo_id, repo, number,
                                count, announced, told_started, first_seen, last_seen)
             VALUES ('lnk_1', 'acme', 'con_1', 'sentry', '77', 'WEB-1', 'Boom', 'https://sentry.io/issues/77', 'rep_web', 'acme/web', 4,
                     12, 10, 1, '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'),
                    ('lnk_2', 'acme', 'con_2', 'linear', 'uuid', 'ENG-2', 'Do it', 'https://linear.app/acme/issue/ENG-2', 'rep_api', 'acme/api', 4,
                     1, 1, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
             INSERT INTO deliveries (id, connection_id, received_at, event, outcome, detail, issue)
             VALUES ('dlv_1', 'con_1', '2026-01-02T00:00:00Z', 'issue.created', 'opened', 'Opened #4.', 'acme/web#4'),
                    ('dlv_2', 'con_1', '2026-01-02T00:00:00Z', 'request', 'refused', 'Not signed.', NULL);
             INSERT INTO agent_runs (session_id, workspace, repo, issue, connection_id, actor, provider_session_id, created_at, synced_at)
             VALUES ('ses_1', 'acme', 'acme/web', 4, 'aip_1', '{}', 'sesn_1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');",
        )
        .unwrap();
        apply(&db, "0013", true);

        // Until the work service says where the issues went, they keep the old pair.
        let pending: (Option<String>, Option<u32>, String, u32, u32) = db
            .query_row("SELECT item_id, number, legacy_repo_id, legacy_number, count FROM links WHERE id = 'lnk_1'", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
            })
            .unwrap();
        assert_eq!(pending, (None, None, "rep_web".to_owned(), 4, 12));
        let delivery: (Option<String>, Option<String>, Option<u32>) = db
            .query_row("SELECT item, legacy_repo_id, legacy_number FROM deliveries WHERE id = 'dlv_1'", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap();
        assert_eq!(delivery, (None, Some("rep_web".to_owned()), Some(4)));
        let run: Option<u32> = db.query_row("SELECT item FROM agent_runs WHERE session_id = 'ses_1'", [], |row| row.get(0)).unwrap();
        assert_eq!(run, None);

        let moved = [
            MigratedItem { repo_id: "rep_web".into(), legacy_number: 4, workspace: "acme".into(), number: 31, item_id: "iss_web4".into() },
            MigratedItem { repo_id: "rep_api".into(), legacy_number: 4, workspace: "acme".into(), number: 32, item_id: "iss_api4".into() },
            MigratedItem { repo_id: "rep_web".into(), legacy_number: 5, workspace: "acme".into(), number: 33, item_id: "iss_web5".into() },
        ];
        // Twice: a page seen again changes nothing.
        for _ in 0..2 {
            for sql in statements() {
                db.execute(&sql, params![page(&moved)]).unwrap();
            }
        }
        let link = |id: &str| -> (String, Option<String>, Option<u32>, Option<String>, Option<u32>) {
            db.query_row("SELECT workspace, item_id, number, legacy_repo_id, legacy_number FROM links WHERE id = ?1", [id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
            })
            .unwrap()
        };
        assert_eq!(link("lnk_1"), ("acme".to_owned(), Some("iss_web4".to_owned()), Some(31), None, None));
        assert_eq!(link("lnk_2"), ("acme".to_owned(), Some("iss_api4".to_owned()), Some(32), None, None));
        let delivery = |id: &str| -> (Option<String>, Option<String>) {
            db.query_row("SELECT item, legacy_repo_id FROM deliveries WHERE id = ?1", [id], |row| Ok((row.get(0)?, row.get(1)?))).unwrap()
        };
        assert_eq!(delivery("dlv_1"), (Some("acme#31".to_owned()), None));
        assert_eq!(delivery("dlv_2"), (None, None));
        let left: u32 = db
            .query_row(
                "SELECT (SELECT count(*) FROM links WHERE legacy_repo_id IS NOT NULL) + (SELECT count(*) FROM deliveries WHERE legacy_repo_id IS NOT NULL)",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(left, 0);
    }
}
