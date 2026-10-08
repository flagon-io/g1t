//! Who may pull, push and delete a package.
//!
//! A package linked to a repository has its visibility and roles: Read
//! pulls, Write pushes, Admin deletes and changes its settings. An unlinked
//! one is its workspace's: members by the base permission, owners delete,
//! anyone pulls a public one. A token is limited further by its scopes
//! (`packages:read`, `packages:write`, `packages:delete`), and an agent's
//! run token by its run: it may push only where its run may push code.

use g1t_contracts::access::{self, RepoRef, RepoRole};
use g1t_contracts::credentials::{self, Decision};
use g1t_contracts::packages::PackagePermissions;
use g1t_contracts::repos::RepoPath;
use g1t_contracts::scopes::{self, Level};
use g1t_contracts::{PrincipalKind, Role, User};
use serde::{Deserialize, Serialize};

/// What is done to a package, as registry tokens name it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Pull,
    Push,
    Delete,
}

impl Action {
    pub fn as_str(self) -> &'static str {
        match self {
            Action::Pull => "pull",
            Action::Push => "push",
            Action::Delete => "delete",
        }
    }

    fn level(self) -> Level {
        match self {
            Action::Pull => Level::Read,
            Action::Push => Level::Write,
            Action::Delete => Level::Delete,
        }
    }
}

/// The repository a package is linked to, or would be on its first push.
#[derive(Clone, Copy, Debug)]
pub struct LinkedTo<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub private: bool,
}

/// What a decision needs to know about a package, made or not yet.
#[derive(Clone, Copy, Debug)]
pub struct Target<'a> {
    pub workspace: &'a str,
    pub repo: Option<LinkedTo<'a>>,
    /// For an unlinked package: whether it is public. A package not made
    /// yet is private.
    pub public: bool,
}

impl Target<'_> {
    /// Whether anyone may pull it.
    pub fn is_public(&self) -> bool {
        match self.repo {
            Some(repo) => !repo.private,
            None => self.public,
        }
    }
}

/// What a member's membership of the workspace gives on its packages.
fn workspace_role(user: &User, workspace: &str) -> Option<RepoRole> {
    // No repository has an empty id, so only the membership counts.
    access::granted(user, RepoRef { id: "", namespace: workspace, private: true })
}

/// Whether `user` may delete an unlinked package of `workspace`, and change
/// its settings: its owners, and the workspace's own token.
fn owns(user: &User, workspace: &str) -> bool {
    matches!(user.kind, PrincipalKind::Workspace | PrincipalKind::System) && user.is_member(workspace)
        || user.role_in(workspace) == Some(Role::Owner)
}

/// Whether `viewer` may do `action` to the package, with the rule and, for
/// a refusal, the reason in words.
pub fn decide(viewer: Option<&User>, target: &Target<'_>, action: Action) -> Decision {
    let public = target.is_public();
    let Some(mut user) = viewer.cloned() else {
        return if action == Action::Pull && public {
            Decision::allow("public")
        } else if action == Action::Pull {
            Decision::deny("anonymous", "Sign in to pull this package: docker login g1t.sh.")
        } else {
            Decision::deny("anonymous", "Sign in to push: docker login g1t.sh.")
        };
    };

    // An agent's run token: only where its run may read or push code, and
    // then as the person it works for.
    if user.kind == PrincipalKind::Agent {
        let Some(scope) = user.acting.as_ref().map(|acting| acting.scope.clone()) else {
            return Decision::deny("agent", "This agent token cannot use packages.");
        };
        if action == Action::Delete {
            return Decision::deny("agent", "A g1t agent cannot delete packages.");
        }
        let Some(repo) = target.repo else {
            return Decision::deny("agent", "A g1t agent can use only the packages of the repository it works on.");
        };
        let path = RepoPath { namespace: target.workspace.to_owned(), name: repo.name.to_owned() };
        let decision = credentials::decide_git(&scope, &path, action == Action::Push);
        if !decision.allowed {
            return decision;
        }
        match credentials::as_person(&user) {
            Some(person) => user = person,
            None => return Decision::deny("agent", "This agent token cannot use packages."),
        }
    }

    if let Some(token) = user.token.as_deref() {
        let decision = scopes::decide_packages(token, action.level(), public);
        if !decision.allowed {
            return decision;
        }
    }

    if action != Action::Pull && user.kind == PrincipalKind::User && !user.verified {
        return Decision::deny("unverified", "Confirm your email address first. Check your inbox, or resend the link from the banner on g1t.sh.");
    }

    match target.repo {
        Some(repo) => {
            let role = access::permission(
                Some(&user),
                RepoRef { id: repo.id, namespace: target.workspace, private: repo.private },
            );
            let needed = match action {
                Action::Pull => RepoRole::Read,
                Action::Push => RepoRole::Write,
                Action::Delete => RepoRole::Admin,
            };
            if role >= Some(needed) {
                Decision::allow("repository")
            } else if role.is_none() {
                Decision::deny("repository", "This package does not exist, or you cannot see it.")
            } else {
                Decision::deny(
                    "repository",
                    format!(
                        "You need the {} role or higher on {}/{} to {} this package.",
                        needed.label(),
                        target.workspace,
                        repo.name,
                        action.as_str()
                    ),
                )
            }
        }
        None => {
            let role = workspace_role(&user, target.workspace);
            let allowed = match action {
                Action::Pull => public || role >= Some(RepoRole::Read),
                Action::Push => role >= Some(RepoRole::Write),
                Action::Delete => owns(&user, target.workspace),
            };
            if allowed {
                Decision::allow(if public && role.is_none() { "public" } else { "workspace" })
            } else if !public && role.is_none() {
                Decision::deny("workspace", "This package does not exist, or you cannot see it.")
            } else if action == Action::Delete {
                Decision::deny("workspace", format!("Only an owner of {} can delete its packages.", target.workspace))
            } else {
                Decision::deny("workspace", format!("You need write access to {} to push its packages.", target.workspace))
            }
        }
    }
}

/// Every action `viewer` may take, for the site.
pub fn permissions(viewer: Option<&User>, target: &Target<'_>) -> PackagePermissions {
    let may = |action| decide(viewer, target, action).allowed;
    let delete = may(Action::Delete);
    PackagePermissions {
        pull: may(Action::Pull),
        push: may(Action::Push),
        delete,
        admin: delete,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::Membership;
    use g1t_contracts::access::{BasePermission, RepoGrant};
    use g1t_contracts::credentials::{Acting, CredentialUse, GitGrant, Principal, RunBinding, RunCredentialKind};
    use g1t_contracts::scopes::{Scope, TokenAccess};

    fn person(role: Role, base: Option<BasePermission>) -> User {
        User {
            id: "usr_1".into(),
            username: "ana".into(),
            verified: true,
            workspaces: vec![Membership { role, base_permission: base, ..Membership::member("acme") }],
            ..User::default()
        }
    }

    fn outsider() -> User {
        User { id: "usr_2".into(), username: "bo".into(), verified: true, ..User::default() }
    }

    const PRIVATE_REPO: LinkedTo<'static> = LinkedTo { id: "rep_1", name: "web", private: true };
    const PUBLIC_REPO: LinkedTo<'static> = LinkedTo { id: "rep_1", name: "web", private: false };

    fn linked(repo: LinkedTo<'static>) -> Target<'static> {
        Target { workspace: "acme", repo: Some(repo), public: false }
    }

    fn unlinked(public: bool) -> Target<'static> {
        Target { workspace: "acme", repo: None, public }
    }

    fn may(user: Option<&User>, target: Target<'_>, action: Action) -> bool {
        decide(user, &target, action).allowed
    }

    #[test]
    fn a_linked_package_follows_its_repository_roles() {
        let member = person(Role::Member, None);
        assert!(may(Some(&member), linked(PRIVATE_REPO), Action::Pull));
        assert!(may(Some(&member), linked(PRIVATE_REPO), Action::Push));
        assert!(!may(Some(&member), linked(PRIVATE_REPO), Action::Delete), "Write is not Admin");
        let reader = person(Role::Member, Some(BasePermission::Read));
        assert!(may(Some(&reader), linked(PRIVATE_REPO), Action::Pull));
        let refused = decide(Some(&reader), &linked(PRIVATE_REPO), Action::Push);
        assert!(refused.reason.unwrap().contains("Write role"));
        let owner = person(Role::Owner, Some(BasePermission::Read));
        assert!(may(Some(&owner), linked(PRIVATE_REPO), Action::Delete));
        // A direct grant counts, for someone outside the workspace.
        let mut collaborator = outsider();
        collaborator.grants = vec![RepoGrant { repo_id: "rep_1".into(), workspace: "acme".into(), role: RepoRole::Admin, team: None }];
        assert!(may(Some(&collaborator), linked(PRIVATE_REPO), Action::Delete));
        assert!(!may(Some(&outsider()), linked(PRIVATE_REPO), Action::Pull));
    }

    #[test]
    fn public_packages_pull_anonymously_and_nothing_else() {
        assert!(may(None, linked(PUBLIC_REPO), Action::Pull));
        assert!(!may(None, linked(PUBLIC_REPO), Action::Push));
        assert!(!may(None, linked(PRIVATE_REPO), Action::Pull));
        assert!(may(None, unlinked(true), Action::Pull));
        assert!(!may(None, unlinked(false), Action::Pull));
        assert!(may(Some(&outsider()), unlinked(true), Action::Pull));
        assert!(!may(Some(&outsider()), unlinked(true), Action::Push));
    }

    #[test]
    fn an_unlinked_package_is_the_workspaces_and_its_owners_delete() {
        let member = person(Role::Member, None);
        assert!(may(Some(&member), unlinked(false), Action::Push));
        assert!(!may(Some(&member), unlinked(false), Action::Delete));
        let none = person(Role::Member, Some(BasePermission::None));
        assert!(!may(Some(&none), unlinked(false), Action::Pull));
        let reader = person(Role::Member, Some(BasePermission::Read));
        assert!(may(Some(&reader), unlinked(false), Action::Pull));
        assert!(!may(Some(&reader), unlinked(false), Action::Push));
        assert!(may(Some(&person(Role::Owner, None)), unlinked(false), Action::Delete));
        // Even a base permission of Admin does not make a member an owner.
        assert!(!may(Some(&person(Role::Member, Some(BasePermission::Admin))), unlinked(false), Action::Delete));
        let permissions = permissions(Some(&member), &unlinked(false));
        assert_eq!(permissions, PackagePermissions { pull: true, push: true, delete: false, admin: false });
    }

    #[test]
    fn a_workspace_token_such_as_g1t_token_does_what_an_owner_can() {
        let workspace = User {
            id: "wsp_1".into(),
            username: "acme".into(),
            kind: PrincipalKind::Workspace,
            verified: true,
            workspaces: vec![Membership::member("acme")],
            token: Some(Box::new(TokenAccess::full())),
            ..User::default()
        };
        assert!(may(Some(&workspace), linked(PRIVATE_REPO), Action::Push));
        assert!(may(Some(&workspace), unlinked(false), Action::Push));
        assert!(may(Some(&workspace), unlinked(false), Action::Delete));
        let other = Target { workspace: "other", repo: None, public: false };
        assert!(!may(Some(&workspace), other, Action::Pull));
    }

    #[test]
    fn a_tokens_scopes_limit_it_and_old_tokens_keep_working() {
        let with = |scopes: &[Scope]| {
            let mut user = person(Role::Owner, None);
            user.token = Some(Box::new(TokenAccess {
                token_id: "tok_1".into(),
                scopes: Some(scopes.iter().map(|s| s.as_str().to_owned()).collect()),
                legacy: false,
            }));
            user
        };
        let code = with(&[Scope::CodeWrite]);
        assert!(!may(Some(&code), linked(PRIVATE_REPO), Action::Pull));
        assert!(may(Some(&code), linked(PUBLIC_REPO), Action::Pull));
        let reader = with(&[Scope::PackagesRead]);
        assert!(may(Some(&reader), linked(PRIVATE_REPO), Action::Pull));
        assert!(!may(Some(&reader), linked(PRIVATE_REPO), Action::Push));
        let writer = with(&[Scope::PackagesWrite]);
        assert!(may(Some(&writer), linked(PRIVATE_REPO), Action::Push));
        assert!(!may(Some(&writer), linked(PRIVATE_REPO), Action::Delete));
        assert!(may(Some(&with(&[Scope::PackagesDelete])), linked(PRIVATE_REPO), Action::Delete));
        let mut legacy = person(Role::Owner, None);
        legacy.token = Some(Box::new(TokenAccess { legacy: true, ..TokenAccess::full() }));
        assert!(may(Some(&legacy), linked(PRIVATE_REPO), Action::Delete));
    }

    #[test]
    fn an_unverified_person_may_pull_but_not_push() {
        let mut person = person(Role::Member, None);
        person.verified = false;
        assert!(may(Some(&person), linked(PRIVATE_REPO), Action::Pull));
        assert!(decide(Some(&person), &linked(PRIVATE_REPO), Action::Push).reason.unwrap().contains("Confirm"));
    }

    fn agent(push: &[&str]) -> User {
        let path = |name: &str| RepoPath { namespace: "acme".into(), name: name.into() };
        User {
            id: "agt_1".into(),
            username: "g1t".into(),
            kind: PrincipalKind::Agent,
            verified: true,
            workspaces: vec![Membership::member("acme")],
            acting: Some(Box::new(Acting {
                credential_id: "cred_1".into(),
                agent: "g1t".into(),
                on_behalf_of: Principal { id: "usr_1".into(), username: "ana".into() },
                scope: g1t_contracts::identity::AgentScope {
                    repo: path("web"),
                    operations: vec![],
                    run: Some(RunBinding {
                        kind: RunCredentialKind::Implement,
                        usage: CredentialUse::Runner,
                        run_id: None,
                        number: None,
                        agent: "g1t".into(),
                        read: vec![],
                        push: push.iter().map(|name| GitGrant { repo: path(name), branch: None }).collect(),
                        system: false,
                    }),
                },
            })),
            ..User::default()
        }
    }

    #[test]
    fn an_agent_run_pushes_only_its_own_repositorys_packages() {
        let pushing = agent(&["web"]);
        assert!(may(Some(&pushing), linked(PRIVATE_REPO), Action::Pull));
        assert!(may(Some(&pushing), linked(PRIVATE_REPO), Action::Push));
        assert!(!may(Some(&pushing), linked(PRIVATE_REPO), Action::Delete));
        assert!(!may(Some(&pushing), unlinked(false), Action::Push), "only packages of a repository");
        let other = LinkedTo { id: "rep_2", name: "api", private: true };
        assert!(!may(Some(&pushing), linked(other), Action::Push));
        let reading = agent(&[]);
        assert!(may(Some(&reading), linked(PRIVATE_REPO), Action::Pull));
        assert!(!may(Some(&reading), linked(PRIVATE_REPO), Action::Push));
    }
}
