//! `g1t-runner` on your own machine: a self-hosted runner for g1t.
//!
//! ```text
//! g1t-runner register --url https://g1t.sh --token g1trt_… [--name build-01]
//!     [--labels gpu,cuda] [--group Default] [--ephemeral] [--work-dir DIR]
//!     [--no-docker] [--image IMAGE] [--replace]
//!     [--memory 8g] [--cpus 4] [--pids-limit 4096] [--no-job-docker]
//! g1t-runner run [--once]
//! g1t-runner service install|start|stop|status|uninstall
//! g1t-runner remove
//! g1t-runner update
//! g1t-runner version
//! ```
//!
//! It only ever calls out, to `api.g1t.sh` over HTTPS: it polls for work
//! (a poll waits up to 20 seconds for some, and is the runner's heartbeat),
//! runs what it is given with the same harness g1t's sandboxes run (this
//! program in another mode, see `exec`), and says how it ended. Nothing
//! listens on the machine. Every command takes `--dir` (default
//! `~/.g1t-runner`, or `G1T_RUNNER_DIR`), where its configuration is kept.
//!
//! How it keeps jobs from the machine is `sandbox`: in its image under
//! Sysbox (`G1T_RUNNER_SANDBOX=nested`) it runs its own Docker Engine
//! (`engine`) and refuses to start if it can reach the machine's.

mod api;
mod config;
#[cfg(unix)]
mod engine;
mod exec;
mod launcher;
mod native;
mod needs;
mod private;
mod sandbox;
mod service;
mod update;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use serde_json::json;

use api::{Api, Failure};
use config::Config;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Set to stop the loop between polls: a Windows service's stop request.
pub static STOP: AtomicBool = AtomicBool::new(false);

/// How long a busy runner waits between heartbeats.
const HEARTBEAT: Duration = Duration::from_secs(10);
/// How long an idle poll waits for work.
const IDLE_WAIT_MS: u64 = 20_000;
/// How often an idle runner checks for a new version.
const UPDATE_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

const COMMANDS: &[&str] = &["register", "register-and-run", "run", "service", "sandbox", "remove", "update", "version", "--version", "help", "--help", "-h"];

/// Whether `args` (without the program) are a command of this one, rather
/// than the harness's `MODE`.
pub fn is_command(args: &[String]) -> bool {
    args.first().is_some_and(|first| COMMANDS.contains(&first.as_str()))
}

pub fn log(message: &str) {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    println!("{} {message}", g1t_now(now));
}

/// RFC 3339 for the log, without pulling in a date library.
fn g1t_now(ms: u64) -> String {
    let seconds = ms / 1000;
    let (days, rest) = (seconds / 86_400, seconds % 86_400);
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", rest / 3600, rest % 3600 / 60, rest % 60)
}

/// `--name value` and `--flag` options.
struct Options {
    values: Vec<(String, String)>,
    flags: Vec<String>,
    rest: Vec<String>,
}

impl Options {
    fn parse(args: &[String], takes_value: &[&str]) -> Result<Options> {
        let mut options = Options { values: Vec::new(), flags: Vec::new(), rest: Vec::new() };
        let mut i = 0;
        while i < args.len() {
            let arg = &args[i];
            if let Some(name) = arg.strip_prefix("--") {
                if let Some((name, value)) = name.split_once('=') {
                    options.values.push((name.to_owned(), value.to_owned()));
                } else if takes_value.contains(&name) {
                    let Some(value) = args.get(i + 1) else { bail!("--{name} needs a value") };
                    options.values.push((name.to_owned(), value.clone()));
                    i += 1;
                } else {
                    options.flags.push(name.to_owned());
                }
            } else {
                options.rest.push(arg.clone());
            }
            i += 1;
        }
        Ok(options)
    }

    fn value(&self, name: &str) -> Option<&str> {
        self.values.iter().rev().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
    }

    fn flag(&self, name: &str) -> bool {
        self.flags.iter().any(|f| f == name)
    }

    /// For `register-and-run` in a container: each option may come from
    /// `G1T_RUNNER_<NAME>` instead (`G1T_RUNNER_TOKEN`, `G1T_RUNNER_LABELS`,
    /// `G1T_RUNNER_EPHEMERAL=1`), so a Kubernetes secret can hold the token.
    fn with_environment(mut self) -> Options {
        let env_name = |name: &str| format!("G1T_RUNNER_{}", name.to_ascii_uppercase().replace('-', "_"));
        for name in VALUE_OPTIONS {
            if self.value(name).is_none()
                && let Ok(value) = std::env::var(env_name(name))
                && !value.is_empty()
            {
                self.values.push((name.to_owned(), value));
            }
        }
        for name in ["ephemeral", "no-docker", "replace", "no-auto-update", "no-job-docker", "native"] {
            if !self.flag(name) && std::env::var(env_name(name)).is_ok_and(|v| matches!(v.as_str(), "1" | "true" | "yes")) {
                self.flags.push(name.to_owned());
            }
        }
        self
    }
}

/// The options that take a value.
const VALUE_OPTIONS: [&str; 14] =
    ["url", "api", "token", "name", "labels", "group", "work-dir", "image", "harness", "memory", "cpus", "pids-limit", "job-docker-image", "machine"];

const HELP: &str = "g1t-runner: a self-hosted runner for g1t.

  g1t-runner register --url https://g1t.sh --token <registration token>
      [--name NAME] [--labels a,b] [--group GROUP] [--ephemeral]
      [--work-dir DIR] [--no-docker] [--image IMAGE]
      [--api URL] [--harness PATH] [--replace] [--no-auto-update]
      [--memory 8g] [--cpus 4] [--pids-limit 4096] [--no-job-docker]
      [--job-docker-image IMAGE] [--native]
  g1t-runner run [--once]          poll for work and run it
  g1t-runner sandbox up|down|status|update [--json]
                                   on your own computer: a Linux VM of the
                                   runner's own for Linux jobs, and Windows
                                   Sandbox for Windows jobs; see
                                   `g1t-runner sandbox help`
  g1t-runner register-and-run ...  both, for containers; options may be
                                   G1T_RUNNER_URL, _TOKEN, _LABELS, _EPHEMERAL…
  g1t-runner service install|start|stop|status|uninstall
  g1t-runner remove                unregister this runner
  g1t-runner update                update to the newest release
  g1t-runner version

In a workflow step (the g1t/deploy and g1t/detect actions use these):
  g1t-runner deploy                build this checkout and put it on g1t.page
  g1t-runner detect [--root-dir DIR]  what that build would find

Every command takes --dir DIR (default ~/.g1t-runner, or G1T_RUNNER_DIR).
Run it as a container under Sysbox so neither it nor its jobs reach the
machine: docker run --runtime=sysbox-runc … g1t.sh/flagon-io/g1t-runner,
or on a desktop, g1t-runner sandbox up. --native runs jobs native to this
OS, each in a throwaway VM (Windows Sandbox). --no-docker (host mode) is
deprecated.
Make a registration token under Settings, Runners on g1t.sh.
Docs: https://docs.g1t.sh/guides/self-hosted-runners/";

/// Runs a command. Returns the process's exit code.
pub fn main(args: Vec<String>) -> i32 {
    // Options of its own, and output the desktop app reads.
    if args[0] == "sandbox" {
        return launcher::main(&args[1..]);
    }
    let mut takes = VALUE_OPTIONS.to_vec();
    takes.push("dir");
    let options = match Options::parse(&args[1..], &takes) {
        Ok(options) => options,
        Err(error) => {
            eprintln!("g1t-runner: {error:#}");
            return 2;
        }
    };
    let folder = config::folder(options.value("dir"));
    let outcome = match args[0].as_str() {
        "register" => register(&options, &folder),
        // A container's one command: register unless it already is, then run.
        "register-and-run" => {
            let options = options.with_environment();
            let ready = if config::load(&folder).is_ok() { Ok(()) } else { register(&options, &folder) };
            ready.and_then(|()| run(&folder, options.flag("once")))
        }
        "run" => run(&folder, options.flag("once")),
        "service" => match options.rest.first().map(String::as_str) {
            Some(action) => config::load(&folder).and_then(|config| service::main(action, &config, &folder)),
            None => Err(anyhow::anyhow!("service takes install, uninstall, start, stop or status")),
        },
        "remove" => remove(&folder),
        "update" => config::load(&folder).and_then(|config| match update::update(&config)? {
            Some(version) => {
                log(&format!("Updated to {version}. Restart the runner (or its service) to use it."));
                Ok(())
            }
            None => {
                log(&format!("{VERSION} is the newest release."));
                Ok(())
            }
        }),
        "version" | "--version" => {
            println!("g1t-runner {VERSION} ({})", update::platform());
            Ok(())
        }
        _ => {
            println!("{HELP}");
            Ok(())
        }
    };
    match outcome {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("g1t-runner: {error:#}");
            1
        }
    }
}

fn hostname() -> String {
    for name in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(value) = std::env::var(name).map(|v| v.trim().to_owned())
            && !value.is_empty()
        {
            return value;
        }
    }
    std::process::Command::new("hostname")
        .output()
        .ok()
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "runner".to_owned())
}

/// Which computer this is, for g1t to know it when it registers again (its
/// sandbox made again, its state lost) and let it take its runners' names
/// back: a hash of the operating system's machine id, never the id itself.
/// None in a container, whose machine id is its image's and so shared by
/// every container made from it (the sandbox's launcher passes the
/// computer's as `G1T_RUNNER_MACHINE`), and where the OS has none.
pub fn machine_fingerprint() -> Option<String> {
    use sha2::{Digest, Sha256};
    let id = os_machine_id()?;
    Some(hex::encode(Sha256::digest(format!("g1t-runner machine\n{id}"))))
}

fn os_machine_id() -> Option<String> {
    let id = if cfg!(windows) {
        // HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid, set when Windows is installed.
        let out = hidden(std::process::Command::new("reg").args(["query", r"HKLM\SOFTWARE\Microsoft\Cryptography", "/v", "MachineGuid"])).output().ok()?;
        String::from_utf8_lossy(&out.stdout).lines().find(|l| l.contains("MachineGuid"))?.split_whitespace().last()?.to_owned()
    } else if cfg!(target_os = "macos") {
        let out = std::process::Command::new("ioreg").args(["-rd1", "-c", "IOPlatformExpertDevice"]).output().ok()?;
        let text = String::from_utf8_lossy(&out.stdout).into_owned();
        text.lines().find(|l| l.contains("\"IOPlatformUUID\""))?.rsplit('"').nth(1)?.to_owned()
    } else {
        if Path::new("/.dockerenv").exists() || Path::new("/run/.containerenv").exists() {
            return None;
        }
        ["/etc/machine-id", "/var/lib/dbus/machine-id"].iter().find_map(|path| std::fs::read_to_string(path).ok())?
    };
    let id = id.trim().to_ascii_lowercase();
    (id.len() >= 8 && id.chars().any(|c| c != '0' && c != '-')).then_some(id)
}

/// No console window for a helper the runner runs on Windows.
fn hidden(command: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// A runner's name from a machine's: what g1t accepts.
fn runner_name(given: &str) -> String {
    let name: String = given
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '-' })
        .take(64)
        .collect();
    if name.is_empty() { "runner".into() } else { name }
}

fn register(options: &Options, folder: &Path) -> Result<()> {
    let Some(url) = options.value("url") else { bail!("--url is needed: the g1t you register with, such as https://g1t.sh") };
    let Some(token) = options.value("token") else { bail!("--token is needed: make a registration token under Settings, Runners") };
    let url = url.trim_end_matches('/').to_owned();
    let api = options.value("api").map(|a| a.trim_end_matches('/').to_owned()).unwrap_or_else(|| config::api_for(&url));
    let name = runner_name(options.value("name").map(str::to_owned).unwrap_or_else(hostname).as_str());
    let labels: Vec<String> = options
        .value("labels")
        .unwrap_or_default()
        .split(',')
        .map(|l| l.trim().to_owned())
        .filter(|l| !l.is_empty())
        .collect();
    let native = options.flag("native");
    if native && options.flag("no-docker") {
        bail!("--native runs each job in a VM of its own, and --no-docker runs it on this machine: pick one");
    }
    let docker = !options.flag("no-docker") && !native;
    let isolation = isolation(docker, native)?;
    if isolation == sandbox::Isolation::Host {
        log(sandbox::HOST_MODE_AT_START);
    } else if !native && !sandbox::nested_requested() && !exec::docker_ready() {
        log("Docker does not answer here. Jobs will fail until it does.");
    }
    let pids_limit = match options.value("pids-limit") {
        Some(text) => Some(text.parse::<u32>().ok().filter(|n| *n > 0).with_context(|| format!("--pids-limit takes a number of processes, not {text}"))?),
        None => None,
    };
    let existing = config::load(folder).ok();
    if existing.is_some() && !options.flag("replace") {
        bail!("{} already holds a registered runner: run `g1t-runner remove` first, or register with --replace or another --dir", folder.display());
    }
    // The OS jobs run on: in Docker that is Linux, whatever the machine
    // (Docker Desktop runs Linux containers on macOS and Windows). A
    // runner says it runs jobs native to this OS only when it sandboxes
    // them (--native), or when the person chose host mode (--no-docker).
    let os = match std::env::consts::OS {
        _ if docker => "linux",
        "macos" => "macos",
        "windows" => "windows",
        _ => "linux",
    };
    let arch = if std::env::consts::ARCH == "aarch64" { "arm64" } else { "x64" };
    let mut body = json!({
        "token": token,
        "name": name,
        "labels": labels,
        "os": os,
        "arch": arch,
        "version": VERSION,
        "ephemeral": options.flag("ephemeral"),
        "group": options.value("group"),
        "replace": options.flag("replace"),
        "isolation": isolation.as_str(),
        "machine": options.value("machine").map(str::to_owned).or_else(machine_fingerprint),
    });
    exec::capacity(options.value("memory"), options.value("cpus"), !options.flag("no-job-docker"), isolation).add_to(&mut body);
    let registered = Api::register(&api, &body)?;
    let work_dir = options.value("work-dir").map(PathBuf::from).unwrap_or_else(|| folder.join("work"));
    let config = Config {
        url,
        api,
        runner: registered.runner.id.clone(),
        name: registered.runner.name.clone(),
        credential: registered.credential,
        workspace: registered.runner.workspace.clone(),
        repo: registered.runner.repo.clone(),
        group: registered.runner.group.clone(),
        labels: registered.runner.labels.clone(),
        ephemeral: options.flag("ephemeral"),
        work_dir,
        docker,
        image: options.value("image").map(str::to_owned),
        harness: options.value("harness").map(PathBuf::from),
        auto_update: !options.flag("no-auto-update"),
        memory: options.value("memory").map(str::to_owned),
        cpus: options.value("cpus").map(str::to_owned),
        pids_limit,
        job_docker: !options.flag("no-job-docker"),
        job_docker_image: options.value("job-docker-image").map(str::to_owned),
        native,
    };
    config::save(folder, &config)?;
    let place = match &config.repo {
        Some(repo) => format!("for {repo}"),
        None => format!("in {}{}", config.workspace, config.group.as_ref().map(|g| format!(", group {g}")).unwrap_or_default()),
    };
    log(&format!("Registered {} {place}, with labels {}.", config.name, config.labels.join(", ")));
    log("Start it with `g1t-runner run`, or `g1t-runner service install` to keep it running.");
    Ok(())
}

/// How this runner keeps work from its machine; refuses a nested runner
/// that can reach the machine (sandbox.rs).
fn isolation(docker: bool, native: bool) -> Result<sandbox::Isolation> {
    use sandbox::{Isolation, SandboxDriver};
    if native {
        let Some(driver) = sandbox::native_driver() else {
            bail!("--native: there is no sandbox for jobs native to {}; Linux jobs run in containers", std::env::consts::OS);
        };
        return driver.preflight().with_context(|| format!("--native needs {}", driver.name()));
    }
    if !docker {
        // What would sandbox jobs native to this OS instead.
        if let Some(driver) = sandbox::native_driver() {
            match driver.preflight() {
                Ok(_) => log(&format!("This machine can run {} jobs sandboxed, each in {}: register with --native instead of --no-docker.", std::env::consts::OS, driver.name())),
                Err(why) => log(&format!("Sandboxed {} jobs, in {}: {why:#}", std::env::consts::OS, driver.name())),
            }
        }
        return Ok(Isolation::Host);
    }
    if !sandbox::nested_requested() {
        return sandbox::SharedDocker.preflight();
    }
    if !cfg!(target_os = "linux") {
        bail!("{}=nested is for the runner's Linux image", sandbox::SANDBOX_ENV);
    }
    let isolation = sandbox::NestedDocker { allow_unsafe: sandbox::unsafe_allowed() }.preflight()?;
    if isolation != Isolation::NestedContainer {
        for problem in sandbox::Findings::read().problems() {
            log(&format!("UNSAFE: {problem}"));
        }
        log(&format!("UNSAFE: {}=1 is set, so the runner starts anyway, and its jobs can reach this machine.", sandbox::UNSAFE_ENV));
    }
    Ok(isolation)
}

/// A nested runner's own Docker Engine, which it uses whatever else it
/// can see (with the override, it starts despite that).
fn prepare(docker: bool) -> Result<()> {
    if !docker || !sandbox::nested_requested() {
        return Ok(());
    }
    #[cfg(unix)]
    {
        let version = engine::start()?;
        log(&format!("Started this runner's own Docker Engine {version}, inside its container."));
    }
    Ok(())
}

fn remove(folder: &Path) -> Result<()> {
    let config = config::load(folder)?;
    let api = Api { base: config.api.clone(), runner: config.runner.clone(), credential: config.credential.clone() };
    match api.remove() {
        Ok(()) | Err(Failure::Refused(401, _)) | Err(Failure::Refused(404, _)) => {}
        Err(failure) => bail!("{failure}; the runner is still registered"),
    }
    config::forget(folder);
    log(&format!("Removed {}.", config.name));
    Ok(())
}

/// The loop, for a Windows service: its exit code.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn serve_from_service() -> i32 {
    let folder = config::folder(None);
    let folder = std::env::args()
        .collect::<Vec<_>>()
        .windows(2)
        .find(|pair| pair[0] == "--dir")
        .map(|pair| PathBuf::from(&pair[1]))
        .unwrap_or(folder);
    match run(&folder, false) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("g1t-runner: {error:#}");
            1
        }
    }
}

/// Sleeps up to `duration`, waking early when `stop` says so.
fn nap(duration: Duration, mut stop: impl FnMut() -> bool) {
    let until = Instant::now() + duration;
    while Instant::now() < until {
        if STOP.load(Ordering::SeqCst) || stop() {
            return;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

fn run(folder: &Path, once: bool) -> Result<()> {
    // Its folder holds its credential and, while a Windows job runs, that
    // job's script: a runner whose folder others can read does not start.
    let mut config = config::load(folder)?;
    private::folder(folder, "--dir")?;
    let mut api = Api { base: config.api.clone(), runner: config.runner.clone(), credential: config.credential.clone() };
    std::fs::create_dir_all(&config.work_dir).with_context(|| format!("could not make {}", config.work_dir.display()))?;
    let isolation = isolation(config.docker, config.native)?;
    prepare(config.docker)?;
    match isolation {
        sandbox::Isolation::Host => {}
        sandbox::Isolation::Vm => native::sweep(folder),
        _ => exec::sweep(&config),
    }
    // A drain or stop asked for before this start is done with.
    let _ = std::fs::remove_file(drain_path(folder));
    let _ = std::fs::remove_file(folder.join("stop"));
    log(&format!(
        "g1t-runner {VERSION}: {} ({}) is listening for work from {}. Isolation: {}.",
        config.name,
        config.labels.join(", "),
        config.url,
        isolation.describe()
    ));
    if isolation == sandbox::Isolation::Host {
        log(sandbox::HOST_MODE_AT_START);
    }
    // What a job here gets, told to g1t with each poll: asked once, as
    // whether Docker answers takes a moment.
    let capacity = exec::capacity(config.memory.as_deref(), config.cpus.as_deref(), config.job_docker, isolation);
    let mut current: Option<exec::Running> = None;
    let mut ran_one = false;
    let mut backoff = Duration::from_secs(2);
    let mut last_update_check = Instant::now().checked_sub(UPDATE_EVERY).unwrap_or_else(Instant::now);
    let mut said_no_key = false;
    loop {
        // Asked to stop now (`g1t-runner sandbox down`): as a service's stop.
        if std::fs::remove_file(folder.join("stop")).is_ok() {
            STOP.store(true, Ordering::SeqCst);
        }
        if STOP.load(Ordering::SeqCst) {
            if let Some(mut running) = current.take() {
                log(&format!("Stopping: {} is cut short.", running.name));
                running.stop();
                let _ = api.finished(&running.id, 1, Some("The self-hosted runner was stopped."));
                running.clean();
            }
            say_status(folder, isolation, None, "stopped");
            return Ok(());
        }
        // What was running has ended: say how.
        if let Some(running) = current.as_mut()
            && let Some(code) = running.ended()
        {
            let mut running = current.take().expect("checked above");
            log(&format!("{} {} ended ({code}).", running.kind, running.name));
            if let Err(failure) = api.finished(&running.id, code, None) {
                log(&format!("Could not say how it ended: {failure}"));
            }
            running.clean();
            ran_one = true;
            if config.ephemeral || once {
                if config.ephemeral {
                    let _ = api.remove();
                    config::forget(folder);
                    log("The ephemeral runner ran its job and removed itself.");
                }
                return Ok(());
            }
        }
        // Asked to drain (`g1t-runner sandbox update`, before it swaps the
        // sandbox's image): no new work, and once idle, stop.
        let draining = drain_path(folder).exists();
        if draining && current.is_none() {
            let _ = std::fs::remove_file(drain_path(folder));
            say_status(folder, isolation, None, "stopped");
            log("Drained: no job is running, so the runner stops here.");
            return Ok(());
        }
        let state = match (&current, draining) {
            (Some(_), true) => "draining",
            (Some(_), false) => "busy",
            (None, _) => "idle",
        };
        say_status(folder, isolation, current.as_ref(), state);
        // Idle: a newer release, now and then.
        if current.is_none() && config.auto_update && last_update_check.elapsed() >= UPDATE_EVERY {
            last_update_check = Instant::now();
            if update::can_update() {
                match update::update(&config) {
                    Ok(Some(version)) => {
                        log(&format!("Updated to {version}; starting it."));
                        return restart();
                    }
                    Ok(None) => {}
                    Err(error) => log(&format!("Could not check for a new version: {error:#}")),
                }
            } else if !said_no_key {
                said_no_key = true;
                log("This build cannot check releases, so it will not update itself.");
            }
        }
        let running: Vec<String> = current.iter().map(|r| r.id.clone()).collect();
        let wait = if current.is_some() { 0 } else { IDLE_WAIT_MS };
        let poll = match api.poll(&running, wait, isolation.as_str(), &capacity) {
            Ok(poll) => {
                backoff = Duration::from_secs(2);
                poll
            }
            Err(Failure::Refused(401, message)) => {
                if let Some(mut running) = current.take() {
                    running.stop();
                    running.clean();
                }
                bail!("g1t no longer knows this runner ({message}). Register it again.");
            }
            Err(failure) => {
                log(&format!("{failure}; trying again in {}s", backoff.as_secs()));
                nap(backoff, || false);
                backoff = (backoff * 2).min(Duration::from_secs(60));
                continue;
            }
        };
        if let Some(fresh) = poll.credential {
            config.credential = fresh.clone();
            api.credential = fresh;
            config::save(folder, &config)?;
        }
        if poll.removed {
            config::forget(folder);
            log("This runner was removed from g1t; stopping.");
            return Ok(());
        }
        if let Some(running) = current.as_mut()
            && poll.cancel.contains(&running.id)
        {
            log(&format!("{} was cancelled; stopping it.", running.name));
            running.stop();
        }
        if let Some(running) = current.as_mut()
            && running.overdue()
        {
            log(&format!("{} ran past its time limit; stopping it.", running.name));
            running.stop();
        }
        if let Some(work) = poll.assignment {
            log(&format!("Took {} {} ({}).", work.kind, work.name, work.repo));
            match exec::start(&config, isolation, folder, &work) {
                Ok(running) => current = Some(running),
                Err(error) => {
                    log(&format!("Could not start it: {error:#}"));
                    let _ = api.finished(&work.id, 1, Some(&format!("The self-hosted runner {} could not start it: {error:#}", config.name)));
                    if config.ephemeral || once {
                        return Ok(());
                    }
                }
            }
            continue;
        }
        if once && ran_one {
            return Ok(());
        }
        // Busy: a heartbeat every few seconds until it ends.
        if current.is_some() {
            let mut check = || current.as_mut().is_some_and(|r| r.ended().is_some());
            nap(HEARTBEAT, &mut check);
        }
    }
}

/// The file whose presence asks a runner to drain: take no new work, and
/// stop once idle.
pub fn drain_path(folder: &Path) -> PathBuf {
    folder.join("drain")
}

/// The file a runner keeps saying what it is doing, for `g1t-runner
/// sandbox status` (which reads it from inside the sandbox).
pub fn status_path(folder: &Path) -> PathBuf {
    folder.join("status.json")
}

/// What a runner says it is doing, in its status file.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct RunnerStatus {
    pub version: String,
    pub isolation: String,
    /// `idle`, `busy`, `draining` or `stopped`.
    pub state: String,
    pub job: Option<JobStatus>,
    pub updated_at: String,
}

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct JobStatus {
    /// `workflow`, or `agent` for g1t's own work (a merge check or a
    /// state of the merge queue).
    pub kind: String,
    pub id: String,
    pub name: String,
    pub repo: String,
}

fn say_status(folder: &Path, isolation: sandbox::Isolation, running: Option<&exec::Running>, state: &str) {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let status = RunnerStatus {
        version: VERSION.to_owned(),
        isolation: isolation.as_str().to_owned(),
        state: state.to_owned(),
        job: running.map(|r| JobStatus { kind: r.kind.clone(), id: r.id.clone(), name: r.name.clone(), repo: r.repo.clone() }),
        updated_at: g1t_now(now),
    };
    let temp = folder.join("status.json.new");
    if serde_json::to_vec_pretty(&status).ok().is_some_and(|bytes| std::fs::write(&temp, bytes).is_ok()) {
        let _ = std::fs::rename(&temp, status_path(folder));
    }
}

/// Runs the updated program in this one's place, with the same arguments.
fn restart() -> Result<()> {
    let me = std::env::current_exe()?;
    let status = std::process::Command::new(me).args(std::env::args().skip(1)).status()?;
    std::process::exit(status.code().unwrap_or(1));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn commands_are_told_apart_from_the_harness() {
        assert!(is_command(&args(&["register", "--url", "x"])));
        assert!(is_command(&args(&["run"])));
        assert!(!is_command(&args(&[])));
        assert!(!is_command(&args(&["something"])));
    }

    #[test]
    fn options_read_both_ways() {
        let options = Options::parse(&args(&["--url", "https://g1t.sh", "--labels=gpu,cuda", "--ephemeral", "install"]), &["url", "labels"]).unwrap();
        assert_eq!(options.value("url"), Some("https://g1t.sh"));
        assert_eq!(options.value("labels"), Some("gpu,cuda"));
        assert!(options.flag("ephemeral"));
        assert_eq!(options.rest, vec!["install".to_owned()]);
        assert!(Options::parse(&args(&["--url"]), &["url"]).is_err());
    }

    #[test]
    fn a_machines_name_becomes_a_runners() {
        assert_eq!(runner_name("Build Box #1"), "Build-Box--1");
        assert_eq!(runner_name(""), "runner");
        assert_eq!(runner_name(&"x".repeat(80)).len(), 64);
    }

    #[test]
    fn the_log_says_when() {
        assert_eq!(g1t_now(1_790_918_179_123), "2026-10-02T05:16:19Z");
    }
}
