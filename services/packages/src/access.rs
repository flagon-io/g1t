//! Who may pull, push, delete and administer a package.
//!
//! A package's role for someone is the most of:
//!
//! - **Its repository's**, for a linked package that inherits access (the
//!   default): Read and Triage pull, Write and Maintain publish, Admin
//!   administers.
//! - **Its workspace's**, for an unlinked one: members by the base
//!   permission, at most Write.
//! - **Ownership**: the workspace's owners administer every package.
//! - **Its own grants**: people and teams given Read, Write or Admin on
//!   the package itself (its Manage access settings).
//!
//! Anyone pulls a public package. A token is limited further by its scopes
//! (`packages:read`, `packages:write`, `packages:delete`); a fine-grained
//! token only reaches packages inside its resource owner and repository
//! selection; a workspace's own token is a member with Write unless an
//! owner gave it Admin. A workflow job's token reaches a package only from
//! the repository it is linked to (Write) or from a repository listed under
//! the package's Manage Actions access, with that role. An agent's run
//! token may push only where its run may push code. A deploy key never
//! reaches packages.

use g1t_contracts::access::{self, RepoRef, RepoRole};
use g1t_contracts::credentials::{self, Decision};
use g1t_contracts::packages::{GranteeKind, PackagePermissions, PackageRole};
use g1t_contracts::repos::RepoPath;
use g1t_contracts::scopes::{self, Level, TokenAccess};
use g1t_contracts::{PrincipalKind, Role, User};
use serde::{Deserialize, Serialize};

/// What is done to a package. Registry tokens name the first three;
/// `Admin` is changing its settings and access, `Settings` reading them
/// (and its deleted versions).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Pull,
    Push,
    Delete,
    Admin,
    Settings,
}

impl Action {
    pub fn as_str(self) -> &'static str {
        match self {
            Action::Pull => "pull",
            Action::Push => "push",
            Action::Delete => "delete",
            Action::Admin => "administer",
            Action::Settings => "see the settings of",
        }
    }

    /// The token scope level it needs: reading settings `packages:read`,
    /// changing them `packages:write` (both with the Admin role), deleting
    /// `packages:delete`.
    fn level(self) -> Level {
        match self {
            Action::Pull | Action::Settings => Level::Read,
            Action::Push | Action::Admin => Level::Write,
            Action::Delete => Level::Delete,
        }
    }

    fn needs(self) -> PackageRole {
        match self {
            Action::Pull => PackageRole::Read,
            Action::Push => PackageRole::Write,
            Action::Delete | Action::Admin | Action::Settings => PackageRole::Admin,
        }
    }

    /// Whether only the package's admins may do it.
    fn administers(self) -> bool {
        matches!(self, Action::Delete | Action::Admin | Action::Settings)
    }
}

/// The repository a package is linked to, or would be on its first push.
#[derive(Clone, Copy, Debug)]
pub struct LinkedTo<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub private: bool,
}

/// A role given on the package itself.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Grant {
    pub kind: GranteeKind,
    /// The person's or the team's id.
    pub id: String,
    pub role: PackageRole,
}

/// A repository of the package's workspace whose workflow jobs may use it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepoAccess {
    /// Its name in the workspace.
    pub name: String,
    pub role: PackageRole,
}

/// What a decision needs to know about a package, made or not yet.
#[derive(Clone, Copy, Debug)]
pub struct Target<'a> {
    pub workspace: &'a str,
    /// Without the workspace, for messages.
    pub name: &'a str,
    pub repo: Option<LinkedTo<'a>>,
    /// For an unlinked package: whether it is public. A package not made
    /// yet is private.
    pub public: bool,
    /// Whether the package is made: one that is not has no settings yet.
    pub exists: bool,
    /// For a linked package: whether it takes its repository's roles.
    pub inherit: bool,
    pub grants: &'a [Grant],
    pub actions: &'a [RepoAccess],
    /// The teams, by id, among those `grants` name, that the person asking
    /// is in (their child teams' people included).
    pub teams: &'a [String],
}

impl Target<'_> {
    /// Whether anyone may pull it.
    pub fn is_public(&self) -> bool {
        match self.repo {
            Some(repo) => !repo.private,
            None => self.public,
        }
    }

    fn label(&self) -> String {
        format!("{}/{}", self.workspace, self.name)
    }
}

fn from_repo_role(role: RepoRole) -> PackageRole {
    match role {
        RepoRole::Read | RepoRole::Triage => PackageRole::Read,
        RepoRole::Write | RepoRole::Maintain => PackageRole::Write,
        RepoRole::Admin => PackageRole::Admin,
    }
}

/// What a member's membership of the workspace gives on its packages. A
/// fine-grained token's repository selection does not apply: the caller
/// checked its resource owner.
fn workspace_role(user: &User, workspace: &str) -> Option<RepoRole> {
    let mut user = user.clone();
    if let Some(token) = user.token.as_deref_mut() {
        token.fine_grained = None;
    }
    // No repository has an empty id, so only the membership counts.
    access::granted(&user, RepoRef { id: "", namespace: workspace, private: true })
}

/// Whether `user` administers every package of `workspace`: its owners, a
/// service or g1t acting as the workspace, and a workspace token an owner
/// gave Admin.
fn owns(user: &User, workspace: &str) -> bool {
    if !user.is_member(workspace) {
        return false;
    }
    match user.kind {
        PrincipalKind::System => true,
        PrincipalKind::Workspace => user.token.as_deref().is_none_or(|token| token.admin),
        _ => user.role_in(workspace) == Some(Role::Owner),
    }
}

/// Whether a token reaches the package for more than a public pull: a
/// fine-grained one only inside its resource owner and, for a linked
/// package, its repository selection.
fn reaches(token: Option<&TokenAccess>, target: &Target<'_>) -> bool {
    let Some(token) = token else {
        return true;
    };
    match target.repo {
        Some(repo) => token.covers_repo(repo.id, target.workspace),
        None => token.fine_grained.as_ref().is_none_or(|reach| reach.owned_by(target.workspace)),
    }
}

/// `user`'s role on the package, and the rule it comes from. A person (or
/// an agent's run, as the person it works for) only; tokens are checked
/// before.
pub fn role_of(user: &User, target: &Target<'_>) -> (Option<PackageRole>, &'static str) {
    let public = target.is_public().then_some(PackageRole::Read);
    if !reaches(user.token.as_deref(), target) {
        return (public, "public");
    }
    if owns(user, target.workspace) {
        return (Some(PackageRole::Admin), "owner");
    }
    let (base, rule) = match target.repo {
        Some(repo) if target.inherit => (
            access::granted(user, RepoRef { id: repo.id, namespace: target.workspace, private: repo.private }).map(from_repo_role),
            "repository",
        ),
        Some(_) => (None, "package"),
        // A member's base permission reaches Write at most: only owners
        // administer the workspace's packages.
        None => (workspace_role(user, target.workspace).map(|role| from_repo_role(role).min(PackageRole::Write)), "workspace"),
    };
    let granted = if user.kind == PrincipalKind::User {
        target
            .grants
            .iter()
            .filter(|grant| match grant.kind {
                GranteeKind::User => grant.id == user.id,
                GranteeKind::Team => target.teams.contains(&grant.id),
            })
            .map(|grant| grant.role)
            .max()
    } else {
        None
    };
    let role = base.max(granted);
    let rule = if granted.is_some() && granted >= base { "package" } else { rule };
    match (role, public) {
        (None, Some(read)) => (Some(read), "public"),
        (role, public) => (role.max(public), rule),
    }
}

/// A workflow job's token: only the repository the package is linked to,
/// and those listed under its Manage Actions access, reach it.
fn decide_job(token: &TokenAccess, target: &Target<'_>, action: Action) -> Decision {
    let public = target.is_public();
    let job = token.repo.as_deref().unwrap_or_default().to_lowercase();
    let (owner, repo) = job.split_once('/').unwrap_or(("", job.as_str()));
    let label = target.label();
    let role = if !owner.eq_ignore_ascii_case(target.workspace) {
        None
    } else if target.repo.is_some_and(|linked| linked.name.eq_ignore_ascii_case(repo)) {
        Some(PackageRole::Write)
    } else if !target.exists {
        // A new package: the workspace's own, which the job's repository
        // is given access to when it is made, or one that will be linked
        // to another repository, which it may not touch.
        target.repo.is_none().then_some(PackageRole::Write)
    } else {
        target.actions.iter().find(|access| access.name.eq_ignore_ascii_case(repo)).map(|access| access.role)
    };
    let Some(role) = role else {
        if action == Action::Pull && public {
            return Decision::allow("public");
        }
        return Decision::deny(
            "token:repository",
            if owner.eq_ignore_ascii_case(target.workspace) {
                format!(
                    "This token is a workflow job's in {job}, which has no access to the package {label}. An admin of the package can add {job} under the package's settings, in Manage Actions access."
                )
            } else {
                format!("This token is a workflow job's in {job}: it cannot reach the packages of {}.", target.workspace)
            },
        );
    };
    let scoped = scopes::decide_packages(token, action.level(), public);
    if !scoped.allowed {
        return scoped;
    }
    match action {
        _ if action.administers() => Decision::deny(
            "token:job",
            "A workflow job's token cannot delete packages or change their settings.",
        ),
        Action::Push if role < PackageRole::Write => Decision::deny(
            "actions",
            format!("{job} has the Read role on the package {label} in Manage Actions access: an admin of the package can give it Write."),
        ),
        _ => Decision::allow("actions"),
    }
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
        if action.administers() {
            return Decision::deny("agent", "A g1t agent cannot delete packages or change their settings.");
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
        if token.deploy_key.is_some() {
            return if action == Action::Pull && public {
                Decision::allow("public")
            } else {
                Decision::deny("token:deploy_key", "A deploy key reaches its repository's code only, never packages.")
            };
        }
        if token.job.is_some() {
            return decide_job(token, target, action);
        }
        // Any other token held to one repository reaches only that
        // repository's packages, and the workspace's unlinked ones.
        if let Some(repo) = target.repo
            && let Some(refused) = scopes::decide_repo(token, &format!("{}/{}", target.workspace, repo.name))
        {
            return refused;
        }
        let decision = scopes::decide_packages(token, action.level(), public);
        if !decision.allowed {
            return decision;
        }
    }

    if action != Action::Pull && user.kind == PrincipalKind::User && !user.verified {
        return Decision::deny("unverified", "Confirm your email address first. Check your inbox, or resend the link from the banner on g1t.sh.");
    }

    let (role, rule) = role_of(&user, target);
    let needed = action.needs();
    if role >= Some(needed) {
        return Decision::allow(rule);
    }
    if role.is_none() {
        return Decision::deny(rule_for(target), "This package does not exist, or you cannot see it.");
    }
    let reason = match (target.repo, action) {
        (Some(repo), _) if target.inherit && target.exists && !action.administers() => format!(
            "You need the {} role or higher on {}/{} to {} this package, or the role on the package itself.",
            match needed {
                PackageRole::Read => RepoRole::Read.label(),
                PackageRole::Write => RepoRole::Write.label(),
                PackageRole::Admin => RepoRole::Admin.label(),
            },
            target.workspace,
            repo.name,
            action.as_str()
        ),
        (Some(repo), _) if !target.exists => format!(
            "You need the Write role or higher on {}/{} to push this package.",
            target.workspace, repo.name
        ),
        (_, action) if action.administers() => format!(
            "You need the Admin role on the package {} to {} it: an owner of {}, or an admin of the package{}, can give it to you.",
            target.label(),
            action.as_str(),
            target.workspace,
            if target.repo.is_some() && target.inherit { " or its repository" } else { "" }
        ),
        _ => format!("You need the Write role on the package {} to push it.", target.label()),
    };
    Decision::deny(rule_for(target), reason)
}

fn rule_for(target: &Target<'_>) -> &'static str {
    match target.repo {
        Some(_) if target.inherit => "repository",
        Some(_) => "package",
        None => "workspace",
    }
}

/// Every action `viewer` may take, for the site.
pub fn permissions(viewer: Option<&User>, target: &Target<'_>) -> PackagePermissions {
    let may = |action| decide(viewer, target, action).allowed;
    PackagePermissions {
        pull: may(Action::Pull),
        push: may(Action::Push),
        delete: may(Action::Delete),
        admin: may(Action::Admin),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::Membership;
    use g1t_contracts::access::{BasePermission, RepoGrant};
    use g1t_contracts::credentials::{Acting, CredentialUse, GitGrant, Principal, RunBinding, RunCredentialKind};
    use g1t_contracts::scopes::{FineGrainedReach, JobToken, RepositorySelection, Scope, TokenAccess};

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
        Target {
            workspace: "acme",
            name: "web",
            repo: Some(repo),
            public: false,
            exists: true,
            inherit: true,
            grants: &[],
            actions: &[],
            teams: &[],
        }
    }

    fn unlinked(public: bool) -> Target<'static> {
        Target { repo: None, public, ..linked(PRIVATE_REPO) }
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
        assert!(!may(Some(&member), linked(PRIVATE_REPO), Action::Admin));
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
    fn an_unlinked_package_is_the_workspaces_and_its_owners_administer() {
        let member = person(Role::Member, None);
        assert!(may(Some(&member), unlinked(false), Action::Push));
        assert!(!may(Some(&member), unlinked(false), Action::Delete));
        let none = person(Role::Member, Some(BasePermission::None));
        assert!(!may(Some(&none), unlinked(false), Action::Pull));
        let reader = person(Role::Member, Some(BasePermission::Read));
        assert!(may(Some(&reader), unlinked(false), Action::Pull));
        assert!(!may(Some(&reader), unlinked(false), Action::Push));
        assert!(may(Some(&person(Role::Owner, None)), unlinked(false), Action::Delete));
        assert!(may(Some(&person(Role::Owner, None)), unlinked(false), Action::Admin));
        // Even a base permission of Admin does not make a member an owner.
        assert!(!may(Some(&person(Role::Member, Some(BasePermission::Admin))), unlinked(false), Action::Delete));
        let permissions = permissions(Some(&member), &unlinked(false));
        assert_eq!(permissions, PackagePermissions { pull: true, push: true, delete: false, admin: false });
    }

    #[test]
    fn grants_on_the_package_add_to_what_its_repository_gives() {
        let grants = [
            Grant { kind: GranteeKind::User, id: "usr_2".into(), role: PackageRole::Write },
            Grant { kind: GranteeKind::Team, id: "team_ops".into(), role: PackageRole::Admin },
        ];
        let target = Target { grants: &grants, ..linked(PRIVATE_REPO) };
        // An outsider given Write on the package pulls and pushes it.
        assert!(may(Some(&outsider()), target, Action::Pull));
        assert!(may(Some(&outsider()), target, Action::Push));
        assert!(!may(Some(&outsider()), target, Action::Delete));
        assert_eq!(decide(Some(&outsider()), &target, Action::Push).rule, "package");
        // A reader of the repository in a team with Admin on the package.
        let reader = person(Role::Member, Some(BasePermission::Read));
        assert!(!may(Some(&reader), target, Action::Admin), "not in the team");
        let teams = ["team_ops".to_owned()];
        let in_team = Target { teams: &teams, ..target };
        assert!(may(Some(&reader), in_team, Action::Admin));
        assert!(may(Some(&reader), in_team, Action::Delete));
        // A workspace's token is not a person: grants do not apply to it.
        let mut workspace = workspace_token(false);
        workspace.id = "usr_2".into();
        assert!(!may(Some(&workspace), target, Action::Delete));
    }

    #[test]
    fn without_inheriting_only_grants_and_owners_count() {
        let grants = [Grant { kind: GranteeKind::User, id: "usr_2".into(), role: PackageRole::Read }];
        let own = Target { inherit: false, grants: &grants, ..linked(PRIVATE_REPO) };
        let member = person(Role::Member, Some(BasePermission::Write));
        assert!(!may(Some(&member), own, Action::Pull), "the repository's Write no longer counts");
        assert_eq!(decide(Some(&member), &own, Action::Pull).rule, "package");
        assert!(may(Some(&outsider()), own, Action::Pull));
        assert!(!may(Some(&outsider()), own, Action::Push));
        assert!(may(Some(&person(Role::Owner, None)), own, Action::Admin), "owners always administer");
        // A public repository's package still pulls for anyone.
        let public = Target { inherit: false, ..linked(PUBLIC_REPO) };
        assert!(may(None, public, Action::Pull));
        assert!(!may(Some(&member), public, Action::Push));
    }

    fn workspace_token(admin: bool) -> User {
        User {
            id: "wsp_1".into(),
            username: "acme".into(),
            kind: PrincipalKind::Workspace,
            verified: true,
            workspaces: vec![Membership::member("acme")],
            token: Some(Box::new(TokenAccess { admin, ..TokenAccess::full() })),
            ..User::default()
        }
    }

    #[test]
    fn a_workspace_token_is_a_member_with_write_unless_given_admin() {
        let workspace = workspace_token(false);
        assert!(may(Some(&workspace), linked(PRIVATE_REPO), Action::Push));
        assert!(may(Some(&workspace), unlinked(false), Action::Push));
        assert!(!may(Some(&workspace), unlinked(false), Action::Delete));
        assert!(!may(Some(&workspace), linked(PRIVATE_REPO), Action::Admin));
        let admin = workspace_token(true);
        assert!(may(Some(&admin), unlinked(false), Action::Delete));
        assert!(may(Some(&admin), linked(PRIVATE_REPO), Action::Admin));
        let other = Target { workspace: "other", ..unlinked(false) };
        assert!(!may(Some(&admin), other, Action::Pull));
    }

    #[test]
    fn a_tokens_scopes_limit_it_and_old_tokens_keep_working() {
        let with = |scopes: &[Scope]| {
            let mut user = person(Role::Owner, None);
            user.token = Some(Box::new(TokenAccess {
                token_id: "tok_1".into(),
                scopes: Some(scopes.iter().map(|s| s.as_str().to_owned()).collect()),
                ..TokenAccess::default()
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
        assert!(may(Some(&writer), linked(PRIVATE_REPO), Action::Admin), "settings take packages:write and the Admin role");
        assert!(may(Some(&with(&[Scope::PackagesDelete])), linked(PRIVATE_REPO), Action::Delete));
        let mut legacy = person(Role::Owner, None);
        legacy.token = Some(Box::new(TokenAccess { legacy: true, ..TokenAccess::full() }));
        assert!(may(Some(&legacy), linked(PRIVATE_REPO), Action::Delete));
    }

    fn fine_grained(selection: RepositorySelection, ids: &[&str], workspace: Option<&str>) -> User {
        let mut user = person(Role::Owner, None);
        user.token = Some(Box::new(TokenAccess {
            token_id: "tok_fg".into(),
            scopes: Some(vec!["packages:write".into()]),
            fine_grained: Some(FineGrainedReach {
                workspace: workspace.map(str::to_owned),
                repositories: selection,
                repo_ids: ids.iter().map(|id| (*id).to_owned()).collect(),
            }),
            ..TokenAccess::default()
        }));
        user
    }

    #[test]
    fn a_fine_grained_token_reaches_only_its_selection_and_owner() {
        let selected = fine_grained(RepositorySelection::Selected, &["rep_1"], Some("acme"));
        assert!(may(Some(&selected), linked(PRIVATE_REPO), Action::Push));
        let api = LinkedTo { id: "rep_2", name: "api", private: true };
        assert!(!may(Some(&selected), linked(api), Action::Pull), "outside its selection");
        let public_api = LinkedTo { private: false, ..api };
        assert!(may(Some(&selected), linked(public_api), Action::Pull), "a public one still pulls");
        assert!(!may(Some(&selected), linked(public_api), Action::Push));
        // The workspace's unlinked packages go by the resource owner alone.
        assert!(may(Some(&selected), unlinked(false), Action::Push));
        let elsewhere = fine_grained(RepositorySelection::All, &[], Some("other"));
        assert!(!may(Some(&elsewhere), unlinked(false), Action::Pull));
        assert!(may(Some(&elsewhere), unlinked(true), Action::Pull));
        assert!(!may(Some(&elsewhere), linked(PRIVATE_REPO), Action::Pull));
        let own_account = fine_grained(RepositorySelection::All, &[], None);
        assert!(!may(Some(&own_account), unlinked(false), Action::Pull));
        // Grants on the package do not reach past the token's selection.
        let grants = [Grant { kind: GranteeKind::User, id: "usr_1".into(), role: PackageRole::Admin }];
        let granted = Target { grants: &grants, ..linked(api) };
        assert!(!may(Some(&selected), granted, Action::Pull));
    }

    fn job(repo: &str, scopes: &[&str]) -> User {
        let mut user = workspace_token(false);
        user.token = Some(Box::new(TokenAccess {
            token_id: "tok_job".into(),
            scopes: Some(scopes.iter().map(|s| (*s).to_owned()).collect()),
            repo: Some(repo.into()),
            job: Some(JobToken { run_id: "run_1".into(), job_id: "job_1".into(), pull_requests: false }),
            ..TokenAccess::default()
        }));
        user
    }

    #[test]
    fn a_workflow_jobs_token_reaches_its_linked_repositorys_packages() {
        let web = job("acme/web", &["packages:read", "packages:write"]);
        assert!(may(Some(&web), linked(PRIVATE_REPO), Action::Push));
        assert!(!may(Some(&web), linked(PRIVATE_REPO), Action::Delete));
        let api = LinkedTo { id: "rep_2", name: "api", private: true };
        let refused = decide(Some(&web), &linked(api), Action::Pull);
        assert_eq!(refused.rule, "token:repository");
        assert!(refused.reason.unwrap().contains("Manage Actions access"));
        // A public package of another repository still pulls.
        assert!(may(Some(&web), linked(LinkedTo { private: false, ..api }), Action::Pull));
        // Another workspace's private package is out of reach.
        let other = Target { workspace: "other", ..linked(PRIVATE_REPO) };
        assert!(!may(Some(&web), other, Action::Pull));
    }

    #[test]
    fn manage_actions_access_lets_other_repositories_read_or_write() {
        let api = LinkedTo { id: "rep_2", name: "api", private: true };
        let actions = [RepoAccess { name: "web".into(), role: PackageRole::Read }];
        let target = Target { actions: &actions, ..linked(api) };
        let web = job("acme/web", &["packages:read", "packages:write"]);
        assert!(may(Some(&web), target, Action::Pull));
        let refused = decide(Some(&web), &target, Action::Push);
        assert!(!refused.allowed);
        assert!(refused.reason.unwrap().contains("Read role"));
        let writers = [RepoAccess { name: "web".into(), role: PackageRole::Write }];
        assert!(may(Some(&web), Target { actions: &writers, ..linked(api) }, Action::Push));
        // An unlisted repository is refused, an unlinked package's too.
        let docs = job("acme/docs", &["packages:read", "packages:write"]);
        assert!(!may(Some(&docs), target, Action::Pull));
        let shared = Target { actions: &actions, ..unlinked(false) };
        assert!(may(Some(&web), shared, Action::Pull));
        assert!(!may(Some(&docs), shared, Action::Pull));
        // The job's scopes still limit it.
        let reading = job("acme/web", &["packages:read"]);
        assert!(!may(Some(&reading), Target { actions: &writers, ..linked(api) }, Action::Push));
    }

    #[test]
    fn a_job_may_make_a_new_workspace_package_but_not_another_repositorys() {
        let web = job("acme/web", &["packages:write"]);
        let new_unlinked = Target { exists: false, ..unlinked(false) };
        assert!(may(Some(&web), new_unlinked, Action::Push));
        let api = LinkedTo { id: "rep_2", name: "api", private: true };
        let new_api = Target { exists: false, ..linked(api) };
        assert!(!may(Some(&web), new_api, Action::Push));
        let new_web = Target { exists: false, ..linked(PRIVATE_REPO) };
        assert!(may(Some(&web), new_web, Action::Push));
    }

    #[test]
    fn a_deploy_key_never_reaches_packages() {
        let mut key = workspace_token(false);
        key.token = Some(Box::new(TokenAccess { repo: Some("acme/web".into()), deploy_key: Some("key_1".into()), ..TokenAccess::full() }));
        assert!(!may(Some(&key), linked(PRIVATE_REPO), Action::Pull));
        assert!(may(Some(&key), linked(PUBLIC_REPO), Action::Pull));
        assert_eq!(decide(Some(&key), &linked(PRIVATE_REPO), Action::Push).rule, "token:deploy_key");
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
        assert!(!may(Some(&pushing), linked(PRIVATE_REPO), Action::Admin));
        assert!(!may(Some(&pushing), unlinked(false), Action::Push), "only packages of a repository");
        let other = LinkedTo { id: "rep_2", name: "api", private: true };
        assert!(!may(Some(&pushing), linked(other), Action::Push));
        let reading = agent(&[]);
        assert!(may(Some(&reading), linked(PRIVATE_REPO), Action::Pull));
        assert!(!may(Some(&reading), linked(PRIVATE_REPO), Action::Push));
    }
}
