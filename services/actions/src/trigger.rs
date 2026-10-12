//! What starts a run: an event on the bus, a schedule, or someone running a
//! workflow by hand. Each finds the workflows that want it, at the commit
//! the event is about, and checks their filters.

use g1t_actions::events::{RunInfo, github_events};
use g1t_actions::workflow::{self, Trigger, Workflow};
use g1t_contracts::access::{self, Capability};
use g1t_contracts::actions::{DispatchArgs, RepositoryDispatchArgs, WorkflowRun};
use g1t_contracts::events::{Event, caused_by_job};
use g1t_contracts::identity::{AGENT_ID, AGENT_NAME, UsernamesArgs};
use g1t_contracts::repos::{Commit, CompareArgs, Comparison, FileStatus, LogArgs, PullMergeRef, PullMergeRefArgs, Repo, RepoPath};
use g1t_contracts::work::{IssueDetail, Label, PullDetail, ViewArgs};
use g1t_contracts::{FailureCode, Outcome, User, new_id};
use g1t_contracts::time::rfc3339;
use g1t_kit::now_ms;
use serde_json::{Map, Value, json};
use worker::Result;

use crate::plan::NewRun;
use crate::sync::{Read, WorkflowRow};
use crate::{API, Actions, SITE, check, fail, payload};

/// How many commits a push's log reads: its `commits`, and how far back
/// `before` is looked for to tell a forced push.
const PUSH_LOG: u32 = 20;

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
    /// What the run builds when it is not `sha`: a pull request's test
    /// merge commit (`refs/pull/<n>/merge`), as on GitHub, which becomes
    /// `github.sha` while statuses and checks stay on `sha`, its head.
    merge: Option<String>,
}

impl Subject {
    /// What the event changes, once compared: the paths for `paths`
    /// filters, and a push's commit's `added`, `removed` and `modified`.
    fn changed(&mut self, changes: Vec<(String, FileStatus)>) {
        payload::push_changes(&mut self.payload, &changes);
        self.paths = Some(changes.into_iter().map(|(path, _)| path).collect());
    }
}

/// The address a push's `pusher.email` gives: g1t's for its agent and
/// itself, a person's noreply address (which needs no lookup) for them,
/// and none for anyone else.
fn pusher_email(actor: Option<&str>, username: &str) -> Option<String> {
    match actor? {
        id if id == AGENT_ID || id == g1t_contracts::system::ID => Some(g1t_contracts::system::EMAIL.to_owned()),
        id if id.starts_with("usr_") => Some(g1t_contracts::accounts::noreply_address(id, username)),
        _ => None,
    }
}

/// Whether a deployment's `ref` is a commit's full hash rather than a
/// branch or tag.
fn is_commit(name: &str) -> bool {
    name.len() == 40 && name.chars().all(|c| c.is_ascii_hexdigit())
}

/// What a ref made or deleted is, as `create` and `delete` name it:
/// `branch` or `tag`, and its short name. `None` for any other ref, and
/// for the merge queue's own branches, which come and go with every
/// queued change.
fn branch_or_tag(git_ref: &str) -> Option<(&'static str, &str)> {
    if git_ref.starts_with("refs/heads/g1t-queue/") {
        return None;
    }
    match (git_ref.strip_prefix("refs/heads/"), git_ref.strip_prefix("refs/tags/")) {
        (Some(branch), _) => Some(("branch", branch)),
        (_, Some(tag)) => Some(("tag", tag)),
        _ => None,
    }
}

/// Events GitHub takes no `branches`, `tags` or `paths` filters on.
fn unfiltered(event_name: &str) -> bool {
    matches!(event_name, "create" | "delete")
}

/// What a pull request's run builds, given its test merge commit.
#[derive(Debug, PartialEq, Eq)]
enum PullBuild {
    /// The merge commit, as on GitHub.
    Merge(String),
    /// The head: g1t could not make the merge commit itself, or a
    /// conflicting pull request's event that still runs without one.
    Head,
    /// No run: GitHub starts no `pull_request` workflow while the pull
    /// request has conflicts, since there is no merge commit to build. The
    /// pull request's checks say so (apps/web `pull.tsx`).
    Nothing,
}

fn pull_build(event_name: &str, action: Option<&str>, made: &PullMergeRef) -> PullBuild {
    match made {
        PullMergeRef::Merged { merge, .. } => PullBuild::Merge(merge.clone()),
        PullMergeRef::Conflict { .. } if event_name == "pull_request" && action != Some("closed") => PullBuild::Nothing,
        PullMergeRef::Conflict { .. } | PullMergeRef::Unavailable { .. } => PullBuild::Head,
    }
}

/// Whether an `*.assigned` event added nobody: g1t says so for a change
/// that only took people off.
fn nobody_added(data: &Value) -> bool {
    data["added"].as_array().is_some_and(Vec::is_empty)
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
        Ok(self.pushed_commits(repo, actor, after, before).await?.0)
    }

    /// The commits a push added, oldest first, and whether it was forced:
    /// `before` is not in `after`'s history. Known only when that history
    /// is read whole (it is shorter than the [`PUSH_LOG`] commits read);
    /// a longer one says not forced.
    async fn pushed_commits(&self, repo: &Repo, actor: &User, after: &str, before: Option<&str>) -> Result<(Vec<Commit>, bool)> {
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
                limit: PUSH_LOG,
            },
        )
        .await?;
        let mut commits: Vec<Commit> = log.into_result().unwrap_or_default();
        let whole = commits.len() < PUSH_LOG as usize;
        let mut forced = false;
        if let Some(before) = before.filter(|before| *before != payload::ZERO) {
            match commits.iter().position(|commit| commit.hash == before) {
                Some(at) => commits.truncate(at),
                None => forced = whole && !commits.is_empty(),
            }
        }
        // GitHub lists them oldest first, with the head commit last.
        commits.reverse();
        Ok((commits, forced))
    }

    /// The message of the commit `sha` in `path`, when it can be read.
    async fn head_message(&self, path: &RepoPath, actor: &User, sha: &str) -> Result<Option<String>> {
        Ok(self.commit_at(path, actor, sha).await?.map(|commit| commit.message))
    }

    /// The commit `sha` in `path`, when it can be read.
    async fn commit_at(&self, path: &RepoPath, actor: &User, sha: &str) -> Result<Option<Commit>> {
        let log: Outcome<Vec<Commit>> = g1t_kit::call(
            &self.repos,
            "log",
            &LogArgs { path: path.clone(), viewer: Some(actor.clone()), git_ref: Some(sha.to_owned()), limit: 1 },
        )
        .await?;
        Ok(log.into_result().ok().and_then(|commits| commits.into_iter().next()))
    }

    /// What `head` changes from `base`: each path and how.
    async fn changed_paths(&self, repo: &Repo, actor: &User, base: Option<String>, head: String) -> Result<Vec<(String, FileStatus)>> {
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
        Ok(compared.into_result().map(|c| c.files.into_iter().map(|f| (f.path, f.status)).collect()).unwrap_or_default())
    }

    /// The repository's labels, for their colors, when `payload` has any.
    async fn label_colors(&self, repo: &Repo, ws: &User, payload: &mut Value) -> Result<()> {
        if !payload::has_labels(payload) {
            return Ok(());
        }
        let args = ViewArgs { repo: Self::repo_path(repo), number: 0, viewer: Some(ws.clone()), after_seq: 0 };
        let labels: Outcome<Vec<Label>> = g1t_kit::call(&self.work, "list_labels", &args).await?;
        if let Outcome::Ok(labels) = labels {
            payload::color_labels(payload, &labels);
        }
        Ok(())
    }

    async fn default_head(&self, repo: &Repo) -> Result<Option<String>> {
        self.branch_head(repo, &repo.default_branch).await
    }

    /// The commit `branch` points to now.
    async fn branch_head(&self, repo: &Repo, branch: &str) -> Result<Option<String>> {
        g1t_kit::call(
            &self.repos,
            "head",
            &g1t_contracts::repos::HeadArgs {
                repo_id: repo.id.clone(),
                branch: branch.to_owned(),
            },
        )
        .await
    }

    /// The pull request's test merge commit for `head` (repos
    /// `pull_merge_ref`), made or moved now. A failure to ask is
    /// unavailable, so that its runs still start, on the head.
    async fn test_merge(&self, repo: &Repo, pull: &g1t_contracts::work::Pull, head: &str, base_ref: &str) -> PullMergeRef {
        let asked: Result<PullMergeRef> = g1t_kit::call(
            &self.repos,
            "pull_merge_ref",
            &PullMergeRefArgs {
                repo_id: repo.id.clone(),
                source_id: pull.fork_repo_id.clone().unwrap_or_else(|| repo.id.clone()),
                head: head.to_owned(),
                number: pull.number,
                target_branch: Some(base_ref.to_owned()),
            },
        )
        .await;
        asked.unwrap_or_else(|error| PullMergeRef::Unavailable { reason: error.to_string() })
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
            merge: None,
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
                let (commits, forced) = self.pushed_commits(repo, ws, after, before).await?;
                let title = commits.last().map(|c| c.message.lines().next().unwrap_or_default().to_owned()).unwrap_or_default();
                let email = pusher_email(event.actor.as_deref(), sender);
                let payload = payload::push(repo, git_ref, before, after, &commits, sender, email.as_deref(), forced);
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
                    merge: None,
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
                let Some((ref_type, name)) = branch_or_tag(git_ref) else { return Ok(None) };
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
                    merge: None,
                })
            }
            // A branch or tag was deleted: on the default branch's latest
            // commit, as on GitHub, since what was deleted has no commit to
            // run on now.
            "delete" => {
                let Some(git_ref) = data["ref"].as_str() else { return Ok(None) };
                let Some((ref_type, name)) = branch_or_tag(git_ref) else { return Ok(None) };
                let Some(sha) = self.default_head(repo).await? else { return Ok(None) };
                let payload = json!({
                    "ref": name,
                    "ref_type": ref_type,
                    "pusher_type": "user",
                    "repository": payload::repository(repo),
                    "sender": payload::user(sender),
                });
                Some(on_default(sha, payload, format!("Deleted {ref_type} {name}"), None))
            }
            "pull_request" | "pull_request_target" | "pull_request_review" => {
                let Some(number) = data["number"].as_u64().map(|n| n as u32) else { return Ok(None) };
                // Assignees changed but nobody was added: someone was only
                // taken off, which is not `assigned`.
                if action == Some("assigned") && nobody_added(data) {
                    return Ok(None);
                }
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
                payload::changed(repo, &mut payload, data);
                self.label_colors(repo, ws, &mut payload).await?;
                // `base.sha` is the base branch's tip now, as GitHub gives
                // it, not where the two last agreed.
                if let Some(tip) = self.branch_head(repo, &base_ref).await? {
                    payload["pull_request"]["base"]["sha"] = json!(tip);
                }
                // A merge's commit, once it has landed.
                if pull.status == g1t_contracts::work::PullStatus::Merged
                    && let Some(commit) = data["commit"].as_str()
                {
                    payload["pull_request"]["merge_commit_sha"] = json!(commit);
                }
                if event_name == "pull_request_review" {
                    let review = detail.comments.iter().rev().find(|c| c.verdict.is_some() && !c.advisory);
                    payload["review"] = payload::review(repo, pull, review);
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
                // Otherwise it builds the head merged into the base's tip,
                // as on GitHub: the test merge commit at refs/pull/<n>/merge,
                // in the repository, whose workflows it reads.
                let merge = match landed {
                    Some(_) => None,
                    None => {
                        let made = self.test_merge(repo, pull, &sha, &base_ref).await;
                        match pull_build(event_name, action, &made) {
                            PullBuild::Merge(merge) => Some(merge),
                            PullBuild::Nothing => {
                                worker::console_log!("actions: pull request #{} conflicts with {base_ref}: {made:?}; no pull_request workflows run", pull.number);
                                return Ok(None);
                            }
                            PullBuild::Head => {
                                worker::console_log!("actions: no merge commit for pull request #{}: {made:?}; its head is built", pull.number);
                                None
                            }
                        }
                    }
                };
                if let Some(merge) = &merge {
                    payload["pull_request"]["merge_commit_sha"] = json!(merge);
                }
                let (source, source_ref) = match (&landed, &merge) {
                    (Some(_), _) => (path.clone(), sha.clone()),
                    (None, Some(merge)) => (path.clone(), merge.clone()),
                    (None, None) => (pull.fork.clone().unwrap_or_else(|| path.clone()), sha.clone()),
                };
                Some(Subject {
                    source,
                    source_ref: Some(source_ref),
                    merge,
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
                // The followed run's row, for what the event does not carry.
                let row = match data["runId"].as_str() {
                    Some(id) => self.db.prepare("SELECT * FROM runs WHERE id = ?").bind(&[id.into()])?.first::<crate::plan::RunRow>(None).await?,
                    None => None,
                };
                let head_commit = match data["sha"].as_str() {
                    Some(head) => self.commit_at(&path, ws, head).await?.filter(|commit| commit.hash == head),
                    None => None,
                };
                // Its pull request, for `pull_requests[]`.
                let pull = match data["pull"].as_u64() {
                    Some(number) => match g1t_kit::call::<_, Outcome<PullDetail>>(&self.work, "get_pull", &view(number as u32)).await? {
                        Outcome::Ok(detail) => Some(detail.pull),
                        Outcome::Fail(_) => None,
                    },
                    None => None,
                };
                let base_sha = match &pull {
                    Some(pull) if pull.fork.is_none() => self.branch_head(repo, pull.base_branch(&repo.default_branch)).await?,
                    _ => None,
                };
                let followed = payload::FollowedRun {
                    pull: pull.as_ref(),
                    base_sha: base_sha.as_deref(),
                    data,
                    workflow_id: row.as_ref().map(|r| r.workflow_id.as_str()),
                    attempt: row.as_ref().map(|r| r.attempt),
                    created_at: row.as_ref().map(|r| r.created_at.as_str()),
                    started_at: row.as_ref().and_then(|r| r.started_at.as_deref()),
                    updated_at: row.as_ref().and_then(|r| r.finished_at.as_deref()),
                    actor: row.as_ref().and_then(|r| r.actor.as_deref()),
                    triggering_actor: row.as_ref().and_then(|r| r.triggering_actor.as_deref()),
                    title: row.as_ref().map(|r| r.title.as_str()),
                    head_commit: head_commit.as_ref(),
                };
                let payload = json!({
                    "action": "completed",
                    "workflow_run": payload::workflow_run(repo, &followed),
                    "workflow": {
                        "id": followed.workflow_id,
                        "node_id": followed.workflow_id,
                        "name": name,
                        "path": data["path"],
                        "state": "active",
                        "html_url": format!("{SITE}/{}/{}/actions", repo.namespace, repo.name),
                    },
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
                if action == Some("assigned") && nobody_added(data) {
                    return Ok(None);
                }
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
                payload::changed(repo, &mut payload, data);
                self.label_colors(repo, ws, &mut payload).await?;
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
                    merge: None,
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
                    merge: None,
                })
            }
            _ => None,
        })
    }

    /// A push keeps the repository's schedules going (`run_schedules`).
    /// Written at most once a day, and only on scheduled workflows.
    async fn note_push(&self, repo_id: &str) -> Result<()> {
        let at = now_ms();
        self.db
            .prepare("UPDATE workflows SET pushed_at = ? WHERE repo_id = ? AND crons != '[]' AND (pushed_at IS NULL OR pushed_at < ?)")
            .bind(&[rfc3339(at).into(), repo_id.into(), rfc3339(at.saturating_sub(24 * 60 * 60 * 1000)).into()])?
            .run()
            .await?;
        Ok(())
    }

    pub async fn on_event(&self, event: &Event) -> Result<()> {
        let Some(repo_id) = event.repo_id.as_deref() else { return Ok(()) };
        let mut mapped = github_events(&event.kind);
        // A new branch or tag is also `create`.
        if event.kind == "git.push" && event.data["before"].is_null() {
            mapped.push(("create", None));
        }
        let pushed_default = event.kind == "git.push" && event.data["defaultBranch"].as_bool() == Some(true);
        if event.kind == "git.push" {
            self.note_push(repo_id).await?;
        }
        if mapped.is_empty() && !pushed_default {
            return Ok(());
        }
        let Some((repo, ws)) = self.repo_by_id(repo_id).await? else { return Ok(()) };
        if pushed_default {
            self.sync(&repo, &ws).await?;
        }
        // A mirror runs only what its state says (mirrored.rs).
        let copied_in = event.kind == "git.push" && event.data["mirrored"].as_bool() == Some(true);
        let policy = crate::mirrored::policy(repo.mirror.as_ref(), copied_in);
        if !policy.runs {
            return Ok(());
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
            if matches!(event_name, "issues" | "issue_comment" | "deployment" | "deployment_status" | "delete")
                && self.listens(repo_id, event_name).await? == Some(false)
            {
                continue;
            }
            let Some(mut subject) = self.subject(event, event_name, action, &repo, &ws, &sender).await? else {
                continue;
            };
            // `[skip ci]` in the head commit's message, as on GitHub.
            if matches!(event_name, "push" | "pull_request") {
                let message = match subject.payload["head_commit"]["message"].as_str() {
                    Some(message) => Some(message.to_owned()),
                    None => self.head_message(&subject.source, &ws, &subject.sha).await?,
                };
                if message.as_deref().is_some_and(g1t_actions::events::skips_ci) {
                    worker::console_log!("actions: {} {} at {} asks to skip its runs", event.kind, event.id, subject.sha);
                    continue;
                }
            }
            // A change to workflows made on the remote, by someone g1t
            // knows nothing of, waits before it may use this repository's
            // secrets.
            if copied_in && matches!(event_name, "push" | "create") {
                if subject.paths.is_none() {
                    let (base, head) = subject.compare.clone().unwrap_or((None, subject.sha.clone()));
                    subject.changed(self.changed_paths(&repo, &ws, base, head).await?);
                }
                if crate::mirrored::touches_workflows(subject.paths.as_deref().unwrap_or_default())
                    && let Some(mirror) = &repo.mirror
                {
                    subject.approval = subject.approval.take().or_else(|| Some(crate::mirrored::copied_workflows(&mirror.remote)));
                }
            }
            // A pull request from a fork reads the fork's files.
            let read = if subject.source == Self::repo_path(&repo) {
                self.read_for(&repo, &ws, subject.source_ref.as_deref(), policy.github).await?
            } else {
                // And this repository's managed workflows: they are its own,
                // whatever the fork's files say (managed.rs).
                let mut read = self.read_workflows(&subject.source, &ws, subject.source_ref.as_deref()).await?;
                read.files = self.with_managed(&repo, read.files).await?;
                read
            };
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
        let parsed: Vec<_> = read.files.into_iter().map(|file| (workflow::parse(&file.source), file)).collect();
        // A push some workflow filters by path is compared before any run
        // starts, so every run's payload lists what its commit changed.
        let filters_paths = |(parsed, _): &(std::result::Result<Workflow, _>, _)| {
            parsed.as_ref().ok().and_then(|w: &Workflow| w.trigger(event_name)).is_some_and(|t| t.paths.is_set())
        };
        if event_name == "push" && subject.paths.is_none() && parsed.iter().any(filters_paths) {
            let (base, head) = subject.compare.clone().unwrap_or((None, subject.sha.clone()));
            subject.changed(self.changed_paths(repo, ws, base, head).await?);
        }
        for (parsed, file) in parsed {
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
            // A workspace's required workflow runs whatever its row says.
            if !file.required && self.disabled(&repo.id, &file.path).await? {
                continue;
            }
            // On a mirror the remote may deploy too: a workflow that deploys
            // waits for approval (mirrored.rs).
            let held = crate::mirrored::policy(repo.mirror.as_ref(), false)
                .hold
                .zip(crate::mirrored::deploys_to(&workflow))
                .map(|(remote, environment)| crate::mirrored::held(&remote, &environment));
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
                approval: subject.approval.clone().or(held),
                head_sha: subject.merge.as_ref().map(|_| subject.sha.clone()),
            })
            .await?;
        }
        Ok(())
    }

    /// Whether the branch, tag and path filters let the event through.
    async fn passes(&self, repo: &Repo, ws: &User, trigger: &Trigger, subject: &mut Subject, event_name: &str) -> Result<bool> {
        // GitHub takes no filters on these: a workflow with `branches` on
        // `create` or `delete` still runs for every branch and tag.
        if unfiltered(event_name) {
            return Ok(true);
        }
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
                subject.changed(self.changed_paths(repo, ws, base, head).await?);
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
            sha: subject.merge.clone().unwrap_or_else(|| subject.sha.clone()),
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

    /// Scheduled workflows that run this minute, on the default branch: at
    /// most every five minutes (`cron::Schedule::runs_at`). Not in a
    /// repository with no push for [`crate::SCHEDULE_IDLE_MS`], nor for an
    /// hour after billing refused one of the workflow's scheduled jobs
    /// ([`crate::SCHEDULE_REFUSED_MS`]): no run is made only to be refused.
    pub async fn run_schedules(&self, minute: u64) -> Result<()> {
        let rows = self
            .db
            .prepare(
                "SELECT * FROM workflows WHERE state = 'active' AND crons != '[]' AND error IS NULL
                   AND COALESCE(pushed_at, updated_at) >= ? AND (schedule_refused_until IS NULL OR schedule_refused_until <= ?)",
            )
            .bind(&[rfc3339(minute.saturating_sub(crate::SCHEDULE_IDLE_MS)).into(), rfc3339(minute).into()])?
            .all()
            .await?
            .results::<WorkflowRow>()?;
        for row in rows {
            let crons: Vec<String> = serde_json::from_str(&row.crons).unwrap_or_default();
            let Some(cron) = crons.iter().find(|cron| g1t_actions::cron::Schedule::parse(cron).is_ok_and(|s| s.runs_at(minute))) else {
                continue;
            };
            let Ok(workflow) = workflow::parse(&row.source) else { continue };
            // Schedules wait while a repository is archived, or a mirror runs
            // nothing; a deleted one is not found.
            let Some((repo, _ws)) = self
                .repo_by_id(&row.repo_id)
                .await?
                .filter(|(repo, _)| !repo.archived() && crate::mirrored::policy(repo.mirror.as_ref(), false).runs)
            else {
                continue;
            };
            // A managed workflow's row may be out of date while its
            // repository waits to be synced again (managed.rs).
            if g1t_actions::managed::is_managed(&row.path) && !self.synced(&repo.id).await? {
                continue;
            }
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
                merge: None,
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
                head_sha: None,
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
        let policy = crate::mirrored::policy(repo.mirror.as_ref(), false);
        if let Some(mirror) = repo.mirror.as_ref().filter(|_| !policy.runs) {
            return Ok(fail(FailureCode::Forbidden, crate::mirrored::refused(&repo.namespace, &repo.name, mirror)));
        }
        let read = self.read_for(&repo, &ws, Some(&short), policy.github).await?;
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
        // `type: environment` names one of the repository's environments.
        let environments = if trigger.inputs.values().any(|spec| spec.get("type").and_then(Value::as_str) == Some("environment")) {
            self.environment_list(&repo.id).await?.into_iter().map(|env| env.name).collect()
        } else {
            Vec::new()
        };
        let inputs = check!(dispatch_inputs(trigger, &a.inputs, &environments));
        let payload = json!({
            // As GitHub gives them here: text, `true` and `false` included.
            // The `inputs` context keeps booleans and numbers.
            "inputs": event_inputs(&inputs),
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
            merge: None,
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
                head_sha: None,
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
        let policy = crate::mirrored::policy(repo.mirror.as_ref(), false);
        if let Some(mirror) = repo.mirror.as_ref().filter(|_| !policy.runs) {
            return Ok(fail(FailureCode::Forbidden, crate::mirrored::refused(&repo.namespace, &repo.name, mirror)));
        }
        let read = self.read_for(&repo, &ws, Some(&repo.default_branch), policy.github).await?;
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
                merge: None,
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
                    head_sha: None,
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
        let mut read = self.read_workflows(&Self::repo_path(&repo), &ws, Some(&a.sha)).await?;
        // A required workflow's check holds the queue too (managed.rs).
        read.files = self.with_managed(&repo, read.files).await?;
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
            if !trigger.wants_type(Some("checks_requested")) || (!file.required && self.disabled(&repo.id, &file.path).await?) {
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
                merge: None,
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
                    head_sha: None,
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
/// workflow's declared inputs, with their defaults filled in. An input the
/// workflow does not declare is refused, as GitHub refuses it.
/// `environments` are the repository's, for `type: environment`.
fn dispatch_inputs(trigger: &Trigger, given: &Map<String, Value>, environments: &[String]) -> Outcome<Map<String, Value>> {
    let unexpected: Vec<&String> = given.keys().filter(|name| !trigger.inputs.contains_key(*name)).collect();
    if !unexpected.is_empty() {
        let names = serde_json::to_string(&unexpected).unwrap_or_default();
        let declared = if trigger.inputs.is_empty() {
            "The workflow declares no inputs.".to_owned()
        } else {
            format!("The workflow declares {}.", trigger.inputs.keys().map(|name| format!("`{name}`")).collect::<Vec<_>>().join(", "))
        };
        return fail(FailureCode::Invalid, format!("Unexpected inputs provided: {names}. {declared}"));
    }
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
                    Value::String(text) if text.trim().eq_ignore_ascii_case("true") => true,
                    Value::String(text) if text.trim().eq_ignore_ascii_case("false") || text.trim().is_empty() => false,
                    _ => return fail(FailureCode::Invalid, format!("The input `{name}` is a boolean: true or false.")),
                }),
                "number" => match &value {
                    Value::Number(_) => value,
                    Value::String(text) => match number(text) {
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
                "environment" => {
                    let text = g1t_actions::expr::to_text(&value);
                    let wanted = text.trim().to_ascii_lowercase();
                    if !wanted.is_empty() && !environments.iter().any(|env| env.eq_ignore_ascii_case(&wanted)) {
                        return fail(
                            FailureCode::Invalid,
                            format!("The input `{name}` names an environment, and this repository has none called `{}`.", text.trim()),
                        );
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

/// A number input given as text: a whole number stays one.
fn number(text: &str) -> Option<serde_json::Number> {
    let text = text.trim();
    match text.parse::<i64>() {
        Ok(whole) => Some(whole.into()),
        Err(_) => text.parse::<f64>().ok().filter(|n| n.is_finite()).and_then(serde_json::Number::from_f64),
    }
}

/// A manual run's inputs as `github.event.inputs` gives them: every one as
/// text, as GitHub's `workflow_dispatch` payload has them.
fn event_inputs(inputs: &Map<String, Value>) -> Map<String, Value> {
    inputs.iter().map(|(name, value)| (name.clone(), Value::String(g1t_actions::expr::to_text(value)))).collect()
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

    #[test]
    fn a_pushers_email_is_their_noreply_address() {
        assert_eq!(pusher_email(Some("usr_01j9zq4m8x7k2v5n3b6c1d0efg"), "Ada").as_deref(), Some("6c1d0efg+ada@users.noreply.g1t.sh"));
        assert_eq!(pusher_email(Some(AGENT_ID), AGENT_NAME).as_deref(), Some(g1t_contracts::system::EMAIL));
        assert_eq!(pusher_email(Some("wsp_1"), "acme"), None);
        assert_eq!(pusher_email(None, "acme"), None);
    }

    #[test]
    fn a_pull_request_builds_its_merge_commit_and_nothing_while_it_conflicts() {
        let merged = PullMergeRef::Merged { head: "h".into(), base: "b".into(), merge: "m".into() };
        let conflict = PullMergeRef::Conflict { head: "h".into(), base: "b".into(), paths: vec!["a".into()] };
        let unavailable = PullMergeRef::Unavailable { reason: "too large".into() };
        assert_eq!(pull_build("pull_request", Some("synchronize"), &merged), PullBuild::Merge("m".into()));
        assert_eq!(pull_build("pull_request_review", Some("submitted"), &merged), PullBuild::Merge("m".into()));
        // GitHub runs no pull_request workflow while it conflicts.
        for action in ["opened", "synchronize", "reopened", "edited"] {
            assert_eq!(pull_build("pull_request", Some(action), &conflict), PullBuild::Nothing);
        }
        // Closing it, or reviewing it, still runs, on the head.
        assert_eq!(pull_build("pull_request", Some("closed"), &conflict), PullBuild::Head);
        assert_eq!(pull_build("pull_request_review", Some("submitted"), &conflict), PullBuild::Head);
        // What g1t could not merge itself runs on the head.
        assert_eq!(pull_build("pull_request", Some("opened"), &unavailable), PullBuild::Head);
    }

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
        assert_eq!(event["labels"][0]["name"], "bug");
        assert!(event["labels"][0]["id"].is_u64());
        assert_eq!(event["milestone"]["title"], "1.1");
        let mut labeled = serde_json::json!({ "action": "labeled" });
        payload::changed(&repo(), &mut labeled, &serde_json::json!({ "label": { "name": "bug", "color": "d73a4a" } }));
        assert_eq!(labeled["label"]["color"], "d73a4a");
        let mut assigned = serde_json::json!({ "action": "assigned" });
        payload::changed(&repo(), &mut assigned, &serde_json::json!({ "assignees": ["ana", "bo"], "added": ["bo"] }));
        assert_eq!(assigned["assignee"]["login"], "bo");
        assert!(nobody_added(&serde_json::json!({ "assignees": ["ana"], "added": [] })));
        assert!(!nobody_added(&serde_json::json!({ "assignees": ["ana"], "added": ["ana"] })));
    }

    fn dispatchable(yaml: &str) -> Trigger {
        workflow::parse(yaml).unwrap().trigger("workflow_dispatch").unwrap().clone()
    }

    fn given(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    const DISPATCH: &str = "on:
  workflow_dispatch:
    inputs:
      dry-run: { type: boolean, default: false }
      count: { type: number, default: 2 }
      target: { type: environment }
      level: { type: choice, options: [low, high], default: low }
      note: { required: false }
jobs:
  a:
    runs-on: x
    steps: [{ run: 'true' }]";

    #[test]
    fn an_input_the_workflow_does_not_declare_is_refused() {
        let trigger = dispatchable(DISPATCH);
        let Outcome::Fail(failure) = dispatch_inputs(&trigger, &given(json!({ "dry-run": true, "colour": "red" })), &[]) else {
            panic!("an undeclared input was taken");
        };
        assert_eq!(failure.code, FailureCode::Invalid);
        assert!(failure.message.starts_with(r#"Unexpected inputs provided: ["colour"]."#), "{}", failure.message);
        assert!(failure.message.contains("`dry-run`"));
        let bare = dispatchable("on: workflow_dispatch\njobs:\n  a:\n    runs-on: x\n    steps: [{ run: 'true' }]");
        let Outcome::Fail(failure) = dispatch_inputs(&bare, &given(json!({ "x": "1" })), &[]) else { panic!() };
        assert!(failure.message.contains("declares no inputs"));
        assert!(matches!(dispatch_inputs(&bare, &Map::new(), &[]), Outcome::Ok(inputs) if inputs.is_empty()));
    }

    #[test]
    fn inputs_are_typed_and_the_event_has_them_as_text() {
        let trigger = dispatchable(DISPATCH);
        let environments = vec!["staging".to_owned(), "production".to_owned()];
        let Outcome::Ok(inputs) = dispatch_inputs(&trigger, &given(json!({ "dry-run": "true", "count": "3", "target": "Staging" })), &environments)
        else {
            panic!("refused");
        };
        assert_eq!(inputs["dry-run"], json!(true));
        assert_eq!(inputs["count"], json!(3));
        assert_eq!(inputs["level"], json!("low"));
        assert_eq!(inputs["note"], json!(""));
        let event = event_inputs(&inputs);
        assert_eq!(event["dry-run"], json!("true"));
        assert_eq!(event["count"], json!("3"));
        assert_eq!(event["target"], json!("Staging"));
        let Outcome::Ok(defaults) = dispatch_inputs(&trigger, &Map::new(), &environments) else { panic!() };
        assert_eq!(event_inputs(&defaults)["dry-run"], json!("false"));
        assert_eq!(defaults["count"], json!(2));
        let refused = |value: Value| match dispatch_inputs(&trigger, &given(value), &environments) {
            Outcome::Fail(failure) => failure.message,
            Outcome::Ok(_) => panic!("taken"),
        };
        assert!(refused(json!({ "target": "qa" })).contains("none called `qa`"));
        assert!(refused(json!({ "dry-run": "yes" })).contains("true or false"));
        assert!(refused(json!({ "count": "many" })).contains("is a number"));
        assert!(refused(json!({ "level": "mid" })).contains("low, high"));
    }

    #[test]
    fn create_and_delete_take_no_filters_and_name_their_ref() {
        assert!(unfiltered("create") && unfiltered("delete"));
        assert!(!unfiltered("push") && !unfiltered("pull_request"));
        assert_eq!(branch_or_tag("refs/heads/feature/x"), Some(("branch", "feature/x")));
        assert_eq!(branch_or_tag("refs/tags/v1.0"), Some(("tag", "v1.0")));
        assert_eq!(branch_or_tag("refs/heads/g1t-queue/main/3"), None);
        assert_eq!(branch_or_tag("refs/notes/commits"), None);
        // A workflow can name `delete`. It takes no filters, as GitHub's
        // schema says, so writing one is refused when the workflow is read.
        assert!(workflow::parse("on:\n  delete:\n    branches: [release/*]\njobs:\n  a:\n    runs-on: x\n    steps: [{ run: 'true' }]").is_err());
        let workflow = workflow::parse("on:\n  delete:\njobs:\n  a:\n    runs-on: x\n    steps: [{ run: 'true' }]").unwrap();
        let trigger = workflow.trigger("delete").unwrap();
        assert!(trigger.wants_type(None));
        assert!(!workflow.notes.iter().any(|note| note.severity == workflow::Severity::Unsupported));
    }
}
