//! Types and service interfaces shared by every g1t service.
//!
//! Each service has a module here holding the data it exchanges and the
//! arguments of each of its methods. Services and their callers depend on
//! this crate, never on each other's code.

pub mod about;
pub mod access;
pub mod account_deletion;
pub mod accounts;
pub mod actions;
pub mod agents;
pub mod audit;
pub mod backups;
pub mod billing;
pub mod capture;
pub mod checks;
pub mod codeowners;
pub mod credentials;
pub mod datasets;
pub mod deploy_keys;
pub mod events;
pub mod folios;
pub mod github;
pub mod guardrails;
pub mod identity;
pub mod inbox;
pub mod integrations;
pub mod members;
pub mod mirrors;
mod ids;
mod names;
mod outcome;
pub mod packages;
pub mod people;
pub mod projects;
pub mod repos;
pub mod rules;
pub mod runners;
pub mod scopes;
pub mod search;
pub mod security;
pub mod teams;
pub mod security_suite;
pub mod subscribers;
pub mod time;
pub mod tokens;
pub mod updates;
pub mod webhooks;
pub mod work;

pub use ids::new_id;
pub use names::{
    Username, aliasable_name, claimable_namespace, claimable_username, is_namespace_shaped, is_reserved_name, is_route_name,
    is_valid_namespace, is_valid_repo_name,
};
pub use outcome::{Failure, FailureCode, Outcome};

use serde::{Deserialize, Serialize};

/// What a member may do in a workspace. A member may also hold
/// [`members::OrgRole`]s, which add to it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// Everything: Admin on every repository, the workspace's members,
    /// settings, billing and security.
    Owner,
    /// The workspace's base permission on each repository, and what its
    /// member privileges allow (see [`members::MemberPrivileges`]).
    Member,
}

pub use members::{MemberPrivileges, OrgRole};

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
    /// Who may create the workspace's teams. Set when a user is resolved
    /// from credentials; absent means the default, any member. See
    /// [`teams::TeamCreation`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_creation: Option<teams::TeamCreation>,
    /// The roles the member holds besides `role`: billing manager,
    /// security manager. Set when a user is resolved from credentials.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub org_roles: Vec<OrgRole>,
    /// What the workspace lets members (and repository admins) do. Set
    /// when a user is resolved from credentials; absent means the
    /// defaults. See [`members::MemberPrivileges`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub privileges: Option<MemberPrivileges>,
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
            team_creation: None,
            org_roles: Vec::new(),
            privileges: None,
        }
    }

    /// Whether the member holds `role` besides owner or member.
    pub fn has(&self, role: OrgRole) -> bool {
        self.org_roles.contains(&role)
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
    /// one repository. Its `username` is `g1t`.
    Agent,
    /// g1t itself: the platform acting on its own, as when it opens a
    /// pull request to upgrade a vulnerable dependency or merges from the
    /// queue. Never resolved from credentials: only services make one,
    /// with [`User::system`]. Its `username` is `g1t`, which nobody can
    /// register.
    System,
}

/// g1t's own identity, as [`PrincipalKind::System`] work is recorded.
pub mod system {
    /// Its id wherever an author or actor id is stored.
    pub const ID: &str = "g1t";
    /// Its name, shown as the author of what it does.
    pub const USERNAME: &str = "g1t";
    /// The address on the commits it makes, which no mailbox receives.
    pub const EMAIL: &str = "g1t@users.noreply.g1t.sh";
    /// Ids that earlier versions stored for g1t's own actions, such as a
    /// merge its settings made. Read as g1t too.
    pub const LEGACY_IDS: [&str; 3] = ["g1t_policy", "svc_runner", "g1t_runner"];

    /// Whether `id` is g1t's own.
    pub fn is_system_id(id: &str) -> bool {
        id == ID || LEGACY_IDS.contains(&id)
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct User {
    pub id: String,
    /// Lowercased: what the person is found, linked and mentioned by.
    pub username: String,
    /// The username as its owner wrote it (`Ana`), when that differs from
    /// `username`: what pages show. Set on the signed-in person and on
    /// people looked up by name; absent elsewhere, where `username` is shown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_username: Option<String>,
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
    /// The workspaces this person belongs to but cannot use until they
    /// meet its policy, such as turning on two-factor authentication.
    /// They are left out of `workspaces` and `grants` meanwhile. Set when
    /// a person is resolved from a session.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub held: Vec<members::PolicyHold>,
}

impl User {
    /// g1t itself, acting in `workspace`: what the platform's own work,
    /// such as security updates, is done and recorded as.
    pub fn system(workspace: &str) -> User {
        User {
            id: system::ID.to_owned(),
            username: system::USERNAME.to_owned(),
            kind: PrincipalKind::System,
            verified: true,
            workspaces: vec![Membership::member(workspace.to_lowercase())],
            ..User::default()
        }
    }

    /// Whether this is g1t itself.
    pub fn is_system(&self) -> bool {
        self.kind == PrincipalKind::System
    }

    /// Whether this is a person whose account has not confirmed its email
    /// address. Such an account can only confirm it (or change it, or sign
    /// out): the site, the API, MCP and git refuse it everything else
    /// ([`accounts::confirm_email_first`]).
    pub fn awaits_confirmation(&self) -> bool {
        self.kind == PrincipalKind::User && !self.verified
    }

    pub fn role_in(&self, slug: &str) -> Option<Role> {
        self.workspaces
            .iter()
            .find(|membership| membership.slug == slug)
            .map(|membership| membership.role)
    }

    pub fn is_member(&self, slug: &str) -> bool {
        self.role_in(slug).is_some()
    }

    /// The membership in `slug`, if any.
    pub fn membership(&self, slug: &str) -> Option<&Membership> {
        self.workspaces.iter().find(|membership| membership.slug.eq_ignore_ascii_case(slug))
    }

    /// Whether this is a person who owns `slug`, or holds `role` in it.
    pub fn owns_or_has(&self, slug: &str, role: OrgRole) -> bool {
        self.membership(slug)
            .is_some_and(|membership| membership.role == Role::Owner || membership.has(role))
    }

    /// Whether the user may manage `slug`'s billing: an owner or a billing
    /// manager.
    pub fn manages_billing(&self, slug: &str) -> bool {
        self.owns_or_has(slug, OrgRole::BillingManager)
    }

    /// Whether the user may see and manage security across `slug`: an
    /// owner or a security manager.
    pub fn manages_security(&self, slug: &str) -> bool {
        self.owns_or_has(slug, OrgRole::SecurityManager)
    }

    /// The workspace's member privileges as this user sees them: the
    /// defaults when the membership does not say.
    pub fn privileges_in(&self, slug: &str) -> MemberPrivileges {
        self.membership(slug).and_then(|membership| membership.privileges).unwrap_or_default()
    }
}

/// Who is asking. Every read and write in every service takes one.
pub type Viewer = Option<User>;
