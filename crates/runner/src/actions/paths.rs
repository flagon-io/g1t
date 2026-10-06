//! Where a job's files go. In g1t's sandbox (and in a container a
//! self-hosted runner starts) that is GitHub's layout under `/home/runner`.
//! A self-hosted runner running a job directly on its machine
//! (`g1t-runner run --no-docker`) sets `G1T_RUNNER_ROOT` to a folder of its
//! own, and every `/home/runner` path, the spec's included, moves there.

use std::path::PathBuf;

use serde_json::Value;

/// GitHub's runner layout, as g1t's sandbox has it.
pub(crate) const HOME_RUNNER: &str = "/home/runner";

/// The folder standing in for `/home/runner`, if the job runs elsewhere.
pub(crate) fn root() -> Option<PathBuf> {
    std::env::var_os("G1T_RUNNER_ROOT").filter(|root| !root.is_empty()).map(PathBuf::from)
}

/// `path` (under `/home/runner`) where this job keeps it.
pub(crate) fn under_home(path: &str) -> PathBuf {
    match (root(), path.strip_prefix(HOME_RUNNER)) {
        (Some(root), Some(rest)) => root.join(rest.trim_start_matches('/')),
        _ => PathBuf::from(path),
    }
}

/// A path as the job's processes see it: with forward slashes, which every
/// shell takes, Windows' included.
pub(crate) fn shown(path: &std::path::Path) -> String {
    let text = path.display().to_string();
    if cfg!(windows) { text.replace('\\', "/") } else { text }
}

/// `text` with `/home/runner` moved to `root`.
fn moved(text: &str, root: &str) -> String {
    match text.strip_prefix(HOME_RUNNER) {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => format!("{root}{rest}"),
        _ => text.to_owned(),
    }
}

/// Moves every `/home/runner` path in a spec's values (its variables,
/// `github` and `runner` contexts) to where this job keeps its files.
pub(crate) fn relocate(value: &mut Value) {
    let Some(root) = root() else { return };
    relocate_to(value, &shown(&root));
}

fn relocate_to(value: &mut Value, root: &str) {
    match value {
        Value::String(text) => *text = moved(text, root),
        Value::Array(items) => items.iter_mut().for_each(|item| relocate_to(item, root)),
        Value::Object(fields) => fields.values_mut().for_each(|item| relocate_to(item, root)),
        _ => {}
    }
}

/// How `PATH` separates its entries here.
pub(crate) const PATH_SEPARATOR: &str = if cfg!(windows) { ";" } else { ":" };

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn home_runner_paths_move_and_nothing_else_does() {
        let mut spec = json!({
            "GITHUB_WORKSPACE": "/home/runner/work/repo",
            "RUNNER_TEMP": "/home/runner/_temp",
            "HOME": "/home/runnerish",
            "list": ["/home/runner", "/etc/hosts"],
            "n": 3,
        });
        relocate_to(&mut spec, "/srv/jobs/job_1");
        assert_eq!(
            spec,
            json!({
                "GITHUB_WORKSPACE": "/srv/jobs/job_1/work/repo",
                "RUNNER_TEMP": "/srv/jobs/job_1/_temp",
                "HOME": "/home/runnerish",
                "list": ["/srv/jobs/job_1", "/etc/hosts"],
                "n": 3,
            })
        );
    }
}
