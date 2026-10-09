//! What starts a run: an event on the bus, a schedule, or someone running a
//! workflow by hand. Each finds the workflows that want it, at the commit
//! the event is about, and checks their filters.

use g1t_actions::events::{RunInfo, github_events};
use g1t_actions::workflow::{self, Trigger, Workflow};
use g1t_contracts::access::{self, Capability};
use g1t_contracts::actions::{DispatchArgs, RepositoryDispatchArgs, WorkflowRun};
use g1t_contracts::events::{Event, caused_by_job};
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
    /// Why its runs wait for approval first: a pull request from outside,
    /// by the repository's approval policy (protection.rs).
    approval: Option<String>,
}

/// Whether a deployment's `ref` is a commit's full hash rather than a
/// branch or tag.
fn is_commit(name: &str) -> bool {
    name.len() == 40 && name.chars().all(|c| c.is_ascii_hexdigit())
}

/// Whether whoever a pull request is for is trusted without asking
/// identity: g1t's agent in work nobody asked it for, or someone whose
/// role here is known to allow pushing.
fn trusted_outright(owner: &User, repo: &Repo) -> bool {
    owner.id == AGENT_ID || access::can(Some(owner), repo, Capability::Push)
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

    /// Whether whoever a pull request is for (Pull::owner: whoever asked
    /// g1t for it, or its author) could push to the repository, so its
    /// runs get the secrets and a token. Anyone else's, a reader's included
    /// (who may open one on a private repository too), runs without them.
    /// A change g1t made for someone is trusted as they are.
    async fn insider(&self, owner: &User, repo: &Repo, ws: &User) -> Result<bool> {
        if trusted_outright(owner, repo) {
            return Ok(true);
        }
        // Stored authors carry no memberships or grants: ask identity, as
        // the workspace (which may see anyone's permission).
        let permission: Outcome<access::PermissionInfo> = g1t_kit::call(
            &self.identity,
            "collaborator_permission",
            &access::CollaboratorPermissionArgs {
                viewer: Some(ws.clone()),
                path: RepoPath { namespace: repo.namespace.clone(), name: repo.name.clone() },
                username: owner.username.clone(),
            },
        )
        .await?;
        Ok(permission
            .into_result()
            .ok()
            .and_then(|info| info.role)
            .is_some_and(|role| access::allows(role, Capability::Push)))
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
                base_branch: None,
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

    /// Whether `name` is one of the repository's branches.
    async fn is_branch(&self, repo: &Repo, ws: &User, name: &str) -> Result<bool> {
        let branches: Outcome<Vec<g1t_contracts::repos::Branch>> = g1t_kit::call(
            &self.repos,
            "branches",
            &g1t_contracts::repos::BranchesArgs {
                path: Self::repo_path(repo),
                viewer: Some(ws.clone()),
            },
        )
        .await?;
        Ok(branches.into_result().unwrap_or_default().iter().any(|branch| branch.name == name))
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
            approval: None,
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
                    approval: None,
                })
            }
            // A branch or tag was made: its own commit, as on GitHub.
            "create" => {
                let (Some(git_ref), Some(after)) = (data["ref"].as_str(), data["after"].as_str()) else {
                    return Ok(None);
                };
                if git_ref.starts_with("refs/heads/g1t-queue/") || !data["before"].is_null() {
                    return Ok(None);
                }
                let (ref_type, name) = match (git_ref.strip_prefix("refs/heads/"), git_ref.strip_prefix("refs/tags/")) {
                    (Some(branch), _) => ("branch", branch),
                    (_, Some(tag)) => ("tag", tag),
                    _ => return Ok(None),
                };
                let payload = json!({
                    "ref": name,
                    "ref_type": ref_type,
                    "master_branch": repo.default_branch,
                    "description": repo.description,
                    "pusher_type": "user",
                    "repository": payload::repository(repo),
                    "sender": payload::user(sender),
                });
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
                    compare: None,
                    payload,
                    title: format!("Created {ref_type} {name}"),
                    trusted: true,
                    approval: None,
                })
            }
            "pull_request" | "pull_request_target" | "pull_request_review" => {
                let Some(number) = data["number"].as_u64().map(|n| n as u32) else { return Ok(None) };
                let detail: Outcome<PullDetail> = g1t_kit::call(&self.work, "get_pull", &view(number)).await?;
                let Outcome::Ok(detail) = detail else { return Ok(None) };
                let pull = &detail.pull;
                let base_ref = pull.base_branch(&repo.default_branch).to_owned();
                let mut payload = json!({
                    "action": action,
                    "number": pull.number,
                    "pull_request": payload::pull(repo, pull),
                    "repository": payload::repository(repo),
                    "sender": payload::user(sender),
                });
                payload::changed(&mut payload, data);
                if event_name == "pull_request_review" {
                    let review = detail.comments.iter().rev().find(|c| c.verdict.is_some());
                    payload["review"] = json!({
                        "state": review.and_then(|r| r.verdict).map(|v| format!("{v:?}").to_lowercase()),
                        "body": review.map(|r| r.body.clone()),
                        "user": review.map(|r| payload::user(&r.author.username)),
                    });
                }
                let trusted = self.insider(pull.owner(), repo, ws).await?;
                // A pull request from outside may wait for approval before
                // its head's code runs. `pull_request_target` runs the
                // base's code, and a merged one's run the commit it landed
                // as, so neither waits.
                let approval = if event_name != "pull_request_target" && action != Some("closed") {
                    self.approval_needed(repo, pull.owner(), ws).await?
                } else {
                    None
                };
                let head_ref = payload::head_ref(pull);
                if event_name == "pull_request_target" {
                    // In the base's context: its workflows, its head.
                    let Some(sha) = self.default_head(repo).await? else { return Ok(None) };
                    let mut subject = on_default(sha, payload, pull.title.clone(), Some(pull.number));
                    subject.head_ref = Some(head_ref);
                    subject.base_ref = Some(base_ref.clone());
                    subject.filter_ref = format!("refs/heads/{base_ref}");
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
                    base_ref: Some(base_ref.clone()),
                    pull: Some(pull.number),
                    // `branches` filters on pull requests name the base.
                    filter_ref: format!("refs/heads/{base_ref}"),
                    paths: Some(pull.files.iter().map(|f| f.path.clone()).collect()),
                    compare: None,
                    payload,
                    title: pull.title.clone(),
                    trusted,
                    approval,
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
                        (payload::pull_as_issue(repo, &detail.pull), detail.comments, detail.pull.title.clone(), true)
                    }
                };
                let mut payload = json!({
                    "action": action,
                    "issue": issue_json,
                    "repository": payload::repository(repo),
                    "sender": payload::user(sender),
                });
                payload::changed(&mut payload, data);
                if event_name == "issue_comment" {
                    let comment_id = data["commentId"].as_str();
                    if action == Some("deleted") {
                        // Gone by now: as the event kept it.
                        match data.get("comment").filter(|kept| kept.is_object()) {
                            Some(kept) => payload["comment"] = payload::deleted_comment(repo, number, kept, on_pull),
                            None => return Ok(None),
                        }
                    } else {
                        let comment = comments.iter().find(|c| Some(c.id.as_str()) == comment_id);
                        // A new comment is the newest; an edited one must be found.
                        let comment = if action == Some("created") { comment.or(comments.last()) } else { comment };
                        match comment {
                            Some(comment) => payload["comment"] = payload::comment(repo, number, comment, on_pull),
                            None => return Ok(None),
                        }
                    }
                    // `edited`: what the body was before.
                    if let Some(changes) = data.get("changes").filter(|changes| changes.is_object()) {
                        payload["changes"] = changes.clone();
                    }
                }
                Some(on_default(sha, payload, title, on_pull.then_some(number)))
            }
            // A release: on its tag, at the commit the tag named.
            "release" => {
                let release = &data["release"];
                let Some(tag) = data["tagName"].as_str().or_else(|| release["tagName"].as_str()) else { return Ok(None) };
                let sha = match release["target"].as_str().filter(|target| !target.is_empty()) {
                    Some(target) => target.to_owned(),
                    None => match self.default_head(repo).await? {
                        Some(head) => head,
                        None => return Ok(None),
                    },
                };
                let git_ref = format!("refs/tags/{tag}");
                let mut payload = json!({
                    "action": action,
                    "release": payload::release(repo, release),
                    "repository": payload::repository(repo),
                    "sender": payload::user(sender),
                });
                if let Some(changes) = data.get("changes").filter(|changes| changes.is_object()) {
                    payload["changes"] = changes.clone();
                }
                let name = release["name"].as_str().filter(|name| !name.is_empty()).unwrap_or(tag);
                Some(Subject {
                    source: path.clone(),
                    source_ref: Some(sha.clone()),
                    git_ref: git_ref.clone(),
                    sha,
                    head_ref: None,
                    base_ref: None,
                    pull: None,
                    filter_ref: git_ref,
                    paths: None,
                    compare: None,
                    payload,
                    title: format!("Release {name} {}", action.unwrap_or("changed")),
                    trusted: true,
                    approval: None,
                })
            }
            // A deployment, or a new status of one: at the commit deployed,
            // on the branch or tag it names (none for a bare commit).
            "deployment" | "deployment_status" => {
                let deployment = &data["deployment"];
                let Some(sha) = deployment["sha"].as_str().filter(|sha| !sha.is_empty()).map(str::to_owned) else { return Ok(None) };
                let named = deployment["ref"].as_str().unwrap_or_default();
                let git_ref = if named.is_empty() || named == sha || is_commit(named) {
                    String::new()
                } else if named.starts_with("refs/") {
                    named.to_owned()
                } else if self.is_branch(repo, ws, named).await? {
                    format!("refs/heads/{named}")
                } else {
                    format!("refs/tags/{named}")
                };
                let environment = deployment["environment"].as_str().unwrap_or_default();
                let mut payload = json!({
                    "action": "created",
                    "deployment": payload::deployment(repo, deployment),
                    "repository": payload::repository(repo),
                    "sender": payload::user(sender),
                });
                let title = if event_name == "deployment_status" {
                    let status = &data["deploymentStatus"];
                    payload["deployment_status"] = payload::deployment_status(repo, status, deployment);
                    format!("Deployment to {environment}: {}", status["state"].as_str().unwrap_or("changed"))
                } else {
                    format!("Deployment to {environment}")
                };
                Some(Subject {
                    source: path.clone(),
                    source_ref: Some(sha.clone()),
                    filter_ref: git_ref.clone(),
                    git_ref,
                    sha,
                    head_ref: None,
                    base_ref: None,
                    pull: None,
                    paths: None,
                    compare: None,
                    payload,
                    title,
                    trusted: true,
                    approval: None,
                })
            }
            _ => None,
        })
    }

    pub async fn on_event(&self, event: &Event) -> Result<()> {
        let Some(repo_id) = event.repo_id.as_deref() else { return Ok(()) };
        let mut mapped = github_events(&event.kind);
        // A new branch or tag is also `create`.
        if event.kind == "git.push" && event.data["before"].is_null() {
            mapped.push(("create", None));
        }
        let pushed_default = event.kind == "git.push" && event.data["defaultBranch"].as_bool() == Some(true);
        if mapped.is_empty() && !pushed_default {
            return Ok(());
        }
        let Some((repo, ws)) = self.repo_by_id(repo_id).await? else { return Ok(()) };
        if pushed_default {
            self.sync(&repo, &ws).await?;
        }
        // What a workflow job's own token did starts no workflows, as on
        // GitHub, so a workflow cannot set itself off; only
        // `workflow_dispatch` and `repository_dispatch` do.
        if let Some(run) = caused_by_job(&event.data) {
            worker::console_log!("actions: {} {} came from run {run}'s token; no workflows start for it", event.kind, event.id);
            return Ok(());
        }
        let sender = self.username(event.actor.as_deref()).await?.unwrap_or_else(|| repo.namespace.clone());
        for (event_name, action) in mapped {
            // Issues and comments start the default branch's workflows,
            // which the synced table lists: when none listens, nothing is
            // read from git. Agents make many of these events.
            // Deployments' statuses are as frequent (every g1t.page build
            // reports several), so they look there first too.
            if matches!(event_name, "issues" | "issue_comment" | "deployment" | "deployment_status")
                && self.listens(repo_id, event_name).await? == Some(false)
            {
                continue;
            }
            let Some(mut subject) = self.subject(event, event_name, action, &repo, &ws, &sender).await? else {
                continue;
            };
            let read = self.read_workflows(&subject.source, &ws, subject.source_ref.as_deref()).await?;
            // A pull request's head runs each workflow once, however many
            // events say it is there (marked ready, and pushed).
            let key = match subject.pull {
                Some(number) if event_name.starts_with("pull_request") && event_name != "pull_request_review" => {
                    // Reopened or made a draft again runs anew, at a head
                    // that may have run before.
                    let phase = match action {
                        Some("closed") => "closed".to_owned(),
                        Some(again @ ("reopened" | "converted_to_draft")) => format!("{again}:{}", event.id),
                        _ => "open".to_owned(),
                    };
                    format!("{event_name}:{number}:{}:{phase}", subject.sha)
                }
                _ if event_name == "create" => format!("{}:create", event.id),
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
                approval: subject.approval.clone(),
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
            // Schedules wait while a repository is archived; a deleted one is not found.
            let Some((repo, _ws)) = self.repo_by_id(&row.repo_id).await?.filter(|(repo, _)| !repo.archived()) else { continue };
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
                approval: None,
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
                approval: None,
            })
            .await?;
        }
        Ok(())
    }

    /// `dispatch`: someone with the Write role runs a workflow that has
    /// `workflow_dispatch`.
    pub async fn dispatch(&self, a: DispatchArgs) -> Result<Outcome<WorkflowRun>> {
        let repo = check!(self.may(&a.actor, &a.repo, Capability::Run).await?);
        if repo.archived() {
            return Ok(fail(FailureCode::Forbidden, g1t_contracts::repos::archived_message(&repo.namespace, &repo.name)));
        }
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
            approval: None,
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
                approval: None,
            })
            .await?;
        match created {
            Some(id) => self.run_summary(&id).await,
            None => Ok(fail(FailureCode::Conflict, "It did not start.")),
        }
    }

    /// `repository_dispatch`: an outside event, by name, starts the default
    /// branch's workflows that run `on: repository_dispatch` with that type
    /// (or with no `types`). A workflow job's token may send one: this,
    /// with `workflow_dispatch`, is how a workflow starts another.
    pub async fn repository_dispatch(&self, a: RepositoryDispatchArgs) -> Result<Outcome<u32>> {
        let repo = check!(self.may(&a.actor, &a.repo, Capability::Push).await?);
        if repo.archived() {
            return Ok(fail(FailureCode::Forbidden, g1t_contracts::repos::archived_message(&repo.namespace, &repo.name)));
        }
        let event_type = a.event_type.trim().to_owned();
        if event_type.is_empty() || event_type.chars().count() > 100 {
            return Ok(fail(FailureCode::Invalid, "event_type is 1 to 100 characters."));
        }
        let client_payload = match a.client_payload {
            Value::Null => json!({}),
            Value::Object(map) if map.len() <= 10 => Value::Object(map),
            Value::Object(_) => return Ok(fail(FailureCode::Invalid, "client_payload has at most 10 top-level properties.")),
            _ => return Ok(fail(FailureCode::Invalid, "client_payload is a JSON object.")),
        };
        if serde_json::to_string(&client_payload).map_or(0, |text| text.len()) > 64 * 1024 {
            return Ok(fail(FailureCode::Invalid, "client_payload is at most 64 KB."));
        }
        let Some(ws) = self.workspace_actor(&repo.namespace).await? else {
            return Ok(fail(FailureCode::NotFound, "There is no such workspace."));
        };
        let read = self.read_workflows(&Self::repo_path(&repo), &ws, Some(&repo.default_branch)).await?;
        let Some(sha) = read.head.clone() else {
            return Ok(fail(FailureCode::NotFound, "The repository has no default branch to run on yet."));
        };
        let git_ref = format!("refs/heads/{}", repo.default_branch);
        let payload = json!({
            "action": event_type,
            "branch": repo.default_branch,
            "client_payload": client_payload,
            "repository": payload::repository(&repo),
            "sender": payload::user(&a.actor.username),
        });
        let key = format!("repository_dispatch:{}", new_id("dsp", now_ms()));
        let mut started = 0u32;
        for file in read.files {
            let Ok(workflow) = workflow::parse(&file.source) else { continue };
            let Some(trigger) = workflow.trigger("repository_dispatch") else { continue };
            if !trigger.wants_type(Some(&event_type)) || self.disabled(&repo.id, &file.path).await? {
                continue;
            }
            let subject = Subject {
                source: Self::repo_path(&repo),
                source_ref: Some(sha.clone()),
                git_ref: git_ref.clone(),
                sha: sha.clone(),
                head_ref: None,
                base_ref: None,
                pull: None,
                filter_ref: git_ref.clone(),
                paths: None,
                compare: None,
                payload: payload.clone(),
                title: event_type.clone(),
                trusted: true,
                approval: None,
            };
            let info = self.run_info(&repo, &workflow, "repository_dispatch", &subject, &a.actor.username, Some(&a.actor.id));
            let created = self
                .create_run(NewRun {
                    repo: repo.clone(),
                    path: file.path.clone(),
                    source: file.source.clone(),
                    workflow,
                    info,
                    action: Some(event_type.clone()),
                    pull: None,
                    title: subject.title.clone(),
                    inputs: Map::new(),
                    event_key: key.clone(),
                    actor_id: Some(a.actor.id.clone()),
                    actor: Some(a.actor.username.clone()),
                    trusted: true,
                    approval: None,
                })
                .await?;
            if created.is_some() {
                started += 1;
            }
        }
        Ok(Outcome::Ok(started))
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
                approval: None,
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
                    approval: None,
                })
                .await?;
            if created.is_some() {
                started += 1;
            }
        }
        Ok(Outcome::Ok(json!({ "runs": started })))
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

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::work::{Pull, g1t_author};

    #[test]
    fn every_event_a_workflow_runs_on_is_sent_to_this_queue() {
        for kind in g1t_contracts::webhooks::EVENT_TYPES {
            if !github_events(kind).is_empty() {
                assert!(
                    g1t_contracts::subscribers::routed("SUBSCRIBER_ACTIONS", kind),
                    "{kind} starts workflows but is not routed to actions (g1t_contracts::subscribers)"
                );
            }
        }
    }
    use g1t_contracts::{Membership, PrincipalKind};

    fn repo() -> Repo {
        serde_json::from_value(json!({
            "id": "rep_1", "namespace": "acme", "name": "web", "description": null, "isPrivate": true,
            "ownerId": "ws_1", "defaultBranch": "main", "forkOf": null, "createdAt": ""
        }))
        .unwrap()
    }

    fn person(id: &str, username: &str) -> User {
        User { id: id.into(), username: username.into(), kind: PrincipalKind::User, ..User::default() }
    }

    fn made_for(asker: User) -> Pull {
        serde_json::from_value(json!({
            "id": "pr_1", "repoId": "rep_1", "number": 14, "issue": 12, "title": "Fix it", "body": null,
            "agent": "g1t", "runtime": "hosted", "status": "open",
            "fork": { "namespace": "pulls", "name": "pr_1" }, "forkRepoId": "rep_f",
            "branch": null, "headCommit": "abc", "mergeBase": null, "mergedBy": null, "mergedAt": null,
            "supersededBy": null, "checkStatus": null,
            "author": g1t_author(), "requestedBy": asker,
            "createdAt": "", "updatedAt": ""
        }))
        .unwrap()
    }

    #[test]
    fn g1t_s_change_for_someone_is_trusted_as_they_are() {
        // Stored people carry no memberships, so identity is asked about
        // them; being g1t's change gives it nothing more.
        let pull = made_for(person("usr_2", "ana"));
        assert!(!trusted_outright(pull.owner(), &repo()));
        // Someone known to be able to push is trusted at once.
        let mut member = person("usr_1", "syntaqx");
        member.workspaces.push(Membership::member("acme"));
        let pull = made_for(member);
        assert!(trusted_outright(pull.owner(), &repo()));
    }

    #[test]
    fn the_payload_names_g1t_as_its_user_and_who_asked_for_it() {
        let pull = made_for(person("usr_1", "syntaqx"));
        let event = payload::pull(&repo(), &pull);
        assert_eq!(event["user"]["login"], "g1t");
        assert_eq!(event["user"]["type"], "Bot");
        assert_eq!(event["requested_by"]["login"], "syntaqx");
        assert_eq!(event["requested_by"]["type"], "User");
        let as_issue = payload::pull_as_issue(&repo(), &pull);
        assert_eq!(as_issue["user"]["login"], "g1t");
        assert_eq!(as_issue["requested_by"]["login"], "syntaqx");
    }

    #[test]
    fn releases_deployments_and_deleted_comments_read_as_githubs() {
        let release = payload::release(
            &repo(),
            &json!({ "id": "rel_1", "tagName": "v1.2.0", "target": "abc", "name": null, "body": "Notes", "draft": false,
                     "prerelease": true, "author": "ana", "createdAt": "2026-10-08T00:00:00Z", "publishedAt": "2026-10-08T00:00:00Z" }),
        );
        assert_eq!(release["tag_name"], "v1.2.0");
        assert_eq!(release["name"], "v1.2.0");
        assert_eq!(release["prerelease"], true);
        assert_eq!(release["author"]["login"], "ana");
        assert_eq!(release["html_url"], "https://g1t.sh/acme/web/releases/tag/v1.2.0");
        let deployment = json!({ "id": "dep_1", "sha": "abc", "ref": "main", "environment": "staging", "creator": "ana",
                                 "production_environment": false, "created_at": "t", "updated_at": "t" });
        let status = payload::deployment_status(&repo(), &json!({ "id": "dst_1", "state": "success", "environment_url": "https://s.example", "log_url": null, "creator": "g1t", "created_at": "t" }), &deployment);
        assert_eq!(status["state"], "success");
        assert_eq!(status["environment"], "staging");
        assert_eq!(status["environment_url"], "https://s.example");
        assert_eq!(payload::deployment(&repo(), &deployment)["payload"], json!({}));
        let gone = payload::deleted_comment(&repo(), 7, &json!({ "id": "cmt_1", "body": "hi", "author": { "id": "usr_1", "username": "bo" }, "createdAt": "t" }), true);
        assert_eq!(gone["user"]["login"], "bo");
        assert_eq!(gone["html_url"], "https://g1t.sh/acme/web/pull/7#cmt_1");
        assert!(is_commit("0123456789abcdef0123456789abcdef01234567"));
        assert!(!is_commit("main"));
    }

    #[test]
    fn a_pull_request_names_its_own_base_labels_and_milestone() {
        let mut pull = made_for(person("usr_1", "syntaqx"));
        let event = payload::pull(&repo(), &pull);
        assert_eq!(event["base"]["ref"], repo().default_branch);
        pull.base = Some("release/1.x".into());
        pull.labels = vec!["bug".into()];
        pull.milestone = Some(g1t_contracts::work::MilestoneRef { number: 2, title: "1.1".into() });
        let event = payload::pull(&repo(), &pull);
        assert_eq!(event["base"]["ref"], "release/1.x");
        assert_eq!(event["labels"], serde_json::json!([{ "name": "bug" }]));
        assert_eq!(event["milestone"]["title"], "1.1");
        let mut labeled = serde_json::json!({ "action": "labeled" });
        payload::changed(&mut labeled, &serde_json::json!({ "label": { "name": "bug", "color": "d73a4a" } }));
        assert_eq!(labeled["label"]["color"], "d73a4a");
    }
}
