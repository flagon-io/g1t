//! macOS, and Linux without Sysbox: the sandbox is a small Linux VM booted
//! from the release's signed kernel, initrd and system disk.
//!
//! - **macOS: vfkit**, a small command line program over Apple's
//!   Virtualization framework (`brew install vfkit`; the one Podman and
//!   CRC use). Chosen over Lima, which shares the home folder unless told
//!   otherwise and brings its own guest agent, and Apple's `container`,
//!   which needs macOS 26 and runs one VM per container rather than one
//!   for the runner. vfkit attaches only the devices named on its command
//!   line, so the sandbox gets disks, a NAT network card, a console and a
//!   random number source: no shared folder, no vsock, no display, no
//!   clipboard.
//! - **Linux: QEMU with KVM**, the same VM: virtio-mmio devices on a
//!   `microvm` (x64) or `virt` (arm64) machine, user-mode networking with
//!   nothing forwarded in, and QEMU's seccomp sandbox on.
//!
//! The VM has three disks: its system (replaced by an update), the
//! runner's state (kept, so an update does not register again; formatted
//! by the guest the first time) and a seed the launcher writes, holding the
//! settings (guest.rs). It says how it is on its console, which the
//! launcher reads from a file; the launcher stops it through the
//! hypervisor's control socket, a Unix socket in the state folder, never a
//! network port.
//!
//! **Untested:** these command builders are tested here, but neither has
//! been run on a Mac or a Linux machine with KVM yet.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};

use super::guest::{self, GuestStatus, Settings};
use super::image::{self, Local};
use super::{Backend, Resources, StopMode, process_alive};
use crate::selfhosted::native::Availability;
use crate::selfhosted::needs::{self, KvmFacts};

/// The seed disk's size: the settings' JSON, then zeros.
pub const SEED_BYTES: usize = 1 << 20;
/// The state disk's size: the runner's registration and status.
pub const STATE_BYTES: u64 = 256 << 20;
/// What the kernel is told: its console, and its system disk.
pub const CMDLINE: &str = "console=hvc0 root=/dev/vda rw quiet";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hypervisor {
    Vfkit,
    Qemu,
}

pub struct DiskVm {
    pub hypervisor: Hypervisor,
    pub dir: PathBuf,
}

/// The VM's files, in the state folder's `vm`.
#[derive(Clone, Debug)]
pub struct Paths {
    pub kernel: PathBuf,
    pub initrd: PathBuf,
    pub system: PathBuf,
    pub state: PathBuf,
    pub seed: PathBuf,
    pub console: PathBuf,
    pub control: PathBuf,
    pub pid: PathBuf,
}

impl Paths {
    pub fn in_dir(vm: &Path) -> Paths {
        Paths {
            kernel: vm.join("kernel"),
            initrd: vm.join("initrd"),
            system: vm.join("system.raw"),
            state: vm.join("state.img"),
            seed: vm.join("seed.img"),
            console: vm.join("console.log"),
            control: vm.join("control.sock"),
            pid: vm.join("vm.pid"),
        }
    }
}

/// vfkit's arguments: the VM's disks, NAT, its console to a file, and its
/// control socket. Nothing shared with the Mac.
pub fn vfkit_args(paths: &Paths, resources: &Resources) -> Vec<String> {
    let p = |path: &Path| path.display().to_string();
    vec![
        "--cpus".into(),
        resources.cpus.to_string(),
        "--memory".into(),
        resources.memory_mib.to_string(),
        "--bootloader".into(),
        format!("linux,kernel={},initrd={},cmdline=\"{CMDLINE}\"", p(&paths.kernel), p(&paths.initrd)),
        "--device".into(),
        format!("virtio-blk,path={}", p(&paths.system)),
        "--device".into(),
        format!("virtio-blk,path={}", p(&paths.state)),
        "--device".into(),
        format!("virtio-blk,path={}", p(&paths.seed)),
        "--device".into(),
        "virtio-net,nat".into(),
        "--device".into(),
        format!("virtio-serial,logFilePath={}", p(&paths.console)),
        "--device".into(),
        "virtio-rng".into(),
        "--restful-uri".into(),
        format!("unix://{}", p(&paths.control)),
    ]
}

/// QEMU's arguments, for `qemu-system-x86_64` (`arch` x64) or
/// `qemu-system-aarch64`: KVM, virtio-mmio devices, user networking with
/// nothing forwarded in, the console to a file, QMP on a Unix socket, and
/// QEMU's own seccomp sandbox.
pub fn qemu_args(arch: &str, paths: &Paths, resources: &Resources) -> Vec<String> {
    let p = |path: &Path| path.display().to_string();
    let machine = if arch == "arm64" { "virt" } else { "microvm" };
    let mut args: Vec<String> = vec![
        "-machine".into(),
        machine.into(),
        "-accel".into(),
        "kvm".into(),
        "-cpu".into(),
        "host".into(),
        "-smp".into(),
        resources.cpus.to_string(),
        "-m".into(),
        format!("{}M", resources.memory_mib),
        "-nodefaults".into(),
        "-no-user-config".into(),
        "-nographic".into(),
        "-kernel".into(),
        p(&paths.kernel),
        "-initrd".into(),
        p(&paths.initrd),
        "-append".into(),
        CMDLINE.into(),
    ];
    for (id, path) in [("system", &paths.system), ("state", &paths.state), ("seed", &paths.seed)] {
        args.extend(["-drive".into(), format!("id={id},file={},format=raw,if=none", p(path)), "-device".into(), format!("virtio-blk-device,drive={id}")]);
    }
    args.extend([
        "-netdev".into(),
        "user,id=net0".into(),
        "-device".into(),
        "virtio-net-device,netdev=net0".into(),
        "-chardev".into(),
        format!("file,id=console,path={}", p(&paths.console)),
        "-device".into(),
        "virtio-serial-device".into(),
        "-device".into(),
        "virtconsole,chardev=console".into(),
        "-object".into(),
        "rng-random,id=rng0,filename=/dev/urandom".into(),
        "-device".into(),
        "virtio-rng-device,rng=rng0".into(),
        "-qmp".into(),
        format!("unix:{},server=on,wait=off", p(&paths.control)),
        "-pidfile".into(),
        p(&paths.pid),
        "-sandbox".into(),
        "on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny".into(),
    ]);
    args
}

fn qemu_program() -> &'static str {
    if image::arch() == "arm64" { "qemu-system-aarch64" } else { "qemu-system-x86_64" }
}

/// vfkit: on the PATH, else where Homebrew puts it, since a program the
/// desktop app starts on a Mac has only the system's folders on its PATH.
fn vfkit_program() -> String {
    if answers("vfkit") {
        return "vfkit".into();
    }
    needs::HOMEBREW_BINS
        .iter()
        .map(|bin| Path::new(bin).join("vfkit"))
        .find(|path| path.exists())
        .map_or_else(|| "vfkit".into(), |path| path.display().to_string())
}

fn answers(program: &str) -> bool {
    Command::new(program).arg("--version").stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
}

/// What a request to stop the VM is, over its control socket: vfkit's
/// REST call, or QMP's handshake and an ACPI power button.
pub fn stop_request(hypervisor: Hypervisor) -> Vec<u8> {
    match hypervisor {
        Hypervisor::Vfkit => {
            let body = r#"{"state":"Stop"}"#;
            format!("POST /vm/state HTTP/1.1\r\nHost: vfkit\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).into_bytes()
        }
        Hypervisor::Qemu => b"{\"execute\":\"qmp_capabilities\"}\n{\"execute\":\"system_powerdown\"}\n".to_vec(),
    }
}

impl DiskVm {
    fn paths(&self) -> Paths {
        Paths::in_dir(&self.dir.join("vm"))
    }

    /// Takes the registration token out of the seed disk, once the runner
    /// has registered with it. The guest reads the seed only as it boots,
    /// and a token it lacks then is one it no longer needs.
    fn forget_token(&self) {
        let seed = self.paths().seed;
        let Some(mut settings) = std::fs::read(&seed).ok().and_then(|bytes| guest::read_seed(&bytes).ok()) else { return };
        if settings.token.take().is_some()
            && let Ok(bytes) = guest::write_seed(&settings, SEED_BYTES)
        {
            let _ = super::write_private(&seed, &bytes);
        }
    }

    fn pid(&self) -> Option<u32> {
        std::fs::read_to_string(self.paths().pid).ok().and_then(|p| p.trim().parse().ok())
    }

    fn resources(&self) -> Resources {
        std::fs::read(self.dir.join("vm").join("resources.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    #[cfg(unix)]
    fn send_stop(&self) -> Result<()> {
        use std::io::{Read, Write};
        let mut socket = std::os::unix::net::UnixStream::connect(self.paths().control).context("could not reach the VM's control socket")?;
        socket.set_read_timeout(Some(Duration::from_secs(5)))?;
        socket.write_all(&stop_request(self.hypervisor))?;
        let mut answer = [0u8; 512];
        let _ = socket.read(&mut answer);
        Ok(())
    }

    #[cfg(not(unix))]
    fn send_stop(&self) -> Result<()> {
        bail!("this VM runs on macOS and Linux")
    }
}

impl Backend for DiskVm {
    fn name(&self) -> &'static str {
        match self.hypervisor {
            Hypervisor::Vfkit => "vfkit",
            Hypervisor::Qemu => "qemu",
        }
    }

    fn image_keys(&self) -> Vec<String> {
        ["kernel", "initrd", "disk"].iter().map(|part| format!("vm-{}-{part}", image::arch())).collect()
    }

    fn availability(&self) -> Availability {
        let needs = match self.hypervisor {
            Hypervisor::Vfkit => {
                let macos = Command::new("sw_vers").arg("-productVersion").output().ok().and_then(|o| needs::macos_major(&String::from_utf8_lossy(&o.stdout)));
                let homebrew = answers("brew") || needs::HOMEBREW_BINS.iter().any(|bin| Path::new(bin).join("brew").exists());
                needs::vfkit_needs(macos, answers(&vfkit_program()), homebrew)
            }
            Hypervisor::Qemu => {
                let device = Path::new("/dev/kvm").exists();
                let (cpu, guest) = needs::cpu_flags(&std::fs::read_to_string("/proc/cpuinfo").unwrap_or_default());
                needs::kvm_needs(&KvmFacts {
                    device,
                    usable: device && std::fs::OpenOptions::new().read(true).write(true).open("/dev/kvm").is_ok(),
                    cpu,
                    guest,
                    qemu: answers(qemu_program()),
                })
            }
        };
        Availability::needing(needs, "linux")
    }

    fn exists(&self) -> bool {
        self.paths().system.exists()
    }

    fn running(&self) -> bool {
        self.pid().is_some_and(process_alive)
    }

    fn create(&self, local: &Local, resources: &Resources) -> Result<()> {
        let paths = self.paths();
        std::fs::create_dir_all(self.dir.join("vm"))?;
        let keys = self.image_keys();
        let file = |part: usize| local.files.get(&keys[part]).with_context(|| format!("no {} image", keys[part]));
        std::fs::copy(file(0)?, &paths.kernel)?;
        std::fs::copy(file(1)?, &paths.initrd)?;
        // The system disk comes compressed; it grows to the disk size asked
        // for, and the guest grows its file system to fill it.
        let mut source = flate2::read::GzDecoder::new(std::fs::File::open(file(2)?)?);
        let mut system = std::fs::File::create(&paths.system)?;
        std::io::copy(&mut source, &mut system).context("could not unpack the sandbox's system disk")?;
        let wanted = resources.disk_gib << 30;
        if system.metadata()?.len() < wanted {
            system.set_len(wanted)?;
        }
        if !paths.state.exists() {
            std::fs::File::create(&paths.state)?.set_len(STATE_BYTES)?;
        }
        std::fs::write(self.dir.join("vm").join("resources.json"), serde_json::to_vec(resources)?)?;
        Ok(())
    }

    fn configure(&self, settings: &Settings) -> Result<()> {
        let paths = self.paths();
        let mut merged = std::fs::read(&paths.seed).ok().and_then(|b| guest::read_seed(&b).ok()).unwrap_or_default();
        let given = settings.clone();
        merged.url = given.url.or(merged.url);
        merged.token = given.token.or(merged.token);
        merged.name = given.name.or(merged.name);
        if !given.labels.is_empty() {
            merged.labels = given.labels;
        }
        merged.group = given.group.or(merged.group);
        if given.cpus > 0 {
            merged.cpus = given.cpus;
        }
        if given.memory_mib > 0 {
            merged.memory_mib = given.memory_mib;
        }
        if !given.runner_image.is_empty() {
            merged.runner_image = given.runner_image;
        }
        if !given.image_version.is_empty() {
            merged.image_version = given.image_version;
        }
        merged.stop = given.stop.or(merged.stop);
        merged.sizes = given.sizes.or(merged.sizes);
        if given.computer_cpus > 0 {
            (merged.computer_cpus, merged.computer_memory_mib) = (given.computer_cpus, given.computer_memory_mib);
        }
        super::write_private(&paths.seed, &guest::write_seed(&merged, SEED_BYTES)?)
    }

    fn load_image(&self, _tar: &Path) -> Result<()> {
        bail!("--runner-image-file is for the WSL sandbox; a VM fetches the runner's image by digest")
    }

    fn start(&self) -> Result<()> {
        if self.running() {
            return Ok(());
        }
        let paths = self.paths();
        let resources = self.resources();
        let _ = std::fs::remove_file(&paths.control);
        let _ = std::fs::remove_file(&paths.console);
        let (program, args) = match self.hypervisor {
            Hypervisor::Vfkit => (vfkit_program(), vfkit_args(&paths, &resources)),
            Hypervisor::Qemu => (qemu_program().to_owned(), qemu_args(image::arch(), &paths, &resources)),
        };
        let log = std::fs::File::create(self.dir.join("sandbox.log"))?;
        let mut command = Command::new(program);
        command.args(&args).stdin(Stdio::null()).stdout(log.try_clone()?).stderr(log);
        let pid = super::spawn_detached(command)?;
        std::fs::write(&paths.pid, pid.to_string())?;
        Ok(())
    }

    fn guest_status(&self) -> Option<GuestStatus> {
        let log = std::fs::read(self.paths().console).ok()?;
        // The console's tail is enough: statuses come every few seconds.
        let tail = &log[log.len().saturating_sub(64 * 1024)..];
        let status = guest::status_from_console(&String::from_utf8_lossy(tail))?;
        // Registered: the token is no longer kept here either, as the
        // guest no longer keeps its own copy (guest.rs).
        if status.runner.is_some() {
            self.forget_token();
        }
        Some(status)
    }

    fn stop(&self, mode: StopMode) -> Result<()> {
        if !self.running() {
            return Ok(());
        }
        self.configure(&Settings { stop: Some(if mode == StopMode::Drain { "drain" } else { "now" }.into()), ..Settings::default() })?;
        self.send_stop()?;
        let limit = (mode == StopMode::Now).then(|| Instant::now() + Duration::from_secs(150));
        while self.running() {
            if limit.is_some_and(|l| Instant::now() > l) {
                if let Some(pid) = self.pid() {
                    let _ = Command::new("kill").args(["-KILL", &pid.to_string()]).status();
                }
                break;
            }
            std::thread::sleep(Duration::from_secs(1));
        }
        Ok(())
    }

    fn export_state(&self) -> Result<Option<Vec<u8>>> {
        // The state disk is kept across updates.
        Ok(None)
    }

    fn import_state(&self, _bytes: &[u8]) -> Result<()> {
        Ok(())
    }

    fn remove_system(&self) -> Result<()> {
        self.stop(StopMode::Now)?;
        let paths = self.paths();
        for path in [&paths.kernel, &paths.initrd, &paths.system, &paths.console] {
            let _ = std::fs::remove_file(path);
        }
        Ok(())
    }

    fn remove(&self) -> Result<()> {
        self.stop(StopMode::Now)?;
        let _ = std::fs::remove_dir_all(self.dir.join("vm"));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resources() -> Resources {
        Resources { cpus: 4, memory_mib: 8192, disk_gib: 64 }
    }

    /// As `Paths::in_dir("/s/vm")` makes them on a Mac or Linux.
    fn test_paths() -> Paths {
        let p = |name: &str| PathBuf::from(format!("/s/vm/{name}"));
        Paths {
            kernel: p("kernel"),
            initrd: p("initrd"),
            system: p("system.raw"),
            state: p("state.img"),
            seed: p("seed.img"),
            console: p("console.log"),
            control: p("control.sock"),
            pid: p("vm.pid"),
        }
    }

    #[test]
    fn vfkit_shares_nothing_with_the_mac() {
        let paths = test_paths();
        let args = vfkit_args(&paths, &resources());
        let text = args.join(" ");
        assert!(text.contains("--cpus 4 --memory 8192"));
        assert!(text.contains("linux,kernel=/s/vm/kernel,initrd=/s/vm/initrd,cmdline=\"console=hvc0 root=/dev/vda rw quiet\""));
        assert_eq!(args.iter().filter(|a| a.starts_with("virtio-blk,")).count(), 3);
        assert!(text.contains("virtio-net,nat"));
        assert!(text.contains("virtio-serial,logFilePath=/s/vm/console.log"));
        assert!(text.contains("--restful-uri unix:///s/vm/control.sock"));
        for shared in ["virtio-fs", "virtio-vsock", "virtio-gpu", "virtio-input", "rosetta", "tcp://"] {
            assert!(!text.contains(shared), "{shared}");
        }
    }

    #[test]
    fn qemu_forwards_nothing_in_and_sandboxes_itself() {
        let paths = test_paths();
        let text = qemu_args("x64", &paths, &resources()).join(" ");
        assert!(text.starts_with("-machine microvm -accel kvm -cpu host -smp 4 -m 8192M -nodefaults"));
        assert!(text.contains("-netdev user,id=net0 "));
        assert!(!text.contains("hostfwd") && !text.contains("-virtfs") && !text.contains("tcp:"));
        assert!(text.contains("-qmp unix:/s/vm/control.sock,server=on,wait=off"));
        assert!(text.contains("-sandbox on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny"));
        assert_eq!(text.matches("virtio-blk-device").count(), 3);
        assert!(qemu_args("arm64", &paths, &resources()).join(" ").starts_with("-machine virt "));
    }

    #[test]
    fn stopping_is_a_power_button_not_a_pulled_plug() {
        let vfkit = String::from_utf8(stop_request(Hypervisor::Vfkit)).unwrap();
        assert!(vfkit.starts_with("POST /vm/state HTTP/1.1\r\n"));
        assert!(vfkit.ends_with(r#"{"state":"Stop"}"#));
        assert!(vfkit.contains("Content-Length: 16\r\n"));
        let qmp = String::from_utf8(stop_request(Hypervisor::Qemu)).unwrap();
        assert!(qmp.contains("qmp_capabilities") && qmp.contains("system_powerdown"));
    }

    #[test]
    fn the_seed_lets_go_of_the_token_once_the_runner_registered() {
        let dir = std::env::temp_dir().join(format!("g1t-vm-seed-{}", std::process::id()));
        let vm = DiskVm { hypervisor: Hypervisor::Qemu, dir: dir.clone() };
        std::fs::create_dir_all(dir.join("vm")).unwrap();
        let settings = Settings { url: Some("https://g1t.sh".into()), token: Some("g1trt_x".into()), runner_image: "img@sha256:ab".into(), ..Settings::default() };
        std::fs::write(vm.paths().seed, guest::write_seed(&settings, SEED_BYTES).unwrap()).unwrap();
        // The console says the runner is registered and running.
        let status = GuestStatus { state: "running".into(), runner: Some(crate::selfhosted::RunnerStatus::default()), ..GuestStatus::default() };
        std::fs::write(vm.paths().console, format!("boot\n{}{}\n", guest::STATUS_PREFIX, serde_json::to_string(&status).unwrap())).unwrap();
        assert!(vm.guest_status().is_some_and(|s| s.runner.is_some()));
        let kept = guest::read_seed(&std::fs::read(vm.paths().seed).unwrap()).unwrap();
        assert_eq!(kept.token, None);
        assert_eq!(kept.url.as_deref(), Some("https://g1t.sh"));
        assert_eq!(kept.runner_image, "img@sha256:ab");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_vm_needs_its_three_files() {
        let vm = DiskVm { hypervisor: Hypervisor::Vfkit, dir: PathBuf::from("/s") };
        let keys = vm.image_keys();
        assert_eq!(keys.len(), 3);
        assert!(keys[2].ends_with("-disk") && keys[0].starts_with("vm-"));
    }
}
