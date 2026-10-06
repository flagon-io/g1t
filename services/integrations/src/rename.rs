//! A workspace renamed: rows kept under its old slug move to the one it
//! has now. See `g1t_kit::rename`.

/// `?1` is the current slug, `?2` a stale one.
pub const STATEMENTS: &[&str] = &[
    "UPDATE connections SET workspace = ?1 WHERE workspace = ?2",
    "UPDATE links SET workspace = ?1 WHERE workspace = ?2",
    "UPDATE links SET repo = ?1 || substr(repo, length(?2) + 1) WHERE substr(repo, 1, length(?2) + 1) = ?2 || '/'",
    "UPDATE model_sessions SET workspace = ?1 WHERE workspace = ?2",
    "UPDATE model_sessions SET repo = ?1 || substr(repo, length(?2) + 1) WHERE substr(repo, 1, length(?2) + 1) = ?2 || '/'",
    "UPDATE deliveries SET issue = ?1 || substr(issue, length(?2) + 1) WHERE substr(issue, 1, length(?2) + 1) = ?2 || '/'",
    "UPDATE OR IGNORE model_routes SET workspace = ?1 WHERE workspace = ?2",
    "DELETE FROM model_routes WHERE workspace = ?2",
    "UPDATE OR IGNORE github_installations SET workspace = ?1 WHERE workspace = ?2",
    "DELETE FROM github_installations WHERE workspace = ?2",
    "UPDATE github_repos SET workspace = ?1 WHERE workspace = ?2",
    "UPDATE github_repos SET repo = ?1 || substr(repo, length(?2) + 1) WHERE substr(repo, 1, length(?2) + 1) = ?2 || '/'",
];

/// A repository transferred (see `g1t_kit::transfer`): its issues' links to
/// outside trackers, and what was sent about them, follow its new path.
/// The workspace's connections stay with the workspace.
pub const TRANSFERRED: &[&str] = &[
    "UPDATE links SET workspace = ?3, repo = ?1 WHERE repo = ?2",
    "UPDATE model_sessions SET repo = ?1 WHERE repo = ?2",
    "UPDATE github_repos SET workspace = ?3, repo = ?1 WHERE repo = ?2",
    "UPDATE deliveries SET issue = ?1 || substr(issue, length(?2) + 1) WHERE substr(issue, 1, length(?2) + 1) = ?2 || '#'",
];

/// A repository purged: its issues' links to outside trackers, the model
/// sessions of its runs, what was received about its issues, and its link
/// to a GitHub repository go. `?1` its id, `?2` its path (`namespace/name`).
pub const PURGED: &[&str] = &[
    "DELETE FROM links WHERE repo_id = ?1",
    "DELETE FROM model_sessions WHERE repo = ?2",
    "DELETE FROM deliveries WHERE substr(issue, 1, length(?2) + 1) = ?2 || '#'",
    "DELETE FROM github_repos WHERE repo_id = ?1",
];

/// Runs [`PURGED`] for `event` when it is `repo.purged`.
pub async fn on_purged(db: &worker::D1Database, event: &g1t_contracts::events::Event) -> worker::Result<()> {
    let Some(g1t_kit::lifecycle::Lifecycle::Purged(purged)) = g1t_kit::lifecycle::read(event) else {
        return Ok(());
    };
    let path = format!("{}/{}", purged.namespace, purged.name);
    let values: [worker::wasm_bindgen::JsValue; 2] = [purged.repo_id.as_str().into(), path.as_str().into()];
    let mut batch = Vec::with_capacity(PURGED.len());
    for sql in PURGED {
        batch.push(db.prepare(*sql).bind(&values[..g1t_kit::transfer::parameters(sql)])?);
    }
    db.batch(batch).await?;
    Ok(())
}

/// A workspace deleted: its connections, links and model routes go. `?1`
/// its slug.
pub const DELETED: &[&str] = &[
    "DELETE FROM connections WHERE workspace = ?1",
    "DELETE FROM links WHERE workspace = ?1",
    "DELETE FROM model_routes WHERE workspace = ?1",
    "DELETE FROM github_installations WHERE workspace = ?1",
    "DELETE FROM github_repos WHERE workspace = ?1",
];

#[cfg(test)]
mod tests {
    use super::{DELETED, PURGED, STATEMENTS, TRANSFERRED};

    #[test]
    fn every_statement_takes_the_two_slugs() {
        for sql in STATEMENTS {
            assert_eq!(g1t_kit::rename::parameters(sql), 2, "{sql}");
        }
    }

    #[test]
    fn transfer_and_deletion_statements_take_what_they_name() {
        for sql in TRANSFERRED {
            assert!((1..=5).contains(&g1t_kit::transfer::parameters(sql)), "{sql}");
        }
        for sql in DELETED {
            assert_eq!(g1t_kit::rename::parameters(sql), 1, "{sql}");
        }
        for sql in PURGED {
            assert!((1..=2).contains(&g1t_kit::transfer::parameters(sql)), "{sql}");
        }
    }
}
