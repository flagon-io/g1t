//! The automations service: rules in a repository's `.g1t/automations/`
//! that act when something happens. See `g1t_contracts::automations` for
//! the methods, and `definition` for what a file may say.
//!
//! The files on a repository's default branch are read again on every push
//! to it. An event from the bus runs each enabled automation that wants it;
//! the minute's sweep runs scheduled ones; a member can run any by hand.
//! Every run is recorded with each step's result, and every run obeys three
//! rules: an event is handled once per automation, an automation makes at
//! most so many runs an hour, and an automation does not answer what it
//! itself just did.
//!
//! Automations act as their workspace: what they write is the workspace's,
//! and says which automation wrote it.

mod definition;

use g1t_contracts::automations::*;
use g1t_contracts::events::Event;
use g1t_contracts::identity::{AGENT_ID, AGENT_NAME, SlugArgs, UsernamesArgs, Workspace};
use g1t_contracts::repos::{BlobArgs, BlobView, EntryKind, GetArgs, PathByIdArgs, Repo, RepoPath, TreeArgs, TreeView};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::{IssueDetail, PullDetail, ViewArgs};
use g1t_contracts::{FailureCode, Membership, Outcome, PrincipalKind, Role, User, Viewer, new_id};
use g1t_kit::{args, now_ms, reply, rpc_method};
use serde::Deserialize;
use serde_json::{Value, json};
use worker::wasm_bindgen::JsValue;
use worker::{
    Context as WorkerContext, D1Database, Env, Fetch, Fetcher, Headers, MessageBatch, MessageExt, Method, Request, RequestInit,
    Response, Result, ScheduleContext, ScheduledEvent, event,
};

use definition::{Context, Definition, Step, Trigger};

/// Where automations live in a repository.
const FOLDER: &str = ".g1t/automations";
/// The most automation files read from a repository.
const MAX_FILES: usize = 50;
const RUNS_SHOWN: u32 = 50;
/// How long an automation's own effect is remembered, so it does not answer it.
const OWN_EFFECT_MS: u64 = 10 * 60 * 1000;
const SITE: &str = "https://g1t.sh";

#[derive(Deserialize)]
struct AutomationRow {
    id: String,
    repo_id: String,
    repo: String,
    path: String,
    name: String,
    source: String,
    error: Option<String>,
    enabled: u32,
}

impl AutomationRow {
    fn definition(&self) -> std::result::Result<Definition, String> {
        if let Some(error) = &self.error {
            return Err(error.clone());
        }
        definition::parse(&self.source, self.path.rsplit('/').next().unwrap_or(&self.path))
    }

    fn repo_path(&self) -> RepoPath {
        let (namespace, name) = self.repo.split_once('/').unwrap_or((&self.repo, ""));
        RepoPath {
            namespace: namespace.to_owned(),
            name: name.to_owned(),
        }
    }
}

#[derive(Deserialize)]
struct RunRow {
    id: String,
    automation_id: String,
    name: String,
    event: String,
    number: Option<u32>,
    status: String,
    reason: Option<String>,
    steps: String,
    actor: Option<String>,
    started_at: String,
}

impl From<RunRow> for AutomationRun {
    fn from(row: RunRow) -> Self {
        AutomationRun {
            id: row.id,
            automation_id: row.automation_id,
            name: row.name,
            event: row.event,
            number: row.number,
            status: row.status,
            reason: row.reason,
            steps: serde_json::from_str(&row.steps).unwrap_or_default(),
            actor: row.actor,
            started_at: row.started_at,
        }
    }
}

#[derive(Deserialize)]
struct Count {
    n: u32,
}

/// What started a run.
struct Source {
    /// Unique per automation: an event's id, the minute, or a manual run.
    key: String,
    event: String,
    number: Option<u32>,
    /// The id of whoever caused it.
    actor_id: Option<String>,
    /// The event's data, for conditions and `{{data.*}}`.
    data: Value,
}

fn optional(value: Option<&str>) -> JsValue {
    value.map_or(JsValue::NULL, JsValue::from)
}

fn fail<T>(code: FailureCode, message: impl Into<String>) -> Outcome<T> {
    Outcome::fail(code, message)
}

fn summary(row: &AutomationRow, last_run: Option<AutomationRun>) -> Automation {
    let parsed = row.definition();
    Automation {
        id: row.id.clone(),
        repo: row.repo.clone(),
        path: row.path.clone(),
        name: row.name.clone(),
        trigger: parsed.as_ref().map(|d| d.trigger.describe()).unwrap_or_default(),
        conditions: parsed.as_ref().map(|d| d.conditions.iter().map(|c| c.describe()).collect()).unwrap_or_default(),
        steps: parsed.as_ref().map(|d| d.steps.iter().map(Step::describe).collect()).unwrap_or_default(),
        enabled: row.enabled != 0,
        error: parsed.as_ref().err().cloned(),
        manual: parsed.is_ok(),
        last_run,
    }
}

struct Automations {
    db: D1Database,
    repos: Fetcher,
    work: Fetcher,
    identity: Fetcher,
    runner: Fetcher,
}

impl Automations {
    fn new(env: &Env) -> Result<Self> {
        Ok(Automations {
            db: env.d1("DB")?,
            repos: env.service("REPOS")?,
            work: env.service("WORK")?,
            identity: env.service("IDENTITY")?,
            runner: env.service("RUNNER")?,
        })
    }

    /// The workspace itself, as automations act.
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

    // --- Reading the files ----------------------------------------------------

    /// Reads a repository's automation files from its default branch, and
    /// keeps the database in step with them.
    async fn sync(&self, path: &RepoPath) -> Result<()> {
        let Some(actor) = self.workspace_actor(&path.namespace).await? else {
            return Ok(());
        };
        let viewer = Some(actor);
        let tree: Outcome<TreeView> = g1t_kit::call(
            &self.repos,
            "tree",
            &TreeArgs {
                path: path.clone(),
                viewer: viewer.clone(),
                git_ref: None,
                tree_path: FOLDER.to_owned(),
            },
        )
        .await?;
        let Some(repo) = self.visible_repo(path, &viewer).await? else {
            return Ok(());
        };
        let entries = match tree {
            Outcome::Ok(tree) => tree.entries,
            // No folder: no automations.
            Outcome::Fail(_) => Vec::new(),
        };
        let files: Vec<String> = entries
            .into_iter()
            .filter(|entry| matches!(entry.kind, EntryKind::Blob | EntryKind::Exec))
            .map(|entry| entry.name)
            .filter(|name| name.ends_with(".yml") || name.ends_with(".yaml"))
            .take(MAX_FILES)
            .collect();
        let full_name = format!("{}/{}", repo.namespace, repo.name);
        let now = rfc3339(now_ms());
        let mut kept = Vec::new();
        for file in &files {
            let file_path = format!("{FOLDER}/{file}");
            let blob: Outcome<BlobView> = g1t_kit::call(
                &self.repos,
                "blob",
                &BlobArgs {
                    path: path.clone(),
                    viewer: viewer.clone(),
                    git_ref: repo.default_branch.clone(),
                    file_path: file_path.clone(),
                },
            )
            .await?;
            let source = match blob {
                Outcome::Ok(BlobView { text: Some(text), .. }) => text,
                _ => continue,
            };
            let parsed = definition::parse(&source, file);
            let (name, error, kind, events) = match &parsed {
                Ok(definition) => (
                    definition.name.clone(),
                    None,
                    match &definition.trigger {
                        Trigger::Events(_) => "events",
                        Trigger::Schedule { .. } => "schedule",
                        Trigger::Manual => "manual",
                    },
                    match &definition.trigger {
                        Trigger::Events(events) => events.clone(),
                        _ => Vec::new(),
                    },
                ),
                Err(problem) => (file.clone(), Some(problem.clone()), "invalid", Vec::new()),
            };
            self.db
                .prepare(
                    "INSERT INTO automations (id, repo_id, repo, path, name, source, trigger_kind, events, error, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT (repo_id, path) DO UPDATE SET
                       repo = excluded.repo, name = excluded.name, source = excluded.source,
                       trigger_kind = excluded.trigger_kind, events = excluded.events,
                       error = excluded.error, updated_at = excluded.updated_at",
                )
                .bind(&[
                    new_id("aut", now_ms()).into(),
                    repo.id.as_str().into(),
                    full_name.as_str().into(),
                    file_path.as_str().into(),
                    name.into(),
                    source.into(),
                    kind.into(),
                    serde_json::to_string(&events)?.into(),
                    optional(error.as_deref()),
                    now.as_str().into(),
                ])?
                .run()
                .await?;
            kept.push(file_path);
        }
        // Files that are gone take their automations with them.
        let mut statements = Vec::new();
        let existing = self
            .db
            .prepare("SELECT * FROM automations WHERE repo_id = ?")
            .bind(&[repo.id.as_str().into()])?
            .all()
            .await?
            .results::<AutomationRow>()?;
        for row in existing.iter().filter(|row| !kept.contains(&row.path)) {
            statements.push(self.db.prepare("DELETE FROM automations WHERE id = ?").bind(&[row.id.as_str().into()])?);
        }
        statements.push(
            self.db
                .prepare("INSERT OR REPLACE INTO synced (repo_id, at) VALUES (?, ?)")
                .bind(&[repo.id.as_str().into(), now.into()])?,
        );
        self.db.batch(statements).await?;
        Ok(())
    }

    async fn synced(&self, repo_id: &str) -> Result<bool> {
        Ok(self
            .db
            .prepare("SELECT COUNT(*) AS n FROM synced WHERE repo_id = ?")
            .bind(&[repo_id.into()])?
            .first::<Count>(None)
            .await?
            .is_some_and(|count| count.n > 0))
    }

    // --- Reading and managing ---------------------------------------------------

    async fn last_run(&self, automation_id: &str) -> Result<Option<AutomationRun>> {
        Ok(self
            .db
            .prepare("SELECT * FROM runs WHERE automation_id = ? ORDER BY id DESC LIMIT 1")
            .bind(&[automation_id.into()])?
            .first::<RunRow>(None)
            .await?
            .map(AutomationRun::from))
    }

    async fn list(&self, a: ListArgs) -> Result<Outcome<Vec<Automation>>> {
        let Some(repo) = self.visible_repo(&a.repo, &a.viewer).await? else {
            return Ok(fail(FailureCode::NotFound, "There is no such repository."));
        };
        if !self.synced(&repo.id).await? {
            self.sync(&RepoPath {
                namespace: repo.namespace.clone(),
                name: repo.name.clone(),
            })
            .await?;
        }
        let rows = self
            .db
            .prepare("SELECT * FROM automations WHERE repo_id = ? ORDER BY path")
            .bind(&[repo.id.as_str().into()])?
            .all()
            .await?
            .results::<AutomationRow>()?;
        let mut out = Vec::with_capacity(rows.len());
        for row in &rows {
            out.push(summary(row, self.last_run(&row.id).await?));
        }
        Ok(Outcome::Ok(out))
    }

    async fn runs(&self, a: RunsArgs) -> Result<Outcome<Vec<AutomationRun>>> {
        let Some(repo) = self.visible_repo(&a.repo, &a.viewer).await? else {
            return Ok(fail(FailureCode::NotFound, "There is no such repository."));
        };
        let rows = match &a.automation {
            Some(id) => self
                .db
                .prepare("SELECT * FROM runs WHERE repo_id = ? AND automation_id = ? ORDER BY id DESC LIMIT ?")
                .bind(&[repo.id.as_str().into(), id.as_str().into(), RUNS_SHOWN.into()])?,
            None => self
                .db
                .prepare("SELECT * FROM runs WHERE repo_id = ? ORDER BY id DESC LIMIT ?")
                .bind(&[repo.id.as_str().into(), RUNS_SHOWN.into()])?,
        }
        .all()
        .await?
        .results::<RunRow>()?;
        Ok(Outcome::Ok(rows.into_iter().map(AutomationRun::from).collect()))
    }

    /// The automation, if the actor is a member of its repository's workspace.
    async fn manageable(&self, actor: &User, repo: &RepoPath, id: &str) -> Result<Outcome<AutomationRow>> {
        if actor.kind == PrincipalKind::Agent || !actor.is_member(&repo.namespace.to_lowercase()) {
            return Ok(fail(FailureCode::Forbidden, format!("Only members of {} can run or change its automations.", repo.namespace)));
        }
        let row = self
            .db
            .prepare("SELECT * FROM automations WHERE id = ? AND lower(repo) = lower(?)")
            .bind(&[id.into(), format!("{}/{}", repo.namespace, repo.name).into()])?
            .first::<AutomationRow>(None)
            .await?;
        Ok(row.map_or_else(|| fail(FailureCode::NotFound, "No such automation."), Outcome::Ok))
    }

    async fn set_enabled(&self, a: SetEnabledArgs) -> Result<Outcome<Automation>> {
        let row = match self.manageable(&a.actor, &a.repo, &a.id).await? {
            Outcome::Ok(row) => row,
            Outcome::Fail(refused) => return Ok(Outcome::Fail(refused)),
        };
        self.db
            .prepare("UPDATE automations SET enabled = ? WHERE id = ?")
            .bind(&[(a.enabled as u32).into(), row.id.as_str().into()])?
            .run()
            .await?;
        let row = AutomationRow {
            enabled: a.enabled as u32,
            ..row
        };
        Ok(Outcome::Ok(summary(&row, self.last_run(&row.id).await?)))
    }

    async fn run_now(&self, a: RunArgs) -> Result<Outcome<AutomationRun>> {
        let row = match self.manageable(&a.actor, &a.repo, &a.id).await? {
            Outcome::Ok(row) => row,
            Outcome::Fail(refused) => return Ok(Outcome::Fail(refused)),
        };
        if let Err(problem) = row.definition() {
            return Ok(fail(FailureCode::Invalid, format!("Its file has a problem: {problem}")));
        }
        let source = Source {
            key: format!("manual:{}", new_id("run", now_ms())),
            event: "manual".to_owned(),
            number: a.number,
            actor_id: Some(a.actor.id.clone()),
            data: json!({}),
        };
        let id = self.run(&row, source).await?;
        Ok(match id {
            Some(id) => self
                .db
                .prepare("SELECT * FROM runs WHERE id = ?")
                .bind(&[id.as_str().into()])?
                .first::<RunRow>(None)
                .await?
                .map_or_else(|| fail(FailureCode::NotFound, "The run was not recorded."), |row| Outcome::Ok(row.into())),
            None => fail(FailureCode::Conflict, "It did not run."),
        })
    }

    // --- Running ------------------------------------------------------------------

    async fn on_event(&self, event: &Event) -> Result<()> {
        let Some(repo_id) = event.repo_id.as_deref() else {
            return Ok(());
        };
        // A push to the default branch may have changed the files.
        if event.kind == "git.push" && event.data["defaultBranch"].as_bool() == Some(true) {
            let path: Option<RepoPath> = g1t_kit::call(&self.repos, "path_by_id", &PathByIdArgs { id: repo_id.to_owned() }).await?;
            if let Some(path) = path {
                self.sync(&path).await?;
            }
        }
        let rows = self
            .db
            .prepare("SELECT * FROM automations WHERE repo_id = ? AND enabled = 1 AND trigger_kind = 'events'")
            .bind(&[repo_id.into()])?
            .all()
            .await?
            .results::<AutomationRow>()?;
        for row in rows {
            let Ok(definition) = row.definition() else { continue };
            let Trigger::Events(events) = &definition.trigger else { continue };
            if !events.contains(&event.kind) {
                continue;
            }
            let source = Source {
                key: event.id.clone(),
                event: event.kind.clone(),
                number: event.data["number"].as_u64().map(|n| n as u32),
                actor_id: event.actor.clone(),
                data: event.data.clone(),
            };
            self.run(&row, source).await?;
        }
        Ok(())
    }

    /// Runs scheduled automations whose schedule fires this minute.
    async fn on_minute(&self, now: u64) -> Result<()> {
        let minute = now / 60_000 * 60_000;
        let rows = self
            .db
            .prepare("SELECT * FROM automations WHERE enabled = 1 AND trigger_kind = 'schedule'")
            .all()
            .await?
            .results::<AutomationRow>()?;
        for row in rows {
            let Ok(definition) = row.definition() else { continue };
            let Trigger::Schedule { schedule, .. } = &definition.trigger else { continue };
            if schedule.fires_at(minute) {
                let source = Source {
                    key: format!("schedule:{minute}"),
                    event: "schedule".to_owned(),
                    number: None,
                    actor_id: None,
                    data: json!({}),
                };
                self.run(&row, source).await?;
            }
        }
        Ok(())
    }

    /// One run of an automation: recorded once, checked against its rules
    /// and conditions, then its steps in order until one fails.
    async fn run(&self, row: &AutomationRow, source: Source) -> Result<Option<String>> {
        let Ok(definition) = row.definition() else {
            return Ok(None);
        };
        let now = now_ms();
        let run_id = new_id("arn", now);
        let claimed = self
            .db
            .prepare(
                "INSERT OR IGNORE INTO runs (id, automation_id, repo_id, event_key, name, event, number, status, steps, started_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'running', '[]', ?) RETURNING id",
            )
            .bind(&[
                run_id.as_str().into(),
                row.id.as_str().into(),
                row.repo_id.as_str().into(),
                source.key.as_str().into(),
                definition.name.as_str().into(),
                source.event.as_str().into(),
                source.number.map_or(JsValue::NULL, JsValue::from),
                rfc3339(now).into(),
            ])?
            .first::<Value>(None)
            .await?;
        if claimed.is_none() {
            return Ok(None);
        }
        let repo = row.repo_path();
        let Some(actor) = self.workspace_actor(&repo.namespace).await? else {
            self.finish(&run_id, "skipped", Some("The workspace no longer exists."), &[], None).await?;
            return Ok(Some(run_id));
        };

        // Who caused it, by name.
        let actor_name = match &source.actor_id {
            Some(id) if id == AGENT_ID => Some(AGENT_NAME.to_owned()),
            Some(id) => {
                let names: std::collections::HashMap<String, String> =
                    g1t_kit::call(&self.identity, "usernames", &UsernamesArgs { ids: vec![id.clone()] }).await?;
                names.get(id).cloned()
            }
            None => None,
        };

        // Not in answer to its own doing.
        if source.actor_id.as_deref() == Some(actor.id.as_str())
            && let Some(number) = source.number
        {
            let recent = self
                .db
                .prepare("SELECT COUNT(*) AS n FROM effects WHERE automation_id = ? AND repo_id = ? AND number = ? AND at > ?")
                .bind(&[
                    row.id.as_str().into(),
                    row.repo_id.as_str().into(),
                    number.into(),
                    rfc3339(now.saturating_sub(OWN_EFFECT_MS)).into(),
                ])?
                .first::<Count>(None)
                .await?
                .is_some_and(|count| count.n > 0);
            if recent {
                let reason = format!(
                    "An automation made this change, and this one changed #{number} in the last 10 minutes, so it did not answer: that could loop."
                );
                self.finish(&run_id, "skipped", Some(&reason), &[], actor_name.as_deref()).await?;
                return Ok(Some(run_id));
            }
        }

        // At most so many runs an hour.
        let this_hour = self
            .db
            .prepare("SELECT COUNT(*) AS n FROM runs WHERE automation_id = ? AND status IN ('succeeded', 'failed') AND started_at > ?")
            .bind(&[row.id.as_str().into(), rfc3339(now.saturating_sub(60 * 60 * 1000)).into()])?
            .first::<Count>(None)
            .await?
            .map_or(0, |count| count.n);
        if this_hour >= definition.per_hour {
            let reason = format!("It has run {} times in the last hour, its limit.", definition.per_hour);
            self.finish(&run_id, "skipped", Some(&reason), &[], actor_name.as_deref()).await?;
            return Ok(Some(run_id));
        }

        // What the run knows.
        let mut context = Context::default();
        context.set("repo", &row.repo);
        context.set("event", &source.event);
        context.set("automation", &definition.name);
        if let Some(name) = &actor_name {
            context.set("actor", name);
        }
        if let Some(branch) = source.data["ref"].as_str().and_then(|r| r.strip_prefix("refs/heads/")) {
            context.set("branch", branch);
        }
        context.add_data(&source.data);
        // The issue or pull request it is about.
        let mut target_issue: Option<u32> = None;
        let mut target_pull: Option<u32> = None;
        if let Some(number) = source.number {
            context.set("number", number.to_string());
            let view = ViewArgs {
                repo: repo.clone(),
                number,
                viewer: Some(actor.clone()),
                after_seq: 0,
            };
            let issue: Outcome<IssueDetail> = g1t_kit::call(&self.work, "get_issue", &view).await?;
            if let Outcome::Ok(detail) = issue {
                context.set("title", &detail.issue.title);
                context.set("url", format!("{SITE}/{}/issues/{number}", row.repo));
                context.labels = detail.issue.labels.clone();
                target_issue = Some(number);
            } else {
                let pull: Outcome<PullDetail> = g1t_kit::call(&self.work, "get_pull", &view).await?;
                if let Outcome::Ok(detail) = pull {
                    context.set("title", &detail.pull.title);
                    context.set("url", format!("{SITE}/{}/pull/{number}", row.repo));
                    if let Some(issue) = &detail.issue {
                        context.labels = issue.labels.clone();
                    }
                    target_pull = Some(number);
                    target_issue = detail.pull.issue;
                }
            }
        }
        if let Err(reason) = definition::holds(&definition.conditions, &context) {
            let reason = format!("Its conditions did not hold: {reason}.");
            self.finish(&run_id, "skipped", Some(&reason), &[], actor_name.as_deref()).await?;
            return Ok(Some(run_id));
        }

        let mut results: Vec<StepResult> = Vec::new();
        let mut failed = false;
        for step in &definition.steps {
            if failed {
                results.push(StepResult {
                    step: step.describe(),
                    ok: false,
                    detail: "Not run: an earlier step failed.".to_owned(),
                });
                continue;
            }
            let outcome = self
                .step(step, &definition, &repo, &actor, &mut context, target_issue, target_pull)
                .await
                .unwrap_or_else(|error| Err(format!("g1t could not do it: {error}")));
            failed = outcome.is_err();
            results.push(StepResult {
                step: step.describe(),
                ok: outcome.is_ok(),
                detail: outcome.unwrap_or_else(|problem| problem),
            });
        }
        // Remember what it touched, so it does not answer itself.
        if let Some(number) = target_pull.or(target_issue) {
            self.db
                .prepare("INSERT INTO effects (automation_id, repo_id, number, at) VALUES (?, ?, ?, ?)")
                .bind(&[row.id.as_str().into(), row.repo_id.as_str().into(), number.into(), rfc3339(now_ms()).into()])?
                .run()
                .await?;
        }
        self.finish(&run_id, if failed { "failed" } else { "succeeded" }, None, &results, actor_name.as_deref())
            .await?;
        Ok(Some(run_id))
    }

    async fn finish(&self, run_id: &str, status: &str, reason: Option<&str>, steps: &[StepResult], actor: Option<&str>) -> Result<()> {
        self.db
            .prepare("UPDATE runs SET status = ?, reason = ?, steps = ?, actor = ? WHERE id = ?")
            .bind(&[status.into(), optional(reason), serde_json::to_string(steps)?.into(), optional(actor), run_id.into()])?
            .run()
            .await?;
        Ok(())
    }

    /// One step. `Ok` with what it did, `Err` with why it could not.
    #[allow(clippy::too_many_arguments)]
    async fn step(
        &self,
        step: &Step,
        definition: &Definition,
        repo: &RepoPath,
        actor: &User,
        context: &mut Context,
        issue: Option<u32>,
        pull: Option<u32>,
    ) -> Result<std::result::Result<String, String>> {
        let render = |text: &str| definition::render(text, context);
        let signed = |text: &str| format!("{}\n\n<sub>From the automation **{}**.</sub>", render(text), definition.name);
        let target = pull.or(issue);
        let outcome = |result: Outcome<Value>, done: String| match result {
            Outcome::Ok(_) => Ok(done),
            Outcome::Fail(refused) => Err(refused.message),
        };
        Ok(match step {
            Step::Comment(text) => {
                let Some(number) = target else { return Ok(Err("There is no issue or pull request to comment on.".to_owned())) };
                let result = g1t_kit::call(
                    &self.work,
                    "add_comment",
                    &json!({ "actor": actor, "repo": repo, "number": number, "body": signed(text) }),
                )
                .await?;
                outcome(result, format!("Commented on #{number}."))
            }
            Step::Label(label) | Step::Unlabel(label) => {
                let Some(number) = issue else {
                    return Ok(Err("Labels belong to issues, and this is not about one.".to_owned()));
                };
                let mut labels = context.labels.clone();
                let adding = matches!(step, Step::Label(_));
                labels.retain(|existing| !existing.eq_ignore_ascii_case(label));
                if adding {
                    labels.push(label.clone());
                }
                let result = g1t_kit::call(&self.work, "update_issue", &json!({ "actor": actor, "repo": repo, "number": number, "labels": labels }))
                    .await?;
                context.labels = labels;
                outcome(result, format!("{} {label} on #{number}.", if adding { "Labelled" } else { "Removed the label" }))
            }
            Step::AssignAgent => {
                let Some(number) = issue else {
                    return Ok(Err("An agent is put on an issue, and this is not about one.".to_owned()));
                };
                let result: Outcome<Value> = g1t_kit::call(&self.runner, "run", &json!({ "actor": actor, "repo": repo, "issue": number })).await?;
                match result {
                    Outcome::Ok(pull) => Ok(format!("Put a g1t agent on #{number}: pull request #{}.", pull["number"])),
                    Outcome::Fail(refused) => Err(refused.message),
                }
            }
            Step::MessageAgent(text) => {
                let Some(number) = pull else {
                    return Ok(Err("Agents are messaged on a pull request, and this is not about one.".to_owned()));
                };
                let result = g1t_kit::call(
                    &self.work,
                    "message_agent",
                    &json!({ "actor": actor, "repo": repo, "number": number, "body": render(text) }),
                )
                .await?;
                outcome(result, format!("Messaged the agent on #{number}."))
            }
            Step::OpenIssue { title, body, labels, assign_agent } => {
                let opened: Outcome<Value> = g1t_kit::call(
                    &self.work,
                    "open_issue",
                    &json!({
                        "actor": actor, "repo": repo, "title": render(title), "body": signed(body),
                        "labels": labels, "checks": [],
                    }),
                )
                .await?;
                let number = match opened {
                    Outcome::Ok(issue) => issue["number"].as_u64().unwrap_or_default() as u32,
                    Outcome::Fail(refused) => return Ok(Err(refused.message)),
                };
                context.set("opened", number.to_string());
                if *assign_agent {
                    let started: Outcome<Value> =
                        g1t_kit::call(&self.runner, "run", &json!({ "actor": actor, "repo": repo, "issue": number })).await?;
                    if let Outcome::Fail(refused) = started {
                        return Ok(Err(format!("Opened #{number}, but no agent could start: {}", refused.message)));
                    }
                    Ok(format!("Opened #{number} and put a g1t agent on it."))
                } else {
                    Ok(format!("Opened #{number}."))
                }
            }
            Step::CloseIssue { not_planned } => {
                let Some(number) = issue else { return Ok(Err("There is no issue to close.".to_owned())) };
                let reason = if *not_planned { "not_planned" } else { "completed" };
                let result = g1t_kit::call(&self.work, "close_issue", &json!({ "actor": actor, "repo": repo, "number": number, "reason": reason }))
                    .await?;
                outcome(result, format!("Closed #{number}."))
            }
            Step::ReopenIssue => {
                let Some(number) = issue else { return Ok(Err("There is no issue to reopen.".to_owned())) };
                let result = g1t_kit::call(&self.work, "reopen_issue", &json!({ "actor": actor, "repo": repo, "number": number })).await?;
                outcome(result, format!("Reopened #{number}."))
            }
            Step::Notify { url, text } => notify(url, &render(text)).await,
        })
    }
}

/// Posts a message, in the shape Slack's, Discord's and most chat tools'
/// incoming webhooks take.
async fn notify(url: &str, text: &str) -> std::result::Result<String, String> {
    let host = url.trim_start_matches("https://").split(['/', ':']).next().unwrap_or_default().to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".local") || host.ends_with(".internal") || host.parse::<std::net::IpAddr>().is_ok() {
        return Err("notify posts only to public addresses by name.".to_owned());
    }
    let send = async {
        let headers = Headers::new();
        headers.set("content-type", "application/json")?;
        headers.set("user-agent", "g1t-automations/1")?;
        let mut init = RequestInit::new();
        init.with_method(Method::Post)
            .with_headers(headers)
            .with_body(Some(json!({ "text": text, "content": text }).to_string().into()));
        let mut response = Fetch::Request(Request::new_with_init(url, &init)?).send().await?;
        Ok::<(u16, String), worker::Error>((response.status_code(), response.text().await.unwrap_or_default()))
    };
    match send.await {
        Ok((status, _)) if (200..300).contains(&status) => Ok(format!("Posted to {host}.")),
        Ok((status, body)) => Err(format!("{host} answered {status}: {}", body.chars().take(200).collect::<String>())),
        Err(error) => Err(format!("{host} could not be reached: {error}")),
    }
}

#[event(fetch)]
async fn fetch(mut request: Request, env: Env, _ctx: WorkerContext) -> Result<Response> {
    let Some(method) = rpc_method(&request) else {
        return Response::error("Not found", 404);
    };
    let body: Value = request.json().await?;
    let service = Automations::new(&env)?;
    match method.as_str() {
        "list" => reply(&service.list(args(body)?).await?),
        "runs" => reply(&service.runs(args(body)?).await?),
        "run" => reply(&service.run_now(args(body)?).await?),
        "set_enabled" => reply(&service.set_enabled(args(body)?).await?),
        _ => Response::error("Unknown method", 404),
    }
}

/// Events from the bus, on this service's own queue.
#[event(queue)]
async fn queue(batch: MessageBatch<Event>, env: Env, _ctx: WorkerContext) -> Result<()> {
    let service = Automations::new(&env)?;
    for message in batch.messages()? {
        service.on_event(message.body()).await?;
        message.ack();
    }
    Ok(())
}

/// Every minute: scheduled automations whose time has come.
#[event(scheduled)]
async fn scheduled(_event: ScheduledEvent, env: Env, _ctx: ScheduleContext) {
    match Automations::new(&env) {
        Ok(service) => {
            if let Err(error) = service.on_minute(now_ms()).await {
                worker::console_error!("automations: the minute's sweep failed: {error}");
            }
        }
        Err(error) => worker::console_error!("automations: could not start: {error}"),
    }
}
