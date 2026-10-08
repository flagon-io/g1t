//! An account purged (`user.deleted`, identity's `account_deletion.rs`):
//! what it wrote stays where it is and shows as `ghost`, and it is taken
//! off what it was asked to do.
//!
//! Its issues, pull requests, comments and reviews, plans and messages to
//! agents keep their place and their words; their author becomes `ghost`
//! (`usr_ghost`), and so does whoever asked g1t for an issue or pull
//! request. It is no longer assigned to anything or asked to review, and
//! review requests that reached it through a team are dropped. Stored
//! rather than mapped when read, so every reader agrees.

use g1t_contracts::account_deletion::{GHOST_ID, GHOST_USERNAME};

/// Each statement takes the account's id as `?1` and its username as `?2`
/// (`g1t_kit::user_deleted`). `ghost`'s id and name are written in.
pub(crate) fn statements() -> Vec<String> {
    let mut sql = Vec::new();
    for table in ["issues", "pulls", "comments", "plans", "agent_messages"] {
        sql.push(format!(
            "UPDATE {table} SET author_id = '{GHOST_ID}', author_name = '{GHOST_USERNAME}' WHERE author_id = ?1"
        ));
    }
    for table in ["issues", "pulls"] {
        sql.push(format!(
            "UPDATE {table} SET requested_by_id = '{GHOST_ID}', requested_by_name = '{GHOST_USERNAME}' WHERE requested_by_id = ?1"
        ));
    }
    for (table, column) in [("issues", "assignees"), ("pulls", "assignees"), ("pulls", "reviewers")] {
        sql.push(format!(
            "UPDATE {table} SET {column} = (SELECT json_group_array(value) FROM json_each({table}.{column}) WHERE value <> ?2)
             WHERE ?1 IS NOT NULL AND json_valid({column}) AND EXISTS (SELECT 1 FROM json_each({table}.{column}) WHERE value = ?2)"
        ));
    }
    sql.push("DELETE FROM team_review_requests WHERE ?1 IS NOT NULL AND username = ?2".to_owned());
    sql
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn everything_it_wrote_becomes_ghosts() {
        let sql = statements();
        for table in ["issues", "pulls", "comments", "plans", "agent_messages"] {
            assert!(
                sql.iter().any(|s| s.starts_with(&format!("UPDATE {table} SET author_id = 'usr_ghost', author_name = 'ghost'"))),
                "{table}"
            );
        }
        assert!(sql.iter().any(|s| s.contains("UPDATE pulls SET requested_by_id = 'usr_ghost'")));
        assert!(sql.iter().any(|s| s.contains("UPDATE pulls SET reviewers")));
        assert!(sql.iter().any(|s| s.contains("team_review_requests")));
    }

    #[test]
    fn every_statement_takes_both_binds() {
        // D1 refuses a bind a statement does not name: each names ?1, and
        // the ones that need the username name ?2 as well.
        for s in statements() {
            assert!(s.contains("?1"), "{s}");
            assert_eq!(g1t_kit::user_deleted::binds(&s, "usr_1", "ada").len(), if s.contains("?2") { 2 } else { 1 });
        }
    }
}
