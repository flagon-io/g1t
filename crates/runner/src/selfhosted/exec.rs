//! Running what g1t hands the runner: a workflow job, or g1t's own work (a
//! merge check or a state of the merge queue), with the same harness g1t's
//! sandboxes run (this program, in another mode).
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

use super::api::{Assignment, Capacity};
use super::config::Config;
use super::sandbox::{self, Isolation};
use super::{log, update};

/// The image workflow jobs run in when they name none: Debian with Node,
/// git and Python, as g1t's sandbox has.
pub const DEFAULT_IMAGE: &str = "node:24-bookworm";
/// g1t's runner image, for jobs asking for one of g1t's machines: what the
/// desktop app's sandbox passes, over the configuration's `hosted_image`.
pub const HOSTED_IMAGE_ENV: &str = "G1T_HOSTED_IMAGE";
/// Its size unpacked, as the sandbox's release says, for the words on
/// pulling it (hosted.rs).
pub const HOSTED_IMAGE_SIZE_ENV: &str = "G1T_HOSTED_IMAGE_SIZE";
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

/// The work kind g1t's own tasks come as: a merge check or a state of the
/// merge queue, with the environment g1t's sandbox would have had. Older
/// g1t sent agents' runs as this kind too; those are refused.
pub const TASK_KIND: &str = "agent";

/// The modes of g1t's own tasks this runner runs (main.rs).
pub const TASK_MODES: &[&str] = &["queue", "mergecheck", "checks"];

/// Work in progress.
pub struct Running {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub repo: String,
    child: Child,
    container: Option<String>,
    /// The job's network and work volume, removed after.
    network: Option<String>,
    volume: Option<String>,
    /// The job's own Docker Engine, when it may have one.
    engine: Option<JobEngine>,
    folder: Option<PathBuf>,
    /// The job's own VM, for a job native to this OS (native.rs); `child`
    /// is then `wsb exec`, whose output carries the job's exit code.
    native: Option<WsbJob>,
    /// How it ended, once read: a native job's code is read once from
    /// `wsb exec`'s output.
    exit: Option<i32>,
    /// Past its time limit and a grace for g1t to say so: stopped here.
    deadline: Instant,
}

use super::native::{self, WsbJob};

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
pub(super) fn docker() -> Command {
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
        if self.exit.is_some() {
            return self.exit;
        }
        self.exit = match self.child.try_wait() {
            Ok(Some(_)) if self.native.is_some() => {
                use std::io::Read;
                let mut text = String::new();
                if let Some(out) = self.child.stdout.as_mut() {
                    let _ = out.read_to_string(&mut text);
                }
                Some(native::parse_exit_code(&text).unwrap_or(1))
            }
            Ok(Some(status)) => Some(status.code().unwrap_or(1)),
            Ok(None) => None,
            Err(_) => Some(1),
        };
        self.exit
    }

    /// Stops it: the container, then the process and everything it started.
    pub fn stop(&mut self) {
        if let Some(container) = &self.container {
            quietly(docker().args(["kill", container]));
        }
        #[cfg(unix)]
        if let Some(engine) = &self.engine {
            quietly(docker().args(["kill", &engine.container]));
        }
        if let Some(job) = &self.native {
            job.stop();
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
        if let Some(job) = self.native.take() {
            job.clean();
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
            // That token is where this computer can see it (a Windows job's
            // script in the job's folder, a container's environment): the
            // harness spends it on fetching the job and works on with a new
            // one only it has.
            env.insert(crate::actions::ROTATE_TOKEN.into(), "1".into());
        }
        TASK_KIND => {
            for (name, value) in work.env.clone().unwrap_or_default() {
                let value = match value {
                    serde_json::Value::String(text) => text,
                    other => other.to_string(),
                };
                env.insert(name, value);
            }
            match env.get("MODE").map(String::as_str) {
                Some(mode) if TASK_MODES.contains(&mode) => {}
                Some(mode) => bail!("this runner does not run g1t work of mode {mode}"),
                None => bail!("this runner does not run agents' work"),
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
    match isolation {
        Isolation::Host => {
            refuse_public_on_host(work)?;
            directly(config, work, env)
        }
        Isolation::Vm => in_native_vm(config, folder, work, env),
        _ => in_docker(config, isolation, folder, work, env),
    }
}

/// A memory size as `--memory` takes it (`8g`, `4096m`), in MiB.
pub fn mib(text: &str) -> Option<u64> {
    let text = text.trim().to_ascii_lowercase();
    let (number, unit) = text.split_at(text.find(|c: char| !c.is_ascii_digit()).unwrap_or(text.len()));
    let number: u64 = number.parse().ok()?;
    match unit.trim_end_matches('b').trim_end_matches('i') {
        "" | "m" => Some(number),
        "g" => Some(number * 1024),
        "k" => Some(number / 1024),
        _ => None,
    }
}

/// A job native to this OS, in a throwaway VM of its own (native.rs):
/// Windows Sandbox on Windows. g1t's own work needs its Linux sandbox
/// layout and runs on a Linux runner.
fn in_native_vm(config: &Config, folder: &Path, work: &Assignment, env: BTreeMap<String, String>) -> Result<Running> {
    if work.kind != "workflow" {
        bail!("g1t's own work runs on Linux runners: this one runs jobs native to {}", std::env::consts::OS);
    }
    if !cfg!(windows) {
        bail!("this runner has no sandbox for jobs native to {}", std::env::consts::OS);
    }
    // A VM sets its memory; Windows Sandbox has no setting for its CPUs.
    let memory = work.size.as_ref().and_then(|size| size.memory_mib).or_else(|| config.memory.as_deref().and_then(mib)).unwrap_or(4096);
    let drop = folder.join("native").join(container_name(&work.id));
    let job = WsbJob::start(drop, &env, memory)?;
    let child = match job.exec().spawn() {
        Ok(child) => child,
        Err(error) => {
            job.clean();
            return Err(error).context("could not run wsb exec");
        }
    };
    log(&format!(
        "Running {} {} in a Windows Sandbox of its own ({memory} MiB): no folder of this machine's but its read-only harness, discarded after",
        work.kind, work.name
    ));
    Ok(Running {
        id: work.id.clone(),
        repo: work.repo.clone(),
        kind: work.kind.clone(),
        name: work.name.clone(),
        child,
        container: None,
        network: None,
        volume: None,
        engine: None,
        folder: None,
        native: Some(job),
        exit: None,
        deadline: deadline(work),
    })
}

/// ` as Standard`, for a job taken for one of g1t's machines' sizes.
fn sized_as(work: &Assignment) -> String {
    work.size.as_ref().and_then(|size| g1t_contracts::runners::size_named(&size.size)).map(|size| format!(" as {}", size.name)).unwrap_or_default()
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

/// A job's limits: the size it was taken for, when g1t gave it one of its
/// machines' jobs ([`Assignment::size`]), exactly; else the runner's own.
pub fn job_limits(config: &Config, work: &Assignment) -> Limits {
    let own = limits(config);
    match work.size.as_ref().and_then(|size| Some((size.cpus?, size.memory_mib?))) {
        Some((cpus, memory_mib)) => Limits { memory: format!("{memory_mib}m"), cpus: cpus.to_string(), ..own },
        None => own,
    }
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

/// What a job here gets, for g1t (`Capacity`): a job container's CPUs and
/// memory (`--cpus` and `--memory`, else what `limits` gives it), a VM's,
/// or the machine's for a job run on it directly; and whether the job can
/// use Docker: its own engine inside the runner's sandbox, or the
/// machine's in host mode. `memory` and `cpus` are the runner's options.
///
/// `hosted_image` is g1t's runner image, if this runner has one: a job
/// container runs jobs asking for g1t's machines in it, which is what g1t
/// gives them only to a runner that says so. Host mode and a VM have no
/// container to run it as.
pub fn capacity(memory: Option<&str>, cpus: Option<&str>, job_docker: bool, isolation: Isolation, hosted_image: Option<&str>) -> Capacity {
    let machine_cpus = std::thread::available_parallelism().map_or(1, |n| n.get()) as u32;
    let given_cpus = cpus.and_then(|c| c.trim().parse::<f64>().ok()).map(|c| c.floor() as u32).filter(|c| *c > 0);
    match isolation {
        Isolation::Host => Capacity { cpus: Some(machine_cpus), memory_mib: super::launcher::total_memory_mib(), docker: docker_ready(), hosted_image: false },
        Isolation::Vm => Capacity { cpus: Some(machine_cpus), memory_mib: Some(memory.and_then(mib).unwrap_or(4096)), docker: false, hosted_image: false },
        Isolation::NestedContainer | Isolation::Container => {
            let memory = memory
                .map(str::to_owned)
                .or_else(|| default_memory(&std::fs::read_to_string("/proc/meminfo").unwrap_or_default()))
                .unwrap_or_else(|| "4g".into());
            Capacity {
                cpus: Some(given_cpus.unwrap_or(machine_cpus)),
                memory_mib: mib(&memory),
                docker: isolation == Isolation::NestedContainer && job_docker && cfg!(unix),
                hosted_image: hosted_image.is_some(),
            }
        }
    }
}

/// Everything a job's `docker run` is made from.
pub struct Plan<'a> {
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
    add(&mut args, &["--security-opt", "no-new-privileges"]);
    for cap in JOB_CAPS {
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

/// g1t's runner image, when this runner has one: `G1T_HOSTED_IMAGE`, else
/// the configuration's.
pub fn hosted_image(config: &Config) -> Option<String> {
    let given = std::env::var(HOSTED_IMAGE_ENV).ok().or_else(|| config.hosted_image.clone());
    given.map(|image| image.trim().to_owned()).filter(|image| !image.is_empty())
}

/// The image a job runs in, and how the log says it: the job's own
/// `container:`; for a job that asked for one of g1t's machines, g1t's
/// runner image, which has what those machines have (in the runner's own,
/// such a job finds no Rust, Go or Python, flagon-io#458); else the
/// runner's image. g1t's own work needs only git, which the default has.
pub fn job_image(config: &Config, work: &Assignment, hosted: Option<String>) -> Result<(String, String)> {
    if let Some(image) = &work.image {
        return Ok((image.clone(), image.clone()));
    }
    if work.size.is_some() {
        let Some(image) = hosted else {
            bail!("this job asked for one of g1t's machines, and this runner has no g1t runner image to run it in: it should not have been given it");
        };
        return Ok((image.clone(), format!("g1t's machine image ({image})")));
    }
    let image = config.image.clone().unwrap_or_else(|| DEFAULT_IMAGE.to_owned());
    Ok((image.clone(), image))
}

fn in_docker(config: &Config, isolation: Isolation, folder: &Path, work: &Assignment, mut env: BTreeMap<String, String>) -> Result<Running> {
    let (image, image_said) = job_image(config, work, hosted_image(config))?;
    #[cfg(unix)]
    if super::engine::in_use() {
        super::engine::ensure_running()?;
    }
    // g1t's machine image is pulled before the runner takes such jobs
    // (hosted.rs); one removed since is pulled as the job starts, and "Set
    // up job" says why it waited.
    if work.image.is_none() && work.size.is_some() && !super::hosted::present(&image) {
        let size = super::hosted::size_from_env();
        log(&format!("{} for {}.", super::hosted::pulling_said(size), work.name));
        env.insert(JOB_NOTICE.to_owned(), super::hosted::pulled_in_job(size));
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
    let limits = job_limits(config, work);
    // A job given less memory than its size: one that runs out of it says
    // so as it ends, and g1t runs it again on its own machines.
    if work.size.as_ref().is_some_and(g1t_contracts::runners::OfferedSize::short_of_memory) {
        env.insert(crate::actions::MEMORY_SHORT_ENV.to_owned(), "1".to_owned());
    }
    let plan = Plan {
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
        "Running {} {}{} in {image_said}: its own container and network, capabilities dropped, {} memory, {} CPUs, {} processes{}",
        work.kind,
        work.name,
        sized_as(work),
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
        repo: work.repo.clone(),
        kind: work.kind.clone(),
        name: work.name.clone(),
        child,
        container: Some(name.clone()),
        network: Some(name),
        volume,
        engine,
        folder: None,
        native: None,
        exit: None,
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
        // g1t's own work expects its sandbox layout (/work), which only a
        // Linux machine (or a container) set aside for it has.
        bail!("g1t's own work runs in Docker, or directly on Linux where /work can be written; this runner can do neither");
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
        repo: work.repo.clone(),
        kind: work.kind.clone(),
        name: work.name.clone(),
        child,
        container: None,
        network: None,
        volume: None,
        engine: None,
        folder,
        native: None,
        exit: None,
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
            harness: None,
            auto_update: false,
            memory: None,
            cpus: None,
            pids_limit: None,
            job_docker: true,
            job_docker_image: None,
            native: false,
            sizes: None,
            sizes_picked: false,
            hosted_image: None,
        }
    }

    fn assignment(kind: &str) -> Assignment {
        serde_json::from_value(json!({
            "kind": kind, "id": "job_1", "name": "build", "repo": "acme/web", "timeout_minutes": 60,
            "token": "jobtoken", "env": { "MODE": "queue", "G1T_TOKEN": "g1t_run", "G1T_API": "https://elsewhere" }
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
        // That token is spent on fetching the job.
        assert_eq!(env[crate::actions::ROTATE_TOKEN], "1");
        assert!(!harness_env(&config(), &assignment("agent")).unwrap().contains_key(crate::actions::ROTATE_TOKEN));
    }

    #[test]
    fn g1ts_own_work_gets_the_sandboxs_environment_and_this_api() {
        let env = harness_env(&config(), &assignment(TASK_KIND)).unwrap();
        assert_eq!(env["MODE"], "queue");
        assert_eq!(env["G1T_TOKEN"], "g1t_run");
        assert_eq!(env["G1T_API"], "https://api.g1t.sh");
        assert_eq!(env["G1T_ABUSE"], "off");
    }

    #[test]
    fn unknown_work_is_refused() {
        assert!(harness_env(&config(), &assignment("deploy")).is_err());
    }

    #[test]
    fn an_agents_run_from_an_older_g1t_is_refused_before_it_starts() {
        for env in [json!({ "MODE": "revise", "G1T_TOKEN": "g1t_run" }), json!({ "PROMPT": "Fix it", "G1T_TOKEN": "g1t_run" })] {
            let mut work = assignment(TASK_KIND);
            work.env = serde_json::from_value(env).unwrap();
            assert!(harness_env(&config(), &work).is_err());
            assert!(start(&config(), Isolation::Host, Path::new("/tmp"), &work).is_err());
        }
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
    fn g1ts_own_work_has_every_wall_a_job_has() {
        let (args, _) = args_for(TASK_KIND, Vec::new());
        assert_eq!(value_of(&args, "--security-opt"), vec!["no-new-privileges"]);
        assert_eq!(value_of(&args, "--cap-add"), JOB_CAPS.to_vec());
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
        // What g1t is told a job gets: the limits a job container is given.
        let given = capacity(Some("12g"), Some("6.5"), true, Isolation::NestedContainer, None);
        assert_eq!((given.cpus, given.memory_mib), (Some(6), Some(12 * 1024)));
        assert_eq!(given.docker, cfg!(unix), "a job's own engine, inside the runner's sandbox");
        let shared = capacity(Some("8192m"), None, true, Isolation::Container, None);
        assert_eq!(shared.memory_mib, Some(8192));
        assert!(!shared.docker, "never the machine's engine");
        assert!(shared.cpus.is_some_and(|n| n >= 1));
        let vm = capacity(None, None, true, Isolation::Vm, Some("img"));
        assert_eq!((vm.memory_mib, vm.docker, vm.hosted_image), (Some(4096), false, false));
        assert!(!given.hosted_image, "no image of g1t's machines, no jobs asking for them");
        assert!(capacity(None, None, true, Isolation::NestedContainer, Some("img")).hosted_image);
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
    fn a_job_taken_for_a_size_gets_exactly_that_size() {
        let mut config = config();
        config.memory = Some("2g".into());
        let mut work = assignment("workflow");
        assert_eq!(job_limits(&config, &work).memory, "2g", "a job that asked for self-hosted keeps the runner's limits");
        work.size = g1t_contracts::runners::OfferedSize::of("2-core").assigned();
        let limits = job_limits(&config, &work);
        assert_eq!((limits.cpus.as_str(), limits.memory.as_str()), ("2", "8192m"));
        assert_eq!(sized_as(&work), " as Standard");
        work.size = Some(g1t_contracts::runners::OfferedSize { size: "2-core".into(), cpus: Some(4.0), memory_mib: Some(16384) });
        let limits = job_limits(&config, &work);
        assert_eq!((limits.cpus.as_str(), limits.memory.as_str()), ("4", "16384m"));
    }

    #[test]
    fn a_job_asking_for_g1ts_machines_runs_in_g1ts_runner_image() {
        let mut config = config();
        config.image = Some("node:24-bookworm-slim".into());
        let mut work = assignment("workflow");
        let hosted = Some("g1t.sh/flagon-io/g1t-runner-hosted@sha256:ab".to_owned());
        assert_eq!(job_image(&config, &work, hosted.clone()).unwrap().0, "node:24-bookworm-slim", "a self-hosted job keeps the runner's image");
        work.size = g1t_contracts::runners::OfferedSize::of("2-core").assigned();
        let (image, said) = job_image(&config, &work, hosted.clone()).unwrap();
        assert_eq!(image, "g1t.sh/flagon-io/g1t-runner-hosted@sha256:ab");
        assert!(said.starts_with("g1t's machine image"));
        assert!(job_image(&config, &work, None).unwrap_err().to_string().contains("no g1t runner image"));
        work.image = Some("rust:1".into());
        assert_eq!(job_image(&config, &work, hosted).unwrap().0, "rust:1", "its own container: first");
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
