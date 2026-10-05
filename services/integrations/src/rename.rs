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
];

#[cfg(test)]
mod tests {
    use super::STATEMENTS;

    #[test]
    fn every_statement_takes_the_two_slugs() {
        for sql in STATEMENTS {
            assert_eq!(g1t_kit::rename::parameters(sql), 2, "{sql}");
        }
    }
}
