//! Deploy keys: SSH keys that reach one repository, for a server or a
//! pipeline that needs that repository and nothing else.
//!
//! A deploy key is read-only unless whoever adds it allows write access.
//! It belongs to the repository, not to a person: it keeps working when the
//! person who added it leaves, and it never reaches another repository.
//! Identity keeps them beside people's SSH keys; a public key is registered
//! once across both, so a key always means one thing.
//!
//! Over SSH a deploy key resolves (identity's `principal_for_ssh_key`) to
//! the repository's workspace acting through a token that reaches that one
//! repository, with `code:read`, and `code:write` and `workflow_files:write`
//! when it may write. Git's checks then need nothing of their own: the
//! token's `repo` refuses every other repository (`scopes::decide_repo`),
//! and its scopes refuse a push from a read-only key (`scopes::decide_git`).
//!
//! Methods of the identity service, served at `POST /rpc/<method>`:
//!
//! - `list_deploy_keys` takes [`DeployKeysArgs`], returns `Outcome<Vec<DeployKey>>`.
//! - `get_deploy_key` takes [`DeployKeyArgs`], returns `Outcome<DeployKey>`.
//! - `add_deploy_key` takes [`AddDeployKeyArgs`], returns `Outcome<DeployKey>`.
//! - `remove_deploy_key` takes [`RemoveDeployKeyArgs`], returns `Outcome<bool>`.
//! - `principal_for_ssh_key` takes [`SshKeyArgs`], returns `Viewer`: the
//!   person who registered the key, or what a deploy key resolves to.
//!
//! Every one of them answers in `snake_case`, as the API does.

use serde::{Deserialize, Serialize};

use crate::access::{Capability, RepoRef, can};
use crate::audit::Surface;
use crate::repos::RepoPath;
use crate::scopes::{Scope, TokenAccess};
use crate::{PrincipalKind, User, Viewer};

/// The most deploy keys one repository may have.
pub const MAX_PER_REPO: usize = 100;

/// The answer when a public key is registered already, as anyone's SSH key
/// or as a deploy key anywhere.
pub const KEY_IN_USE: &str = "Key is already in use.";

/// One deploy key, as the API shows it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeployKey {
    /// `dk_…`.
    pub id: String,
    pub title: String,
    /// The public key, `<type> <base64>`, without its comment.
    pub key: String,
    /// `SHA256:…`, as `ssh-keygen -lf` prints it.
    pub fingerprint: String,
    /// False when it may push.
    pub read_only: bool,
    /// RFC 3339.
    pub created_at: String,
    /// The username (or workspace slug, for a workspace's token) that
    /// added it; null once that account is gone.
    #[serde(default)]
    pub created_by: Option<String>,
    /// RFC 3339; null when it was never used. Kept to within 5 minutes.
    #[serde(default)]
    pub last_used_at: Option<String>,
}

/// `list_deploy_keys`.
#[derive(Debug, Serialize, Deserialize)]
pub struct DeployKeysArgs {
    pub viewer: Viewer,
    pub path: RepoPath,
}

/// `get_deploy_key`.
#[derive(Debug, Serialize, Deserialize)]
pub struct DeployKeyArgs {
    pub viewer: Viewer,
    pub path: RepoPath,
    pub id: String,
}

/// `add_deploy_key`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AddDeployKeyArgs {
    pub actor: User,
    pub path: RepoPath,
    /// Empty takes the key's comment, else "Deploy key".
    #[serde(default)]
    pub title: String,
    /// One line in OpenSSH public key format.
    pub key: String,
    /// Read-only unless said otherwise.
    #[serde(default = "read_only_by_default")]
    pub read_only: bool,
    #[serde(default)]
    pub surface: Option<Surface>,
}

fn read_only_by_default() -> bool {
    true
}

/// `principal_for_ssh_key`: who an SSH client signing in with the key
/// with this fingerprint (`SHA256:…`) is.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct SshKeyArgs {
    pub fingerprint: String,
    /// True once the client has proved it holds the private key: only then
    /// is the key's last use recorded. False while a client only offers a
    /// key, which anyone holding the public key can do.
    #[serde(default)]
    pub used: bool,
}

/// `remove_deploy_key`.
#[derive(Debug, Serialize, Deserialize)]
pub struct RemoveDeployKeyArgs {
    pub actor: User,
    pub path: RepoPath,
    pub id: String,
    #[serde(default)]
    pub surface: Option<Surface>,
}

/// The scopes a deploy key's token carries.
pub fn scopes(read_only: bool) -> Vec<String> {
    let mut scopes = vec![Scope::RepoRead, Scope::CodeRead];
    if !read_only {
        // As on GitHub, a key that may push may change workflow files too.
        scopes.extend([Scope::CodeWrite, Scope::WorkflowFilesWrite]);
    }
    scopes.into_iter().map(|scope| scope.as_str().to_owned()).collect()
}

/// What a deploy key acts with: a token of its repository's workspace that
/// reaches `repo` (`owner/name`, where it is now) and nothing else.
pub fn access(id: &str, title: &str, repo: &str, read_only: bool) -> TokenAccess {
    TokenAccess {
        token_id: id.to_owned(),
        name: Some(title.to_owned()),
        scopes: Some(scopes(read_only)),
        repo: Some(repo.to_owned()),
        deploy_key: Some(id.to_owned()),
        ..TokenAccess::default()
    }
}

/// The principal a deploy key resolves to: `workspace` (its id and slug
/// now) acting through [`access`].
pub fn principal(workspace_id: &str, workspace_slug: &str, token: TokenAccess) -> User {
    User {
        id: workspace_id.to_owned(),
        username: workspace_slug.to_owned(),
        kind: PrincipalKind::Workspace,
        verified: true,
        workspaces: vec![crate::Membership::member(workspace_slug.to_lowercase())],
        token: Some(Box::new(token)),
        ..User::default()
    }
}

/// Whether `actor` may add and remove a repository's deploy keys, and see
/// them: the Admin role on it (`Capability::ManageAccess`). Never a deploy
/// key, and never an agent, whatever it acts for; a workspace's token only
/// when an owner gave it Admin. `None` when they may, else why not.
pub fn refusal(actor: Option<&User>, repo: RepoRef<'_>, full_name: &str) -> Option<String> {
    let Some(actor) = actor else {
        return Some("Sign in to manage deploy keys.".to_owned());
    };
    if actor.token.as_deref().is_some_and(|token| token.deploy_key.is_some()) {
        return Some("A deploy key cannot manage deploy keys.".to_owned());
    }
    if actor.kind == PrincipalKind::Agent || actor.acting.is_some() {
        return Some("An agent cannot manage deploy keys: they decide who reaches a repository.".to_owned());
    }
    if !can(Some(actor), repo, Capability::ManageAccess) {
        return Some(crate::access::needs(Capability::ManageAccess, full_name));
    }
    None
}

/// Whether a last-used time `last` (RFC 3339) is old enough at `now`
/// (`rfc3339` too) to be written again: once every 5 minutes at most, as
/// access tokens' are, so a busy key does not write on every fetch.
pub fn note_use_due(last: Option<&str>, stale_before: &str) -> bool {
    last.is_none_or(|at| at < stale_before)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::access::{BasePermission, RepoGrant, RepoRole};
    use crate::scopes::{decide_git, decide_repo};
    use crate::{Membership, Role};

    fn repo() -> RepoRef<'static> {
        RepoRef { id: "rep_web", namespace: "acme", private: true }
    }

    fn key(read_only: bool) -> User {
        principal("wsp_acme", "acme", access("dk_1", "CI", "acme/web", read_only))
    }

    #[test]
    fn a_read_only_key_reads_its_repository_and_pushes_nowhere() {
        let user = key(true);
        let token = user.token.as_deref().unwrap();
        assert!(decide_repo(token, "acme/web").is_none());
        assert!(decide_git(token, false, false).allowed, "clones a private repository");
        assert!(!decide_git(token, true, false).allowed, "never pushes");
        assert!(can(Some(&user), repo(), Capability::Read));
    }

    #[test]
    fn a_key_with_write_access_pushes_and_may_change_workflow_files() {
        let user = key(false);
        let token = user.token.as_deref().unwrap();
        assert!(decide_git(token, true, false).allowed);
        assert!(crate::scopes::decide_workflow_files(Some(token), [".g1t/workflows/ci.yml"]).is_none());
        assert!(can(Some(&user), repo(), Capability::Push));
        // Write, never more: settings and access stay with people.
        assert!(!can(Some(&user), repo(), Capability::ManageSettings));
        let read_only = key(true);
        assert!(crate::scopes::decide_workflow_files(read_only.token.as_deref(), [".g1t/workflows/ci.yml"]).is_some());
    }

    #[test]
    fn a_key_reaches_no_other_repository() {
        let user = key(false);
        let token = user.token.as_deref().unwrap();
        for other in ["acme/api", "other/web", "acme/web-2"] {
            let refused = decide_repo(token, other).expect(other);
            assert!(!refused.allowed);
            assert!(refused.reason.unwrap().contains("deploy key"), "{other}");
        }
        // Names compare without case, as paths do.
        assert!(decide_repo(token, "Acme/Web").is_none());
    }

    #[test]
    fn its_scopes_are_code_and_nothing_else() {
        assert_eq!(scopes(true), ["repo:read", "code:read"]);
        assert_eq!(scopes(false), ["repo:read", "code:read", "code:write", "workflow_files:write"]);
        let token = access("dk_1", "CI", "acme/web", true);
        assert_eq!(token.deploy_key.as_deref(), Some("dk_1"));
        assert!(!token.admin);
        assert!(!token.allows(Scope::IssuesWrite));
        assert!(!token.allows(Scope::AccessAdmin));
    }

    #[test]
    fn only_admins_manage_deploy_keys() {
        let person = |role: Option<RepoRole>, base: Option<BasePermission>| User {
            id: "usr_ada".into(),
            username: "ada".into(),
            verified: true,
            workspaces: vec![Membership { base_permission: base, ..Membership::member("acme") }],
            grants: role
                .map(|role| vec![RepoGrant { repo_id: "rep_web".into(), workspace: "acme".into(), role, team: None }])
                .unwrap_or_default(),
            ..User::default()
        };
        assert!(refusal(Some(&person(Some(RepoRole::Admin), None)), repo(), "acme/web").is_none());
        let writer = person(None, Some(BasePermission::Write));
        assert!(refusal(Some(&writer), repo(), "acme/web").unwrap().contains("Admin"));
        assert!(refusal(Some(&person(Some(RepoRole::Maintain), None)), repo(), "acme/web").is_some());
        assert!(refusal(None, repo(), "acme/web").is_some());
        let owner = User {
            workspaces: vec![Membership { role: Role::Owner, ..Membership::member("acme") }],
            ..person(None, None)
        };
        assert!(refusal(Some(&owner), repo(), "acme/web").is_none());
    }

    #[test]
    fn tokens_agents_and_keys_do_not_manage_deploy_keys() {
        // A workspace's own token: Write unless an owner gave it Admin.
        let workspace = |admin: bool| User {
            token: Some(Box::new(TokenAccess { admin, ..TokenAccess::default() })),
            ..principal("wsp_acme", "acme", TokenAccess::default())
        };
        assert!(refusal(Some(&workspace(false)), repo(), "acme/web").is_some());
        assert!(refusal(Some(&workspace(true)), repo(), "acme/web").is_none());
        // A deploy key, even one that may push.
        assert_eq!(refusal(Some(&key(false)), repo(), "acme/web").unwrap(), "A deploy key cannot manage deploy keys.");
        // An agent.
        let agent = User { kind: PrincipalKind::Agent, ..User::system("acme") };
        assert!(refusal(Some(&agent), repo(), "acme/web").unwrap().contains("agent"));
    }

    #[test]
    fn reading_deploy_keys_needs_access_read_and_changing_them_access_admin() {
        use crate::scopes::scope_for;
        assert_eq!(scope_for("list_deploy_keys"), Some(Scope::AccessRead));
        assert_eq!(scope_for("get_deploy_key"), Some(Scope::AccessRead));
        assert_eq!(scope_for("create_deploy_key"), Some(Scope::AccessAdmin));
        assert_eq!(scope_for("delete_deploy_key"), Some(Scope::AccessAdmin));
        for operation in ["list_deploy_keys", "get_deploy_key", "create_deploy_key", "delete_deploy_key"] {
            assert!(crate::credentials::NEVER.contains(&operation), "no agent run manages {operation}");
        }
    }

    #[test]
    fn last_used_is_written_at_most_every_five_minutes() {
        let stale_before = "2026-10-08T11:55:00.000Z";
        assert!(note_use_due(None, stale_before), "never used");
        assert!(note_use_due(Some("2026-10-08T11:00:00.000Z"), stale_before));
        assert!(!note_use_due(Some("2026-10-08T11:58:00.000Z"), stale_before));
        assert!(!note_use_due(Some(stale_before), stale_before));
    }

    #[test]
    fn a_deploy_key_travels_in_snake_case() {
        let shown = serde_json::to_value(DeployKey { read_only: true, ..DeployKey::default() }).unwrap();
        for field in ["id", "title", "key", "fingerprint", "read_only", "created_at", "created_by", "last_used_at"] {
            assert!(shown.get(field).is_some(), "{field}");
        }
        let args: AddDeployKeyArgs = serde_json::from_value(serde_json::json!({
            "actor": { "id": "usr_ada", "username": "ada" },
            "path": { "namespace": "acme", "name": "web" },
            "key": "ssh-ed25519 AAAA",
        }))
        .unwrap();
        assert!(args.read_only, "read-only unless said otherwise");
    }
}
