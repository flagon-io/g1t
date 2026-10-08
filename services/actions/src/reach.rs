//! Using another repository's actions and reusable workflows:
//! `uses: owner/repo@ref`, `owner/repo/path@ref` and
//! `jobs.<id>.uses: owner/repo/.g1t/workflows/build.yml@ref`.
//!
//! The repository is looked for on g1t first, as the calling repository's
//! workspace sees it. When g1t has it, the calling repository may use it if
//! it is the same repository, if it is public, or if it is private, in the
//! same workspace, allows it (Settings, Actions, Access: `organization`)
//! and the caller is private too (a public repository's logs would show a
//! private one's code). When g1t does not have it (or the workspace cannot
//! see it), the action comes from GitHub, as before, and the reusable
//! workflow from a public repository there.

use g1t_contracts::repos::{Repo, RepoPath};
use g1t_contracts::{FailureCode, Outcome, User};
use serde_json::{Value, json};
use worker::Result;

use crate::{Actions, SITE, fail};

/// What `uses:` names in another repository.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct UsesRef {
    pub(crate) owner: String,
    pub(crate) repo: String,
    /// Inside the repository: an action's folder, or a workflow's file.
    /// Empty for an action at its root.
    pub(crate) path: String,
    pub(crate) git_ref: String,
}

impl UsesRef {
    pub(crate) fn full_name(&self) -> String {
        format!("{}/{}", self.owner, self.repo)
    }
}

/// `owner/repo[/path]@ref`, if `uses` is that. Local (`./…`) and
/// `docker://` ones are not.
pub(crate) fn parse_uses(uses: &str) -> Option<UsesRef> {
    let uses = uses.trim();
    if uses.starts_with("./") || uses.starts_with("docker://") {
        return None;
    }
    let (name, git_ref) = uses.split_once('@')?;
    let mut parts = name.splitn(3, '/');
    let (owner, repo) = (parts.next()?, parts.next()?);
    let path = parts.next().unwrap_or_default().trim_matches('/');
    let fine = |part: &str| !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) && part != "..";
    if !fine(owner) || !fine(repo) || git_ref.trim().is_empty() || path.split('/').any(|part| part == "..") {
        return None;
    }
    Some(UsesRef { owner: owner.to_owned(), repo: repo.to_owned(), path: path.to_owned(), git_ref: git_ref.trim().to_owned() })
}

/// Whether `caller`'s workflows may use `target`'s actions and reusable
/// workflows, given `target`'s access level (`none` or `organization`).
/// Err says why not.
pub(crate) fn may_use(caller: &Repo, target: &Repo, access_level: &str) -> std::result::Result<(), String> {
    if caller.id == target.id || !target.is_private {
        return Ok(());
    }
    let name = format!("{}/{}", target.namespace, target.name);
    if !caller.namespace.eq_ignore_ascii_case(&target.namespace) {
        return Err(format!("{name} is private, and only repositories in {} may use its actions and workflows.", target.namespace));
    }
    if access_level != "organization" {
        return Err(format!(
            "{name} is private and does not let other repositories use its actions and workflows. An admin of {name} can allow it under Settings, Actions, Access."
        ));
    }
    if !caller.is_private {
        return Err(format!("{name} is private, and a public repository's workflows cannot use a private repository's actions or workflows."));
    }
    Ok(())
}

/// Where another repository's action or workflow comes from.
pub(crate) enum Found {
    /// g1t has it, and the caller may use it.
    G1t(Repo),
    /// g1t does not have it (that the caller's workspace can see): GitHub.
    GitHub,
}

impl Actions {
    /// Looks for `owner/repo` on g1t, as `caller`'s workspace (`ws`) sees
    /// it, and checks the caller may use it.
    pub(crate) async fn find_used(&self, caller: &Repo, ws: &User, used: &UsesRef) -> Result<Outcome<Found>> {
        let path = RepoPath { namespace: used.owner.clone(), name: used.repo.clone() };
        let Some(target) = self.visible_repo(&path, &Some(ws.clone())).await? else {
            return Ok(Outcome::Ok(Found::GitHub));
        };
        let level = if target.is_private && target.id != caller.id { self.access_level_of(&target.id).await? } else { "none" };
        Ok(match may_use(caller, &target, level) {
            Ok(()) => Outcome::Ok(Found::G1t(target)),
            Err(why) => fail(FailureCode::Forbidden, why),
        })
    }

    /// `job_action`: a running job asks where to fetch an action from, by
    /// `report.repository` (`owner/repo`) and `report.ref`. Answers
    /// `{"source": "g1t", "url", "ref", "token"}` (a read-only token for
    /// that repository, ending with the job, when it is private),
    /// `{"source": "github"}`, or a refusal saying why it may not be used.
    pub async fn job_action(&self, a: g1t_contracts::actions::JobCallArgs) -> Result<Outcome<Value>> {
        let job = crate::check!(self.job_for_token(&a).await?);
        let Some(run) = self.run_row(&job.run_id).await? else {
            return Ok(fail(FailureCode::NotFound, "No such run."));
        };
        let repository = a.report["repository"].as_str().unwrap_or_default();
        let git_ref = a.report["ref"].as_str().unwrap_or_default();
        let Some(used) = parse_uses(&format!("{repository}@{git_ref}")) else {
            return Ok(fail(FailureCode::Invalid, "Name the action's repository as owner/repo, and its ref."));
        };
        let Some((caller, ws)) = self.repo_by_id(&run.repo_id).await? else {
            return Ok(fail(FailureCode::NotFound, "The repository is gone."));
        };
        let target = match crate::check!(self.find_used(&caller, &ws, &used).await?) {
            Found::GitHub => return Ok(Outcome::Ok(json!({ "source": "github" }))),
            Found::G1t(target) => target,
        };
        let full_name = format!("{}/{}", target.namespace, target.name);
        // A private repository is read with a token of its own: read-only,
        // for that repository alone, ending with the job.
        let token = if target.is_private {
            let created: g1t_contracts::identity::CreatedAccessToken = g1t_kit::call(
                &self.identity,
                "create_job_token",
                &g1t_contracts::identity::CreateJobTokenArgs {
                    workspace: ws.clone(),
                    repo: RepoPath { namespace: target.namespace.clone(), name: target.name.clone() },
                    run_id: run.id.clone(),
                    job_id: job.id.clone(),
                    name: format!("Action {full_name} for {} run {}", run.repo, run.number),
                    ttl_seconds: u64::from(job.timeout_minutes) * 60 + 600,
                    scopes: vec!["repo:read".to_owned(), "code:read".to_owned()],
                    pull_requests: false,
                },
            )
            .await?;
            Value::String(created.token)
        } else {
            Value::Null
        };
        Ok(Outcome::Ok(json!({
            "source": "g1t",
            "repository": full_name,
            "url": format!("{SITE}/{full_name}.git"),
            "ref": used.git_ref,
            "token": token,
        })))
    }
}

/// Whether `path` is a workflow file: `.g1t/workflows/…` or
/// `.github/workflows/…`, ending `.yml` or `.yaml`.
pub(crate) fn is_workflow_path(path: &str) -> bool {
    (path.starts_with(".g1t/workflows/") || path.starts_with(".github/workflows/")) && (path.ends_with(".yml") || path.ends_with(".yaml"))
}

/// The paths to try for a workflow file: as written, and for `.github/…`
/// also `.g1t/…`, where a repository moved to g1t keeps it.
fn candidates(path: &str) -> Vec<String> {
    let mut paths = vec![path.to_owned()];
    if let Some(rest) = path.strip_prefix(".github/") {
        paths.push(format!(".g1t/{rest}"));
    }
    paths
}

/// What a job's `secrets:` passes to the workflow it calls, kept with the
/// called jobs until they start, when it is read with the secrets
/// themselves (`resolve_secrets`); no secret is stored. `inherit` passes
/// all of the caller's; a mapping passes each name's expression, read with
/// the caller's `secrets` and the contexts it had (`needs`, `inputs`,
/// `matrix`); nothing passes none. `outer` is the caller's own, when the
/// caller is itself a called workflow's job.
pub(crate) fn secrets_plan(job_raw: &Value, contexts: &serde_json::Map<String, Value>, outer: Option<Value>) -> Value {
    let mut plan = match job_raw.get("secrets") {
        Some(Value::String(text)) if text.trim() == "inherit" => json!({ "inherit": true }),
        Some(Value::Object(map)) => json!({
            "map": map,
            "scope": {
                "needs": contexts.get("needs").cloned().unwrap_or_else(|| json!({})),
                "inputs": contexts.get("inputs").cloned().unwrap_or_else(|| json!({})),
                "matrix": contexts.get("matrix").cloned().unwrap_or_else(|| json!({})),
            },
        }),
        _ => json!({ "map": {} }),
    };
    if let Some(outer) = outer.filter(Value::is_object) {
        plan["outer"] = outer;
    }
    plan
}

/// The secrets a called workflow says are required
/// (`on.workflow_call.secrets.<name>.required`) that `plan` does not pass.
/// `inherit` passes whatever the caller has, so it is not checked here.
pub(crate) fn missing_secrets(called_raw: &Value, plan: &Value) -> Vec<String> {
    if plan["inherit"] == json!(true) {
        return Vec::new();
    }
    let on = called_raw.get("on").or_else(|| called_raw.get("true")).cloned().unwrap_or(Value::Null);
    let Some(Value::Object(declared)) = on.get("workflow_call").and_then(|call| call.get("secrets")).cloned() else {
        return Vec::new();
    };
    let passed = plan["map"].as_object().cloned().unwrap_or_default();
    declared
        .iter()
        .filter(|(_, spec)| spec.get("required").and_then(Value::as_bool) == Some(true))
        .filter(|(name, _)| !passed.keys().any(|key| key.eq_ignore_ascii_case(name)))
        .map(|(name, _)| name.clone())
        .collect()
}

/// The `secrets` a called workflow's job gets, by `plan` (`secrets_plan`),
/// from `base` (the repository's secrets, as the top caller has them),
/// with `github` and `vars` for the expressions. The job's token is added
/// by the caller of this, as every job's is.
pub(crate) fn resolve_secrets(
    plan: &Value,
    base: &serde_json::Map<String, Value>,
    github: &Value,
    vars: &serde_json::Map<String, Value>,
) -> serde_json::Map<String, Value> {
    let outer = match plan.get("outer").filter(|outer| outer.is_object()) {
        Some(outer) => resolve_secrets(outer, base, github, vars),
        None => base.clone(),
    };
    if plan["inherit"] == json!(true) {
        return outer;
    }
    let mut contexts = serde_json::Map::new();
    if let Some(Value::Object(scope)) = plan.get("scope") {
        contexts.extend(scope.clone());
    }
    contexts.insert("secrets".into(), Value::Object(outer));
    contexts.insert("github".into(), github.clone());
    contexts.insert("vars".into(), Value::Object(vars.clone()));
    let scope = g1t_actions::expr::Scope { contexts: &contexts, status: g1t_actions::expr::Status::Success, hash_files: None };
    let mut passed = serde_json::Map::new();
    for (name, expression) in plan["map"].as_object().into_iter().flatten() {
        let value = g1t_actions::expr::interpolate_value(expression, &scope).unwrap_or(Value::Null);
        let text = g1t_actions::expr::to_text(&value);
        if !text.is_empty() {
            passed.insert(name.clone(), Value::String(text));
        }
    }
    passed
}

/// A public repository's file on GitHub, if it is there.
async fn github_file(repository: &str, git_ref: &str, path: &str) -> Option<String> {
    let url = format!("https://raw.githubusercontent.com/{repository}/{git_ref}/{path}");
    let headers = worker::Headers::new();
    headers.set("user-agent", "g1t-actions").ok()?;
    let mut init = worker::RequestInit::new();
    init.with_method(worker::Method::Get).with_headers(headers);
    let request = worker::Request::new_with_init(&url, &init).ok()?;
    let mut response = worker::Fetch::Request(request).send().await.ok()?;
    if response.status_code() != 200 {
        return None;
    }
    response.text().await.ok()
}

impl Actions {
    /// The workflow file a job's `uses:` calls, its text, and where it
    /// came from (`origin`, kept with its jobs so a `./` call inside it
    /// reads from the same place): `{"source": "g1t" | "github", "repo",
    /// "ref"}`. Err says why it cannot be called.
    pub(crate) async fn called_workflow(
        &self,
        run: &crate::plan::RunRow,
        row: &crate::plan::JobRow,
        uses: &str,
    ) -> Result<std::result::Result<(String, String, Value), String>> {
        let Some(ws) = self.workspace_actor(&crate::repo_path(&run.repo).namespace).await? else {
            return Ok(Err("The workspace is gone.".to_owned()));
        };
        let (origin, file) = match parse_uses(uses) {
            None => {
                let Some(local) = uses.trim().strip_prefix("./") else {
                    return Ok(Err(format!("`{uses}` is not a workflow: name one as ./.g1t/workflows/build.yml or owner/repo/.g1t/workflows/build.yml@ref.")));
                };
                // In the same repository and commit as the workflow the
                // calling job is in: the run's, or the called workflow's.
                let origin = row
                    .call()
                    .filter(|call| call["role"] == "callee")
                    .and_then(|call| call.get("origin").cloned())
                    .filter(Value::is_object)
                    .unwrap_or_else(|| json!({ "source": "g1t", "repo": run.repo, "ref": run.sha }));
                (origin, local.split('@').next().unwrap_or(local).to_owned())
            }
            Some(used) => {
                if !is_workflow_path(&used.path) {
                    return Ok(Err(format!("`{uses}` is not a workflow file: it is under .g1t/workflows/ or .github/workflows/ and ends .yml or .yaml.")));
                }
                let Some((caller, _)) = self.repo_by_id(&run.repo_id).await? else {
                    return Ok(Err("The repository is gone.".to_owned()));
                };
                let origin = match self.find_used(&caller, &ws, &used).await? {
                    Outcome::Fail(refused) => return Ok(Err(refused.message)),
                    Outcome::Ok(Found::G1t(target)) => {
                        json!({ "source": "g1t", "repo": format!("{}/{}", target.namespace, target.name), "ref": used.git_ref })
                    }
                    Outcome::Ok(Found::GitHub) => json!({ "source": "github", "repo": used.full_name(), "ref": used.git_ref }),
                };
                (origin, used.path)
            }
        };
        let repository = origin["repo"].as_str().unwrap_or_default().to_owned();
        let git_ref = origin["ref"].as_str().unwrap_or_default().to_owned();
        let on_github = origin["source"] == "github";
        for path in candidates(&file) {
            let text = if on_github {
                github_file(&repository, &git_ref, &path).await
            } else {
                self.read_file(&crate::repo_path(&repository), &ws, &git_ref, &path).await?
            };
            if let Some(text) = text {
                // Shown as the repository names it, when it is another's.
                let shown = if repository.eq_ignore_ascii_case(&run.repo) { path } else { format!("{repository}/{path}@{git_ref}") };
                return Ok(Ok((shown, text, origin)));
            }
        }
        Ok(Err(if repository.eq_ignore_ascii_case(&run.repo) {
            format!("`{uses}` is not in the repository at this commit.")
        } else if on_github {
            format!("`{uses}` was found neither on g1t nor in a public repository on GitHub.")
        } else {
            format!("`{uses}`: {repository} has no {file} at {git_ref}.")
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_called_workflow_gets_only_the_secrets_passed_to_it() {
        let base: serde_json::Map<String, Value> =
            serde_json::from_value(json!({ "NPM_TOKEN": "npm-1", "DEPLOY_KEY": "key-2", "OTHER": "x" })).unwrap();
        let github = json!({ "ref": "refs/heads/main" });
        let vars = serde_json::Map::new();
        let contexts: serde_json::Map<String, Value> = serde_json::from_value(json!({ "needs": { "build": { "outputs": { "target": "prod" } } } })).unwrap();
        // Nothing passed: nothing but the job's token, which is added later.
        let none = secrets_plan(&json!({ "uses": "acme/shared/.g1t/workflows/x.yml@v1" }), &contexts, None);
        assert!(resolve_secrets(&none, &base, &github, &vars).is_empty());
        // inherit: all of them.
        let inherit = secrets_plan(&json!({ "secrets": "inherit" }), &contexts, None);
        assert_eq!(resolve_secrets(&inherit, &base, &github, &vars), base);
        // A mapping: each name's expression, read with the caller's secrets
        // and contexts.
        let mapped = secrets_plan(
            &json!({ "secrets": { "token": "${{ secrets.NPM_TOKEN }}", "where": "${{ needs.build.outputs.target }}-${{ secrets.DEPLOY_KEY }}" } }),
            &contexts,
            None,
        );
        let passed = resolve_secrets(&mapped, &base, &github, &vars);
        assert_eq!(passed.len(), 2);
        assert_eq!(passed["token"], "npm-1");
        assert_eq!(passed["where"], "prod-key-2");
        // Nested: the inner call reads what the outer one was given.
        let inner = secrets_plan(&json!({ "secrets": { "NPM": "${{ secrets.token }}", "LEAK": "${{ secrets.OTHER }}" } }), &contexts, Some(mapped.clone()));
        let passed = resolve_secrets(&inner, &base, &github, &vars);
        assert_eq!(passed.get("NPM"), Some(&json!("npm-1")));
        assert_eq!(passed.get("LEAK"), None);
        let inherited = secrets_plan(&json!({ "secrets": "inherit" }), &contexts, Some(mapped));
        assert_eq!(resolve_secrets(&inherited, &base, &github, &vars).len(), 2);
    }

    #[test]
    fn required_secrets_must_be_passed() {
        let called = g1t_actions::workflow::parse(
            "on:\n  workflow_call:\n    secrets:\n      token: { required: true }\n      extra: { required: false }\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{ run: 'true' }]",
        )
        .unwrap()
        .raw;
        let none = secrets_plan(&json!({}), &serde_json::Map::new(), None);
        assert_eq!(missing_secrets(&called, &none), ["token"]);
        let passed = secrets_plan(&json!({ "secrets": { "TOKEN": "${{ secrets.X }}" } }), &serde_json::Map::new(), None);
        assert!(missing_secrets(&called, &passed).is_empty());
        let inherit = secrets_plan(&json!({ "secrets": "inherit" }), &serde_json::Map::new(), None);
        assert!(missing_secrets(&called, &inherit).is_empty());
    }

    #[test]
    fn only_workflow_files_are_called() {
        assert!(is_workflow_path(".g1t/workflows/build.yml"));
        assert!(is_workflow_path(".github/workflows/build.yaml"));
        assert!(!is_workflow_path("actions/setup/action.yml"));
        assert!(!is_workflow_path(".github/workflows/notes.md"));
        assert_eq!(candidates(".github/workflows/x.yml"), [".github/workflows/x.yml", ".g1t/workflows/x.yml"]);
        assert_eq!(candidates(".g1t/workflows/x.yml"), [".g1t/workflows/x.yml"]);
    }

    fn repo(id: &str, namespace: &str, private: bool) -> Repo {
        serde_json::from_value(json!({
            "id": id, "namespace": namespace, "name": id, "description": null, "isPrivate": private,
            "ownerId": "ws_1", "defaultBranch": "main", "forkOf": null, "createdAt": ""
        }))
        .unwrap()
    }

    #[test]
    fn uses_names_a_repository_a_path_and_a_ref() {
        assert_eq!(
            parse_uses("acme/shared/.g1t/workflows/build.yml@v2"),
            Some(UsesRef { owner: "acme".into(), repo: "shared".into(), path: ".g1t/workflows/build.yml".into(), git_ref: "v2".into() })
        );
        assert_eq!(parse_uses("acme/setup@main").map(|u| (u.path, u.git_ref)), Some((String::new(), "main".into())));
        assert_eq!(parse_uses("./.g1t/workflows/build.yml"), None);
        assert_eq!(parse_uses("docker://alpine:3"), None);
        assert_eq!(parse_uses("acme/setup"), None);
        assert_eq!(parse_uses("acme/../x@v1"), None);
        assert_eq!(parse_uses("acme/shared/../../etc@v1"), None);
    }

    #[test]
    fn who_may_use_a_repositorys_actions() {
        let web = repo("web", "acme", true);
        // Itself, and anything public, always.
        assert!(may_use(&web, &web, "none").is_ok());
        assert!(may_use(&web, &repo("lint", "other", false), "none").is_ok());
        // A private one: only when it allows its workspace's repositories.
        let shared = repo("shared", "acme", true);
        assert!(may_use(&web, &shared, "none").unwrap_err().contains("Settings, Actions, Access"));
        assert!(may_use(&web, &shared, "organization").is_ok());
        // Never from another workspace, nor from a public repository.
        assert!(may_use(&repo("x", "other", true), &shared, "organization").unwrap_err().contains("only repositories in acme"));
        assert!(may_use(&repo("site", "acme", false), &shared, "organization").unwrap_err().contains("public repository"));
    }
}
