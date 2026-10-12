//! Managed workflows: workflows g1t (or a workspace) installs into a
//! repository without committing them. One runs like any workflow in
//! `.g1t/workflows/` (the same runs, logs, re-runs and checks), from a
//! source kept beside the repository rather than in it, under a path in
//! [`FOLDER`] that no file can have.
//!
//! A repository takes one over by having a workflow of the same `name:` in
//! `.g1t/workflows/`: that file runs instead ([`prefer_repository`]). So
//! moving a managed workflow into the repository is committing its source.
//!
//! [`deploy_workflow`] writes the one deployments install: it calls g1t's
//! own reusable deploy workflow with the project's settings as its inputs.

use crate::workflow;

/// Where managed workflows' paths start. Not a folder in any repository:
/// workflow files are read from `.g1t/workflows/` and `.github/workflows/`.
pub const FOLDER: &str = "managed";

/// The `name:` of the workflow deployments install, and of its calling
/// job, so the called job's check is `g1t / deploy`, the name a g1t.page
/// build's status has always had.
pub const DEPLOY_NAME: &str = "g1t";

/// The reusable workflow the deploy workflow calls.
pub const DEPLOY_CALLS: &str = "g1t/workflows/.g1t/workflows/deploy.yml@v1";

/// The path a managed workflow called `name` runs under.
pub fn path(name: &str) -> String {
    format!("{FOLDER}/{name}.yml")
}

/// Whether `path` is a managed workflow's.
pub fn is_managed(path: &str) -> bool {
    path.strip_prefix(FOLDER).is_some_and(|rest| rest.starts_with('/'))
}

/// A project's deployment settings, as the deploy workflow's triggers and
/// inputs.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DeploySettings {
    /// The project's slug, which names its app.
    pub project: String,
    /// The branch production builds from: the repository's default branch.
    pub production_branch: String,
    /// The project's folder in the repository; empty or `.` for the root.
    pub root_dir: String,
    /// Empty: what deployments detect.
    pub build_command: String,
    /// Empty: what deployments detect.
    pub output_dir: String,
    /// Whether pull requests get previews.
    pub previews: bool,
    /// Whether pushes to the production branch deploy.
    pub production: bool,
}

/// A string as YAML reads it back unchanged: JSON's quoting is YAML's.
fn quoted(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_owned())
}

/// The workflow deployments install for a project, or None when it neither
/// previews nor deploys production, so nothing would start it.
pub fn deploy_workflow(settings: &DeploySettings) -> Option<String> {
    if !settings.previews && !settings.production {
        return None;
    }
    let mut on = String::new();
    if settings.production {
        on.push_str(&format!("  push:\n    branches: [{}]\n", quoted(&settings.production_branch)));
    }
    if settings.previews {
        // Previews come down on the server when their pull request closes.
        on.push_str("  pull_request:\n    types: [opened, synchronize, reopened, ready_for_review]\n");
    }
    let root_dir = if settings.root_dir.trim().is_empty() { "." } else { settings.root_dir.trim() };
    Some(format!(
        "# Managed by g1t, from the deployment settings of the project {project}.\n\
         # It is not in the repository. A workflow named \"{name}\" in .g1t/workflows/\n\
         # runs in its place.\n\
         name: {name}\n\
         on:\n\
         {on}\
         # A newer push replaces a build still running for the same branch or\n\
         # pull request.\n\
         concurrency:\n  \
           group: ${{{{ github.workflow }}}}-{project_key}-${{{{ github.event.pull_request.number || github.ref }}}}\n  \
           cancel-in-progress: true\n\
         permissions:\n  \
           contents: read\n  \
           deployments: write\n  \
           id-token: write\n\
         jobs:\n  \
           {name}:\n    \
             name: {name}\n    \
             uses: {calls}\n    \
             with:\n      \
               project: {project}\n      \
               root-dir: {root_dir}\n      \
               build-command: {build_command}\n      \
               output-dir: {output_dir}\n    \
             secrets: inherit\n",
        name = DEPLOY_NAME,
        calls = DEPLOY_CALLS,
        on = on,
        project = quoted(&settings.project),
        project_key = settings.project.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect::<String>(),
        root_dir = quoted(root_dir),
        build_command = quoted(settings.build_command.trim()),
        output_dir = quoted(settings.output_dir.trim()),
    ))
}

/// A workflow's name, as it would be listed: its `name:`, else its path.
fn listed_name(path: &str, source: &str) -> String {
    workflow::parse(source).map(|parsed| parsed.display_name(path)).unwrap_or_else(|_| path.to_owned())
}

/// The managed workflows that run beside a repository's own `files`, each
/// as `(path, source)`: every one, except those a file of the same `name:`
/// takes the place of.
pub fn prefer_repository<'a>(files: impl IntoIterator<Item = (&'a str, &'a str)>, managed: Vec<(String, String)>) -> Vec<(String, String)> {
    let theirs: Vec<String> = files.into_iter().map(|(path, source)| listed_name(path, source)).collect();
    managed.into_iter().filter(|(path, source)| !theirs.contains(&listed_name(path, source))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::Severity;

    fn settings() -> DeploySettings {
        DeploySettings {
            project: "web".into(),
            production_branch: "main".into(),
            root_dir: "apps/web".into(),
            build_command: String::new(),
            output_dir: "dist".into(),
            previews: true,
            production: true,
        }
    }

    #[test]
    fn the_deploy_workflow_is_a_workflow_g1t_runs_as_it_is() {
        let source = deploy_workflow(&settings()).unwrap();
        let parsed = workflow::parse(&source).unwrap();
        assert_eq!(parsed.name.as_deref(), Some("g1t"));
        assert!(parsed.trigger("push").is_some() && parsed.trigger("pull_request").is_some());
        assert!(!parsed.notes.iter().any(|note| note.severity != Severity::Info), "{:?}", parsed.notes);
        let job = &parsed.jobs[0];
        assert_eq!(job.id, "g1t");
        assert!(source.contains("uses: g1t/workflows/.g1t/workflows/deploy.yml@v1"));
        assert!(source.contains("root-dir: \"apps/web\"") && source.contains("output-dir: \"dist\"") && source.contains("build-command: \"\""));
        assert!(source.contains("branches: [\"main\"]"));
    }

    #[test]
    fn the_called_workflow_takes_every_input_the_deploy_workflow_gives() {
        let called = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../workflows/.g1t/workflows/deploy.yml")).unwrap();
        let parsed = workflow::parse(&called).unwrap();
        assert!(!parsed.notes.iter().any(|note| note.severity != Severity::Info), "{:?}", parsed.notes);
        let raw: serde_json::Value = serde_yaml::from_str(&called).unwrap();
        let inputs = &raw["on"]["workflow_call"]["inputs"];
        let caller = workflow::parse(&deploy_workflow(&settings()).unwrap()).unwrap();
        for (key, _) in caller.jobs[0].raw["with"].as_object().unwrap() {
            assert!(inputs.get(key).is_some(), "the called workflow takes no `{key}`");
        }
        // Its job is `deploy`, so the caller's `g1t` reports `g1t / deploy`.
        assert_eq!(parsed.jobs[0].raw["name"], "deploy");
        assert!(DEPLOY_CALLS.starts_with("g1t/workflows/.g1t/workflows/deploy.yml@"));
    }

    #[test]
    fn what_a_project_turns_off_starts_nothing() {
        let previews_only = deploy_workflow(&DeploySettings { production: false, ..settings() }).unwrap();
        let parsed = workflow::parse(&previews_only).unwrap();
        assert!(parsed.trigger("push").is_none() && parsed.trigger("pull_request").is_some());
        let production_only = deploy_workflow(&DeploySettings { previews: false, ..settings() }).unwrap();
        assert!(workflow::parse(&production_only).unwrap().trigger("pull_request").is_none());
        assert_eq!(deploy_workflow(&DeploySettings { previews: false, production: false, ..settings() }), None);
    }

    #[test]
    fn settings_are_quoted_so_they_stay_text() {
        let tricky = DeploySettings { build_command: "npm run build -- --base \"/x\": yes".into(), root_dir: String::new(), ..settings() };
        let source = deploy_workflow(&tricky).unwrap();
        let parsed = workflow::parse(&source).unwrap();
        let with = &parsed.jobs[0].raw["with"];
        assert_eq!(with["build-command"], "npm run build -- --base \"/x\": yes");
        assert_eq!(with["root-dir"], ".");
    }

    #[test]
    fn a_repository_workflow_of_the_same_name_takes_its_place() {
        let deploy = (path("deploy"), deploy_workflow(&settings()).unwrap());
        let other = (path("scan"), "name: Scan\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{ run: 'true' }]\n".to_owned());
        let own = "name: g1t\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{ run: 'true' }]\n";
        let kept = prefer_repository([(".g1t/workflows/g1t.yml", own)], vec![deploy.clone(), other.clone()]);
        assert_eq!(kept, vec![other.clone()]);
        let kept = prefer_repository([(".g1t/workflows/ci.yml", "name: CI\non: push\njobs: {}\n")], vec![deploy.clone(), other]);
        assert_eq!(kept.len(), 2);
        assert!(is_managed(&deploy.0) && !is_managed(".g1t/workflows/g1t.yml") && !is_managed("managedx/a.yml"));
    }
}
