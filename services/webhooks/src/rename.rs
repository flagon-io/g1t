//! A workspace renamed: rows kept under its old slug move to the one it
//! has now. See `g1t_kit::rename`.

/// `?1` is the current slug, `?2` a stale one.
pub const STATEMENTS: &[&str] = &[
    "UPDATE hooks SET workspace = ?1 WHERE workspace = ?2",
    "UPDATE hooks SET repo = ?1 || substr(repo, length(?2) + 1) WHERE substr(repo, 1, length(?2) + 1) = ?2 || '/'",
    "UPDATE repo_names SET namespace = ?1 WHERE namespace = ?2",
];

/// A repository renamed or transferred (see `g1t_kit::transfer`): its own
/// webhooks go with it, and its payloads name it by its new path. After a
/// transfer the old workspace's webhooks stop hearing about it; the new
/// one's start.
pub const TRANSFERRED: &[&str] = &[
    "UPDATE hooks SET workspace = ?3, repo = ?1 WHERE scope = 'repo' AND repo_id = ?5",
    "UPDATE repo_names SET namespace = ?3, name = ?6 WHERE repo_id = ?5",
];

/// A repository purged (see `g1t_kit::lifecycle`), once its last event is
/// delivered: its own webhooks and what was sent to them go. `?1` its id.
/// What its workspace's webhooks were sent stays, as their history.
pub const PURGED: &[&str] = &[
    "DELETE FROM deliveries WHERE hook_id IN (SELECT id FROM hooks WHERE scope = 'repo' AND repo_id = ?1)",
    "DELETE FROM hooks WHERE scope = 'repo' AND repo_id = ?1",
    "DELETE FROM repo_names WHERE repo_id = ?1",
];

/// A workspace deleted: its own webhooks go. `?1` its slug.
pub const DELETED: &[&str] = &["DELETE FROM hooks WHERE scope = 'workspace' AND workspace = ?1"];

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
            assert!((1..=7).contains(&g1t_kit::transfer::parameters(sql)), "{sql}");
        }
        for sql in PURGED {
            assert_eq!(g1t_kit::transfer::parameters(sql), 1, "{sql}");
        }
        for sql in DELETED {
            assert_eq!(g1t_kit::rename::parameters(sql), 1, "{sql}");
        }
    }
}
