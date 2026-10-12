//! Managed workflows: workflows g1t (or a workspace) installs into a
//! repository without committing them. One runs like any workflow in
//! `.g1t/workflows/` (the same runs, logs, re-runs and checks), from a
//! source kept beside the repository rather than in it, under a path in
//! [`FOLDER`] that no file can have.
//!
//! A repository takes one over by having a workflow of the same `name:` in
//! `.g1t/workflows/`: that file runs instead ([`arrange`]). So moving a
//! managed workflow into the repository is committing its source. A
//! workspace's managed workflows ([`Target`], [`Mode`]) are the exception
//! when they are required: then the repository's file of that name is set
//! aside instead, and no repository can turn the workflow off.
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

/// Whether `name` can end a managed workflow's path: lowercase letters,
/// digits and hyphens, at most 64.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

/// How a workspace's managed workflow holds in its repositories.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// It runs in every repository it targets: a workflow of the same
    /// `name:` in the repository is set aside, and no repository can turn
    /// it off, so its check can be required.
    Required,
    /// It runs where the repository has no workflow of the same `name:`,
    /// and the repository's admins can turn it off.
    Default,
}

impl Mode {
    pub fn parse(text: &str) -> Option<Mode> {
        match text.trim().to_ascii_lowercase().as_str() {
            "required" => Some(Mode::Required),
            "default" => Some(Mode::Default),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Required => "required",
            Mode::Default => "default",
        }
    }
}

/// The visibilities a target can name.
pub const VISIBILITIES: [&str; 3] = ["all", "public", "private"];

/// Which of a workspace's repositories one of its managed workflows runs in.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Target {
    /// Repository names and patterns (`*`, `[a-z]`; `!` excludes what an
    /// earlier one included), read in order, the last match deciding,
    /// without regard to case. Empty is every repository; only exclusions
    /// is every repository but those.
    pub repositories: Vec<String>,
    /// One of [`VISIBILITIES`].
    pub visibility: String,
}

impl Target {
    /// Whether it takes in the repository `name`, private or not. A
    /// workflow read from a private repository (`source_private`) never
    /// runs in a public one, whose workflow page and logs anyone can read.
    pub fn includes(&self, name: &str, private: bool, source_private: bool) -> bool {
        if source_private && !private {
            return false;
        }
        match self.visibility.as_str() {
            "public" if private => return false,
            "private" if !private => return false,
            _ => {}
        }
        if self.repositories.is_empty() {
            return true;
        }
        let lowered: Vec<String> = self.repositories.iter().map(|pattern| pattern.trim().to_ascii_lowercase()).collect();
        let mut patterns = crate::filter::Patterns::new(&lowered);
        if patterns.0.iter().all(|pattern| pattern.negated) {
            patterns.0.insert(0, crate::filter::Pattern::parse("*"));
        }
        patterns.includes(&name.to_ascii_lowercase())
    }
}

/// A workflow a repository runs, as [`arrange`] decides.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Arranged {
    pub path: String,
    pub source: String,
    /// A workspace's required workflow: nothing turns it off.
    pub required: bool,
}

/// The workflows a repository runs: its own `files`, and the managed
/// workflows offered to it, those `installed` in it by g1t's services (such
/// as a project's deploy workflow) and its workspace's (`workspace`, each
/// with its [`Mode`]), all as `(path, source)`.
///
/// - The workspace's required workflows run, and a file of the same
///   `name:` is set aside, so nothing else reports their checks.
/// - Then the repository's own files.
/// - Then each other managed workflow that no workflow before it of the
///   same `name:` or path takes the place of: those installed in the
///   repository first, then the workspace's defaults.
pub fn arrange(files: Vec<(String, String)>, installed: Vec<(String, String)>, workspace: Vec<(String, String, Mode)>) -> Vec<Arranged> {
    let mut names: Vec<String> = Vec::new();
    let mut paths: Vec<String> = Vec::new();
    let mut out: Vec<Arranged> = Vec::new();
    let (required, defaults): (Vec<_>, Vec<_>) = workspace.into_iter().partition(|(_, _, mode)| *mode == Mode::Required);
    let offer = |path: String, source: String, required: bool, out: &mut Vec<Arranged>, names: &mut Vec<String>, paths: &mut Vec<String>| {
        let name = listed_name(&path, &source);
        if names.contains(&name) || paths.contains(&path) {
            return;
        }
        names.push(name);
        paths.push(path.clone());
        out.push(Arranged { path, source, required });
    };
    for (path, source, _) in required {
        offer(path, source, true, &mut out, &mut names, &mut paths);
    }
    // A repository's files are set aside only for a required workflow's
    // name, never for each other's.
    let required_names = names.clone();
    for (path, source) in files {
        let name = listed_name(&path, &source);
        if required_names.contains(&name) {
            continue;
        }
        names.push(name);
        paths.push(path.clone());
        out.push(Arranged { path, source, required: false });
    }
    for (path, source) in installed.into_iter().chain(defaults.into_iter().map(|(path, source, _)| (path, source))) {
        offer(path, source, false, &mut out, &mut names, &mut paths);
    }
    out
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

    fn own(path: &str, name: &str) -> (String, String) {
        (path.to_owned(), format!("name: {name}\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{{ run: 'true' }}]\n"))
    }

    fn paths(arranged: &[Arranged]) -> Vec<&str> {
        arranged.iter().map(|kept| kept.path.as_str()).collect()
    }

    #[test]
    fn a_repository_workflow_of_the_same_name_takes_its_place() {
        let deploy = (path("deploy"), deploy_workflow(&settings()).unwrap());
        let other = own(&path("scan"), "Scan");
        let kept = arrange(vec![own(".g1t/workflows/g1t.yml", "g1t")], vec![deploy.clone(), other.clone()], vec![]);
        assert_eq!(paths(&kept), [".g1t/workflows/g1t.yml", "managed/scan.yml"]);
        let kept = arrange(vec![own(".g1t/workflows/ci.yml", "CI")], vec![deploy.clone(), other], vec![]);
        assert_eq!(kept.len(), 3);
        assert!(kept.iter().all(|kept| !kept.required));
        assert!(is_managed(&deploy.0) && !is_managed(".g1t/workflows/g1t.yml") && !is_managed("managedx/a.yml"));
    }

    #[test]
    fn a_required_workflow_sets_aside_a_file_of_its_name() {
        let files = vec![own(".g1t/workflows/scan.yml", "Scan"), own(".g1t/workflows/ci.yml", "CI")];
        let kept = arrange(files, vec![], vec![(path("scan"), own("", "Scan").1, Mode::Required)]);
        assert_eq!(paths(&kept), ["managed/scan.yml", ".g1t/workflows/ci.yml"]);
        assert!(kept[0].required && !kept[1].required);
    }

    #[test]
    fn a_default_workflow_gives_way_to_a_file_of_its_name() {
        let files = vec![own(".g1t/workflows/lint.yml", "Lint")];
        let workspace = vec![(path("lint"), own("", "Lint").1, Mode::Default), (path("audit"), own("", "Audit").1, Mode::Default)];
        let kept = arrange(files, vec![], workspace);
        assert_eq!(paths(&kept), [".g1t/workflows/lint.yml", "managed/audit.yml"]);
        assert!(kept.iter().all(|kept| !kept.required));
    }

    #[test]
    fn a_repository_keeps_two_files_of_one_name() {
        let files = vec![own(".g1t/workflows/a.yml", "Same"), own(".g1t/workflows/b.yml", "Same")];
        assert_eq!(arrange(files, vec![], vec![]).len(), 2);
    }

    #[test]
    fn what_is_installed_in_the_repository_comes_between_required_and_default() {
        // The same path: required beats installed, installed beats default.
        let installed = vec![own(&path("deploy-web"), "Deploy")];
        let kept = arrange(vec![], installed.clone(), vec![(path("deploy-web"), own("", "Policy").1, Mode::Required)]);
        assert_eq!(kept.len(), 1);
        assert!(kept[0].source.contains("Policy") && kept[0].required);
        let kept = arrange(vec![], installed, vec![(path("deploy-web"), own("", "Policy").1, Mode::Default)]);
        assert_eq!(kept.len(), 1);
        assert!(kept[0].source.contains("Deploy") && !kept[0].required);
        // The same name at another path: the first offered stays.
        let kept = arrange(vec![], vec![own(&path("a"), "Same")], vec![(path("b"), own("", "Same").1, Mode::Default)]);
        assert_eq!(paths(&kept), ["managed/a.yml"]);
    }

    #[test]
    fn targets_take_names_patterns_and_visibility() {
        let all = Target { repositories: vec![], visibility: "all".into() };
        assert!(all.includes("web", true, false) && all.includes("web", false, false));
        let some = Target { repositories: vec!["web".into(), "api-*".into()], visibility: "all".into() };
        assert!(some.includes("web", false, false) && some.includes("API-gateway", false, false));
        assert!(!some.includes("docs", false, false) && !some.includes("webx", false, false));
        let but = Target { repositories: vec!["!sandbox-*".into()], visibility: "all".into() };
        assert!(but.includes("web", false, false) && !but.includes("sandbox-1", false, false));
        let then_back = Target { repositories: vec!["*".into(), "!sandbox-*".into(), "sandbox-keep".into()], visibility: "all".into() };
        assert!(then_back.includes("sandbox-keep", false, false) && !then_back.includes("sandbox-2", false, false));
        let private = Target { repositories: vec![], visibility: "private".into() };
        assert!(private.includes("web", true, false) && !private.includes("web", false, false));
        let public = Target { repositories: vec![], visibility: "public".into() };
        assert!(!public.includes("web", true, false) && public.includes("web", false, false));
    }

    #[test]
    fn a_private_source_never_runs_in_a_public_repository() {
        let all = Target { repositories: vec!["*".into()], visibility: "all".into() };
        assert!(all.includes("web", true, true));
        assert!(!all.includes("site", false, true));
    }

    #[test]
    fn modes_and_names_read_as_written() {
        assert_eq!(Mode::parse("Required"), Some(Mode::Required));
        assert_eq!(Mode::parse("default").map(Mode::as_str), Some("default"));
        assert_eq!(Mode::parse("optional"), None);
        assert!(valid_name("deploy") && valid_name("code-scanning-2"));
        for bad in ["", "Deploy", "a/b", "a.yml", "../x", &"a".repeat(65)] {
            assert!(!valid_name(bad), "{bad}");
        }
    }
}
