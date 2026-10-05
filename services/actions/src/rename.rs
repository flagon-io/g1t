//! A workspace renamed: rows kept under its old slug move to the one it
//! has now. See `g1t_kit::rename`.

/// `?1` is the current slug, `?2` a stale one.
pub const STATEMENTS: &[&str] = &[
    "UPDATE settings SET owner = ?1 WHERE scope = 'workspace' AND owner = ?2",
    "UPDATE jobs SET namespace = ?1 WHERE namespace = ?2",
    "UPDATE workflows SET repo = ?1 || substr(repo, length(?2) + 1) WHERE substr(repo, 1, length(?2) + 1) = ?2 || '/'",
    "UPDATE runs SET repo = ?1 || substr(repo, length(?2) + 1) WHERE substr(repo, 1, length(?2) + 1) = ?2 || '/'",
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
