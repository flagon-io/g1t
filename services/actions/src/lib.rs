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
//! - [`settings`] keeps secrets and variables.
//! - [`protection`] keeps a repository's workflow settings and its
//!   environments' protection rules, holds jobs at those rules until they
//!   pass, and lets pull requests' runs from outside wait for approval.
//! - [`cache`] lists `actions/cache` entries, which the API keeps in R2.
//! - [`runners`] keeps self-hosted runners, hands them jobs (and agent
//!   work from the runner service) when they ask, and hears back.
//!
//! The service acts as the repository's workspace: it reads what the
//! workspace can read, and a job's `GITHUB_TOKEN` is a token of the
//! workspace's that reaches the job's repository only, with the scopes its
//! `permissions:` give it, revoked when the job ends.

mod artifacts;
mod cache;
mod payload;
mod plan;
mod protection;
mod reach;
mod rename;
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
use worker::{Context, D1Database, Env, Fetcher, MessageBatch, MessageExt, Request, Response, Result, ScheduleContext, ScheduledEvent, event};

/// The most workflow files read from a repository.
pub const MAX_WORKFLOWS: usize = 50;
/// Jobs one workspace may have running at once; the rest wait their turn.
pub const RUNNING_PER_WORKSPACE: u32 = 4;
/// The longest a job may run, whatever its `timeout-minutes`.
pub const MAX_TIMEOUT_MINUTES: u32 = 60;
/// The longest a job on a self-hosted runner may run: the machine is the
/// workspace's own, and its time costs nothing.
pub const SELF_HOSTED_MAX_TIMEOUT_MINUTES: u32 = 24 * 60;
/// A running job that has said nothing for this long is taken as lost.
pub const SILENT_MS: u64 = 10 * 60 * 1000;
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
    /// Where the API keeps cache entries, for deleting evicted ones.
    cache: Option<worker::Bucket>,
    /// Seals secrets; absent until `ACTIONS_KEY` is set, when secrets
    /// cannot be saved.
    sealer: Option<Sealer>,
    /// Signs the toolkit's blob links (runtime.rs), from `ACTIONS_KEY`.
    blob_key: Option<String>,
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
            cache: env.bucket("ACTIONS_CACHE").ok(),
            sealer: env.secret("ACTIONS_KEY").ok().and_then(|key| Sealer::new(&key.to_string())),
            blob_key: env.secret("ACTIONS_KEY").ok().map(|key| runtime::blob_key(&key.to_string())),
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
    /// short. Agents never may: people and tokens run and change workflows.
    async fn may(&self, actor: &User, path: &RepoPath, capability: Capability) -> Result<Outcome<Repo>> {
        if actor.kind == PrincipalKind::Agent {
            return Ok(fail(FailureCode::Forbidden, "An agent cannot do that. Ask a person."));
        }
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
async fn fetch(mut request: Request, env: Env, _ctx: Context) -> Result<Response> {
    let Some(method) = rpc_method(&request) else {
        return Response::error("Not found", 404);
    };
    let body: Value = request.json().await?;
    let service = Actions::new(&env)?;
    match method.as_str() {
        "workflows" => reply(&service.workflows(args(body)?).await?),
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
        "job_spec" => reply(&service.job_spec(args(body)?).await?),
        "job_auth" => reply(&service.job_auth(args(body)?).await?),
        "job_action" => reply(&service.job_action(args(body)?).await?),
        "check_runs" => reply(&service.check_runs(args(body)?).await?),
        "job_report" => reply(&service.job_report(args(body)?).await?),
        // actions/cache, through the API with the job's token.
        "cache_lookup" => reply(&service.cache_lookup(args(body)?).await?),
        "cache_reserve" => reply(&service.cache_reserve(args(body)?).await?),
        "cache_commit" => reply(&service.cache_commit(args(body)?).await?),
        "cache_abort" => reply(&service.cache_abort(args(body)?).await?),
        "cache_upload" => reply(&service.cache_upload(args(body)?).await?),
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
        "blob_part" => reply(&service.blob_part(args(body)?).await?),
        "blob_parts" => reply(&service.blob_parts(args(body)?).await?),
        "blob_done" => reply(&service.blob_done(args(body)?).await?),
        // Self-hosted runners: people's side.
        "runners" => reply(&service.runners(args(body)?).await?),
        "create_registration_token" => reply(&service.create_registration_token(args(body)?).await?),
        "remove_runner" => reply(&service.remove_runner(args(body)?).await?),
        "runner_groups" => reply(&service.runner_groups(args(body)?).await?),
        "set_runner_group" => reply(&service.set_runner_group(args(body)?).await?),
        "delete_runner_group" => reply(&service.delete_runner_group(args(body)?).await?),
        "runner_settings" => reply(&service.runner_settings(args(body)?).await?),
        "set_runner_settings" => reply(&service.set_runner_settings(args(body)?).await?),
        // The runner's own side, through the API with its credential.
        "runner_register" => reply(&service.runner_register(args(body)?).await?),
        "runner_poll" => reply(&service.runner_poll(args(body)?).await?),
        "runner_finished" => reply(&service.runner_finished(args(body)?).await?),
        "runner_remove_self" => reply(&service.runner_remove_self(args(body)?).await?),
        // Agent work, from the runner service.
        "runner_route" => reply(&service.runner_route(args(body)?).await?),
        "stuck_jobs" => reply(&service.stuck_jobs(args(body)?).await?),
        "enqueue_task" => reply(&service.enqueue_task(args(body)?).await?),
        "cancel_task" => reply(&service.cancel_task(args(body)?).await?),
        _ => Response::error("Unknown method", 404),
    }
}

/// Events from the bus, on this service's own queue.
#[event(queue)]
async fn queue(batch: MessageBatch<Event>, env: Env, _ctx: Context) -> Result<()> {
    let service = Actions::new(&env)?;
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
                message.retry();
                continue;
            }
            message.ack();
            continue;
        }
        if let Err(error) = service.on_event(message.body()).await {
            worker::console_error!("actions: event {} failed: {error}", message.body().id);
            message.retry();
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
