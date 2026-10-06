//! Types and service interfaces shared by every g1t service.
//!
//! Each service has a module here holding the data it exchanges and the
//! arguments of each of its methods. Services and their callers depend on
//! this crate, never on each other's code.

pub mod access;
pub mod accounts;
pub mod actions;
pub mod agents;
pub mod audit;
pub mod billing;
pub mod capture;
pub mod credentials;
pub mod events;
pub mod github;
pub mod guardrails;
pub mod identity;
pub mod integrations;
mod ids;
mod names;
mod outcome;
pub mod projects;
pub mod repos;
pub mod scopes;
pub mod search;
pub mod security;
pub mod time;
pub mod webhooks;
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
    /// Create repositories, push, manage issues and merge pull requests.
    Member,
}

/// One workspace a user belongs to.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Membership {
    /// The workspace's name in URLs: `g1t.sh/<slug>`.
    pub slug: String,
    pub role: Role,
    /// The workspace's display name, for showing it to people. Set when a
    /// user is resolved from credentials; absent on principals made up by
    /// a service.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The workspace's uploaded icon: the SHA-256 of its bytes, served at
    /// `/avatars/<avatar>`. Absent means the generated letter avatar.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    /// What a member gets on each of the workspace's repositories: the
    /// workspace's base permission. Set when a user is resolved from
    /// credentials; absent means the default, Write. Owners have Admin
    /// whatever it says. See [`access`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_permission: Option<access::BasePermission>,
}

impl Membership {
    /// A plain member of `slug`, as services act inside one workspace.
    pub fn member(slug: impl Into<String>) -> Self {
        Membership {
            slug: slug.into(),
            role: Role::Member,
            name: None,
            avatar: None,
            base_permission: None,
        }
    }
}

/// What a set of credentials resolved to.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PrincipalKind {
    /// A person's account.
    #[default]
    User,
    /// A workspace, acting through one of its own access tokens. Its `id`
    /// is the workspace's, its `username` the workspace's slug, and it is a
    /// member of that workspace and no other.
    Workspace,
    /// A g1t agent at work in a sandbox, acting through a token that lives
    /// as long as its run and can do only what that token's scope lists, in
    /// one repository. Its `username` is `g1t-agent`.
    Agent,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct User {
    pub id: String,
    pub username: String,
    #[serde(default)]
    pub kind: PrincipalKind,
    /// Whether the account's email address has been confirmed. Unverified
    /// accounts can sign in but cannot create or change anything.
    #[serde(default)]
    pub verified: bool,
    /// The workspaces this user belongs to. Filled in when a user is
    /// resolved from credentials, so any service can authorize from it.
    #[serde(default)]
    pub workspaces: Vec<Membership>,
    /// The person's uploaded avatar: the SHA-256 of its bytes, served at
    /// `/avatars/<avatar>`. Absent means the generated letter avatar.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    /// Set on an agent resolved from its token: who it acts for, with which
    /// credential, and what it may do. See [`credentials`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acting: Option<Box<credentials::Acting>>,
    /// The repositories this user has been given a role on directly,
    /// whether or not they belong to its workspace. Filled in with
    /// `workspaces`; see [`access`].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub grants: Vec<access::RepoGrant>,
    /// Set on a user resolved from an access token: its scopes and the
    /// workspaces or repositories it is limited to. Absent on a signed-in
    /// session and on an agent (whose `acting` scope applies instead).
    /// See [`scopes`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<Box<scopes::TokenAccess>>,
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
