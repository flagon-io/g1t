//! Types and service interfaces shared by every g1t service.
//!
//! Each service has a module here holding the data it exchanges and the
//! arguments of each of its methods. Services and their callers depend on
//! this crate, never on each other's code.

pub mod events;
pub mod identity;
mod ids;
mod names;
mod outcome;
pub mod repos;
pub mod time;
pub mod work;

pub use ids::new_id;
pub use names::{is_valid_namespace, is_valid_repo_name};
pub use outcome::{Failure, FailureCode, Outcome};

use serde::{Deserialize, Serialize};

/// What a member may do in a workspace.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// Everything a member can, plus managing members.
    Owner,
    /// Create repositories, push, open intents and ship.
    Member,
}

/// One workspace a user belongs to.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Membership {
    /// The workspace's name in URLs: `g1t.sh/<slug>`.
    pub slug: String,
    pub role: Role,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct User {
    pub id: String,
    pub username: String,
    /// Whether the account's email address has been confirmed. Unverified
    /// accounts can sign in but cannot create or change anything.
    #[serde(default)]
    pub verified: bool,
    /// The workspaces this user belongs to. Filled in when a user is
    /// resolved from credentials, so any service can authorize from it.
    #[serde(default)]
    pub workspaces: Vec<Membership>,
}

impl User {
    pub fn role_in(&self, slug: &str) -> Option<Role> {
        self.workspaces
            .iter()
            .find(|membership| membership.slug == slug)
            .map(|membership| membership.role)
    }

    pub fn is_member(&self, slug: &str) -> bool {
        self.role_in(slug).is_some()
    }
}

/// Who is asking. Every read and write in every service takes one.
pub type Viewer = Option<User>;
