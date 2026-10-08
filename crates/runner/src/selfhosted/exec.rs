//! Running what g1t hands the runner: a workflow job or agent work, with
//! the same harness g1t's sandboxes run (this program, in another mode).
//!
//! - **In Docker** (the default): one container per job, removed when it
//!   ends, from the job's `container:` image or the runner's `--image`. A
//!   Linux build of the harness is mounted into it read-only. Its
//!   credentials are passed by name (`-e NAME`), never on the command line.
//! - **Directly** (`--no-docker`): the harness runs as a child process, in a
//!   fresh folder under the runner's work folder that is removed after.
//!
//! The runner's own credential never reaches either: a job only ever has
//! its own short-lived token, as it would in g1t's sandbox.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};

use super::api::Assignment;
use super::config::Config;
use super::{log, update};

/// The image workflow jobs run in when they name none: Debian with Node,
/// git and Python, as g1t's sandbox has.
pub const DEFAULT_IMAGE: &str = "node:24-bookworm";

/// Work in progress.
pub struct Running {
    pub id: String,
    pub kind: String,
    pub name: String,
    child: Child,
    container: Option<String>,
    folder: Option<PathBuf>,
    /// Past its time limit and a grace for g1t to say so: stopped here.
    deadline: Instant,
}

impl Running {
    pub fn overdue(&self) -> bool {
        Instant::now() > self.deadline
    }

    /// Its exit code once it has ended.
    pub fn ended(&mut self) -> Option<i32> {
        match self.child.try_wait() {
            Ok(Some(status)) => Some(status.code().unwrap_or(1)),
            Ok(None) => None,
            Err(_) => Some(1),
        }
    }

    /// Stops it: the container, then the process and everything it started.
    pub fn stop(&mut self) {
        if let Some(container) = &self.container {
            let _ = Command::new("docker").args(["kill", container]).stdout(Stdio::null()).stderr(Stdio::null()).status();
        }
        let pid = self.child.id().to_string();
        if cfg!(windows) {
            let _ = Command::new("taskkill").args(["/T", "/F", "/PID", &pid]).stdout(Stdio::null()).stderr(Stdio::null()).status();
        } else {
            // Its own process group (see `directly`): the steps' processes too.
            let _ = Command::new("kill").args(["-TERM", &format!("-{pid}")]).stdout(Stdio::null()).stderr(Stdio::null()).status();
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    /// Removes what it left on the machine.
    pub fn clean(&mut self) {
        if let Some(container) = &self.container {
            let _ = Command::new("docker").args(["rm", "-f", container]).stdout(Stdio::null()).stderr(Stdio::null()).status();
        }
        if let Some(folder) = &self.folder {
            let _ = std::fs::remove_dir_all(folder);
        }
    }
}

/// A name Docker takes, from a job's id.
fn container_name(id: &str) -> String {
    let clean: String = id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '-' }).collect();
    format!("g1t-{clean}")
}

/// The environment the harness gets for this work.
fn harness_env(config: &Config, work: &Assignment) -> Result<BTreeMap<String, String>> {
    let mut env = BTreeMap::new();
    match work.kind.as_str() {
        "workflow" => {
            let Some(token) = &work.token else { bail!("the job came without its token") };
            env.insert("MODE".into(), "actions".into());
            env.insert("G1T_API".into(), config.api.clone());
            env.insert("ACTIONS_JOB".into(), work.id.clone());
            env.insert("ACTIONS_TOKEN".into(), token.clone());
        }
        "agent" => {
            for (name, value) in work.env.clone().unwrap_or_default() {
                let value = match value {
                    serde_json::Value::String(text) => text,
                    other => other.to_string(),
                };
                env.insert(name, value);
            }
            if !env.contains_key("MODE") && !env.contains_key("PROMPT") {
                bail!("the agent work came without its environment");
            }
            // Where its API calls go: this installation's.
            env.insert("G1T_API".into(), config.api.clone());
        }
        other => bail!("this runner does not know work of kind {other}; update it"),
    }
    // The machine is the workspace's own: no mining watch.
    env.insert("G1T_ABUSE".into(), "off".into());
    Ok(env)
}

/// Starts work. The harness reports a workflow job's steps and log itself;
/// the runner tells g1t how the process ended.
pub fn start(config: &Config, folder: &Path, work: &Assignment) -> Result<Running> {
    let env = harness_env(config, work)?;
    if config.docker { in_docker(config, folder, work, env) } else { directly(config, work, env) }
}

fn in_docker(config: &Config, folder: &Path, work: &Assignment, env: BTreeMap<String, String>) -> Result<Running> {
    let image = match work.kind.as_str() {
        "agent" => match config.agent_image.clone().or_else(|| update::agent_image(config)) {
            Some(image) => image,
            None => bail!(
                "agent work needs an image with git, Node and the agent's CLI: register this runner with --agent-image, or run it with --no-docker on Linux"
            ),
        },
        _ => work.image.clone().or_else(|| config.image.clone()).unwrap_or_else(|| DEFAULT_IMAGE.to_owned()),
    };
    let harness = update::linux_harness(config, folder)?;
    let name = container_name(&work.id);
    let _ = Command::new("docker").args(["rm", "-f", &name]).stdout(Stdio::null()).stderr(Stdio::null()).status();
    let mut command = Command::new("docker");
    command.args(["run", "--rm", "--name", &name, "--label", &format!("sh.g1t.runner={}", config.runner)]);
    command.args(["--pull", "missing", "--init"]);
    // The job is in its `container:` image already: the harness inside
    // does not start it again (actions/containers.rs).
    command.args(["-e", "G1T_JOB_CONTAINER=1"]);
    for name in env.keys() {
        command.args(["-e", name]);
    }
    command.envs(&env);
    command.args(["-v", &format!("{}:/opt/g1t/g1t-runner:ro", harness.display())]);
    command.args(["--entrypoint", "/opt/g1t/g1t-runner", &image]);
    log(&format!("Running {} {} in {image}", work.kind, work.name));
    let child = command.spawn().context("could not run docker: is Docker installed and running? (or register with --no-docker)")?;
    Ok(Running { id: work.id.clone(), kind: work.kind.clone(), name: work.name.clone(), child, container: Some(name), folder: None, deadline: deadline(work) })
}

fn directly(config: &Config, work: &Assignment, env: BTreeMap<String, String>) -> Result<Running> {
    let me = std::env::current_exe().context("could not find this program to run the job")?;
    let mut command = Command::new(me);
    let mut folder = None;
    if work.kind == "workflow" {
        // GitHub's layout, in a folder of its own.
        let root = config.work_dir.join(container_name(&work.id));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).with_context(|| format!("could not make {}", root.display()))?;
        command.env("G1T_RUNNER_ROOT", &root);
        folder = Some(root);
    } else if !cfg!(target_os = "linux") || std::fs::create_dir_all("/work").is_err() {
        // Agent work expects g1t's sandbox layout (/work), which only a
        // Linux machine (or a container) set aside for it has.
        bail!("agent work runs in Docker, or directly on Linux where /work can be written; this runner can do neither");
    }
    // Its own variables, less anything of the runner's.
    for (name, _) in std::env::vars_os() {
        if name.to_string_lossy().starts_with("G1T_RUNNER_") && name != "G1T_RUNNER_ROOT" {
            command.env_remove(&name);
        }
    }
    command.envs(&env);
    // A group of its own, so stopping it stops what its steps started.
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    log(&format!("Running {} {} on this machine", work.kind, work.name));
    let child = command.spawn().context("could not start the job's process")?;
    Ok(Running { id: work.id.clone(), kind: work.kind.clone(), name: work.name.clone(), child, container: None, folder, deadline: deadline(work) })
}

fn deadline(work: &Assignment) -> Instant {
    Instant::now() + Duration::from_secs(u64::from(work.timeout_minutes.max(1)) * 60 + 10 * 60)
}

/// Whether Docker answers.
pub fn docker_ready() -> bool {
    Command::new("docker")
        .args(["version", "--format", "{{.Server.Version}}"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config() -> Config {
        Config {
            url: "https://g1t.sh".into(),
            api: "https://api.g1t.sh".into(),
            runner: "rnr_1".into(),
            name: "a".into(),
            credential: "g1tr_secret".into(),
            workspace: "acme".into(),
            repo: None,
            group: None,
            labels: vec![],
            ephemeral: false,
            work_dir: PathBuf::from("/tmp/w"),
            docker: true,
            image: None,
            agent_image: None,
            harness: None,
            auto_update: false,
        }
    }

    fn assignment(kind: &str) -> Assignment {
        serde_json::from_value(json!({
            "kind": kind, "id": "job_1", "name": "build", "repo": "acme/web", "timeout_minutes": 60,
            "token": "jobtoken", "env": { "MODE": "checks", "G1T_TOKEN": "g1t_run", "G1T_API": "https://elsewhere" }
        }))
        .unwrap()
    }

    #[test]
    fn a_workflow_job_gets_its_own_token_and_never_the_runners() {
        let env = harness_env(&config(), &assignment("workflow")).unwrap();
        assert_eq!(env["MODE"], "actions");
        assert_eq!(env["ACTIONS_JOB"], "job_1");
        assert_eq!(env["ACTIONS_TOKEN"], "jobtoken");
        assert_eq!(env["G1T_API"], "https://api.g1t.sh");
        assert!(env.values().all(|value| !value.contains("g1tr_")));
    }

    #[test]
    fn agent_work_gets_the_sandboxs_environment_and_this_api() {
        let env = harness_env(&config(), &assignment("agent")).unwrap();
        assert_eq!(env["MODE"], "checks");
        assert_eq!(env["G1T_TOKEN"], "g1t_run");
        assert_eq!(env["G1T_API"], "https://api.g1t.sh");
        assert_eq!(env["G1T_ABUSE"], "off");
    }

    #[test]
    fn unknown_work_is_refused() {
        assert!(harness_env(&config(), &assignment("deploy")).is_err());
    }

    #[test]
    fn container_names_are_dockers() {
        assert_eq!(container_name("job_01ab"), "g1t-job_01ab");
        assert_eq!(container_name("a/b c"), "g1t-a-b-c");
    }
}
