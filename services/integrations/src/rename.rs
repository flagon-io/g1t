//! A workspace renamed: rows kept under its old slug move to the one it
//! has now. See `g1t_kit::rename`.

/// `?1` is the current slug, `?2` a stale one.
pub const STATEMENTS: &[&str] = &[
    "UPDATE connections SET workspace = ?1 WHERE workspace = ?2",
    "UPDATE ai_providers SET workspace = ?1 WHERE workspace = ?2",
    "UPDATE links SET workspace = ?1 WHERE workspace = ?2",
    "UPDATE model_sessions SET workspace = ?1 WHERE workspace = ?2",
    "UPDATE model_sessions SET repo = ?1 || substr(repo, length(?2) + 1) WHERE substr(repo, 1, length(?2) + 1) = ?2 || '/'",
    "UPDATE deliveries SET item = ?1 || substr(item, length(?2) + 1) WHERE substr(item, 1, length(?2) + 1) = ?2 || '#'",
    "UPDATE OR IGNORE ai_routes SET workspace = ?1 WHERE workspace = ?2",
    "DELETE FROM ai_routes WHERE workspace = ?2",
    "UPDATE OR IGNORE github_installations SET workspace = ?1 WHERE workspace = ?2",
    "DELETE FROM github_installations WHERE workspace = ?2",
    "UPDATE github_repos SET workspace = ?1 WHERE workspace = ?2",
    "UPDATE github_repos SET repo = ?1 || substr(repo, length(?2) + 1) WHERE substr(repo, 1, length(?2) + 1) = ?2 || '/'",
    "UPDATE agent_runs SET workspace = ?1 WHERE workspace = ?2",
    "UPDATE agent_runs SET repo = ?1 || substr(repo, length(?2) + 1) WHERE substr(repo, 1, length(?2) + 1) = ?2 || '/'",
];

/// A repository transferred (see `g1t_kit::transfer`): what was kept for
/// it follows its new path. Work items, and so their links to outside
/// trackers, stay with their workspace, as do the workspace's connections
/// and AI providers.
pub const TRANSFERRED: &[&str] = &[
    "UPDATE model_sessions SET repo = ?1 WHERE repo = ?2",
    "UPDATE github_repos SET workspace = ?3, repo = ?1 WHERE repo = ?2",
    "UPDATE agent_runs SET workspace = ?3, repo = ?1 WHERE repo = ?2",
];

/// A repository purged: the model sessions of its runs and its link to a
/// GitHub repository go. Work items outlive it, with their links. `?1` its
/// id, `?2` its path (`namespace/name`).
pub const PURGED: &[&str] = &[
    "DELETE FROM model_sessions WHERE repo = ?2",
    "DELETE FROM github_repos WHERE repo_id = ?1",
    "UPDATE agent_runs SET status = 'ended' WHERE repo = ?2",
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

/// A workspace deleted: its connections, links, AI providers and what Ask
/// answers with go. `?1` its slug.
pub const DELETED: &[&str] = &[
    "DELETE FROM managed_agents WHERE connection_id IN (SELECT id FROM ai_providers WHERE workspace = ?1)",
    "DELETE FROM connections WHERE workspace = ?1",
    "DELETE FROM ai_providers WHERE workspace = ?1",
    "DELETE FROM links WHERE workspace = ?1",
    "DELETE FROM ai_routes WHERE workspace = ?1",
    "DELETE FROM github_installations WHERE workspace = ?1",
    "DELETE FROM github_repos WHERE workspace = ?1",
    "DELETE FROM agent_runs WHERE workspace = ?1",
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
