//! `g1t-runner` on your own machine: a self-hosted runner for g1t.
//!
//! ```text
//! g1t-runner register --url https://g1t.sh --token g1trt_… [--name build-01]
//!     [--labels gpu,cuda] [--group Default] [--ephemeral] [--work-dir DIR]
//!     [--no-docker] [--image IMAGE] [--agent-image IMAGE] [--replace]
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

mod api;
mod config;
mod exec;
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

const COMMANDS: &[&str] = &["register", "register-and-run", "run", "service", "remove", "update", "version", "--version", "help", "--help", "-h"];

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
        for name in ["url", "api", "token", "name", "labels", "group", "work-dir", "image", "agent-image", "harness"] {
            if self.value(name).is_none()
                && let Ok(value) = std::env::var(env_name(name))
                && !value.is_empty()
            {
                self.values.push((name.to_owned(), value));
            }
        }
        for name in ["ephemeral", "no-docker", "replace", "no-auto-update"] {
            if !self.flag(name) && std::env::var(env_name(name)).is_ok_and(|v| matches!(v.as_str(), "1" | "true" | "yes")) {
                self.flags.push(name.to_owned());
            }
        }
        self
    }
}

const HELP: &str = "g1t-runner: a self-hosted runner for g1t.

  g1t-runner register --url https://g1t.sh --token <registration token>
      [--name NAME] [--labels a,b] [--group GROUP] [--ephemeral]
      [--work-dir DIR] [--no-docker] [--image IMAGE] [--agent-image IMAGE]
      [--api URL] [--harness PATH] [--replace] [--no-auto-update]
  g1t-runner run [--once]          poll for work and run it
  g1t-runner register-and-run ...  both, for containers; options may be
                                   G1T_RUNNER_URL, _TOKEN, _LABELS, _EPHEMERAL…
  g1t-runner service install|start|stop|status|uninstall
  g1t-runner remove                unregister this runner
  g1t-runner update                update to the newest release
  g1t-runner version

Every command takes --dir DIR (default ~/.g1t-runner, or G1T_RUNNER_DIR).
Make a registration token under Settings, Runners on g1t.sh.
Docs: https://docs.g1t.sh/guides/self-hosted-runners/";

/// Runs a command. Returns the process's exit code.
pub fn main(args: Vec<String>) -> i32 {
    let takes = ["url", "api", "token", "name", "labels", "group", "work-dir", "image", "agent-image", "harness", "dir"];
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
    let docker = !options.flag("no-docker");
    if docker && !exec::docker_ready() {
        log("Docker does not answer here. Jobs will fail until it does; register with --no-docker to run them on this machine instead.");
    }
    let existing = config::load(folder).ok();
    if existing.is_some() && !options.flag("replace") {
        bail!("{} already holds a registered runner: run `g1t-runner remove` first, or register with --replace or another --dir", folder.display());
    }
    // The OS jobs run on: in Docker that is Linux, whatever the machine
    // (Docker Desktop runs Linux containers on macOS and Windows).
    let os = match std::env::consts::OS {
        _ if docker => "linux",
        "macos" => "macos",
        "windows" => "windows",
        _ => "linux",
    };
    let arch = if std::env::consts::ARCH == "aarch64" { "arm64" } else { "x64" };
    let registered = Api::register(
        &api,
        &json!({
            "token": token,
            "name": name,
            "labels": labels,
            "os": os,
            "arch": arch,
            "version": VERSION,
            "ephemeral": options.flag("ephemeral"),
            "group": options.value("group"),
            "replace": options.flag("replace"),
        }),
    )?;
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
        agent_image: options.value("agent-image").map(str::to_owned),
        harness: options.value("harness").map(PathBuf::from),
        auto_update: !options.flag("no-auto-update"),
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
    let mut config = config::load(folder)?;
    let mut api = Api { base: config.api.clone(), runner: config.runner.clone(), credential: config.credential.clone() };
    std::fs::create_dir_all(&config.work_dir).with_context(|| format!("could not make {}", config.work_dir.display()))?;
    log(&format!(
        "g1t-runner {VERSION}: {} ({}) is listening for work from {}, {}.",
        config.name,
        config.labels.join(", "),
        config.url,
        if config.docker { "in Docker" } else { "on this machine" }
    ));
    let mut current: Option<exec::Running> = None;
    let mut ran_one = false;
    let mut backoff = Duration::from_secs(2);
    let mut last_update_check = Instant::now().checked_sub(UPDATE_EVERY).unwrap_or_else(Instant::now);
    let mut said_no_key = false;
    loop {
        if STOP.load(Ordering::SeqCst) {
            if let Some(mut running) = current.take() {
                log(&format!("Stopping: {} is cut short.", running.name));
                running.stop();
                let _ = api.finished(&running.id, 1, Some("The self-hosted runner was stopped."));
                running.clean();
            }
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
        let poll = match api.poll(&running, wait) {
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
            match exec::start(&config, folder, &work) {
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
