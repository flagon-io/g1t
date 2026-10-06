//! Git with a run credential, and git's entries in the audit log.
//!
//! A sandbox's runner clones, fetches and pushes with a credential bound to
//! its run (see `g1t_contracts::credentials`): it may read the repositories
//! its run needs, push only to its pull request's fork or branch, and acts
//! as the person it works for once let through, so the repository's own
//! rules then apply to them too. Every git request a run credential makes
//! is recorded, and so is every push, by anyone.

use g1t_contracts::audit::{AuditActor, AuditTarget, NewAuditEntry, RecordAuditArgs, Surface};
use g1t_contracts::credentials::{Decision, as_person, decide_git, decide_refs, limits_branches};
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
        entry: Option<Box<NewAuditEntry>>,
    },
    Refused(Response),
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
    Response::error(
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
        let run_scope = user
            .acting
            .as_ref()
            .filter(|_| user.kind == PrincipalKind::Agent)
            .map(|acting| acting.scope.clone());
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
            // People and workspace tokens: their pushes are recorded; the
            // repository's own rules decide.
            let pushing = post && write && git.endpoint == "git-receive-pack";
            let entry = if pushing {
                let rule = match user.kind {
                    PrincipalKind::Workspace => "workspace-token",
                    PrincipalKind::Agent => "agent-token",
                    PrincipalKind::User => "person",
                };
                Some(Box::new(entry(
                    self.audit_target_of(&git.path, found).await?,
                    &Decision::allow(rule),
                )))
            } else {
                None
            };
            return Ok(Admitted::Go {
                request,
                viewer,
                entry,
            });
        };

        let mut decision = decide_git(&scope, &git.path, write);
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
            entry: post.then(|| Box::new(entry(target, &decision))),
        })
    }

    /// Records a git request's entry with how it ended: `status` is the
    /// HTTP status git was answered with.
    pub(crate) async fn finish_git(
        &self,
        entry: Option<Box<NewAuditEntry>>,
        status: u16,
        message: Option<String>,
    ) {
        let Some(mut entry) = entry.map(|entry| *entry) else {
            return;
        };
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
