//! `github.event`: the webhook-shaped payload GitHub gives a workflow,
//! built from g1t's own records so `github.event.pull_request.number`,
//! `github.event.issue.labels.*.name` and the like read as they do there.

use g1t_contracts::User;
use g1t_contracts::repos::{Commit, Repo};
use g1t_contracts::work::{Comment, Issue, Pull, PullStatus, State};
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

fn person(user: &User) -> Value {
    self::user(&user.username)
}

fn labels(names: &[String]) -> Value {
    Value::Array(names.iter().map(|name| json!({ "name": name })).collect())
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
        "user": person(&issue.author),
        "assignees": issue.assignees.iter().map(|a| user(a)).collect::<Vec<_>>(),
        "comments": issue.comment_count,
        "created_at": issue.created_at,
        "updated_at": issue.updated_at,
        "closed_at": issue.closed_at,
        "html_url": format!("{SITE}/{full_name}/issues/{}", issue.number),
        "url": format!("{API}/repos/{full_name}/issues/{}", issue.number),
    })
}

/// A pull request. `labels` are its issue's, since g1t labels issues.
pub fn pull(repo: &Repo, pull: &Pull, labels_of: &[String]) -> Value {
    let full_name = format!("{}/{}", repo.namespace, repo.name);
    let head_ref = head_ref(pull);
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
        "labels": labels(labels_of),
        "user": person(&pull.author),
        "assignees": pull.assignees.iter().map(|a| user(a)).collect::<Vec<_>>(),
        "requested_reviewers": pull.reviewers.iter().map(|r| user(r)).collect::<Vec<_>>(),
        "head": {
            "ref": head_ref,
            "sha": pull.head_commit,
            "label": format!("{}:{head_ref}", repo.namespace),
            "repo": head_repo,
        },
        "base": {
            "ref": repo.default_branch,
            "sha": pull.merge_base,
            "label": format!("{}:{}", repo.namespace, repo.default_branch),
            "repo": repository(repo),
        },
        "html_url": format!("{SITE}/{full_name}/pull/{}", pull.number),
        "url": format!("{API}/repos/{full_name}/pulls/{}", pull.number),
        "issue_url": pull.issue.map(|n| format!("{API}/repos/{full_name}/issues/{n}")),
    })
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
pub fn pull_as_issue(repo: &Repo, pull: &Pull, labels_of: &[String]) -> Value {
    let full_name = format!("{}/{}", repo.namespace, repo.name);
    json!({
        "id": pull.id,
        "number": pull.number,
        "title": pull.title,
        "body": pull.body,
        "state": if pull.status.is_active() { "open" } else { "closed" },
        "labels": labels(labels_of),
        "user": person(&pull.author),
        "html_url": format!("{SITE}/{full_name}/pull/{}", pull.number),
        "pull_request": {
            "url": format!("{API}/repos/{full_name}/pulls/{}", pull.number),
            "html_url": format!("{SITE}/{full_name}/pull/{}", pull.number),
            "merged_at": pull.merged_at,
        },
    })
}

