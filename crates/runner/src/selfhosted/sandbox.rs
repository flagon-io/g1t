//! How the runner keeps work from the machine it is on, and what it checks
//! before it takes any.
//!
//! The goal is two walls: the runner in a sandbox of its own, away from
//! its machine, and each job in a fresh sandbox of its own inside that,
//! made for the job and destroyed after. Where the runner stands today:
//!
//! | Isolation | How | Wall from the machine |
//! | --- | --- | --- |
//! | `nested-container` | The runner is a container under Sysbox (`docker run --runtime=sysbox-runc`), with its own Docker Engine inside; each job is a container on that engine. On a desktop, `g1t-runner sandbox up` runs exactly this inside a Linux VM of the runner's own (launcher/). | Two: the job's container, then the runner's, whose root is no one on the machine; a third, the VM, under `sandbox up`. |
//! | `vm` | Jobs native to the machine's OS, each in a throwaway VM: Windows Sandbox on Windows, a cloned macOS VM on a Mac (native.rs). The runner stays on the machine and only makes and destroys those VMs. | One, a hypervisor: the job's VM, which gets no folder of the machine's but a read-only copy of the harness. |
//! | `container` | The runner drives a Docker Engine it shares with the machine (installed on it, or a container with the machine's Docker socket); each job is a container on it. | One: the job's container. The runner itself can do anything the machine's Docker can, which is everything. |
//! | `host` | `--no-docker`: each job is a process on the machine, in a folder of its own. Deprecated. | None. |
//!
//! [`SandboxDriver`] is what makes a job's sandbox. [`NestedDocker`] (and
//! [`SharedDocker`], the same on a shared engine) is built: exec.rs runs
//! jobs through it. For jobs native to the machine's OS,
//! [`super::native::WindowsSandbox`] is built and runs on Windows 11 Pro,
//! Enterprise and Education; [`super::native::MacVm`] is designed, its
//! commands built and tested, and not yet run on a Mac.

use std::path::Path;

use anyhow::{Result, bail};

/// How well a runner keeps work from its machine, as it tells g1t when it
/// registers (`isolation`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Isolation {
    /// A container per job, inside the runner's own sandboxed container.
    NestedContainer,
    /// A throwaway VM per job, native to the machine's OS (native.rs).
    Vm,
    /// A container per job, on a Docker Engine shared with the machine.
    Container,
    /// Directly on the machine.
    Host,
}

impl Isolation {
    pub fn as_str(self) -> &'static str {
        match self {
            Isolation::NestedContainer => "nested-container",
            Isolation::Vm => "vm",
            Isolation::Container => "container",
            Isolation::Host => "host",
        }
    }

    /// For the log at start.
    pub fn describe(self) -> &'static str {
        match self {
            Isolation::NestedContainer => {
                "nested-container: each job runs in a fresh container on this runner's own Docker Engine, inside the runner's sandboxed container; neither reaches the machine"
            }
            Isolation::Vm => {
                "vm: each job runs in a throwaway virtual machine of its own, native to this OS, made for it and destroyed after; it gets no folder of this machine's but a read-only copy of the harness"
            }
            Isolation::Container => {
                "container: each job runs in a fresh container, but the runner is not sandboxed from the machine (it shares the machine's Docker Engine, or its container's root is the machine's), so the runner, and anything that takes it over, controls the machine. Run the runner's image under Sysbox for nested-container isolation"
            }
            Isolation::Host => "host: jobs run directly on this machine, unsandboxed",
        }
    }
}

/// What `G1T_RUNNER_SANDBOX` asks for: `nested`, the runner's image's
/// setting, starts a Docker Engine inside the runner's container.
pub const SANDBOX_ENV: &str = "G1T_RUNNER_SANDBOX";

/// The override for the checks below, loudly named: with it, a runner
/// whose jobs can reach the machine starts anyway.
pub const UNSAFE_ENV: &str = "G1T_RUNNER_UNSAFE_ALLOW_HOST_ACCESS";

pub fn nested_requested() -> bool {
    std::env::var(SANDBOX_ENV).is_ok_and(|v| v.eq_ignore_ascii_case("nested"))
}

pub fn unsafe_allowed() -> bool {
    std::env::var(UNSAFE_ENV).is_ok_and(|v| matches!(v.as_str(), "1" | "true" | "yes"))
}

// --- Host mode's deprecation ---------------------------------------------

/// What the runner's log says when it starts in host mode.
pub const HOST_MODE_AT_START: &str = "Deprecated: this runner runs jobs directly on this machine (--no-docker), unsandboxed. Every job can read, change and leave behind anything this user can. Host mode will be removed: run the runner's image under Sysbox instead, see https://docs.g1t.sh/guides/self-hosted-runners/#isolation";

/// What every job's log says when it ran in host mode.
pub const HOST_MODE_IN_JOB: &str = "This job ran on the host, unsandboxed: the self-hosted runner runs jobs directly on its machine (--no-docker). Host mode will be removed; see https://docs.g1t.sh/guides/self-hosted-runners/#isolation";

/// Why a public repository's job is refused in host mode.
pub fn host_mode_refuses(repo: &str) -> String {
    format!(
        "{repo} is public, and this self-hosted runner runs jobs directly on its machine (--no-docker), unsandboxed, so it does not take a public repository's work. Run the runner's image under Sysbox, or register it without --no-docker. See https://docs.g1t.sh/guides/self-hosted-runners/#isolation"
    )
}

// --- What the runner's container can see ----------------------------------

/// Socket names that are a container engine's: whoever has one controls
/// that engine, and through it the machine it runs on.
const ENGINE_SOCKETS: &[&str] = &["docker.sock", "containerd.sock", "podman.sock", "crio.sock", "dockershim.sock", "cri-dockerd.sock"];

fn is_engine_socket(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    ENGINE_SOCKETS.contains(&name)
}

/// mountinfo escapes spaces and the like as `\040`; undoes it.
fn unescape(field: &str) -> String {
    let bytes = field.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\'
            && let Some(code) =
                bytes.get(i + 1..i + 4).and_then(|d| std::str::from_utf8(d).ok()).and_then(|d| u8::from_str_radix(d, 8).ok())
        {
            out.push(code);
            i += 4;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The engine sockets mounted into this container from outside it, from
/// `/proc/self/mountinfo`: a mount point, or the file a mount came from,
/// named like an engine's socket (`-v /var/run/docker.sock:/var/run/docker.sock`,
/// or the same socket under another name).
pub fn mounted_engine_sockets(mountinfo: &str) -> Vec<String> {
    let mut found = Vec::new();
    for line in mountinfo.lines() {
        // `id parent major:minor root mount-point options [optional…] - fstype source super-options`
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 5 {
            continue;
        }
        let (root, mount_point) = (unescape(fields[3]), unescape(fields[4]));
        if is_engine_socket(&mount_point) || is_engine_socket(&root) {
            found.push(mount_point);
        }
    }
    found
}

/// Whether this container runs under Sysbox, whose virtual files
/// (`/proc/uptime`, `/sys/kernel`, …) come from `sysboxfs`.
pub fn under_sysbox(mountinfo: &str) -> bool {
    mountinfo.lines().any(|line| line.split(" - ").nth(1).is_some_and(|rest| rest.split_whitespace().nth(1) == Some("sysboxfs")))
}

/// Whether root here is root on the machine: no user namespace, every id
/// mapped to itself (`/proc/self/uid_map` is `0 0 4294967295`).
pub fn root_is_the_machines(uid_map: &str) -> bool {
    let rows: Vec<Vec<&str>> = uid_map.lines().map(|l| l.split_whitespace().collect()).filter(|r: &Vec<&str>| r.len() == 3).collect();
    rows.iter().any(|r| r[0] == "0" && r[1] == "0" && r[2].parse::<u64>().is_ok_and(|n| n >= 4_294_967_295))
}

/// What a nested runner found about its container.
#[derive(Debug, Default)]
pub struct Findings {
    /// Engine sockets mounted in from outside.
    pub sockets: Vec<String>,
    /// An engine socket that is just there, where the runner's own engine
    /// does not put one: a directory such as `/var/run` mounted from the
    /// machine.
    pub stray_sockets: Vec<String>,
    /// `DOCKER_HOST` pointing somewhere.
    pub docker_host: Option<String>,
    pub sysbox: bool,
    pub machine_root: bool,
}

impl Findings {
    pub fn read() -> Findings {
        let mountinfo = std::fs::read_to_string("/proc/self/mountinfo").unwrap_or_default();
        let uid_map = std::fs::read_to_string("/proc/self/uid_map").unwrap_or_default();
        let mut findings = Findings::from_text(&mountinfo, &uid_map);
        for path in ["/var/run/docker.sock", "/run/docker.sock", "/run/containerd/containerd.sock", "/run/podman/podman.sock"] {
            // `/var/run` is often `/run`: the same file is said once.
            let same =
                |a: &str, b: &str| a == b || std::fs::canonicalize(a).ok().zip(std::fs::canonicalize(b).ok()).is_some_and(|(a, b)| a == b);
            if Path::new(path).exists() && !findings.sockets.iter().any(|s| same(s, path)) {
                findings.stray_sockets.push(path.to_owned());
            }
        }
        findings.docker_host = std::env::var("DOCKER_HOST").ok().filter(|h| !h.is_empty());
        findings
    }

    pub fn from_text(mountinfo: &str, uid_map: &str) -> Findings {
        Findings {
            sockets: mounted_engine_sockets(mountinfo),
            sysbox: under_sysbox(mountinfo),
            machine_root: root_is_the_machines(uid_map),
            ..Findings::default()
        }
    }

    /// What reaches the machine from here, one reason a line.
    pub fn problems(&self) -> Vec<String> {
        let mut problems = Vec::new();
        for socket in &self.sockets {
            problems.push(format!(
                "{socket} is a container engine's socket mounted in from outside this container: whoever uses it controls the machine"
            ));
        }
        for socket in &self.stray_sockets {
            problems.push(format!(
                "{socket} is a container engine's socket that this runner did not make (a folder mounted from the machine?)"
            ));
        }
        if let Some(host) = &self.docker_host {
            problems.push(format!("DOCKER_HOST is set ({host}): jobs would run on that engine, not this runner's own"));
        }
        if self.machine_root && !self.sysbox {
            problems.push("root in this container is root on the machine (it has no user namespace of its own): run it with --runtime=sysbox-runc, and without --privileged".to_owned());
        }
        problems
    }
}

/// Decides a nested runner's isolation, or refuses to start. With
/// [`UNSAFE_ENV`] it starts anyway, as `container`, and says why loudly.
pub fn check_nested(findings: &Findings, allow_unsafe: bool) -> Result<Isolation> {
    let problems = findings.problems();
    if problems.is_empty() {
        return Ok(Isolation::NestedContainer);
    }
    if allow_unsafe {
        return Ok(Isolation::Container);
    }
    bail!(
        "this runner is not sandboxed from its machine, so it will not take work:\n  - {}\nRun it as `docker run --runtime=sysbox-runc …` without the machine's Docker socket (see https://docs.g1t.sh/guides/self-hosted-runners/#run-it-as-a-container), or set {UNSAFE_ENV}=1 to run anyway with jobs able to reach the machine.",
        problems.join("\n  - ")
    )
}

// --- Sandbox drivers --------------------------------------------------------

/// What makes and destroys a job's sandbox. Each job gets a fresh one,
/// which never touches the machine, and which is gone after the job.
/// Making and destroying a Docker sandbox is exec.rs; a driver for another
/// kind adds its own when it is built.
pub trait SandboxDriver {
    /// What it is called in the log.
    fn name(&self) -> &'static str;
    /// Whether this machine can make sandboxes with it: the isolation it
    /// gives here, or why it cannot.
    fn preflight(&self) -> Result<Isolation>;
}

/// Linux, built: the runner's own Docker Engine, inside the runner's
/// Sysbox container (engine.rs), and a container per job on it (exec.rs),
/// with no mounts from the machine. `allow_unsafe`: [`UNSAFE_ENV`] is set.
pub struct NestedDocker {
    pub allow_unsafe: bool,
}

impl SandboxDriver for NestedDocker {
    fn name(&self) -> &'static str {
        "Docker inside the runner's container"
    }
    fn preflight(&self) -> Result<Isolation> {
        check_nested(&Findings::read(), self.allow_unsafe)
    }
}

/// The same containers, on a Docker Engine shared with the machine: a
/// runner installed on the machine, or a container given its socket.
pub struct SharedDocker;

impl SandboxDriver for SharedDocker {
    fn name(&self) -> &'static str {
        "the machine's Docker"
    }
    fn preflight(&self) -> Result<Isolation> {
        Ok(Isolation::Container)
    }
}

/// The driver for jobs native to this OS, where there is one: Windows
/// Sandbox on Windows, a cloned macOS VM on a Mac (native.rs).
pub fn native_driver() -> Option<Box<dyn SandboxDriver>> {
    match std::env::consts::OS {
        "windows" => Some(Box::new(super::native::WindowsSandbox)),
        "macos" => Some(Box::new(super::native::MacVm)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLAIN: &str = "\
611 590 0:52 / / rw,relatime master:180 - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/A,upperdir=/var/lib/docker/overlay2/x/diff
612 611 0:55 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw
620 611 254:1 /var/lib/docker/volumes/g1t-runner/_data /data rw,relatime - ext4 /dev/vda1 rw
621 611 254:1 /var/lib/docker/containers/abc/resolv.conf /etc/resolv.conf rw,relatime - ext4 /dev/vda1 rw
";

    const WITH_SOCKET: &str = "\
611 590 0:52 / / rw,relatime master:180 - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/A
622 611 0:26 /docker.sock /run/docker.sock rw,nosuid,nodev,noexec,relatime - tmpfs tmpfs rw,size=3280376k,mode=755
";

    const RENAMED_SOCKET: &str = "\
623 611 0:26 /docker.sock /tmp/engine rw,nosuid,nodev - tmpfs tmpfs rw
624 611 0:27 /containerd/containerd.sock /run/containerd/containerd.sock rw - tmpfs tmpfs rw
";

    const SYSBOX: &str = "\
1000 990 0:60 / / rw,relatime - shiftfs /var/lib/sysbox/shiftfs/x rw
1001 1000 0:61 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw
1002 1001 0:62 /proc/uptime /proc/uptime rw,nosuid,nodev,relatime - fuse sysboxfs rw,user_id=0,group_id=0,default_permissions,allow_other
1003 1000 254:1 /var/lib/sysbox/docker/abc /var/lib/docker rw,relatime - ext4 /dev/vda1 rw
";

    #[test]
    fn a_mounted_docker_socket_is_found() {
        assert!(mounted_engine_sockets(PLAIN).is_empty());
        assert_eq!(mounted_engine_sockets(WITH_SOCKET), vec!["/run/docker.sock".to_owned()]);
        // The same socket under another name, and containerd's.
        assert_eq!(mounted_engine_sockets(RENAMED_SOCKET), vec!["/tmp/engine".to_owned(), "/run/containerd/containerd.sock".to_owned()]);
        // Sysbox's own Docker data mount is not a socket.
        assert!(mounted_engine_sockets(SYSBOX).is_empty());
    }

    #[test]
    fn escaped_paths_are_read() {
        assert_eq!(mounted_engine_sockets("1 0 0:1 /a\\040b/docker.sock /x\\040y rw - tmpfs tmpfs rw"), vec!["/x y".to_owned()]);
    }

    #[test]
    fn sysbox_and_a_user_namespace_are_told() {
        assert!(under_sysbox(SYSBOX));
        assert!(!under_sysbox(PLAIN));
        assert!(root_is_the_machines("         0          0 4294967295\n"));
        assert!(!root_is_the_machines("         0     165536      65536\n"));
    }

    #[test]
    fn a_nested_runner_refuses_the_machines_socket_unless_told_loudly() {
        let sysbox = Findings::from_text(SYSBOX, "0 165536 65536");
        assert_eq!(check_nested(&sysbox, false).unwrap(), Isolation::NestedContainer);

        let socket = Findings::from_text(&format!("{SYSBOX}{WITH_SOCKET}"), "0 165536 65536");
        let refused = check_nested(&socket, false).unwrap_err().to_string();
        assert!(refused.contains("/run/docker.sock"), "{refused}");
        assert!(refused.contains(UNSAFE_ENV), "{refused}");
        assert_eq!(check_nested(&socket, true).unwrap(), Isolation::Container);

        // --privileged, without Sysbox: root here is the machine's.
        let privileged = Findings::from_text(PLAIN, "0 0 4294967295");
        assert!(check_nested(&privileged, false).unwrap_err().to_string().contains("sysbox-runc"));

        let host = Findings { docker_host: Some("tcp://10.0.0.1:2375".into()), ..Findings::from_text(SYSBOX, "0 165536 65536") };
        assert!(check_nested(&host, false).is_err());
    }

    #[test]
    fn host_mode_says_it_is_deprecated() {
        assert!(HOST_MODE_AT_START.starts_with("Deprecated:"));
        assert!(HOST_MODE_AT_START.contains("will be removed"));
        assert!(HOST_MODE_IN_JOB.starts_with("This job ran on the host, unsandboxed"));
        assert!(HOST_MODE_IN_JOB.contains("Host mode will be removed"));
        assert!(host_mode_refuses("acme/web").contains("acme/web is public"));
        assert_eq!(Isolation::NestedContainer.as_str(), "nested-container");
        assert_eq!(Isolation::Host.as_str(), "host");
    }

    #[test]
    fn a_shared_engine_is_one_wall_and_a_vm_says_so() {
        assert_eq!(SharedDocker.preflight().unwrap(), Isolation::Container);
        assert_eq!(Isolation::Vm.as_str(), "vm");
        assert!(Isolation::Vm.describe().contains("throwaway virtual machine"));
    }
}
