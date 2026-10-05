//! What starts a run: an event on the bus, a schedule, or someone running a
//! workflow by hand. Each finds the workflows that want it, at the commit
//! the event is about, and checks their filters.

use g1t_actions::events::{RunInfo, github_events};
use g1t_actions::workflow::{self, Trigger, Workflow};
use g1t_contracts::actions::{DispatchArgs, WorkflowRun};
use g1t_contracts::events::Event;
use g1t_contracts::identity::{AGENT_ID, AGENT_NAME, UsernamesArgs};
use g1t_contracts::repos::{Commit, CompareArgs, Comparison, LogArgs, Repo, RepoPath};
use g1t_contracts::work::{IssueDetail, PullDetail, ViewArgs};
use g1t_contracts::{FailureCode, Outcome, User, new_id};
use g1t_kit::now_ms;
use serde_json::{Map, Value, json};
use worker::Result;

use crate::plan::NewRun;
use crate::sync::{Read, WorkflowRow};
use crate::{API, Actions, SITE, check, fail, payload};

/// What an event is about, worked out once for every workflow it starts.
struct Subject {
    /// Where the workflow files are read, and at which commit.
    source: RepoPath,
    source_ref: Option<String>,
    git_ref: String,
    sha: String,
    head_ref: Option<String>,
    base_ref: Option<String>,
    pull: Option<u32>,
    /// The branch or tag for `branches`/`tags` filters; for pull requests,
    /// the branch they merge into.
    filter_ref: String,
    /// The files it changes, for `paths` filters; `None` until needed.
    paths: Option<Vec<String>>,
    /// For a push, what to compare to find the files.
    compare: Option<(Option<String>, String)>,
    payload: Value,
    title: String,
    trusted: bool,
}

impl Actions {
    async fn username(&self, id: Option<&str>) -> Result<Option<String>> {
        let Some(id) = id else { return Ok(None) };
        if id == AGENT_ID {
            return Ok(Some(AGENT_NAME.to_owned()));
        }
        let names: std::collections::HashMap<String, String> =
            g1t_kit::call(&self.identity, "usernames", &UsernamesArgs { ids: vec![id.to_owned()] }).await?;
        Ok(names.get(id).cloned())
    }

    /// Whether a pull request's author belongs to the workspace, so its
    /// runs get the secrets and a token. On a private repository only
    /// members can open one at all.
    async fn insider(&self, author: &User, repo: &Repo, ws: &User) -> Result<bool> {
        let slug = repo.namespace.to_lowercase();
        if repo.is_private || author.id == AGENT_ID || author.is_member(&slug) {
            return Ok(true);
        }
        // Stored authors carry no memberships: ask the workspace.
        let members: Outcome<Vec<g1t_contracts::identity::Member>> = g1t_kit::call(
            &self.identity,
            "list_members",
            &g1t_contracts::identity::ListMembersArgs { slug, viewer: Some(ws.clone()) },
        )
        .await?;
        Ok(members.into_result().unwrap_or_default().iter().any(|m| m.username.eq_ignore_ascii_case(&author.username)))
    }

    async fn commits(&self, repo: &Repo, actor: &User, after: &str, before: Option<&str>) -> Result<Vec<Commit>> {
        let log: Outcome<Vec<Commit>> = g1t_kit::call(
            &self.repos,
            "log",
            &LogArgs {
                path: RepoPath {
                    namespace: repo.namespace.clone(),
                    name: repo.name.clone(),
                },
                viewer: Some(actor.clone()),
                git_ref: Some(after.to_owned()),
                limit: 20,
            },
        )
        .await?;
        let mut commits: Vec<Commit> = log.into_result().unwrap_or_default();
        if let Some(before) = before
            && let Some(at) = commits.iter().position(|commit| commit.hash == before)
        {
            commits.truncate(at);
        }
        // GitHub lists them oldest first, with the head commit last.
        commits.reverse();
        Ok(commits)
    }

    async fn changed_paths(&self, repo: &Repo, actor: &User, base: Option<String>, head: String) -> Result<Vec<String>> {
        let compared: Outcome<Comparison> = g1t_kit::call(
            &self.repos,
            "compare",
            &CompareArgs {
                repo_id: repo.id.clone(),
                viewer: Some(actor.clone()),
                base,
                head: Some(head),
            },
        )
        .await?;
        Ok(compared.into_result().map(|c| c.files.into_iter().map(|f| f.path).collect()).unwrap_or_default())
    }

    async fn default_head(&self, repo: &Repo) -> Result<Option<String>> {
        g1t_kit::call(
            &self.repos,
            "head",
            &g1t_contracts::repos::HeadArgs {
                repo_id: repo.id.clone(),
                branch: repo.default_branch.clone(),
            },
        )
        .await
    }

    fn repo_path(repo: &Repo) -> RepoPath {
        RepoPath {
            namespace: repo.namespace.clone(),
            name: repo.name.clone(),
        }
    }

    /// The subject of an event of `kind`, as GitHub's `event_name`.
    async fn subject(&self, event: &Event, event_name: &str, action: Option<&str>, repo: &Repo, ws: &User, sender: &str) -> Result<Option<Subject>> {
        let path = Self::repo_path(repo);
        let data = &event.data;
        let on_default = |sha: String, payload: Value, title: String, pull: Option<u32>| Subject {
            source: path.clone(),
            source_ref: None,
            git_ref: format!("refs/heads/{}", repo.default_branch),
            sha,
            head_ref: None,
            base_ref: None,
            pull,
            filter_ref: format!("refs/heads/{}", repo.default_branch),
            paths: None,
            compare: None,
            payload,
            title,
            trusted: true,
        };
        let view = |number: u32| ViewArgs {
            repo: path.clone(),
            number,
            viewer: Some(ws.clone()),
            after_seq: 0,
        };
        Ok(match event_name {
            "push" => {
                let (Some(git_ref), Some(after)) = (data["ref"].as_str(), data["after"].as_str()) else {
                    return Ok(None);
                };
                // The merge queue's states run merge_group workflows, not push ones.
                if git_ref.starts_with("refs/heads/g1t-queue/") {
                    return Ok(None);
                }
                let before = data["before"].as_str();
                let commits = self.commits(repo, ws, after, before).await?;
                let title = commits.last().map(|c| c.message.lines().next().unwrap_or_default().to_owned()).unwrap_or_default();
                let mut payload = payload::push(repo, git_ref, before, after, &commits, sender);
                if let Some(head) = commits.last() {
                    payload["head_commit"] = payload::commit(repo, head);
                }
                Some(Subject {
                    source: path.clone(),
                    source_ref: Some(after.to_owned()),
                    git_ref: git_ref.to_owned(),
                    sha: after.to_owned(),
                    head_ref: None,
                    base_ref: None,
                    pull: None,
                    filter_ref: git_ref.to_owned(),
                    paths: None,
                    compare: Some((before.map(str::to_owned), after.to_owned())),
                    payload,
                    title,
                    trusted: true,
                })
            }
            "pull_request" | "pull_request_target" | "pull_request_review" => {
                let Some(number) = data["number"].as_u64().map(|n| n as u32) else { return Ok(None) };
                let detail: Outcome<PullDetail> = g1t_kit::call(&self.work, "get_pull", &view(number)).await?;
                let Outcome::Ok(detail) = detail else { return Ok(None) };
                let pull = &detail.pull;
                let labels = detail.issue.as_ref().map(|i| i.labels.clone()).unwrap_or_default();
                let mut payload = json!({
                    "action": action,
                    "number": pull.number,
                    "pull_request": payload::pull(repo, pull, &labels),
                    "repository": payload::repository(repo),
                    "sender": payload::user(sender),
                });
                if event_name == "pull_request_review" {
                    let review = detail.comments.iter().rev().find(|c| c.verdict.is_some());
                    payload["review"] = json!({
                        "state": review.and_then(|r| r.verdict).map(|v| format!("{v:?}").to_lowercase()),
                        "body": review.map(|r| r.body.clone()),
                        "user": review.map(|r| payload::user(&r.author.username)),
                    });
                }
                let trusted = self.insider(&pull.author, repo, ws).await?;
                let head_ref = payload::head_ref(pull);
                if event_name == "pull_request_target" {
                    // In the base's context: its workflows, its head.
                    let Some(sha) = self.default_head(repo).await? else { return Ok(None) };
                    let mut subject = on_default(sha, payload, pull.title.clone(), Some(pull.number));
                    subject.head_ref = Some(head_ref);
                    subject.base_ref = Some(repo.default_branch.clone());
                    subject.paths = Some(pull.files.iter().map(|f| f.path.clone()).collect());
                    return Ok(Some(subject));
                }
                // A merged pull request's run is on the commit it landed as,
                // in the repository; otherwise on its head, where that is.
                let landed = match (action, data["commit"].as_str()) {
                    (Some("closed"), Some(commit)) => Some(commit.to_owned()),
                    _ => None,
                };
                let sha = match (&landed, data["commit"].as_str(), &pull.head_commit) {
                    (Some(commit), _, _) => commit.clone(),
                    (None, Some(commit), _) => commit.to_owned(),
                    (None, None, Some(head)) => head.clone(),
                    (None, None, None) => return Ok(None),
                };
                let source = match landed {
                    Some(_) => path.clone(),
                    None => pull.fork.clone().unwrap_or_else(|| path.clone()),
                };
                Some(Subject {
                    source,
                    source_ref: Some(sha.clone()),
                    git_ref: format!("refs/pull/{}/merge", pull.number),
                    sha,
                    head_ref: Some(head_ref),
                    base_ref: Some(repo.default_branch.clone()),
                    pull: Some(pull.number),
                    filter_ref: format!("refs/heads/{}", repo.default_branch),
                    paths: Some(pull.files.iter().map(|f| f.path.clone()).collect()),
                    compare: None,
                    payload,
                    title: pull.title.clone(),
                    trusted,
                })
            }
            "workflow_run" => {
                // A run of a workflow_run workflow does not start another,
                // so two such workflows cannot set each other off.
                if data["event"].as_str() == Some("workflow_run") {
                    return Ok(None);
                }
                let Some(sha) = self.default_head(repo).await? else { return Ok(None) };
                let head_branch = data["ref"].as_str().unwrap_or_default().trim_start_matches("refs/heads/").to_owned();
                let name = data["workflow"].as_str().unwrap_or_default();
                let payload = json!({
                    "action": "completed",
                    "workflow_run": {
                        "id": data["runId"],
                        "name": name,
                        "path": data["path"],
                        "event": data["event"],
                        "status": "completed",
                        "conclusion": data["conclusion"],
                        "head_sha": data["sha"],
                        "head_branch": head_branch,
                        "run_number": data["number"],
                        "html_url": format!("{SITE}/{}/{}/actions/runs/{}", repo.namespace, repo.name, data["runId"].as_str().unwrap_or_default()),
                        "pull_requests": data["pull"].as_u64().map(|n| vec![json!({ "number": n })]).unwrap_or_default(),
                    },
                    "workflow": { "name": name, "path": data["path"] },
                    "repository": payload::repository(repo),
                    "sender": payload::user(sender),
                });
                let mut subject = on_default(sha, payload, format!("After {name}"), None);
                // Branch filters apply to the branch the followed run was on.
                subject.filter_ref = format!("refs/heads/{head_branch}");
                Some(subject)
            }
            "issues" | "issue_comment" => {
                let Some(number) = data["number"].as_u64().map(|n| n as u32) else { return Ok(None) };
                let Some(sha) = self.default_head(repo).await? else { return Ok(None) };
                let issue: Outcome<IssueDetail> = g1t_kit::call(&self.work, "get_issue", &view(number)).await?;
                let (issue_json, comments, title, on_pull) = match issue {
                    Outcome::Ok(detail) => (payload::issue(repo, &detail.issue), detail.comments, detail.issue.title.clone(), false),
                    Outcome::Fail(_) => {
                        let pull: Outcome<PullDetail> = g1t_kit::call(&self.work, "get_pull", &view(number)).await?;
                        let Outcome::Ok(detail) = pull else { return Ok(None) };
                        let labels = detail.issue.as_ref().map(|i| i.labels.clone()).unwrap_or_default();
                        (payload::pull_as_issue(repo, &detail.pull, &labels), detail.comments, detail.pull.title.clone(), true)
                    }
                };
                let mut payload = json!({
                    "action": action,
                    "issue": issue_json,
                    "repository": payload::repository(repo),
                    "sender": payload::user(sender),
                });
                if event_name == "issue_comment" {
                    let comment_id = data["commentId"].as_str();
                    let comment = comments.iter().find(|c| Some(c.id.as_str()) == comment_id).or(comments.last());
                    match comment {
                        Some(comment) => payload["comment"] = payload::comment(repo, number, comment, on_pull),
                        None => return Ok(None),
                    }
                }
                Some(on_default(sha, payload, title, on_pull.then_some(number)))
            }
            _ => None,
        })
    }

    pub async fn on_event(&self, event: &Event) -> Result<()> {
        let Some(repo_id) = event.repo_id.as_deref() else { return Ok(()) };
        let mapped = github_events(&event.kind);
        let pushed_default = event.kind == "git.push" && event.data["defaultBranch"].as_bool() == Some(true);
        if mapped.is_empty() && !pushed_default {
            return Ok(());
        }
        let Some((repo, ws)) = self.repo_by_id(repo_id).await? else { return Ok(()) };
        if pushed_default {
            self.sync(&repo, &ws).await?;
        }
        let sender = self.username(event.actor.as_deref()).await?.unwrap_or_else(|| repo.namespace.clone());
        for (event_name, action) in mapped {
            let Some(mut subject) = self.subject(event, event_name, action, &repo, &ws, &sender).await? else {
                continue;
            };
            let read = self.read_workflows(&subject.source, &ws, subject.source_ref.as_deref()).await?;
            // A pull request's head runs each workflow once, however many
            // events say it is there (marked ready, and pushed).
            let key = match subject.pull {
                Some(number) if event_name.starts_with("pull_request") && event_name != "pull_request_review" => {
                    let phase = if action == Some("closed") { "closed" } else { "open" };
                    format!("{event_name}:{number}:{}:{phase}", subject.sha)
                }
                _ => event.id.clone(),
            };
            self.start_matching(&repo, &ws, read, &mut subject, event_name, action, &key, event.actor.as_deref(), &sender)
                .await?;
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn start_matching(
        &self,
        repo: &Repo,
        ws: &User,
        read: Read,
        subject: &mut Subject,
        event_name: &str,
        action: Option<&str>,
        event_key: &str,
        actor_id: Option<&str>,
        sender: &str,
    ) -> Result<()> {
        for file in read.files {
            let parsed = workflow::parse(&file.source);
            let workflow = match parsed {
                Ok(workflow) => workflow,
                Err(problem) => {
                    // A push shows a broken workflow as a failed run, as GitHub does.
                    if event_name == "push" && file.source.contains("on") {
                        self.record_invalid(repo, &file.path, &file.source, subject, event_key, actor_id, sender, &problem)
                            .await?;
                    }
                    continue;
                }
            };
            let Some(trigger) = workflow.trigger(event_name) else { continue };
            // workflow_run follows the workflows it names.
            if event_name == "workflow_run" {
                let followed = subject.payload["workflow_run"]["name"].as_str().unwrap_or_default();
                if !trigger.workflows.iter().any(|name| name == followed) {
                    continue;
                }
            }
            if !trigger.wants_type(action) || !self.passes(repo, ws, trigger, subject, event_name).await? {
                continue;
            }
            if self.disabled(&repo.id, &file.path).await? {
                continue;
            }
            self.create_run(NewRun {
                repo: repo.clone(),
                path: file.path,
                source: file.source,
                info: self.run_info(repo, &workflow, event_name, subject, sender, actor_id),
                workflow,
                action: action.map(str::to_owned),
                pull: subject.pull,
                title: subject.title.clone(),
                inputs: Map::new(),
                event_key: event_key.to_owned(),
                actor_id: actor_id.map(str::to_owned),
                actor: Some(sender.to_owned()),
                trusted: subject.trusted,
            })
            .await?;
        }
        Ok(())
    }

    /// Whether the branch, tag and path filters let the event through.
    async fn passes(&self, repo: &Repo, ws: &User, trigger: &Trigger, subject: &mut Subject, event_name: &str) -> Result<bool> {
        let git_ref = subject.filter_ref.as_str();
        if let Some(tag) = git_ref.strip_prefix("refs/tags/") {
            // A tag push runs a workflow that filters tags, or filters nothing.
            if trigger.tags.is_set() {
                if !trigger.tags.allows(tag) {
                    return Ok(false);
                }
            } else if trigger.branches.is_set() {
                return Ok(false);
            }
            // Paths are not checked for tags, as on GitHub.
            return Ok(true);
        }
        let branch = git_ref.strip_prefix("refs/heads/").unwrap_or(git_ref);
        if trigger.branches.is_set() {
            if !trigger.branches.allows(branch) {
                return Ok(false);
            }
        } else if event_name == "push" && trigger.tags.is_set() {
            return Ok(false);
        }
        if trigger.paths.is_set() {
            if subject.paths.is_none() {
                let (base, head) = subject.compare.clone().unwrap_or((None, subject.sha.clone()));
                subject.paths = Some(self.changed_paths(repo, ws, base, head).await?);
            }
            if !trigger.paths.allows_paths(subject.paths.as_deref().unwrap_or_default()) {
                return Ok(false);
            }
        }
        Ok(true)
    }

    async fn disabled(&self, repo_id: &str, path: &str) -> Result<bool> {
        let row = self
            .db
            .prepare("SELECT * FROM workflows WHERE repo_id = ? AND path = ?")
            .bind(&[repo_id.into(), path.into()])?
            .first::<WorkflowRow>(None)
            .await?;
        Ok(row.is_some_and(|row| row.state == "disabled"))
    }

    fn run_info(&self, repo: &Repo, workflow: &Workflow, event_name: &str, subject: &Subject, sender: &str, actor_id: Option<&str>) -> RunInfo {
        RunInfo {
            repository: format!("{}/{}", repo.namespace, repo.name),
            repository_id: repo.id.clone(),
            default_branch: repo.default_branch.clone(),
            event_name: event_name.to_owned(),
            event: subject.payload.clone(),
            git_ref: subject.git_ref.clone(),
            sha: subject.sha.clone(),
            head_ref: subject.head_ref.clone(),
            base_ref: subject.base_ref.clone(),
            actor: sender.to_owned(),
            actor_id: actor_id.unwrap_or_default().to_owned(),
            triggering_actor: sender.to_owned(),
            run_id: String::new(),
            run_number: 0,
            run_attempt: 1,
            workflow: workflow.name.clone().unwrap_or_default(),
            workflow_path: String::new(),
            server_url: SITE.to_owned(),
            api_url: API.to_owned(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn record_invalid(
        &self,
        repo: &Repo,
        path: &str,
        source: &str,
        subject: &Subject,
        event_key: &str,
        actor_id: Option<&str>,
        sender: &str,
        problem: &str,
    ) -> Result<()> {
        let row = self.workflow_row(repo, path, path, source).await?;
        self.record_failed_run(&row, subject.git_ref.as_str(), &subject.sha, event_key, actor_id, sender, problem).await
    }

    /// Scheduled workflows whose cron fires this minute, on the default branch.
    pub async fn run_schedules(&self, minute: u64) -> Result<()> {
        let rows = self
            .db
            .prepare("SELECT * FROM workflows WHERE state = 'active' AND crons != '[]' AND error IS NULL")
            .all()
            .await?
            .results::<WorkflowRow>()?;
        for row in rows {
            let crons: Vec<String> = serde_json::from_str(&row.crons).unwrap_or_default();
            let Some(cron) = crons.iter().find(|cron| g1t_actions::cron::Schedule::parse(cron).is_ok_and(|s| s.fires_at(minute))) else {
                continue;
            };
            let Ok(workflow) = workflow::parse(&row.source) else { continue };
            let Some((repo, _ws)) = self.repo_by_id(&row.repo_id).await? else { continue };
            let Some(sha) = self.default_head(&repo).await? else { continue };
            let payload = json!({ "schedule": cron, "repository": payload::repository(&repo), "workflow": row.path });
            let mut subject = Subject {
                source: Self::repo_path(&repo),
                source_ref: None,
                git_ref: format!("refs/heads/{}", repo.default_branch),
                sha,
                head_ref: None,
                base_ref: None,
                pull: None,
                filter_ref: String::new(),
                paths: None,
                compare: None,
                payload,
                title: format!("Scheduled: {cron}"),
                trusted: true,
            };
            subject.filter_ref = subject.git_ref.clone();
            let info = self.run_info(&repo, &workflow, "schedule", &subject, &repo.namespace, None);
            self.create_run(NewRun {
                repo: repo.clone(),
                path: row.path.clone(),
                source: row.source.clone(),
                workflow,
                info,
                action: None,
                pull: None,
                title: subject.title.clone(),
                inputs: Map::new(),
                event_key: format!("schedule:{minute}"),
                actor_id: None,
                actor: None,
                trusted: true,
            })
            .await?;
        }
        Ok(())
    }

    /// `dispatch`: a member runs a workflow that has `workflow_dispatch`.
    pub async fn dispatch(&self, a: DispatchArgs) -> Result<Outcome<WorkflowRun>> {
        if let Some(refused) = Self::member(&a.actor, &a.repo) {
            return Ok(check_refusal(refused));
        }
        let Some(repo) = self.visible_repo(&a.repo, &Some(a.actor.clone())).await? else {
            return Ok(fail(FailureCode::NotFound, "There is no such repository."));
        };
        let Some(ws) = self.workspace_actor(&repo.namespace).await? else {
            return Ok(fail(FailureCode::NotFound, "There is no such workspace."));
        };
        let git_ref = a.git_ref.clone().unwrap_or_else(|| repo.default_branch.clone());
        let full_ref = if git_ref.starts_with("refs/") {
            git_ref.clone()
        } else {
            // A branch if there is one by that name, otherwise a tag.
            let branches: Outcome<Vec<g1t_contracts::repos::Branch>> = g1t_kit::call(
                &self.repos,
                "branches",
                &g1t_contracts::repos::BranchesArgs {
                    path: Self::repo_path(&repo),
                    viewer: Some(ws.clone()),
                },
            )
            .await?;
            let is_branch = branches.into_result().unwrap_or_default().iter().any(|branch| branch.name == git_ref);
            format!("refs/{}/{git_ref}", if is_branch { "heads" } else { "tags" })
        };
        let short = full_ref.trim_start_matches("refs/heads/").trim_start_matches("refs/tags/").to_owned();
        let read = self.read_workflows(&Self::repo_path(&repo), &ws, Some(&short)).await?;
        let Some(sha) = read.head.clone() else {
            return Ok(fail(FailureCode::NotFound, format!("There is no branch or tag called {short}.")));
        };
        // A workflow is named by its file (`build.yml`), its path, or its id
        // (`wfl_…`), which stands for the path it was read from.
        let by_id = if a.workflow.starts_with("wfl_") {
            self.db
                .prepare("SELECT * FROM workflows WHERE repo_id = ? AND id = ?")
                .bind(&[repo.id.as_str().into(), a.workflow.as_str().into()])?
                .first::<WorkflowRow>(None)
                .await?
                .map(|row| row.path)
        } else {
            None
        };
        let named = by_id.as_deref().unwrap_or(&a.workflow);
        let wanted = named.trim_start_matches(".g1t/workflows/");
        let Some(file) = read.files.iter().find(|file| {
            file.path.rsplit('/').next() == Some(wanted) || file.path == named
        }) else {
            return Ok(fail(FailureCode::NotFound, format!("There is no workflow {wanted} on {short}.")));
        };
        let workflow = match workflow::parse(&file.source) {
            Ok(workflow) => workflow,
            Err(problem) => return Ok(fail(FailureCode::Invalid, format!("The workflow does not read: {problem}"))),
        };
        let Some(trigger) = workflow.trigger("workflow_dispatch") else {
            return Ok(fail(FailureCode::Invalid, "That workflow cannot be run by hand: it has no `workflow_dispatch` trigger."));
        };
        let inputs = check!(dispatch_inputs(trigger, &a.inputs));
        let payload = json!({
            "inputs": inputs,
            "ref": full_ref,
            "repository": payload::repository(&repo),
            "sender": payload::user(&a.actor.username),
            "workflow": file.path,
        });
        let subject = Subject {
            source: Self::repo_path(&repo),
            source_ref: Some(sha.clone()),
            git_ref: full_ref.clone(),
            sha,
            head_ref: None,
            base_ref: None,
            pull: None,
            filter_ref: full_ref,
            paths: None,
            compare: None,
            payload,
            title: format!("{} run by {}", workflow.display_name(&file.path), a.actor.username),
            trusted: true,
        };
        let info = self.run_info(&repo, &workflow, "workflow_dispatch", &subject, &a.actor.username, Some(&a.actor.id));
        let created = self
            .create_run(NewRun {
                repo: repo.clone(),
                path: file.path.clone(),
                source: file.source.clone(),
                workflow,
                info,
                action: None,
                pull: None,
                title: subject.title.clone(),
                inputs,
                event_key: format!("dispatch:{}", new_id("dsp", now_ms())),
                actor_id: Some(a.actor.id.clone()),
                actor: Some(a.actor.username.clone()),
                trusted: true,
            })
            .await?;
        match created {
            Some(id) => self.run_summary(&id).await,
            None => Ok(fail(FailureCode::Conflict, "It did not start.")),
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeGroupArgs {
    pub repo_id: String,
    pub entry: String,
    pub sha: String,
    pub head_ref: String,
    #[serde(default)]
    pub base_sha: Option<String>,
    pub number: u32,
    #[serde(default)]
    pub ahead: Vec<u32>,
}

impl Actions {
    /// `merge_group`: the merge queue built a state and its checks passed.
    /// Starts the workflows that run `on: merge_group` on it, as GitHub's
    /// queue does, and says how many started; the queue waits for their
    /// statuses on that commit.
    pub async fn merge_group(&self, a: MergeGroupArgs) -> Result<Outcome<Value>> {
        let Some((repo, ws)) = self.repo_by_id(&a.repo_id).await? else {
            return Ok(Outcome::Ok(json!({ "runs": 0 })));
        };
        let read = self.read_workflows(&Self::repo_path(&repo), &ws, Some(&a.sha)).await?;
        let head_commit = self.commits(&repo, &ws, &a.sha, None).await?.pop();
        let payload = json!({
            "action": "checks_requested",
            "merge_group": {
                "head_sha": a.sha,
                "head_ref": a.head_ref,
                "base_sha": a.base_sha,
                "base_ref": format!("refs/heads/{}", repo.default_branch),
                "head_commit": head_commit.as_ref().map(|c| payload::commit(&repo, c)),
            },
            "repository": payload::repository(&repo),
            "sender": payload::user(&repo.namespace),
        });
        let mut started = 0u32;
        for file in read.files {
            let Ok(workflow) = workflow::parse(&file.source) else { continue };
            let Some(trigger) = workflow.trigger("merge_group") else { continue };
            if !trigger.wants_type(Some("checks_requested")) || self.disabled(&repo.id, &file.path).await? {
                continue;
            }
            // Branch filters on merge_group name the branch it merges into.
            if trigger.branches.is_set() && !trigger.branches.allows(&repo.default_branch) {
                continue;
            }
            let ahead = if a.ahead.is_empty() {
                String::new()
            } else {
                format!(" after {}", a.ahead.iter().map(|n| format!("#{n}")).collect::<Vec<_>>().join(", "))
            };
            let subject = Subject {
                source: Self::repo_path(&repo),
                source_ref: Some(a.sha.clone()),
                git_ref: a.head_ref.clone(),
                sha: a.sha.clone(),
                head_ref: None,
                base_ref: Some(repo.default_branch.clone()),
                pull: Some(a.number),
                filter_ref: format!("refs/heads/{}", repo.default_branch),
                paths: None,
                compare: None,
                payload: payload.clone(),
                title: format!("Merge queue: #{}{ahead}", a.number),
                trusted: true,
            };
            let info = self.run_info(&repo, &workflow, "merge_group", &subject, &repo.namespace, None);
            let created = self
                .create_run(NewRun {
                    repo: repo.clone(),
                    path: file.path.clone(),
                    source: file.source.clone(),
                    workflow,
                    info,
                    action: Some("checks_requested".to_owned()),
                    pull: Some(a.number),
                    title: subject.title.clone(),
                    inputs: Map::new(),
                    event_key: format!("merge_group:{}:{}", a.entry, a.sha),
                    actor_id: None,
                    actor: None,
                    trusted: true,
                })
                .await?;
            if created.is_some() {
                started += 1;
            }
        }
        Ok(Outcome::Ok(json!({ "runs": started })))
    }
}

fn check_refusal<T>(refused: Outcome<()>) -> Outcome<T> {
    match refused {
        Outcome::Fail(failure) => Outcome::Fail(failure),
        Outcome::Ok(()) => fail(FailureCode::Forbidden, "Not allowed."),
    }
}

/// The inputs of a manual run: what was given, checked against the
/// workflow's declared inputs, with their defaults filled in.
fn dispatch_inputs(trigger: &Trigger, given: &Map<String, Value>) -> Outcome<Map<String, Value>> {
    let mut inputs = Map::new();
    for (name, spec) in &trigger.inputs {
        let kind = spec.get("type").and_then(Value::as_str).unwrap_or("string");
        let value = given.get(name).cloned().or_else(|| spec.get("default").cloned());
        let required = spec.get("required").and_then(Value::as_bool).unwrap_or(false);
        let value = match value {
            Some(Value::Null) | None if required => return fail(FailureCode::Invalid, format!("The input `{name}` is required.")),
            Some(Value::Null) | None => match kind {
                "boolean" => Value::Bool(false),
                _ => Value::String(String::new()),
            },
            Some(value) => match kind {
                "boolean" => Value::Bool(match &value {
                    Value::Bool(flag) => *flag,
                    Value::String(text) => text == "true",
                    _ => false,
                }),
                "number" => match &value {
                    Value::Number(_) => value,
                    Value::String(text) => match text.parse::<f64>().ok().and_then(serde_json::Number::from_f64) {
                        Some(number) => Value::Number(number),
                        None => return fail(FailureCode::Invalid, format!("The input `{name}` is a number.")),
                    },
                    _ => return fail(FailureCode::Invalid, format!("The input `{name}` is a number.")),
                },
                "choice" => {
                    let text = g1t_actions::expr::to_text(&value);
                    let options: Vec<String> =
                        spec.get("options").and_then(Value::as_array).map(|o| o.iter().map(g1t_actions::expr::to_text).collect()).unwrap_or_default();
                    if !options.is_empty() && !options.contains(&text) {
                        return fail(FailureCode::Invalid, format!("The input `{name}` is one of {}.", options.join(", ")));
                    }
                    Value::String(text)
                }
                _ => Value::String(g1t_actions::expr::to_text(&value)),
            },
        };
        inputs.insert(name.clone(), value);
    }
    Outcome::Ok(inputs)
}
