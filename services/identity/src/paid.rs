//! What a free workspace may not do, asked of billing (`free_workspaces`).
//!
//! - **One free workspace per person.** A person may own at most one
//!   workspace on no paid plan. Paid is the g1t plan, an enterprise's terms
//!   or a 100% discount (g1t's own workspaces). Making a second free one is
//!   refused with the way forward: start the plan on the one they have, or
//!   delete it. People who own several from before keep them, and cannot
//!   make more until all but one are paid for.
//! - **No one added to a free workspace.** It cannot add members, send
//!   invites, or invite outside collaborators to its repositories, and an
//!   invite sent before cannot be accepted, until it starts the plan. Its
//!   members stay. g1t's own agent (@g1t) is never a member for this.
//!
//! Without billing bound (a g1t that does not take payments) nothing is
//! free and nothing is refused. When billing cannot be asked, the change
//! is refused for now, never let through unchecked.

use g1t_contracts::billing::FreeWorkspacesArgs;
use g1t_contracts::{FailureCode, Outcome, Role};
use worker::Result;

use crate::Identity;

/// Why a person cannot make another free workspace: they own `free`
/// already. None when they own none.
pub(crate) fn second_free_refusal(free: &[String]) -> Option<String> {
    let first = free.first()?;
    let (owned, them) = if free.len() == 1 {
        (format!("You already own a free workspace, {first}"), "it")
    } else {
        (format!("You already own {} free workspaces ({})", free.len(), free.join(", ")), "each of them")
    };
    Some(format!(
        "{owned}, and each person can own one workspace that is not on the g1t plan. A new workspace starts free: to make one, start the plan on {them} (/{first}/-/billing#plan), or delete a free workspace you no longer use (in its settings, /{first}/-/settings)."
    ))
}

/// Why no one can be added to the free workspace `slug`.
pub(crate) fn invite_refusal(slug: &str) -> String {
    format!(
        "{slug} is a free workspace, so it cannot add people. Start the plan to invite people: an owner can start it at /{slug}/-/billing#plan. Its members stay as they are."
    )
}

/// Whether `username` is g1t's own agent, which is never counted as a
/// person added to a workspace.
pub(crate) fn is_g1t(username: &str) -> bool {
    username.trim().eq_ignore_ascii_case(g1t_contracts::identity::AGENT_NAME)
}

/// What to say when billing could not be asked.
const UNCHECKED: &str = "g1t could not check the workspace's plan just now. Nothing was changed; try again in a minute.";

impl Identity {
    /// The free ones of `workspaces`, as billing says. Empty without
    /// billing bound.
    async fn free_of(&self, workspaces: Vec<String>) -> Result<Vec<String>> {
        if workspaces.is_empty() {
            return Ok(vec![]);
        }
        let Ok(billing) = self.env.service("BILLING") else {
            return Ok(vec![]);
        };
        g1t_kit::call(&billing, "free_workspaces", &FreeWorkspacesArgs { workspaces }).await
    }

    /// A refusal if the person already owns a free workspace, for
    /// `create_workspace`.
    pub(crate) async fn second_free_workspace<T>(&self, user_id: &str) -> Result<Option<Outcome<T>>> {
        let owned: Vec<String> = self
            .memberships(user_id)
            .await?
            .into_iter()
            .filter(|m| m.role == Role::Owner)
            .map(|m| m.slug)
            .collect();
        Ok(match self.free_of(owned).await {
            Ok(free) => second_free_refusal(&free).map(|why| Outcome::fail(FailureCode::PaymentRequired, why)),
            Err(error) => {
                worker::console_error!("free workspaces of {user_id} not checked: {error}");
                Some(Outcome::fail(FailureCode::Conflict, UNCHECKED))
            }
        })
    }

    /// A refusal if `slug` is a free workspace, before anyone is added to
    /// it: as a member, by an invite, or as an outside collaborator.
    pub(crate) async fn free_workspace_refusal<T>(&self, slug: &str) -> Result<Option<Outcome<T>>> {
        let slug = slug.trim().to_lowercase();
        Ok(match self.free_of(vec![slug.clone()]).await {
            Ok(free) if free.contains(&slug) => Some(Outcome::fail(FailureCode::PaymentRequired, invite_refusal(&slug))),
            Ok(_) => None,
            Err(error) => {
                worker::console_error!("the plan of {slug} not checked before adding someone: {error}");
                Some(Outcome::fail(FailureCode::Conflict, UNCHECKED))
            }
        })
    }

    /// Whether `slug` is free, for paths that skip rather than refuse (a
    /// sign-up whose invite names a workspace). Free when billing cannot
    /// be asked: nobody joins unchecked.
    pub(crate) async fn is_free_workspace(&self, slug: &str) -> bool {
        let slug = slug.trim().to_lowercase();
        match self.free_of(vec![slug.clone()]).await {
            Ok(free) => free.contains(&slug),
            Err(error) => {
                worker::console_error!("the plan of {slug} not checked: {error}");
                true
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_free_workspace_is_refused_with_the_way_forward() {
        assert_eq!(second_free_refusal(&[]), None);
        let one = second_free_refusal(&["acme".to_owned()]).unwrap();
        assert!(one.starts_with("You already own a free workspace, acme"));
        assert!(one.contains("/acme/-/billing#plan"));
        assert!(one.contains("delete"));
        // Grandfathered: several from before are named, and still no more.
        let several = second_free_refusal(&["acme".to_owned(), "side".to_owned()]).unwrap();
        assert!(several.starts_with("You already own 2 free workspaces (acme, side)"));
    }

    #[test]
    fn a_free_workspace_is_told_to_start_the_plan_to_invite() {
        let why = invite_refusal("acme");
        assert!(why.contains("Start the plan to invite people"));
        assert!(why.contains("/acme/-/billing#plan"));
        assert!(why.contains("members stay"));
    }

    #[test]
    fn g1ts_agent_is_never_a_person_added() {
        assert!(is_g1t("g1t"));
        assert!(is_g1t(" G1T "));
        assert!(!is_g1t("ada"));
        assert!(!is_g1t("g1t-fan"));
    }
}
