//! Self-hosted runners: registering them, handing them work, hearing back,
//! and the people's side (listing, removing, groups, settings). See
//! `g1t_contracts::runners` for the model and the wire.
//!
//! Work reaches a runner only when it asks for it (`runner_poll`), so a
//! runner never needs an open port. A workflow job is taken by flipping its
//! row from `queued` to `in_progress` in one statement, exactly as g1t's
//! own sandboxes take one, and the harness on the machine then fetches it
//! and reports with the job's own token through the same API. Agent work
//! from the runner service is kept as a task with its environment sealed,
//! and handed over once.

use g1t_contracts::access::Capability;
use g1t_contracts::audit::{AuditActor, AuditOutcome, AuditTarget, NewAuditEntry, RecordAuditArgs, Surface};
use g1t_contracts::billing::{ComputeKind, RecordSandboxArgs};
use g1t_contracts::repos::{Repo, RepoPath};
use g1t_contracts::runners::{
    self as model, ACTIVITY_LIMIT, Assignment, CancelTaskArgs, CloudJob, CreateRegistrationTokenArgs, DeleteRunnerGroupArgs,
    DesktopCapability, DesktopDiagnosis, DesktopJob, DesktopRunner, DesktopRunnersArgs, DesktopUpdate, EnqueueTaskArgs, FinishedArgs,
    HandedOverTask, ListRunnersArgs, Poll, PollArgs, RegisterArgs, Registered, RegistrationToken, RemoveRunnerArgs, RemoveSelfArgs,
    ReportDesktopArgs, RouteArgs, Runner, RunnerActivity, RunnerActivityArgs, RunnerAuth, RunnerGroup, RunnerGroupsArgs, RunnerSettings,
    RunnerSettingsArgs, RunnerWork, RunnersOwner, SetRunnerGroupArgs, SetRunnerSettingsArgs, StuckJob, StuckJobsArgs, Wanted,
};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, PrincipalKind, Role, User, new_id};
use g1t_kit::now_ms;
use g1t_secrets::{random_hex, sha256_hex};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::plan::JobRow;
use crate::{Actions, Count, SILENT_MS, check, fail, optional};

/// What one poll has learned while it looks for work, so its looks again
/// do not ask again: each repository's visibility, and the jobs it already
/// said wait for a sandboxed runner.
#[derive(Default)]
struct Looked {
    visibilities: std::collections::HashMap<String, Option<String>>,
    noted: std::collections::HashSet<String>,
}

/// How often a poll looks again for work while it waits.
const POLL_EVERY_MS: u64 = 2_500;
/// A runner that has been offline this long is removed, as on GitHub.
const FORGET_OFFLINE_MS: u64 = 14 * 24 * 60 * 60 * 1000;
/// How often a poll writes down that a runner, or the work it holds, is
/// still there. Polls come every twenty seconds or so; a write each time
/// would be most of the service's writes for nothing. Well inside
/// [`model::ONLINE_WITHIN_MS`] and [`crate::SILENT_MS`].
const SEEN_RESOLUTION_MS: u64 = 60 * 1000;

/// Whether `seen` is old enough, at `at`, to be written down again.
fn seen_is_stale(seen: Option<&str>, at: u64) -> bool {
    seen.is_none_or(|seen| seen < rfc3339(at.saturating_sub(SEEN_RESOLUTION_MS)).as_str())
}

/// How long a runner may go on listing a job it finished as running: its
/// container exits a moment after the job's last report.
const WRAPPING_UP_MS: u64 = 60 * 1000;

/// Whether a poll tells the runner to stop `job`, which it says it is
/// running but which is no longer in progress on it. Not one it finished
/// itself in the last [`WRAPPING_UP_MS`]: the job reported its end and its
/// container is on its way out, and a stop then only kills it early and
/// logs it as cancelled (Deploy #596's Smoke, 2026-10-23). A job cancelled,
/// taken from it, or finished longer ago is stopped.
fn stops_on_poll(job: &JobRow, runner_id: &str, at: u64) -> bool {
    let finished_here =
        job.status == "completed" && job.runner_id.as_deref() == Some(runner_id) && job.conclusion.as_deref() != Some("cancelled");
    let just_now = job
        .finished_at
        .as_deref()
        .and_then(g1t_contracts::time::parse_rfc3339)
        .is_some_and(|finished| at.saturating_sub(finished) < WRAPPING_UP_MS);
    !(finished_here && just_now)
}

#[derive(Clone, Debug, Deserialize)]
pub struct RunnerRow {
    pub id: String,
    pub workspace: String,
    pub repo_id: Option<String>,
    pub repo: Option<String>,
    pub group_id: Option<String>,
    pub name: String,
    pub labels: String,
    pub os: String,
    pub arch: String,
    pub version: String,
    pub ephemeral: u32,
    pub credential_hash: String,
    pub previous_hash: Option<String>,
    pub rotated_at: String,
    pub work_id: Option<String>,
    pub work_kind: Option<String>,
    pub spent: u32,
    pub last_seen_at: Option<String>,
    pub created_at: String,
    pub created_by: Option<String>,
    /// `nested-container`, `container` or `host` (migration 0015); none
    /// for a runner that never said.
    #[serde(default)]
    pub isolation: Option<String>,
    /// Which computer it registered from (migration 0022): a hash of the
    /// fingerprint it sent, with its workspace; none for a runner that
    /// never said.
    #[serde(default)]
    pub machine_hash: Option<String>,
    /// What a job on it gets, as it last said (migration 0030); none for a
    /// runner that never said.
    #[serde(default)]
    pub cpus: Option<u32>,
    #[serde(default)]
    pub memory_mib: Option<u64>,
    #[serde(default)]
    pub docker: Option<u32>,
    /// The sizes it takes, as it last said (migration 0031): JSON, as
    /// [`kept_sizes`] keeps them; none for a runner that never said.
    #[serde(default)]
    pub sizes: Option<String>,
    /// 1 when it runs jobs asking for a hosted label in g1t's runner image,
    /// as it last said (migration 0032); none for a runner that never said,
    /// which takes none of them.
    #[serde(default)]
    pub hosted_image: Option<u32>,
}

impl RunnerRow {
    fn labels(&self) -> Vec<String> {
        serde_json::from_str(&self.labels).unwrap_or_default()
    }

    fn sizes(&self) -> Option<Vec<model::OfferedSize>> {
        self.sizes.as_deref().and_then(|text| serde_json::from_str(text).ok())
    }

    fn capacity(&self) -> model::Capacity {
        model::Capacity {
            cpus: self.cpus,
            memory_mib: self.memory_mib,
            docker: self.docker.map(|docker| docker != 0),
            hosted_image: self.hosted_image.map(|image| image != 0),
        }
    }

    fn online(&self, now: u64) -> bool {
        self.last_seen_at.as_deref().is_some_and(|seen| seen >= rfc3339(now.saturating_sub(model::ONLINE_WITHIN_MS)).as_str())
    }
}

#[derive(Clone, Debug, Deserialize)]
struct GroupRow {
    id: String,
    name: String,
    is_default: u32,
    repositories: String,
    updated_at: String,
}

impl GroupRow {
    fn repositories(&self) -> Vec<String> {
        serde_json::from_str(&self.repositories).unwrap_or_default()
    }

    /// Whether `repo` (`owner/name`, or a bare name) may use the group.
    fn allows(&self, repo: &str) -> bool {
        let name = repo.rsplit('/').next().unwrap_or(repo);
        let listed = self.repositories();
        listed.is_empty() || listed.iter().any(|r| r.eq_ignore_ascii_case(name))
    }
}

#[derive(Clone, Debug, Deserialize)]
struct RegistrationRow {
    workspace: String,
    repo_id: Option<String>,
    repo: Option<String>,
    group_id: Option<String>,
    expires_at: String,
    /// Who made the token: the runners it registers are theirs.
    #[serde(default)]
    created_by: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct SettingsRow {
    agents: u32,
    agent_labels: String,
    fork_pulls: u32,
    /// Migration 0029: on unless turned off.
    #[serde(default = "on")]
    prefer_own: u32,
}

fn on() -> u32 {
    1
}

#[derive(Clone, Debug, Deserialize)]
pub struct TaskRow {
    pub id: String,
    pub sandbox: String,
    pub repo_id: Option<String>,
    pub repo: String,
    pub kind: String,
    pub title: String,
    pub labels: String,
    pub env: Option<String>,
    pub timeout_minutes: u32,
    pub status: String,
    pub runner_id: Option<String>,
    pub runner_name: Option<String>,
    pub started_at: Option<String>,
    #[serde(default)]
    pub seen_at: Option<String>,
    /// The agent run it belongs to (migration 0012); none for older tasks.
    #[serde(default)]
    pub run_id: Option<String>,
}

/// Who may do what with a set of runners: the workspace, and the
/// repository when they are a repository's own.
struct Place {
    workspace: String,
    repo: Option<Repo>,
}

fn now() -> String {
    rfc3339(now_ms())
}

/// Takes a queued job for a runner: `?1` its token's hash, `?2` and `?3`
/// the runner's id and name, `?4` now, `?5` the job. A job offered to the
/// runners in place of g1t's machine may be taken by g1t's machine at
/// once (plan.rs `HOSTED_CLAIM`): only the first finds it still queued.
pub(crate) const RUNNER_CLAIM: &str =
    "UPDATE jobs SET status = 'in_progress', token_hash = ?1, first_token_hash = NULL, runner_id = ?2, runner_name = ?3,
       reason = NULL, started_at = ?4, seen_at = ?4
     WHERE id = ?5 AND status = 'queued' RETURNING id";

/// What a runner says a job on it gets, as it is kept: a count of CPUs and
/// MiB of memory that are some, and no more than any machine has.
fn kept_capacity(cpus: Option<u32>, memory_mib: Option<u64>, docker: Option<bool>, hosted_image: Option<bool>) -> model::Capacity {
    model::Capacity {
        cpus: cpus.filter(|n| (1..=4096).contains(n)),
        memory_mib: memory_mib.filter(|n| (1..=64 * 1024 * 1024).contains(n)),
        docker,
        hosted_image,
    }
}

/// The sizes a runner says it takes, as they are kept: JSON of
/// [`model::kept_sizes`], g1t's machines only, none below its size.
fn sized(given: &[model::OfferedSize]) -> String {
    serde_json::to_string(&model::kept_sizes(given)).unwrap_or_else(|_| "[]".to_owned())
}

fn valid_name(name: &str) -> std::result::Result<String, String> {
    let name = name.trim();
    let ok = !name.is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if ok { Ok(name.to_owned()) } else { Err("A runner's name is 1 to 64 letters, digits, `-`, `_` and `.`.".to_owned()) }
}

fn valid_group_name(name: &str) -> std::result::Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 64 || name.chars().any(|c| c.is_control()) {
        return Err("A group's name is 1 to 64 characters.".to_owned());
    }
    Ok(name.to_owned())
}

/// What a runner's credential is checked against, and what a registration
/// token is found by.
fn hash(secret: &str) -> String {
    sha256_hex(secret)
}

/// What a runner's machine fingerprint is kept as: hashed with its
/// workspace, so the same computer is not recognisable across workspaces.
/// A fingerprint is 32 to 128 hex digits; anything else counts as none.
fn machine_hash(workspace: &str, machine: Option<&str>) -> Option<String> {
    let machine = machine.map(str::trim).filter(|m| (32..=128).contains(&m.len()) && m.chars().all(|c| c.is_ascii_hexdigit()))?;
    Some(hash(&format!("{workspace}\n{}", machine.to_ascii_lowercase())))
}

/// Whether a registration takes the place of `existing`, a runner of the
/// same name: when asked to (`--replace`); when it is the same computer
/// registering again (its sandbox made again, its state lost); or, for a
/// runner from before runners said which computer they are, when the same
/// person registered it and it is no longer heard from.
fn takes_over(existing: &RunnerRow, replace: bool, machine_hash: Option<&str>, created_by: Option<&str>, now: u64) -> bool {
    let same_machine = machine_hash.is_some() && existing.machine_hash.as_deref() == machine_hash;
    let left_behind =
        existing.machine_hash.is_none() && created_by.is_some() && existing.created_by.as_deref() == created_by && !existing.online(now);
    replace || same_machine || left_behind
}

/// The actor of a runner's own entries in the audit log.
fn runner_actor(runner: &RunnerRow) -> AuditActor {
    AuditActor {
        actor_kind: Some(g1t_contracts::audit::ActorKind::Runner),
        actor: runner.name.clone(),
        actor_id: runner.id.clone(),
        ..AuditActor::default()
    }
}

fn entry(actor: AuditActor, action: &str, workspace: &str, repo: Option<String>, path: Option<String>, message: String) -> NewAuditEntry {
    NewAuditEntry {
        actor,
        action: action.to_owned(),
        surface: Surface::Rest,
        target: AuditTarget { workspace: workspace.to_owned(), repo, path, ..AuditTarget::default() },
        outcome: AuditOutcome::Allowed,
        rule: "runner".to_owned(),
        result: Some("ok".to_owned()),
        message: Some(message),
        request_id: new_id("req", now_ms()),
    }
}

impl Actions {
    // --- Shared ------------------------------------------------------------

    pub(crate) async fn audit(&self, entries: Vec<NewAuditEntry>) {
        let recorded: Result<u32> = g1t_kit::call(&self.events, "audit_record", &RecordAuditArgs { entries }).await;
        if let Err(error) = recorded {
            worker::console_error!("actions: audit entries not recorded: {error}");
        }
    }

    /// Where `owner` points, if `actor` may see it (`manage` false) or
    /// change it (`manage` true): a workspace's runners are seen by its
    /// members and changed by its owners; a repository's own, by its
    /// admins. Workspace tokens never change them, so a workflow's
    /// `G1T_TOKEN` cannot add a machine to run its own jobs.
    async fn runner_place(&self, actor: &User, owner: &RunnersOwner, manage: bool) -> Result<Outcome<Place>> {
        if manage && actor.kind == PrincipalKind::Workspace {
            return Ok(fail(
                FailureCode::Forbidden,
                "A workspace's tokens, G1T_TOKEN included, cannot change self-hosted runners. Use a person's token with the runners:admin scope.",
            ));
        }
        match (&owner.repo, &owner.workspace) {
            (Some(path), _) => {
                let repo = check!(self.may(actor, path, Capability::ManageIntegrations).await?);
                Ok(Outcome::Ok(Place { workspace: repo.namespace.to_lowercase(), repo: Some(repo) }))
            }
            (None, Some(slug)) => {
                let slug = slug.to_lowercase();
                let role = actor.workspaces.iter().find(|m| m.slug.eq_ignore_ascii_case(&slug)).map(|m| m.role);
                match role {
                    None => Ok(fail(FailureCode::NotFound, "There is no such workspace, or you are not a member of it.")),
                    // A workspace's machines and their tokens are its owners' alone, to see as well as change.
                    Some(Role::Member) => Ok(fail(
                        FailureCode::Forbidden,
                        format!("Only owners of {slug} can {} its self-hosted runners.", if manage { "change" } else { "see" }),
                    )),
                    Some(_) => Ok(Outcome::Ok(Place { workspace: slug, repo: None })),
                }
            }
            (None, None) => Ok(fail(FailureCode::Invalid, "Give `repo` or `workspace`.")),
        }
    }

    async fn group_rows(&self, workspace: &str) -> Result<Vec<GroupRow>> {
        self.db
            .prepare("SELECT * FROM runner_groups WHERE workspace = ? ORDER BY is_default DESC, name")
            .bind(&[workspace.into()])?
            .all()
            .await?
            .results::<GroupRow>()
    }

    /// The workspace's default group, made the first time it is needed.
    async fn default_group(&self, workspace: &str) -> Result<GroupRow> {
        let at = now();
        self.db
            .prepare(
                "INSERT OR IGNORE INTO runner_groups (id, workspace, name, is_default, repositories, created_at, updated_at)
                 VALUES (?, ?, 'Default', 1, '[]', ?, ?)",
            )
            .bind(&[new_id("rng", now_ms()).into(), workspace.into(), at.as_str().into(), at.as_str().into()])?
            .run()
            .await?;
        let row = self
            .db
            .prepare("SELECT * FROM runner_groups WHERE workspace = ? AND is_default = 1 LIMIT 1")
            .bind(&[workspace.into()])?
            .first::<GroupRow>(None)
            .await?;
        row.ok_or_else(|| worker::Error::RustError("the default runner group could not be made".into()))
    }

    /// A group of the workspace by id or name.
    async fn find_group(&self, workspace: &str, wanted: &str) -> Result<Option<GroupRow>> {
        self.default_group(workspace).await?;
        Ok(self.group_rows(workspace).await?.into_iter().find(|g| g.id == wanted || g.name.eq_ignore_ascii_case(wanted.trim())))
    }

    async fn runner_rows(&self, workspace: &str) -> Result<Vec<RunnerRow>> {
        self.db
            .prepare("SELECT * FROM runners WHERE workspace = ? ORDER BY name")
            .bind(&[workspace.into()])?
            .all()
            .await?
            .results::<RunnerRow>()
    }

    async fn runner_by_id(&self, id: &str) -> Result<Option<RunnerRow>> {
        self.db.prepare("SELECT * FROM runners WHERE id = ?").bind(&[id.into()])?.first::<RunnerRow>(None).await
    }

    /// What a runner is doing, for people.
    async fn work_of(&self, row: &RunnerRow) -> Result<Option<RunnerWork>> {
        let Some(id) = &row.work_id else { return Ok(None) };
        if row.work_kind.as_deref() == Some("agent") {
            let task =
                self.db.prepare("SELECT * FROM runner_tasks WHERE id = ?").bind(&[id.as_str().into()])?.first::<TaskRow>(None).await?;
            return Ok(task.filter(|t| t.status == "in_progress").map(|t| RunnerWork {
                kind: "agent".into(),
                id: t.id,
                name: t.title,
                repo: Some(t.repo),
                run_id: t.run_id,
                started_at: t.started_at,
            }));
        }
        #[derive(Deserialize)]
        struct Found {
            id: String,
            name: String,
            run_id: String,
            status: String,
            started_at: Option<String>,
            repo: String,
        }
        let job = self
            .db
            .prepare("SELECT jobs.id, jobs.name, jobs.run_id, jobs.status, jobs.started_at, runs.repo FROM jobs JOIN runs ON runs.id = jobs.run_id WHERE jobs.id = ?")
            .bind(&[id.as_str().into()])?
            .first::<Found>(None)
            .await?;
        Ok(job.filter(|j| j.status == "in_progress").map(|j| RunnerWork {
            kind: "workflow".into(),
            id: j.id,
            name: j.name,
            repo: Some(j.repo),
            run_id: Some(j.run_id),
            started_at: j.started_at,
        }))
    }

    async fn runner_view(&self, row: &RunnerRow, groups: &[GroupRow], at: u64) -> Result<Runner> {
        let online = row.online(at);
        let work = if online { self.work_of(row).await? } else { None };
        Ok(Runner {
            id: row.id.clone(),
            name: row.name.clone(),
            workspace: row.workspace.clone(),
            repo: row.repo.clone(),
            group: row.group_id.as_ref().and_then(|id| groups.iter().find(|g| &g.id == id)).map(|g| g.name.clone()),
            labels: row.labels(),
            os: row.os.clone(),
            arch: row.arch.clone(),
            version: row.version.clone(),
            ephemeral: row.ephemeral != 0,
            status: if !online {
                "offline"
            } else if work.is_some() {
                "busy"
            } else {
                "online"
            }
            .to_owned(),
            work,
            last_seen_at: row.last_seen_at.clone(),
            created_at: row.created_at.clone(),
            created_by: row.created_by.clone(),
            isolation: row.isolation.clone(),
            cpus: row.cpus,
            memory_mib: row.memory_mib,
            docker: row.docker.map(|docker| docker != 0),
            sizes: row.sizes(),
            hosted_image: row.hosted_image.map(|image| image != 0),
        })
    }

    // --- People's side -----------------------------------------------------

    /// `runners`: a workspace's runners, or a repository's: its own and
    /// the workspace's that its group lets it use.
    pub async fn runners(&self, a: ListRunnersArgs) -> Result<Outcome<Vec<Runner>>> {
        let place = check!(self.runner_place(&a.actor, &a.owner, false).await?);
        self.default_group(&place.workspace).await?;
        let groups = self.group_rows(&place.workspace).await?;
        let at = now_ms();
        let mut out = Vec::new();
        for row in self.runner_rows(&place.workspace).await? {
            let shown = match &place.repo {
                None => row.repo_id.is_none(),
                Some(repo) => match &row.repo_id {
                    Some(id) => id == &repo.id,
                    None => groups.iter().find(|g| Some(&g.id) == row.group_id.as_ref()).is_none_or(|g| g.allows(&repo.name)),
                },
            };
            if shown {
                out.push(self.runner_view(&row, &groups, at).await?);
            }
        }
        Ok(Outcome::Ok(out))
    }

    /// `create_registration_token`.
    pub async fn create_registration_token(&self, a: CreateRegistrationTokenArgs) -> Result<Outcome<RegistrationToken>> {
        let place = check!(self.runner_place(&a.actor, &a.owner, true).await?);
        // A workspace g1t staff put a hold on registers no new runners.
        if self.standing(&place.workspace).await.is_some_and(|standing| standing.held) {
            return Ok(fail(
                FailureCode::Paused,
                "g1t staff put a hold on this workspace, so it cannot register new runners. Write to hey@flagon.io if you think this is a mistake.",
            ));
        }
        let made = self
            .db
            .prepare("SELECT COUNT(*) AS n FROM runner_registrations WHERE workspace = ? AND created_at > ?")
            .bind(&[place.workspace.as_str().into(), rfc3339(now_ms().saturating_sub(60 * 60 * 1000)).into()])?
            .first::<Count>(None)
            .await?
            .map_or(0, |c| c.n);
        if made >= model::MAX_TOKENS_PER_HOUR {
            return Ok(fail(
                FailureCode::Conflict,
                "Too many registration tokens in the last hour. Each lasts an hour and registers any number of runners.",
            ));
        }
        let group = match (&place.repo, a.group.as_deref().map(str::trim).filter(|g| !g.is_empty())) {
            (Some(_), Some(_)) => return Ok(fail(FailureCode::Invalid, "A repository's own runners are in no group.")),
            (Some(_), None) => None,
            (None, Some(wanted)) => match self.find_group(&place.workspace, wanted).await? {
                Some(group) => Some(group),
                None => return Ok(fail(FailureCode::NotFound, format!("There is no runner group called {wanted}."))),
            },
            (None, None) => Some(self.default_group(&place.workspace).await?),
        };
        let token = format!("{}{}", model::REGISTRATION_PREFIX, random_hex(24));
        let at = now_ms();
        let expires_at = rfc3339(at + model::REGISTRATION_TTL_SECONDS * 1000);
        let repo_name = place.repo.as_ref().map(|r| format!("{}/{}", r.namespace, r.name));
        self.db
            .prepare(
                "INSERT INTO runner_registrations (token_hash, workspace, repo_id, repo, group_id, created_by, created_at, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                hash(&token).into(),
                place.workspace.as_str().into(),
                optional(place.repo.as_ref().map(|r| r.id.as_str())),
                optional(repo_name.as_deref()),
                optional(group.as_ref().map(|g| g.id.as_str())),
                a.actor.username.as_str().into(),
                rfc3339(at).into(),
                expires_at.as_str().into(),
            ])?
            .run()
            .await?;
        self.audit(vec![entry(
            AuditActor::of(&a.actor),
            "create_runner_registration_token",
            &place.workspace,
            repo_name.clone(),
            None,
            format!("Made a runner registration token{}.", group.as_ref().map(|g| format!(" for group {}", g.name)).unwrap_or_default()),
        )])
        .await;
        Ok(Outcome::Ok(RegistrationToken {
            token,
            expires_at,
            workspace: place.workspace,
            repo: repo_name,
            group: group.map(|g| g.name),
            url: crate::SITE.to_owned(),
        }))
    }

    /// `remove_runner`: a person removing one.
    pub async fn remove_runner(&self, a: RemoveRunnerArgs) -> Result<Outcome<bool>> {
        let place = check!(self.runner_place(&a.actor, &a.owner, true).await?);
        let Some(row) = self.runner_by_id(&a.id).await? else {
            return Ok(fail(FailureCode::NotFound, "There is no such runner."));
        };
        let ours = row.workspace == place.workspace
            && match &place.repo {
                Some(repo) => row.repo_id.as_deref() == Some(repo.id.as_str()),
                None => row.repo_id.is_none(),
            };
        if !ours {
            return Ok(fail(FailureCode::NotFound, "There is no such runner."));
        }
        self.forget_runner(&row, &format!("{} removed the runner {}.", a.actor.username, row.name)).await?;
        self.audit(vec![entry(
            AuditActor::of(&a.actor),
            "remove_runner",
            &row.workspace,
            row.repo.clone(),
            Some(row.name.clone()),
            format!("Removed the self-hosted runner {}.", row.name),
        )])
        .await;
        Ok(Outcome::Ok(true))
    }

    /// `admin_runners`: staff see a workspace's runners.
    pub async fn admin_runners(&self, a: g1t_contracts::runners::AdminRunnersArgs) -> Result<Vec<g1t_contracts::runners::AdminRunner>> {
        let workspace = a.workspace.trim().to_lowercase();
        Ok(self
            .runner_rows(&workspace)
            .await?
            .into_iter()
            .map(|row| g1t_contracts::runners::AdminRunner {
                busy: row.work_id.is_some(),
                id: row.id,
                name: row.name,
                repo: row.repo,
                os: row.os,
                version: row.version,
                last_seen_at: row.last_seen_at,
                created_at: row.created_at,
                created_by: row.created_by,
            })
            .collect())
    }

    /// `admin_remove_runners`: staff remove one runner or all of a
    /// workspace's, and end its registration tokens.
    pub async fn admin_remove_runners(&self, a: g1t_contracts::runners::AdminRemoveRunnersArgs) -> Result<Outcome<u32>> {
        let staff = a.staff.trim();
        if staff.is_empty() {
            return Ok(fail(FailureCode::Forbidden, "Say which staff member is doing it."));
        }
        let workspace = a.workspace.trim().to_lowercase();
        let rows: Vec<RunnerRow> =
            self.runner_rows(&workspace).await?.into_iter().filter(|row| a.id.as_deref().is_none_or(|id| id == row.id)).collect();
        if a.id.is_some() && rows.is_empty() {
            return Ok(fail(FailureCode::NotFound, "There is no such runner."));
        }
        let why = format!("g1t staff removed the runner from {workspace}.");
        for row in &rows {
            self.forget_runner(row, &why).await?;
        }
        if a.id.is_none() {
            self.db.prepare("DELETE FROM runner_registrations WHERE workspace = ?").bind(&[workspace.as_str().into()])?.run().await?;
        }
        worker::console_log!("actions: staff {staff} removed {} of {workspace}'s runners", rows.len());
        Ok(Outcome::Ok(u32::try_from(rows.len()).unwrap_or(u32::MAX)))
    }

    /// Removes a runner: what it was running fails, and its credential
    /// stops working at once.
    async fn forget_runner(&self, row: &RunnerRow, why: &str) -> Result<()> {
        self.db.prepare("DELETE FROM runners WHERE id = ?").bind(&[row.id.as_str().into()])?.run().await?;
        self.abandon_work(&row.id, why).await
    }

    /// Fails whatever a runner was running.
    async fn abandon_work(&self, runner_id: &str, why: &str) -> Result<()> {
        let jobs = self
            .db
            .prepare("SELECT id FROM jobs WHERE runner_id = ? AND status = 'in_progress'")
            .bind(&[runner_id.into()])?
            .all()
            .await?
            .results::<IdRow>()?;
        for job in jobs {
            self.finish_job(&job.id, "failure", Some(why), None).await?;
        }
        let tasks = self
            .db
            .prepare("SELECT * FROM runner_tasks WHERE runner_id = ? AND status = 'in_progress'")
            .bind(&[runner_id.into()])?
            .all()
            .await?
            .results::<TaskRow>()?;
        for task in tasks {
            self.end_task(&task, 1, why).await?;
        }
        Ok(())
    }

    /// `runner_groups`.
    pub async fn runner_groups(&self, a: RunnerGroupsArgs) -> Result<Outcome<Vec<RunnerGroup>>> {
        let owner = RunnersOwner { repo: None, workspace: Some(a.workspace.clone()) };
        let place = check!(self.runner_place(&a.actor, &owner, false).await?);
        self.default_group(&place.workspace).await?;
        let groups = self.group_rows(&place.workspace).await?;
        let runners = self.runner_rows(&place.workspace).await?;
        Ok(Outcome::Ok(groups.iter().map(|g| group_view(g, &runners)).collect()))
    }

    /// `set_runner_group`.
    pub async fn set_runner_group(&self, a: SetRunnerGroupArgs) -> Result<Outcome<RunnerGroup>> {
        let owner = RunnersOwner { repo: None, workspace: Some(a.workspace.clone()) };
        let place = check!(self.runner_place(&a.actor, &owner, true).await?);
        self.default_group(&place.workspace).await?;
        let groups = self.group_rows(&place.workspace).await?;
        let name = match a.name.as_deref().map(valid_group_name).transpose() {
            Ok(name) => name,
            Err(problem) => return Ok(fail(FailureCode::Invalid, problem)),
        };
        let repositories: Option<Vec<String>> = a.repositories.map(|list| {
            let mut out: Vec<String> = Vec::new();
            for repo in list {
                let name = repo.trim().rsplit('/').next().unwrap_or_default().to_owned();
                if !name.is_empty() && !out.iter().any(|r: &String| r.eq_ignore_ascii_case(&name)) {
                    out.push(name);
                }
            }
            out
        });
        if let Some(name) = &name
            && groups.iter().any(|g| g.name.eq_ignore_ascii_case(name) && Some(&g.id) != a.id.as_ref())
        {
            return Ok(fail(FailureCode::Conflict, format!("There is already a group called {name}.")));
        }
        let at = now();
        let id = match &a.id {
            Some(id) => {
                let Some(group) = groups.iter().find(|g| &g.id == id) else {
                    return Ok(fail(FailureCode::NotFound, "There is no such runner group."));
                };
                self.db
                    .prepare("UPDATE runner_groups SET name = ?, repositories = ?, updated_at = ? WHERE id = ?")
                    .bind(&[
                        name.clone().unwrap_or(group.name.clone()).into(),
                        serde_json::to_string(&repositories.clone().unwrap_or(group.repositories()))?.into(),
                        at.as_str().into(),
                        id.as_str().into(),
                    ])?
                    .run()
                    .await?;
                id.clone()
            }
            None => {
                let Some(name) = name.clone() else {
                    return Ok(fail(FailureCode::Invalid, "A new group needs a name."));
                };
                if groups.len() >= 50 {
                    return Ok(fail(FailureCode::Conflict, "A workspace has at most 50 runner groups."));
                }
                let id = new_id("rng", now_ms());
                self.db
                    .prepare(
                        "INSERT INTO runner_groups (id, workspace, name, is_default, repositories, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)",
                    )
                    .bind(&[
                        id.as_str().into(),
                        place.workspace.as_str().into(),
                        name.into(),
                        serde_json::to_string(&repositories.clone().unwrap_or_default())?.into(),
                        at.as_str().into(),
                        at.as_str().into(),
                    ])?
                    .run()
                    .await?;
                id
            }
        };
        let groups = self.group_rows(&place.workspace).await?;
        let runners = self.runner_rows(&place.workspace).await?;
        let Some(group) = groups.iter().find(|g| g.id == id) else {
            return Ok(fail(FailureCode::NotFound, "There is no such runner group."));
        };
        self.audit(vec![entry(
            AuditActor::of(&a.actor),
            if a.id.is_some() { "update_runner_group" } else { "create_runner_group" },
            &place.workspace,
            None,
            Some(group.name.clone()),
            format!(
                "Runner group {}: {}.",
                group.name,
                if group.repositories().is_empty() { "every repository".to_owned() } else { group.repositories().join(", ") }
            ),
        )])
        .await;
        Ok(Outcome::Ok(group_view(group, &runners)))
    }

    /// `delete_runner_group`.
    pub async fn delete_runner_group(&self, a: DeleteRunnerGroupArgs) -> Result<Outcome<bool>> {
        let owner = RunnersOwner { repo: None, workspace: Some(a.workspace.clone()) };
        let place = check!(self.runner_place(&a.actor, &owner, true).await?);
        let default = self.default_group(&place.workspace).await?;
        let Some(group) = self.group_rows(&place.workspace).await?.into_iter().find(|g| g.id == a.id) else {
            return Ok(fail(FailureCode::NotFound, "There is no such runner group."));
        };
        if group.is_default != 0 {
            return Ok(fail(FailureCode::Conflict, "The default group cannot be deleted."));
        }
        self.db
            .batch(vec![
                self.db
                    .prepare("UPDATE runners SET group_id = ? WHERE group_id = ?")
                    .bind(&[default.id.as_str().into(), group.id.as_str().into()])?,
                self.db.prepare("DELETE FROM runner_groups WHERE id = ?").bind(&[group.id.as_str().into()])?,
            ])
            .await?;
        self.audit(vec![entry(
            AuditActor::of(&a.actor),
            "delete_runner_group",
            &place.workspace,
            None,
            Some(group.name.clone()),
            format!("Deleted the runner group {}; its runners joined {}.", group.name, default.name),
        )])
        .await;
        Ok(Outcome::Ok(true))
    }

    async fn settings_row(&self, owner: &str) -> Result<Option<SettingsRow>> {
        self.db.prepare("SELECT * FROM runner_settings WHERE owner = ?").bind(&[owner.into()])?.first::<SettingsRow>(None).await
    }

    fn settings_of(row: Option<SettingsRow>, inherited: bool) -> RunnerSettings {
        match row {
            Some(row) => RunnerSettings {
                agents_on_self_hosted: row.agents != 0,
                agent_labels: serde_json::from_str(&row.agent_labels).unwrap_or_else(|_| vec![model::SELF_HOSTED.to_owned()]),
                fork_pull_requests: row.fork_pulls != 0,
                prefer_own_runners: row.prefer_own != 0,
                inherited,
            },
            None => RunnerSettings {
                agent_labels: vec![model::SELF_HOSTED.to_owned()],
                prefer_own_runners: true,
                inherited,
                ..RunnerSettings::default()
            },
        }
    }

    /// The settings that apply in a workspace, or in one of its
    /// repositories: the repository's own if it has them.
    pub async fn effective_runner_settings(&self, workspace: &str, repo_id: Option<&str>) -> Result<RunnerSettings> {
        if let Some(repo_id) = repo_id
            && let Some(own) = self.settings_row(repo_id).await?
        {
            return Ok(Self::settings_of(Some(own), false));
        }
        let inherited = repo_id.is_some();
        Ok(Self::settings_of(self.settings_row(&workspace.to_lowercase()).await?, inherited))
    }

    /// `runner_settings`.
    pub async fn runner_settings(&self, a: RunnerSettingsArgs) -> Result<Outcome<RunnerSettings>> {
        let place = check!(self.runner_place(&a.actor, &a.owner, false).await?);
        Ok(Outcome::Ok(self.effective_runner_settings(&place.workspace, place.repo.as_ref().map(|r| r.id.as_str())).await?))
    }

    /// `report_desktop`: what a person's desktop app says of its runner,
    /// in a workspace they own. Kept per computer, replaced each time.
    pub async fn report_desktop(&self, a: ReportDesktopArgs) -> Result<Outcome<bool>> {
        let owner = RunnersOwner { repo: None, workspace: Some(a.workspace.clone()) };
        let place = check!(self.runner_place(&a.actor, &owner, true).await?);
        let machine = match valid_name(&a.machine) {
            Ok(name) => name,
            Err(problem) => return Ok(fail(FailureCode::Invalid, problem)),
        };
        if !matches!(a.backend.as_str(), "sandboxed" | "docker" | "host") {
            return Ok(fail(FailureCode::Invalid, "A desktop runs jobs sandboxed, in Docker or on the host."));
        }
        let clip = |text: &str, most: usize| text.chars().take(most).collect::<String>();
        let tidy = |d: &DesktopDiagnosis| DesktopDiagnosis {
            code: clip(&d.code, 40),
            tone: clip(&d.tone, 20),
            title: clip(&d.title, 200),
            cause: d.cause.as_deref().map(|t| clip(t, 1000)),
            fix: d.fix.as_deref().map(|t| clip(t, 1000)),
            capabilities: d
                .capabilities
                .iter()
                .take(model::MAX_DESKTOP_CAPABILITIES)
                .map(|c| DesktopCapability {
                    id: clip(&c.id, 20),
                    label: clip(&c.label, 60),
                    tone: clip(&c.tone, 20),
                    title: clip(&c.title, 200),
                    cause: c.cause.as_deref().map(|t| clip(t, 1000)),
                    fix: c.fix.as_deref().map(|t| clip(t, 1000)),
                    state: c.state.as_deref().map(|t| clip(t, 20)),
                    headline: c.headline.as_deref().map(|t| clip(t, 200)),
                    about: c.about.as_deref().map(|t| clip(t, 200)),
                    enabled: c.enabled,
                    job: c.job.as_ref().map(|j| DesktopJob { kind: clip(&j.kind, 20), name: clip(&j.name, 200), repo: clip(&j.repo, 200) }),
                    runner: c.runner.as_deref().map(|t| clip(t, 80)),
                    isolation: c.isolation.as_deref().map(|t| clip(t, 40)),
                    version: c.version.as_deref().map(|t| clip(t, 40)),
                    update: c.update.as_deref().map(|t| clip(t, 200)),
                })
                .collect(),
            in_capabilities: d.in_capabilities && !d.capabilities.is_empty(),
            update: d.update.as_ref().map(|u| DesktopUpdate {
                checked_at: u.checked_at.as_deref().map(|t| clip(t, 40)),
                ready: u.ready.as_deref().map(|t| clip(t, 40)),
                note: u.note.as_deref().map(|t| clip(t, 200)),
            }),
        };
        let at = now_ms();
        let known = self
            .db
            .prepare("SELECT COUNT(*) AS n FROM desktop_runners WHERE workspace = ? AND lower(machine) <> lower(?)")
            .bind(&[place.workspace.as_str().into(), machine.as_str().into()])?
            .first::<Count>(None)
            .await?
            .map_or(0, |c| c.n);
        if known >= model::MAX_DESKTOPS {
            // The oldest report makes room: a computer long gone.
            self.db
                .prepare("DELETE FROM desktop_runners WHERE rowid IN (SELECT rowid FROM desktop_runners WHERE workspace = ? ORDER BY reported_at LIMIT 1)")
                .bind(&[place.workspace.as_str().into()])?
                .run()
                .await?;
        }
        self.db
            .prepare(
                "INSERT INTO desktop_runners (workspace, machine, person, backend, version, diagnosis, closed, reported_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (workspace, machine) DO UPDATE SET person = ?3, backend = ?4, version = ?5, diagnosis = ?6, closed = ?7, reported_at = ?8",
            )
            .bind(&[
                place.workspace.as_str().into(),
                machine.as_str().into(),
                a.actor.username.as_str().into(),
                a.backend.as_str().into(),
                optional(a.version.as_deref().map(|v| clip(v, 40)).as_deref()),
                serde_json::to_string(&tidy(&a.diagnosis))?.into(),
                serde_json::to_string(&tidy(&a.closed))?.into(),
                rfc3339(at).into(),
            ])?
            .run()
            .await?;
        Ok(Outcome::Ok(true))
    }

    /// `desktop_runners`: the workspace's desktops, as each app last said.
    pub async fn desktop_runners(&self, a: DesktopRunnersArgs) -> Result<Outcome<Vec<DesktopRunner>>> {
        let owner = RunnersOwner { repo: None, workspace: Some(a.workspace.clone()) };
        let place = check!(self.runner_place(&a.actor, &owner, false).await?);
        #[derive(Deserialize)]
        struct Row {
            workspace: String,
            machine: String,
            person: String,
            backend: String,
            version: Option<String>,
            diagnosis: String,
            closed: String,
            reported_at: String,
        }
        let rows = self
            .db
            .prepare("SELECT * FROM desktop_runners WHERE workspace = ? ORDER BY lower(machine)")
            .bind(&[place.workspace.as_str().into()])?
            .all()
            .await?
            .results::<Row>()?;
        let open_since = rfc3339(now_ms().saturating_sub(model::DESKTOP_OPEN_WITHIN_MS));
        Ok(Outcome::Ok(
            rows.into_iter()
                .map(|row| DesktopRunner {
                    open: row.reported_at.as_str() > open_since.as_str(),
                    diagnosis: serde_json::from_str(&row.diagnosis).unwrap_or_default(),
                    closed: serde_json::from_str(&row.closed).unwrap_or_default(),
                    workspace: row.workspace,
                    machine: row.machine,
                    person: row.person,
                    backend: row.backend,
                    version: row.version,
                    reported_at: row.reported_at,
                })
                .collect(),
        ))
    }

    /// `set_runner_settings`.
    pub async fn set_runner_settings(&self, a: SetRunnerSettingsArgs) -> Result<Outcome<RunnerSettings>> {
        let place = check!(self.runner_place(&a.actor, &a.owner, true).await?);
        let (owner, scope) = match &place.repo {
            Some(repo) => (repo.id.clone(), "repository"),
            None => (place.workspace.clone(), "workspace"),
        };
        if a.inherit && place.repo.is_some() {
            self.db.prepare("DELETE FROM runner_settings WHERE owner = ?").bind(&[owner.as_str().into()])?.run().await?;
        } else {
            let current = self.effective_runner_settings(&place.workspace, place.repo.as_ref().map(|r| r.id.as_str())).await?;
            let labels = match &a.agent_labels {
                Some(given) => match model::runner_labels(given, model::SELF_HOSTED, model::SELF_HOSTED) {
                    Ok(labels) => labels,
                    Err(problem) => return Ok(fail(FailureCode::Invalid, problem)),
                },
                None => current.agent_labels.clone(),
            };
            let agents = a.agents_on_self_hosted.unwrap_or(current.agents_on_self_hosted);
            let forks = a.fork_pull_requests.unwrap_or(current.fork_pull_requests);
            let prefer_own = a.prefer_own_runners.unwrap_or(current.prefer_own_runners);
            self.db
                .prepare(
                    "INSERT INTO runner_settings (owner, scope, agents, agent_labels, fork_pulls, updated_at, updated_by, prefer_own)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                     ON CONFLICT (owner) DO UPDATE SET agents = ?3, agent_labels = ?4, fork_pulls = ?5, updated_at = ?6, updated_by = ?7, prefer_own = ?8",
                )
                .bind(&[
                    owner.as_str().into(),
                    scope.into(),
                    u32::from(agents).into(),
                    serde_json::to_string(&labels)?.into(),
                    u32::from(forks).into(),
                    now().into(),
                    a.actor.username.as_str().into(),
                    u32::from(prefer_own).into(),
                ])?
                .run()
                .await?;
        }
        let settings = self.effective_runner_settings(&place.workspace, place.repo.as_ref().map(|r| r.id.as_str())).await?;
        self.audit(vec![entry(
            AuditActor::of(&a.actor),
            "update_runner_settings",
            &place.workspace,
            place.repo.as_ref().map(|r| format!("{}/{}", r.namespace, r.name)),
            None,
            format!(
                "g1t's work on self-hosted runners: {}; labels {}; pull requests from forks: {}; hosted labels on own runners first: {}.",
                if settings.agents_on_self_hosted { "on" } else { "off" },
                settings.agent_labels.join(", "),
                if settings.fork_pull_requests { "allowed" } else { "not allowed" },
                if settings.prefer_own_runners { "on" } else { "off" }
            ),
        )])
        .await;
        Ok(Outcome::Ok(settings))
    }

    // --- The runner's side ---------------------------------------------------

    /// `runner_register`.
    pub async fn runner_register(&self, a: RegisterArgs) -> Result<Outcome<Registered>> {
        let refused = || {
            fail(
                FailureCode::Unauthenticated,
                "That registration token is not valid, or it expired. Make a new one under Settings, Runners.",
            )
        };
        if !a.token.starts_with(model::REGISTRATION_PREFIX) {
            return Ok(refused());
        }
        let registration = self
            .db
            .prepare("SELECT * FROM runner_registrations WHERE token_hash = ?")
            .bind(&[hash(&a.token).into()])?
            .first::<RegistrationRow>(None)
            .await?;
        let at = now_ms();
        let Some(registration) = registration.filter(|r| r.expires_at.as_str() > rfc3339(at).as_str()) else {
            return Ok(refused());
        };
        let name = match valid_name(&a.name) {
            Ok(name) => name,
            Err(problem) => return Ok(fail(FailureCode::Invalid, problem)),
        };
        let (Some(os), Some(arch)) = (model::os_label(&a.os), model::arch_label(&a.arch)) else {
            return Ok(fail(FailureCode::Invalid, "A runner's os is linux, macos or windows, and its arch x64 or arm64."));
        };
        let labels = match model::runner_labels(&a.labels, os, arch) {
            Ok(labels) => labels,
            Err(problem) => return Ok(fail(FailureCode::Invalid, problem)),
        };
        let workspace = registration.workspace.clone();
        // Abuse: so many machines, so fast, are not a team's.
        let recent = self
            .db
            .prepare("SELECT COUNT(*) AS n FROM runners WHERE workspace = ? AND created_at > ?")
            .bind(&[workspace.as_str().into(), rfc3339(at.saturating_sub(60 * 1000)).into()])?
            .first::<Count>(None)
            .await?
            .map_or(0, |c| c.n);
        if recent >= model::MAX_REGISTRATIONS_PER_MINUTE {
            return Ok(fail(FailureCode::Conflict, "Too many runners registered in the last minute. Wait a moment and try again."));
        }
        let total = self
            .db
            .prepare("SELECT COUNT(*) AS n FROM runners WHERE workspace = ?")
            .bind(&[workspace.as_str().into()])?
            .first::<Count>(None)
            .await?
            .map_or(0, |c| c.n);
        // A group: the one asked for, the token's, or the default.
        let group = if registration.repo_id.is_some() {
            None
        } else {
            match a.group.as_deref().map(str::trim).filter(|g| !g.is_empty()) {
                Some(wanted) => match self.find_group(&workspace, wanted).await? {
                    Some(group) => Some(group.id),
                    None => return Ok(fail(FailureCode::NotFound, format!("There is no runner group called {wanted}."))),
                },
                None => match registration.group_id.clone() {
                    Some(id) => Some(id),
                    None => Some(self.default_group(&workspace).await?.id),
                },
            }
        };
        let existing = self
            .db
            .prepare("SELECT * FROM runners WHERE workspace = ? AND COALESCE(repo_id, '') = ? AND lower(name) = lower(?)")
            .bind(&[workspace.as_str().into(), registration.repo_id.clone().unwrap_or_default().into(), name.as_str().into()])?
            .first::<RunnerRow>(None)
            .await?;
        let machine_hash = machine_hash(&workspace, a.machine.as_deref());
        if let Some(existing) = &existing {
            if !takes_over(existing, a.replace, machine_hash.as_deref(), registration.created_by.as_deref(), at) {
                let elsewhere = if existing.machine_hash.is_some() && machine_hash.is_some() { " from another computer" } else { "" };
                return Ok(fail(
                    FailureCode::Conflict,
                    format!(
                        "A runner called {name} is already registered here{elsewhere}. Register with --replace to take its place, or choose another --name."
                    ),
                ));
            }
            self.forget_runner(existing, &format!("The runner {name} was replaced by a new registration.")).await?;
        } else if total >= model::MAX_RUNNERS {
            return Ok(fail(FailureCode::Conflict, format!("A workspace has at most {} self-hosted runners.", model::MAX_RUNNERS)));
        }
        // How it keeps work from its machine, and what a job on it gets, if
        // it said (older runners do not).
        let isolation = a.isolation.as_deref().filter(|level| model::ISOLATIONS.contains(level));
        let capacity = kept_capacity(a.cpus, a.memory_mib, a.docker, a.hosted_image);
        let sizes = a.sizes.as_deref().map(sized);
        let id = new_id("rnr", at);
        let credential = format!("{}{}", model::CREDENTIAL_PREFIX, random_hex(32));
        let created = rfc3339(at);
        self.db
            .prepare(
                "INSERT INTO runners (id, workspace, repo_id, repo, group_id, name, labels, os, arch, version, ephemeral, credential_hash,
                   rotated_at, last_seen_at, created_at, created_by, isolation, machine_hash, cpus, memory_mib, docker, sizes, hosted_image)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                id.as_str().into(),
                workspace.as_str().into(),
                optional(registration.repo_id.as_deref()),
                optional(registration.repo.as_deref()),
                optional(group.as_deref()),
                name.as_str().into(),
                serde_json::to_string(&labels)?.into(),
                os.into(),
                arch.into(),
                a.version.chars().take(40).collect::<String>().into(),
                u32::from(a.ephemeral).into(),
                hash(&credential).into(),
                created.as_str().into(),
                created.as_str().into(),
                created.as_str().into(),
                // The person who made the token: a desktop's runner is theirs.
                optional(registration.created_by.as_deref()),
                optional(isolation),
                optional(machine_hash.as_deref()),
                capacity.cpus.map_or(JsValue::NULL, JsValue::from),
                capacity.memory_mib.map_or(JsValue::NULL, |mib| JsValue::from(mib as f64)),
                capacity.docker.map_or(JsValue::NULL, |docker| JsValue::from(u32::from(docker))),
                optional(sizes.as_deref()),
                capacity.hosted_image.map_or(JsValue::NULL, |image| JsValue::from(u32::from(image))),
            ])?
            .run()
            .await?;
        self.db
            .prepare("UPDATE runner_registrations SET used = used + 1 WHERE token_hash = ?")
            .bind(&[hash(&a.token).into()])?
            .run()
            .await?;
        let row = self.runner_by_id(&id).await?.ok_or_else(|| worker::Error::RustError("the runner was not kept".into()))?;
        self.audit(vec![entry(
            runner_actor(&row),
            "register_runner",
            &workspace,
            row.repo.clone(),
            Some(name.clone()),
            format!("Registered the self-hosted runner {name} ({os}, {arch}; labels {}).", labels.join(", ")),
        )])
        .await;
        let groups = self.group_rows(&workspace).await?;
        Ok(Outcome::Ok(Registered { runner: self.runner_view(&row, &groups, at).await?, credential }))
    }

    /// The runner a call is from, if its credential is that runner's (or
    /// the one before a rotation, until the new one is used).
    async fn authenticated(&self, auth: &RunnerAuth) -> Result<Option<(RunnerRow, bool)>> {
        if !auth.credential.starts_with(model::CREDENTIAL_PREFIX) {
            return Ok(None);
        }
        let Some(row) = self.runner_by_id(&auth.runner).await? else { return Ok(None) };
        let given = hash(&auth.credential);
        if g1t_secrets::same(&row.credential_hash, &given) {
            if row.previous_hash.is_some() {
                self.db.prepare("UPDATE runners SET previous_hash = NULL WHERE id = ?").bind(&[row.id.as_str().into()])?.run().await?;
            }
            return Ok(Some((row, true)));
        }
        if row.previous_hash.as_deref().is_some_and(|previous| g1t_secrets::same(previous, &given)) {
            return Ok(Some((row, false)));
        }
        Ok(None)
    }

    fn unknown_runner<T>() -> Outcome<T> {
        fail(FailureCode::Unauthenticated, "This runner is not registered, or its credential is not valid. Register it again.")
    }

    /// `runner_poll`.
    pub async fn runner_poll(&self, a: PollArgs) -> Result<Outcome<Poll>> {
        let Some((row, current)) = self.authenticated(&a.auth).await? else {
            return Ok(Self::unknown_runner());
        };
        let at = now_ms();
        let seen = rfc3339(at);
        // A new credential every day, handed over on a poll that used the
        // current one.
        let mut credential = None;
        let rotate_after = rfc3339(at.saturating_sub(model::ROTATE_AFTER_MS));
        if current && row.rotated_at.as_str() < rotate_after.as_str() {
            let fresh = format!("{}{}", model::CREDENTIAL_PREFIX, random_hex(32));
            self.db
                .prepare("UPDATE runners SET previous_hash = credential_hash, credential_hash = ?, rotated_at = ? WHERE id = ?")
                .bind(&[hash(&fresh).into(), seen.as_str().into(), row.id.as_str().into()])?
                .run()
                .await?;
            credential = Some(fresh);
        }
        // What it holds that it should stop, and the heartbeat for the rest.
        let mut cancel = Vec::new();
        let mut active: Option<(String, &'static str)> = None;
        for id in a.running.iter().take(10) {
            if let Some(job) = self.db.prepare("SELECT * FROM jobs WHERE id = ?").bind(&[id.as_str().into()])?.first::<JobRow>(None).await?
            {
                if job.status == "in_progress" && job.runner_id.as_deref() == Some(row.id.as_str()) {
                    if seen_is_stale(job.seen_at.as_deref(), at) {
                        self.db
                            .prepare("UPDATE jobs SET seen_at = ? WHERE id = ?")
                            .bind(&[seen.as_str().into(), id.as_str().into()])?
                            .run()
                            .await?;
                    }
                    active = Some((id.clone(), "workflow"));
                } else if stops_on_poll(&job, &row.id, at) {
                    cancel.push(id.clone());
                }
                continue;
            }
            match self.db.prepare("SELECT * FROM runner_tasks WHERE id = ?").bind(&[id.as_str().into()])?.first::<TaskRow>(None).await? {
                Some(task) if task.status == "in_progress" && task.runner_id.as_deref() == Some(row.id.as_str()) => {
                    if seen_is_stale(task.seen_at.as_deref(), at) {
                        self.db
                            .prepare("UPDATE runner_tasks SET seen_at = ? WHERE id = ?")
                            .bind(&[seen.as_str().into(), id.as_str().into()])?
                            .run()
                            .await?;
                    }
                    active = Some((id.clone(), "agent"));
                }
                _ => cancel.push(id.clone()),
            }
        }
        // Written when something changed, or once a minute to keep it online.
        let version: String = if a.version.is_empty() { row.version.clone() } else { a.version.chars().take(40).collect() };
        let work_id = active.as_ref().map(|(id, _)| id.as_str());
        let work_kind = active.as_ref().map(|(_, kind)| *kind);
        // How it is isolated, as it says now: a runner re-registered or
        // restarted with or without Docker says so on its next poll.
        let isolation =
            a.isolation.as_deref().filter(|level| model::ISOLATIONS.contains(level)).map(str::to_owned).or_else(|| row.isolation.clone());
        // And what a job on it gets: a runner given more memory says so.
        let said = kept_capacity(a.cpus, a.memory_mib, a.docker, a.hosted_image);
        let cpus = said.cpus.or(row.cpus);
        let memory_mib = said.memory_mib.or(row.memory_mib);
        let docker = said.docker.map(u32::from).or(row.docker);
        // A runner that stops saying it (one downgraded) no longer has it.
        let hosted_image = said.hosted_image.map(u32::from);
        // And the sizes it takes: changed in its settings, they count from now.
        let sizes = a.sizes.as_deref().map(sized).or_else(|| row.sizes.clone());
        let changed = version != row.version
            || work_id != row.work_id.as_deref()
            || work_kind != row.work_kind.as_deref()
            || isolation != row.isolation
            || (cpus, memory_mib, docker) != (row.cpus, row.memory_mib, row.docker)
            || sizes != row.sizes
            || hosted_image != row.hosted_image;
        if changed || seen_is_stale(row.last_seen_at.as_deref(), at) {
            self.db
                .prepare(
                    "UPDATE runners SET last_seen_at = ?, version = ?, work_id = ?, work_kind = ?, isolation = ?, cpus = ?, memory_mib = ?, docker = ?, sizes = ?, hosted_image = ? WHERE id = ?",
                )
                .bind(&[
                    seen.as_str().into(),
                    version.into(),
                    optional(work_id),
                    optional(work_kind),
                    optional(isolation.as_deref()),
                    cpus.map_or(JsValue::NULL, JsValue::from),
                    memory_mib.map_or(JsValue::NULL, |mib| JsValue::from(mib as f64)),
                    docker.map_or(JsValue::NULL, JsValue::from),
                    optional(sizes.as_deref()),
                    hosted_image.map_or(JsValue::NULL, JsValue::from),
                    row.id.as_str().into(),
                ])?
                .run()
                .await?;
        }
        let row = RunnerRow { isolation, cpus, memory_mib, docker, sizes, hosted_image, ..row };
        let mut poll = Poll { assignment: None, cancel, credential, removed: false };
        // Busy, or an ephemeral runner that has had its one job.
        if active.is_some() || !a.running.is_empty() {
            return Ok(Outcome::Ok(poll));
        }
        if row.ephemeral != 0 && row.spent != 0 {
            self.forget_runner(&row, "The ephemeral runner finished its job.").await?;
            poll.removed = true;
            return Ok(Outcome::Ok(poll));
        }
        let groups = self.group_rows(&row.workspace).await?;
        let group = row.group_id.as_ref().and_then(|id| groups.iter().find(|g| &g.id == id)).cloned();
        let deadline = at + a.wait_ms.min(model::MAX_POLL_WAIT_MS);
        let mut looked = Looked::default();
        loop {
            if let Some(assignment) = self.claim(&row, group.as_ref(), &mut looked).await? {
                poll.assignment = Some(assignment);
                return Ok(Outcome::Ok(poll));
            }
            if now_ms() + POLL_EVERY_MS > deadline {
                return Ok(Outcome::Ok(poll));
            }
            worker::Delay::from(std::time::Duration::from_millis(POLL_EVERY_MS)).await;
        }
    }

    /// Takes the oldest work this runner can do, if there is any.
    async fn claim(&self, runner: &RunnerRow, group: Option<&GroupRow>, looked: &mut Looked) -> Result<Option<Assignment>> {
        let labels = runner.labels();
        let group_name = group.map(|g| g.name.clone());
        // Workflow jobs.
        let mut sql = "SELECT jobs.*, runs.repo AS run_repo FROM jobs JOIN runs ON runs.id = jobs.run_id
                       WHERE jobs.status = 'queued' AND jobs.labels IS NOT NULL AND lower(jobs.namespace) = ?"
            .to_owned();
        let mut binds: Vec<JsValue> = vec![runner.workspace.as_str().into()];
        if let Some(repo_id) = &runner.repo_id {
            sql.push_str(" AND jobs.repo_id = ?");
            binds.push(repo_id.as_str().into());
        }
        // One job of a concurrency group runs at a time.
        sql.push_str(
            " AND (jobs.concurrency_group IS NULL OR NOT EXISTS (SELECT 1 FROM jobs o WHERE o.repo_id = jobs.repo_id
               AND o.concurrency_group = jobs.concurrency_group AND o.status IN ('in_progress', 'calling')))",
        );
        sql.push_str(" ORDER BY jobs.rowid LIMIT 50");
        #[derive(Deserialize)]
        struct Queued {
            #[serde(flatten)]
            job: JobRow,
            run_repo: String,
        }
        let mut queued = self.db.prepare(sql).bind(&binds)?.all().await?.results::<Queued>()?;
        // A workspace without the plan runs FREE_SELF_HOSTED_JOBS of its jobs
        // on its own runners at once (limits.rs). Billing is asked only once
        // that many are going, so a runner's poll stays cheap.
        if !queued.is_empty() && self.limits.free_self_hosted_jobs > 0 {
            let running = self
                .db
                .prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'in_progress' AND runner_id IS NOT NULL AND lower(namespace) = ?")
                .bind(&[runner.workspace.as_str().into()])?
                .first::<Count>(None)
                .await?
                .map_or(0, |c| c.n);
            if !crate::limits::self_hosted_room(running as u64, self.limits.free_self_hosted_jobs)
                && self.standing(&runner.workspace).await.is_some_and(|standing| !standing.has_plan)
            {
                // Its workflow jobs wait for one to finish; anything else the
                // runner takes (below) is not held back.
                queued.clear();
            }
        }
        for Queued { job, run_repo } in queued {
            let stored: Vec<String> = job.labels.as_deref().and_then(|l| serde_json::from_str(l).ok()).unwrap_or_default();
            let wanted = Wanted::from_stored(&stored);
            if !wanted.matches(&labels, group_name.as_deref()) {
                continue;
            }
            if runner.repo_id.is_none() && !group.is_none_or(|g| g.allows(&run_repo)) {
                continue;
            }
            // A job that asked for one of g1t's machines, offered to the
            // workspace's runners first: only one that takes that machine's
            // size (or, saying no sizes, is as large), with Docker if it uses
            // it, takes it, and a host-mode runner only a repository known to
            // be private. The rest run on g1t's.
            let offered = job.fallback_instance.is_some();
            let mut size: Option<model::OfferedSize> = None;
            if let Some(instance) = job.fallback_instance.as_deref() {
                let machine = g1t_contracts::actions::instance_named(instance).unwrap_or(g1t_contracts::actions::STANDARD_INSTANCE);
                let visibility = match runner.isolation.as_deref() {
                    Some("host") => self.visibility_once(looked, &job.repo_id).await,
                    _ => None,
                };
                let sizes = runner.sizes();
                if !model::stands_in_for(
                    runner.capacity(),
                    sizes.as_deref(),
                    runner.isolation.as_deref(),
                    visibility.as_deref(),
                    &machine,
                    job.needs_docker != 0,
                ) {
                    continue;
                }
                // Taken for that size: its sandbox is the size's, or what the
                // runner gives that size.
                size = sizes.iter().flatten().find(|offered| offered.size == machine.machine).and_then(model::OfferedSize::assigned);
            } else if runner.isolation.as_deref() == Some("host") {
                // A host-mode runner takes no public repository's job: it
                // waits for a sandboxed runner, and says so when none could.
                let visibility = self.visibility_once(looked, &job.repo_id).await;
                if !model::isolation_allows(runner.isolation.as_deref(), visibility.as_deref()) {
                    if looked.noted.insert(job.id.clone()) {
                        self.wait_for_sandbox(&job, &run_repo, &wanted).await?;
                    }
                    continue;
                }
            }
            if let Some(max) = job.max_parallel {
                let siblings = self
                    .db
                    .prepare("SELECT COUNT(*) AS n FROM jobs WHERE run_id = ? AND key = ? AND status = 'in_progress'")
                    .bind(&[job.run_id.as_str().into(), job.key.as_str().into()])?
                    .first::<Count>(None)
                    .await?
                    .map_or(0, |c| c.n);
                if siblings >= max {
                    continue;
                }
            }
            let token = random_hex(24);
            let at = now();
            let claimed = self
                .db
                .prepare(RUNNER_CLAIM)
                .bind(&[
                    sha256_hex(&token).into(),
                    runner.id.as_str().into(),
                    runner.name.as_str().into(),
                    at.as_str().into(),
                    job.id.as_str().into(),
                ])?
                .first::<Value>(None)
                .await?;
            if claimed.is_none() {
                continue;
            }
            self.db
                .batch(vec![
                    self.db
                        .prepare("UPDATE runs SET status = 'in_progress', started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'queued'")
                        .bind(&[at.as_str().into(), job.run_id.as_str().into()])?,
                    self.db
                        .prepare("UPDATE runners SET work_id = ?, work_kind = 'workflow', spent = ephemeral WHERE id = ?")
                        .bind(&[job.id.as_str().into(), runner.id.as_str().into()])?,
                ])
                .await?;
            self.audit(vec![entry(
                runner_actor(runner),
                "runner.take_job",
                &runner.workspace,
                Some(run_repo.clone()),
                Some(job.name.clone()),
                format!("The self-hosted runner {} took the job {}.", runner.name, job.name),
            )])
            .await;
            // It says in "Set up job" why it is here and not on g1t's machine.
            if offered {
                self.note_log(
                    &job.id,
                    0,
                    &format!("{}\n", model::on_own_runner_note(&runner.name, size.as_ref(), runner.isolation.as_deref())),
                )
                .await?;
            }
            // A job that deploys: its run's deployment is under way.
            self.job_started(&job.id).await?;
            let image = self.job_image(&job).await?;
            let visibility = self.visibility(&job.repo_id).await;
            return Ok(Some(Assignment {
                kind: "workflow".into(),
                id: job.id.clone(),
                name: job.name.clone(),
                repo: run_repo,
                timeout_minutes: job.timeout_minutes,
                image,
                token: Some(token),
                env: None,
                visibility,
                size,
            }));
        }

        // Agent work.
        let tasks = self
            .db
            .prepare("SELECT * FROM runner_tasks WHERE status = 'queued' AND workspace = ? ORDER BY created_at LIMIT 20")
            .bind(&[runner.workspace.as_str().into()])?
            .all()
            .await?
            .results::<TaskRow>()?;
        for task in tasks {
            let wanted = Wanted::of(&serde_json::from_str::<Vec<String>>(&task.labels).unwrap_or_default(), None);
            if !wanted.matches(&labels, None) {
                continue;
            }
            // Nor a public repository's agent work.
            if runner.isolation.as_deref() == Some("host")
                && let Some(repo_id) = &task.repo_id
            {
                let visibility = self.visibility_once(looked, repo_id).await;
                if !model::isolation_allows(runner.isolation.as_deref(), visibility.as_deref()) {
                    continue;
                }
            }
            if let Some(repo_id) = &runner.repo_id
                && task.repo_id.as_deref() != Some(repo_id.as_str())
            {
                continue;
            }
            if runner.repo_id.is_none() && !group.is_none_or(|g| g.allows(&task.repo)) {
                continue;
            }
            let Some(sealed) = task.env.clone() else { continue };
            let at = now();
            let claimed = self
                .db
                .prepare(
                    "UPDATE runner_tasks SET status = 'in_progress', runner_id = ?, runner_name = ?, env = NULL, started_at = ?, seen_at = ?
                     WHERE id = ? AND status = 'queued' RETURNING id",
                )
                .bind(&[runner.id.as_str().into(), runner.name.as_str().into(), at.as_str().into(), at.as_str().into(), task.id.as_str().into()])?
                .first::<Value>(None)
                .await?;
            if claimed.is_none() {
                continue;
            }
            self.db
                .prepare("UPDATE runners SET work_id = ?, work_kind = 'agent', spent = ephemeral WHERE id = ?")
                .bind(&[task.id.as_str().into(), runner.id.as_str().into()])?
                .run()
                .await?;
            let env: Map<String, Value> = self
                .sealer
                .as_ref()
                .and_then(|sealer| sealer.open(&sealed, &task.id))
                .and_then(|text| serde_json::from_str(&text).ok())
                .unwrap_or_default();
            if env.is_empty() {
                self.end_task(&TaskRow { status: "in_progress".into(), ..task.clone() }, 1, "The work's environment could not be opened.")
                    .await?;
                continue;
            }
            self.audit(vec![entry(
                runner_actor(runner),
                "runner.take_task",
                &runner.workspace,
                Some(task.repo.clone()),
                Some(task.kind.clone()),
                format!("The self-hosted runner {} took agent work: {}.", runner.name, task.title),
            )])
            .await;
            let visibility = match &task.repo_id {
                Some(repo_id) => self.visibility(repo_id).await,
                None => None,
            };
            return Ok(Some(Assignment {
                kind: "agent".into(),
                id: task.id.clone(),
                name: task.title.clone(),
                repo: task.repo.clone(),
                timeout_minutes: task.timeout_minutes,
                image: None,
                token: None,
                env: Some(env),
                visibility,
                size: None,
            }));
        }
        Ok(None)
    }

    /// [`Self::visibility`], asked once per repository in a poll.
    async fn visibility_once(&self, looked: &mut Looked, repo_id: &str) -> Option<String> {
        if let Some(known) = looked.visibilities.get(repo_id) {
            return known.clone();
        }
        let found = self.visibility(repo_id).await;
        looked.visibilities.insert(repo_id.to_owned(), found.clone());
        found
    }

    /// Whether one of the workspace's runners could take `job`, offered to
    /// them in place of one of g1t's machines, now: online and idle, its
    /// repository or group lets the job's repository use it, it is of the
    /// job's OS and architecture and as large as the machine, and the
    /// workspace's plan lets its runners take one more job. Otherwise the
    /// job runs on g1t's machine at once.
    pub(crate) async fn own_runner_free(&self, job: &JobRow, run_repo: &str, at: u64) -> Result<bool> {
        let Some(instance) = job.fallback_instance.as_deref() else { return Ok(false) };
        let machine = g1t_contracts::actions::instance_named(instance).unwrap_or(g1t_contracts::actions::STANDARD_INSTANCE);
        let stored: Vec<String> = job.labels.as_deref().and_then(|l| serde_json::from_str(l).ok()).unwrap_or_default();
        let wanted = Wanted::from_stored(&stored);
        let workspace = job.namespace.to_lowercase();
        let groups = self.group_rows(&workspace).await?;
        let runners = self.runner_rows(&workspace).await?;
        // A repository's visibility is asked only for a host-mode runner,
        // the one kind that may take a private repository's job alone.
        let visibility = if runners.iter().any(|r| r.isolation.as_deref() == Some("host") && r.online(at)) {
            self.visibility(&job.repo_id).await
        } else {
            None
        };
        let free = runners.iter().any(|runner| {
            takes_offered_job(runner, &groups, &job.repo_id, run_repo, &wanted, &machine, job.needs_docker != 0, visibility.as_deref(), at)
        });
        if !free || self.limits.free_self_hosted_jobs == 0 {
            return Ok(free);
        }
        // Past the free plan's runners' share, the job runs on g1t's machine
        // rather than wait for one of them (`claim` holds them back).
        let running = self
            .db
            .prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'in_progress' AND runner_id IS NOT NULL AND lower(namespace) = ?")
            .bind(&[workspace.as_str().into()])?
            .first::<Count>(None)
            .await?
            .map_or(0, |c| c.n);
        if crate::limits::self_hosted_room(running as u64, self.limits.free_self_hosted_jobs) {
            return Ok(true);
        }
        Ok(self.standing(&workspace).await.is_some_and(|standing| standing.has_plan))
    }

    /// A public repository's job that a host-mode runner passed over: when
    /// no online runner that may take it could (its labels, group,
    /// repository, and isolation), its page says it waits for a sandboxed
    /// one. Written only when that changes what it says.
    async fn wait_for_sandbox(&self, job: &JobRow, run_repo: &str, wanted: &Wanted) -> Result<()> {
        let at = now_ms();
        let groups = self.group_rows(&job.namespace.to_lowercase()).await?;
        let runners = self.runner_rows(&job.namespace.to_lowercase()).await?;
        let sandboxed = runners.iter().any(|other| takes_public_job(other, &groups, &job.repo_id, run_repo, wanted, at));
        if sandboxed {
            return Ok(());
        }
        self.db
            .prepare("UPDATE jobs SET reason = ? WHERE id = ? AND status = 'queued' AND reason IS NOT ?")
            .bind(&[model::WAITING_FOR_SANDBOX.into(), job.id.as_str().into(), model::WAITING_FOR_SANDBOX.into()])?
            .run()
            .await?;
        Ok(())
    }

    /// A repository's visibility for a runner, `public` or `private`; none
    /// when it cannot be read, and the runner decides without it.
    async fn visibility(&self, repo_id: &str) -> Option<String> {
        match self.repo_by_id(repo_id).await {
            Ok(Some((repo, _))) => Some(if repo.is_private { "private" } else { "public" }.to_owned()),
            _ => None,
        }
    }

    /// The image a job's `container:` names, when it names one plainly.
    async fn job_image(&self, job: &JobRow) -> Result<Option<String>> {
        let Some(run) = self.run_row(&job.run_id).await? else { return Ok(None) };
        let raw = match job.callee() {
            Some((_, spec, _)) => spec.raw,
            None => match g1t_actions::workflow::parse(&run.source) {
                Ok(workflow) => match workflow.jobs.into_iter().find(|j| j.id == job.key) {
                    Some(spec) => spec.raw,
                    None => return Ok(None),
                },
                Err(_) => return Ok(None),
            },
        };
        let image = match raw.get("container") {
            Some(Value::String(image)) => Some(image.clone()),
            Some(Value::Object(container)) => container.get("image").and_then(Value::as_str).map(str::to_owned),
            _ => None,
        };
        Ok(image.filter(|image| !image.contains("${{") && !image.trim().is_empty()))
    }

    /// `runner_finished`.
    pub async fn runner_finished(&self, a: FinishedArgs) -> Result<Outcome<bool>> {
        let Some((row, _)) = self.authenticated(&a.auth).await? else {
            return Ok(Self::unknown_runner());
        };
        let reason = a.reason.clone().filter(|r| !r.trim().is_empty()).map(|r| r.chars().take(2000).collect::<String>());
        let mut changed = false;
        if let Some(job) = self.db.prepare("SELECT * FROM jobs WHERE id = ?").bind(&[a.id.as_str().into()])?.first::<JobRow>(None).await? {
            if job.runner_id.as_deref() == Some(row.id.as_str()) && job.status == "in_progress" {
                let why = reason.unwrap_or_else(|| {
                    format!("The job's process on {} exited with code {} before it reported how the job went.", row.name, a.exit_code)
                });
                self.finish_job(&job.id, "failure", Some(&why), None).await?;
                changed = true;
            }
        } else if let Some(task) =
            self.db.prepare("SELECT * FROM runner_tasks WHERE id = ?").bind(&[a.id.as_str().into()])?.first::<TaskRow>(None).await?
            && task.runner_id.as_deref() == Some(row.id.as_str())
            && task.status == "in_progress"
        {
            let why = reason.unwrap_or_else(|| {
                if a.exit_code == 0 { String::new() } else { format!("The work exited with code {} on {}.", a.exit_code, row.name) }
            });
            self.end_task(&task, a.exit_code, &why).await?;
            changed = true;
        }
        self.db
            .prepare("UPDATE runners SET work_id = NULL, work_kind = NULL, last_seen_at = ? WHERE id = ? AND work_id = ?")
            .bind(&[now().into(), row.id.as_str().into(), a.id.as_str().into()])?
            .run()
            .await?;
        Ok(Outcome::Ok(changed))
    }

    /// `runner_remove_self`.
    pub async fn runner_remove_self(&self, a: RemoveSelfArgs) -> Result<Outcome<bool>> {
        let Some((row, _)) = self.authenticated(&a.auth).await? else {
            return Ok(Self::unknown_runner());
        };
        self.forget_runner(&row, &format!("The runner {} was removed from its machine.", row.name)).await?;
        self.audit(vec![entry(
            runner_actor(&row),
            "remove_runner",
            &row.workspace,
            row.repo.clone(),
            Some(row.name.clone()),
            format!("The self-hosted runner {} removed itself.", row.name),
        )])
        .await;
        Ok(Outcome::Ok(true))
    }

    /// A self-hosted job finished, however it did: its runner is free, and
    /// its time goes on the workspace's usage as self-hosted, at $0.
    pub async fn released(&self, job: &JobRow) -> Result<()> {
        let Some(runner_id) = &job.runner_id else { return Ok(()) };
        self.db
            .prepare("UPDATE runners SET work_id = NULL, work_kind = NULL WHERE id = ? AND work_id = ?")
            .bind(&[runner_id.as_str().into(), job.id.as_str().into()])?
            .run()
            .await?;
        let (Some(started), Some(finished)) =
            (job.started_at.as_deref(), job.finished_at.as_deref().map(str::to_owned).or_else(|| Some(now())))
        else {
            return Ok(());
        };
        let seconds = match (g1t_contracts::time::parse_rfc3339(started), g1t_contracts::time::parse_rfc3339(&finished)) {
            (Some(a), Some(b)) if b > a => ((b - a) / 1000).max(1),
            _ => 1,
        };
        let run = self.run_row(&job.run_id).await?;
        let repo = run.as_ref().map(|r| r.repo.clone());
        let recorded: Result<Outcome<bool>> = g1t_kit::call(
            &self.billing,
            "record_sandbox",
            &RecordSandboxArgs {
                workspace: job.namespace.to_lowercase(),
                seconds: u32::try_from(seconds).unwrap_or(u32::MAX),
                description: format!(
                    "{} in {} on the self-hosted runner {}",
                    job.name,
                    repo.clone().unwrap_or_default(),
                    job.runner_name.clone().unwrap_or_default()
                ),
                repo,
                reference: format!("selfhosted/{}/{}", job.id, started),
                kind: Some(ComputeKind::Workflow),
                cpu_seconds: None,
                reservation_id: None,
                self_hosted: true,
                instance: None,
            },
        )
        .await;
        if let Err(error) = recorded {
            worker::console_error!("actions: self-hosted time not recorded for {}: {error}", job.id);
        }
        Ok(())
    }

    /// `runner` and `RUNNER_*` for a job on a self-hosted runner.
    pub async fn runner_context_for(&self, runner_id: &str, variables: &mut Map<String, Value>) -> Result<Value> {
        let mut context = g1t_actions::events::runner_context();
        let Some(runner) = self.runner_by_id(runner_id).await? else { return Ok(context) };
        let os = match runner.os.as_str() {
            "macos" => "macOS",
            "windows" => "Windows",
            _ => "Linux",
        };
        let arch = if runner.arch == "arm64" { "ARM64" } else { "X64" };
        context["name"] = json!(runner.name);
        context["os"] = json!(os);
        context["arch"] = json!(arch);
        context["environment"] = json!("self-hosted");
        {
            let vars = variables;
            vars.insert("RUNNER_NAME".into(), json!(runner.name));
            vars.insert("RUNNER_OS".into(), json!(os));
            vars.insert("RUNNER_ARCH".into(), json!(arch));
            vars.insert("RUNNER_ENVIRONMENT".into(), json!("self-hosted"));
        }
        Ok(context)
    }

    // --- Agent work, for the runner service ----------------------------------

    /// `runner_route`: the labels g1t's own work in `repo` runs on, when
    /// its workspace (or the repository) sends it to self-hosted runners.
    pub async fn runner_route(&self, a: RouteArgs) -> Result<Option<Vec<String>>> {
        let repo_id = match self.repo_by_path(&a.repo).await? {
            Some(repo) => Some(repo.id),
            None => None,
        };
        let settings = self.effective_runner_settings(&a.workspace, repo_id.as_deref()).await?;
        Ok(settings.agents_on_self_hosted.then_some(settings.agent_labels))
    }

    async fn repo_by_path(&self, path: &RepoPath) -> Result<Option<Repo>> {
        let Some(actor) = self.workspace_actor(&path.namespace).await? else { return Ok(None) };
        self.visible_repo(path, &Some(actor)).await
    }

    /// `enqueue_task`.
    pub async fn enqueue_task(&self, a: EnqueueTaskArgs) -> Result<Outcome<String>> {
        let Some(sealer) = &self.sealer else {
            return Ok(fail(FailureCode::Conflict, "Agent work cannot be handed to self-hosted runners yet: g1t's key for it is not set."));
        };
        let id = new_id("rtk", now_ms());
        let sealed = sealer.seal(&serde_json::to_string(&a.env)?, &id);
        let repo_id = self.repo_by_path(&a.repo).await?.map(|r| r.id);
        let labels = match model::runner_labels(&a.labels, model::SELF_HOSTED, model::SELF_HOSTED) {
            Ok(labels) => labels,
            Err(problem) => return Ok(fail(FailureCode::Invalid, problem)),
        };
        let at = now();
        let inserted = self
            .db
            .prepare(
                "INSERT OR IGNORE INTO runner_tasks (id, sandbox, workspace, repo_id, repo, kind, title, labels, env, timeout_minutes, status, created_at, run_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?) RETURNING id",
            )
            .bind(&[
                id.as_str().into(),
                a.sandbox.as_str().into(),
                a.workspace.to_lowercase().into(),
                optional(repo_id.as_deref()),
                format!("{}/{}", a.repo.namespace, a.repo.name).into(),
                a.kind.as_str().into(),
                a.title.chars().take(300).collect::<String>().into(),
                serde_json::to_string(&labels)?.into(),
                sealed.into(),
                a.timeout_minutes.max(1).into(),
                at.into(),
                optional(a.run_id.as_deref().filter(|id| !id.is_empty())),
            ])?
            .first::<Value>(None)
            .await?;
        if inserted.is_none() {
            return Ok(fail(FailureCode::Conflict, "That sandbox already handed work to a self-hosted runner."));
        }
        Ok(Outcome::Ok(id))
    }

    /// `cancel_task`: the sandbox stopped it. Its runner hears on its next
    /// poll; the sandbox does its own ending.
    pub async fn cancel_task(&self, a: CancelTaskArgs) -> Result<Outcome<bool>> {
        let done = self
            .db
            .prepare(
                "UPDATE runner_tasks SET status = 'completed', exit_code = -1, reason = ?, env = NULL, finished_at = ?
                 WHERE sandbox = ? AND status != 'completed' RETURNING id",
            )
            .bind(&[optional(a.reason.as_deref()), now().into(), a.sandbox.as_str().into()])?
            .first::<Value>(None)
            .await?;
        Ok(Outcome::Ok(done.is_some()))
    }

    /// Ends a task and tells the sandbox waiting on it, once.
    async fn end_task(&self, task: &TaskRow, exit_code: i32, reason: &str) -> Result<()> {
        let ended = self
            .db
            .prepare(
                "UPDATE runner_tasks SET status = 'completed', exit_code = ?, reason = ?, env = NULL, finished_at = ?
                 WHERE id = ? AND status != 'completed' RETURNING id",
            )
            .bind(&[exit_code.into(), optional(Some(reason).filter(|r| !r.is_empty())), now().into(), task.id.as_str().into()])?
            .first::<Value>(None)
            .await?;
        if ended.is_none() {
            return Ok(());
        }
        if let Some(runner_id) = &task.runner_id {
            self.db
                .prepare("UPDATE runners SET work_id = NULL, work_kind = NULL WHERE id = ? AND work_id = ?")
                .bind(&[runner_id.as_str().into(), task.id.as_str().into()])?
                .run()
                .await?;
        }
        let told: Result<Value> = g1t_kit::call(
            &self.runner,
            "task_ended",
            &json!({
                "sandbox": task.sandbox,
                "exitCode": exit_code,
                "reason": if reason.is_empty() { Value::Null } else { json!(reason) },
                "runner": task.runner_name,
            }),
        )
        .await;
        if let Err(error) = told {
            worker::console_error!("actions: the sandbox waiting on task {} was not told: {error}", task.id);
        }
        Ok(())
    }

    /// `runner_activity`: what runs for the workspace now, in g1t's
    /// sandboxes and handed to its own runners. Its owners only, as its
    /// runners are.
    pub async fn runner_activity(&self, a: RunnerActivityArgs) -> Result<Outcome<RunnerActivity>> {
        let owner = RunnersOwner { repo: None, workspace: Some(a.workspace.clone()) };
        let place = check!(self.runner_place(&a.actor, &owner, false).await?);
        let workspace = place.workspace;
        let cloud_jobs = self
            .db
            .prepare(
                "SELECT jobs.id, jobs.name, jobs.run_id, runs.repo, jobs.started_at FROM jobs JOIN runs ON runs.id = jobs.run_id
                 WHERE lower(jobs.namespace) = ? AND jobs.status = 'in_progress' AND jobs.labels IS NULL
                 ORDER BY jobs.started_at DESC LIMIT ?",
            )
            .bind(&[workspace.as_str().into(), ACTIVITY_LIMIT.into()])?
            .all()
            .await?
            .results::<CloudJob>()?;
        let cloud_jobs_queued = self.queued_jobs(&workspace, false).await?;
        let self_hosted_jobs_queued = self.queued_jobs(&workspace, true).await?;
        let handed_over = self
            .db
            .prepare(
                "SELECT id, run_id, kind, title, repo, status, runner_name, created_at, started_at FROM runner_tasks
                 WHERE status IN ('queued', 'in_progress') AND workspace = ?
                 ORDER BY created_at DESC LIMIT ?",
            )
            .bind(&[workspace.as_str().into(), ACTIVITY_LIMIT.into()])?
            .all()
            .await?
            .results::<HandedOverTask>()?;
        Ok(Outcome::Ok(RunnerActivity { cloud_jobs, cloud_jobs_queued, handed_over, self_hosted_jobs_queued }))
    }

    /// The workspace's workflow jobs queued for its own runners
    /// (`labelled`), or for g1t's sandboxes. A job offered to its runners
    /// in place of g1t's machine runs on one or the other, at most seconds
    /// later: it counts with g1t's.
    async fn queued_jobs(&self, workspace: &str, labelled: bool) -> Result<u32> {
        let sql = if labelled {
            "SELECT COUNT(*) AS n FROM jobs WHERE lower(namespace) = ? AND status = 'queued' AND labels IS NOT NULL AND fallback_instance IS NULL"
        } else {
            "SELECT COUNT(*) AS n FROM jobs WHERE lower(namespace) = ? AND status = 'queued' AND (labels IS NULL OR fallback_instance IS NOT NULL)"
        };
        Ok(self.db.prepare(sql).bind(&[workspace.into()])?.first::<Count>(None).await?.map_or(0, |c| c.n))
    }

    /// `stuck_jobs`: jobs of the viewer's workspaces that have waited ten
    /// minutes or more for a self-hosted runner while none that could take
    /// them is online, for Mission control's Needs you.
    pub async fn stuck_jobs(&self, a: StuckJobsArgs) -> Result<Vec<StuckJob>> {
        let Some(viewer) = a.viewer else { return Ok(Vec::new()) };
        let at = now_ms();
        let mut out = Vec::new();
        for membership in viewer.workspaces.iter().take(20) {
            let workspace = membership.slug.to_lowercase();
            #[derive(Deserialize)]
            struct Waiting {
                id: String,
                name: String,
                run_id: String,
                labels: String,
                queued_at: Option<String>,
                repo: String,
                repo_id: String,
            }
            let waiting = self
                .db
                .prepare(
                    "SELECT jobs.id, jobs.name, jobs.run_id, jobs.labels, jobs.queued_at, runs.repo, jobs.repo_id FROM jobs JOIN runs ON runs.id = jobs.run_id
                     WHERE jobs.status = 'queued' AND jobs.labels IS NOT NULL AND jobs.fallback_instance IS NULL AND lower(jobs.namespace) = ? AND jobs.queued_at < ?
                     ORDER BY jobs.rowid LIMIT 20",
                )
                .bind(&[workspace.as_str().into(), rfc3339(at.saturating_sub(10 * 60 * 1000)).into()])?
                .all()
                .await?
                .results::<Waiting>()?;
            if waiting.is_empty() {
                continue;
            }
            let groups = self.group_rows(&workspace).await?;
            let online: Vec<RunnerRow> = self.runner_rows(&workspace).await?.into_iter().filter(|r| r.online(at)).collect();
            // A repository's visibility is asked only when a host-mode runner
            // is online, since only those pass over a public repository's jobs.
            let any_host = online.iter().any(|runner| runner.isolation.as_deref() == Some("host"));
            let mut looked = Looked::default();
            for job in waiting {
                let wanted = Wanted::from_stored(&serde_json::from_str::<Vec<String>>(&job.labels).unwrap_or_default());
                let visibility = if any_host { self.visibility_once(&mut looked, &job.repo_id).await } else { None };
                let served = online.iter().any(|runner| {
                    let group = runner.group_id.as_ref().and_then(|id| groups.iter().find(|g| &g.id == id));
                    wanted.matches(&runner.labels(), group.map(|g| g.name.as_str()))
                        && model::isolation_allows(runner.isolation.as_deref(), visibility.as_deref())
                });
                if !served {
                    out.push(StuckJob {
                        id: job.id,
                        name: job.name,
                        run_id: job.run_id,
                        repo: job.repo,
                        labels: wanted.describe(),
                        queued_at: job.queued_at.unwrap_or_default(),
                    });
                }
            }
        }
        Ok(out)
    }

    // --- Every minute ----------------------------------------------------------

    /// Jobs and tasks that waited too long, tasks whose runner went quiet,
    /// runners offline for weeks, and registration tokens long expired.
    pub async fn sweep_runners(&self, at: u64) -> Result<()> {
        let before = |ms: u64| rfc3339(at.saturating_sub(ms));
        let waited = model::MAX_WAIT_HOURS * 60 * 60 * 1000;
        // Not one offered to them in place of g1t's machine, which runs
        // there instead (plan.rs `start_queued`).
        let stale = self
            .db
            .prepare("SELECT * FROM jobs WHERE status = 'queued' AND labels IS NOT NULL AND fallback_instance IS NULL AND queued_at < ? LIMIT 50")
            .bind(&[before(waited).into()])?
            .all()
            .await?
            .results::<JobRow>()?;
        for job in stale {
            let stored: Vec<String> = job.labels.as_deref().and_then(|l| serde_json::from_str(l).ok()).unwrap_or_default();
            let why = format!(
                "No self-hosted runner with labels {} took it within {} hours.",
                Wanted::from_stored(&stored).describe(),
                model::MAX_WAIT_HOURS
            );
            self.finish_job(&job.id, "failure", Some(&why), None).await?;
        }
        let tasks = self
            .db
            .prepare(
                "SELECT * FROM runner_tasks WHERE (status = 'queued' AND created_at < ?) OR (status = 'in_progress' AND seen_at < ?) LIMIT 50",
            )
            .bind(&[before(waited).into(), before(SILENT_MS).into()])?
            .all()
            .await?
            .results::<TaskRow>()?;
        for task in tasks {
            let why = if task.status == "queued" {
                format!(
                    "No self-hosted runner with labels {} took it within {} hours.",
                    Wanted::of(&serde_json::from_str::<Vec<String>>(&task.labels).unwrap_or_default(), None).describe(),
                    model::MAX_WAIT_HOURS
                )
            } else {
                format!("The self-hosted runner {} stopped answering.", task.runner_name.clone().unwrap_or_default())
            };
            self.end_task(&task, 1, &why).await?;
        }
        let forgotten = self
            .db
            .prepare("SELECT * FROM runners WHERE COALESCE(last_seen_at, created_at) < ? LIMIT 50")
            .bind(&[before(FORGET_OFFLINE_MS).into()])?
            .all()
            .await?
            .results::<RunnerRow>()?;
        for row in forgotten {
            self.forget_runner(&row, "The runner was offline for 14 days.").await?;
        }
        // An ephemeral runner that took its job and then went quiet.
        let spent = self
            .db
            .prepare("SELECT * FROM runners WHERE ephemeral = 1 AND spent = 1 AND work_id IS NULL AND COALESCE(last_seen_at, created_at) < ? LIMIT 50")
            .bind(&[before(60 * 60 * 1000).into()])?
            .all()
            .await?
            .results::<RunnerRow>()?;
        for row in spent {
            self.forget_runner(&row, "The ephemeral runner finished its job.").await?;
        }
        self.db.prepare("DELETE FROM runner_registrations WHERE expires_at < ?").bind(&[before(24 * 60 * 60 * 1000).into()])?.run().await?;
        Ok(())
    }
}

#[derive(Deserialize)]
struct IdRow {
    id: String,
}

/// Whether `runner` is online and could take a public repository's job:
/// not host-mode, and its repository, group and labels let it.
fn takes_public_job(runner: &RunnerRow, groups: &[GroupRow], repo_id: &str, run_repo: &str, wanted: &Wanted, at: u64) -> bool {
    let group = runner.group_id.as_ref().and_then(|id| groups.iter().find(|g| &g.id == id));
    runner.online(at)
        && model::isolation_allows(runner.isolation.as_deref(), Some("public"))
        && runner.repo_id.as_deref().is_none_or(|repo| repo == repo_id)
        && (runner.repo_id.is_some() || group.is_none_or(|g| g.allows(run_repo)))
        && wanted.matches(&runner.labels(), group.map(|g| g.name.as_str()))
}

/// Whether `runner` could take a job offered to the workspace's runners in
/// place of `machine` now: online, idle, its repository or group lets the
/// job's repository use it, its labels are the job's, and it stands in for
/// the machine ([`model::stands_in_for`]).
#[allow(clippy::too_many_arguments)]
fn takes_offered_job(
    runner: &RunnerRow,
    groups: &[GroupRow],
    repo_id: &str,
    run_repo: &str,
    wanted: &Wanted,
    machine: &g1t_contracts::actions::InstanceType,
    needs_docker: bool,
    visibility: Option<&str>,
    at: u64,
) -> bool {
    let group = runner.group_id.as_ref().and_then(|id| groups.iter().find(|g| &g.id == id));
    runner.online(at)
        && runner.work_id.is_none()
        && !(runner.ephemeral != 0 && runner.spent != 0)
        && runner.repo_id.as_deref().is_none_or(|repo| repo == repo_id)
        && (runner.repo_id.is_some() || group.is_none_or(|g| g.allows(run_repo)))
        && wanted.matches(&runner.labels(), group.map(|g| g.name.as_str()))
        && model::stands_in_for(
            runner.capacity(),
            runner.sizes().as_deref(),
            runner.isolation.as_deref(),
            visibility,
            machine,
            needs_docker,
        )
}

fn group_view(group: &GroupRow, runners: &[RunnerRow]) -> RunnerGroup {
    RunnerGroup {
        id: group.id.clone(),
        name: group.name.clone(),
        default: group.is_default != 0,
        repositories: group.repositories(),
        runners: runners.iter().filter(|r| r.group_id.as_deref() == Some(group.id.as_str())).count() as u32,
        updated_at: group.updated_at.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn group(repositories: &[&str]) -> GroupRow {
        GroupRow {
            id: "rng_1".into(),
            name: "Default".into(),
            is_default: 1,
            repositories: serde_json::to_string(&repositories).unwrap(),
            updated_at: "2026-10-06T00:00:00Z".into(),
        }
    }

    #[test]
    fn being_seen_is_written_once_a_minute() {
        let at = 2_000_000_000_000;
        assert!(seen_is_stale(None, at));
        assert!(!seen_is_stale(Some(&rfc3339(at - 59_000)), at));
        assert!(seen_is_stale(Some(&rfc3339(at - 61_000)), at));
        // A runner written down at the last moment is still online until the
        // next write, a poll later.
        assert!(SEEN_RESOLUTION_MS + model::MAX_POLL_WAIT_MS < model::ONLINE_WITHIN_MS);
        assert!(SEEN_RESOLUTION_MS < crate::SILENT_MS);
    }

    #[test]
    fn a_group_lets_its_repositories_use_it() {
        assert!(group(&[]).allows("acme/web"));
        assert!(group(&["web", "api"]).allows("acme/WEB"));
        assert!(group(&["web"]).allows("web"));
        assert!(!group(&["web"]).allows("acme/docs"));
    }

    #[test]
    fn names_are_checked() {
        assert_eq!(valid_name(" build-01 ").unwrap(), "build-01");
        assert!(valid_name("").is_err());
        assert!(valid_name("has space").is_err());
        assert!(valid_name(&"x".repeat(65)).is_err());
        assert!(valid_group_name("GPU machines").is_ok());
        assert!(valid_group_name("").is_err());
    }

    #[test]
    fn only_a_sandboxed_runner_that_could_take_it_serves_a_public_job() {
        let at = 1_000_000_000;
        let runner = |isolation: Option<&str>| RunnerRow {
            id: "rnr_1".into(),
            workspace: "acme".into(),
            repo_id: None,
            repo: None,
            group_id: None,
            name: "a".into(),
            labels: r#"["self-hosted","linux","x64"]"#.into(),
            os: "linux".into(),
            arch: "x64".into(),
            version: String::new(),
            ephemeral: 0,
            credential_hash: String::new(),
            previous_hash: None,
            rotated_at: String::new(),
            work_id: None,
            work_kind: None,
            spent: 0,
            last_seen_at: Some(rfc3339(at)),
            created_at: String::new(),
            created_by: None,
            isolation: isolation.map(str::to_owned),
            machine_hash: None,
            cpus: None,
            memory_mib: None,
            docker: None,
            sizes: None,
            hosted_image: None,
        };
        let wanted = Wanted::of(&["self-hosted".to_owned(), "linux".to_owned()], None);
        let takes = |row: &RunnerRow| takes_public_job(row, &[], "rep_1", "acme/web", &wanted, at);
        assert!(!takes(&runner(Some("host"))));
        assert!(takes(&runner(Some("container"))));
        assert!(takes(&runner(Some("nested-container"))));
        assert!(takes(&runner(None)), "an older runner, which refuses for itself");
        assert!(!takes(&RunnerRow { repo_id: Some("rep_2".into()), ..runner(None) }), "another repository's");
        assert!(!takes(&RunnerRow { labels: r#"["self-hosted","macos"]"#.into(), ..runner(None) }));
        assert!(!takes(&RunnerRow { last_seen_at: None, ..runner(None) }), "offline");
    }

    #[test]
    fn only_a_free_runner_as_large_as_the_machine_takes_a_job_that_asked_for_one() {
        let at = 1_000_000_000;
        let runner = RunnerRow {
            id: "rnr_1".into(),
            workspace: "acme".into(),
            repo_id: None,
            repo: None,
            group_id: Some("rng_1".into()),
            name: "box-linux".into(),
            labels: r#"["self-hosted","linux","x64","desktop"]"#.into(),
            os: "linux".into(),
            arch: "x64".into(),
            version: String::new(),
            ephemeral: 0,
            credential_hash: String::new(),
            previous_hash: None,
            rotated_at: String::new(),
            work_id: None,
            work_kind: None,
            spent: 0,
            last_seen_at: Some(rfc3339(at)),
            created_at: String::new(),
            created_by: None,
            isolation: Some("nested-container".into()),
            machine_hash: None,
            cpus: Some(8),
            memory_mib: Some(16 * 1024),
            docker: Some(1),
            sizes: None,
            hosted_image: Some(1),
        };
        let groups = [group(&["web"])];
        let wanted = model::hosted_wanted(&["ubuntu-latest".to_owned()]).unwrap();
        let standard = g1t_contracts::actions::STANDARD_INSTANCE;
        let takes = |row: &RunnerRow, needs_docker: bool| {
            takes_offered_job(row, &groups, "rep_1", "acme/web", &wanted, &standard, needs_docker, None, at)
        };
        assert!(takes(&runner, true));
        assert!(!takes(&RunnerRow { work_id: Some("job_2".into()), ..runner.clone() }, false), "busy");
        assert!(!takes(&RunnerRow { last_seen_at: Some(rfc3339(at - 120_000)), ..runner.clone() }, false), "offline");
        assert!(!takes(&RunnerRow { ephemeral: 1, spent: 1, ..runner.clone() }, false), "an ephemeral runner that had its job");
        assert!(!takes(&RunnerRow { arch: "arm64".into(), labels: r#"["self-hosted","linux","arm64"]"#.into(), ..runner.clone() }, false));
        assert!(!takes(&RunnerRow { cpus: Some(1), ..runner.clone() }, false), "smaller than the machine");
        assert!(!takes(&RunnerRow { cpus: None, ..runner.clone() }, false), "a runner that never said");
        assert!(!takes(&RunnerRow { docker: Some(0), ..runner.clone() }, true), "services without Docker");
        assert!(!takes(&RunnerRow { isolation: Some("host".into()), ..runner.clone() }, false), "host mode, visibility unknown");
        assert!(!takes(&RunnerRow { repo_id: Some("rep_2".into()), ..runner.clone() }, false), "another repository's");
        assert!(!takes(&RunnerRow { hosted_image: None, ..runner.clone() }, false), "a runner before g1t's runner image");
        assert!(!takes(&RunnerRow { hosted_image: Some(0), ..runner.clone() }, false), "a runner with no image of g1t's machines");
        // A runner that says its sizes takes the machine's, whatever it has.
        let sized = |json: &str| RunnerRow { cpus: Some(1), memory_mib: Some(1024), sizes: Some(json.into()), ..runner.clone() };
        assert!(takes(&sized(r#"[{"size":"2-core"}]"#), false), "its sizes, not its resources");
        assert!(!takes(&sized(r#"[{"size":"1-core"}]"#), false), "not a size it takes");
        assert!(!takes(&sized("[]"), false), "it takes none");
        let elsewhere = [group(&["docs"])];
        assert!(
            !takes_offered_job(&runner, &elsewhere, "rep_1", "acme/web", &wanted, &standard, false, None, at),
            "its group leaves the repository out"
        );
    }

    #[test]
    fn a_job_its_runner_just_finished_is_left_to_exit_and_any_other_is_stopped() {
        let at = 1_000_000_000_000;
        let job = |status: &str, conclusion: Option<&str>, runner: &str, finished: Option<u64>| -> JobRow {
            serde_json::from_value(json!({
                "id": "job_1", "run_id": "run_1", "repo_id": "rep_1", "namespace": "n", "key": "k", "ordinal": 0,
                "name": "Smoke", "needs": "[]", "status": status, "conclusion": conclusion, "steps": "[]",
                "annotations": "[]", "outputs": "{}", "timeout_minutes": 60, "continue_on_error": 0,
                "runner_id": runner, "finished_at": finished.map(rfc3339),
            }))
            .unwrap()
        };
        // Deploy #596's Smoke: done a second ago, its container still exiting.
        assert!(!stops_on_poll(&job("completed", Some("success"), "rnr_1", Some(at - 1_000)), "rnr_1", at));
        assert!(!stops_on_poll(&job("completed", Some("failure"), "rnr_1", Some(at - 30_000)), "rnr_1", at));
        // A runner still holding it a minute on is stopped.
        assert!(stops_on_poll(&job("completed", Some("success"), "rnr_1", Some(at - WRAPPING_UP_MS)), "rnr_1", at));
        assert!(stops_on_poll(&job("completed", Some("success"), "rnr_1", None), "rnr_1", at));
        // Cancelled, another runner's, or back in the queue: stopped at once.
        assert!(stops_on_poll(&job("completed", Some("cancelled"), "rnr_1", Some(at - 1_000)), "rnr_1", at));
        assert!(stops_on_poll(&job("completed", Some("success"), "rnr_2", Some(at - 1_000)), "rnr_1", at));
        assert!(stops_on_poll(&job("queued", None, "rnr_1", Some(at - 1_000)), "rnr_1", at));
    }

    #[test]
    fn what_a_runner_says_it_has_is_kept_only_when_it_is_believable() {
        assert_eq!(
            kept_capacity(Some(8), Some(16384), Some(true), Some(true)),
            model::Capacity { cpus: Some(8), memory_mib: Some(16384), docker: Some(true), hosted_image: Some(true) }
        );
        assert_eq!(kept_capacity(Some(0), Some(0), None, None), model::Capacity::default());
        assert_eq!(kept_capacity(Some(1_000_000), None, None, None).cpus, None);
        // Its sizes: g1t's machines, each once, never below the size.
        let said = [
            model::OfferedSize { size: "2-core".into(), cpus: Some(1.0), memory_mib: Some(16 * 1024) },
            model::OfferedSize::of("1-core"),
            model::OfferedSize::of("1-core"),
            model::OfferedSize::of("gpu"),
        ];
        assert_eq!(sized(&said), r#"[{"size":"1-core"},{"size":"2-core","memory_mib":16384}]"#);
    }

    #[test]
    fn online_means_seen_in_the_last_ninety_seconds() {
        let row = RunnerRow {
            id: "rnr_1".into(),
            workspace: "acme".into(),
            repo_id: None,
            repo: None,
            group_id: None,
            name: "a".into(),
            labels: "[]".into(),
            os: "linux".into(),
            arch: "x64".into(),
            version: String::new(),
            ephemeral: 0,
            credential_hash: String::new(),
            previous_hash: None,
            rotated_at: String::new(),
            work_id: None,
            work_kind: None,
            spent: 0,
            last_seen_at: Some(rfc3339(1_000_000_000)),
            created_at: String::new(),
            created_by: None,
            isolation: None,
            machine_hash: None,
            cpus: None,
            memory_mib: None,
            docker: None,
            sizes: None,
            hosted_image: None,
        };
        assert!(row.online(1_000_000_000 + 60_000));
        assert!(!row.online(1_000_000_000 + 120_000));
        assert_eq!(row.workspace, "acme");
    }

    #[test]
    fn a_machine_fingerprint_is_kept_per_workspace_and_only_when_it_is_one() {
        let print = "ab".repeat(32);
        assert_eq!(machine_hash("acme", Some(&print)), machine_hash("acme", Some(&print.to_ascii_uppercase())));
        assert_ne!(machine_hash("acme", Some(&print)), machine_hash("other", Some(&print)));
        assert_eq!(machine_hash("acme", Some("SYNTAQX")), None);
        assert_eq!(machine_hash("acme", Some("abc")), None);
        assert_eq!(machine_hash("acme", None), None);
    }

    #[test]
    fn the_same_computer_takes_its_runners_name_back() {
        let at = 1_000_000_000;
        let ours = machine_hash("acme", Some(&"ab".repeat(32)));
        let theirs = machine_hash("acme", Some(&"cd".repeat(32)));
        let row = |machine_hash: Option<String>, created_by: Option<&str>, seen: u64| RunnerRow {
            id: "rnr_1".into(),
            workspace: "acme".into(),
            repo_id: None,
            repo: None,
            group_id: None,
            name: "box-linux".into(),
            labels: "[]".into(),
            os: "linux".into(),
            arch: "x64".into(),
            version: String::new(),
            ephemeral: 0,
            credential_hash: String::new(),
            previous_hash: None,
            rotated_at: String::new(),
            work_id: None,
            work_kind: None,
            spent: 0,
            last_seen_at: Some(rfc3339(seen)),
            created_at: String::new(),
            created_by: created_by.map(str::to_owned),
            isolation: None,
            machine_hash,
            cpus: None,
            memory_mib: None,
            docker: None,
            sizes: None,
            hosted_image: None,
        };
        // The same computer, even while the old one still looks online.
        assert!(takes_over(&row(ours.clone(), Some("u1"), at), false, ours.as_deref(), Some("u1"), at));
        // Another computer of the same name: only when asked to.
        assert!(!takes_over(&row(theirs.clone(), Some("u1"), 0), false, ours.as_deref(), Some("u1"), at));
        assert!(takes_over(&row(theirs, Some("u1"), at), true, ours.as_deref(), Some("u1"), at));
        // One from before fingerprints: the same person's, gone quiet.
        assert!(takes_over(&row(None, Some("u1"), 0), false, ours.as_deref(), Some("u1"), at));
        assert!(!takes_over(&row(None, Some("u1"), at), false, ours.as_deref(), Some("u1"), at));
        assert!(!takes_over(&row(None, Some("u2"), 0), false, ours.as_deref(), Some("u1"), at));
        assert!(!takes_over(&row(None, None, 0), false, ours.as_deref(), None, at));
        // A runner without a fingerprint never matches one without.
        assert!(!takes_over(&row(None, Some("u1"), at), false, None, Some("u1"), at));
    }
}
