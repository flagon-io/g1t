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
//!
//! The service acts as the repository's workspace: it reads what the
//! workspace can read, and a job's `GITHUB_TOKEN` is a short-lived token of
//! the workspace's.

mod payload;
mod plan;
mod settings;
mod sync;
mod trigger;
mod views;

use g1t_contracts::events::Event;
use g1t_contracts::identity::{SlugArgs, Workspace};
use g1t_contracts::repos::{GetArgs, GetByIdArgs, Repo, RepoPath};
use g1t_contracts::{FailureCode, Membership, Outcome, PrincipalKind, Role, User, Viewer};
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
/// A running job that has said nothing for this long is taken as lost.
pub const SILENT_MS: u64 = 10 * 60 * 1000;
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
    /// Seals secrets; absent until `ACTIONS_KEY` is set, when secrets
    /// cannot be saved.
    sealer: Option<Sealer>,
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
            sealer: env.secret("ACTIONS_KEY").ok().and_then(|key| Sealer::new(&key.to_string())),
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
            workspaces: vec![Membership {
                slug: workspace.slug,
                role: Role::Member,
            }],
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

    /// Refuses anyone but a member of the repository's workspace.
    fn member(actor: &User, repo: &RepoPath) -> Option<Outcome<()>> {
        (actor.kind == PrincipalKind::Agent || !actor.is_member(&repo.namespace.to_lowercase()))
            .then(|| fail(FailureCode::Forbidden, format!("Only members of {} can do that.", repo.namespace)))
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
        "dispatch" => reply(&service.dispatch(args(body)?).await?),
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
        "job_report" => reply(&service.job_report(args(body)?).await?),
        _ => Response::error("Unknown method", 404),
    }
}

/// Events from the bus, on this service's own queue.
#[event(queue)]
async fn queue(batch: MessageBatch<Event>, env: Env, _ctx: Context) -> Result<()> {
    let service = Actions::new(&env)?;
    for message in batch.messages()? {
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
