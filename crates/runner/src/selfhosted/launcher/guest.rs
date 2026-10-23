//! Inside the sandbox's VM: `g1t-runner sandbox guest …`, which the
//! launcher on the computer runs (through `wsl.exe --exec` on Windows, as
//! the VM's systemd service on macOS and Linux).
//!
//! `guest run` is the VM's supervisor. It
//!
//! 1. on WSL, takes away what WSL puts in every distribution that reaches
//!    Windows: `/mnt/wsl` (shared by every distribution, where Docker
//!    Desktop keeps sockets to Windows' Docker), WSLg's display and sound
//!    sockets, Windows' GPU driver folders, and `/dev/dxg`; and checks
//!    `/etc/wsl.conf` is the image's, which turns off drives and Windows
//!    programs ([`WSL_CONF`]);
//! 2. refuses to go on if anything of the computer's is still mounted, or
//!    a container engine's socket other than its own is reachable
//!    ([`problems`]);
//! 3. starts Sysbox and a Docker Engine of the VM's own, and adds rules
//!    that keep every container off the computer's own address (the VM's
//!    gateway) but for DNS ([`firewall_rules`]);
//! 4. runs the runner's image under `--runtime=sysbox-runc` with the
//!    registration on `/var/lib/g1t-sandbox/state`, and keeps saying how
//!    it is in `/var/lib/g1t-sandbox/status.json` (and on the console);
//! 5. on `guest stop` (or SIGTERM), asks the runner to drain or stop,
//!    waits for it, and stops everything.
//!
//! Root in this VM is not a wall on WSL: every WSL distribution, the
//! person's own among them, runs in one VM, and root in any of them can
//! reach the others' disks. That is why the runner runs under Sysbox here
//! and its jobs in containers inside it: a job is two walls from this
//! VM's root, and three from the computer.

use std::net::Ipv4Addr;
use std::path::Path;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::selfhosted::RunnerStatus;

pub const ROOT: &str = "/var/lib/g1t-sandbox";
/// The runner's folder (`/data` in its container): its registration, and
/// the status file it keeps.
pub const STATE_DIR: &str = "/var/lib/g1t-sandbox/state";
pub const SETTINGS: &str = "/var/lib/g1t-sandbox/settings.json";
pub const REGISTER_ENV: &str = "/var/lib/g1t-sandbox/register.env";
pub const STATUS: &str = "/var/lib/g1t-sandbox/status.json";
/// `drain` or `now`: asks the supervisor to stop.
pub const STOP_FILE: &str = "/var/lib/g1t-sandbox/stop";
/// A runner image the launcher put here for the supervisor to load
/// (`sandbox up --runner-image-file`, for a build that is not released).
pub const IMAGE_TAR: &str = "/var/lib/g1t-sandbox/runner-image.tar";
pub const RUN_DIR: &str = "/run/g1t-sandbox";
/// The VM's Docker Engine: not `/var/run/docker.sock`.
pub const DOCKER_SOCKET: &str = "/run/g1t-sandbox/docker.sock";
pub const PID_FILE: &str = "/run/g1t-sandbox/supervisor.pid";
pub const RUNNER_CONTAINER: &str = "g1t-runner";
/// How a status line starts on a VM's console.
pub const STATUS_PREFIX: &str = "G1T-SANDBOX-STATUS ";

/// The image's `/etc/wsl.conf`.
pub const WSL_CONF: &str = include_str!("../../../../../deploy/sandbox/wsl.conf");

/// What WSL mounts into every distribution that reaches Windows or other
/// distributions, taken away at start.
pub const WSL_CHANNELS: &[&str] = &["/mnt/wsl", "/mnt/wslg", "/tmp/.X11-unix", "/usr/lib/wsl/drivers", "/usr/lib/wsl/lib"];

/// What the launcher tells the guest (`guest configure`, or the seed disk).
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Settings {
    /// The site to register with, and a registration token: only until the
    /// runner has registered.
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub group: Option<String>,
    /// The computer's fingerprint (`machine_fingerprint`), which the
    /// runner in the VM can't work out for itself.
    #[serde(default)]
    pub machine: Option<String>,
    /// The runner's container's share of the VM, and so its jobs'.
    #[serde(default)]
    pub cpus: u32,
    #[serde(default)]
    pub memory_mib: u64,
    /// The runner's image, by digest from the signed release.
    #[serde(default)]
    pub runner_image: String,
    #[serde(default)]
    pub image_version: String,
    /// For a VM, how to stop when it is shut down: `drain` or `now`.
    #[serde(default)]
    pub stop: Option<String>,
    /// The sizes of g1t's machines the runner takes jobs for (sizes.rs),
    /// as the launcher keeps them: passed to it as `G1T_RUNNER_SIZES`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sizes: Option<Vec<crate::selfhosted::sizes::SizeChoice>>,
    /// The computer the sandbox is a share of, which the runner can't see:
    /// passed to it as `G1T_RUNNER_COMPUTER`. 0 when unknown.
    #[serde(default)]
    pub computer_cpus: u32,
    #[serde(default)]
    pub computer_memory_mib: u64,
}

/// What `guest status` says, and the launcher reports.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct GuestStatus {
    /// `starting`, `running`, `stopping`, `stopped` or `error`.
    pub state: String,
    #[serde(default)]
    pub runner: Option<RunnerStatus>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub image_version: Option<String>,
    #[serde(default)]
    pub updated_at: String,
}

/// A mount that is the computer's, or WSL's way to it, from
/// `/proc/self/mountinfo`.
pub fn host_mounts(mountinfo: &str) -> Vec<String> {
    let mut found = Vec::new();
    for line in mountinfo.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 5 {
            continue;
        }
        let point = fields[4];
        let fstype = line.split(" - ").nth(1).and_then(|rest| rest.split_whitespace().next()).unwrap_or("");
        let shared_fs = matches!(fstype, "9p" | "drvfs" | "virtiofs" | "vboxsf" | "prl_fs" | "vmhgfs" | "fuse.vmhgfs-fuse" | "smb3" | "cifs");
        let channel = WSL_CHANNELS.iter().any(|c| point == *c || point.starts_with(&format!("{c}/")));
        if shared_fs || channel || point.starts_with("/mnt/") {
            found.push(format!("{point} ({fstype})"));
        }
    }
    found
}

/// What keeps the VM from being a sandbox: mounts of the computer's, an
/// engine socket that is not this VM's own, WSL's interop with Windows.
pub fn problems(mountinfo: &str, sockets: &[String], interop: bool, wsl_conf: Option<&str>) -> Vec<String> {
    let mut problems: Vec<String> = host_mounts(mountinfo).into_iter().map(|m| format!("{m} is mounted from the computer, or is WSL's way to it")).collect();
    for socket in sockets {
        problems.push(format!("{socket} is a container engine's socket that is not this sandbox's own"));
    }
    if interop {
        problems.push("WSL interop is on: Windows programs can be started from inside the sandbox".to_owned());
    }
    if let Some(conf) = wsl_conf
        && conf.trim() != WSL_CONF.trim()
    {
        problems.push("/etc/wsl.conf is not the sandbox image's, which turns off Windows drives and programs".to_owned());
    }
    problems
}

/// The VM's default gateway, which is the computer, from `/proc/net/route`
/// (addresses in little-endian hex).
pub fn gateway(route: &str) -> Option<Ipv4Addr> {
    route.lines().skip(1).find_map(|line| {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() > 2 && fields[1] == "00000000" {
            u32::from_str_radix(fields[2], 16).ok().map(|n| Ipv4Addr::from(n.swap_bytes())).filter(|a| !a.is_unspecified())
        } else {
            None
        }
    })
}

/// The sandbox's `/etc/resolv.conf`: the resolvers WSL offered, else the
/// gateway, which answers DNS on WSL's NAT.
pub fn resolv_conf(offered: &str, gateway: Option<Ipv4Addr>) -> String {
    let mut servers = nameservers(offered);
    if servers.is_empty() {
        servers.extend(gateway);
    }
    servers.iter().map(|s| format!("nameserver {s}\n")).collect()
}

pub fn nameservers(resolv: &str) -> Vec<Ipv4Addr> {
    resolv
        .lines()
        .filter_map(|l| l.trim().strip_prefix("nameserver"))
        .filter_map(|a| a.trim().parse().ok())
        .collect()
}

/// `iptables` arguments, in order, for the `DOCKER-USER` chain, which
/// every container's traffic passes: DNS to the VM's resolvers, and
/// nothing else to the computer's address (the gateway), to a resolver
/// the computer answers on, or to link-local addresses. The internet
/// stays reachable, as a job needs.
pub fn firewall_rules(gateway: Option<Ipv4Addr>, resolvers: &[Ipv4Addr]) -> Vec<Vec<String>> {
    let s = |items: &[&str]| items.iter().map(|i| i.to_string()).collect::<Vec<String>>();
    let mut rules = Vec::new();
    let mut walled: Vec<Ipv4Addr> = gateway.into_iter().collect();
    for resolver in resolvers {
        if resolver.is_loopback() {
            continue;
        }
        let address = resolver.to_string();
        for proto in ["udp", "tcp"] {
            rules.push(s(&["-d", &address, "-p", proto, "--dport", "53", "-j", "ACCEPT"]));
        }
        // A resolver that is the computer, or WSL's DNS tunnel, takes DNS
        // and nothing else.
        if (resolver.is_private() || resolver.is_link_local()) && !walled.contains(resolver) {
            walled.push(*resolver);
        }
    }
    for address in walled {
        rules.push(s(&["-d", &address.to_string(), "-j", "DROP"]));
    }
    rules.push(s(&["-d", "169.254.0.0/16", "-j", "DROP"]));
    rules
}

/// The VM's Docker Engine: Sysbox as a runtime, its own socket, address
/// ranges away from Docker's defaults (the runner's own engine, inside,
/// uses those).
pub fn daemon_json() -> Value {
    json!({
        "hosts": [format!("unix://{DOCKER_SOCKET}")],
        "pidfile": format!("{RUN_DIR}/dockerd.pid"),
        "runtimes": { "sysbox-runc": { "path": "/usr/local/bin/sysbox-runc" } },
        "bip": "172.29.254.1/24",
        "default-address-pools": [{ "base": "172.28.0.0/16", "size": 24 }],
        "log-driver": "json-file",
        "log-opts": { "max-size": "20m", "max-file": "2" },
    })
}

/// The registration's variables, for `register-and-run` in the runner's
/// image: a file, so the token is on no command line.
pub fn register_env(settings: &Settings) -> Result<String> {
    let (Some(url), Some(token)) = (&settings.url, &settings.token) else { bail!("the sandbox's runner is not registered, and no --url and --token were given") };
    let mut lines = vec![format!("G1T_RUNNER_URL={url}"), format!("G1T_RUNNER_TOKEN={token}")];
    if let Some(name) = &settings.name {
        lines.push(format!("G1T_RUNNER_NAME={name}"));
    }
    if !settings.labels.is_empty() {
        lines.push(format!("G1T_RUNNER_LABELS={}", settings.labels.join(",")));
    }
    if let Some(group) = &settings.group {
        lines.push(format!("G1T_RUNNER_GROUP={group}"));
    }
    if let Some(machine) = &settings.machine {
        lines.push(format!("G1T_RUNNER_MACHINE={machine}"));
    }
    if lines.iter().any(|l| l.contains('\n') || l.contains('\r')) {
        bail!("a registration setting has a line break in it");
    }
    Ok(lines.join("\n") + "\n")
}

/// `docker run` for the runner in the VM.
pub fn runner_run_args(settings: &Settings, register: bool) -> Vec<String> {
    sysbox_run_args(settings, RUNNER_CONTAINER, STATE_DIR, register.then_some(REGISTER_ENV))
}

/// `docker run` for the runner: its image under Sysbox, `data` (a folder
/// or a volume) as `/data`, no socket, no host network, its share of the
/// machine, and no self-update (the launcher updates the whole sandbox).
pub fn sysbox_run_args(settings: &Settings, name: &str, data: &str, env_file: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = ["run", "-d", "--name", name, "--runtime=sysbox-runc", "--restart", "on-failure:5"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    if settings.cpus > 0 {
        args.extend(["--cpus".into(), settings.cpus.to_string()]);
    }
    if settings.memory_mib > 0 {
        let memory = format!("{}m", settings.memory_mib);
        args.extend(["--memory".into(), memory.clone(), "--memory-swap".into(), memory]);
    }
    args.extend(["-v".into(), format!("{data}:/data")]);
    args.extend(["-e".into(), "G1T_RUNNER_NO_AUTO_UPDATE=1".into()]);
    if let Some(sizes) = settings.sizes.as_ref().and_then(|s| serde_json::to_string(s).ok()) {
        args.extend(["-e".into(), format!("{}={sizes}", crate::selfhosted::sizes::SIZES_ENV)]);
    }
    if settings.computer_cpus > 0 && settings.computer_memory_mib > 0 {
        args.extend(["-e".into(), format!("{}={},{}", crate::selfhosted::sizes::COMPUTER_ENV, settings.computer_cpus, settings.computer_memory_mib)]);
    }
    if let Some(file) = env_file {
        args.extend(["--env-file".into(), file.into()]);
    }
    args.extend(["--label".into(), "sh.g1t.sandbox=runner".into()]);
    args.push(settings.runner_image.clone());
    args
}

/// Reads a seed disk: JSON, then zeros.
pub fn read_seed(bytes: &[u8]) -> Result<Settings> {
    let end = bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len());
    serde_json::from_slice(&bytes[..end]).context("the seed disk does not read")
}

/// A seed disk's bytes: the settings' JSON, padded to `size`.
pub fn write_seed(settings: &Settings, size: usize) -> Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec(settings)?;
    if bytes.len() >= size {
        bail!("the sandbox's settings do not fit its seed disk");
    }
    bytes.resize(size, 0);
    Ok(bytes)
}

/// The last status line on a VM's console.
pub fn status_from_console(log: &str) -> Option<GuestStatus> {
    log.lines().rev().find_map(|line| line.split_once(STATUS_PREFIX).and_then(|(_, json)| serde_json::from_str(json.trim()).ok()))
}

fn read_json<T: for<'a> Deserialize<'a>>(path: &str) -> Option<T> {
    std::fs::read(path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

fn write_private(path: &str, bytes: &[u8]) -> Result<()> {
    let temp = format!("{path}.new");
    std::fs::write(&temp, bytes).with_context(|| format!("could not write {temp}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&temp, path).with_context(|| format!("could not write {path}"))?;
    Ok(())
}

fn registered() -> bool {
    Path::new(STATE_DIR).join("config.json").exists()
}

/// `g1t-runner sandbox guest <command>`.
pub fn main(args: &[String]) -> Result<()> {
    let command = args.first().map(String::as_str).unwrap_or("");
    let value = |name: &str| args.windows(2).find(|w| w[0] == name).map(|w| w[1].clone());
    match command {
        "configure" => configure(&read_stdin()?),
        "status" => {
            println!("{}", serde_json::to_string(&current_status())?);
            Ok(())
        }
        "export-state" => {
            use std::io::Write;
            let bytes = std::fs::read(Path::new(STATE_DIR).join("config.json")).context("the sandbox's runner is not registered")?;
            std::io::stdout().write_all(&bytes)?;
            Ok(())
        }
        "import-state" => {
            std::fs::create_dir_all(STATE_DIR)?;
            let bytes = read_stdin()?;
            serde_json::from_slice::<Value>(&bytes).context("that is not a runner's configuration")?;
            write_private(&format!("{STATE_DIR}/config.json"), &bytes)
        }
        "load-image" => {
            std::fs::create_dir_all(ROOT)?;
            let bytes = read_stdin()?;
            write_private(IMAGE_TAR, &bytes)
        }
        "check" => {
            let found = check();
            if found.is_empty() {
                println!("Nothing of the computer's reaches this sandbox.");
                Ok(())
            } else {
                bail!("this sandbox can reach the computer:\n  - {}", found.join("\n  - "))
            }
        }
        "stop" => stop(if args.iter().any(|a| a == "--now") { "now" } else { "drain" }, value("--wait").and_then(|w| w.parse().ok())),
        "run" => run(value("--seed"), value("--state-disk"), value("--console")),
        _ => bail!("guest takes configure, run, status, stop, check, export-state, import-state or load-image"),
    }
}

fn read_stdin() -> Result<Vec<u8>> {
    use std::io::Read;
    let mut bytes = Vec::new();
    std::io::stdin().read_to_end(&mut bytes)?;
    // Windows' tools may put a byte-order mark before JSON.
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        bytes.drain(..3);
    }
    Ok(bytes)
}

/// Keeps what the launcher sent, over what was there: a token only until
/// the runner has registered.
fn configure(bytes: &[u8]) -> Result<()> {
    let given: Settings = serde_json::from_slice(bytes).context("the sandbox's settings do not read")?;
    std::fs::create_dir_all(STATE_DIR)?;
    let mut settings: Settings = read_json(SETTINGS).unwrap_or_default();
    if given.url.is_some() {
        settings.url = given.url;
    }
    if given.token.is_some() && !registered() {
        settings.token = given.token;
    }
    if given.name.is_some() {
        settings.name = given.name;
    }
    if !given.labels.is_empty() {
        settings.labels = given.labels;
    }
    if given.group.is_some() {
        settings.group = given.group;
    }
    if given.machine.is_some() {
        settings.machine = given.machine;
    }
    if given.cpus > 0 {
        settings.cpus = given.cpus;
    }
    if given.memory_mib > 0 {
        settings.memory_mib = given.memory_mib;
    }
    if !given.runner_image.is_empty() {
        settings.runner_image = given.runner_image;
    }
    if !given.image_version.is_empty() {
        settings.image_version = given.image_version;
    }
    if given.sizes.is_some() {
        settings.sizes = given.sizes;
    }
    if given.computer_cpus > 0 {
        (settings.computer_cpus, settings.computer_memory_mib) = (given.computer_cpus, given.computer_memory_mib);
    }
    write_private(SETTINGS, &serde_json::to_vec_pretty(&settings)?)
}

/// The supervisor's status, or `stopped` when it is not running.
fn current_status() -> GuestStatus {
    let status: Option<GuestStatus> = read_json(STATUS);
    let alive = supervisor_alive();
    match status {
        Some(status) if alive || status.state == "error" || status.state == "stopped" => status,
        Some(status) => GuestStatus { state: "stopped".into(), ..status },
        None => GuestStatus { state: "stopped".into(), ..GuestStatus::default() },
    }
}

fn supervisor_alive() -> bool {
    std::fs::read_to_string(PID_FILE)
        .ok()
        .and_then(|p| p.trim().parse::<u32>().ok())
        .is_some_and(|pid| Path::new(&format!("/proc/{pid}")).exists())
}

/// What reaches the computer from here, now.
pub fn check() -> Vec<String> {
    let mountinfo = std::fs::read_to_string("/proc/self/mountinfo").unwrap_or_default();
    let mut sockets = Vec::new();
    // `/var/run` is `/run`.
    for dir in ["/mnt", "/run", "/tmp"] {
        find_sockets(Path::new(dir), 3, &mut sockets);
    }
    let sockets: Vec<String> = sockets.into_iter().filter(|s| !own_socket(s)).collect();
    let on_wsl = on_wsl();
    // With interop off, WSL starts no interop server for the distribution's
    // processes, and `WSL_INTEROP` names none.
    let interop = on_wsl && std::env::var_os("WSL_INTEROP").is_some();
    let conf = on_wsl.then(|| std::fs::read_to_string("/etc/wsl.conf").unwrap_or_default());
    problems(&mountinfo, &sockets, interop, conf.as_deref())
}

/// The sandbox's own engine's sockets, and the containerd and Sysbox it
/// runs.
pub fn own_socket(path: &str) -> bool {
    [RUN_DIR, "/run/docker/", "/run/containerd/", "/run/sysbox/"].iter().any(|own| path.starts_with(own))
}

#[cfg_attr(not(unix), allow(clippy::only_used_in_recursion))]
fn find_sockets(dir: &Path, depth: u32, found: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        let path = entry.path();
        #[cfg(unix)]
        {
            use std::os::unix::fs::FileTypeExt;
            if kind.is_socket() {
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if ["docker.sock", "containerd.sock", "podman.sock", "docker.proxy.sock", "backend.sock", "filesystem.sock"].contains(&name) {
                    found.push(path.display().to_string());
                }
                continue;
            }
        }
        if kind.is_dir() && depth > 0 {
            find_sockets(&path, depth - 1, found);
        }
    }
}

fn on_wsl() -> bool {
    std::env::var_os("WSL_DISTRO_NAME").is_some() || Path::new("/proc/sys/fs/binfmt_misc/WSLInterop").exists() || Path::new("/run/WSL").exists()
}

/// Asks the supervisor to stop (`drain`: once the runner's job is done),
/// and waits up to `wait` seconds for it, or forever.
fn stop(mode: &str, wait: Option<u64>) -> Result<()> {
    if !supervisor_alive() {
        return Ok(());
    }
    std::fs::write(STOP_FILE, mode)?;
    let until = wait.map(|w| std::time::Instant::now() + std::time::Duration::from_secs(w));
    while supervisor_alive() {
        if until.is_some_and(|u| std::time::Instant::now() > u) {
            bail!("the sandbox is still stopping");
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn run(_seed: Option<String>, _state_disk: Option<String>, _console: Option<String>) -> Result<()> {
    bail!("the sandbox's supervisor runs inside its Linux VM")
}

#[cfg(target_os = "linux")]
fn run(seed: Option<String>, state_disk: Option<String>, console: Option<String>) -> Result<()> {
    supervisor::run(seed, state_disk, console)
}

#[cfg(target_os = "linux")]
mod supervisor {
    use std::path::Path;
    use std::process::{Child, Command, Stdio};
    use std::sync::atomic::Ordering;
    use std::time::{Duration, Instant};

    use anyhow::{Context, Result, bail};

    use super::*;
    use crate::selfhosted::{STOP, g1t_now};

    extern "C" fn on_term(_: libc::c_int) {
        STOP.store(true, Ordering::SeqCst);
    }

    fn now() -> String {
        g1t_now(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0))
    }

    /// A clean environment: WSL's session points `XDG_RUNTIME_DIR` and
    /// the display variables into /mnt/wslg, which is gone.
    fn clean(command: &mut Command) -> &mut Command {
        command.env_clear().env("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin").env("HOME", "/root")
    }

    fn docker() -> Command {
        let mut command = Command::new("docker");
        clean(&mut command).env("DOCKER_HOST", format!("unix://{DOCKER_SOCKET}"));
        command
    }

    fn ok(command: &mut Command) -> bool {
        command.stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
    }

    struct Say {
        console: Option<String>,
        version: Option<String>,
    }

    impl Say {
        fn status(&self, state: &str, runner: Option<RunnerStatus>, error: Option<String>) {
            let status = GuestStatus { state: state.into(), runner, error, image_version: self.version.clone(), updated_at: now() };
            let Ok(bytes) = serde_json::to_vec(&status) else { return };
            let _ = write_private(STATUS, &bytes);
            if let Some(console) = &self.console {
                let _ = std::fs::OpenOptions::new()
                    .append(true)
                    .open(console)
                    .and_then(|mut c| std::io::Write::write_all(&mut c, format!("{STATUS_PREFIX}{}\n", String::from_utf8_lossy(&bytes)).as_bytes()));
            }
        }
    }

    fn daemon(program: &str, args: &[&str], log: &str) -> Result<Child> {
        let out = std::fs::File::create(format!("{RUN_DIR}/{log}"))?;
        let mut command = Command::new(program);
        clean(&mut command)
            .args(args)
            .stdout(out.try_clone()?)
            .stderr(out)
            .stdin(Stdio::null())
            .spawn()
            .with_context(|| format!("could not start {program}"))
    }

    fn wait_for(what: &str, limit: Duration, mut ready: impl FnMut() -> bool) -> Result<()> {
        let until = Instant::now() + limit;
        while !ready() {
            if Instant::now() > until {
                bail!("{what} did not start");
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        Ok(())
    }

    /// WSL's ways to Windows and to other distributions, taken away.
    fn wsl_prepare() -> Result<()> {
        // The resolvers WSL offers (its DNS tunnel, or the gateway), in a
        // file of the sandbox's own: WSL's is in /mnt/wsl, unmounted next.
        let offered = ["/mnt/wsl/resolv.conf", "/etc/resolv.conf"].iter().find_map(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
        let route = std::fs::read_to_string("/proc/net/route").unwrap_or_default();
        let _ = std::fs::remove_file("/etc/resolv.conf");
        std::fs::write("/etc/resolv.conf", resolv_conf(&offered, gateway(&route)))?;
        for point in WSL_CHANNELS {
            let _ = Command::new("umount").args(["-R", "-l", point]).stdout(Stdio::null()).stderr(Stdio::null()).status();
        }
        // The GPU's paravirtual device: a way to Windows' driver.
        let _ = std::fs::remove_file("/dev/dxg");
        Ok(())
    }

    fn mount_state_disk(device: &str) -> Result<()> {
        std::fs::create_dir_all(STATE_DIR)?;
        let blank = !Command::new("blkid").arg(device).output().is_ok_and(|o| o.status.success() && !o.stdout.is_empty());
        if blank && !ok(Command::new("mkfs.ext4").args(["-q", "-L", "g1t-state", device])) {
            bail!("could not format the state disk {device}");
        }
        if !ok(Command::new("mount").args([device, STATE_DIR])) {
            bail!("could not mount the state disk {device}");
        }
        Ok(())
    }

    fn read_seed_device(device: &str) -> Result<Settings> {
        // The launcher may have rewritten it since boot: read past the cache.
        let _ = Command::new("blockdev").args(["--flushbufs", device]).status();
        let bytes = std::fs::read(device).with_context(|| format!("could not read the seed disk {device}"))?;
        read_seed(&bytes)
    }

    fn firewall() -> Result<()> {
        let route = std::fs::read_to_string("/proc/net/route").unwrap_or_default();
        let resolv = std::fs::read_to_string("/etc/resolv.conf").unwrap_or_default();
        let rules = firewall_rules(gateway(&route), &nameservers(&resolv));
        let _ = Command::new("iptables").args(["-N", "DOCKER-USER"]).stderr(Stdio::null()).status();
        // Only these rules, however many times the sandbox has started.
        let _ = Command::new("iptables").args(["-F", "DOCKER-USER"]).status();
        // Inserted last first, so they end up in order at the chain's top.
        for (at, rule) in rules.iter().enumerate() {
            let position = (at + 1).to_string();
            let mut args = vec!["-I", "DOCKER-USER", position.as_str()];
            args.extend(rule.iter().map(String::as_str));
            if !ok(Command::new("iptables").args(&args)) {
                bail!("could not add the rule that keeps containers off the computer: iptables {}", args.join(" "));
            }
        }
        Ok(())
    }

    fn container_state() -> Option<(bool, i32)> {
        let out = docker().args(["inspect", "-f", "{{.State.Running}} {{.State.ExitCode}}", RUNNER_CONTAINER]).output().ok()?;
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let mut parts = text.split_whitespace();
        Some((parts.next() == Some("true"), parts.next().and_then(|c| c.parse().ok()).unwrap_or(0)))
    }

    /// The runner's last words: its last line of output.
    fn logs_tail() -> String {
        docker()
            .args(["logs", "--tail", "1", RUNNER_CONTAINER])
            .output()
            .map(|o| format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr)).trim().to_owned())
            .unwrap_or_default()
            .trim_start_matches("g1t-runner: ")
            .to_owned()
    }

    fn start_runner(settings: &Settings) -> Result<()> {
        if let Some((true, _)) = container_state() {
            return Ok(());
        }
        let _ = docker().args(["rm", "-f", RUNNER_CONTAINER]).stdout(Stdio::null()).stderr(Stdio::null()).status();
        // What an earlier runner said is not what this one says.
        let _ = std::fs::remove_file(format!("{STATE_DIR}/status.json"));
        let register = !registered();
        if register {
            write_private(REGISTER_ENV, register_env(settings)?.as_bytes())?;
        }
        let out = docker().args(runner_run_args(settings, register)).output().context("could not run docker")?;
        if !out.status.success() {
            bail!("could not start the runner: {}", String::from_utf8_lossy(&out.stderr).trim());
        }
        Ok(())
    }

    pub fn run(seed: Option<String>, state_disk: Option<String>, console: Option<String>) -> Result<()> {
        unsafe {
            libc::signal(libc::SIGTERM, on_term as *const () as libc::sighandler_t);
            libc::signal(libc::SIGINT, on_term as *const () as libc::sighandler_t);
        }
        std::fs::create_dir_all(RUN_DIR)?;
        std::fs::create_dir_all(ROOT)?;
        std::fs::write(PID_FILE, std::process::id().to_string())?;
        let _ = std::fs::remove_file(STOP_FILE);
        let version = std::fs::read_to_string("/etc/g1t-sandbox-version").ok().map(|v| v.trim().to_owned());
        let say = Say { console, version };
        say.status("starting", None, None);
        let outcome = supervise(&say, seed, state_disk);
        if let Err(error) = &outcome {
            say.status("error", None, Some(format!("{error:#}")));
        }
        let _ = std::fs::remove_file(PID_FILE);
        outcome
    }

    fn supervise(say: &Say, seed: Option<String>, state_disk: Option<String>) -> Result<()> {
        if on_wsl() {
            wsl_prepare()?;
        }
        if let Some(device) = &state_disk {
            // A VM's system disk was grown to the size asked for: its file
            // system grows to fill it.
            let _ = Command::new("resize2fs").arg("/dev/vda").stdout(Stdio::null()).stderr(Stdio::null()).status();
            mount_state_disk(device)?;
        }
        std::fs::create_dir_all(STATE_DIR)?;
        if let Some(device) = &seed {
            let settings = read_seed_device(device)?;
            configure(&serde_json::to_vec(&settings)?)?;
        }
        let found = check();
        if !found.is_empty() {
            bail!("this sandbox can reach the computer, so it will not run jobs:\n  - {}", found.join("\n  - "));
        }
        let settings: Settings = read_json(SETTINGS).context("the sandbox has no settings: run `g1t-runner sandbox up` on the computer")?;
        if settings.runner_image.is_empty() {
            bail!("the sandbox's settings name no runner image");
        }

        let mut daemons: Vec<Child> = Vec::new();
        let _ = std::fs::remove_file("/run/sysbox/sysmgr.sock");
        daemons.push(daemon("sysbox-mgr", &[], "sysbox-mgr.log")?);
        wait_for("Sysbox's manager", Duration::from_secs(30), || Path::new("/run/sysbox/sysmgr.sock").exists())?;
        daemons.push(daemon("sysbox-fs", &[], "sysbox-fs.log")?);
        wait_for("Sysbox's file system", Duration::from_secs(30), || Path::new("/run/sysbox/sysfs.sock").exists())?;
        std::fs::write("/etc/docker/daemon.json", serde_json::to_vec_pretty(&daemon_json())?)?;
        daemons.push(daemon("dockerd", &[], "dockerd.log")?);
        let outcome = (|| -> Result<()> {
            wait_for("The sandbox's Docker Engine", Duration::from_secs(60), || ok(docker().args(["version"])))?;
            firewall()?;
            if Path::new(IMAGE_TAR).exists() {
                let loaded = docker().args(["load", "-i", IMAGE_TAR]).stdout(Stdio::null()).status();
                let _ = std::fs::remove_file(IMAGE_TAR);
                if !loaded.is_ok_and(|s| s.success()) {
                    bail!("could not load the runner image the launcher gave");
                }
            }
            if !ok(docker().args(["image", "inspect", &settings.runner_image])) && !ok(docker().args(["pull", "-q", &settings.runner_image])) {
                bail!("could not fetch the runner's image {}", settings.runner_image);
            }
            start_runner(&settings)?;
            watch(say)
        })();
        // Everything stops with the supervisor; the runner first, so it can
        // say how its job ended.
        let _ = docker().args(["stop", "-t", "60", RUNNER_CONTAINER]).stdout(Stdio::null()).stderr(Stdio::null()).status();
        for child in daemons.iter_mut().rev() {
            unsafe {
                libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
            }
            let until = Instant::now() + Duration::from_secs(20);
            while matches!(child.try_wait(), Ok(None)) && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(200));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
        if outcome.is_ok() {
            say.status("stopped", None, None);
        }
        outcome
    }

    /// Says how the runner is until asked to stop, then stops it.
    fn watch(say: &Say) -> Result<()> {
        let data = Path::new(STATE_DIR);
        let mut asked: Option<String> = None;
        let mut tried_again = Instant::now();
        loop {
            if asked.is_none() {
                let mode = std::fs::read_to_string(STOP_FILE).ok().map(|m| m.trim().to_owned());
                asked = mode.or_else(|| STOP.load(Ordering::SeqCst).then(|| read_json::<Settings>(SETTINGS).and_then(|s| s.stop).unwrap_or_else(|| "now".into())));
                if let Some(mode) = &asked {
                    // The runner reads these in its folder (selfhosted/mod.rs).
                    std::fs::write(data.join(if mode == "drain" { "drain" } else { "stop" }), "")?;
                }
            }
            if registered() && Path::new(REGISTER_ENV).exists() {
                // Registered: the token is no longer kept.
                let _ = std::fs::remove_file(REGISTER_ENV);
                if let Some(mut settings) = read_json::<Settings>(SETTINGS) {
                    settings.token = None;
                    let _ = write_private(SETTINGS, &serde_json::to_vec_pretty(&settings)?);
                }
            }
            let runner: Option<RunnerStatus> = read_json(&format!("{STATE_DIR}/status.json"));
            match container_state() {
                Some((true, _)) => {
                    let state = if asked.is_some() { "stopping" } else { "running" };
                    say.status(state, runner, None);
                }
                Some((false, code)) if asked.is_some() || code == 0 => {
                    let _ = std::fs::remove_file(data.join("stop"));
                    let _ = std::fs::remove_file(data.join("drain"));
                    return Ok(());
                }
                Some((false, code)) => {
                    say.status("error", runner, Some(format!("The runner stopped ({code}): {}", logs_tail())));
                    if tried_again.elapsed() > Duration::from_secs(30) {
                        tried_again = Instant::now();
                        let _ = docker().args(["start", RUNNER_CONTAINER]).stdout(Stdio::null()).stderr(Stdio::null()).status();
                    }
                }
                None => bail!("the runner's container is gone"),
            }
            std::thread::sleep(Duration::from_secs(2));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WSL_MOUNTINFO: &str = "\
353 361 0:29 / /usr/lib/modules/6.6.87.2-microsoft-standard-WSL2 rw,nosuid,nodev,noatime - overlay none rw,lowerdir=/modules
354 361 0:32 / /mnt/wsl rw,relatime shared:1 - tmpfs none rw
355 354 0:61 /guest-services /mnt/wsl/docker-desktop/shared-sockets/guest-services rw,nosuid,nodev shared:18 - tmpfs none rw,mode=755
358 361 0:34 / /usr/lib/wsl/drivers ro,nosuid,nodev,noatime - 9p drivers ro,aname=drivers;fmask=222;dmask=222
361 343 8:96 / / rw,relatime - ext4 /dev/sdg rw,discard,errors=remount-ro,data=ordered
362 361 0:87 / /mnt/wslg rw,relatime shared:32 - tmpfs none rw
389 361 0:104 / /usr/lib/wsl/lib rw,nosuid,nodev,noatime - overlay none rw,lowerdir=/gpu_lib_packaged:/gpu_lib_inbox
393 361 0:108 / /proc rw,nosuid,nodev,noexec,noatime shared:46 - proc proc rw
411 361 0:87 /.X11-unix /tmp/.X11-unix ro,relatime shared:32 - tmpfs none rw
";

    const CLEAN: &str = "\
361 343 8:96 / / rw,relatime - ext4 /dev/sdg rw,discard,errors=remount-ro,data=ordered
393 361 0:108 / /proc rw,nosuid,nodev,noexec,noatime shared:46 - proc proc rw
395 361 0:110 / /run rw,nosuid,nodev shared:48 - tmpfs none rw,mode=755
";

    #[test]
    fn what_wsl_mounts_is_found_and_a_cleaned_distribution_is_clean() {
        let found = host_mounts(WSL_MOUNTINFO);
        for point in ["/mnt/wsl ", "/mnt/wsl/docker-desktop", "/usr/lib/wsl/drivers", "/mnt/wslg", "/usr/lib/wsl/lib", "/tmp/.X11-unix"] {
            assert!(found.iter().any(|f| f.starts_with(point)), "{point} in {found:?}");
        }
        assert!(!found.iter().any(|f| f.starts_with("/usr/lib/modules")));
        assert!(host_mounts(CLEAN).is_empty());
        let drive = "500 361 0:90 / /mnt/c rw,noatime - 9p C:\\ rw,aname=drvfs;path=C:\\";
        assert_eq!(host_mounts(drive), vec!["/mnt/c (9p)".to_owned()]);
        assert_eq!(host_mounts("501 361 0:91 / /work rw - virtiofs share rw").len(), 1);
    }

    #[test]
    fn the_sandbox_refuses_what_reaches_the_computer() {
        assert!(problems(CLEAN, &[], false, Some(WSL_CONF)).is_empty());
        assert!(problems(CLEAN, &[], false, None).is_empty());
        let all = problems(WSL_MOUNTINFO, &["/mnt/wsl/docker-desktop/shared-sockets/host-services/docker.proxy.sock".into()], true, Some("[automount]\nenabled=true\n"));
        assert!(all.iter().any(|p| p.contains("docker.proxy.sock")));
        assert!(all.iter().any(|p| p.contains("interop is on")));
        assert!(all.iter().any(|p| p.contains("/etc/wsl.conf")));
    }

    #[test]
    fn the_image_turns_off_every_way_to_windows() {
        let conf = WSL_CONF.replace(' ', "");
        for setting in ["[automount]\nenabled=false", "mountFsTab=false", "[interop]\nenabled=false", "appendWindowsPath=false", "[user]\ndefault=sandbox"] {
            assert!(conf.contains(setting), "{setting}");
        }
        // What opens the distribution without naming a user is not root;
        // the launcher names root on every call (wsl.rs).
        assert!(!conf.contains("default=root"));
        let dockerfile = include_str!("../../../../../deploy/sandbox/Dockerfile");
        assert!(dockerfile.contains("useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin sandbox"));
        assert!(dockerfile.contains("passwd --lock sandbox"));
    }

    #[test]
    fn the_gateway_and_resolvers_read() {
        let route = "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n\
eth0\t00000000\t01E01EAC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n\
eth0\t00E01EAC\t00000000\t0001\t0\t0\t0\t00F0FFFF\t0\t0\t0\n";
        assert_eq!(gateway(route), Some(Ipv4Addr::new(172, 30, 224, 1)));
        assert_eq!(gateway("Iface\tDestination\n"), None);
        assert_eq!(nameservers("# x\nnameserver 10.255.255.254\nsearch lan\nnameserver ::1\n"), vec![Ipv4Addr::new(10, 255, 255, 254)]);
        assert_eq!(resolv_conf("nameserver 10.255.255.254\n", None), "nameserver 10.255.255.254\n");
        assert_eq!(resolv_conf("", Some(Ipv4Addr::new(172, 30, 224, 1))), "nameserver 172.30.224.1\n");
    }

    #[test]
    fn containers_get_dns_and_nothing_else_of_the_computer() {
        let gw = Ipv4Addr::new(172, 30, 224, 1);
        let rules = firewall_rules(Some(gw), &[Ipv4Addr::new(10, 255, 255, 254), Ipv4Addr::new(1, 1, 1, 1), Ipv4Addr::LOCALHOST]);
        let text: Vec<String> = rules.iter().map(|r| r.join(" ")).collect();
        assert_eq!(text[0], "-d 10.255.255.254 -p udp --dport 53 -j ACCEPT");
        assert!(text.contains(&"-d 1.1.1.1 -p tcp --dport 53 -j ACCEPT".to_owned()));
        let first_drop = text.iter().position(|r| r.ends_with("DROP")).unwrap();
        assert!(text[..first_drop].iter().all(|r| r.ends_with("ACCEPT")), "accepts come first: {text:?}");
        assert!(text.contains(&"-d 172.30.224.1 -j DROP".to_owned()));
        assert!(text.contains(&"-d 10.255.255.254 -j DROP".to_owned()));
        assert!(!text.contains(&"-d 1.1.1.1 -j DROP".to_owned()), "a public resolver is the internet");
        assert!(!text.iter().any(|r| r.contains("127.0.0.1")));
        assert_eq!(text.last().unwrap(), "-d 169.254.0.0/16 -j DROP");
    }

    #[test]
    fn the_runner_is_told_its_sizes_and_the_computer_its_share_is_of() {
        use crate::selfhosted::sizes::SizeChoice;
        let plain = runner_run_args(&Settings::default(), false).join(" ");
        assert!(!plain.contains("G1T_RUNNER_SIZES") && !plain.contains("G1T_RUNNER_COMPUTER"), "a launcher that says nothing");
        let settings = Settings { sizes: Some(vec![SizeChoice::Key("2-core".into())]), computer_cpus: 16, computer_memory_mib: 32768, ..Settings::default() };
        let args = runner_run_args(&settings, false);
        assert!(args.contains(&r#"G1T_RUNNER_SIZES=["2-core"]"#.to_owned()), "{args:?}");
        assert!(args.contains(&"G1T_RUNNER_COMPUTER=16,32768".to_owned()));
    }

    #[test]
    fn the_runner_runs_under_sysbox_with_no_socket_and_no_self_update() {
        let settings = Settings { cpus: 4, memory_mib: 8192, runner_image: "g1t.sh/flagon-io/g1t-runner@sha256:ab".into(), ..Settings::default() };
        let args = runner_run_args(&settings, false).join(" ");
        assert!(args.starts_with("run -d --name g1t-runner --runtime=sysbox-runc"));
        assert!(args.contains("--cpus 4 --memory 8192m --memory-swap 8192m"));
        assert!(args.contains("-v /var/lib/g1t-sandbox/state:/data"));
        assert!(args.contains("G1T_RUNNER_NO_AUTO_UPDATE=1"));
        assert!(!args.contains("docker.sock") && !args.contains("--privileged") && !args.contains("--network host"));
        assert!(!args.contains("--env-file"));
        assert!(args.ends_with("g1t.sh/flagon-io/g1t-runner@sha256:ab"));
        assert!(runner_run_args(&settings, true).join(" ").contains("--env-file /var/lib/g1t-sandbox/register.env"));
    }

    #[test]
    fn registration_goes_by_file_and_refuses_line_breaks() {
        let mut settings = Settings {
            url: Some("https://g1t.sh".into()),
            token: Some("g1trt_x".into()),
            name: Some("box-linux".into()),
            labels: vec!["gpu".into()],
            ..Settings::default()
        };
        let env = register_env(&settings).unwrap();
        assert_eq!(env, "G1T_RUNNER_URL=https://g1t.sh\nG1T_RUNNER_TOKEN=g1trt_x\nG1T_RUNNER_NAME=box-linux\nG1T_RUNNER_LABELS=gpu\n");
        // The computer's fingerprint, which the runner in the VM can't work out.
        settings.machine = Some("ab".repeat(32));
        assert!(register_env(&settings).unwrap().ends_with(&format!("G1T_RUNNER_MACHINE={}\n", "ab".repeat(32))));
        settings.name = Some("a\nG1T_RUNNER_URL=https://evil".into());
        assert!(register_env(&settings).is_err());
        assert!(register_env(&Settings::default()).is_err());
    }

    #[test]
    fn a_seed_disk_and_a_console_line_round_trip() {
        let settings = Settings { runner_image: "img".into(), cpus: 2, stop: Some("drain".into()), ..Settings::default() };
        let bytes = write_seed(&settings, 4096).unwrap();
        assert_eq!(bytes.len(), 4096);
        assert_eq!(read_seed(&bytes).unwrap(), settings);
        assert!(write_seed(&settings, 8).is_err());
        let log = format!("[    1.0] booting\n{STATUS_PREFIX}{{\"state\":\"starting\"}}\nnoise\n{STATUS_PREFIX}{{\"state\":\"running\",\"updated_at\":\"t\"}}\n");
        assert_eq!(status_from_console(&log).unwrap().state, "running");
        assert!(status_from_console("nothing").is_none());
    }

    #[test]
    fn the_vm_engine_has_sysbox_and_its_own_socket() {
        let config = daemon_json();
        assert_eq!(config["hosts"][0], "unix:///run/g1t-sandbox/docker.sock");
        assert_eq!(config["runtimes"]["sysbox-runc"]["path"], "/usr/local/bin/sysbox-runc");
    }
}
