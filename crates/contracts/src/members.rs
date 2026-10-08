//! A workspace's members: owners and members, the roles that add to a
//! member (billing manager, security manager), what members are allowed to
//! do (member privileges), and the rules for changing who owns it.
//!
//! **Owners and members.** Every workspace has at least one owner. An
//! owner can make a member an owner and an owner a member, hand the
//! workspace to another member ([`TransferOwnershipArgs`]), and remove
//! anyone else. Anyone can leave ([`LeaveWorkspaceArgs`]). Whatever the
//! change, it is refused when it would leave the workspace without an
//! owner ([`last_owner_refusal`]).
//!
//! **Roles that add to a member** ([`OrgRole`]). A billing manager manages
//! the workspace's billing as an owner does: the budget, AI credit, cards,
//! invoices and billing details. It gives nothing on repositories. A
//! security manager reads every repository and sees and manages every
//! security alert and security setting on them, as
//! `access::SECURITY_MANAGER` lists. Owners have both already.
//!
//! **Member privileges** ([`MemberPrivileges`]): who may create
//! repositories, and whether repository admins who are members may change
//! a repository's visibility, delete or transfer it, and invite outside
//! collaborators. Owners can always do all of it. Identity attaches them to
//! each membership ([`crate::Membership::privileges`]) so the repos service
//! and identity enforce them without asking again.
//!
//! Every method is served by identity at `POST /rpc/<method>`; changing
//! members is for people, signed in or with a personal access token, never
//! an agent's or a workspace's token.

use serde::{Deserialize, Serialize};

use crate::{Role, User};

/// A role a member can hold besides owner or member. Owners have what
/// every one of them gives.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrgRole {
    /// Manages billing: budget, AI credit, payment, invoices and billing
    /// details. Nothing on repositories by itself.
    BillingManager,
    /// Reads every repository, and sees and manages every security alert
    /// and security setting on them.
    SecurityManager,
}

impl OrgRole {
    pub const ALL: [OrgRole; 2] = [OrgRole::BillingManager, OrgRole::SecurityManager];

    pub fn as_str(self) -> &'static str {
        match self {
            OrgRole::BillingManager => "billing_manager",
            OrgRole::SecurityManager => "security_manager",
        }
    }

    pub fn parse(text: &str) -> Option<OrgRole> {
        let text = text.trim().to_ascii_lowercase().replace([' ', '-'], "_");
        OrgRole::ALL.into_iter().find(|role| role.as_str() == text)
    }

    /// How people are shown it.
    pub fn label(self) -> &'static str {
        match self {
            OrgRole::BillingManager => "Billing manager",
            OrgRole::SecurityManager => "Security manager",
        }
    }
}

/// What a workspace lets its members do, set by its owners on Settings →
/// Member privileges. The names are the ones the REST API uses. Stored as
/// JSON in `workspaces.member_privileges`; NULL, or a field left out,
/// means its default.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemberPrivileges {
    /// Members may create public repositories. Default on.
    pub members_can_create_public_repositories: bool,
    /// Members may create private repositories. Default on.
    pub members_can_create_private_repositories: bool,
    /// Members with the Admin role on a repository may change its
    /// visibility. Default on. Off: owners only.
    pub members_can_change_repo_visibility: bool,
    /// Members with the Admin role on a repository may delete or transfer
    /// it. Default off: owners only, as before this setting existed.
    pub members_can_delete_repositories: bool,
    /// Members with the Admin role on a repository may give a role on it
    /// to someone outside the workspace. Default on. Off: owners only.
    pub members_can_invite_outside_collaborators: bool,
}

impl Default for MemberPrivileges {
    fn default() -> Self {
        MemberPrivileges {
            members_can_create_public_repositories: true,
            members_can_create_private_repositories: true,
            members_can_change_repo_visibility: true,
            members_can_delete_repositories: false,
            members_can_invite_outside_collaborators: true,
        }
    }
}

impl MemberPrivileges {
    /// Whether someone with `role` in the workspace may create a
    /// repository that is `private` or not.
    pub fn may_create(&self, role: Role, private: bool) -> bool {
        role == Role::Owner
            || if private {
                self.members_can_create_private_repositories
            } else {
                self.members_can_create_public_repositories
            }
    }

    /// The refusal for creating a repository, when there is one.
    pub fn creation_refusal(&self, role: Role, private: bool, slug: &str) -> Option<String> {
        if self.may_create(role, private) {
            return None;
        }
        let kind = if private { "private" } else { "public" };
        Some(if !self.members_can_create_public_repositories && !self.members_can_create_private_repositories {
            format!("Only owners of {slug} can create repositories in it.")
        } else {
            format!("Only owners of {slug} can create {kind} repositories in it.")
        })
    }

    /// Parses the JSON stored in `workspaces.member_privileges`.
    pub fn from_stored(text: Option<&str>) -> MemberPrivileges {
        text.and_then(|text| serde_json::from_str(text).ok()).unwrap_or_default()
    }

    /// Each setting with its name, value and what it means, in the order
    /// Settings shows them.
    pub fn listed(&self) -> [(&'static str, bool); 5] {
        [
            ("members_can_create_public_repositories", self.members_can_create_public_repositories),
            ("members_can_create_private_repositories", self.members_can_create_private_repositories),
            ("members_can_change_repo_visibility", self.members_can_change_repo_visibility),
            ("members_can_delete_repositories", self.members_can_delete_repositories),
            ("members_can_invite_outside_collaborators", self.members_can_invite_outside_collaborators),
        ]
    }

    /// The setting's sentence for the audit log.
    pub fn describe(name: &str) -> &'static str {
        match name {
            "members_can_create_public_repositories" => "members can create public repositories",
            "members_can_create_private_repositories" => "members can create private repositories",
            "members_can_change_repo_visibility" => "repository admins can change visibility",
            "members_can_delete_repositories" => "repository admins can delete and transfer repositories",
            "members_can_invite_outside_collaborators" => "repository admins can invite outside collaborators",
            _ => "a member privilege",
        }
    }
}

/// A change to some of a workspace's member privileges: each field given
/// is set, the rest are kept.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemberPrivilegesPatch {
    pub members_can_create_public_repositories: Option<bool>,
    pub members_can_create_private_repositories: Option<bool>,
    pub members_can_change_repo_visibility: Option<bool>,
    pub members_can_delete_repositories: Option<bool>,
    pub members_can_invite_outside_collaborators: Option<bool>,
}

impl MemberPrivilegesPatch {
    pub fn is_empty(&self) -> bool {
        *self == MemberPrivilegesPatch::default()
    }

    pub fn apply(&self, to: MemberPrivileges) -> MemberPrivileges {
        MemberPrivileges {
            members_can_create_public_repositories: self
                .members_can_create_public_repositories
                .unwrap_or(to.members_can_create_public_repositories),
            members_can_create_private_repositories: self
                .members_can_create_private_repositories
                .unwrap_or(to.members_can_create_private_repositories),
            members_can_change_repo_visibility: self
                .members_can_change_repo_visibility
                .unwrap_or(to.members_can_change_repo_visibility),
            members_can_delete_repositories: self.members_can_delete_repositories.unwrap_or(to.members_can_delete_repositories),
            members_can_invite_outside_collaborators: self
                .members_can_invite_outside_collaborators
                .unwrap_or(to.members_can_invite_outside_collaborators),
        }
    }

    /// Reads the fields of a JSON object, such as an API request's body,
    /// by their names. A field that is there and not a boolean is named in
    /// the error.
    pub fn from_json(input: &serde_json::Value) -> Result<MemberPrivilegesPatch, String> {
        let field = |name: &str| -> Result<Option<bool>, String> {
            match input.get(name) {
                None | Some(serde_json::Value::Null) => Ok(None),
                Some(serde_json::Value::Bool(value)) => Ok(Some(*value)),
                Some(_) => Err(format!("{name} is true or false.")),
            }
        };
        Ok(MemberPrivilegesPatch {
            members_can_create_public_repositories: field("members_can_create_public_repositories")?,
            members_can_create_private_repositories: field("members_can_create_private_repositories")?,
            members_can_change_repo_visibility: field("members_can_change_repo_visibility")?,
            members_can_delete_repositories: field("members_can_delete_repositories")?,
            members_can_invite_outside_collaborators: field("members_can_invite_outside_collaborators")?,
        })
    }
}

/// A workspace a person belongs to and cannot use yet, and why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicyHold {
    pub slug: String,
    /// What to tell them, such as "acme needs members to turn on
    /// two-factor authentication."
    pub reason: String,
    /// `two_factor`, `verified_email` or `email_domain`.
    pub gap: String,
}

/// Why a change to who owns a workspace would leave it with none, or
/// `None` when it would not. `owners` is how many owners it has now;
/// `losing` is whether the change takes one away.
pub fn last_owner_refusal(owners: usize, losing: bool) -> Option<&'static str> {
    (losing && owners <= 1).then_some(
        "A workspace needs at least one owner. Make another member an owner first, or delete the workspace.",
    )
}

/// `update_member`: change a member's role (owner or member) and the roles
/// they hold besides it. Each field given is set. Owners only, as a person;
/// never leaves the workspace without an owner. Returns
/// `Outcome<identity::Member>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateMemberArgs {
    pub actor: User,
    pub slug: String,
    pub username: String,
    #[serde(default)]
    pub role: Option<Role>,
    #[serde(default)]
    pub org_roles: Option<Vec<OrgRole>>,
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

/// `transfer_ownership`: makes `username`, a member, an owner, and the
/// owner asking a member, in one step. Owners only, as a person. Returns
/// `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct TransferOwnershipArgs {
    pub actor: User,
    pub slug: String,
    pub username: String,
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

/// `leave_workspace`: the person asking leaves. Their roles on its
/// repositories and their place in its teams go too. Refused for the last
/// owner. Returns `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct LeaveWorkspaceArgs {
    pub user: User,
    pub slug: String,
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

/// `set_member_privileges`: owners only, as a person. Returns
/// `Outcome<MemberPrivileges>`, all of them as they are now.
#[derive(Debug, Serialize, Deserialize)]
pub struct SetMemberPrivilegesArgs {
    pub actor: User,
    pub slug: String,
    pub privileges: MemberPrivilegesPatch,
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

/// `set_two_factor_requirement`: whether the workspace requires two-factor
/// authentication of its members and outside collaborators. Owners only,
/// as a person who has it on themselves. Those without it keep their
/// membership but cannot use it until they turn it on. Returns
/// `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct SetTwoFactorRequirementArgs {
    pub actor: User,
    pub slug: String,
    pub required: bool,
    #[serde(default)]
    pub surface: Option<crate::audit::Surface>,
}

/// `grant_creator`: the repos service made a repository; its creator gets
/// the Admin role on it directly, as a grant, so they keep it whatever the
/// base permission. For the repos service. Returns `bool`.
#[derive(Debug, Serialize, Deserialize)]
pub struct GrantCreatorArgs {
    pub repo_id: String,
    /// The workspace's slug.
    pub namespace: String,
    pub name: String,
    pub user_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_workspace_never_loses_its_last_owner() {
        assert!(last_owner_refusal(1, true).is_some());
        assert!(last_owner_refusal(0, true).is_some());
        assert_eq!(last_owner_refusal(2, true), None);
        assert_eq!(last_owner_refusal(1, false), None);
    }

    #[test]
    fn the_defaults_keep_what_members_could_do() {
        let defaults = MemberPrivileges::default();
        assert!(defaults.may_create(Role::Member, true));
        assert!(defaults.may_create(Role::Member, false));
        assert!(defaults.members_can_change_repo_visibility);
        assert!(!defaults.members_can_delete_repositories);
        assert!(defaults.members_can_invite_outside_collaborators);
        // Nothing stored, or an unreadable value, is the defaults.
        assert_eq!(MemberPrivileges::from_stored(None), defaults);
        assert_eq!(MemberPrivileges::from_stored(Some("nope")), defaults);
        // A field left out keeps its default.
        let stored = MemberPrivileges::from_stored(Some(r#"{"members_can_create_public_repositories":false}"#));
        assert!(!stored.members_can_create_public_repositories);
        assert!(stored.members_can_create_private_repositories);
    }

    #[test]
    fn owners_create_whatever_the_privileges_say() {
        let closed = MemberPrivileges {
            members_can_create_public_repositories: false,
            members_can_create_private_repositories: false,
            ..MemberPrivileges::default()
        };
        assert!(closed.may_create(Role::Owner, true));
        assert!(!closed.may_create(Role::Member, true));
        assert!(closed.creation_refusal(Role::Member, false, "acme").unwrap().contains("Only owners of acme can create repositories"));
        let private_only = MemberPrivileges { members_can_create_public_repositories: false, ..MemberPrivileges::default() };
        assert!(private_only.may_create(Role::Member, true));
        assert!(private_only.creation_refusal(Role::Member, false, "acme").unwrap().contains("public"));
        assert_eq!(private_only.creation_refusal(Role::Member, true, "acme"), None);
    }

    #[test]
    fn a_patch_sets_only_what_it_names() {
        let patch = MemberPrivilegesPatch::from_json(&serde_json::json!({ "members_can_delete_repositories": true, "name": "x" })).unwrap();
        assert!(!patch.is_empty());
        let applied = patch.apply(MemberPrivileges::default());
        assert!(applied.members_can_delete_repositories);
        assert!(applied.members_can_create_public_repositories);
        assert!(MemberPrivilegesPatch::from_json(&serde_json::json!({})).unwrap().is_empty());
        assert!(MemberPrivilegesPatch::from_json(&serde_json::json!({ "members_can_delete_repositories": "yes" })).is_err());
    }

    #[test]
    fn org_roles_read_and_write_as_words() {
        for role in OrgRole::ALL {
            assert_eq!(OrgRole::parse(role.as_str()), Some(role));
            assert_eq!(serde_json::to_value(role).unwrap(), role.as_str());
        }
        assert_eq!(OrgRole::parse("Billing manager"), Some(OrgRole::BillingManager));
        assert_eq!(OrgRole::parse("security-manager"), Some(OrgRole::SecurityManager));
        assert_eq!(OrgRole::parse("owner"), None);
    }
}
