//! Workflow run artifacts over REST and MCP, in GitHub's shapes: listing a
//! repository's or a run's, one by id, a link to download it, deleting it,
//! and how long a repository keeps them.
//!
//! The actions service keeps them and decides who may see and change
//! them (`g1t_contracts::actions`); their bytes are in R2, downloaded
//! through the toolkit's blob endpoint (toolkit.rs) with a link signed for
//! a few minutes. `GET …/artifacts/{id}/zip` answers with a redirect to
//! that link, as GitHub's does.

use g1t_contracts::actions::{Artifact, ArtifactArgs, ArtifactBlob, ArtifactList, ArtifactRetention, ArtifactRetentionArgs, ArtifactsArgs, DeleteArtifactArgs};
use g1t_contracts::{FailureCode, Outcome, Viewer};
use serde_json::{Value, json};
use worker::Result;

use crate::operations::{Services, repo_path};

/// One operation on artifacts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArtifactsOp {
    ListArtifacts,
    ListRunArtifacts,
    GetArtifact,
    DownloadArtifact,
    DeleteArtifact,
    GetArtifactRetention,
    SetArtifactRetention,
}

impl ArtifactsOp {
    /// Every one: `Op::ALL` lists each as `Op::Artifacts(…)`, which a test
    /// checks against this.
    #[cfg(test)]
    pub const ALL: [ArtifactsOp; 7] = [
        ArtifactsOp::ListArtifacts,
        ArtifactsOp::ListRunArtifacts,
        ArtifactsOp::GetArtifact,
        ArtifactsOp::DownloadArtifact,
        ArtifactsOp::DeleteArtifact,
        ArtifactsOp::GetArtifactRetention,
        ArtifactsOp::SetArtifactRetention,
    ];

    pub fn name(self) -> &'static str {
        match self {
            ArtifactsOp::ListArtifacts => "list_artifacts",
            ArtifactsOp::ListRunArtifacts => "list_workflow_run_artifacts",
            ArtifactsOp::GetArtifact => "get_artifact",
            ArtifactsOp::DownloadArtifact => "download_artifact",
            ArtifactsOp::DeleteArtifact => "delete_artifact",
            ArtifactsOp::GetArtifactRetention => "get_artifact_retention",
            ArtifactsOp::SetArtifactRetention => "set_artifact_retention",
        }
    }

    /// For the API reference.
    pub fn title(self) -> &'static str {
        match self {
            ArtifactsOp::ListArtifacts => "List a repository's artifacts",
            ArtifactsOp::ListRunArtifacts => "List a workflow run's artifacts",
            ArtifactsOp::GetArtifact => "Get an artifact",
            ArtifactsOp::DownloadArtifact => "Download an artifact",
            ArtifactsOp::DeleteArtifact => "Delete an artifact",
            ArtifactsOp::GetArtifactRetention => "Get artifact retention",
            ArtifactsOp::SetArtifactRetention => "Set artifact retention",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            ArtifactsOp::ListArtifacts => "List a repository's artifacts that have not expired, newest first: each with its id (a number), name, size_in_bytes, digest (sha256:… of its zip), created_at, expires_at, archive_download_url, and workflow_run (its run's id, head_branch and head_sha). Narrow with name; page with page and per_page (30 by default, at most 100). total_count counts every match. Needs the Read role; a public repository's are open to anyone.",
            ArtifactsOp::ListRunArtifacts => "List one workflow run's artifacts that have not expired, oldest first, in the same shape as list_artifacts. Narrow with name. Needs the Read role.",
            ArtifactsOp::GetArtifact => "Get one artifact by its id: its name, size_in_bytes, digest, when it was made and when it expires, and its run. Needs the Read role.",
            ArtifactsOp::DownloadArtifact => "A link to download an artifact as a zip file (an artifact an older runner kept is a .tar.gz), good for 10 minutes and needing no token. Over REST, GET …/zip answers 302 with the link in Location, as GitHub does: `curl -L` follows it. Over MCP the link is returned as url, with expires_at. Needs the Read role.",
            ArtifactsOp::DeleteArtifact => "Delete an artifact before it expires: its bytes go at once and its id stops resolving. Needs the Write role.",
            ArtifactsOp::GetArtifactRetention => "How many days the repository keeps artifacts (days), and the most it may choose (maximum_allowed_days, 90). A workflow's retention-days can ask for fewer days, never more. Needs the Read role.",
            ArtifactsOp::SetArtifactRetention => "Set how many days the repository keeps artifacts by default, and at most: days, from 1 to 90. Artifacts already uploaded keep the expiry they were given. Needs the Maintain role.",
        }
    }

    /// Whether it changes anything.
    pub fn writes(self) -> bool {
        matches!(self, ArtifactsOp::DeleteArtifact | ArtifactsOp::SetArtifactRetention)
    }

    pub fn input(self) -> Value {
        let repo = json!({ "type": "string", "description": "Repository as \"owner/name\", e.g. \"flagon-io/hello\"." });
        let id = json!({ "type": ["integer", "string"], "description": "The artifact's id, a number." });
        let (properties, required): (Value, &[&str]) = match self {
            ArtifactsOp::ListArtifacts => (
                json!({
                    "repo": repo,
                    "name": { "type": "string", "description": "Only artifacts with exactly this name." },
                    "page": { "type": "integer", "description": "The page, from 1." },
                    "per_page": { "type": "integer", "description": "Artifacts a page: 30 unless you say, at most 100." },
                }),
                &["repo"],
            ),
            ArtifactsOp::ListRunArtifacts => (
                json!({
                    "repo": repo,
                    "id": { "type": "string", "description": "The run's id (run_…)." },
                    "name": { "type": "string", "description": "Only the artifact with exactly this name." },
                }),
                &["repo", "id"],
            ),
            ArtifactsOp::GetArtifact | ArtifactsOp::DownloadArtifact | ArtifactsOp::DeleteArtifact => (json!({ "repo": repo, "id": id }), &["repo", "id"]),
            ArtifactsOp::GetArtifactRetention => (json!({ "repo": repo }), &["repo"]),
            ArtifactsOp::SetArtifactRetention => (
                json!({
                    "repo": repo,
                    "days": { "type": "integer", "minimum": 1, "maximum": 90, "description": "Days to keep artifacts, by default and at most." },
                }),
                &["repo", "days"],
            ),
        };
        json!({ "type": "object", "properties": properties, "required": required })
    }
}

/// A number from a path segment or a JSON number.
fn number(input: &Value, key: &str) -> Option<u64> {
    match &input[key] {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

/// An outcome's value made into what is sent; its failure as it is.
fn mapped<T>(outcome: Outcome<T>, f: impl FnOnce(T) -> Value) -> Outcome<Value> {
    match outcome {
        Outcome::Ok(value) => Outcome::Ok(f(value)),
        Outcome::Fail(refused) => Outcome::Fail(refused),
    }
}

fn text(input: &Value, key: &str) -> Option<String> {
    input[key].as_str().map(str::trim).filter(|t| !t.is_empty()).map(str::to_owned)
}

/// An artifact as GitHub's REST API shows one.
pub fn shown(artifact: &Artifact, api: &str, repository: &str) -> Value {
    let url = format!("{api}/repos/{repository}/actions/artifacts/{}", artifact.id);
    json!({
        "id": artifact.id,
        "node_id": format!("artifact_{}", artifact.id),
        "name": artifact.name,
        "size_in_bytes": artifact.size,
        "url": url,
        "archive_download_url": format!("{url}/zip"),
        "expired": artifact.expired,
        "digest": artifact.digest,
        "created_at": artifact.created_at,
        "updated_at": artifact.updated_at,
        "expires_at": artifact.expires_at,
        "workflow_run": {
            "id": artifact.run_id,
            "repository_id": artifact.repo_id,
            "head_repository_id": artifact.repo_id,
            "head_branch": artifact.head_branch,
            "head_sha": artifact.head_sha,
        },
    })
}

/// Where a signed blob token downloads from.
pub fn blob_url(api: &str, blob: &str) -> String {
    format!("{api}/actions/toolkit/blobs/{blob}")
}

fn list(found: ArtifactList, api: &str, repository: &str) -> Value {
    json!({
        "total_count": found.total_count,
        "artifacts": found.artifacts.iter().map(|a| shown(a, api, repository)).collect::<Vec<_>>(),
    })
}

pub async fn run(op: ArtifactsOp, services: &Services, viewer: &Viewer, input: &Value) -> Result<Outcome<Value>> {
    let Some(repo) = repo_path(input) else {
        return Ok(Outcome::fail(FailureCode::Invalid, "Give the repository as \"owner/name\"."));
    };
    let repository = format!("{}/{}", repo.namespace, repo.name);
    let api = services.addresses.api.clone();
    let actions = &services.actions;
    let id = number(input, "id");
    let by_id = || ArtifactArgs { repo: repo.clone(), viewer: viewer.clone(), id, run: None, name: None };
    if matches!(op, ArtifactsOp::GetArtifact | ArtifactsOp::DownloadArtifact | ArtifactsOp::DeleteArtifact) && id.is_none() {
        return Ok(Outcome::fail(FailureCode::Invalid, "Name the artifact by its id, a number."));
    }
    Ok(match op {
        ArtifactsOp::ListArtifacts | ArtifactsOp::ListRunArtifacts => {
            let run = (op == ArtifactsOp::ListRunArtifacts).then(|| text(input, "id")).flatten();
            let args = ArtifactsArgs {
                repo: repo.clone(),
                viewer: viewer.clone(),
                run,
                name: text(input, "name"),
                page: number(input, "page").map(|n| n as u32),
                per_page: number(input, "per_page").map(|n| n as u32),
            };
            let found: Outcome<ArtifactList> = g1t_kit::call(actions, "artifacts", &args).await?;
            mapped(found, |mut found| {
                // A run's are listed in the order they were made.
                if op == ArtifactsOp::ListRunArtifacts {
                    found.artifacts.reverse();
                }
                list(found, &api, &repository)
            })
        }
        ArtifactsOp::GetArtifact => {
            let found: Outcome<Artifact> = g1t_kit::call(actions, "artifact", &by_id()).await?;
            mapped(found, |a| shown(&a, &api, &repository))
        }
        ArtifactsOp::DownloadArtifact => {
            let found: Outcome<ArtifactBlob> = g1t_kit::call(actions, "artifact_download", &by_id()).await?;
            match found {
                Outcome::Ok(found) if found.blob.is_empty() => Outcome::fail(FailureCode::Invalid, "Download links are not set up on this installation."),
                Outcome::Ok(found) => Outcome::Ok(json!({
                    "url": blob_url(&api, &found.blob),
                    "expires_at": g1t_contracts::time::rfc3339(g1t_kit::now_ms() + 10 * 60 * 1000),
                    "artifact": shown(&found.artifact, &api, &repository),
                })),
                Outcome::Fail(refused) => Outcome::Fail(refused),
            }
        }
        ArtifactsOp::DeleteArtifact => {
            let Some(actor) = viewer.clone() else {
                return Ok(Outcome::fail(FailureCode::Unauthenticated, "Deleting an artifact needs a g1t access token."));
            };
            let done: Outcome<Artifact> = g1t_kit::call(actions, "delete_artifact", &DeleteArtifactArgs { actor, repo, id: id.unwrap_or_default() }).await?;
            mapped(done, |a| json!({ "deleted": true, "id": a.id, "name": a.name }))
        }
        ArtifactsOp::GetArtifactRetention | ArtifactsOp::SetArtifactRetention => {
            let days = if op == ArtifactsOp::SetArtifactRetention {
                match number(input, "days") {
                    Some(days) => Some(days.min(u64::from(u32::MAX)) as u32),
                    None => return Ok(Outcome::fail(FailureCode::Invalid, "Give days, from 1 to 90.")),
                }
            } else {
                None
            };
            let found: Outcome<ArtifactRetention> = g1t_kit::call(actions, "artifact_retention", &ArtifactRetentionArgs { repo, viewer: viewer.clone(), days }).await?;
            mapped(found, |r| json!({ "days": r.days, "maximum_allowed_days": r.maximum_allowed_days }))
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn artifact() -> Artifact {
        Artifact {
            id: 42,
            name: "dist".into(),
            size: 1024,
            digest: Some(format!("sha256:{}", "a".repeat(64))),
            format: "zip".into(),
            run_id: "run_1".into(),
            job_id: "job_1".into(),
            repo_id: "repo_1".into(),
            expired: false,
            created_at: "2026-10-08T12:00:00.000Z".into(),
            updated_at: "2026-10-08T12:00:00.000Z".into(),
            expires_at: "2026-10-22T12:00:00.000Z".into(),
            head_branch: Some("main".into()),
            head_sha: Some("abc".into()),
        }
    }

    #[test]
    fn an_artifact_is_shown_as_github_shows_one() {
        let shown = shown(&artifact(), "https://api.g1t.sh", "acme/web");
        assert_eq!(shown["id"], 42);
        assert_eq!(shown["size_in_bytes"], 1024);
        assert_eq!(shown["url"], "https://api.g1t.sh/repos/acme/web/actions/artifacts/42");
        assert_eq!(shown["archive_download_url"], "https://api.g1t.sh/repos/acme/web/actions/artifacts/42/zip");
        assert_eq!(shown["workflow_run"]["head_branch"], "main");
        assert!(g1t_kit::wire::camel_case_keys(&shown).is_empty());
    }

    #[test]
    fn ids_are_read_from_a_path_or_a_number() {
        assert_eq!(number(&json!({ "id": "42" }), "id"), Some(42));
        assert_eq!(number(&json!({ "id": 42 }), "id"), Some(42));
        assert_eq!(number(&json!({ "id": "run_1" }), "id"), None);
    }

    #[test]
    fn each_operation_is_described_with_a_schema() {
        for op in ArtifactsOp::ALL {
            assert!(crate::operations::Op::ALL.contains(&crate::operations::Op::Artifacts(op)), "{}", op.name());
            assert!(!op.title().is_empty() && op.description().len() > 40, "{}", op.name());
            assert!(op.input()["required"].as_array().unwrap().contains(&json!("repo")), "{}", op.name());
            let level = g1t_contracts::scopes::scope_for(op.name()).unwrap().level();
            assert_eq!(op.writes(), level == g1t_contracts::scopes::Level::Write, "{}", op.name());
        }
    }
}
