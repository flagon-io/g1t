//! A workspace renamed: rows kept under its old slug move to the one it
//! has now. See `g1t_kit::rename`.

/// `?1` is the current slug, `?2` a stale one.
pub const STATEMENTS: &[&str] = &[
    "UPDATE settings SET owner = ?1 WHERE scope = 'workspace' AND owner = ?2",
    "UPDATE jobs SET namespace = ?1 WHERE namespace = ?2",
    "UPDATE workflows SET repo = ?1 || substr(repo, length(?2) + 1) WHERE substr(repo, 1, length(?2) + 1) = ?2 || '/'",
    "UPDATE runs SET repo = ?1 || substr(repo, length(?2) + 1) WHERE substr(repo, 1, length(?2) + 1) = ?2 || '/'",
];

/// A repository renamed or transferred (see `g1t_kit::transfer`): its
/// workflows, its runs and their jobs go with it. Its own secrets and
/// variables are kept by its id (or its project's), so they go with it
/// too; the old workspace's stop reaching it. A workspace's rows name the
/// projects they reach by slug, not repositories, so a rename leaves them.
pub const TRANSFERRED: &[&str] = &[
    "UPDATE workflows SET repo = ?1 WHERE repo_id = ?5 AND repo = ?2",
    "UPDATE runs SET repo = ?1 WHERE repo_id = ?5 AND repo = ?2",
    "UPDATE jobs SET namespace = ?3 WHERE repo_id = ?5 AND namespace = ?4",
];

/// A repository purged (see `g1t_kit::lifecycle`): its workflows, runs,
/// jobs and their logs go, and secrets and variables still kept under its
/// id (from before projects held them). `?1` its id. A project's own rows
/// stay with the project.
pub const PURGED: &[&str] = &[
    "DELETE FROM logs WHERE job_id IN (SELECT id FROM jobs WHERE repo_id = ?1)",
    "DELETE FROM jobs WHERE repo_id = ?1",
    "DELETE FROM runs WHERE repo_id = ?1",
    "DELETE FROM workflows WHERE repo_id = ?1",
    "DELETE FROM synced WHERE repo_id = ?1",
    "DELETE FROM settings WHERE scope <> 'workspace' AND owner = ?1",
];

/// A workspace deleted: its own secrets and variables go. `?1` its slug.
pub const DELETED: &[&str] = &["DELETE FROM settings WHERE scope = 'workspace' AND owner = ?1"];

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
            assert_eq!(g1t_kit::transfer::parameters(sql), 1, "{sql}");
        }
    }
}
