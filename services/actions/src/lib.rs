//! The actions service: a repository's GitHub Actions workflows, run on
//! g1t as they are. See `g1t_contracts::actions` for the methods and
//! `g1t_actions` for how workflows, expressions and filters are read.
//!
//! - [`sync`] reads workflow files, at the default branch for the list and
//!   at an event's own commit for its runs.
//! - [`trigger`] turns events, schedules and manual runs into runs.
//! - [`plan`] moves a run's jobs along: each waits for the jobs it needs,
//!   is skipped or expanded into its matrix, queued, started in a sandbox
//!   when the workspace has room, and finished by the sandbox's report.
//! - [`payload`] builds the webhook-shaped `github.event`.
//! - [`settings`] keeps secrets and variables, and [`broker`] the stand-ins
//!   jobs are given for brokered secrets.
//! - [`protection`] keeps a repository's workflow settings and its
//!   environments' protection rules, holds jobs at those rules until they
//!   pass, and lets pull requests' runs from outside wait for approval.
//! - [`cache`] lists `actions/cache` entries, which the API keeps in R2.
//! - [`reach`] finds the actions and reusable workflows of other
//!   repositories on g1t, and [`registry`] resolves those from GitHub to
//!   commits and keeps their archives, for jobs to download from g1t.
//! - [`runners`] keeps self-hosted runners, hands them jobs (and agent
//!   work from the runner service) when they ask, and hears back.
//!
//! The service acts as the repository's workspace: it reads what the
//! workspace can read, and a job's `GITHUB_TOKEN` is a token of the
//! workspace's that reaches the job's repository only, with the scopes its
//! `permissions:` give it, revoked when the job ends.

mod run_artifacts;
mod broker;
mod cache;
mod limits;
mod managed;
mod payload;
mod plan;
mod protection;
mod reach;
mod registry;
mod rename;
mod retention;
pub mod runtime;
mod runners;
mod settings;
mod sync;
mod trigger;
mod views;

use g1t_contracts::access::{self, Capability};
use g1t_contracts::events::Event;
use g1t_contracts::identity::{SlugArgs, Workspace};
use g1t_contracts::repos::{GetArgs, GetByIdArgs, Repo, RepoPath};
use g1t_contracts::{FailureCode, Membership, Outcome, PrincipalKind, User, Viewer};
use g1t_kit::{args, reply, rpc_method};
use g1t_secrets::Sealer;
use serde::Deserialize;
use serde_json::Value;
use worker::wasm_bindgen::JsValue;
use worker::{
    Context, D1Database, Env, Fetcher, MessageBatch, MessageExt, QueueRetryOptionsBuilder, Request, Response, Result, ScheduleContext,
    ScheduledEvent, event,
};

/// The most workflow files read from a repository.
pub const MAX_WORKFLOWS: usize = 50;
/// Jobs on g1t's own machines one workspace may always have running at
/// once; the rest wait their turn, unless the pool has room (`has_room`).
pub const RUNNING_PER_WORKSPACE: u32 = 4;
/// The most one workspace may run at once while the pool has room to spare.
pub const BURST_PER_WORKSPACE: u32 = 12;
/// Sandboxes g1t's own machines have between them (services/runner's
/// wrangler.jsonc: 50 standard, which `ubuntu-latest` runs on in a private
/// repository, 30 4-core, which it runs on in a public one, and 10
/// `ubuntu-slim`).
pub const HOSTED_POOL: u32 = 90;
/// Kept free while workspaces run past their share, so another workspace's
/// first jobs still start at once.
pub const POOL_HEADROOM: u32 = 8;

/// Whether a workspace running `in_workspace` jobs on g1t's machines may
/// start another while `in_pool` run across every workspace: always within
/// its share, and past it, up to the burst, while the pool keeps its
/// headroom.
pub fn has_room(in_workspace: u32, in_pool: u32) -> bool {
    in_workspace < RUNNING_PER_WORKSPACE
        || (in_workspace < BURST_PER_WORKSPACE && in_pool + POOL_HEADROOM < HOSTED_POOL)
}

/// How long a job waits for a machine when the runner has none for it
/// (every sandbox of its class taken, or a rollout replacing them) before it
/// fails saying so. Tried again within seconds (MACHINE_RETRY_MS), then each
/// minute until then.
pub const WAIT_FOR_MACHINE_MS: u64 = 30 * 60 * 1000;

/// The pauses before a job refused for want of a machine is tried again,
/// after a request or the minute's sweep: refusals come in bursts that end
/// within seconds, and the next sweep left such a job waiting a median
/// 13.5 s and p90 120 s (#292). Together well under the 30 s a request's
/// `wait_until` may run after its answer.
pub const MACHINE_RETRY_MS: [u64; 3] = [2_000, 5_000, 10_000];

/// How long a job on g1t's machines has to say anything after it starts.
/// Its runner reports its first step within seconds (6 to 12 on Deploy
/// #445); one that has said nothing by now never got a sandbox, so it is
/// tried again rather than left until SILENT_MS fails it. On 2026-10-20
/// two jobs of Deploy #443 were started from the request of a job that
/// reported its end: no container was free, the library's retries took
/// longer than that job's container stayed connected, and the start was
/// cancelled with the request, after the jobs were marked as running.
pub const FIRST_REPORT_MS: u64 = 3 * 60 * 1000;

/// Whether a job that started at `started` and was last heard from at
/// `seen` (RFC 3339, both set as it starts) never reported, and is past
/// FIRST_REPORT_MS at `now`. Every report moves `seen` on.
pub fn never_reported(started: Option<&str>, seen: Option<&str>, now: u64) -> bool {
    match (started, seen) {
        (Some(started), Some(seen)) if started == seen => {
            g1t_contracts::time::parse_rfc3339(started).is_some_and(|started| now.saturating_sub(started) >= FIRST_REPORT_MS)
        }
        _ => false,
    }
}

/// Whether a job that has waited for a machine since `since` (RFC 3339)
/// should stop waiting at `now`. One whose start cannot be read waits from
/// now on.
pub fn waited_for_a_machine(since: Option<&str>, now: u64) -> bool {
    since
        .and_then(g1t_contracts::time::parse_rfc3339)
        .is_some_and(|since| now.saturating_sub(since) >= WAIT_FOR_MACHINE_MS)
}
/// The longest a job on g1t's own machines may run, whatever its
/// `timeout-minutes`.
pub const MAX_TIMEOUT_MINUTES: u32 = g1t_actions::workflow::HOSTED_MAX_TIMEOUT_MINUTES;
/// The longest a job on a self-hosted runner may run: the machine is the
/// workspace's own, and its time costs nothing.
pub const SELF_HOSTED_MAX_TIMEOUT_MINUTES: u32 = 24 * 60;
/// A running job that has said nothing for this long is taken as lost.
pub const SILENT_MS: u64 = 10 * 60 * 1000;

/// Whether a job on g1t's machines that went silent after it reported runs
/// again on another machine rather than failing. Its machine was stopped
/// under it, not by it: on 2026-10-23 three Self-host shards died within two
/// seconds of another g1t-4core job finishing (#426). Once only, so a job
/// that kills its own machine still fails; never one being cancelled; and
/// never one that deploys to an environment, which may have got halfway.
pub fn runs_again_when_lost(machine_lost: u32, environment: Option<&str>, cancelling: bool) -> bool {
    machine_lost == 0 && environment.is_none_or(str::is_empty) && !cancelling
}

/// Why a job that lost its machine went back in the queue: the step it was
/// on (the one running, else the one that failed, else the last done), from
/// its `steps` as reported, and the container instance it ran on, from its
/// log's "Set up job" (`Instance: …`), when they are known. `stopped`: its
/// runner said a step was stopped by a SIGTERM it did not send, rather
/// than going silent.
pub fn lost_machine_reason(steps: &str, log_head: Option<&str>, stopped: bool) -> String {
    let steps: Vec<serde_json::Value> = serde_json::from_str(steps).unwrap_or_default();
    let last = |pick: &dyn Fn(&serde_json::Value) -> bool| steps.iter().rev().find(|step| pick(step));
    let step = last(&|step| step["status"] == "in_progress")
        .or_else(|| last(&|step| step["conclusion"] == "failure"))
        .or_else(|| last(&|step| step["status"] == "completed"))
        .and_then(|step| step["name"].as_str())
        .filter(|name| !name.is_empty());
    let instance = log_head.and_then(|text| {
        text.lines().find_map(|line| line.split_once("Instance: ").map(|(_, id)| id.trim())).filter(|id| !id.is_empty())
    });
    let mut reason = if stopped { "Its machine was stopped" } else { "Its machine stopped answering" }.to_owned();
    if let Some(step) = step {
        reason.push_str(&format!(" in \"{step}\""));
    }
    if let Some(instance) = instance {
        reason.push_str(&format!(" (instance {instance})"));
    }
    reason.push_str("; it runs again on another machine.");
    reason
}
/// Schedules pause in a repository that has had no push for this long; the
/// next push resumes them.
pub const SCHEDULE_IDLE_MS: u64 = 60 * 24 * 60 * 60 * 1000;
/// How long a workflow's schedule waits after billing refused to start a
/// job of one of its scheduled runs, before it tries again.
pub const SCHEDULE_REFUSED_MS: u64 = 60 * 60 * 1000;
pub const SITE: &str = "https://g1t.sh";
pub const API: &str = "https://api.g1t.sh";

#[derive(Deserialize)]
struct Count {
    n: u32,
}

pub fn optional(value: Option<&str>) -> JsValue {
    value.map_or(JsValue::NULL, JsValue::from)
}

pub fn fail<T>(code: FailureCode, message: impl Into<String>) -> Outcome<T> {
    Outcome::fail(code, message)
}

/// `owner/name` as a path.
pub fn repo_path(full_name: &str) -> RepoPath {
    let (namespace, name) = full_name.split_once('/').unwrap_or((full_name, ""));
    RepoPath {
        namespace: namespace.to_owned(),
        name: name.to_owned(),
    }
}

pub struct Actions {
    db: D1Database,
    repos: Fetcher,
    work: Fetcher,
    identity: Fetcher,
    runner: Fetcher,
    events: Fetcher,
    /// Projects: a repository's secrets and variables belong to its project.
    projects: Fetcher,
    /// Billing: self-hosted runners' time, recorded at $0, and the
    /// cache's storage.
    billing: Fetcher,
    /// Deployments: a job with an `environment:` deploys to it, and its
    /// run's deployment is recorded there (plan.rs `report_deployment`).
    deployments: Fetcher,
    /// Notify, optional: pages open on a repository hear its runs' jobs
    /// start and finish (plan.rs `tell_live`). Without it they catch up
    /// on their own.
    notify: Option<Fetcher>,
    /// Where the API keeps cache entries, for deleting evicted ones.
    cache: Option<worker::Bucket>,
    /// Seals secrets; absent until `ACTIONS_KEY` is set, when secrets
    /// cannot be saved.
    sealer: Option<Sealer>,
    /// Signs the toolkit's blob links (runtime.rs), from `ACTIONS_KEY`.
    blob_key: Option<String>,
    /// Log retention and free workspaces' caps, from wrangler vars (limits.rs).
    limits: limits::Limits,
    /// Whether repositories' Actions are on, read once per request.
    actions_on: protection::ActionsOn,
    /// In a request, queued jobs are not started inline: whoever made the
    /// request may be gone before a sandbox starts, which can take seconds
    /// while Cloudflare has no container free, and the start would be
    /// cancelled with it, after the jobs were marked as running. They are
    /// started after the answer instead (`fetch`, `wait_until`).
    defer_starts: bool,
    /// Whether this request queued jobs or freed room for them.
    starts_wanted: std::cell::Cell<bool>,
}

impl Actions {
    fn new(env: &Env) -> Result<Self> {
        Ok(Actions {
            db: env.d1("DB")?,
            repos: env.service("REPOS")?,
            work: env.service("WORK")?,
            identity: env.service("IDENTITY")?,
            runner: env.service("RUNNER")?,
            events: env.service("EVENTS")?,
            projects: env.service("PROJECTS")?,
            billing: env.service("BILLING")?,
            deployments: env.service("DEPLOYMENTS")?,
            notify: env.service("NOTIFY").ok(),
            cache: env.bucket("ACTIONS_CACHE").ok(),
            sealer: env.secret("ACTIONS_KEY").ok().and_then(|key| Sealer::new(&key.to_string())),
            blob_key: env.secret("ACTIONS_KEY").ok().map(|key| runtime::blob_key(&key.to_string())),
            limits: limits::Limits::from_env(env),
            actions_on: protection::ActionsOn::default(),
            defer_starts: false,
            starts_wanted: std::cell::Cell::new(false),
        })
    }

    /// The workspace itself, as the service acts.
    async fn workspace_actor(&self, slug: &str) -> Result<Option<User>> {
        let workspace: Option<Workspace> = g1t_kit::call(&self.identity, "get_workspace", &SlugArgs { slug: slug.to_owned() }).await?;
        Ok(workspace.map(|workspace| User {
            id: workspace.id,
            username: workspace.slug.clone(),
            kind: PrincipalKind::Workspace,
            verified: true,
            workspaces: vec![Membership::member(workspace.slug)],
            ..User::default()
        }))
    }

    /// The repository, if the viewer may see it and it is not a pull
    /// request's working copy.
    async fn visible_repo(&self, path: &RepoPath, viewer: &Viewer) -> Result<Option<Repo>> {
        let found: Outcome<Repo> = g1t_kit::call(
            &self.repos,
            "get",
            &GetArgs {
                path: path.clone(),
                viewer: viewer.clone(),
            },
        )
        .await?;
        Ok(found.into_result().ok().filter(|repo| repo.fork_of.is_none()))
    }

    /// A repository by id, as its workspace sees it.
    async fn repo_by_id(&self, id: &str) -> Result<Option<(Repo, User)>> {
        let path: Option<RepoPath> = g1t_kit::call(&self.repos, "path_by_id", &g1t_contracts::repos::PathByIdArgs { id: id.to_owned() }).await?;
        let Some(path) = path else { return Ok(None) };
        let Some(actor) = self.workspace_actor(&path.namespace).await? else {
            return Ok(None);
        };
        let found: Outcome<Repo> = g1t_kit::call(
            &self.repos,
            "get_by_id",
            &GetByIdArgs {
                id: id.to_owned(),
                viewer: Some(actor.clone()),
            },
        )
        .await?;
        Ok(found.into_result().ok().filter(|repo| repo.fork_of.is_none()).map(|repo| (repo, actor)))
    }

    /// The repository at `path`, when `actor` may do `capability` in it:
    /// not found when they cannot read it, forbidden when their role falls
    /// short.
    async fn may(&self, actor: &User, path: &RepoPath, capability: Capability) -> Result<Outcome<Repo>> {
        let Some(repo) = self.visible_repo(path, &Some(actor.clone())).await? else {
            return Ok(fail(FailureCode::NotFound, "There is no such repository."));
        };
        if !access::can(Some(actor), &repo, capability) {
            return Ok(fail(
                FailureCode::Forbidden,
                access::needs(capability, &format!("{}/{}", repo.namespace, repo.name)),
            ));
        }
        Ok(Outcome::Ok(repo))
    }
}

/// Unwraps an `Outcome`, or returns its failure from the enclosing method.
#[macro_export]
macro_rules! check {
    ($outcome:expr) => {
        match $outcome {
            g1t_contracts::Outcome::Ok(value) => value,
            g1t_contracts::Outcome::Fail(refused) => return Ok(g1t_contracts::Outcome::Fail(refused)),
        }
    };
}

#[event(fetch)]
async fn fetch(mut request: Request, env: Env, ctx: Context) -> Result<Response> {
    let Some(method) = rpc_method(&request) else {
        return Response::error("Not found", 404);
    };
    let body: Value = request.json().await?;
    let service = Actions { defer_starts: true, ..Actions::new(&env)? };
    let response = answer(&service, &method, body).await;
    // The jobs this request queued or made room for start after the
    // answer, where the caller leaving cannot cancel them. A start that is
    // cut short anyway is tried again (FIRST_REPORT_MS).
    if service.starts_wanted.get() {
        ctx.wait_until(async move {
            match Actions::new(&env) {
                Ok(service) => {
                    if let Err(error) = service.start_queued_retrying(&std::collections::HashSet::new()).await {
                        worker::console_error!("actions: starting queued jobs after {method} failed: {error}");
                    }
                }
                Err(error) => worker::console_error!("actions: could not start: {error}"),
            }
        });
    }
    response
}

/// One RPC's answer.
async fn answer(service: &Actions, method: &str, body: Value) -> Result<Response> {
    match method {
        "workflows" => reply(&service.workflows(args(body)?).await?),
        "workflow" => reply(&service.workflow(args(body)?).await?),
        "runs" => reply(&service.runs(args(body)?).await?),
        "run" => reply(&service.run(args(body)?).await?),
        "logs" => reply(&service.logs(args(body)?).await?),
        "job_log_text" => reply(&service.job_log_text(args(body)?).await?),
        "run_logs" => reply(&service.run_logs(args(body)?).await?),
        "summaries" => reply(&service.summaries(args(body)?).await?),
        "dispatch" => reply(&service.dispatch(args(body)?).await?),
        "repository_dispatch" => reply(&service.repository_dispatch(args(body)?).await?),
        "approve_run" => reply(&service.approve_run(args(body)?).await?),
        "pending_deployments" => reply(&service.pending_deployments(args(body)?).await?),
        "review_deployments" => reply(&service.review_deployments(args(body)?).await?),
        "actions_settings" => reply(&service.actions_settings(args(body)?).await?),
        "set_actions_settings" => reply(&service.set_actions_settings(args(body)?).await?),
        "workspace_actions_settings" => reply(&service.workspace_actions_settings(args(body)?).await?),
        "set_workspace_actions_settings" => reply(&service.set_workspace_actions_settings(args(body)?).await?),
        "environments" => reply(&service.environments(args(body)?).await?),
        "set_environment" => reply(&service.set_environment(args(body)?).await?),
        "delete_environment" => reply(&service.delete_environment(args(body)?).await?),
        "merge_group" => reply(&service.merge_group(args(body)?).await?),
        "cancel" => reply(&service.cancel(args(body)?).await?),
        "rerun" => reply(&service.rerun(args(body)?).await?),
        "set_workflow_enabled" => reply(&service.set_workflow_enabled(args(body)?).await?),
        "settings" => reply(&service.settings(args(body)?).await?),
        "set_setting" => reply(&service.set_setting(args(body)?).await?),
        "delete_setting" => reply(&service.delete_setting(args(body)?).await?),
        "resolve_settings" => reply(&service.resolve_settings(args(body)?).await?),
        // Managed workflows: g1t's services' side only.
        "set_managed_workflow" => reply(&service.set_managed_workflow(args(body)?).await?),
        "remove_managed_workflow" => reply(&service.remove_managed_workflow(args(body)?).await?),
        "set_managed_deploy" => reply(&service.set_managed_deploy(args(body)?).await?),
        // A workspace's managed workflows: its owners'.
        "workspace_managed_workflows" => reply(&service.workspace_managed_workflows(args(body)?).await?),
        "set_workspace_managed_workflow" => reply(&service.set_workspace_managed_workflow(args(body)?).await?),
        "remove_workspace_managed_workflow" => reply(&service.remove_workspace_managed_workflow(args(body)?).await?),
        "job_spec" => reply(&service.job_spec(args(body)?).await?),
        "job_auth" => reply(&service.job_auth(args(body)?).await?),
        "job_action" => reply(&service.job_action(args(body)?).await?),
        "job_action_archive" => reply(&service.job_action_archive(args(body)?).await?),
        "check_runs" => reply(&service.check_runs(args(body)?).await?),
        "job_report" => reply(&service.job_report(args(body)?).await?),
        // A running job's stand-ins for brokered secrets: the runner
        // Worker's alone, never passed on by the API.
        "brokered_secrets" => reply(&service.brokered_secrets(args(body)?).await?),
        // The same for a self-hosted job's broker requests, which the
        // runner Worker relays (`POST /actions/jobs/{job}/broker`): with
        // the job's current token only.
        "relayed_secrets" => reply(&service.relayed_secrets(args(body)?).await?),
        // actions/cache, through the API with the job's token.
        "cache_lookup" => reply(&service.cache_lookup(args(body)?).await?),
        "cache_reserve" => reply(&service.cache_reserve(args(body)?).await?),
        "cache_commit" => reply(&service.cache_commit(args(body)?).await?),
        "cache_abort" => reply(&service.cache_abort(args(body)?).await?),
        "cache_upload" => reply(&service.cache_upload(args(body)?).await?),
        // The cache: people's side, listing what is saved and deleting it.
        "caches" => reply(&service.caches(args(body)?).await?),
        "cache_usage" => reply(&service.cache_usage(args(body)?).await?),
        "delete_caches" => reply(&service.delete_caches(args(body)?).await?),
        // Artifacts: a job's side, with its token or its runtime token.
        "artifact_reserve" => reply(&service.artifact_reserve(args(body)?).await?),
        "artifact_commit" => reply(&service.artifact_commit(args(body)?).await?),
        "artifact_abort" => reply(&service.artifact_abort(args(body)?).await?),
        "job_artifacts" => reply(&service.job_artifacts(args(body)?).await?),
        "job_artifact" => reply(&service.job_artifact(args(body)?).await?),
        "job_delete_artifact" => reply(&service.job_delete_artifact(args(body)?).await?),
        // Artifacts: people's side.
        "artifacts" => reply(&service.artifacts(args(body)?).await?),
        "artifact" => reply(&service.artifact(args(body)?).await?),
        "artifact_download" => reply(&service.artifact_download(args(body)?).await?),
        "delete_artifact" => reply(&service.delete_artifact(args(body)?).await?),
        "artifact_retention" => reply(&service.artifact_retention(args(body)?).await?),
        // The toolkit's protocols: the runtime token, OIDC, blob links.
        "runtime_auth" => reply(&service.runtime_auth(args(body)?).await?),
        "oidc_claims" => reply(&service.oidc_claims(args(body)?).await?),
        "blob_sign" => reply(&service.blob_sign(args(body)?).await?),
        "blob_open" => reply(&service.blob_open(args(body)?).await?),
        "blob_start" => reply(&service.blob_start(args(body)?).await?),
        "blob_part" => reply(&service.blob_part(args(body)?).await?),
        "blob_parts" => reply(&service.blob_parts(args(body)?).await?),
        "blob_done" => reply(&service.blob_done(args(body)?).await?),
        // Self-hosted runners: people's side.
        "runners" => reply(&service.runners(args(body)?).await?),
        "create_registration_token" => reply(&service.create_registration_token(args(body)?).await?),
        "remove_runner" => reply(&service.remove_runner(args(body)?).await?),
        // Staff only, from sudo: a workspace's runners, and removing them.
        "admin_runners" => reply(&service.admin_runners(args(body)?).await?),
        "admin_remove_runners" => reply(&service.admin_remove_runners(args(body)?).await?),
        "runner_groups" => reply(&service.runner_groups(args(body)?).await?),
        "set_runner_group" => reply(&service.set_runner_group(args(body)?).await?),
        "delete_runner_group" => reply(&service.delete_runner_group(args(body)?).await?),
        "runner_settings" => reply(&service.runner_settings(args(body)?).await?),
        "set_runner_settings" => reply(&service.set_runner_settings(args(body)?).await?),
        // The desktop app's runners, as each app says they are.
        "report_desktop" => reply(&service.report_desktop(args(body)?).await?),
        "desktop_runners" => reply(&service.desktop_runners(args(body)?).await?),
        // The runner's own side, through the API with its credential.
        "runner_register" => reply(&service.runner_register(args(body)?).await?),
        "runner_poll" => reply(&service.runner_poll(args(body)?).await?),
        "runner_finished" => reply(&service.runner_finished(args(body)?).await?),
        "runner_remove_self" => reply(&service.runner_remove_self(args(body)?).await?),
        // Agent work, from the runner service.
        "runner_route" => reply(&service.runner_route(args(body)?).await?),
        "stuck_jobs" => reply(&service.stuck_jobs(args(body)?).await?),
        "runner_activity" => reply(&service.runner_activity(args(body)?).await?),
        "enqueue_task" => reply(&service.enqueue_task(args(body)?).await?),
        "cancel_task" => reply(&service.cancel_task(args(body)?).await?),
        _ => Response::error("Unknown method", 404),
    }
}

/// How long a failed event waits before it is tried again.
const RETRY_DELAY_SECONDS: u32 = 30;

/// Events from the bus, on this service's own queue. One that fails is
/// retried on its own, after a while: what fails is nearly always the
/// database being overloaded, which a retry straight away finds still
/// overloaded. After its retries it goes to the dead-letter queue
/// (wrangler.jsonc), which the events service counts.
#[event(queue)]
async fn queue(batch: MessageBatch<Event>, env: Env, _ctx: Context) -> Result<()> {
    let service = Actions::new(&env)?;
    let later = QueueRetryOptionsBuilder::new().with_delay_seconds(RETRY_DELAY_SECONDS).build();
    for message in batch.messages()? {
        // A workspace renamed: its rows move to the slug it has now.
        if g1t_kit::rename::on_event(&env, &env.d1("DB")?, message.body(), rename::STATEMENTS).await? {
            message.ack();
            continue;
        }
        // A repository renamed or transferred: its rows follow its new path.
        if g1t_kit::transfer::on_event(&env, &env.d1("DB")?, message.body(), rename::TRANSFERRED).await? {
            message.ack();
            continue;
        }
        // A workspace deleted: what it kept for itself goes.
        if g1t_kit::deleted::on_event(&env.d1("DB")?, message.body(), rename::DELETED).await? {
            message.ack();
            continue;
        }
        // A repository purged: every row kept for it goes.
        if g1t_kit::lifecycle::on_purged(&env.d1("DB")?, message.body(), rename::PURGED).await? {
            message.ack();
            continue;
        }
        // A repository deleted or archived: its runs stop.
        if let Some(repo_id) = plan::stops_runs(message.body()) {
            if let Err(error) = service.stop_runs(&repo_id).await {
                worker::console_error!("actions: event {} failed: {error}", message.body().id);
                message.retry_with_options(&later);
                continue;
            }
            message.ack();
            continue;
        }
        if let Err(error) = service.on_event(message.body()).await {
            worker::console_error!("actions: event {} failed: {error}", message.body().id);
            message.retry_with_options(&later);
            continue;
        }
        message.ack();
    }
    Ok(())
}

/// Every minute: schedules that fire, jobs waiting for room, and jobs
/// whose sandbox went quiet.
#[event(scheduled)]
async fn scheduled(_event: ScheduledEvent, env: Env, _ctx: ScheduleContext) {
    match Actions::new(&env) {
        Ok(service) => {
            if let Err(error) = service.on_minute(g1t_kit::now_ms()).await {
                worker::console_error!("actions: the sweep failed: {error}");
            }
        }
        Err(error) => worker::console_error!("actions: could not start: {error}"),
    }
}

#[cfg(test)]
mod room_tests {
    use super::*;

    #[test]
    fn a_workspace_always_has_its_share() {
        assert!(has_room(RUNNING_PER_WORKSPACE - 1, HOSTED_POOL));
        assert!(!has_room(RUNNING_PER_WORKSPACE, HOSTED_POOL));
    }

    #[test]
    fn past_its_share_a_workspace_runs_more_while_the_pool_keeps_its_headroom() {
        assert!(has_room(RUNNING_PER_WORKSPACE, HOSTED_POOL - POOL_HEADROOM - 1));
        assert!(!has_room(RUNNING_PER_WORKSPACE, HOSTED_POOL - POOL_HEADROOM));
        assert!(!has_room(BURST_PER_WORKSPACE, 0));
    }

    #[test]
    fn a_job_waits_for_a_machine_for_half_an_hour() {
        let since = g1t_contracts::time::rfc3339(1_000_000);
        assert!(!waited_for_a_machine(None, u64::MAX));
        assert!(!waited_for_a_machine(Some(&since), 1_000_000 + WAIT_FOR_MACHINE_MS - 1));
        assert!(waited_for_a_machine(Some(&since), 1_000_000 + WAIT_FOR_MACHINE_MS));
        assert!(!waited_for_a_machine(Some("not a time"), u64::MAX));
    }

    #[test]
    fn a_job_refused_a_machine_is_tried_again_within_seconds() {
        let waited: u64 = MACHINE_RETRY_MS.iter().sum();
        assert!(MACHINE_RETRY_MS.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(waited < 30_000 && waited < WAIT_FOR_MACHINE_MS);
    }

    #[test]
    fn a_job_that_never_reported_is_lost_after_three_minutes() {
        let started = g1t_contracts::time::rfc3339(1_000_000);
        let later = g1t_contracts::time::rfc3339(1_005_000);
        assert!(!never_reported(Some(&started), Some(&started), 1_000_000 + FIRST_REPORT_MS - 1));
        assert!(never_reported(Some(&started), Some(&started), 1_000_000 + FIRST_REPORT_MS));
        // Once it has said anything, only SILENT_MS ends it.
        assert!(!never_reported(Some(&started), Some(&later), u64::MAX));
        assert!(!never_reported(None, None, u64::MAX));
        assert!(!never_reported(Some("not a time"), Some("not a time"), u64::MAX));
    }

    #[test]
    fn a_job_that_loses_its_machine_runs_again_once_unless_it_deploys() {
        assert!(runs_again_when_lost(0, None, false));
        assert!(runs_again_when_lost(0, Some(""), false));
        assert!(!runs_again_when_lost(1, None, false));
        assert!(!runs_again_when_lost(0, Some("production"), false));
        assert!(!runs_again_when_lost(0, None, true));
    }

    #[test]
    fn a_lost_machine_says_the_step_and_instance_it_stopped_on() {
        let steps = r#"[{"number":1,"name":"Run actions/checkout@v5","status":"completed"},{"number":2,"name":"Build work","status":"in_progress"},{"number":3,"name":"Keep what was built","status":"queued"}]"#;
        let head = "Current runner version: '0.3.6'\n##[group]Machine\nHosted by g1t\nInstance: 7f3a9c\nHost: node-12\n##[endgroup]\n";
        assert_eq!(lost_machine_reason(steps, Some(head), false), "Its machine stopped answering in \"Build work\" (instance 7f3a9c); it runs again on another machine.");
        // Between steps: the last one it finished.
        let between = r#"[{"number":1,"name":"Run actions/checkout@v5","status":"completed"},{"number":2,"name":"Build work","status":"queued"}]"#;
        assert_eq!(lost_machine_reason(between, None, false), "Its machine stopped answering in \"Run actions/checkout@v5\"; it runs again on another machine.");
        assert_eq!(lost_machine_reason("[]", Some("no header"), false), "Its machine stopped answering; it runs again on another machine.");
        assert_eq!(lost_machine_reason("not json", None, false), "Its machine stopped answering; it runs again on another machine.");
        // A job that reported its end after a step was stopped: the step
        // that failed, not the cleanup after it.
        let ended = r#"[{"number":1,"name":"Run actions/checkout@v5","status":"completed","conclusion":"success"},{"number":2,"name":"Tests","status":"completed","conclusion":"failure"},{"number":3,"name":"Post Run actions/checkout@v5","status":"completed","conclusion":"success"}]"#;
        assert_eq!(lost_machine_reason(ended, Some(head), true), "Its machine was stopped in \"Tests\" (instance 7f3a9c); it runs again on another machine.");
    }
}
