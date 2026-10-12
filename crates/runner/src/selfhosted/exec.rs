//! Running what g1t hands the runner: a workflow job or agent work, with
//! the same harness g1t's sandboxes run (this program, in another mode).
//!
//! - **In Docker** (the default): one container per job, removed when it
//!   ends, from the job's `container:` image or the runner's `--image`. A
//!   Linux build of the harness is mounted into it read-only; that and the
//!   job's own work volume, removed after, are its only mounts. It runs
//!   with every capability dropped but the few a build needs, no new
//!   privileges, a process, memory and CPU limit, and a network of its
//!   own. With nested-container isolation (sandbox.rs), all of this is on
//!   the runner's own Docker Engine, inside the runner's container, and a
//!   job that uses Docker gets an engine of its own (engine.rs).
//! - **Directly** (`--no-docker`, deprecated): the harness runs as a child
//!   process, in a fresh folder under the runner's work folder that is
//!   removed after. Unsandboxed: the job's log says so, and a public
//!   repository's work is refused.
//!
//! The runner's own credential never reaches either: a job only ever has
//! its own short-lived token, as it would in g1t's sandbox. Credentials are
//! passed by name (`-e NAME`), never on the command line.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};

use super::api::Assignment;
use super::config::Config;
use super::sandbox::{self, Isolation};
use super::{log, update};

/// The image workflow jobs run in when they name none: Debian with Node,
/// git and Python, as g1t's sandbox has.
pub const DEFAULT_IMAGE: &str = "node:24-bookworm";
/// The most processes in a job's container, unless the runner says.
pub const DEFAULT_PIDS_LIMIT: u32 = 4096;

/// The capabilities a job's container keeps; Docker's others, and
/// everything else, are dropped. A workflow job runs as its image's user,
/// root for most CI images, and these are what installing packages and
/// building need:
///
/// - `CHOWN`, `FOWNER`, `FSETID`, `DAC_OVERRIDE`: a package manager (apt,
///   npm as root) writing files it then hands to another owner, keeping
///   setgid bits, and root writing files it does not own.
/// - `SETUID`, `SETGID`: apt and others drop to their own user (`_apt`) to
///   download; with no new privileges, nothing can gain a user back.
/// - `KILL`: a step stopping processes another user started.
/// - `NET_BIND_SERVICE`: a test server on port 80 or 443.
///
/// Not kept, among others: `NET_RAW` (raw sockets, `ping`), `MKNOD`,
/// `SYS_CHROOT`, `SETFCAP`, `AUDIT_WRITE`, and every `SYS_*` and `NET_ADMIN`.
pub const JOB_CAPS: &[&str] = &["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "SETUID", "SETGID", "KILL", "NET_BIND_SERVICE"];

/// Agent work's image runs as `node` and uses `sudo` once, to put its
/// guardrails' policy where the agent cannot change it, and then removes
/// its own sudo (guard.rs). sudo needs a setuid program to work and
/// `AUDIT_WRITE` to log, so agent work keeps those and has no
/// `no-new-privileges`; it still has every other limit.
pub const AGENT_EXTRA_CAPS: &[&str] = &["AUDIT_WRITE"];

/// Work in progress.
pub struct Running {
    pub id: String,
    pub kind: String,
    pub name: String,
    child: Child,
    container: Option<String>,
    /// The job's network and work volume, removed after.
    network: Option<String>,
    volume: Option<String>,
    /// The job's own Docker Engine, when it may have one.
    engine: Option<JobEngine>,
    folder: Option<PathBuf>,
    /// Past its time limit and a grace for g1t to say so: stopped here.
    deadline: Instant,
}

#[cfg(unix)]
use super::engine::JobEngine;

/// No job has an engine of its own off Unix.
#[cfg(not(unix))]
pub struct JobEngine;

#[cfg(not(unix))]
impl JobEngine {
    fn remove(&self) {}
    fn job_args(&self) -> Vec<String> {
        Vec::new()
    }
}

/// `docker`, at the runner's own engine when it has one.
fn docker() -> Command {
    #[cfg(unix)]
    return super::engine::docker();
    #[cfg(not(unix))]
    Command::new("docker")
}

fn quietly(command: &mut Command) {
    let _ = command.stdout(Stdio::null()).stderr(Stdio::null()).status();
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
            quietly(docker().args(["kill", container]));
        }
        if let Some(engine) = &self.engine {
            quietly(docker().args(["kill", &engine.container]));
        }
        let pid = self.child.id().to_string();
        if cfg!(windows) {
            quietly(Command::new("taskkill").args(["/T", "/F", "/PID", &pid]));
        } else {
            // Its own process group (see `directly`): the steps' processes too.
            quietly(Command::new("kill").args(["-TERM", &format!("-{pid}")]));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    /// Removes what it left: its container, its engine and that engine's
    /// data, its network, its work volume, its folder.
    pub fn clean(&mut self) {
        if let Some(container) = &self.container {
            quietly(docker().args(["rm", "-f", "-v", container]));
        }
        if let Some(engine) = self.engine.take() {
            engine.remove();
        }
        if let Some(network) = &self.network {
            quietly(docker().args(["network", "rm", network]));
        }
        if let Some(volume) = &self.volume {
            quietly(docker().args(["volume", "rm", "-f", volume]));
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
pub fn start(config: &Config, isolation: Isolation, folder: &Path, work: &Assignment) -> Result<Running> {
    let env = harness_env(config, work)?;
    if isolation == Isolation::Host {
        refuse_public_on_host(work)?;
        return directly(config, work, env);
    }
    in_docker(config, isolation, folder, work, env)
}

/// Host mode does not take a public repository's work: anyone can propose
/// code to one, and here it would run on the machine itself.
fn refuse_public_on_host(work: &Assignment) -> Result<()> {
    match work.visibility.as_deref() {
        Some("public") => bail!("{}", sandbox::host_mode_refuses(&work.repo)),
        Some(_) => Ok(()),
        None => {
            log(&format!("g1t did not say whether {} is public (an older g1t), so it runs; host mode refuses public repositories' work once it does.", work.repo));
            Ok(())
        }
    }
}

/// Each job container's limits.
#[derive(Debug, Clone, PartialEq)]
pub struct Limits {
    pub memory: String,
    pub cpus: String,
    pub pids: u32,
}

/// Three quarters of `MemTotal` in `/proc/meminfo`, in MiB, which under
/// Sysbox is the runner container's own memory.
fn default_memory(meminfo: &str) -> Option<String> {
    let kb: u64 = meminfo.lines().find_map(|l| l.strip_prefix("MemTotal:"))?.trim().trim_end_matches("kB").trim().parse().ok()?;
    let mib = kb / 1024 * 3 / 4;
    (mib >= 256).then(|| format!("{mib}m"))
}

pub fn limits(config: &Config) -> Limits {
    let memory = config
        .memory
        .clone()
        .or_else(|| default_memory(&std::fs::read_to_string("/proc/meminfo").unwrap_or_default()))
        .unwrap_or_else(|| "4g".into());
    let cpus = config.cpus.clone().unwrap_or_else(|| std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2).to_string());
    Limits { memory, cpus, pids: config.pids_limit.unwrap_or(DEFAULT_PIDS_LIMIT) }
}

/// Everything a job's `docker run` is made from.
pub struct Plan<'a> {
    pub kind: &'a str,
    pub name: &'a str,
    pub runner: &'a str,
    pub image: &'a str,
    pub harness: &'a Path,
    pub network: &'a str,
    /// The job's work volume, for a workflow job's `/home/runner`.
    pub volume: Option<&'a str>,
    pub limits: &'a Limits,
    /// The names of the harness's variables, whose values come from the
    /// runner's process, never its command line.
    pub env_names: Vec<&'a str>,
    /// What the job's own engine adds (`JobEngine::job_args`).
    pub engine_args: Vec<String>,
}

/// The arguments of `docker` that start a job's container.
pub fn run_args(plan: &Plan) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    fn add(args: &mut Vec<String>, items: &[&str]) {
        args.extend(items.iter().map(|s| s.to_string()));
    }
    add(&mut args, &["run", "--rm", "--name", plan.name, "--label", &format!("sh.g1t.runner={}", plan.runner)]);
    add(&mut args, &["--pull", "missing", "--init"]);
    // The walls.
    add(&mut args, &["--cap-drop", "ALL"]);
    let mut caps: Vec<&str> = JOB_CAPS.to_vec();
    if plan.kind == "agent" {
        caps.extend(AGENT_EXTRA_CAPS);
    } else {
        add(&mut args, &["--security-opt", "no-new-privileges"]);
    }
    for cap in caps {
        add(&mut args, &["--cap-add", cap]);
    }
    let pids = plan.limits.pids.to_string();
    add(&mut args, &["--pids-limit", &pids, "--memory", &plan.limits.memory, "--memory-swap", &plan.limits.memory, "--cpus", &plan.limits.cpus]);
    add(&mut args, &["--network", plan.network, "--ipc", "private"]);
    // The job is in its `container:` image already: the harness inside
    // does not start it again (actions/containers.rs).
    add(&mut args, &["-e", "G1T_JOB_CONTAINER=1"]);
    for name in &plan.env_names {
        add(&mut args, &["-e", name]);
    }
    // Its only mounts: the harness, read-only, and its own volume.
    add(&mut args, &["-v", &format!("{}:/opt/g1t/g1t-runner:ro", plan.harness.display())]);
    if let Some(volume) = plan.volume {
        add(&mut args, &["-v", &format!("{volume}:/home/runner")]);
    }
    args.extend(plan.engine_args.iter().cloned());
    add(&mut args, &["--entrypoint", "/opt/g1t/g1t-runner", plan.image]);
    args
}

fn in_docker(config: &Config, isolation: Isolation, folder: &Path, work: &Assignment, env: BTreeMap<String, String>) -> Result<Running> {
    let image = match work.kind.as_str() {
        "agent" => match config.agent_image.clone().or_else(|| update::agent_image(config)) {
            Some(image) => image,
            None => bail!(
                "agent work needs an image with git, Node and the agent's CLI: register this runner with --agent-image IMAGE"
            ),
        },
        _ => work.image.clone().or_else(|| config.image.clone()).unwrap_or_else(|| DEFAULT_IMAGE.to_owned()),
    };
    #[cfg(unix)]
    if super::engine::in_use() {
        super::engine::ensure_running()?;
    }
    let harness = update::linux_harness(config, folder)?;
    let name = container_name(&work.id);
    // What an earlier run of this job may have left.
    quietly(docker().args(["rm", "-f", "-v", &name]));
    quietly(docker().args(["network", "rm", &name]));
    let output = docker()
        .args(["network", "create", "--label", &format!("sh.g1t.runner={}", config.runner), &name])
        .output()
        .context("could not run docker: is Docker installed and running?")?;
    if !output.status.success() {
        bail!("could not make the job's network: {}", String::from_utf8_lossy(&output.stderr).trim());
    }
    let volume = (work.kind == "workflow").then(|| format!("{name}-work"));
    if let Some(volume) = &volume {
        quietly(docker().args(["volume", "rm", "-f", volume]));
        quietly(docker().args(["volume", "create", "--label", &format!("sh.g1t.runner={}", config.runner), volume]));
    }
    // A job's own Docker, only inside the runner's own sandbox: on a
    // shared engine it would be the machine's.
    let engine: Option<JobEngine> = job_engine(config, isolation, &name);
    let limits = limits(config);
    let plan = Plan {
        kind: &work.kind,
        name: &name,
        runner: &config.runner,
        image: &image,
        harness: &harness,
        network: &name,
        volume: volume.as_deref(),
        limits: &limits,
        env_names: env.keys().map(String::as_str).collect(),
        engine_args: engine.as_ref().map(JobEngine::job_args).unwrap_or_default(),
    };
    let mut command = docker();
    command.args(run_args(&plan));
    command.envs(&env);
    log(&format!(
        "Running {} {} in {image}: its own container and network, capabilities dropped, {} memory, {} CPUs, {} processes{}",
        work.kind,
        work.name,
        limits.memory,
        limits.cpus,
        limits.pids,
        if engine.is_some() { ", Docker of its own when it uses it" } else { "" }
    ));
    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            if let Some(engine) = &engine {
                engine.remove();
            }
            quietly(docker().args(["network", "rm", &name]));
            return Err(error).context("could not run docker: is Docker installed and running?");
        }
    };
    Ok(Running {
        id: work.id.clone(),
        kind: work.kind.clone(),
        name: work.name.clone(),
        child,
        container: Some(name.clone()),
        network: Some(name),
        volume,
        engine,
        folder: None,
        deadline: deadline(work),
    })
}

#[cfg(unix)]
fn job_engine(config: &Config, isolation: Isolation, name: &str) -> Option<JobEngine> {
    if isolation != Isolation::NestedContainer || !config.job_docker {
        return None;
    }
    let image = config.job_docker_image.as_deref().unwrap_or(super::engine::DEFAULT_JOB_ENGINE_IMAGE);
    match JobEngine::prepare(name, &config.runner, image) {
        Ok(engine) => Some(engine),
        Err(error) => {
            log(&format!("This job has no Docker of its own: {error:#}"));
            None
        }
    }
}

#[cfg(not(unix))]
fn job_engine(_config: &Config, _isolation: Isolation, _name: &str) -> Option<JobEngine> {
    None
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
    // The job's log says it ran unsandboxed (actions/mod.rs).
    command.env(JOB_NOTICE, sandbox::HOST_MODE_IN_JOB);
    // A group of its own, so stopping it stops what its steps started.
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    log(&format!("Running {} {} on this machine, unsandboxed (host mode, deprecated)", work.kind, work.name));
    let child = command.spawn().context("could not start the job's process")?;
    Ok(Running {
        id: work.id.clone(),
        kind: work.kind.clone(),
        name: work.name.clone(),
        child,
        container: None,
        network: None,
        volume: None,
        engine: None,
        folder,
        deadline: deadline(work),
    })
}

/// A warning the harness puts at the top of the job's log.
pub const JOB_NOTICE: &str = "G1T_JOB_NOTICE";

fn deadline(work: &Assignment) -> Instant {
    Instant::now() + Duration::from_secs(u64::from(work.timeout_minutes.max(1)) * 60 + 10 * 60)
}

/// Whether Docker answers.
pub fn docker_ready() -> bool {
    docker()
        .args(["version", "--format", "{{.Server.Version}}"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// Removes what jobs of this runner's left behind, if it stopped while one ran.
pub fn sweep(config: &Config) {
    let label = format!("label=sh.g1t.runner={}", config.runner);
    for (list, remove) in [
        (vec!["ps", "-aq", "--filter", &label], vec!["rm", "-f", "-v"]),
        (vec!["network", "ls", "-q", "--filter", &label], vec!["network", "rm"]),
        (vec!["volume", "ls", "-q", "--filter", &label], vec!["volume", "rm", "-f"]),
    ] {
        let Ok(output) = docker().args(&list).output() else { return };
        let ids: Vec<String> = String::from_utf8_lossy(&output.stdout).split_whitespace().map(str::to_owned).collect();
        if !ids.is_empty() {
            quietly(docker().args(&remove).args(&ids));
        }
    }
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
            memory: None,
            cpus: None,
            pids_limit: None,
            job_docker: true,
            job_docker_image: None,
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

    fn args_for(kind: &str, engine_args: Vec<String>) -> (Vec<String>, BTreeMap<String, String>) {
        let config = config();
        let env = harness_env(&config, &assignment(kind)).unwrap();
        let limits = Limits { memory: "6144m".into(), cpus: "4".into(), pids: 4096 };
        let harness = PathBuf::from("/usr/local/bin/g1t-runner");
        let plan = Plan {
            kind,
            name: "g1t-job_1",
            runner: "rnr_1",
            image: DEFAULT_IMAGE,
            harness: &harness,
            network: "g1t-job_1",
            volume: (kind == "workflow").then_some("g1t-job_1-work"),
            limits: &limits,
            env_names: env.keys().map(String::as_str).collect(),
            engine_args,
        };
        (run_args(&plan), env.clone())
    }

    fn value_of<'a>(args: &'a [String], flag: &str) -> Vec<&'a str> {
        args.windows(2).filter(|w| w[0] == flag).map(|w| w[1].as_str()).collect()
    }

    #[test]
    fn a_jobs_container_is_walled_in() {
        let (args, _) = args_for("workflow", Vec::new());
        assert_eq!(args[0], "run");
        assert!(args.contains(&"--rm".to_owned()));
        assert_eq!(value_of(&args, "--cap-drop"), vec!["ALL"]);
        assert_eq!(value_of(&args, "--cap-add"), JOB_CAPS.to_vec());
        assert_eq!(value_of(&args, "--security-opt"), vec!["no-new-privileges"]);
        assert_eq!(value_of(&args, "--pids-limit"), vec!["4096"]);
        assert_eq!(value_of(&args, "--memory"), vec!["6144m"]);
        assert_eq!(value_of(&args, "--memory-swap"), vec!["6144m"]);
        assert_eq!(value_of(&args, "--cpus"), vec!["4"]);
        assert_eq!(value_of(&args, "--network"), vec!["g1t-job_1"]);
        for forbidden in ["--privileged", "--pid", "--userns", "--device", "host"] {
            assert!(!args.iter().any(|a| a == forbidden), "{forbidden} in {args:?}");
        }
        assert!(!JOB_CAPS.iter().any(|c| c.starts_with("SYS_") || *c == "NET_ADMIN" || *c == "NET_RAW"));
    }

    #[test]
    fn a_jobs_only_mounts_are_the_harness_and_its_own_volume() {
        let (args, _) = args_for("workflow", Vec::new());
        let mounts = value_of(&args, "-v");
        assert_eq!(mounts, vec!["/usr/local/bin/g1t-runner:/opt/g1t/g1t-runner:ro", "g1t-job_1-work:/home/runner"]);
        assert!(!args.iter().any(|a| a.contains("docker.sock")), "no engine socket: {args:?}");
        assert!(!args.iter().any(|a| a == "--mount"));
    }

    #[test]
    fn credentials_go_by_name_and_the_runners_never() {
        let (args, env) = args_for("workflow", Vec::new());
        let passed = value_of(&args, "-e");
        assert!(passed.contains(&"ACTIONS_TOKEN"));
        // Never a value on the command line, and never the runner's credential.
        assert!(!args.iter().any(|a| a.contains("jobtoken")));
        assert!(!args.iter().any(|a| a.contains("g1tr_")));
        assert!(env.values().all(|v| !v.contains("g1tr_secret")));
        assert!(!env.contains_key("G1T_RUNNER_TOKEN"));
    }

    #[test]
    fn agent_work_keeps_sudo_for_its_guardrails_and_every_other_wall() {
        let (args, _) = args_for("agent", Vec::new());
        assert!(value_of(&args, "--security-opt").is_empty());
        assert!(value_of(&args, "--cap-add").contains(&"AUDIT_WRITE"));
        assert_eq!(value_of(&args, "--cap-drop"), vec!["ALL"]);
        assert_eq!(value_of(&args, "-v"), vec!["/usr/local/bin/g1t-runner:/opt/g1t/g1t-runner:ro"]);
    }

    #[test]
    fn a_job_with_docker_gets_a_socket_of_its_own_not_the_runners() {
        let engine_args = vec!["-v".into(), "/run/g1t-runner/jobs/g1t-job_1/proxy:/run/g1t-docker:ro".into(), "-e".into(), "DOCKER_HOST=unix:///run/g1t-docker/docker.sock".into()];
        let (args, _) = args_for("workflow", engine_args);
        let mounts = value_of(&args, "-v");
        assert!(mounts.contains(&"/run/g1t-runner/jobs/g1t-job_1/proxy:/run/g1t-docker:ro"));
        assert!(!mounts.iter().any(|m| m.starts_with("/var/run/docker.sock") || m.starts_with("/run/g1t-runner/docker.sock")));
        // The entrypoint and image stay last.
        assert_eq!(&args[args.len() - 3..], ["--entrypoint", "/opt/g1t/g1t-runner", DEFAULT_IMAGE]);
    }

    #[test]
    fn limits_default_sensibly() {
        assert_eq!(default_memory("MemTotal:       16384000 kB\nMemFree: 1 kB\n"), Some("12000m".into()));
        assert_eq!(default_memory(""), None);
        let mut config = config();
        config.memory = Some("2g".into());
        config.pids_limit = Some(100);
        let limits = limits(&config);
        assert_eq!(limits.memory, "2g");
        assert_eq!(limits.pids, 100);
        assert!(limits.cpus.parse::<f64>().unwrap() >= 1.0);
    }

    #[test]
    fn host_mode_refuses_a_public_repositorys_work() {
        let mut work = assignment("workflow");
        work.visibility = Some("public".into());
        let refused = refuse_public_on_host(&work).unwrap_err().to_string();
        assert!(refused.contains("acme/web is public"), "{refused}");
        work.visibility = Some("private".into());
        assert!(refuse_public_on_host(&work).is_ok());
        work.visibility = None;
        assert!(refuse_public_on_host(&work).is_ok());
        // And refuses it before anything runs.
        work.visibility = Some("public".into());
        assert!(start(&config(), Isolation::Host, Path::new("/tmp"), &work).is_err());
    }
}
