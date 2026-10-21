//! Git with a run credential, and git's entries in the audit log.
//!
//! A sandbox's runner clones, fetches and pushes with a credential bound to
//! its run (see `g1t_contracts::credentials`): it may read the repositories
//! its run needs, push only to its pull request's fork or branch (a
//! session's: its repository and its pull requests' forks), and acts
//! as the person it works for once let through, so the repository's own
//! rules then apply to them too. Every git request a run credential makes
//! is recorded, and so is every push, by anyone.

use g1t_contracts::audit::{AuditActor, AuditTarget, NewAuditEntry, RecordAuditArgs, Surface};
use g1t_contracts::credentials::{Decision, RunCredentialKind, as_person, decide_git_at, decide_refs, limits_branches};
use g1t_contracts::repos::{GitService, Repo, RepoPath};
use g1t_contracts::{PrincipalKind, Viewer};
use worker::js_sys::Uint8Array;
use worker::{Headers, Method, Request, RequestInit, Response, Result, console_error};

use crate::Repos;
use crate::git_http::GitRequest;
use crate::store::GitStore;

/// What became of a git request at the door.
pub enum Admitted {
    /// Go on, as `viewer`, with `request` (rebuilt if its body was read).
    Go {
        request: Request,
        viewer: Viewer,
        /// To be finished with the result and recorded.
        entry: Option<Box<GitEntry>>,
    },
    Refused(Response),
}

/// A git request's audit entry, before its result is known.
pub struct GitEntry {
    pub entry: NewAuditEntry,
    /// Recorded only if the request is refused: git's first request of a
    /// push, which is where a credential that may not push is turned away.
    pub refused_only: bool,
}

/// The rule a push by someone other than a run is recorded under: who
/// pushed, as the repository's own rules then decide.
pub(crate) fn push_rule(user: &g1t_contracts::User) -> &'static str {
    match user.kind {
        PrincipalKind::Workspace if user.token.as_deref().is_some_and(|token| token.deploy_key.is_some()) => "deploy-key",
        PrincipalKind::Workspace => "workspace-token",
        PrincipalKind::Agent => "agent-token",
        PrincipalKind::User => "person",
        PrincipalKind::System => "g1t",
    }
}

/// Whether a request of a push is recorded: the pack (`Some(false)`,
/// always) and git's first request for the refs it may push to
/// (`Some(true)`, only if refused). Fetches by people and workspace
/// tokens are not recorded.
pub(crate) fn push_entry(post: bool, write: bool, endpoint: &str) -> Option<bool> {
    match (write, post) {
        (true, true) if endpoint == "git-receive-pack" => Some(false),
        (true, false) => Some(true),
        _ => None,
    }
}

/// Whether an entry is kept, given the HTTP status git was answered with.
pub(crate) fn kept(refused_only: bool, status: u16) -> bool {
    !refused_only || status >= 400
}

/// The refs a receive-pack request asks to change, deletions included,
/// read from the pkt-lines before the pack.
fn pushed_refs(body: &[u8]) -> Vec<String> {
    let mut refs = Vec::new();
    let mut position = 0;
    while let Some(length) = body
        .get(position..position + 4)
        .and_then(|hex| std::str::from_utf8(hex).ok())
        .and_then(|hex| usize::from_str_radix(hex, 16).ok())
    {
        if length < 4 || position + length > body.len() {
            break;
        }
        let line = &body[position + 4..position + length];
        position += length;
        let command = line.split(|byte| *byte == 0).next().unwrap_or_default();
        let Ok(command) = std::str::from_utf8(command) else {
            continue;
        };
        let mut parts = command.trim_end().splitn(3, ' ');
        if let (Some(_old), Some(_new), Some(name)) = (parts.next(), parts.next(), parts.next()) {
            refs.push(name.to_owned());
        }
    }
    refs
}

/// The same request again, with the body already read.
fn rebuilt(request: &Request, body: &[u8]) -> Result<Request> {
    let headers = Headers::new();
    for (name, value) in request.headers().entries() {
        headers.set(&name, &value)?;
    }
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(Uint8Array::from(body).into()));
    Request::new_with_init(request.url()?.as_str(), &init)
}

fn refusal(decision: &Decision) -> Result<Response> {
    crate::git_ops::plain_refusal(
        decision
            .reason
            .clone()
            .unwrap_or_else(|| "Not allowed.".to_owned()),
        403,
    )
}

impl<S: GitStore> Repos<S> {
    /// Where a git request's entry belongs: the repository a fork came
    /// from, so that a pull request's pushes are in its workspace's log.
    pub(crate) async fn audit_target(&self, path: &RepoPath) -> Result<AuditTarget> {
        let found = self.registry.by_path(path).await?;
        self.audit_target_of(path, found.as_ref()).await
    }

    /// The same, for the repository at `path` as already read (`found`).
    async fn audit_target_of(&self, path: &RepoPath, found: Option<&Repo>) -> Result<AuditTarget> {
        let mut repo = path.clone();
        if let Some(found) = found
            && let Some(source) = found.fork_of.as_deref()
            && let Some(source) = self.registry.by_id(source).await?
        {
            repo = RepoPath {
                namespace: source.namespace,
                name: source.name,
            };
        }
        Ok(AuditTarget {
            workspace: repo.namespace.to_lowercase(),
            repo: Some(format!("{}/{}", repo.namespace, repo.name)),
            ..AuditTarget::default()
        })
    }

    pub(crate) async fn record_git(&self, entry: NewAuditEntry) {
        let recorded: Result<u32> = g1t_kit::call(
            &self.events,
            "audit_record",
            &RecordAuditArgs {
                entries: vec![entry],
            },
        )
        .await;
        if let Err(error) = recorded {
            console_error!("git audit entry not recorded: {error}");
        }
    }

    /// Checks a run credential against its grants before anything else
    /// sees the request, and starts the request's audit entry.
    pub(crate) async fn admit_git(
        &self,
        mut request: Request,
        git: &GitRequest,
        viewer: Viewer,
        found: Option<&Repo>,
    ) -> Result<Admitted> {
        let post = request.method() == Method::Post;
        let write = git.service == GitService::ReceivePack;
        let action = if write { "git.push" } else { "git.fetch" };
        let request_id = request
            .headers()
            .get("cf-ray")?
            .unwrap_or_else(|| g1t_contracts::new_id("req", g1t_kit::now_ms()));
        let Some(user) = viewer.clone() else {
            return Ok(Admitted::Go {
                request,
                viewer,
                entry: None,
            });
        };
        // A run credential carries its scope; whatever kind of principal
        // it resolves as, it is held to that scope.
        let run_scope = user.acting.as_ref().map(|acting| acting.scope.clone());
        let entry = |target: AuditTarget, decision: &Decision| {
            NewAuditEntry::new(
                AuditActor::of(&user),
                action,
                Surface::Git,
                target,
                decision,
                request_id.clone(),
            )
        };

        let Some(scope) = run_scope else {
            // People, workspace tokens and deploy keys: their pushes are
            // recorded, and so is a push refused at its first request; the
            // repository's own rules decide.
            let entry = match push_entry(post, write, git.endpoint) {
                Some(refused_only) => Some(Box::new(GitEntry {
                    entry: entry(self.audit_target_of(&git.path, found).await?, &Decision::allow(push_rule(&user))),
                    refused_only,
                })),
                None => None,
            };
            return Ok(Admitted::Go {
                request,
                viewer,
                entry,
            });
        };

        // A session's credential reaches its repository's pull requests'
        // working copies too, made after it was: by what they copy.
        let source = match found.and_then(|repo| repo.fork_of.as_deref()) {
            Some(source_id) if scope.run.as_ref().is_some_and(|run| run.kind == RunCredentialKind::Session) => self
                .registry
                .by_id(source_id)
                .await?
                .map(|source| RepoPath { namespace: source.namespace, name: source.name }),
            _ => None,
        };
        let mut decision = decide_git_at(&scope, &git.path, source.as_ref(), write);
        let mut refs = Vec::new();
        if decision.allowed && post && write && limits_branches(&scope, &git.path) {
            let body = request.bytes().await?;
            refs = pushed_refs(&body);
            decision = decide_refs(&scope, &git.path, &refs);
            request = rebuilt(&request, &body)?;
        } else if decision.allowed && post && write {
            // A fork is the pull request's own: any branch of it.
            refs.clear();
        }
        let mut target = self.audit_target_of(&git.path, found).await?;
        if !refs.is_empty() {
            target.git_ref = Some(refs.join(" "));
        }
        if !decision.allowed {
            let mut refused = entry(target, &decision);
            refused.result = Some("forbidden".to_owned());
            self.record_git(refused).await;
            return Ok(Admitted::Refused(refusal(&decision)?));
        }
        // Once through, the person it works for, with the run's workspace
        // only: what they may do decides the rest.
        let person = as_person(&user);
        Ok(Admitted::Go {
            request,
            viewer: person,
            // Only the requests that move data are worth a line each.
            entry: post.then(|| Box::new(GitEntry { entry: entry(target, &decision), refused_only: false })),
        })
    }

    /// Records a git request's entry with how it ended: `status` is the
    /// HTTP status git was answered with.
    pub(crate) async fn finish_git(
        &self,
        entry: Option<Box<GitEntry>>,
        status: u16,
        message: Option<String>,
    ) {
        let Some(GitEntry { mut entry, refused_only }) = entry.map(|entry| *entry) else {
            return;
        };
        if !kept(refused_only, status) {
            return;
        }
        if status == 200 {
            entry.result = Some("ok".to_owned());
        } else {
            entry.result = Some(status.to_string());
            if matches!(status, 401 | 403 | 404) {
                entry.outcome = g1t_contracts::audit::AuditOutcome::Denied;
                entry.rule = "repository".to_owned();
            }
            entry.message = message;
        }
        self.record_git(entry).await;
    }
}

#[cfg(test)]
mod audit_tests {
    use super::{kept, push_entry, push_rule};
    use g1t_contracts::User;
    use g1t_contracts::audit::{ActorKind, AuditActor};

    fn workspace_token() -> User {
        serde_json::from_value(serde_json::json!({
            "id": "wsp_flagon",
            "username": "flagon-io",
            "kind": "workspace",
            "token": { "token_id": "tok_publish", "scopes": ["code:read", "code:write"] },
        }))
        .unwrap()
    }

    #[test]
    fn a_workspace_tokens_push_is_the_workspaces_with_its_token() {
        let user = workspace_token();
        let actor = AuditActor::of(&user);
        assert_eq!(actor.actor_kind, Some(ActorKind::Workspace));
        assert_eq!((actor.actor.as_str(), actor.actor_id.as_str()), ("flagon-io", "wsp_flagon"));
        assert_eq!(actor.credential_id.as_deref(), Some("tok_publish"));
        assert_eq!(actor.on_behalf_of, None);
        assert_eq!(push_rule(&user), "workspace-token");
    }

    #[test]
    fn a_deploy_key_is_told_apart_from_a_workspace_token() {
        let key = g1t_contracts::deploy_keys::principal(
            "wsp_acme",
            "acme",
            g1t_contracts::deploy_keys::access("dk_1", "CI", "acme/rocket", false),
        );
        assert_eq!(push_rule(&key), "deploy-key");
        assert_eq!(AuditActor::of(&key).credential_id.as_deref(), Some("dk_1"));
    }

    #[test]
    fn a_push_is_recorded_and_so_is_one_refused_at_its_first_request() {
        // The pack: always.
        assert_eq!(push_entry(true, true, "git-receive-pack"), Some(false));
        // git's first request for the refs it may push to: if refused.
        assert_eq!(push_entry(false, true, "info/refs"), Some(true));
        assert!(kept(true, 404) && kept(true, 403) && kept(true, 401));
        assert!(!kept(true, 200), "an allowed push is recorded once, with its pack");
        assert!(kept(false, 200));
        // Fetches are not recorded.
        assert_eq!(push_entry(false, false, "info/refs"), None);
        assert_eq!(push_entry(true, false, "git-upload-pack"), None);
    }
}

#[cfg(test)]
mod tests {
    use super::pushed_refs;

    fn pkt(payload: &str) -> Vec<u8> {
        format!("{:04x}{payload}", payload.len() + 4).into_bytes()
    }

    #[test]
    fn every_ref_a_push_names_is_read() {
        let old = "c71546fcd893ef8b0f57388b65e620d759705dda";
        let new = "4807077b296e6edbf410d55e72749d3e1170c291";
        let zero = "0000000000000000000000000000000000000000";
        let body = [
            pkt(&format!(
                "{old} {new} refs/heads/fix\0 report-status side-band-64k\n"
            )),
            pkt(&format!("{old} {zero} refs/heads/main\n")),
            pkt(&format!("{zero} {new} refs/tags/v1\n")),
            b"0000".to_vec(),
            b"PACK\0\0\0\x02".to_vec(),
        ]
        .concat();
        assert_eq!(
            pushed_refs(&body),
            ["refs/heads/fix", "refs/heads/main", "refs/tags/v1"]
        );
        assert!(pushed_refs(b"0000").is_empty());
    }
}
