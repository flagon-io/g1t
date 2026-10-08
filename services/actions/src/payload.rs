//! `github.event`: the webhook-shaped payload GitHub gives a workflow,
//! built from g1t's own records so `github.event.pull_request.number`,
//! `github.event.issue.labels.*.name` and the like read as they do there.

use g1t_contracts::{PrincipalKind, User};
use g1t_contracts::repos::{Commit, Repo};
use g1t_contracts::work::{Comment, Issue, MilestoneRef, Pull, PullStatus, State};
use serde_json::{Value, json};

use crate::{API, SITE};

pub fn repository(repo: &Repo) -> Value {
    let full_name = format!("{}/{}", repo.namespace, repo.name);
    json!({
        "id": repo.id,
        "node_id": repo.id,
        "name": repo.name,
        "full_name": full_name,
        "private": repo.is_private,
        "owner": { "login": repo.namespace, "type": "Organization" },
        "html_url": format!("{SITE}/{full_name}"),
        "url": format!("{API}/repos/{full_name}"),
        "clone_url": format!("{SITE}/{full_name}.git"),
        "description": repo.description,
        "default_branch": repo.default_branch,
        "fork": false,
        "visibility": if repo.is_private { "private" } else { "public" },
    })
}

pub fn user(login: &str) -> Value {
    json!({ "login": login, "type": "User", "html_url": format!("{SITE}/{login}") })
}

/// Someone as GitHub names them. g1t, the author of what it makes and
/// files, is a `Bot`, as an app is there.
fn person(user: &User) -> Value {
    let mut named = self::user(&user.username);
    if matches!(user.kind, PrincipalKind::Agent | PrincipalKind::System) {
        named["type"] = json!("Bot");
    }
    named
}

fn labels(names: &[String]) -> Value {
    Value::Array(names.iter().map(|name| json!({ "name": name })).collect())
}

/// A milestone as an issue or a pull request names it.
fn milestone(milestone: Option<&MilestoneRef>) -> Value {
    milestone.map_or(Value::Null, |milestone| json!({ "number": milestone.number, "title": milestone.title }))
}

pub fn commit(repo: &Repo, commit: &Commit) -> Value {
    json!({
        "id": commit.hash,
        "tree_id": commit.tree_hash,
        "message": commit.message,
        "timestamp": commit.authored_at,
        "url": format!("{SITE}/{}/{}/commit/{}", repo.namespace, repo.name, commit.hash),
        "author": { "name": commit.author.name, "email": commit.author.email },
        "committer": { "name": commit.author.name, "email": commit.author.email },
        "distinct": true,
    })
}

pub fn push(repo: &Repo, git_ref: &str, before: Option<&str>, after: &str, commits: &[Commit], pusher: &str) -> Value {
    let zero = "0000000000000000000000000000000000000000";
    let commits: Vec<Value> = commits.iter().map(|c| commit(repo, c)).collect();
    json!({
        "ref": git_ref,
        "before": before.unwrap_or(zero),
        "after": after,
        "created": before.is_none(),
        "deleted": false,
        "forced": false,
        "base_ref": null,
        "compare": format!("{SITE}/{}/{}/commit/{after}", repo.namespace, repo.name),
        "head_commit": commits.first().cloned().unwrap_or(Value::Null),
        "commits": commits,
        "pusher": { "name": pusher, "email": null },
        "repository": repository(repo),
        "sender": user(pusher),
    })
}

pub fn issue(repo: &Repo, issue: &Issue) -> Value {
    let full_name = format!("{}/{}", repo.namespace, repo.name);
    json!({
        "id": issue.id,
        "number": issue.number,
        "title": issue.title,
        "body": issue.body,
        "state": if issue.state == State::Open { "open" } else { "closed" },
        "state_reason": issue.reason,
        "labels": labels(&issue.labels),
        "milestone": milestone(issue.milestone.as_ref()),
        "user": person(&issue.author),
        // g1t's own field: for an issue its agent filed, who it worked for.
        "requested_by": issue.requested_by.as_ref().map(person),
        "assignees": issue.assignees.iter().map(|a| user(a)).collect::<Vec<_>>(),
        "comments": issue.comment_count,
        "created_at": issue.created_at,
        "updated_at": issue.updated_at,
        "closed_at": issue.closed_at,
        "html_url": format!("{SITE}/{full_name}/issues/{}", issue.number),
        "url": format!("{API}/repos/{full_name}/issues/{}", issue.number),
    })
}

/// A pull request, with its own labels.
pub fn pull(repo: &Repo, pull: &Pull) -> Value {
    let full_name = format!("{}/{}", repo.namespace, repo.name);
    let head_ref = head_ref(pull);
    let base_ref = pull.base_branch(&repo.default_branch);
    let head_repo = match &pull.fork {
        Some(fork) => json!({ "full_name": format!("{}/{}", fork.namespace, fork.name), "fork": true }),
        None => json!({ "full_name": full_name, "fork": false }),
    };
    json!({
        "id": pull.id,
        "number": pull.number,
        "title": pull.title,
        "body": pull.body,
        "state": if pull.status.is_active() { "open" } else { "closed" },
        "draft": pull.status == PullStatus::Draft,
        "merged": pull.status == PullStatus::Merged,
        "merged_at": pull.merged_at,
        "merged_by": pull.merged_by.as_deref().map(user),
        "merge_commit_sha": if pull.status == PullStatus::Merged { pull.head_commit.clone() } else { None },
        "labels": labels(&pull.labels),
        "milestone": milestone(pull.milestone.as_ref()),
        "user": person(&pull.author),
        // g1t's own field: for a change g1t made, who asked for it.
        "requested_by": pull.requested_by.as_ref().map(person),
        "assignees": pull.assignees.iter().map(|a| user(a)).collect::<Vec<_>>(),
        "requested_reviewers": pull.reviewers.iter().map(|r| user(r)).collect::<Vec<_>>(),
        "head": {
            "ref": head_ref,
            "sha": pull.head_commit,
            "label": format!("{}:{head_ref}", repo.namespace),
            "repo": head_repo,
        },
        "base": {
            "ref": base_ref,
            "sha": pull.merge_base,
            "label": format!("{}:{base_ref}", repo.namespace),
            "repo": repository(repo),
        },
        "html_url": format!("{SITE}/{full_name}/pull/{}", pull.number),
        "url": format!("{API}/repos/{full_name}/pulls/{}", pull.number),
        "issue_url": pull.issue.map(|n| format!("{API}/repos/{full_name}/issues/{n}")),
    })
}

/// What a `labeled`, `unlabeled`, `milestoned`, `demilestoned` or base
/// change was about, from the g1t event: `label`, `milestone`, and for a
/// new base, `changes.base.ref.from` is not known, so only the new base is
/// in `pull_request.base`.
pub fn changed(payload: &mut Value, data: &Value) {
    if let Some(label) = data.get("label").filter(|label| label.is_object()) {
        payload["label"] = json!({ "name": label["name"], "color": label["color"] });
    }
    if let Some(milestone) = data.get("milestone").filter(|milestone| milestone.is_object()) {
        payload["milestone"] = json!({ "number": milestone["number"], "title": milestone["title"] });
    }
}

/// The branch a pull request comes from, or a name for its fork.
pub fn head_ref(pull: &Pull) -> String {
    pull.branch.clone().unwrap_or_else(|| format!("pull/{}", pull.number))
}

pub fn comment(repo: &Repo, number: u32, comment: &Comment, on_pull: bool) -> Value {
    let full_name = format!("{}/{}", repo.namespace, repo.name);
    let page = if on_pull { "pull" } else { "issues" };
    json!({
        "id": comment.id,
        "body": comment.body,
        "user": person(&comment.author),
        "created_at": comment.created_at,
        "updated_at": comment.created_at,
        "path": comment.path,
        "line": comment.line,
        "html_url": format!("{SITE}/{full_name}/{page}/{number}#{}", comment.id),
    })
}

/// An issue as `issue_comment` gives it for a pull request: the pull
/// request's number and title, with `pull_request` set.
pub fn pull_as_issue(repo: &Repo, pull: &Pull) -> Value {
    let full_name = format!("{}/{}", repo.namespace, repo.name);
    json!({
        "id": pull.id,
        "number": pull.number,
        "title": pull.title,
        "body": pull.body,
        "state": if pull.status.is_active() { "open" } else { "closed" },
        "labels": labels(&pull.labels),
        "milestone": milestone(pull.milestone.as_ref()),
        "user": person(&pull.author),
        "requested_by": pull.requested_by.as_ref().map(person),
        "html_url": format!("{SITE}/{full_name}/pull/{}", pull.number),
        "pull_request": {
            "url": format!("{API}/repos/{full_name}/pulls/{}", pull.number),
            "html_url": format!("{SITE}/{full_name}/pull/{}", pull.number),
            "merged_at": pull.merged_at,
        },
    })
}

/// A comment as the event that deleted it kept it (`comment.deleted`'s
/// `comment`), since it can no longer be read.
pub fn deleted_comment(repo: &Repo, number: u32, kept: &Value, on_pull: bool) -> Value {
    let full_name = format!("{}/{}", repo.namespace, repo.name);
    let page = if on_pull { "pull" } else { "issues" };
    let id = kept["id"].as_str().unwrap_or_default();
    let login = kept["author"]["username"].as_str().unwrap_or_default();
    json!({
        "id": id,
        "body": kept["body"],
        "user": user(login),
        "created_at": kept["createdAt"],
        "updated_at": kept["createdAt"],
        "path": kept["path"],
        "line": kept["line"],
        "html_url": format!("{SITE}/{full_name}/{page}/{number}#{id}"),
    })
}

/// A release, from what a `release.*` event carries
/// (`g1t_contracts::about::Release`).
pub fn release(repo: &Repo, release: &Value) -> Value {
    let full_name = format!("{}/{}", repo.namespace, repo.name);
    let tag = release["tagName"].as_str().unwrap_or_default();
    let id = release["id"].as_str().unwrap_or_default();
    json!({
        "id": id,
        "node_id": id,
        "tag_name": tag,
        "target_commitish": release["target"],
        "name": release["name"].as_str().unwrap_or(tag),
        "body": release["body"],
        "draft": release["draft"].as_bool().unwrap_or(false),
        "prerelease": release["prerelease"].as_bool().unwrap_or(false),
        "created_at": release["createdAt"],
        "published_at": release["publishedAt"],
        "author": user(release["author"].as_str().unwrap_or(&repo.namespace)),
        "assets": [],
        "html_url": format!("{SITE}/{full_name}/releases/tag/{tag}"),
        "url": format!("{API}/repos/{full_name}/releases/{id}"),
    })
}

/// A deployment, from what `deployment.created` and
/// `deployment_status.created` carry (`RepoDeployment`, already in GitHub's
/// spelling).
pub fn deployment(repo: &Repo, deployment: &Value) -> Value {
    let full_name = format!("{}/{}", repo.namespace, repo.name);
    let id = deployment["id"].as_str().unwrap_or_default();
    json!({
        "id": id,
        "node_id": id,
        "sha": deployment["sha"],
        "ref": deployment["ref"],
        "task": deployment["task"].as_str().unwrap_or("deploy"),
        "payload": deployment.get("payload").filter(|p| p.is_object()).cloned().unwrap_or_else(|| json!({})),
        "environment": deployment["environment"],
        "original_environment": deployment["environment"],
        "description": deployment["description"],
        "creator": user(deployment["creator"].as_str().unwrap_or("g1t")),
        "transient_environment": deployment["transient_environment"].as_bool().unwrap_or(false),
        "production_environment": deployment["production_environment"].as_bool().unwrap_or(false),
        "created_at": deployment["created_at"],
        "updated_at": deployment["updated_at"],
        "url": format!("{API}/repos/{full_name}/deployments/{id}"),
        "statuses_url": format!("{API}/repos/{full_name}/deployments/{id}/statuses"),
    })
}

/// A deployment's status (`DeploymentStatus`), for `deployment_status`.
pub fn deployment_status(repo: &Repo, status: &Value, deployment: &Value) -> Value {
    let full_name = format!("{}/{}", repo.namespace, repo.name);
    let deployment_id = deployment["id"].as_str().unwrap_or_default();
    let id = status["id"].as_str().unwrap_or_default();
    json!({
        "id": id,
        "node_id": id,
        "state": status["state"],
        "description": status["description"].as_str().unwrap_or_default(),
        "environment": deployment["environment"],
        "environment_url": status["environment_url"].as_str().unwrap_or_default(),
        "log_url": status["log_url"].as_str().unwrap_or_default(),
        "target_url": status["log_url"].as_str().unwrap_or_default(),
        "creator": user(status["creator"].as_str().unwrap_or("g1t")),
        "created_at": status["created_at"],
        "updated_at": status["created_at"],
        "deployment_url": format!("{API}/repos/{full_name}/deployments/{deployment_id}"),
        "url": format!("{API}/repos/{full_name}/deployments/{deployment_id}/statuses/{id}"),
    })
}

