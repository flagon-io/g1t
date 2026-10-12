//! Shared invite links: before registration opened, one link staff handed
//! to a group (a conference's judges, a post, a community), made in sudo.
//!
//! None are made or used any more: anyone may register, and a shared
//! link's code is now an unknown code that sign-up ignores. The tables
//! (`shared_invites`, `shared_invite_uses`) keep what they recorded, so
//! sudo still shows "Joined through <label>" for an account made with one.

use g1t_contracts::identity::SharedInviteSource;
use serde::Deserialize;
use worker::Result;

use crate::Identity;

impl Identity {
    /// The shared link an account was made with, if it was.
    pub(crate) async fn shared_source(&self, user_id: &str) -> Result<Option<SharedInviteSource>> {
        #[derive(Deserialize)]
        struct Row {
            id: String,
            label: String,
        }
        Ok(self
            .db
            .prepare(
                "SELECT s.id, s.label FROM shared_invite_uses u JOIN shared_invites s ON s.id = u.shared_invite_id
                 WHERE u.user_id = ?",
            )
            .bind(&[user_id.into()])?
            .first::<Row>(None)
            .await?
            .map(|row| SharedInviteSource { id: row.id, label: row.label }))
    }
}
