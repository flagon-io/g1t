//! What other modules' queries read of work items, as SQL fragments: the
//! only place outside this module that names `work_items` or
//! `work_item_repos`. Each takes the SQL expression it reads from as a
//! string literal, and expands to one, for `concat!` in a `const`.
//!
//! Statements other modules run on an account's or a repository's rows,
//! for what is kept for work items, are here too ([`user_deleted`],
//! [`REPO_PURGED`]).

/// The number of the work item whose id is `$id`.
macro_rules! item_number {
    ($id:literal) => {
        concat!("(SELECT number FROM work_items WHERE work_items.id = ", $id, ")")
    };
}

/// The workspace of the work item whose id is `$id`.
macro_rules! item_workspace {
    ($id:literal) => {
        concat!("(SELECT workspace FROM work_items WHERE work_items.id = ", $id, ")")
    };
}

/// The numbers, as a JSON array in the order given, of the work items
/// whose ids are the JSON array `$ids`.
macro_rules! item_numbers {
    ($ids:literal) => {
        concat!(
            "(SELECT json_group_array(number) FROM
     (SELECT w.number AS number FROM json_each(",
            $ids,
            ") j JOIN work_items w ON w.id = j.value
      WHERE w.number IS NOT NULL ORDER BY j.key))"
        )
    };
}

/// The ids of the work items linked to repository `$repo`, any role.
macro_rules! items_linked_to {
    ($repo:literal) => {
        concat!("(SELECT item_id FROM work_item_repos WHERE repo_id = ", $repo, ")")
    };
}

/// How many numbered work items linked to repository `$repo` are open.
macro_rules! open_items_linked_to {
    ($repo:literal) => {
        concat!(
            "(SELECT count(*) FROM work_item_repos r JOIN work_items i ON i.id = r.item_id
                        WHERE r.repo_id = ",
            $repo,
            " AND i.state = 'open' AND i.number IS NOT NULL)"
        )
    };
}

/// Work items, each with its origin's id (`origin_id`, NULL for none): a
/// table to select from.
macro_rules! items_with_origin {
    () => {
        "(SELECT i.id, i.workspace, i.number, i.title, i.state, i.reason, i.author_id, i.requested_by_id,
            i.created_at, i.updated_at, o.repo_id AS origin_id
          FROM work_items i LEFT JOIN work_item_repos o ON o.item_id = i.id AND o.role = 'origin')"
    };
}

pub(crate) use {item_number, item_numbers, item_workspace, items_linked_to, items_with_origin, open_items_linked_to};

/// An account purged (ghost.rs, `?1` its id, `?2` its username): its work
/// items show as ghost's, and it is assigned to none.
pub(crate) fn user_deleted() -> Vec<String> {
    use g1t_contracts::account_deletion::{GHOST_ID, GHOST_USERNAME};
    vec![
        format!("UPDATE work_items SET author_id = '{GHOST_ID}', author_name = '{GHOST_USERNAME}' WHERE author_id = ?1"),
        format!("UPDATE work_items SET requested_by_id = '{GHOST_ID}', requested_by_name = '{GHOST_USERNAME}' WHERE requested_by_id = ?1"),
        "UPDATE work_items SET assignees = (SELECT json_group_array(value) FROM json_each(work_items.assignees) WHERE value <> ?2)
             WHERE ?1 IS NOT NULL AND json_valid(assignees) AND EXISTS (SELECT 1 FROM json_each(work_items.assignees) WHERE value = ?2)"
            .to_owned(),
    ]
}

/// `repo.purged` (retired.rs, `?1` its id): its work items stay, their
/// links keeping the path it had.
pub(crate) const REPO_PURGED: &str =
    "UPDATE work_item_repos SET path = COALESCE((SELECT path FROM repo_workspaces WHERE repo_id = ?1), path) WHERE repo_id = ?1";
