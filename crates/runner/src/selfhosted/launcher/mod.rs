//! `g1t-runner sandbox`: self-hosted runners on a person's own computer
//! that nothing a job runs can get out of, to the computer's files, its
//! processes, its other programs or its Docker.
//!
//! ```text
//! g1t-runner sandbox up [--url https://g1t.sh --token g1trt_…] [--name NAME]
//!     [--labels a,b] [--group GROUP] [--cpus N] [--memory 8g] [--disk 64g]
//!     [--only linux,windows] [--no-native | --native] [--state-dir DIR] [--json]
//!     [--image-file PATH] [--runner-image REF] [--runner-image-file TAR]
//! g1t-runner sandbox down [--only linux,windows] [--drain] [--delete] [--json]
//! g1t-runner sandbox status [--json]
//! g1t-runner sandbox update [--image-file PATH] [--json]
//! ```
//!
//! It gives a computer up to two capabilities, each a runner of its own:
//!
//! - **`linux`: Linux jobs, in a VM of the runner's own.** The launcher
//!   makes and owns one small Linux VM per computer (a WSL 2 distribution
//!   on Windows, wsl.rs; a vfkit VM on macOS and a QEMU one on Linux
//!   without Sysbox, vm.rs; on Linux with Sysbox no VM is needed,
//!   sysbox.rs). Inside it the runner's image runs under Sysbox, and each
//!   job is a fresh container inside that, removed after (guest.rs):
//!   `nested-container` isolation. The VM's image is published with each
//!   runner release, in its signed manifest, and checked before use
//!   (image.rs). Its registration is kept apart from its system, so
//!   `update` drains the runner, swaps the image and starts again without
//!   registering again.
//! - **`windows` (and `macos`): jobs native to the computer's OS**, each in
//!   a throwaway VM of its own (native.rs): Windows Sandbox on Windows 11
//!   Pro, Enterprise and Education. The runner for these runs on the
//!   computer itself, with `--native`, and only starts and stops those VMs.
//!   `vm` isolation. On a Mac this is designed, not released.
//!
//! A runner registers labels only for what it sandboxes: the VM's runner
//! as `linux`, the native one as `windows` only when Windows Sandbox is
//! there. Nothing here advertises a native label for host mode.
//!
//! Each capability starts and stops on its own. `up --only windows` turns
//! Windows jobs on and starts them, leaving Linux jobs as they are; `down
//! --only windows` stops them and keeps them off, so a later `up` (with no
//! `--only`) starts only what is on. `down` with no `--only` stops
//! everything and turns nothing off. `--no-native` and `--native` turn the
//! OS's own capability off and on, as `--only` does.
//!
//! ## `status --json`
//!
//! The desktop app runs `g1t-runner sandbox status --json` and shows what
//! it says. One JSON object on standard output, exit code 0 whenever the
//! status could be read (a sandbox in `error` included):
//!
//! ```json
//! {
//!   "schema": 1,
//!   "state": "running",
//!   "backend": "wsl2",
//!   "runner_version": "0.3.0",
//!   "launcher_version": "0.3.0",
//!   "image_version": "0.3.0",
//!   "isolation": "nested-container",
//!   "job": { "kind": "workflow", "id": "job_…", "name": "build", "repo": "acme/web" },
//!   "error": null,
//!   "resources": { "cpus": 4, "memory_mib": 8192, "disk_gib": 64 },
//!   "capabilities": [
//!     { "id": "linux", "available": true, "state": "running", "isolation": "nested-container",
//!       "runner_version": "0.3.0", "job": null, "cause": null, "fix": null, "turned_off": false },
//!     { "id": "windows", "available": false, "state": "absent", "isolation": "vm",
//!       "runner_version": null, "job": null, "turned_off": false,
//!       "cause": "Windows Sandbox is not turned on, or this edition of Windows has none (Home does not).",
//!       "fix": "On Windows 11 Pro, Enterprise or Education, turn on Windows Sandbox under Settings, …" }
//!   ],
//!   "state_dir": "C:\\Users\\a\\.g1t-runner\\sandbox",
//!   "warnings": []
//! }
//! ```
//!
//! The top-level fields are the Linux VM's. `state` is one of `absent`
//! (never made, or deleted), `stopped`, `starting`, `running`, `updating`
//! or `error`; `error` is a sentence for a person, set whenever something
//! is wrong, and `cause`/`fix` say why a capability is unavailable, or for
//! a native one in `error` why it didn't start, and what to do.
//! `warnings` holds sentences about what on the computer weakens the
//! sandbox: a runner of the same account registered for host mode, whose
//! jobs could look inside it, or a state folder others can read. It is
//! empty when nothing does, and left out by launchers before it.
//! `turned_off` is true for a capability someone stopped (`down --only`,
//! `--no-native`), whose state is then `stopped`: stopped by a person, not
//! failing. `job` is what the runner is running now, or null. Fields
//! are only ever added; `schema` changes if one changes meaning. `up`,
//! `down` and `update` print the same object with `--json` when they are
//! done, and exit 1 with `error` set when they fail.

// The supervisor runs inside the Linux VM; elsewhere only its builders
// (tested everywhere) and its commands' parsing are used.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub mod guest;
mod image;
mod sysbox;
#[cfg_attr(not(unix), allow(dead_code))]
mod vm;
mod wsl;

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};

use super::native::{Availability, MacVm, WsbFound};
use super::private::{self, write_private};
use super::{JobStatus, Options, RunnerStatus, VERSION, config, log};
use guest::{GuestStatus, Settings};

/// What `status --json`'s shape is.
pub const SCHEMA: u32 = 1;
/// The site whose releases the sandbox's images come from when none was
/// given.
pub const DEFAULT_SITE: &str = "https://g1t.sh";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopMode {
    /// After the running job, if any.
    Drain,
    /// Now: the running job is cut short, and g1t told so.
    Now,
}

/// The VM's (or the runner container's) share of the computer.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Resources {
    pub cpus: u32,
    pub memory_mib: u64,
    pub disk_gib: u64,
}

/// One kind of sandbox that holds the Linux runner.
pub trait Backend {
    /// What `status` calls it: `wsl2`, `vfkit`, `qemu` or `sysbox`.
    fn name(&self) -> &'static str;
    /// The release files it is made from.
    fn image_keys(&self) -> Vec<String>;
    fn availability(&self) -> Availability;
    fn exists(&self) -> bool;
    fn running(&self) -> bool;
    fn create(&self, local: &image::Local, resources: &Resources) -> Result<()>;
    fn configure(&self, settings: &Settings) -> Result<()>;
    /// A runner image from a file, for a build that is not released.
    fn load_image(&self, tar: &Path) -> Result<()>;
    fn start(&self) -> Result<()>;
    fn guest_status(&self) -> Option<GuestStatus>;
    fn stop(&self, mode: StopMode) -> Result<()>;
    /// The runner's registration, when the sandbox's system and its state
    /// are one (WSL), to carry across an update.
    fn export_state(&self) -> Result<Option<Vec<u8>>>;
    fn import_state(&self, bytes: &[u8]) -> Result<()>;
    /// Removes the sandbox's system, keeping its state where that is apart.
    fn remove_system(&self) -> Result<()> {
        self.remove()
    }
    /// Removes the sandbox entirely.
    fn remove(&self) -> Result<()>;
}

/// What the launcher keeps in `<state>/sandbox.json`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Saved {
    #[serde(default)]
    pub url: Option<String>,
    /// The runners' name before `-linux` / `-windows`.
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub resources: Resources,
    #[serde(default)]
    pub image_version: Option<String>,
    #[serde(default)]
    pub runner_image: Option<String>,
    /// The capabilities turned off (`down --only`, `--no-native`), kept
    /// until `up --only` (or `--native`) turns them on again.
    #[serde(default)]
    pub off: Vec<String>,
    /// From a launcher before `off`: the native capability turned off.
    #[serde(default, skip_serializing)]
    pub no_native: bool,
    /// Why the native capability's runner didn't start, until it does.
    #[serde(default)]
    pub native_error: Option<String>,
    /// `starting` or `updating`, while a launcher (`phase_pid`) does it.
    #[serde(default)]
    pub phase: Option<String>,
    #[serde(default)]
    pub phase_pid: Option<u32>,
    /// What went wrong last, for `status`.
    #[serde(default)]
    pub error: Option<String>,
}

impl Saved {
    fn path(dir: &Path) -> PathBuf {
        dir.join("sandbox.json")
    }

    pub fn load(dir: &Path) -> Saved {
        let mut saved: Saved = std::fs::read(Saved::path(dir)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        // An earlier launcher's `--no-native`, said the way this one says it.
        if std::mem::take(&mut saved.no_native)
            && let Some(native) = native_id()
        {
            saved.turn(native, false);
        }
        saved
    }

    /// Whether a capability was turned off.
    pub fn is_off(&self, id: &str) -> bool {
        self.off.iter().any(|o| o == id)
    }

    /// Turns a capability on or off, until said otherwise.
    pub fn turn(&mut self, id: &str, on: bool) {
        self.off.retain(|o| o != id);
        if !on {
            self.off.push(id.to_owned());
            self.off.sort();
        }
    }

    pub fn save(&self, dir: &Path) -> Result<()> {
        std::fs::create_dir_all(dir).with_context(|| format!("could not make {}", dir.display()))?;
        write_private(&Saved::path(dir), &serde_json::to_vec_pretty(self)?)
    }

    fn site(&self) -> &str {
        self.url.as_deref().unwrap_or(DEFAULT_SITE)
    }
}

/// What `status --json` prints (see the module's documentation).
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Status {
    pub schema: u32,
    pub state: String,
    pub backend: Option<String>,
    pub runner_version: Option<String>,
    pub launcher_version: String,
    pub image_version: Option<String>,
    pub isolation: Option<String>,
    pub job: Option<JobStatus>,
    pub error: Option<String>,
    pub resources: Resources,
    pub capabilities: Vec<Capability>,
    pub state_dir: String,
    /// Sentences about what on the computer weakens the sandbox (a
    /// host-mode runner of the same account, a state folder others can
    /// read); empty when nothing does. Older launchers leave it out.
    #[serde(default)]
    pub warnings: Vec<String>,
}

/// One kind of job this computer can run sandboxed.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Capability {
    /// `linux`, `windows` or `macos`.
    pub id: String,
    pub available: bool,
    pub state: String,
    pub isolation: Option<String>,
    pub runner_version: Option<String>,
    pub job: Option<JobStatus>,
    pub cause: Option<String>,
    pub fix: Option<String>,
    /// Someone stopped it (`down --only`, `--no-native`): `stopped` until
    /// `up --only` turns it on again. Older launchers leave it out.
    pub turned_off: bool,
}

// --- The computer -------------------------------------------------------------

/// Whether a process is still running.
pub fn process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let alive = unsafe { libc::kill(pid as libc::pid_t, 0) } == 0;
        alive || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(windows)]
    {
        let mut command = Command::new("tasklist");
        command.args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"]);
        super::native::hide_window(&mut command);
        command.output().is_ok_and(|o| String::from_utf8_lossy(&o.stdout).contains(&format!("\"{pid}\"")))
    }
}

/// Starts a process that outlives the launcher (and the desktop app that
/// ran it), with no window. Its pid.
pub fn spawn_detached(mut command: Command) -> Result<u32> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        // The caller's own output (the desktop app's pipe) must not be
        // inherited by a process that outlives this one, or the caller
        // waits for its end until the sandbox stops.
        let _quiet = StdHandlesPrivate::new();
        command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB);
        if let Ok(child) = command.spawn() {
            return Ok(child.id());
        }
        // A job object that allows no breakaway: started inside it.
        command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
        Ok(command.spawn().context("could not start the sandbox")?.id())
    }
    #[cfg(unix)]
    {
        std::os::unix::process::CommandExt::process_group(&mut command, 0);
        Ok(command.spawn().context("could not start the sandbox")?.id())
    }
}

/// While it lives, this process's standard handles are not inheritable.
#[cfg(windows)]
struct StdHandlesPrivate {
    handles: Vec<isize>,
}

#[cfg(windows)]
unsafe extern "system" {
    fn GetStdHandle(which: u32) -> isize;
    fn SetHandleInformation(handle: isize, mask: u32, flags: u32) -> i32;
    fn GetHandleInformation(handle: isize, flags: *mut u32) -> i32;
}

#[cfg(windows)]
impl StdHandlesPrivate {
    const INHERIT: u32 = 1;

    fn new() -> StdHandlesPrivate {
        let mut handles = Vec::new();
        // STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE.
        for which in [-10i32 as u32, -11i32 as u32, -12i32 as u32] {
            let handle = unsafe { GetStdHandle(which) };
            let mut flags = 0u32;
            if handle != 0 && handle != -1 && unsafe { GetHandleInformation(handle, &mut flags) } != 0 && flags & Self::INHERIT != 0 {
                unsafe { SetHandleInformation(handle, Self::INHERIT, 0) };
                handles.push(handle);
            }
        }
        StdHandlesPrivate { handles }
    }
}

#[cfg(windows)]
impl Drop for StdHandlesPrivate {
    fn drop(&mut self) {
        for handle in &self.handles {
            unsafe { SetHandleInformation(*handle, Self::INHERIT, Self::INHERIT) };
        }
    }
}

/// The computer's memory, in MiB.
pub fn total_memory_mib() -> Option<u64> {
    #[cfg(windows)]
    {
        #[repr(C)]
        struct MemoryStatusEx {
            length: u32,
            load: u32,
            total_phys: u64,
            avail_phys: u64,
            total_page: u64,
            avail_page: u64,
            total_virtual: u64,
            avail_virtual: u64,
            avail_extended: u64,
        }
        unsafe extern "system" {
            fn GlobalMemoryStatusEx(buffer: *mut MemoryStatusEx) -> i32;
        }
        let mut status = MemoryStatusEx { length: std::mem::size_of::<MemoryStatusEx>() as u32, load: 0, total_phys: 0, avail_phys: 0, total_page: 0, avail_page: 0, total_virtual: 0, avail_virtual: 0, avail_extended: 0 };
        let ok = unsafe { GlobalMemoryStatusEx(&mut status) } != 0;
        ok.then_some(status.total_phys >> 20)
    }
    #[cfg(target_os = "macos")]
    {
        let out = Command::new("sysctl").args(["-n", "hw.memsize"]).output().ok()?;
        String::from_utf8_lossy(&out.stdout).trim().parse::<u64>().ok().map(|b| b >> 20)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let meminfo = std::fs::read_to_string("/proc/meminfo").ok()?;
        meminfo.lines().find_map(|l| l.strip_prefix("MemTotal:"))?.trim().trim_end_matches("kB").trim().parse::<u64>().ok().map(|kb| kb >> 10)
    }
}

/// The sandbox's share when none is given: half the CPUs (at most 8) and
/// a quarter of the memory (2 to 8 GiB, never more than half), and a disk
/// that may grow to 64 GiB.
pub fn default_resources(cpus: usize, memory_mib: Option<u64>) -> Resources {
    let cpus = (cpus / 2).clamp(1, 8) as u32;
    let total = memory_mib.unwrap_or(8192);
    let memory_mib = (total / 4).clamp(2048, 8192).min(total / 2).max(1024);
    Resources { cpus, memory_mib, disk_gib: 64 }
}

fn parse_gib(text: &str) -> Option<u64> {
    super::exec::mib(text).map(|m| m.div_ceil(1024))
}

/// The backend for this computer's Linux runner.
pub fn backend(dir: &Path) -> Box<dyn Backend> {
    let dir = dir.to_path_buf();
    match std::env::consts::OS {
        "windows" => Box::new(wsl::Wsl { distro: wsl::DISTRO.to_owned(), dir }),
        "macos" => Box::new(vm::DiskVm { hypervisor: vm::Hypervisor::Vfkit, dir }),
        _ => {
            let sysbox = sysbox::SysboxHost { dir: dir.clone() };
            if sysbox.exists() || sysbox.availability().available {
                Box::new(sysbox)
            } else {
                Box::new(vm::DiskVm { hypervisor: vm::Hypervisor::Qemu, dir })
            }
        }
    }
}

// --- The native capability ------------------------------------------------------

/// What this OS's native capability is called: `windows`, `macos`, or none on Linux.
fn native_id() -> Option<&'static str> {
    match std::env::consts::OS {
        "windows" => Some("windows"),
        "macos" => Some("macos"),
        _ => None,
    }
}

/// What this OS's native sandbox is called, and whether it is here.
fn native_capability() -> Option<(&'static str, Availability)> {
    match native_id()? {
        "windows" => Some(("windows", WsbFound::look().availability())),
        os => Some((os, MacVm::availability())),
    }
}

/// The capabilities this computer has, by id: `linux`, and its OS's own.
fn kinds() -> Vec<&'static str> {
    let mut kinds = vec!["linux"];
    kinds.extend(native_id());
    kinds
}

/// How a capability is said to a person: `Windows`.
fn kind_name(id: &str) -> &str {
    match id {
        "linux" => "Linux",
        "windows" => "Windows",
        "macos" => "macOS",
        other => other,
    }
}

/// `--only linux,windows`: the capabilities a command is for, of those
/// this computer has (`native` is its OS's own), or None for all of them.
fn only(options: &Options) -> Result<Option<Vec<&'static str>>> {
    let Some(given) = options.value("only") else { return Ok(None) };
    only_of(given, &kinds()).map(Some)
}

fn only_of(given: &str, have: &[&'static str]) -> Result<Vec<&'static str>> {
    let mut chosen: Vec<&'static str> = Vec::new();
    for word in given.split(',').map(str::trim).filter(|w| !w.is_empty()) {
        let word = if word == "native" { have.iter().copied().find(|k| *k != "linux").unwrap_or(word) } else { word };
        let Some(kind) = have.iter().find(|k| **k == word) else {
            bail!("--only takes {} on this computer, not {word}", have.join(" or "));
        };
        if !chosen.contains(kind) {
            chosen.push(kind);
        }
    }
    if chosen.is_empty() {
        bail!("--only takes {} on this computer", have.join(" or "));
    }
    Ok(chosen)
}

fn native_dir(dir: &Path) -> PathBuf {
    dir.join("native")
}

fn native_pid(dir: &Path) -> Option<u32> {
    std::fs::read_to_string(native_dir(dir).join("runner.pid")).ok().and_then(|p| p.trim().parse().ok())
}

fn native_running(dir: &Path) -> bool {
    native_pid(dir).is_some_and(process_alive)
}

/// Registers (once) and starts the runner for native jobs on the computer.
fn native_up(dir: &Path, saved: &Saved, token: Option<&str>, os: &str) -> Result<()> {
    let folder = native_dir(dir);
    if config::load(&folder).is_err() {
        let (Some(url), Some(token)) = (saved.url.as_deref(), token) else {
            bail!("the {os} runner is not registered: pass --url and --token");
        };
        let mut args = vec!["--url".to_owned(), url.to_owned(), "--token".into(), token.to_owned(), "--native".into()];
        args.extend(["--name".into(), format!("{}-{os}", base_name(saved))]);
        if !saved.labels.is_empty() {
            args.extend(["--labels".into(), saved.labels.join(",")]);
        }
        if let Some(group) = &saved.group {
            args.extend(["--group".into(), group.clone()]);
        }
        let options = Options::parse(&args, &super::VALUE_OPTIONS)?;
        super::register(&options, &folder)?;
    }
    if native_running(dir) {
        return Ok(());
    }
    let me = std::env::current_exe()?;
    let log_file = std::fs::File::create(folder.join("runner.log"))?;
    let mut command = Command::new(me);
    command.args(["run", "--dir"]).arg(&folder).stdin(Stdio::null()).stdout(log_file.try_clone()?).stderr(log_file);
    let pid = spawn_detached(command)?;
    std::fs::write(folder.join("runner.pid"), pid.to_string())?;
    Ok(())
}

fn native_down(dir: &Path, mode: StopMode) {
    let folder = native_dir(dir);
    let Some(pid) = native_pid(dir).filter(|p| process_alive(*p)) else { return };
    let _ = std::fs::write(folder.join(if mode == StopMode::Drain { "drain" } else { "stop" }), "");
    let limit = (mode == StopMode::Now).then(|| Instant::now() + Duration::from_secs(90));
    while process_alive(pid) {
        if limit.is_some_and(|l| Instant::now() > l) {
            #[cfg(windows)]
            let _ = Command::new("taskkill").args(["/F", "/PID", &pid.to_string()]).stdout(Stdio::null()).stderr(Stdio::null()).status();
            #[cfg(unix)]
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGKILL);
            }
            break;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    let _ = std::fs::remove_file(folder.join("runner.pid"));
}

fn base_name(saved: &Saved) -> String {
    saved.name.clone().unwrap_or_else(|| super::runner_name(&super::hostname()))
}

// --- Status -----------------------------------------------------------------------

/// The Linux capability's state from what is known.
pub fn linux_state(available: bool, exists: bool, running: bool, phase: Option<&str>, guest: Option<&GuestStatus>, error: Option<&str>) -> &'static str {
    if let Some(phase) = phase {
        return if phase == "updating" { "updating" } else { "starting" };
    }
    if !exists {
        return if available && error.is_none() { "absent" } else if error.is_some() { "error" } else { "absent" };
    }
    if !running {
        return if error.is_some() { "error" } else { "stopped" };
    }
    match guest.map(|g| (g.state.as_str(), g.runner.is_some())) {
        // Running, once the runner has registered and says so.
        Some(("running" | "stopping", true)) => "running",
        Some(("error", _)) => "error",
        Some(("stopped", _)) => "stopped",
        _ => "starting",
    }
}

pub fn status(dir: &Path) -> Status {
    let mut saved = Saved::load(dir);
    // A launcher that died mid-way leaves no phase behind.
    if saved.phase.is_some() && !saved.phase_pid.is_some_and(process_alive) {
        saved.phase = None;
    }
    let backend = backend(dir);
    let available = backend.availability();
    let exists = backend.exists();
    let running = exists && backend.running();
    let guest = if running { backend.guest_status() } else { None };
    let runner = guest.as_ref().and_then(|g| g.runner.clone());
    let mut error = saved.error.clone().or_else(|| guest.as_ref().and_then(|g| g.error.clone()));
    if !available.available && error.is_none() {
        error = available.cause.clone();
    }
    let linux_off = saved.is_off("linux");
    let mut state = linux_state(available.available, exists, running, saved.phase.as_deref(), guest.as_ref(), error.as_deref());
    // Turned off and not running is stopped by a person: nothing is wrong.
    if linux_off && saved.phase.is_none() && !running {
        state = "stopped";
    }
    if state == "running" || (linux_off && state == "stopped") {
        error = None;
    }
    let linux = Capability {
        id: "linux".into(),
        available: available.available,
        state: state.into(),
        isolation: Some(runner.as_ref().map(|r| r.isolation.clone()).unwrap_or_else(|| "nested-container".into())),
        runner_version: runner.as_ref().map(|r| r.version.clone()),
        job: runner.as_ref().and_then(|r| r.job.clone()),
        cause: available.cause.clone(),
        fix: available.fix.clone(),
        turned_off: linux_off,
    };
    let mut capabilities = vec![linux.clone()];
    if let Some((os, found)) = native_capability() {
        let folder = native_dir(dir);
        let native_status: Option<RunnerStatus> = std::fs::read(super::status_path(&folder)).ok().and_then(|b| serde_json::from_slice(&b).ok());
        let registered = config::load(&folder).is_ok();
        let alive = native_running(dir);
        let off = saved.is_off(os);
        let failed = saved.native_error.clone().filter(|_| !alive && !off && found.available);
        let state = native_state(registered, alive, off, failed.is_some());
        let (cause, fix) = match failed {
            Some(error) => (Some(error), None),
            None => (found.cause.clone(), found.fix.clone()),
        };
        capabilities.push(Capability {
            id: os.into(),
            available: found.available,
            state: state.into(),
            isolation: Some("vm".into()),
            runner_version: native_status.as_ref().filter(|_| alive).map(|s| s.version.clone()),
            job: native_status.filter(|_| alive).and_then(|s| s.job),
            cause,
            fix,
            turned_off: off,
        });
    }
    Status {
        schema: SCHEMA,
        state: linux.state,
        backend: Some(backend.name().to_owned()),
        runner_version: linux.runner_version,
        launcher_version: VERSION.to_owned(),
        // What the running image says it is, else what was installed.
        image_version: guest.as_ref().and_then(|g| g.image_version.clone()).or_else(|| saved.image_version.clone()),
        isolation: linux.isolation,
        job: linux.job,
        error,
        resources: saved.resources,
        capabilities,
        state_dir: dir.display().to_string(),
        warnings: warnings(dir),
    }
}

// --- What weakens it ---------------------------------------------------------------

/// What on this computer lets someone look inside the sandbox: a runner of
/// this account's that runs jobs as it, and a state folder others can read.
fn warnings(dir: &Path) -> Vec<String> {
    let mut said: Vec<String> = host_mode_runners(&host_runner_folders()).iter().map(|folder| host_mode_warning(folder)).collect();
    if dir.exists() {
        let readers = private::readers(dir);
        if !readers.is_empty() {
            said.push(format!(
                "{} can be read by {}: the runners' credentials and the VM's disk are in it. The next `g1t-runner sandbox up` makes it private, or refuses to start.",
                dir.display(),
                readers.join(", ")
            ));
        }
    }
    said
}

/// Where a runner of this account's may be registered: `g1t-runner`'s own
/// folder (`G1T_RUNNER_DIR`, `~/.g1t-runner`), and the desktop app's for
/// running jobs directly on the computer.
fn host_runner_folders() -> Vec<PathBuf> {
    let mut folders = vec![config::folder(None)];
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    if let Some(home) = &home {
        folders.push(home.join(".g1t-runner"));
    }
    // The desktop app's data folder (its `app_data_dir`): runner/host.
    let data = match std::env::consts::OS {
        "windows" => std::env::var_os("APPDATA").map(PathBuf::from),
        "macos" => home.as_ref().map(|h| h.join("Library").join("Application Support")),
        _ => std::env::var_os("XDG_DATA_HOME").filter(|d| !d.is_empty()).map(PathBuf::from).or_else(|| home.as_ref().map(|h| h.join(".local").join("share"))),
    };
    if let Some(data) = data {
        folders.push(data.join("sh.g1t.desktop").join("runner").join("host"));
    }
    folders.dedup();
    folders
}

/// Those of `folders` that hold a runner registered for host mode: jobs as
/// processes of this account, neither in a container nor in a VM.
fn host_mode_runners(folders: &[PathBuf]) -> Vec<PathBuf> {
    folders.iter().filter(|folder| config::load(folder).is_ok_and(|c| !c.docker && !c.native)).cloned().collect()
}

fn host_mode_warning(folder: &Path) -> String {
    format!(
        "A runner registered in {} runs jobs directly on this computer, as you (host mode). Whenever it runs, what its jobs run can read this sandbox's runner credentials and reach inside the sandbox, as you can. Remove it (`g1t-runner remove --dir {}`), or register it under another account.",
        folder.display(),
        folder.display()
    )
}

/// The native capability's state: running while its runner lives;
/// stopped when turned off, or registered and not running; `error` when
/// it didn't start; `absent` before it is registered.
pub fn native_state(registered: bool, alive: bool, off: bool, failed: bool) -> &'static str {
    if alive {
        "running"
    } else if off {
        "stopped"
    } else if failed {
        "error"
    } else if registered {
        "stopped"
    } else {
        "absent"
    }
}

fn print(status: &Status, json: bool) {
    if json {
        println!("{}", serde_json::to_string_pretty(status).unwrap_or_default());
        return;
    }
    println!("Sandbox: {} ({})", status.state, status.backend.as_deref().unwrap_or("none"));
    for capability in &status.capabilities {
        let said = match (capability.turned_off, capability.available) {
            (true, _) => "stopped (turned off; `up --only` turns it on)",
            (false, true) => capability.state.as_str(),
            (false, false) => "unavailable",
        };
        let mut line = format!("  {:8} {said}", capability.id);
        if let Some(job) = &capability.job {
            line.push_str(&format!(", running {} in {}", job.name, job.repo));
        }
        println!("{line}");
        if !capability.turned_off && (!capability.available || capability.state == "error") {
            if let Some(cause) = &capability.cause {
                println!("           {cause}");
            }
            if let Some(fix) = &capability.fix {
                println!("           {fix}");
            }
        }
    }
    for warning in &status.warnings {
        println!("Warning: {warning}");
    }
    if let Some(error) = &status.error {
        println!("Error: {error}");
    }
}

// --- Commands -----------------------------------------------------------------------

const HELP: &str = "g1t-runner sandbox: self-hosted runners on your own computer, sandboxed.

  g1t-runner sandbox up [--url https://g1t.sh --token <registration token>]
      [--name NAME] [--labels a,b] [--group GROUP]
      [--cpus N] [--memory 8g] [--disk 64g] [--only linux,windows]
      [--no-native | --native] [--json]
  g1t-runner sandbox down [--only linux,windows] [--drain] [--delete] [--json]
  g1t-runner sandbox status [--json]
  g1t-runner sandbox update [--json]

Linux jobs run in a Linux VM of the runner's own (a WSL distribution on
Windows, a vfkit VM on macOS; on Linux, Sysbox, or a QEMU VM), each in a
fresh container inside it. Windows jobs run each in a Windows Sandbox of
its own (Windows 11 Pro, Enterprise or Education). Nothing a job runs
reaches this computer's files, programs or Docker.

The first `up` needs --url and --token (make a token under Settings,
Runners). `down` stops now, cutting a running job short; --drain waits
for it. Each kind of job starts and stops on its own: `down --only
windows` stops Windows jobs and keeps them off, leaving Linux jobs
running, until `up --only windows` turns them on again. `update` drains,
swaps in the newest signed image, and starts
again, keeping the registration. Every command takes --state-dir DIR
(default ~/.g1t-runner/sandbox).
Docs: https://docs.g1t.sh/guides/self-hosted-runners/#sandbox-on-your-computer";

const SANDBOX_VALUES: &[&str] = &[
    "url",
    "token",
    "name",
    "labels",
    "group",
    "cpus",
    "memory",
    "disk",
    "state-dir",
    "image-file",
    "runner-image",
    "runner-image-file",
    "wait",
    "only",
];

/// `g1t-runner sandbox <command>`: the process's exit code.
pub fn main(args: &[String]) -> i32 {
    if args.first().map(String::as_str) == Some("guest") {
        return match guest::main(&args[1..]) {
            Ok(()) => 0,
            Err(error) => {
                eprintln!("g1t-runner: {error:#}");
                1
            }
        };
    }
    let options = match Options::parse(args.get(1..).unwrap_or_default(), SANDBOX_VALUES) {
        Ok(options) => options,
        Err(error) => {
            eprintln!("g1t-runner: {error:#}");
            return 2;
        }
    };
    let json = options.flag("json");
    let dir = options.value("state-dir").map(PathBuf::from).unwrap_or_else(|| config::folder(None).join("sandbox"));
    // The state folder holds the runners' credentials and the VM's disk:
    // only this account's, or nothing is made or started in it.
    let private = || private::folder(&dir, "--state-dir");
    let outcome = match args.first().map(String::as_str) {
        Some("up") => private().and_then(|()| up(&options, &dir)),
        Some("down") => private().and_then(|()| down(&options, &dir)),
        Some("update") => private().and_then(|()| update_sandbox(&options, &dir)),
        Some("status") => Ok(()),
        _ => {
            println!("{HELP}");
            return 0;
        }
    };
    let mut status = status(&dir);
    match outcome {
        Ok(()) => {
            print(&status, json);
            0
        }
        Err(error) => {
            status.error = Some(format!("{error:#}"));
            if json {
                print(&status, true);
            } else {
                eprintln!("g1t-runner: {error:#}");
            }
            1
        }
    }
}

/// Runs `step` as a phase (`starting`, `updating`) that `status` reports,
/// keeping what went wrong for it.
fn in_phase(dir: &Path, phase: &str, step: impl FnOnce(&mut Saved) -> Result<()>) -> Result<()> {
    let mut saved = Saved::load(dir);
    saved.phase = Some(phase.to_owned());
    saved.phase_pid = Some(std::process::id());
    saved.error = None;
    saved.save(dir)?;
    let outcome = step(&mut saved);
    saved.phase = None;
    saved.phase_pid = None;
    saved.error = outcome.as_ref().err().map(|e| format!("{e:#}"));
    saved.save(dir)?;
    outcome
}

fn up(options: &Options, dir: &Path) -> Result<()> {
    let mut saved = Saved::load(dir);
    if let Some(url) = options.value("url") {
        saved.url = Some(url.trim_end_matches('/').to_owned());
    }
    if let Some(name) = options.value("name") {
        saved.name = Some(super::runner_name(name));
    }
    if let Some(labels) = options.value("labels") {
        saved.labels = labels.split(',').map(|l| l.trim().to_owned()).filter(|l| !l.is_empty()).collect();
    }
    if let Some(group) = options.value("group") {
        saved.group = Some(group.to_owned());
    }
    let defaults = default_resources(std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2), total_memory_mib());
    let mut resources = if saved.resources == Resources::default() { defaults } else { saved.resources };
    if let Some(cpus) = options.value("cpus") {
        resources.cpus = cpus.parse().ok().filter(|n| *n > 0).ok_or_else(|| anyhow!("--cpus takes a number of CPUs, not {cpus}"))?;
    }
    if let Some(memory) = options.value("memory") {
        resources.memory_mib = super::exec::mib(memory).filter(|m| *m >= 1024).ok_or_else(|| anyhow!("--memory takes a size of 1g or more, such as 8g, not {memory}"))?;
    }
    if let Some(disk) = options.value("disk") {
        resources.disk_gib = parse_gib(disk).filter(|g| *g >= 16).ok_or_else(|| anyhow!("--disk takes a size of 16g or more, such as 64g, not {disk}"))?;
    }
    saved.resources = resources;
    // Each capability on or off, kept until said otherwise: `--only` turns
    // on what it names and leaves the rest as they are.
    let only = only(options)?;
    if let Some(native) = native_id() {
        if options.flag("no-native") {
            saved.turn(native, false);
        } else if options.flag("native") {
            saved.turn(native, true);
        }
    }
    for kind in only.iter().flatten() {
        saved.turn(kind, true);
    }
    let wanted = |kind: &str| match &only {
        Some(only) => only.contains(&kind),
        None => !saved.is_off(kind),
    };
    let (want_linux, native) = (wanted("linux"), native_capability().filter(|(os, _)| wanted(os)));
    if let Some(image) = options.value("runner-image") {
        saved.runner_image = Some(image.to_owned());
    }
    saved.save(dir)?;
    // From G1T_RUNNER_TOKEN too, as register-and-run takes it: a token on
    // the command line shows in the process list to anyone on the machine
    // while `up` runs, and the desktop app passes it this way.
    let token = options
        .value("token")
        .map(str::to_owned)
        .or_else(|| std::env::var("G1T_RUNNER_TOKEN").ok().filter(|token| !token.trim().is_empty()));

    if !want_linux && native.is_none() {
        log("Every kind of job is turned off here: `g1t-runner sandbox up --only linux` turns Linux jobs on again.");
        return Ok(());
    }
    let backend = backend(dir);
    let found = backend.availability();
    let linux = if !want_linux {
        None
    } else if found.available {
        Some(in_phase(dir, "starting", |saved| {
            let fresh = !backend.exists();
            if fresh {
                let local = obtain_image(options, saved, backend.as_ref(), dir)?;
                backend.create(&local, &saved.resources)?;
                saved.image_version = Some(local.version.clone());
                if local.runner_image.is_some() {
                    saved.runner_image = local.runner_image.clone();
                }
            }
            // An update that stopped half-way, after the old system was
            // removed, left the registration here.
            let carried = dir.join("carry").join("config.json");
            if let Ok(bytes) = std::fs::read(&carried) {
                backend.import_state(&bytes)?;
                let _ = std::fs::remove_dir_all(dir.join("carry"));
            }
            if let Some(tar) = options.value("runner-image-file") {
                backend.load_image(Path::new(tar))?;
            }
            let Some(runner_image) = saved.runner_image.clone() else {
                bail!("there is no runner image for the sandbox: this build is not a release, so pass --runner-image or --runner-image-file");
            };
            backend.configure(&Settings {
                url: saved.url.clone(),
                token: token.clone(),
                name: Some(format!("{}-linux", base_name(saved))),
                labels: saved.labels.clone(),
                group: saved.group.clone(),
                machine: super::machine_fingerprint(),
                cpus: saved.resources.cpus,
                memory_mib: saved.resources.memory_mib,
                runner_image,
                image_version: saved.image_version.clone().unwrap_or_default(),
                stop: None,
            })?;
            backend.start()?;
            wait_running(backend.as_ref(), Duration::from_secs(if fresh { 600 } else { 180 }))
        }))
    } else {
        Some(Err(anyhow!("{} {}", found.cause.unwrap_or_default(), found.fix.unwrap_or_default())))
    };
    let native = match native {
        Some((os, found)) if found.available => {
            let started = native_up(dir, &Saved::load(dir), token.as_deref(), os);
            // Why it didn't start is the capability's, for `status`, until it does.
            let mut kept = Saved::load(dir);
            kept.native_error = started.as_ref().err().map(|e| format!("{e:#}"));
            kept.save(dir)?;
            Some((os, started))
        }
        // Asked for by name, and not here: why, rather than nothing.
        Some((os, found)) if only.is_some() => Some((os, Err(anyhow!("{} {}", found.cause.unwrap_or_default(), found.fix.unwrap_or_default()).context(format!("{} jobs can't run here", kind_name(os)))))),
        _ => None,
    };
    match (linux, native) {
        (None | Some(Ok(())), None | Some((_, Ok(())))) => Ok(()),
        (Some(Err(linux)), Some((os, Ok(())))) => Err(linux.context(format!("{} jobs are sandboxed and running, but Linux jobs are not", kind_name(os)))),
        (Some(Err(linux)), _) => Err(linux),
        (Some(Ok(())), Some((os, Err(native)))) => Err(native.context(format!("Linux jobs are sandboxed and running, but {} jobs are not", kind_name(os)))),
        (None, Some((_, Err(native)))) => Err(native),
    }
}

/// Waits until the sandbox's runner is registered and asking for work (it
/// has written its status), or says what went wrong.
fn wait_running(backend: &dyn Backend, limit: Duration) -> Result<()> {
    let until = Instant::now() + limit;
    loop {
        if let Some(status) = backend.guest_status() {
            match status.state.as_str() {
                "running" if status.runner.as_ref().is_some_and(|r| r.state != "stopped") => return Ok(()),
                "error" => bail!("{}", status.error.unwrap_or_else(|| "the sandbox stopped".into())),
                _ => {}
            }
        }
        if Instant::now() > until {
            bail!("the sandbox did not start within {} seconds; `g1t-runner sandbox status` says how it is now", limit.as_secs());
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

fn obtain_image(options: &Options, saved: &Saved, backend: &dyn Backend, dir: &Path) -> Result<image::Local> {
    let keys = backend.image_keys();
    if let Some(file) = options.value("image-file") {
        log(&format!("Using {file}, which is not a release: it is not checked against g1t's signature."));
        return image::local(&keys, Path::new(file), saved.runner_image.clone());
    }
    if keys.is_empty() {
        // Sysbox on Linux: only the runner's image, named in the release.
        let manifest = image::latest(saved.site());
        return Ok(image::Local {
            version: manifest.as_ref().map(|m| m.version.clone()).unwrap_or_else(|_| VERSION.to_owned()),
            files: Default::default(),
            runner_image: manifest.ok().and_then(|m| m.sandbox).and_then(|s| s.runner_image).or_else(|| saved.runner_image.clone()),
        });
    }
    let manifest = image::latest(saved.site())?;
    image::obtain(saved.site(), &manifest, &keys, &dir.join("images"), &|line| log(line))
}

fn down(options: &Options, dir: &Path) -> Result<()> {
    let mode = if options.flag("drain") { StopMode::Drain } else { StopMode::Now };
    if let Some(only) = only(options)? {
        return down_only(dir, mode, &only, options.flag("delete"));
    }
    native_down(dir, mode);
    let backend = backend(dir);
    if options.flag("delete") {
        backend.remove()?;
        let _ = std::fs::remove_dir_all(dir.join("images"));
        let _ = std::fs::remove_dir_all(native_dir(dir));
        let _ = std::fs::remove_dir_all(dir.join("carry"));
        let mut saved = Saved::load(dir);
        saved.image_version = None;
        saved.error = None;
        saved.save(dir)?;
        log("Deleted the sandbox. Its runners are still listed on g1t until you remove them there.");
        return Ok(());
    }
    if backend.exists() {
        backend.stop(mode)?;
    }
    let mut saved = Saved::load(dir);
    saved.error = None;
    saved.native_error = None;
    saved.save(dir)
}

/// `down --only`: stops those capabilities and turns them off, leaving the
/// others as they are, running or not.
fn down_only(dir: &Path, mode: StopMode, only: &[&'static str], delete: bool) -> Result<()> {
    if delete {
        bail!("--delete removes the whole sandbox, so it takes no --only");
    }
    for kind in only {
        if *kind == "linux" {
            let backend = backend(dir);
            if backend.exists() && backend.running() {
                backend.stop(mode)?;
            }
        } else {
            native_down(dir, mode);
        }
        let mut saved = Saved::load(dir);
        if *kind == "linux" {
            saved.error = None;
        } else {
            saved.native_error = None;
        }
        saved.turn(kind, false);
        saved.save(dir)?;
        log(&format!("Stopped {} jobs; they stay off until `g1t-runner sandbox up --only {kind}`.", kind_name(kind)));
    }
    Ok(())
}

fn update_sandbox(options: &Options, dir: &Path) -> Result<()> {
    let backend = backend(dir);
    if !backend.exists() {
        bail!("there is no sandbox to update: run `g1t-runner sandbox up`");
    }
    let saved = Saved::load(dir);
    let local = if options.value("image-file").is_some() {
        obtain_image(options, &saved, backend.as_ref(), dir)?
    } else {
        let manifest = image::latest(saved.site())?;
        if saved.image_version.as_deref().is_some_and(|current| !super::update::newer(&manifest.version, current)) {
            log(&format!("The sandbox's image is the newest, {}.", manifest.version));
            return Ok(());
        }
        let keys = backend.image_keys();
        if keys.is_empty() {
            obtain_image(options, &saved, backend.as_ref(), dir)?
        } else {
            image::obtain(saved.site(), &manifest, &keys, &dir.join("images"), &|line| log(line))?
        }
    };
    in_phase(dir, "updating", |saved| {
        let was_running = backend.running();
        if was_running {
            log("Draining: the runner finishes the job it is running, then stops.");
            backend.stop(StopMode::Drain)?;
        }
        // The registration, kept on the computer (in the private state
        // folder) only while no sandbox has it: from just before the old
        // system goes until the new one has it. Should the update stop in
        // between, the next `up` puts it in the new system and removes it.
        let carry = dir.join("carry");
        let carried = carry.join("config.json");
        if let Some(bytes) = backend.export_state()? {
            std::fs::create_dir_all(&carry)?;
            write_private(&carried, &bytes)?;
        }
        if let Err(error) = backend.remove_system() {
            // The old system, and the registration in it, are still there.
            let _ = std::fs::remove_dir_all(&carry);
            return Err(error);
        }
        backend.create(&local, &saved.resources)?;
        if let Ok(bytes) = std::fs::read(&carried) {
            backend.import_state(&bytes)?;
        }
        let _ = std::fs::remove_dir_all(&carry);
        if let Some(tar) = options.value("runner-image-file") {
            backend.load_image(Path::new(tar))?;
        }
        saved.image_version = Some(local.version.clone());
        if local.runner_image.is_some() {
            saved.runner_image = local.runner_image.clone();
        }
        backend.configure(&Settings {
            runner_image: saved.runner_image.clone().unwrap_or_default(),
            image_version: local.version.clone(),
            cpus: saved.resources.cpus,
            memory_mib: saved.resources.memory_mib,
            url: saved.url.clone(),
            name: Some(format!("{}-linux", base_name(saved))),
            labels: saved.labels.clone(),
            group: saved.group.clone(),
            machine: super::machine_fingerprint(),
            ..Settings::default()
        })?;
        if was_running {
            backend.start()?;
            wait_running(backend.as_ref(), Duration::from_secs(600))?;
        }
        image::prune(&dir.join("images"), &local.version);
        if local.version == "local" {
            log("The sandbox is on the image from --image-file.");
        } else {
            log(&format!("The sandbox is on image {}.", local.version));
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_share_leaves_the_computer_room() {
        assert_eq!(default_resources(16, Some(65536)), Resources { cpus: 8, memory_mib: 8192, disk_gib: 64 });
        assert_eq!(default_resources(8, Some(16384)), Resources { cpus: 4, memory_mib: 4096, disk_gib: 64 });
        assert_eq!(default_resources(4, Some(8192)), Resources { cpus: 2, memory_mib: 2048, disk_gib: 64 });
        // Never more than half a small machine's memory.
        assert_eq!(default_resources(2, Some(3072)).memory_mib, 1536);
        assert_eq!(default_resources(1, None).cpus, 1);
        assert_eq!(parse_gib("64g"), Some(64));
        assert_eq!(parse_gib("100000m"), Some(98));
    }

    #[test]
    fn the_state_says_what_a_person_needs_to_know() {
        let running = GuestStatus { state: "running".into(), runner: Some(RunnerStatus { state: "idle".into(), ..RunnerStatus::default() }), ..GuestStatus::default() };
        let unregistered = GuestStatus { state: "running".into(), ..GuestStatus::default() };
        let failed = GuestStatus { state: "error".into(), error: Some("x".into()), ..GuestStatus::default() };
        assert_eq!(linux_state(true, false, false, None, None, None), "absent");
        assert_eq!(linux_state(false, false, false, None, None, Some("WSL is not installed.")), "error");
        assert_eq!(linux_state(true, true, false, None, None, None), "stopped");
        assert_eq!(linux_state(true, true, true, None, None, None), "starting");
        assert_eq!(linux_state(true, true, true, None, Some(&running), None), "running");
        assert_eq!(linux_state(true, true, true, None, Some(&unregistered), None), "starting");
        assert_eq!(linux_state(true, true, true, None, Some(&failed), None), "error");
        assert_eq!(linux_state(true, true, true, Some("updating"), Some(&running), None), "updating");
        assert_eq!(linux_state(true, false, false, Some("starting"), None, None), "starting");
    }

    #[test]
    fn the_status_contract_holds_its_fields() {
        let status = Status {
            schema: SCHEMA,
            state: "running".into(),
            backend: Some("wsl2".into()),
            launcher_version: VERSION.into(),
            capabilities: vec![Capability { id: "linux".into(), available: true, state: "running".into(), ..Capability::default() }],
            ..Status::default()
        };
        let value = serde_json::to_value(&status).unwrap();
        for field in ["schema", "state", "backend", "runner_version", "launcher_version", "image_version", "isolation", "job", "error", "resources", "capabilities", "state_dir", "warnings"] {
            assert!(value.get(field).is_some(), "{field}");
        }
        for field in ["id", "available", "state", "isolation", "runner_version", "job", "cause", "fix", "turned_off"] {
            assert!(value["capabilities"][0].get(field).is_some(), "{field}");
        }
        assert_eq!(value["resources"]["memory_mib"], 0);
    }

    #[test]
    fn a_status_with_nothing_made_is_absent_and_says_where() {
        let dir = std::env::temp_dir().join(format!("g1t-sandbox-status-{}", std::process::id()));
        let saved = Saved { phase: Some("updating".into()), phase_pid: Some(u32::MAX - 1), ..Saved::default() };
        saved.save(&dir).unwrap();
        // A launcher that died mid-update leaves no phase in the status.
        assert_ne!(status(&dir).state, "updating");
        assert_eq!(status(&dir).state_dir, dir.display().to_string());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_names_what_this_computer_has() {
        let windows = ["linux", "windows"];
        assert_eq!(only_of("windows", &windows).unwrap(), ["windows"]);
        assert_eq!(only_of("linux, windows,linux", &windows).unwrap(), ["linux", "windows"]);
        assert_eq!(only_of("native", &windows).unwrap(), ["windows"]);
        assert!(only_of("macos", &windows).unwrap_err().to_string().contains("linux or windows"));
        assert!(only_of(",", &windows).is_err());
        // Linux has no native capability: `native` is not one of its kinds.
        assert!(only_of("native", &["linux"]).unwrap_err().to_string().contains("not native"));
    }

    #[test]
    fn a_capability_turned_off_stays_off_and_reads_as_stopped() {
        let mut saved = Saved::default();
        saved.turn("windows", false);
        saved.turn("windows", false);
        assert_eq!(saved.off, ["windows"]);
        assert!(saved.is_off("windows") && !saved.is_off("linux"));
        saved.turn("windows", true);
        assert!(saved.off.is_empty());
        // Stopped by a person is not failing, and running is running whatever it says.
        assert_eq!(native_state(true, false, true, true), "stopped");
        assert_eq!(native_state(true, true, true, false), "running");
        assert_eq!(native_state(true, false, false, true), "error");
        assert_eq!(native_state(true, false, false, false), "stopped");
        assert_eq!(native_state(false, false, false, false), "absent");
    }

    #[test]
    fn an_earlier_no_native_is_read_as_turned_off() {
        let dir = std::env::temp_dir().join(format!("g1t-sandbox-off-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("sandbox.json"), r#"{"no_native":true,"labels":[]}"#).unwrap();
        let saved = Saved::load(&dir);
        assert!(!saved.no_native);
        assert_eq!(saved.off, native_id().into_iter().collect::<Vec<_>>());
        saved.save(&dir).unwrap();
        let written = std::fs::read_to_string(dir.join("sandbox.json")).unwrap();
        assert!(!written.contains("no_native"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_host_mode_runner_of_the_same_account_is_warned_of() {
        let root = std::env::temp_dir().join(format!("g1t-sandbox-host-{}", std::process::id()));
        let registered = |name: &str, how: &str| {
            let folder = root.join(name);
            std::fs::create_dir_all(&folder).unwrap();
            let config = format!(
                r#"{{"url":"https://g1t.sh","api":"https://api.g1t.sh","runner":"rnr_1","name":"a","credential":"g1tr_x","workspace":"acme","labels":[],"work_dir":"/tmp/w"{how}}}"#
            );
            std::fs::write(folder.join("config.json"), config).unwrap();
            folder
        };
        let host = registered("host", r#","docker":false"#);
        let docker = registered("docker", "");
        let native = registered("native", r#","docker":false,"native":true"#);
        let none = root.join("none");
        let found = host_mode_runners(&[host.clone(), docker, native, none]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0], host);
        let said = host_mode_warning(&host);
        assert!(said.contains("as you") && said.contains("g1t-runner remove --dir"), "{said}");
        // The desktop app's folder for running jobs directly is looked at.
        assert!(host_runner_folders().iter().any(|f| f.ends_with(Path::new("sh.g1t.desktop").join("runner").join("host"))));
        // An older status, without warnings, still reads.
        let old: Status = serde_json::from_str(r#"{"schema":1,"state":"absent","backend":null,"runner_version":null,"launcher_version":"0.3.0","image_version":null,"isolation":null,"job":null,"error":null,"resources":{"cpus":0,"memory_mib":0,"disk_gib":0},"capabilities":[],"state_dir":"x"}"#).unwrap();
        assert!(old.warnings.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn this_process_is_alive() {
        assert!(process_alive(std::process::id()));
        assert!(!process_alive(u32::MAX - 1));
        assert!(total_memory_mib().unwrap_or(1) > 0);
    }
}
