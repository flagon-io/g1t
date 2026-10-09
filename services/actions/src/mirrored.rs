//! What runs on a mirror (see `g1t_contracts::mirrors`).
//!
//! A mirror standing by runs nothing: its workflows run where it is
//! mirrored from. Its owners can keep CI warm, which runs `.g1t/workflows`
//! on the pushes copied in. In CI failover the remote keeps the code and
//! g1t runs its workflows, GitHub's `.github/workflows` as well as g1t's
//! own; during a takeover it does too, unless the link says not to. A
//! workflow that deploys waits for approval in both, unless the link says
//! otherwise, so nothing deploys from two places. While a takeover is
//! handed back, nothing starts.

use g1t_actions::workflow::Workflow;
use g1t_contracts::mirrors::{MirrorState, RepoMirror};

/// GitHub's own folder, read on a mirror in CI failover or taken over.
pub const GITHUB_FOLDER: &str = ".github/workflows";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Policy {
    /// Whether workflows start at all.
    pub runs: bool,
    /// Whether `.github/workflows` is read as well as `.g1t/workflows`.
    pub github: bool,
    /// Set when a workflow that deploys waits for approval: the remote, as
    /// people name it.
    pub hold: Option<String>,
}

/// What runs on a repository with `mirror`, for an event that was a push
/// copied in from the remote (`copied_in`) or anything else.
pub fn policy(mirror: Option<&RepoMirror>, copied_in: bool) -> Policy {
    let Some(mirror) = mirror else {
        return Policy { runs: true, github: false, hold: None };
    };
    let hold = mirror.hold_deploys.then(|| mirror.remote.clone());
    match mirror.state {
        MirrorState::Standby => Policy { runs: copied_in && mirror.warm, github: false, hold: None },
        MirrorState::Ci => Policy { runs: true, github: true, hold },
        MirrorState::Takeover => Policy { runs: true, github: mirror.github_workflows, hold },
        MirrorState::HandingBack => Policy::default(),
    }
}

/// Why nothing runs, for someone who asked for a run.
pub fn refused(namespace: &str, name: &str, mirror: &RepoMirror) -> String {
    match mirror.state {
        MirrorState::HandingBack => format!("{namespace}/{name} is handing back to {}. Workflows start again once that is done.", mirror.remote),
        _ => format!(
            "{namespace}/{name} is a standby mirror of {remote}: its workflows run there. Start CI failover or take over in Settings → Mirroring to run them on g1t.",
            remote = mirror.remote
        ),
    }
}

/// The environment a workflow deploys to, if any job names one.
pub fn deploys_to(workflow: &Workflow) -> Option<String> {
    workflow.jobs.iter().find_map(|job| match &job.raw["environment"] {
        serde_json::Value::String(name) => Some(name.clone()),
        serde_json::Value::Object(environment) => {
            Some(environment.get("name").and_then(|name| name.as_str()).unwrap_or("an environment").to_owned())
        }
        _ => None,
    })
}

/// Why a deploying workflow waits.
pub fn held(remote: &str, environment: &str) -> String {
    format!(
        "This workflow deploys to {environment}. While {remote} may still deploy too, runs that deploy wait for approval so nothing deploys twice."
    )
}

/// Whether a change touches what runs: workflows or local actions.
pub fn touches_workflows(paths: &[String]) -> bool {
    paths.iter().any(|path| path.starts_with(".g1t/") || path.starts_with(".github/workflows/") || path.starts_with(".github/actions/"))
}

/// Why a run from a push copied in waits.
pub fn copied_workflows(remote: &str) -> String {
    format!(
        "This push came from {remote} and changes workflows. Approve the run to let it use this repository's secrets and variables."
    )
}

/// Drops `.github` workflows that a `.g1t` one of the same name stands in
/// for: g1t's own wins.
pub fn prefer_g1t(files: Vec<crate::sync::WorkflowFile>) -> Vec<crate::sync::WorkflowFile> {
    let name = |file: &crate::sync::WorkflowFile| {
        g1t_actions::workflow::parse(&file.source)
            .map(|workflow| workflow.display_name(&file.path))
            .unwrap_or_else(|_| file.path.clone())
    };
    let ours: Vec<String> = files.iter().filter(|file| !file.path.starts_with(GITHUB_FOLDER)).map(name).collect();
    files
        .into_iter()
        .filter(|file| !file.path.starts_with(GITHUB_FOLDER) || !ours.contains(&name(file)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mirror(state: MirrorState) -> RepoMirror {
        RepoMirror {
            state,
            remote: "github.com/acme/web".into(),
            warm: false,
            github_workflows: true,
            hold_deploys: true,
            ..RepoMirror::default()
        }
    }

    #[test]
    fn a_standby_mirror_runs_nothing_unless_kept_warm() {
        assert_eq!(policy(None, false), Policy { runs: true, github: false, hold: None });
        assert!(!policy(Some(&mirror(MirrorState::Standby)), true).runs);
        let warm = RepoMirror { warm: true, ..mirror(MirrorState::Standby) };
        assert_eq!(policy(Some(&warm), true), Policy { runs: true, github: false, hold: None });
        assert!(!policy(Some(&warm), false).runs, "only the pushes copied in");
        assert!(!policy(Some(&mirror(MirrorState::HandingBack)), true).runs);
    }

    #[test]
    fn ci_failover_and_takeover_run_githubs_workflows_and_hold_deploys() {
        let ci = policy(Some(&mirror(MirrorState::Ci)), true);
        assert!(ci.runs && ci.github);
        assert_eq!(ci.hold.as_deref(), Some("github.com/acme/web"));
        let quiet = RepoMirror { github_workflows: false, hold_deploys: false, ..mirror(MirrorState::Takeover) };
        assert_eq!(policy(Some(&quiet), false), Policy { runs: true, github: false, hold: None });
        assert!(refused("acme", "web", &mirror(MirrorState::Standby)).contains("standby mirror of github.com/acme/web"));
    }

    #[test]
    fn a_workflow_deploys_when_a_job_names_an_environment() {
        let parse = |text: &str| g1t_actions::workflow::parse(text).unwrap();
        let build = parse("on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n");
        assert_eq!(deploys_to(&build), None);
        let deploy = parse("on: push\njobs:\n  ship:\n    runs-on: ubuntu-latest\n    environment: production\n    steps:\n      - run: echo\n");
        assert_eq!(deploys_to(&deploy).as_deref(), Some("production"));
        let named = parse(
            "on: push\njobs:\n  ship:\n    runs-on: ubuntu-latest\n    environment:\n      name: staging\n      url: https://x\n    steps:\n      - run: echo\n",
        );
        assert_eq!(deploys_to(&named).as_deref(), Some("staging"));
    }

    #[test]
    fn a_copied_push_that_changes_workflows_waits() {
        let paths = |list: &[&str]| list.iter().map(|path| path.to_string()).collect::<Vec<_>>();
        assert!(touches_workflows(&paths(&["src/a.rs", ".g1t/workflows/ci.yml"])));
        assert!(touches_workflows(&paths(&[".github/workflows/deploy.yml"])));
        assert!(touches_workflows(&paths(&[".github/actions/setup/action.yml"])));
        assert!(!touches_workflows(&paths(&[".github/CODEOWNERS", "README.md"])));
    }

    #[test]
    fn g1ts_own_workflow_stands_in_for_githubs_of_the_same_name() {
        let file = |path: &str, name: &str| crate::sync::WorkflowFile {
            path: path.into(),
            source: format!("name: {name}\non: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: echo\n"),
        };
        let kept = prefer_g1t(vec![
            file(".g1t/workflows/ci.yml", "CI"),
            file(".github/workflows/ci.yml", "CI"),
            file(".github/workflows/lint.yml", "Lint"),
        ]);
        let paths: Vec<&str> = kept.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(paths, [".g1t/workflows/ci.yml", ".github/workflows/lint.yml"]);
    }
}
