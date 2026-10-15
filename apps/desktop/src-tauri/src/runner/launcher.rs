//! The one place the app meets `g1t-runner sandbox`, the launcher that
//! makes a sandbox of the runner's own on this computer and runs the
//! runner inside it (crates/runner/src/selfhosted/launcher): Linux jobs in
//! a Linux VM (a WSL 2 distribution on Windows, vfkit on macOS, Sysbox or
//! QEMU with KVM on Linux), each a fresh container inside it
//! (`nested-container`), and, on Windows 11 Pro and up, Windows jobs each
//! in a Windows Sandbox of its own (`vm`).
//!
//! It is the `g1t-runner` the app already keeps up to date (native.rs),
//! with its state in the app's runner folder (`--state-dir`). The app runs
//! four commands, each with `--json`, and reads the one object each prints
//! last (the launcher's documented status, schema 1):
//!
//! - `up --url … --name … --labels desktop [--token …]`, after the window
//!   opens: makes the sandbox if there is none and starts it, waiting until
//!   the runner asks for work. The token goes only to the first `up`; the
//!   launcher keeps the registration from then on, across updates too. It
//!   adds `-linux` and `-windows` to the name, and the OS labels, itself.
//! - `status`, every few seconds, for the tray, settings and the site.
//! - `down` as g1t quits or the person stops it; `down --drain` when they
//!   choose another way of running jobs; `down --delete` when the
//!   registration is no longer the one wanted.
//! - `up --only linux` and `down --only windows` when the person starts
//!   or stops one kind of job in settings: the other is left as it is.
//!   Every `up` names the kinds that are on (`--only`), so the launcher
//!   never starts one the person stopped. A launcher from before `--only`
//!   says no `turned_off` in its status, and is never sent `down --only`,
//!   which it would read as `down`, stopping everything.
//! - `update`, while nothing runs: the newest signed image, the same
//!   registration.
//!
//! What a status's causes and errors mean is read here (`why`); what the
//! app says about them is diagnosis.rs's.

use std::ffi::OsString;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::Deserialize;

use super::backend::quiet;

/// The launcher's state folder, under the app's runner folder.
pub const FOLDER: &str = "sandbox";
/// The status shape the app reads (`schema`).
pub const SCHEMA: u32 = 1;
/// How often the app asks the sandbox how it is: a call takes about a second.
pub const STATUS_EVERY: Duration = Duration::from_secs(8);
/// What installs WSL on Windows, for the person to run as administrator.
pub const WSL_INSTALL: &str = "wsl --install --no-distribution";
/// What installs vfkit on a Mac.
pub const VFKIT_INSTALL: &str = "brew install vfkit";
/// What loads KVM on Linux, Intel's or AMD's.
pub const KVM_LOAD: &str = "sudo modprobe kvm_intel || sudo modprobe kvm_amd";
/// What lets this account use /dev/kvm, after logging in again.
pub const KVM_GROUP: &str = "sudo usermod -aG kvm $USER";

/// What installs QEMU on this Linux, from `/etc/os-release` and the
/// machine (`x86_64`, `aarch64`): None where it isn't known.
pub fn qemu_install(os_release: &str, arch: &str) -> Option<String> {
    let field = |name: &str| {
        os_release.lines().find_map(|line| line.strip_prefix(name).and_then(|rest| rest.strip_prefix('='))).map(|value| value.trim_matches('"').to_ascii_lowercase()).unwrap_or_default()
    };
    let family = format!("{} {}", field("ID"), field("ID_LIKE"));
    let is = |name: &str| family.split_whitespace().any(|id| id == name);
    let system = if arch == "aarch64" { "qemu-system-arm" } else { "qemu-system-x86" };
    if is("debian") || is("ubuntu") {
        Some(format!("sudo apt install {system}"))
    } else if is("fedora") || is("rhel") || is("centos") {
        Some("sudo dnf install qemu-kvm".into())
    } else if is("arch") {
        Some("sudo pacman -S qemu-base".into())
    } else if is("opensuse") || is("suse") {
        Some("sudo zypper install qemu-kvm".into())
    } else {
        None
    }
}
/// How often the app looks again for a release with the sandbox's images,
/// while the newest is published without them.
pub const IMAGES_AGAIN: Duration = Duration::from_secs(5 * 60);

/// A sandbox's, or one capability's, state.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    /// Never made, or deleted.
    #[default]
    Absent,
    Stopped,
    Starting,
    Running,
    Updating,
    Error,
    /// A state a newer launcher has that this app does not know.
    #[serde(other)]
    Unknown,
}

/// What a runner is running now.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct Job {
    /// `workflow` or `agent`.
    pub kind: String,
    pub id: String,
    pub name: String,
    pub repo: String,
}

impl Job {
    /// How the tray says it: `build (acme/web)`.
    pub fn said(&self) -> String {
        if self.repo.is_empty() { self.name.clone() } else { format!("{} ({})", self.name, self.repo) }
    }
}

/// One kind of job the computer can run sandboxed: `linux`, `windows` or `macos`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct Capability {
    pub id: String,
    pub available: bool,
    pub state: State,
    pub isolation: Option<String>,
    pub runner_version: Option<String>,
    pub job: Option<Job>,
    /// Why it is not available, in a sentence.
    pub cause: Option<String>,
    /// What to do about it, in a sentence.
    pub fix: Option<String>,
    /// The person stopped it (`down --only`): stopped, not failing. None
    /// from a launcher before it could stop one kind of job on its own.
    pub turned_off: Option<bool>,
    /// What this computer still lacks for it, by name, first what must
    /// come first: `wsl`, `vm_platform`, `virtualization`, `restart`, …
    /// (the launcher's needs.rs). diagnosis.rs says each. Empty from a
    /// launcher before them, whose causes are read by their words (`why`).
    pub needs: Vec<String>,
}

impl Capability {
    pub fn off(&self) -> bool {
        self.turned_off == Some(true)
    }
}

/// `g1t-runner sandbox status --json`. The top-level fields are the Linux
/// VM's. Fields the app does not use (`resources`, `state_dir`) are left
/// out, and any a newer launcher adds are ignored.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct Status {
    pub schema: u32,
    pub state: State,
    /// `wsl2`, `vfkit`, `qemu` or `sysbox`.
    pub backend: Option<String>,
    pub runner_version: Option<String>,
    pub launcher_version: Option<String>,
    pub image_version: Option<String>,
    pub isolation: Option<String>,
    pub job: Option<Job>,
    /// A sentence for a person, whenever something is wrong.
    pub error: Option<String>,
    pub capabilities: Vec<Capability>,
}

impl Status {
    pub fn capability(&self, id: &str) -> Option<&Capability> {
        self.capabilities.iter().find(|c| c.id == id)
    }

    /// The Linux capability, as the top-level fields say it when a launcher lists none.
    pub fn linux(&self) -> Capability {
        self.capability("linux").cloned().unwrap_or_else(|| Capability {
            id: "linux".into(),
            available: self.state != State::Error || self.error.is_none(),
            state: self.state,
            runner_version: self.runner_version.clone(),
            job: self.job.clone(),
            ..Capability::default()
        })
    }

    /// Whether any of its runners is running.
    pub fn running(&self) -> bool {
        self.state == State::Running || self.capabilities.iter().any(|c| c.state == State::Running)
    }

    /// Whether anything here can be sandboxed at all.
    pub fn anything_available(&self) -> bool {
        if self.capabilities.is_empty() { self.linux().available } else { self.capabilities.iter().any(|c| c.available) }
    }

    /// A capability that can be had here, and is on, but was never set
    /// up: registering it needs a token.
    pub fn unregistered(&self) -> bool {
        let wanting = |c: &Capability| c.available && !c.off() && c.state == State::Absent;
        if self.capabilities.is_empty() { wanting(&self.linux()) } else { self.capabilities.iter().any(wanting) }
    }

    /// Whether this launcher starts and stops each kind of job on its own
    /// (`--only`), which it says by saying which are turned off.
    pub fn per_kind(&self) -> bool {
        !self.capabilities.is_empty() && self.capabilities.iter().all(|c| c.turned_off.is_some())
    }

    /// Whether everything that could run here was turned off by the person.
    pub fn all_off(&self) -> bool {
        let available: Vec<&Capability> = self.capabilities.iter().filter(|c| c.available || c.off()).collect();
        !available.is_empty() && available.iter().all(|c| c.off())
    }

    /// What a runner is running, the Linux one's first.
    pub fn job(&self) -> Option<&Job> {
        self.job.as_ref().or_else(|| self.capabilities.iter().find_map(|c| c.job.as_ref()))
    }

    /// The runner's version, as the tray and the site say it.
    pub fn version(&self) -> Option<String> {
        self.runner_version
            .clone()
            .or_else(|| self.capabilities.iter().find_map(|c| c.runner_version.clone()))
            .or_else(|| self.launcher_version.clone())
    }

    /// What this computer lacks for Linux jobs, by name: none when the
    /// person stopped them.
    pub fn linux_needs(&self) -> Vec<String> {
        let linux = self.linux();
        if linux.off() { vec![] } else { linux.needs }
    }

    /// What is wrong with Linux jobs, in the launcher's words: its error,
    /// else why the capability is unavailable.
    pub fn trouble(&self) -> Option<(String, Option<String>)> {
        let linux = self.linux();
        // Stopped by the person: nothing is wrong with it.
        if linux.off() {
            return None;
        }
        if !linux.available {
            let cause = linux.cause.or_else(|| self.error.clone())?;
            return Some((cause, linux.fix));
        }
        if linux.state == State::Error || self.state == State::Error {
            return Some((self.error.clone().unwrap_or_else(|| "The sandbox stopped, and didn't say why.".into()), None));
        }
        None
    }
}

/// Reads what a launcher command printed: log lines, then the status as
/// one JSON object, which starts on a line of its own. A launcher whose
/// schema is not this app's is not read, nor is a `g1t-runner` from before
/// the launcher, which prints no status at all.
pub fn parse(output: &str) -> Result<Status, String> {
    let start = output
        .match_indices('\n')
        .map(|(at, _)| at + 1)
        .chain(std::iter::once(0))
        .filter(|at| output[*at..].starts_with('{'))
        .max()
        .ok_or_else(|| "this g1t-runner printed no sandbox status: it is older than its sandbox launcher".to_owned())?;
    let status: Status = serde_json::from_str(output[start..].trim()).map_err(|e| format!("the sandbox's status doesn't read: {e}"))?;
    if status.schema != SCHEMA {
        return Err(format!("the sandbox's status is in schema {}, and this g1t reads schema {SCHEMA}: update g1t", status.schema));
    }
    Ok(status)
}

/// Whether a line of a launcher's output starts its status, rather than being a log line.
pub fn starts_status(line: &str) -> bool {
    line.starts_with('{')
}

/// How far the sandbox's image has downloaded, from the launcher's log.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Download {
    /// `wsl-x64`.
    pub key: String,
    pub percent: u8,
}

/// Reads `Fetching the sandbox's wsl-x64 image (612 MB)`, the start of a
/// download, and `Fetching the sandbox's wsl-x64 image: 40% of 612 MB`,
/// each tenth of it (the launcher's image.rs), after the log's time.
pub fn download(line: &str) -> Option<Download> {
    let (_, rest) = line.split_once("Fetching the sandbox's ")?;
    let (key, rest) = rest.split_once(" image")?;
    let percent = match rest.strip_prefix(": ") {
        Some(said) => said.split_once('%')?.0.trim().parse::<u8>().ok()?.min(100),
        None => 0,
    };
    Some(Download { key: key.to_owned(), percent })
}

/// What `up` is told the first time, and again on every start (the
/// launcher keeps what it was told, and `--token` only matters once).
#[derive(Clone, PartialEq, Eq)]
pub struct Up<'a> {
    pub url: &'a str,
    pub name: &'a str,
    pub labels: &'a str,
    /// The registration token: only for a sandbox that has no registration yet.
    pub token: Option<&'a str>,
    /// The kinds of job to start (`--only`): those the person has on.
    pub only: Vec<&'a str>,
}

// Never print a token, in a log or a panic.
impl std::fmt::Debug for Up<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Up")
            .field("url", &self.url)
            .field("name", &self.name)
            .field("labels", &self.labels)
            .field("token", &self.token.map(|_| "…"))
            .field("only", &self.only)
            .finish()
    }
}

fn args(action: &str, dir: &Path) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec!["sandbox".into(), action.into(), "--json".into(), "--state-dir".into()];
    args.push(dir.as_os_str().to_owned());
    args
}

/// `sandbox up`'s arguments. The token is never one of them: anyone on the
/// computer can read a process's command line while it runs, so it goes in
/// `up`'s environment instead ([`with_token`]).
pub fn up_args(dir: &Path, up: &Up) -> Vec<OsString> {
    let mut args = args("up", dir);
    for (name, value) in [("--url", up.url), ("--name", up.name), ("--labels", up.labels)] {
        args.push(name.into());
        args.push(value.into());
    }
    if !up.only.is_empty() {
        args.push("--only".into());
        args.push(up.only.join(",").into());
    }
    args
}

/// Gives a launcher command the registration token, as `G1T_RUNNER_TOKEN`
/// in its environment and nowhere else.
pub fn with_token(command: &mut Command, token: Option<&str>) {
    if let Some(token) = token {
        command.env("G1T_RUNNER_TOKEN", token);
    }
}

/// How `down` stops the sandbox.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Down {
    /// Now: a running job is cut short (as g1t quits, or Stop).
    Now,
    /// After the running job (another way of running jobs was chosen).
    Drain,
    /// Now, and the VM and the registration with it (another workspace or server).
    Delete,
}

pub fn down_args(dir: &Path, how: Down) -> Vec<OsString> {
    let mut args = args("down", dir);
    match how {
        Down::Now => {}
        Down::Drain => args.push("--drain".into()),
        Down::Delete => args.push("--delete".into()),
    }
    args
}

/// `down --only <kind>`: that kind of job stops, and stays off; the others
/// are left as they are. Only for a launcher whose status is [`Status::per_kind`].
pub fn down_only_args(dir: &Path, kind: &str) -> Vec<OsString> {
    let mut args = args("down", dir);
    args.push("--only".into());
    args.push(kind.into());
    args
}

/// `down --only <kind> --drain`: as [`down_only_args`], after the job
/// that kind is running, if any. An update stops a kind this way while
/// its program is replaced, and starts it again after.
pub fn drain_only_args(dir: &Path, kind: &str) -> Vec<OsString> {
    let mut args = down_only_args(dir, kind);
    args.push("--drain".into());
    args
}

pub fn status_args(dir: &Path) -> Vec<OsString> {
    args("status", dir)
}

pub fn update_args(dir: &Path) -> Vec<OsString> {
    args("update", dir)
}

/// A launcher command whose output the app reads a line at a time
/// (`up` and `update`, which take minutes the first time).
pub fn command(binary: &Path, args: Vec<OsString>) -> Command {
    let mut command = quiet(binary);
    // What the app's own environment may have set for another runner is not this one's.
    for (name, _) in std::env::vars_os() {
        if name.to_string_lossy().starts_with("G1T_RUNNER_") {
            command.env_remove(&name);
        }
    }
    command.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    command
}

/// Runs a short launcher command to its end and reads its status, which
/// it prints whether it worked or not.
fn run(binary: &Path, args: Vec<OsString>) -> Result<Status, String> {
    run_done(binary, args).map(|(status, _)| status)
}

/// [`run`], and whether the command did what it was asked (its exit code).
fn run_done(binary: &Path, args: Vec<OsString>) -> Result<(Status, bool), String> {
    let out = command(binary, args).output().map_err(|e| format!("g1t-runner could not start: {e}"))?;
    let printed = String::from_utf8_lossy(&out.stdout);
    match parse(&printed) {
        Ok(status) => Ok((status, out.status.success())),
        Err(_) if !out.status.success() && !out.stderr.is_empty() => Err(String::from_utf8_lossy(&out.stderr).trim().trim_start_matches("g1t-runner: ").to_owned()),
        Err(why) => Err(why),
    }
}

/// How the sandbox is now.
pub fn status(binary: &Path, dir: &Path) -> Result<Status, String> {
    run(binary, status_args(dir))
}

/// Stops the sandbox, waiting for it: how it is now.
pub fn down(binary: &Path, dir: &Path, how: Down) -> Result<Status, String> {
    down_with(binary, down_args(dir, how))
}

/// Stops one kind of job, and keeps it off, waiting for it.
pub fn down_only(binary: &Path, dir: &Path, kind: &str) -> Result<Status, String> {
    down_with(binary, down_only_args(dir, kind))
}

fn down_with(binary: &Path, args: Vec<OsString>) -> Result<Status, String> {
    if !binary.exists() {
        return Err("g1t-runner isn't installed".into());
    }
    match run_done(binary, args)? {
        (status, true) => Ok(status),
        (status, false) => Err(status.error.unwrap_or_else(|| "g1t-runner sandbox down failed.".into())),
    }
}

/// What a launcher's sentence is about: the words the app shows for it
/// are diagnosis.rs's. Read from the causes and errors the launcher
/// writes (crates/runner/src/selfhosted/launcher and native.rs).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Why {
    NoWsl,
    WslMirrored,
    NoVirtualization,
    NoVfkit,
    /// Linux, with neither Sysbox in Docker nor KVM.
    NoSysboxOrKvm,
    /// The newest release is published without the sandbox's images (for
    /// this computer), so there is nothing to download yet.
    NoImages,
    /// The sandbox's image couldn't be downloaded, or isn't the release's.
    Image,
    /// g1t refused the registration token.
    TokenRefused,
    /// g1t no longer knows the runner.
    Forgotten,
    /// The sandbox has no registration, and no token was given.
    Unregistered,
    /// Windows Sandbox is off, or this edition of Windows has none.
    WindowsSandboxOff,
    /// Windows Sandbox without `wsb`, from before Windows 11 24H2.
    NoWsb,
    /// Sandboxed macOS jobs are not released.
    MacNotReleased,
    /// Anything else: shown in the launcher's own words.
    Other,
}

/// The release a "has no sandbox images" sentence names, and the image
/// it lacks when it is only this computer's: `release 0.3.0 has no
/// sandbox image vm-arm64-disk for this machine`.
pub fn missing_images(text: &str) -> Option<(String, Option<String>)> {
    let (before, after) = text.split_once(" has no sandbox image")?;
    let version = before.rsplit("release ").next()?.trim().to_owned();
    let image = after.strip_prefix(' ').and_then(|rest| rest.split_whitespace().next()).map(str::to_owned);
    (!version.is_empty() && !version.contains(' ')).then_some((version, image))
}

pub fn why(text: &str) -> Why {
    let lower = text.to_ascii_lowercase();
    let has = |words: &str| lower.contains(words);
    if has("wsl is not installed") {
        Why::NoWsl
    } else if has("mirrored") {
        Why::WslMirrored
    } else if has("virtualization is not enabled")
        || has("enable virtualization")
        || has("virtual machine platform")
        || has("hcs_e_hyperv_not_installed")
        || has("vt-x")
        || has("hypervisor is not present")
    {
        Why::NoVirtualization
    } else if has("vfkit") && has("not installed") {
        Why::NoVfkit
    } else if has("neither sysbox nor kvm") || has("docker has no sysbox") {
        Why::NoSysboxOrKvm
    } else if has("token") && (has("not valid") || has("expired") || has("invalid")) {
        Why::TokenRefused
    } else if has("no longer knows this runner") || has("was removed from g1t") {
        Why::Forgotten
    } else if has("is not registered") {
        Why::Unregistered
    } else if has("has no sandbox image") {
        Why::NoImages
    } else if has("sandbox image") || has("sandbox's images") || has("no sandbox images") || has("sha-256") || has("signature") || has("release key") || has("could not fetch") || has("broke off") {
        Why::Image
    } else if has("windows sandbox is not turned on") {
        Why::WindowsSandboxOff
    } else if has("24h2") {
        Why::NoWsb
    } else if has("macos jobs are not released") {
        Why::MacNotReleased
    } else {
        Why::Other
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// What `status --json` printed on a Windows 11 Pro machine with WSL
    /// and Windows Sandbox, before `up` (g1t-runner 0.2.1).
    const ABSENT: &str = r#"{
  "schema": 1,
  "state": "absent",
  "backend": "wsl2",
  "runner_version": null,
  "launcher_version": "0.2.1",
  "image_version": null,
  "isolation": "nested-container",
  "job": null,
  "error": null,
  "resources": {
    "cpus": 0,
    "memory_mib": 0,
    "disk_gib": 0
  },
  "capabilities": [
    {
      "id": "linux",
      "available": true,
      "state": "absent",
      "isolation": "nested-container",
      "runner_version": null,
      "job": null,
      "cause": null,
      "fix": null
    },
    {
      "id": "windows",
      "available": true,
      "state": "absent",
      "isolation": "vm",
      "runner_version": null,
      "job": null,
      "cause": null,
      "fix": null
    }
  ],
  "state_dir": "C:\\Users\\syntaqx\\.g1t-runner\\sandbox"
}"#;

    /// The launcher's documented example: running a job, Windows Sandbox off.
    const RUNNING: &str = r#"{
  "schema": 1, "state": "running", "backend": "wsl2",
  "runner_version": "0.3.0", "launcher_version": "0.3.0", "image_version": "0.3.0",
  "isolation": "nested-container",
  "job": { "kind": "workflow", "id": "job_1", "name": "build", "repo": "acme/web" },
  "error": null,
  "resources": { "cpus": 4, "memory_mib": 8192, "disk_gib": 64 },
  "capabilities": [
    { "id": "linux", "available": true, "state": "running", "isolation": "nested-container",
      "runner_version": "0.3.0", "job": { "kind": "workflow", "id": "job_1", "name": "build", "repo": "acme/web" }, "cause": null, "fix": null },
    { "id": "windows", "available": false, "state": "absent", "isolation": "vm",
      "runner_version": null, "job": null,
      "cause": "Windows Sandbox is not turned on, or this edition of Windows has none (Home does not).",
      "fix": "On Windows 11 Pro, Enterprise or Education, turn on Windows Sandbox under Settings, System, Optional features, More Windows features, then restart." }
  ],
  "state_dir": "C:\\Users\\a\\.g1t-runner\\sandbox",
  "something_new": { "a": 1 }
}"#;

    #[test]
    fn a_status_is_read_from_after_the_log() {
        let printed = format!("2026-10-12T08:00:00Z Downloading the sandbox image wsl-x64.\n2026-10-12T08:03:00Z {{not json}}\n{RUNNING}\n");
        let status = parse(&printed).unwrap();
        assert_eq!(status.state, State::Running);
        assert_eq!(status.backend.as_deref(), Some("wsl2"));
        assert_eq!(status.job().map(Job::said).as_deref(), Some("build (acme/web)"));
        assert_eq!(status.version().as_deref(), Some("0.3.0"));
        assert!(status.running());
        assert!(!status.unregistered());
        let windows = status.capability("windows").unwrap();
        assert!(!windows.available);
        assert_eq!(why(windows.cause.as_deref().unwrap()), Why::WindowsSandboxOff);
        assert_eq!(status.trouble(), None);
    }

    #[test]
    fn a_sandbox_never_made_needs_registering() {
        let status = parse(ABSENT).unwrap();
        assert_eq!(status.state, State::Absent);
        assert!(status.anything_available());
        assert!(status.unregistered());
        assert!(!status.running());
        assert_eq!(status.version().as_deref(), Some("0.2.1"));
    }

    #[test]
    fn what_is_not_a_status_is_said_so() {
        assert!(parse("g1t-runner: unknown command sandbox\n").unwrap_err().contains("older than its sandbox launcher"));
        assert!(parse(&ABSENT.replace("\"schema\": 1", "\"schema\": 2")).unwrap_err().contains("schema 2"));
        let unknown = parse(&ABSENT.replace("\"state\": \"absent\",\n  \"backend\"", "\"state\": \"hibernating\",\n  \"backend\"")).unwrap();
        assert_eq!(unknown.state, State::Unknown);
        assert!(starts_status("{") && !starts_status("  \"schema\": 1,"));
    }

    #[test]
    fn without_wsl_linux_says_why_and_nothing_else_can_run_on_home() {
        let status = parse(
            r#"{"schema":1,"state":"error","backend":"wsl2","launcher_version":"0.2.1",
            "error":"WSL is not installed, and the sandbox for Linux jobs is a WSL distribution of its own.",
            "capabilities":[
              {"id":"linux","available":false,"state":"error",
               "cause":"WSL is not installed, and the sandbox for Linux jobs is a WSL distribution of its own.",
               "fix":"Open a terminal as administrator and run `wsl --install --no-distribution`, then restart Windows."},
              {"id":"windows","available":false,"state":"absent","cause":"Windows Sandbox is not turned on, or this edition of Windows has none (Home does not).","fix":"…"}]}"#,
        )
        .unwrap();
        assert!(!status.anything_available());
        let (cause, fix) = status.trouble().unwrap();
        assert_eq!(why(&cause), Why::NoWsl);
        assert!(fix.unwrap().contains(WSL_INSTALL));
    }

    #[test]
    fn the_launchers_sentences_are_told_apart() {
        for (text, expected) in [
            ("WSL is set to mirrored networking, in which Linux reaches this computer's own localhost.", Why::WslMirrored),
            ("WSL could not import the sandbox: Please enable the Virtual Machine Platform Windows feature and ensure virtualization is enabled in the BIOS.", Why::NoVirtualization),
            ("vfkit, which runs the sandbox's VM with Apple's Virtualization framework, is not installed.", Why::NoVfkit),
            ("This machine has neither Sysbox nor KVM, so there is nothing to sandbox the runner with.", Why::NoSysboxOrKvm),
            ("the sandbox image wsl-x64.tar.gz's SHA-256 is not the release's; not using it", Why::Image),
            ("could not fetch https://g1t.sh/downloads/runner/0.3.0/wsl-x64.tar.gz: dns error", Why::Image),
            ("release 0.3.0 has no sandbox images", Why::NoImages),
            ("Windows jobs are sandboxed and running, but Linux jobs are not: release 0.3.0 has no sandbox images", Why::NoImages),
            ("release 0.3.0 has no sandbox image vm-arm64-disk for this machine", Why::NoImages),
            ("The registration token is not valid, or has expired.", Why::TokenRefused),
            ("g1t no longer knows this runner (401 unauthorized). Register it again.", Why::Forgotten),
            ("the sandbox's runner is not registered, and no --url and --token were given", Why::Unregistered),
            ("This Windows has Windows Sandbox but not its command line, wsb, which came in Windows 11 24H2.", Why::NoWsb),
            ("Sandboxed macOS jobs are not released yet.", Why::MacNotReleased),
            ("This user may not use /dev/kvm.", Why::Other),
        ] {
            assert_eq!(why(text), expected, "{text}");
        }
    }

    #[test]
    fn a_kind_turned_off_is_stopped_by_the_person() {
        let status = parse(
            r#"{"schema":1,"state":"stopped","capabilities":[
              {"id":"linux","available":true,"state":"stopped","turned_off":true},
              {"id":"windows","available":true,"state":"absent","turned_off":false}]}"#,
        )
        .unwrap();
        assert!(status.per_kind());
        assert!(status.capability("linux").unwrap().off());
        assert!(!status.all_off());
        assert_eq!(status.trouble(), None);
        // Only Windows, never set up, wants registering; Linux is off.
        assert!(status.unregistered());
        let all = parse(r#"{"schema":1,"state":"stopped","capabilities":[{"id":"linux","available":true,"state":"stopped","turned_off":true},{"id":"windows","available":false,"state":"absent","turned_off":false}]}"#).unwrap();
        assert!(all.all_off());
        assert!(!all.unregistered());
        // A launcher from before `--only` says nothing of it.
        assert!(!parse(RUNNING).unwrap().per_kind());
    }

    #[test]
    fn a_download_says_how_far_it_is() {
        assert_eq!(download("2026-10-12T08:00:00Z Fetching the sandbox's wsl-x64 image (612 MB)"), Some(Download { key: "wsl-x64".into(), percent: 0 }));
        assert_eq!(download("2026-10-12T08:01:00Z Fetching the sandbox's wsl-x64 image: 40% of 612 MB"), Some(Download { key: "wsl-x64".into(), percent: 40 }));
        assert_eq!(download("2026-10-12T08:01:00Z Took build (acme/web)"), None);
        assert_eq!(missing_images("release 0.3.0 has no sandbox images"), Some(("0.3.0".into(), None)));
        assert_eq!(missing_images("Windows jobs are sandboxed and running, but Linux jobs are not: release 0.3.0 has no sandbox images"), Some(("0.3.0".into(), None)));
        assert_eq!(missing_images("release 0.4.0 has no sandbox image vm-arm64-disk for this machine"), Some(("0.4.0".into(), Some("vm-arm64-disk".into()))));
        assert_eq!(missing_images("could not fetch"), None);
    }

    #[test]
    fn the_commands_are_the_launchers() {
        let dir = PathBuf::from("data").join("runner").join(FOLDER);
        let text = |args: Vec<OsString>| args.iter().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>();
        let first = Up { url: "https://g1t.sh", name: "build-box", labels: "desktop", token: Some("g1trt_secret"), only: vec!["linux", "windows"] };
        let up = text(up_args(&dir, &first));
        assert_eq!(&up[..4], ["sandbox", "up", "--json", "--state-dir"]);
        assert_eq!(up[4], dir.to_string_lossy());
        // Never the token: it goes in the environment, out of the process list.
        assert_eq!(&up[5..], ["--url", "https://g1t.sh", "--name", "build-box", "--labels", "desktop", "--only", "linux,windows"]);
        assert_eq!(text(down_only_args(&dir, "windows"))[5..], ["--only", "windows"]);
        assert_eq!(text(drain_only_args(&dir, "windows"))[5..], ["--only", "windows", "--drain"]);
        assert!(!up.iter().any(|a| a == "--token" || a.starts_with("g1trt_")));
        let mut command = command(Path::new("g1t-runner"), up_args(&dir, &first));
        with_token(&mut command, first.token);
        assert!(command.get_envs().any(|(name, value)| name == "G1T_RUNNER_TOKEN" && value == Some(std::ffi::OsStr::new("g1trt_secret"))));
        assert!(!command.get_args().any(|a| a.to_string_lossy().contains("g1trt_")));
        // Its name and labels as the app has them: the launcher adds `-linux` and the OS labels.
        assert!(!up.iter().any(|a| a.ends_with("-linux")));
        let again = text(up_args(&dir, &Up { token: None, only: vec![], ..first.clone() }));
        assert!(!again.iter().any(|a| a == "--only"));
        assert!(!again.iter().any(|a| a == "--token" || a.starts_with("g1trt_")));
        assert!(!format!("{first:?}").contains("g1trt_secret"));
        assert_eq!(text(down_args(&dir, Down::Now))[..3], ["sandbox", "down", "--json"]);
        assert_eq!(text(down_args(&dir, Down::Now)).len(), 5);
        assert_eq!(text(down_args(&dir, Down::Drain)).last().unwrap(), "--drain");
        assert_eq!(text(down_args(&dir, Down::Delete)).last().unwrap(), "--delete");
        assert_eq!(text(status_args(&dir))[..3], ["sandbox", "status", "--json"]);
        assert_eq!(text(update_args(&dir))[..3], ["sandbox", "update", "--json"]);
    }
}
