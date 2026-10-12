//! The Sandboxed backend on Linux today: the runner's image under Sysbox,
//! through this computer's Docker, exactly as docs.g1t.sh/guides/
//! self-hosted-runners/#run-it-as-a-container runs it. Sysbox gives the
//! runner's container a user namespace of its own and a Docker Engine
//! inside it, so each job is a container inside the runner's container and
//! neither reaches this computer (`nested-container` isolation). The
//! machine's Docker socket is never given to it.
//!
//! The registration and credential are kept on a volume of their own, so
//! the container can be replaced, when a newer image is out, without
//! registering again. Keeping it up to date is pulling the image and,
//! while the runner is idle, putting a new container in the old one's place.

use std::process::{Child, Stdio};

use super::backend::quiet;

/// The runner's image, published with each release.
pub const IMAGE: &str = "g1t.sh/flagon-io/g1t-runner:latest";
/// The container the app runs, and the volume its registration is kept on.
pub const NAME: &str = "g1t-desktop-runner";
pub const VOLUME: &str = "g1t-desktop-runner";

fn docker_ok(args: &[&str]) -> bool {
    quiet("docker").args(args).stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|status| status.success())
}

fn docker_text(args: &[&str]) -> Option<String> {
    let out = quiet("docker").args(args).stderr(Stdio::null()).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned()).filter(|text| !text.is_empty())
}

/// The arguments of the `docker run` that starts the runner. Each
/// variable's value comes from the environment of the `docker` command,
/// never its command line, so a registration token is not in the
/// computer's list of processes.
pub fn run_args(names: &[&str]) -> Vec<String> {
    let mut args: Vec<String> = ["run", "-d", "--name", NAME, "--runtime=sysbox-runc", "--label", "sh.g1t.desktop=runner", "-v"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    args.push(format!("{VOLUME}:/data"));
    for name in names {
        args.push("-e".into());
        args.push((*name).to_owned());
    }
    args.push(IMAGE.into());
    args.push("register-and-run".into());
    args
}

/// Fetches the newest image; whether the one here changed.
pub fn pull() -> bool {
    let before = docker_text(&["image", "inspect", "--format", "{{.Id}}", IMAGE]);
    let pulled = docker_ok(&["pull", "--quiet", IMAGE]);
    pulled && docker_text(&["image", "inspect", "--format", "{{.Id}}", IMAGE]) != before
}

/// Whether the image is here at all.
pub fn have_image() -> bool {
    docker_ok(&["image", "inspect", IMAGE])
}

/// Whether the running container is from an older image than the one here.
pub fn outdated() -> bool {
    let image = docker_text(&["image", "inspect", "--format", "{{.Id}}", IMAGE]);
    let running = docker_text(&["inspect", "--format", "{{.Image}}", NAME]);
    matches!((image, running), (Some(image), Some(running)) if image != running)
}

/// Whether a registration is kept here.
pub fn registered() -> bool {
    docker_ok(&["volume", "inspect", VOLUME])
}

/// Starts the runner's container in place of any earlier one, then
/// follows its log: the child's output is the runner's.
pub fn start(envs: &[(&str, String)]) -> Result<Child, String> {
    let _ = docker_ok(&["rm", "-f", NAME]);
    let names: Vec<&str> = envs.iter().map(|(name, _)| *name).collect();
    let out = quiet("docker")
        .args(run_args(&names))
        .envs(envs.iter().map(|(name, value)| (*name, value.as_str())))
        .stdout(Stdio::null())
        .output()
        .map_err(|e| format!("could not run docker: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_owned());
    }
    quiet("docker")
        .args(["logs", "--follow", NAME])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not follow the runner's log: {e}"))
}

/// How the container's runner ended, while the container is still there.
pub fn exit_code() -> Option<i32> {
    docker_text(&["inspect", "--format", "{{.State.ExitCode}}", NAME]).and_then(|code| code.parse().ok())
}

/// Stops the container and removes it; its volume stays.
pub fn stop(logs: Option<&mut Child>) {
    let _ = docker_ok(&["stop", "--time", "20", NAME]);
    let _ = docker_ok(&["rm", "-f", NAME]);
    if let Some(logs) = logs {
        let _ = logs.kill();
        let _ = logs.wait();
    }
}

/// Unregisters the runner kept on the volume, then removes the volume.
pub fn forget() {
    if registered() {
        let mut args = vec!["run", "--rm", "--runtime=sysbox-runc", "-v"];
        let mount = format!("{VOLUME}:/data");
        args.push(&mount);
        args.extend([IMAGE, "remove"]);
        let _ = docker_ok(&args);
        let _ = docker_ok(&["volume", "rm", "-f", VOLUME]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_runner_runs_under_sysbox_without_the_machines_docker() {
        let args = run_args(&["G1T_RUNNER_URL", "G1T_RUNNER_TOKEN"]);
        assert!(args.contains(&"--runtime=sysbox-runc".to_owned()));
        assert!(args.contains(&"g1t-desktop-runner:/data".to_owned()));
        assert!(!args.iter().any(|a| a.contains("docker.sock") || a == "--privileged"), "{args:?}");
        // Values never on the command line: only the names.
        assert!(args.windows(2).any(|w| w[0] == "-e" && w[1] == "G1T_RUNNER_TOKEN"));
        assert_eq!(&args[args.len() - 2..], [IMAGE, "register-and-run"]);
    }
}
