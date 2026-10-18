//! Emoji reactions to a work item's or a pull request's description and
//! to the comments on it (`react`). Anyone who can read it may react; g1t
//! reacts 👀 to what it was asked to take on (integrations' `summon.rs`).
//! A conversation's reactions are read with its comments, in the same
//! batch ([`THREAD_SQL`], [`ITEM_THREAD_SQL`]), and grouped onto them
//! ([`attach`]).

use g1t_contracts::work::{Comment, ReactArgs, ReactionContent, ReactionGroup, group_reactions};
use g1t_contracts::{FailureCode, Outcome};
use g1t_kit::now_ms;
use g1t_contracts::time::rfc3339;
use worker::wasm_bindgen::JsValue;
use serde::Deserialize;
use worker::Result;

use crate::retired::writable;
use crate::{On, Thread, Work};

/// Unwraps an `Outcome`, returning its failure from the enclosing method.
macro_rules! check {
    ($outcome:expr) => {
        match $outcome {
            Outcome::Ok(value) => value,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        }
    };
}

/// A pull request's reactions, oldest first: `?1` the repository, `?2` its
/// number.
pub(crate) const THREAD_SQL: &str = "SELECT subject, content, user_name FROM reactions
     WHERE repo_id = ?1 AND number = ?2 ORDER BY created_at, rowid LIMIT 2000";

/// A work item's reactions, oldest first: `?1` its id.
pub(crate) const ITEM_THREAD_SQL: &str = "SELECT subject, content, user_name FROM reactions
     WHERE item_id = ?1 ORDER BY created_at, rowid LIMIT 2000";

/// `repo.purged`: `?1` the repository.
pub(crate) const PURGED: &str = "DELETE FROM reactions WHERE repo_id = ?1";

/// An account purged: its reactions go, `?1` its id.
pub(crate) const USER_DELETED: &str = "DELETE FROM reactions WHERE user_id = ?1";

#[derive(Deserialize)]
pub(crate) struct ReactionRow {
    subject: String,
    content: String,
    user_name: String,
}

/// The reactions of the thing called `subject`, grouped.
fn groups_of(rows: &[ReactionRow], subject: &str) -> Vec<ReactionGroup> {
    group_reactions(
        rows.iter()
            .filter(|row| row.subject == subject)
            .filter_map(|row| ReactionContent::parse(&row.content).map(|content| (content, row.user_name.as_str()))),
    )
}

/// Puts each comment's reactions on it, and returns those to the
/// description, whose subject is the work item's or pull request's id.
pub(crate) fn attach(rows: &[ReactionRow], description: &str, comments: &mut [Comment]) -> Vec<ReactionGroup> {
    if rows.is_empty() {
        return Vec::new();
    }
    for comment in comments.iter_mut() {
        comment.reactions = groups_of(rows, &comment.id);
    }
    groups_of(rows, description)
}

impl Work {
    /// `react`: see [`ReactArgs`].
    pub(crate) async fn react(&self, a: ReactArgs) -> Result<Outcome<Vec<ReactionGroup>>> {
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, crate::UNVERIFIED));
        }
        let thread = check!(self.thread(&Some(a.actor.clone()), a.repo.as_ref(), &a.workspace, a.number).await?);
        if let Thread::Pull(repo, _) = &thread {
            check!(writable(repo));
        }
        // What is reacted to: a comment in this conversation, or its description.
        let subject = match a.comment_id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
            Some(id) => {
                let found = match thread.on() {
                    On::Pull(repo_id, number) => {
                        self.db
                            .prepare("SELECT id FROM comments WHERE id = ? AND repo_id = ? AND number = ? AND kind = 'comment'")
                            .bind(&[id.into(), repo_id.into(), number.into()])?
                            .first::<IdOnly>(None)
                            .await?
                    }
                    On::Item(item_id) => {
                        self.db
                            .prepare("SELECT id FROM comments WHERE id = ? AND item_id = ? AND kind = 'comment'")
                            .bind(&[id.into(), item_id.into()])?
                            .first::<IdOnly>(None)
                            .await?
                    }
                };
                match found {
                    Some(row) => row.id,
                    None => return Ok(Outcome::fail(FailureCode::NotFound, "Comment not found.")),
                }
            }
            None => thread.subject().to_owned(),
        };
        let (repo_id, number, item_id) = match thread.on() {
            On::Pull(repo_id, number) => (JsValue::from(repo_id), JsValue::from(number), JsValue::NULL),
            On::Item(item_id) => (JsValue::NULL, JsValue::NULL, JsValue::from(item_id)),
        };
        let statement = if a.remove {
            self.db
                .prepare("DELETE FROM reactions WHERE subject = ? AND user_id = ? AND content = ?")
                .bind(&[subject.as_str().into(), a.actor.id.as_str().into(), a.content.as_str().into()])?
        } else {
            self.db
                .prepare(
                    "INSERT INTO reactions (subject, repo_id, number, item_id, user_id, user_name, content, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
                )
                .bind(&[
                    subject.as_str().into(),
                    repo_id,
                    number,
                    item_id,
                    a.actor.id.as_str().into(),
                    a.actor.username.as_str().into(),
                    a.content.as_str().into(),
                    rfc3339(now_ms()).into(),
                ])?
        };
        let read = self
            .db
            .prepare("SELECT subject, content, user_name FROM reactions WHERE subject = ? ORDER BY created_at, rowid LIMIT 500")
            .bind(&[subject.as_str().into()])?;
        let results = self.db.batch(vec![statement, read]).await?;
        let rows = match results.get(1) {
            Some(result) => result.results::<ReactionRow>()?,
            None => Vec::new(),
        };
        Ok(Outcome::Ok(groups_of(&rows, &subject)))
    }
}

#[derive(Deserialize)]
struct IdOnly {
    id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(subject: &str, content: &str, user: &str) -> ReactionRow {
        ReactionRow { subject: subject.into(), content: content.into(), user_name: user.into() }
    }

    #[test]
    fn reactions_group_by_what_they_react_to() {
        let rows = vec![
            row("iss_1", "eyes", "g1t"),
            row("cmt_1", "heart", "ana"),
            row("cmt_1", "+1", "bo"),
            row("cmt_1", "+1", "ana"),
            row("iss_1", "nonsense", "ana"),
        ];
        let groups = groups_of(&rows, "cmt_1");
        assert_eq!(groups.len(), 2);
        // In the order the picker shows them, not the order they came.
        assert_eq!(groups[0].content, ReactionContent::PlusOne);
        assert_eq!(groups[0].users, vec!["bo", "ana"]);
        assert_eq!(groups[0].count, 2);
        assert_eq!(groups[1].content, ReactionContent::Heart);
        let body = groups_of(&rows, "iss_1");
        assert_eq!(body.len(), 1, "an unknown reaction is left out");
        assert_eq!(body[0].users, vec!["g1t"]);
    }
}
