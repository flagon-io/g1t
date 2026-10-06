//! The security service: what g1t finds wrong in a repository, and the
//! upkeep that fixes it without a person.
//!
//! - Secrets. The repos service refuses pushes that add one
//!   (`push_blocked` says which were allowed and records the rest), and
//!   each repository's history is scanned once, in the background.
//!   A push too large to scan first is let through, and its new commits
//!   are scanned after they land (`history::advance_push_scan`).
//! - Alerts are open, dismissed (with a reason, a comment and who) or
//!   fixed, and each keeps an activity log. Likely test values are listed
//!   apart and never block a push or count as critical.
//! - Dependencies. On every push to a default branch, and daily, the
//!   lockfiles are read and every package checked against OSV. Each
//!   vulnerable package with a fix gets a security update: g1t itself
//!   (`User::system`) opens a pull request raising its version, made in a
//!   sandbox (the runner's `bump`), which lands through the branch's
//!   required checks. Only when code has to change is g1t-agent put on an
//!   issue for it.
//!
//! Other services reach it over `POST /rpc/<method>`; see
//! `g1t_contracts::security`.

mod deps;
mod history;
mod security_updates;
mod store;
mod updates;

use g1t_contracts::access::{self, Capability};
use g1t_contracts::events::{Event, WorkspaceRenamed};
use g1t_contracts::security::UPDATE_BRANCH_PREFIX;
use g1t_contracts::repos::{GetArgs, PathByIdArgs, Repo, RepoPath, RepoStatus, StatusByIdArgs};
use g1t_contracts::security::*;
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, User};
use g1t_kit::{args, now_ms, reply, rpc_method};
use serde::Deserialize;
use worker::{Context, Env, Fetcher, MessageBatch, Request, Response, Result, ScheduleContext, ScheduledEvent, event};

use store::{Activity, RepoRow, Store};

/// Repositories whose history is continued per sweep, and pages each.
const HISTORIES_PER_SWEEP: u32 = 5;
const PAGES_PER_SWEEP: u32 = 4;
/// Repositories whose dependencies are read again per sweep.
const DEPENDENCIES_PER_SWEEP: u32 = 10;
const DAY_MS: u64 = 24 * 60 * 60 * 1000;
const MAX_REASON_CHARS: usize = 500;
/// What seeing a repository's findings takes: the Write role, as changing
/// its code does. Dismissing or allowing one takes Admin.
const SEE_FINDINGS: Capability = Capability::Push;

pub struct Security {
    store: Store,
    identity: Fetcher,
    repos: Fetcher,
    work: Fetcher,
    runner: Fetcher,
    billing: Fetcher,
}

fn fail<T>(code: FailureCode, message: impl Into<String>) -> Outcome<T> {
    Outcome::fail(code, message)
}

/// `git.push`, as far as this service reads it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pushed {
    repo_id: String,
    #[serde(default)]
    default_branch: bool,
    #[serde(default, rename = "ref")]
    git_ref: String,
    #[serde(default)]
    before: Option<String>,
    #[serde(default)]
    after: String,
    /// Too large to scan before it was stored.
    #[serde(default)]
    unscanned: bool,
}

/// `pull.merged`, `pull.closed` and `checks.completed`, as far as this
/// service reads them.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PullHappened {
    repo_id: String,
    number: u32,
    #[serde(default)]
    status: Option<String>,
}

/// The longest comment a dismissal keeps.
const MAX_COMMENT_CHARS: usize = MAX_REASON_CHARS;
/// Activity rows the Security page reads, newest first.
const ACTIVITY_SHOWN: u32 = 500;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Created {
    repo_id: String,
}

impl Security {
    fn new(env: &Env) -> Result<Self> {
        Ok(Security {
            store: Store { db: env.d1("DB")? },
            identity: env.service("IDENTITY")?,
            repos: env.service("REPOS")?,
            work: env.service("WORK")?,
            runner: env.service("RUNNER")?,
            billing: env.service("BILLING")?,
        })
    }

    /// The repository at `path`, recorded here, if `viewer` may see its
    /// findings (the Write role) and do `capability`. Findings are for those
    /// who can change the code: to anyone else the page does not exist,
    /// public repository or not.
    async fn member_repo(
        &self,
        path: &RepoPath,
        viewer: &Option<User>,
        capability: Capability,
    ) -> Result<Outcome<RepoRow>> {
        let hidden = || fail(FailureCode::NotFound, "Repository not found.");
        if viewer.is_none() {
            return Ok(hidden());
        }
        let repo: Outcome<Repo> =
            g1t_kit::call(&self.repos, "get", &GetArgs { path: path.clone(), viewer: viewer.clone() }).await?;
        let repo = match repo {
            Outcome::Ok(repo) if repo.fork_of.is_none() => repo,
            _ => return Ok(hidden()),
        };
        if !access::can(viewer.as_ref(), &repo, SEE_FINDINGS) {
            return Ok(hidden());
        }
        if !access::can(viewer.as_ref(), &repo, capability) {
            return Ok(fail(
                FailureCode::Forbidden,
                access::needs(capability, &format!("{}/{}", repo.namespace, repo.name)),
            ));
        }
        Ok(Outcome::Ok(self.store.register(&repo.id, &repo.namespace, &repo.name).await?))
    }

    /// Whether the repository is neither archived nor deleted. When repos
    /// cannot say, it is taken as active.
    async fn active(&self, repo_id: &str) -> Result<bool> {
        let status: Result<RepoStatus> =
            g1t_kit::call(&self.repos, "status_by_id", &StatusByIdArgs { id: repo_id.to_owned() }).await;
        Ok(match status {
            Ok(status) => status.active(),
            Err(error) => {
                worker::console_error!("security: status_by_id {repo_id}: {error}");
                true
            }
        })
    }

    /// Records a repository named in an event, by id. Forks are not
    /// recorded: a pull request's findings belong to its repository.
    async fn register_by_id(&self, repo_id: &str) -> Result<Option<RepoRow>> {
        if let Some(row) = self.store.repo(repo_id).await? {
            return Ok(Some(row));
        }
        let path: Option<RepoPath> = g1t_kit::call(&self.repos, "path_by_id", &PathByIdArgs { id: repo_id.to_owned() }).await?;
        match path {
            Some(path) => Ok(Some(self.store.register(repo_id, &path.namespace, &path.name).await?)),
            None => Ok(None),
        }
    }

    async fn overview(&self, a: OverviewArgs) -> Result<Outcome<SecurityOverview>> {
        let mut repo = match self.member_repo(&a.repo, &a.viewer, SEE_FINDINGS).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        // The first look at a repository reads its dependencies at once;
        // its history is scanned in the background.
        if repo.deps_scanned_at.is_none() {
            self.scan_dependencies(&repo).await?;
            repo = self.store.repo(&repo.repo_id).await?.unwrap_or(repo);
        }
        let (counts, _, _) = self.store.counts(&repo.repo_id).await?;
        Ok(Outcome::Ok(SecurityOverview {
            repo_id: repo.repo_id.clone(),
            counts,
            secret_counts: self.store.secret_counts(&repo.repo_id).await?,
            secrets: self.store.secrets(&repo.repo_id).await?,
            vulnerabilities: self.store.vulnerabilities(&repo.repo_id).await?,
            activity: self.store.activity(&repo.repo_id, ACTIVITY_SHOWN).await?,
            scan: repo.scan_state(),
            upkeep: repo.upkeep != 0,
            version_updates: repo.version_updates(),
        }))
    }

    /// What dismissing or reopening alert `id` takes: Admin for a secret,
    /// whose dismissal lets it through push protection, Write for a
    /// vulnerable dependency.
    fn capability_for(id: &str) -> Capability {
        if id.starts_with("sec_") { Capability::ManageIntegrations } else { SEE_FINDINGS }
    }

    async fn dismiss(&self, a: DismissArgs) -> Result<Outcome<AlertChange>> {
        let repo = match self.member_repo(&a.repo, &Some(a.actor.clone()), Self::capability_for(&a.id)).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if !a.actor.verified {
            return Ok(fail(FailureCode::Forbidden, "Confirm your email address first."));
        }
        let comment: String = a.comment.trim().chars().take(MAX_COMMENT_CHARS).collect();
        let comment = (!comment.is_empty()).then_some(comment);
        if let Some(finding) = self.store.secret(&repo.repo_id, &a.id).await? {
            if !a.reason.for_secrets() {
                return Ok(fail(
                    FailureCode::Invalid,
                    "A secret is dismissed as false_positive, used_in_tests, revoked or wont_fix.",
                ));
            }
            if finding.state != AlertState::Open {
                return Ok(fail(FailureCode::Conflict, "This alert is not open. Reopen it first to dismiss it again."));
            }
            self.store
                .dismiss_secret(&repo.repo_id, &a.id, a.reason, &a.actor.username, comment.as_deref())
                .await?;
            self.store
                .record(&repo.repo_id, &[Activity {
                    alert_id: &a.id,
                    action: "dismissed",
                    actor: Some(&a.actor.username),
                    reason: Some(a.reason),
                    comment: comment.as_deref(),
                    number: None,
                }])
                .await?;
            return Ok(Outcome::Ok(AlertChange { secret: self.store.secret(&repo.repo_id, &a.id).await?, vulnerability: None }));
        }
        let Some(vuln) = self.store.vulnerability(&repo.repo_id, &a.id).await? else {
            return Ok(fail(FailureCode::NotFound, "No such alert."));
        };
        if a.reason.for_secrets() {
            return Ok(fail(
                FailureCode::Invalid,
                "A dependency is dismissed as fix_started, no_bandwidth, tolerable_risk, inaccurate or not_used.",
            ));
        }
        if vuln.state != AlertState::Open {
            return Ok(fail(FailureCode::Conflict, "This alert is not open. Reopen it first to dismiss it again."));
        }
        self.store
            .dismiss_vulnerability(&repo.repo_id, &a.id, a.reason, &a.actor.username, comment.as_deref())
            .await?;
        self.store
            .record(&repo.repo_id, &[Activity {
                alert_id: &a.id,
                action: "dismissed",
                actor: Some(&a.actor.username),
                reason: Some(a.reason),
                comment: comment.as_deref(),
                number: None,
            }])
            .await?;
        Ok(Outcome::Ok(AlertChange { secret: None, vulnerability: self.store.vulnerability(&repo.repo_id, &a.id).await? }))
    }

    async fn reopen(&self, a: ReopenArgs) -> Result<Outcome<AlertChange>> {
        let repo = match self.member_repo(&a.repo, &Some(a.actor.clone()), Self::capability_for(&a.id)).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if !a.actor.verified {
            return Ok(fail(FailureCode::Forbidden, "Confirm your email address first."));
        }
        let reopened = Activity { alert_id: &a.id, action: "reopened", actor: Some(&a.actor.username), reason: None, comment: None, number: None };
        if let Some(finding) = self.store.secret(&repo.repo_id, &a.id).await? {
            if finding.state == AlertState::Open {
                return Ok(fail(FailureCode::Conflict, "This alert is already open."));
            }
            // A secret that never landed has nothing to reopen to but blocked.
            let status = if finding.source == "push" && finding.test_value.is_none() { SecretStatus::Blocked } else { SecretStatus::Open };
            self.store.reopen_secret(&repo.repo_id, &a.id, status).await?;
            self.store.record(&repo.repo_id, &[reopened]).await?;
            return Ok(Outcome::Ok(AlertChange { secret: self.store.secret(&repo.repo_id, &a.id).await?, vulnerability: None }));
        }
        let Some(vuln) = self.store.vulnerability(&repo.repo_id, &a.id).await? else {
            return Ok(fail(FailureCode::NotFound, "No such alert."));
        };
        if vuln.state != AlertState::Dismissed {
            return Ok(fail(FailureCode::Conflict, "Only a dismissed alert can be reopened; a fixed one reopens when it is found again."));
        }
        self.store.reopen_vulnerability(&repo.repo_id, &a.id).await?;
        self.store.record(&repo.repo_id, &[reopened]).await?;
        Ok(Outcome::Ok(AlertChange { secret: None, vulnerability: self.store.vulnerability(&repo.repo_id, &a.id).await? }))
    }

    async fn rescan(&self, a: RescanArgs) -> Result<Outcome<ScanState>> {
        let repo = match self.member_repo(&a.repo, &Some(a.actor.clone()), SEE_FINDINGS).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        self.store.restart_history(&repo.repo_id).await?;
        self.scan_dependencies(&repo).await?;
        if let Some(fresh) = self.store.repo(&repo.repo_id).await? {
            self.advance_history(&fresh, 1).await?;
        }
        let state = self.store.repo(&repo.repo_id).await?.map(|row| row.scan_state()).unwrap_or_default();
        Ok(Outcome::Ok(state))
    }

    async fn set_upkeep(&self, a: SetUpkeepArgs) -> Result<Outcome<bool>> {
        // Whether agents keep its dependencies up to date is one of its
        // settings.
        let repo = match self.member_repo(&a.repo, &Some(a.actor.clone()), Capability::ManageSettings).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if !a.actor.verified {
            return Ok(fail(FailureCode::Forbidden, "Confirm your email address first."));
        }
        self.store.set_upkeep(&repo.repo_id, a.enabled, &a.actor.username).await?;
        Ok(Outcome::Ok(a.enabled))
    }

    async fn workspace(&self, a: WorkspaceArgs) -> Result<Outcome<Vec<RepoSecurity>>> {
        let workspace = a.workspace.to_lowercase();
        if !a.viewer.as_ref().is_some_and(|user| user.is_member(&workspace)) {
            return Ok(fail(FailureCode::NotFound, "Workspace not found."));
        }
        let mut list = Vec::new();
        for repo in self.store.in_namespace(&workspace).await? {
            // Only the repositories whose findings the viewer may see. The
            // Write role is never had through being public, so treating
            // each as private changes nothing.
            let target = access::RepoRef { id: &repo.repo_id, namespace: &workspace, private: true };
            if !access::can(a.viewer.as_ref(), target, SEE_FINDINGS) {
                continue;
            }
            let (counts, secrets, vulnerabilities) = self.store.counts(&repo.repo_id).await?;
            list.push(RepoSecurity {
                repo_id: repo.repo_id,
                name: repo.name,
                counts,
                secrets,
                vulnerabilities,
                upkeep: repo.upkeep != 0,
                dependencies_scanned_at: repo.deps_scanned_at,
            });
        }
        Ok(Outcome::Ok(list))
    }

    /// Push protection's question: which of these secrets were allowed?
    /// The others are recorded as blocked, so someone can allow them.
    async fn push_blocked(&self, a: PushBlockedArgs) -> Result<PushVerdict> {
        self.store.register(&a.repo_id, &a.path.namespace, &a.path.name).await?;
        let fingerprints: Vec<String> = a.secrets.iter().map(|secret| secret.fingerprint.clone()).collect();
        let known = self.store.known(&a.repo_id, &fingerprints).await?;
        let allowed = let_through(&known, &a.secrets);
        let fresh: Vec<NewSecret> = a
            .secrets
            .into_iter()
            .filter(|secret| !known.iter().any(|(fingerprint, _, _)| *fingerprint == secret.fingerprint))
            .collect();
        // A likely test value goes through, so it lands: open, not blocked.
        let (tests, real): (Vec<NewSecret>, Vec<NewSecret>) = fresh.into_iter().partition(|secret| secret.test_value.is_some());
        self.store
            .add_secrets(&a.repo_id, &real, SecretStatus::Blocked, "push", a.pusher.as_deref())
            .await?;
        self.store
            .add_secrets(&a.repo_id, &tests, SecretStatus::Open, "push", a.pusher.as_deref())
            .await?;
        let ids = self
            .store
            .known(&a.repo_id, &fingerprints)
            .await?
            .into_iter()
            .filter(|(fingerprint, _, _)| !allowed.contains(fingerprint))
            .map(|(fingerprint, id, _)| (fingerprint, id))
            .collect();
        Ok(PushVerdict { allowed, ids })
    }

    /// What happens on the bus that concerns this service.
    async fn on_event(&self, event: &Event) -> Result<()> {
        match event.kind.as_str() {
            "git.push" => {
                let Ok(pushed) = serde_json::from_value::<Pushed>(event.data.clone()) else {
                    return Ok(());
                };
                // Too large to scan before it was stored: its new commits
                // are scanned now, on whichever branch.
                if pushed.unscanned
                    && !pushed.after.is_empty()
                    && let Some(repo) = self.register_by_id(&pushed.repo_id).await?
                {
                    let id = self
                        .store
                        .add_push_scan(&repo.repo_id, &pushed.git_ref, &pushed.after, pushed.before.as_deref(), event.actor.as_deref())
                        .await?;
                    self.advance_push_scan(&id, history::PUSH_PAGES_AT_ONCE).await?;
                }
                // A security update's branch, pushed by its sandbox: time for
                // its pull request.
                if let Some(branch) = pushed.git_ref.strip_prefix("refs/heads/")
                    && branch.starts_with(UPDATE_BRANCH_PREFIX)
                {
                    self.update_pushed(&pushed.repo_id, branch).await?;
                    return Ok(());
                }
                if !pushed.default_branch {
                    return Ok(());
                }
                if let Some(repo) = self.register_by_id(&pushed.repo_id).await? {
                    self.scan_dependencies(&repo).await?;
                    if repo.history != "done" {
                        self.advance_history(&repo, 1).await?;
                    }
                }
            }
            "pull.merged" | "pull.closed" | "checks.completed" => {
                if let Ok(happened) = serde_json::from_value::<PullHappened>(event.data.clone()) {
                    self.update_pull_event(
                        &event.kind,
                        &happened.repo_id,
                        happened.number,
                        happened.status.as_deref(),
                        event.actor.as_deref(),
                    )
                    .await?;
                }
            }
            "repo.created" => {
                if let Ok(created) = serde_json::from_value::<Created>(event.data.clone()) {
                    self.register_by_id(&created.repo_id).await?;
                }
            }
            // A repository transferred or renamed: it is recorded under its new path.
            "repo.transferred" | "repo.renamed" => {
                if let Some(moved) = g1t_kit::transfer::read(event) {
                    // Where it is now, so moves heard out of order end in
                    // the same place.
                    let now: Option<g1t_contracts::repos::RepoPath> = g1t_kit::call(
                        &self.repos,
                        "path_by_id",
                        &g1t_contracts::repos::PathByIdArgs { id: moved.repo_id.clone() },
                    )
                    .await?;
                    let current = now.map_or_else(
                        || moved.destination().to_owned(),
                        |path| format!("{}/{}", path.namespace, path.name),
                    );
                    if let Some((namespace, name)) = current.split_once('/') {
                        self.store.moved(&moved.repo_id, namespace, name).await?;
                    }
                }
            }
            // A repository purged: everything found in it goes.
            "repo.purged" => {
                if let Some(g1t_kit::lifecycle::Lifecycle::Purged(purged)) = g1t_kit::lifecycle::read(event) {
                    self.store.purge(&purged.repo_id).await?;
                }
            }
            "workspace.renamed" => {
                if let Ok(renamed) = serde_json::from_value::<WorkspaceRenamed>(event.data.clone()) {
                    self.store.rename_namespace(&renamed.stale_slugs(&renamed.to), &renamed.to).await?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// The sweep: continues history scans and scans of pushes that landed
    /// unscanned, catches security updates whose sandbox never pushed, and
    /// reads dependencies that have not been read for a day.
    async fn sweep(&self) -> Result<()> {
        for scan in self.store.pending_push_scans(HISTORIES_PER_SWEEP).await? {
            if let Err(error) = self.advance_push_scan(&scan.id, PAGES_PER_SWEEP).await {
                worker::console_error!("security: push scan {} not continued: {error}", scan.id);
            }
        }
        if let Err(error) = self.stalled_updates().await {
            worker::console_error!("security: stalled security updates not handled: {error}");
        }
        // Archived and deleted repositories wait; a few more are looked at
        // so that they do not hold up the rest.
        let mut histories = 0;
        for repo in self.store.unfinished_histories(HISTORIES_PER_SWEEP * 4).await? {
            if histories == HISTORIES_PER_SWEEP {
                break;
            }
            if !self.active(&repo.repo_id).await? {
                continue;
            }
            histories += 1;
            if let Err(error) = self.advance_history(&repo, PAGES_PER_SWEEP).await {
                worker::console_error!("security: history of {} not scanned: {error}", repo.repo_id);
            }
        }
        let day_ago = rfc3339(now_ms().saturating_sub(DAY_MS));
        for repo in self.store.stale_dependencies(&day_ago, DEPENDENCIES_PER_SWEEP).await? {
            if !self.active(&repo.repo_id).await? {
                self.store
                    .skip_dependencies(&repo.repo_id, "Dependencies are not checked while the repository is archived or deleted.")
                    .await?;
                continue;
            }
            if let Err(error) = self.scan_dependencies(&repo).await {
                worker::console_error!("security: dependencies of {} not read: {error}", repo.repo_id);
            }
        }
        Ok(())
    }
}

/// The fingerprints a push may carry: those someone dismissed (allowed),
/// and likely test values, which are recorded but never stop a push.
/// `known` is (fingerprint, id, status) of findings already recorded.
fn let_through(known: &[(String, String, String)], secrets: &[NewSecret]) -> Vec<String> {
    let mut allowed: Vec<String> = known
        .iter()
        .filter(|(_, _, status)| status == "allowed")
        .map(|(fingerprint, _, _)| fingerprint.clone())
        .chain(secrets.iter().filter(|secret| secret.test_value.is_some()).map(|secret| secret.fingerprint.clone()))
        .collect();
    allowed.sort();
    allowed.dedup();
    allowed
}

#[event(fetch)]
async fn fetch(mut request: Request, env: Env, _ctx: Context) -> Result<Response> {
    let Some(method) = rpc_method(&request) else {
        return Response::error("Not found", 404);
    };
    let security = Security::new(&env)?;
    let body: serde_json::Value = request.json().await?;
    match method.as_str() {
        "overview" => reply(&security.overview(args(body)?).await?),
        "dismiss" => reply(&security.dismiss(args(body)?).await?),
        "reopen" => reply(&security.reopen(args(body)?).await?),
        "rescan" => reply(&security.rescan(args(body)?).await?),
        "set_upkeep" => reply(&security.set_upkeep(args(body)?).await?),
        "workspace" => reply(&security.workspace(args(body)?).await?),
        "push_blocked" => reply(&security.push_blocked(args(body)?).await?),
        _ => Response::error("Unknown method", 404),
    }
}

#[event(queue)]
async fn queue(batch: MessageBatch<Event>, env: Env, _ctx: Context) -> Result<()> {
    let security = Security::new(&env)?;
    for message in batch.messages()? {
        let event = message.body();
        if let Err(error) = security.on_event(event).await {
            // Scans are idempotent and the sweep catches up, so one failed
            // event is logged rather than retried.
            worker::console_error!("security: {} {} failed: {error}", event.kind, event.id);
        }
    }
    Ok(())
}

#[event(scheduled)]
async fn scheduled(_event: ScheduledEvent, env: Env, _ctx: ScheduleContext) {
    match Security::new(&env) {
        Ok(security) => {
            if let Err(error) = security.sweep().await {
                worker::console_error!("security: the sweep failed: {error}");
            }
        }
        Err(error) => worker::console_error!("security: could not start: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secret(fingerprint: &str, test_value: Option<&str>) -> NewSecret {
        NewSecret {
            fingerprint: fingerprint.into(),
            kind: "aws_access_key".into(),
            path: "a.env".into(),
            line: 1,
            commit: "c".into(),
            preview: "AKIA…".into(),
            test_value: test_value.map(str::to_owned),
        }
    }

    #[test]
    fn dismissed_secrets_and_test_values_go_through() {
        let known = vec![
            ("allowed".to_owned(), "sec_1".to_owned(), "allowed".to_owned()),
            ("resolved".to_owned(), "sec_2".to_owned(), "resolved".to_owned()),
            ("blocked".to_owned(), "sec_3".to_owned(), "blocked".to_owned()),
        ];
        let secrets = [secret("allowed", None), secret("resolved", None), secret("example", Some("it says it is an example")), secret("real", None)];
        assert_eq!(let_through(&known, &secrets), ["allowed", "example"]);
    }

    #[test]
    fn a_push_says_when_it_landed_unscanned() {
        let pushed: Pushed = serde_json::from_value(serde_json::json!({
            "repoId": "rep_1", "ref": "refs/heads/import", "after": "abc", "defaultBranch": false, "unscanned": true
        }))
        .unwrap();
        assert!(pushed.unscanned && pushed.before.is_none() && pushed.git_ref == "refs/heads/import");
        let ordinary: Pushed = serde_json::from_value(serde_json::json!({ "repoId": "rep_1", "ref": "refs/heads/main", "after": "abc", "defaultBranch": true })).unwrap();
        assert!(!ordinary.unscanned);
    }

    #[test]
    fn owners_are_told_what_landed_and_what_to_do() {
        let one = history::landed_secrets_intro("acme", "rocket", "import", 1);
        assert!(one.contains("A push to import in acme/rocket") && one.contains("a secret that looks real") && one.contains("Rotate"));
        assert!(history::landed_secrets_intro("acme", "rocket", "main", 3).contains("3 secrets that look real"));
    }

    #[test]
    fn dismissing_a_secret_takes_admin_and_a_dependency_write() {
        assert_eq!(Security::capability_for("sec_1"), Capability::ManageIntegrations);
        assert_eq!(Security::capability_for("vul_1"), Capability::Push);
    }
}
