//! What a computer still lacks before a kind of job can run sandboxed,
//! each by name (`status --json`'s `needs`), found before anything is
//! downloaded: the desktop app says each in plain words and sets up those
//! it can, behind one administrator prompt.
//!
//! | Need | Kind of job | What is missing | Set up by the app |
//! | --- | --- | --- | --- |
//! | `restart` | Linux, Windows | Windows features were turned on, and take effect after a restart | No: Restart now |
//! | `windows_update` | Linux, Windows | Windows older than 2004 (WSL 2), or than 11 24H2 (`wsb`) | No: Windows Update |
//! | `virtualization` | all | Virtualization (VT-x, AMD-V) off in the firmware | No: steps |
//! | `nested_virtualization` | all | A VM whose host doesn't pass virtualization through | No: steps |
//! | `vm_platform` | Linux on Windows | The Virtual Machine Platform feature | Yes |
//! | `wsl` | Linux on Windows | WSL | Yes |
//! | `wsl_update` | Linux on Windows | WSL older than 2.0, or the one built into Windows | Yes |
//! | `windows_edition` | Windows | Windows Home, which has no Windows Sandbox | No: Linux jobs still run |
//! | `windows_sandbox` | Windows | The Windows Sandbox feature | Yes |
//! | `kvm_module` | Linux on Linux | `/dev/kvm`: its module isn't loaded | No: command |
//! | `kvm_group` | Linux on Linux | Permission to use `/dev/kvm` | No: command |
//! | `qemu` | Linux on Linux | QEMU | No: command |
//! | `macos_update` | Linux on macOS | macOS older than 13 | No: Software Update |
//! | `homebrew` | Linux on macOS | Homebrew, which installs vfkit | No: steps |
//! | `vfkit` | Linux on macOS | vfkit | No: command |
//!
//! Each is said only when the facts say it for certain: a computer that
//! can run the sandbox is never held back by a guess. What can't be known
//! beforehand (virtualization inside a VM) is named from the error that
//! starting the sandbox gives instead.

use std::collections::BTreeMap;
use std::path::Path;
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

/// The file the desktop app's setup leaves in the launcher's state folder
/// when what it turned on takes a restart: this boot's time, as
/// [`WindowsFacts::booted`] says it.
pub const RESTART_FILE: &str = "restart-pending";

/// The oldest Windows build with WSL 2 (Windows 10 2004).
pub const WSL2_BUILD: u32 = 19041;
/// The oldest WSL the sandbox takes: the one from the Microsoft Store, 2.0 or later.
pub const WSL_VERSION: (u32, u32, u32) = (2, 0, 0);
/// The oldest macOS vfkit runs on.
pub const MACOS_MAJOR: u32 = 13;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Need {
    Restart,
    WindowsUpdate,
    Virtualization,
    NestedVirtualization,
    VmPlatform,
    Wsl,
    WslUpdate,
    WindowsEdition,
    WindowsSandbox,
    KvmModule,
    KvmGroup,
    Qemu,
    MacosUpdate,
    Homebrew,
    Vfkit,
}

impl Need {
    /// Why, and what to do, in the launcher's words: what `status` says
    /// as a capability's `cause` and `fix`. The first sentences of those a
    /// desktop app from before `needs` reads are kept as they were.
    pub fn said(self, kind: &str) -> (String, String) {
        let (cause, fix) = match (self, kind) {
            (Need::Restart, _) => {
                ("Windows needs a restart to finish turning on what the sandbox needs.", "Restart Windows; the sandbox starts after.")
            }
            (Need::WindowsUpdate, "windows") => (
                "This Windows has Windows Sandbox but not its command line, wsb, which came in Windows 11 24H2.",
                "Update Windows to 24H2 or later.",
            ),
            (Need::WindowsUpdate, _) => (
                "This Windows is older than Windows 10 version 2004, the first with WSL 2.",
                "Update Windows under Settings, Windows Update, then restart.",
            ),
            (Need::Virtualization, "linux") if cfg!(target_os = "linux") => (
                "This machine has neither Sysbox nor KVM: virtualization (Intel VT-x or AMD-V) is off in its firmware, or its processor has none.",
                "Turn on Intel VT-x or AMD-V in the firmware (BIOS or UEFI) settings and restart, or install Sysbox 0.7 or later.",
            ),
            (Need::Virtualization, _) => (
                "Virtualization (Intel VT-x or AMD-V) is turned off in this computer's firmware, and the sandbox is a small virtual machine.",
                "Restart into the firmware (BIOS or UEFI) settings, turn on Intel Virtualization Technology (VT-x) or SVM Mode (AMD-V), save and restart.",
            ),
            (Need::NestedVirtualization, _) => (
                "This computer is a virtual machine whose host doesn't pass virtualization through to it, and the sandbox is a virtual machine inside it.",
                "Turn on nested virtualization for this VM on its host, then start it again: on Hyper-V, `Set-VMProcessor -VMName <name> -ExposeVirtualizationExtensions $true` with the VM off.",
            ),
            (Need::VmPlatform, _) => (
                "Virtual Machine Platform, the Windows feature WSL 2 runs on, is turned off.",
                "Open a terminal as administrator and run `wsl --install --no-distribution`, which turns it on, then restart Windows.",
            ),
            (Need::Wsl, _) => (
                "WSL is not installed, and the sandbox for Linux jobs is a WSL distribution of its own.",
                "Open a terminal as administrator and run `wsl --install --no-distribution`, then restart Windows. It works on every edition of Windows 11, Home included.",
            ),
            (Need::WslUpdate, _) => (
                "This WSL is older than the one the sandbox needs: WSL 2.0 or later, from the Microsoft Store.",
                "Open a terminal as administrator and run `wsl --update`.",
            ),
            (Need::WindowsEdition, _) => (
                "Windows Sandbox, which Windows jobs run in, isn't in Windows Home.",
                "Linux jobs run on every edition. Windows jobs need Windows 11 Pro, Enterprise or Education.",
            ),
            (Need::WindowsSandbox, _) => (
                "Windows Sandbox is not turned on, and Windows jobs each run in one.",
                "Turn on Windows Sandbox under Settings, System, Optional features, More Windows features, then restart.",
            ),
            (Need::KvmModule, _) => (
                "This machine has neither Sysbox nor KVM: its processor can run virtual machines, but /dev/kvm isn't there.",
                "Load KVM with `sudo modprobe kvm_intel` (or `kvm_amd`); if it says the firmware disabled it, turn on VT-x or AMD-V there. Or install Sysbox 0.7 or later.",
            ),
            (Need::KvmGroup, _) => ("This user may not use /dev/kvm.", "Run `sudo usermod -aG kvm $USER`, then log out and in again."),
            (Need::Qemu, _) => (
                "QEMU, which runs the sandbox's VM, is not installed.",
                "Install QEMU (qemu-system-x86 on Debian and Ubuntu, qemu-kvm on Fedora), or Sysbox 0.7 or later.",
            ),
            (Need::MacosUpdate, _) => {
                ("The sandbox's VM needs macOS 13 or later.", "Update macOS under System Settings, General, Software Update.")
            }
            (Need::Homebrew, _) => (
                "vfkit, which runs the sandbox's VM with Apple's Virtualization framework, is not installed, nor is Homebrew, which installs it.",
                "Install Homebrew (brew.sh), then run `brew install vfkit`.",
            ),
            (Need::Vfkit, _) => (
                "vfkit, which runs the sandbox's VM with Apple's Virtualization framework, is not installed.",
                "Install it with `brew install vfkit` (macOS 13 or later), then start the sandbox again.",
            ),
        };
        (cause.to_owned(), fix.to_owned())
    }
}

// --- Windows ------------------------------------------------------------------------

/// What Windows says of itself, read without an administrator. Each is
/// None (or empty) when it couldn't be read, and nothing is concluded from it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct WindowsFacts {
    /// `EditionID`: `Core` (Home), `Professional`, `Enterprise`, …
    pub edition: Option<String>,
    pub build: Option<u32>,
    /// A hypervisor is running (`Win32_ComputerSystem.HypervisorPresent`).
    pub hypervisor: Option<bool>,
    /// Virtualization on in the firmware (`Win32_Processor`). It reads
    /// false whenever a hypervisor is running, so it says something only
    /// when none is.
    pub firmware: Option<bool>,
    pub model: Option<String>,
    pub manufacturer: Option<String>,
    /// `Win32_OptionalFeature.InstallState`: 1 on, 2 off, 3 not in this edition.
    pub features: BTreeMap<String, u32>,
    /// When Windows started, in UTC.
    pub booted: Option<String>,
}

pub const VM_PLATFORM: &str = "VirtualMachinePlatform";
pub const WINDOWS_SANDBOX: &str = "Containers-DisposableClientVM";

/// The facts, as one PowerShell call prints them: about a second, so only
/// asked while something is missing.
const PROBE: &str = r#"$ErrorActionPreference = 'SilentlyContinue'
$v = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$cs = Get-CimInstance Win32_ComputerSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$features = @{}
Get-CimInstance Win32_OptionalFeature | Where-Object { $_.Name -in @('VirtualMachinePlatform', 'Containers-DisposableClientVM') } | ForEach-Object { $features[$_.Name] = [int]$_.InstallState }
$os = Get-CimInstance Win32_OperatingSystem
[pscustomobject]@{
  edition = $v.EditionID
  build = [int]$v.CurrentBuildNumber
  hypervisor = $cs.HypervisorPresent
  firmware = $cpu.VirtualizationFirmwareEnabled
  model = $cs.Model
  manufacturer = $cs.Manufacturer
  features = $features
  booted = $os.LastBootUpTime.ToUniversalTime().ToString('o')
} | ConvertTo-Json -Compress"#;

/// PowerShell's `-EncodedCommand`: a script as UTF-16LE in base64, so
/// nothing in it is read by a shell on the way.
pub fn encoded(script: &str) -> String {
    use base64::Engine;
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

impl WindowsFacts {
    /// Asks Windows, once a process: what it can't say is left unknown.
    pub fn look() -> WindowsFacts {
        static FACTS: std::sync::OnceLock<WindowsFacts> = std::sync::OnceLock::new();
        FACTS
            .get_or_init(|| {
                let mut command = Command::new("powershell.exe");
                command
                    .args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded(PROBE)])
                    .stdin(Stdio::null())
                    .stderr(Stdio::null());
                super::native::hide_window(&mut command);
                command.output().ok().and_then(|out| serde_json::from_slice(&out.stdout).ok()).unwrap_or_default()
            })
            .clone()
    }

    /// [`look`](Self::look), kept in the launcher's state folder until
    /// Windows restarts: what it says (the edition, the processor, a
    /// hypervisor running, a feature turned on) changes only across a
    /// restart, and asking takes a second or two, which a status every
    /// few seconds shouldn't.
    pub fn look_in(dir: &Path) -> WindowsFacts {
        let path = dir.join(FACTS_FILE);
        let Some(boot) = booted_at() else { return WindowsFacts::look() };
        let kept: Option<Kept> = std::fs::read(&path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok());
        if let Some(kept) = kept.filter(|kept| same_boot(kept.boot, boot)) {
            return kept.facts;
        }
        let facts = WindowsFacts::look();
        // Kept only when Windows answered.
        if facts.booted.is_some() {
            let _ = std::fs::create_dir_all(dir);
            let _ = std::fs::write(&path, serde_json::to_vec(&Kept { boot, facts: facts.clone() }).unwrap_or_default());
        }
        facts
    }

    /// Windows Home (`Core`, `CoreN`, `CoreSingleLanguage`, `CoreCountrySpecific`).
    pub fn home(&self) -> bool {
        self.edition.as_deref().is_some_and(|e| e.starts_with("Core"))
    }

    /// This Windows is itself a virtual machine.
    pub fn virtual_machine(&self) -> bool {
        let said = format!("{} {}", self.model.as_deref().unwrap_or(""), self.manufacturer.as_deref().unwrap_or("")).to_ascii_lowercase();
        ["virtual machine", "vmware", "virtualbox", "qemu", "kvm", "parallels", "xen", "bochs"].iter().any(|vm| said.contains(vm))
    }

    /// A feature on (Some(true)), off or not here (Some(false)), or not known.
    pub fn feature(&self, name: &str) -> Option<bool> {
        self.features.get(name).map(|state| *state == 1)
    }

    /// Virtualization is off in the firmware, for certain: a physical
    /// computer with no hypervisor running whose processor says so.
    pub fn firmware_off(&self) -> bool {
        !self.virtual_machine() && self.hypervisor == Some(false) && self.firmware == Some(false)
    }

    /// What the computer lacks for virtualization, said from an error
    /// that starting a VM gave: off in the firmware, or not passed through to this VM.
    pub fn no_virtualization(&self) -> Need {
        if self.virtual_machine() { Need::NestedVirtualization } else { Need::Virtualization }
    }
}

/// The file [`WindowsFacts::look_in`] keeps them in.
pub const FACTS_FILE: &str = "windows-facts.json";

#[derive(Serialize, Deserialize)]
struct Kept {
    /// When Windows started, in seconds since 1970.
    boot: u64,
    facts: WindowsFacts,
}

/// Two readings of when Windows started are the same boot: they are
/// worked out from the time now and the time since, so differ by a second or so.
fn same_boot(a: u64, b: u64) -> bool {
    a.abs_diff(b) <= 30
}

/// When Windows started, in seconds since 1970: now, less how long it has been running.
fn booted_at() -> Option<u64> {
    #[cfg(windows)]
    {
        unsafe extern "system" {
            fn GetTickCount64() -> u64;
        }
        // SAFETY: GetTickCount64 takes nothing and only reads a counter.
        let up = unsafe { GetTickCount64() } / 1000;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
        Some(now.saturating_sub(up))
    }
    #[cfg(not(windows))]
    None
}

/// Whether setup left a restart to do, this boot: the file setup wrote
/// names the boot it ran in. One from an earlier boot is removed.
pub fn restart_pending(dir: &Path, facts: &WindowsFacts) -> bool {
    let path = dir.join(RESTART_FILE);
    let Ok(said) = std::fs::read_to_string(&path) else { return false };
    match facts.booted.as_deref() {
        Some(booted) if said.trim() == booted => true,
        Some(_) => {
            let _ = std::fs::remove_file(&path);
            false
        }
        // Not known: a restart is still to be done until Windows says otherwise.
        None => true,
    }
}

/// What WSL says of itself.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WslFacts {
    /// `wsl --status` answers.
    pub installed: bool,
    /// `wsl --version`'s, which the WSL built into Windows doesn't answer.
    pub version: Option<(u32, u32, u32)>,
    /// A WSL 2 distribution is here already: WSL 2 itself works.
    pub has_wsl2: bool,
}

/// The first `a.b.c` in `wsl --version`'s first line, in any language:
/// `WSL version: 2.5.9.0`, `WSL-Version: 2.5.9.0`.
pub fn wsl_version(text: &str) -> Option<(u32, u32, u32)> {
    let line = text.replace('\0', "");
    let first = line.lines().find(|l| !l.trim().is_empty())?.to_owned();
    first.split(|c: char| !(c.is_ascii_digit() || c == '.')).find_map(|word| {
        let mut parts = word.split('.').map(|p| p.parse::<u32>().ok());
        match (parts.next().flatten(), parts.next().flatten(), parts.next().flatten()) {
            (Some(a), Some(b), Some(c)) => Some((a, b, c)),
            _ => None,
        }
    })
}

/// What Linux jobs on Windows still need, first what must come first.
pub fn wsl_needs(win: &WindowsFacts, wsl: &WslFacts, restart: bool) -> Vec<Need> {
    let mut needs = Vec::new();
    if win.build.is_some_and(|b| b < WSL2_BUILD) {
        return vec![Need::WindowsUpdate];
    }
    // A WSL 2 distribution that runs says virtualization and the platform are there.
    if !wsl.has_wsl2 {
        if win.firmware_off() && !restart {
            return vec![Need::Virtualization];
        }
        if win.feature(VM_PLATFORM) == Some(false) {
            needs.push(Need::VmPlatform);
        }
    }
    if !wsl.installed {
        needs.push(Need::Wsl);
    } else if wsl.version.is_none_or(|v| v < WSL_VERSION) {
        needs.push(Need::WslUpdate);
    }
    if restart && (needs.iter().any(|n| matches!(n, Need::VmPlatform)) || win.hypervisor == Some(false)) {
        // What is left to set up after it is said once it's done.
        return vec![Need::Restart];
    }
    needs
}

/// What Windows jobs still need: Windows Sandbox (`feature`, its program
/// is here) and its command line (`cli`).
pub fn windows_sandbox_needs(win: &WindowsFacts, feature: bool, cli: bool, restart: bool) -> Vec<Need> {
    if feature && cli {
        return vec![];
    }
    if feature {
        return vec![Need::WindowsUpdate];
    }
    if win.home() || (win.feature(WINDOWS_SANDBOX).is_none() && win.features.contains_key(VM_PLATFORM)) {
        // Home, or an edition whose feature list has no Windows Sandbox.
        return vec![Need::WindowsEdition];
    }
    if restart {
        return vec![Need::Restart];
    }
    if win.firmware_off() {
        return vec![Need::Virtualization];
    }
    let mut needs = vec![Need::WindowsSandbox];
    if win.build.is_some_and(|b| b < 26100) {
        needs.push(Need::WindowsUpdate);
    }
    needs
}

/// Whether a sentence about a VM that wouldn't start is about virtualization.
pub fn about_virtualization(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    [
        "virtualization is not enabled",
        "enable virtualization",
        "ensure virtualization",
        "hcs_e_hyperv_not_installed",
        "hypervisor is not present",
        "vt-x",
        "nested virtualization",
    ]
    .iter()
    .any(|said| lower.contains(said))
}

// --- Linux --------------------------------------------------------------------------

/// What a Linux computer has for a QEMU VM with KVM.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KvmFacts {
    /// `/dev/kvm` is there.
    pub device: bool,
    /// This user may open it.
    pub usable: bool,
    /// The processor says it can virtualize (`vmx`, `svm`): None on an
    /// architecture whose flags don't say.
    pub cpu: Option<bool>,
    /// This Linux is itself a virtual machine (`hypervisor`).
    pub guest: bool,
    pub qemu: bool,
}

/// `/proc/cpuinfo`'s flags: whether the processor can virtualize, and
/// whether this is a guest. On x86 only; elsewhere it says nothing.
pub fn cpu_flags(cpuinfo: &str) -> (Option<bool>, bool) {
    let Some(flags) = cpuinfo.lines().find(|l| l.starts_with("flags")).and_then(|l| l.split_once(':')).map(|(_, f)| f) else {
        return (None, false);
    };
    let has = |flag: &str| flags.split_whitespace().any(|f| f == flag);
    (Some(has("vmx") || has("svm")), has("hypervisor"))
}

pub fn kvm_needs(facts: &KvmFacts) -> Vec<Need> {
    let mut needs = Vec::new();
    if !facts.device {
        needs.push(match facts.cpu {
            Some(false) if facts.guest => Need::NestedVirtualization,
            Some(false) => Need::Virtualization,
            _ => Need::KvmModule,
        });
    } else if !facts.usable {
        needs.push(Need::KvmGroup);
    }
    if !facts.qemu {
        needs.push(Need::Qemu);
    }
    needs
}

// --- macOS --------------------------------------------------------------------------

/// `sw_vers -productVersion`'s major version: `14.6.1` is 14.
pub fn macos_major(text: &str) -> Option<u32> {
    text.trim().split('.').next()?.parse().ok()
}

pub fn vfkit_needs(macos: Option<u32>, vfkit: bool, homebrew: bool) -> Vec<Need> {
    if macos.is_some_and(|major| major < MACOS_MAJOR) {
        return vec![Need::MacosUpdate];
    }
    match (vfkit, homebrew) {
        (true, _) => vec![],
        (false, true) => vec![Need::Vfkit],
        (false, false) => vec![Need::Homebrew],
    }
}

/// Where Homebrew puts programs, which a program a Mac app starts doesn't
/// have on its PATH: Apple silicon's, then Intel's.
pub const HOMEBREW_BINS: [&str; 2] = ["/opt/homebrew/bin", "/usr/local/bin"];

#[cfg(test)]
mod tests {
    use super::*;

    /// What the probe printed on a Windows 11 Pro desktop with Hyper-V running.
    const PRO: &str = r#"{"edition":"Professional","build":26220,"hypervisor":true,"firmware":false,"model":"MS-7D25","manufacturer":"Micro-Star International Co., Ltd.","features":{"VirtualMachinePlatform":1,"Containers-DisposableClientVM":1},"booted":"2026-10-14T20:17:29.5000000Z"}"#;

    fn facts(json: &str) -> WindowsFacts {
        serde_json::from_str(json).unwrap()
    }

    /// A clean Windows 11 Home laptop: nothing turned on, virtualization on in its firmware.
    fn clean_home() -> WindowsFacts {
        facts(
            r#"{"edition":"Core","build":26100,"hypervisor":false,"firmware":true,"model":"XPS 13","manufacturer":"Dell Inc.","features":{"VirtualMachinePlatform":2},"booted":"2026-10-14T08:00:00Z"}"#,
        )
    }

    fn wsl(installed: bool, version: Option<(u32, u32, u32)>, has_wsl2: bool) -> WslFacts {
        WslFacts { installed, version, has_wsl2 }
    }

    #[test]
    fn a_computer_that_has_everything_needs_nothing() {
        let pro = facts(PRO);
        assert!(!pro.home() && !pro.virtual_machine() && !pro.firmware_off());
        // Hyper-V running: firmware reads false, and means nothing.
        assert_eq!(wsl_needs(&pro, &wsl(true, Some((2, 5, 9)), true), false), vec![]);
        assert_eq!(wsl_needs(&pro, &wsl(true, Some((2, 5, 9)), false), false), vec![]);
        assert_eq!(windows_sandbox_needs(&pro, true, true, false), vec![]);
    }

    #[test]
    fn a_clean_computer_needs_the_platform_and_wsl_set_up() {
        let home = clean_home();
        assert_eq!(wsl_needs(&home, &wsl(false, None, false), false), vec![Need::VmPlatform, Need::Wsl]);
        // The WSL built into Windows answers --status but not --version.
        assert_eq!(wsl_needs(&home, &wsl(true, None, false), false), vec![Need::VmPlatform, Need::WslUpdate]);
        assert_eq!(wsl_needs(&home, &wsl(true, Some((1, 2, 5)), false), false), vec![Need::VmPlatform, Need::WslUpdate]);
        // Home has no Windows Sandbox, and that's said as such, not as "off".
        assert_eq!(windows_sandbox_needs(&home, false, false, false), vec![Need::WindowsEdition]);
    }

    #[test]
    fn after_setup_it_says_restart_until_windows_has_restarted() {
        let home = clean_home();
        assert_eq!(wsl_needs(&home, &wsl(true, Some((2, 5, 9)), false), true), vec![Need::Restart]);
        let pro = WindowsFacts {
            edition: Some("Professional".into()),
            features: [(VM_PLATFORM.to_owned(), 1), (WINDOWS_SANDBOX.to_owned(), 2)].into(),
            ..clean_home()
        };
        assert_eq!(windows_sandbox_needs(&pro, false, false, true), vec![Need::Restart]);
        // Restarted, with everything there: nothing.
        let after =
            WindowsFacts { hypervisor: Some(true), firmware: Some(false), features: [(VM_PLATFORM.to_owned(), 1)].into(), ..clean_home() };
        assert_eq!(wsl_needs(&after, &wsl(true, Some((2, 5, 9)), false), false), vec![]);
        // The file names the boot it was written in; a later boot's facts remove it.
        let dir = std::env::temp_dir().join(format!("g1t-needs-restart-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(RESTART_FILE), "2026-10-14T08:00:00Z\r\n").unwrap();
        assert!(restart_pending(&dir, &home));
        let rebooted = WindowsFacts { booted: Some("2026-10-14T09:30:00Z".into()), ..clean_home() };
        assert!(!restart_pending(&dir, &rebooted));
        assert!(!dir.join(RESTART_FILE).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn virtualization_off_in_the_firmware_comes_first_and_is_never_guessed() {
        let off = WindowsFacts { firmware: Some(false), ..clean_home() };
        assert!(off.firmware_off());
        assert_eq!(wsl_needs(&off, &wsl(false, None, false), false), vec![Need::Virtualization]);
        let pro = WindowsFacts {
            edition: Some("Professional".into()),
            features: [(VM_PLATFORM.to_owned(), 2), (WINDOWS_SANDBOX.to_owned(), 2)].into(),
            ..off.clone()
        };
        assert_eq!(windows_sandbox_needs(&pro, false, false, false), vec![Need::Virtualization]);
        // Pro whose feature list leaves Windows Sandbox out (Windows Server, N editions): no Windows Sandbox.
        let without = WindowsFacts { features: [(VM_PLATFORM.to_owned(), 2)].into(), ..pro };
        assert_eq!(windows_sandbox_needs(&without, false, false, false), vec![Need::WindowsEdition]);
        // Not known: not said.
        let unknown = WindowsFacts { firmware: None, ..off.clone() };
        assert_eq!(wsl_needs(&unknown, &wsl(false, None, false), false), vec![Need::VmPlatform, Need::Wsl]);
        // In a VM the firmware's flag says nothing; an error names it instead.
        let guest = WindowsFacts { model: Some("Virtual Machine".into()), manufacturer: Some("Microsoft Corporation".into()), ..off };
        assert!(guest.virtual_machine() && !guest.firmware_off());
        assert_eq!(guest.no_virtualization(), Need::NestedVirtualization);
        assert_eq!(clean_home().no_virtualization(), Need::Virtualization);
        assert!(about_virtualization(
            "WSL could not import the sandbox: Please enable the Virtual Machine Platform Windows feature and ensure virtualization is enabled in the BIOS."
        ));
        assert!(!about_virtualization("could not fetch https://g1t.sh"));
        // Nothing read at all (PowerShell blocked): nothing concluded but what WSL says.
        assert_eq!(wsl_needs(&WindowsFacts::default(), &wsl(false, None, false), false), vec![Need::Wsl]);
        assert_eq!(windows_sandbox_needs(&WindowsFacts::default(), false, false, false), vec![Need::WindowsSandbox]);
    }

    #[test]
    fn old_windows_says_update() {
        let old = WindowsFacts { build: Some(18363), ..clean_home() };
        assert_eq!(wsl_needs(&old, &wsl(false, None, false), false), vec![Need::WindowsUpdate]);
        let pro = facts(PRO);
        assert_eq!(windows_sandbox_needs(&pro, true, false, false), vec![Need::WindowsUpdate]);
        let pro_23h2 =
            WindowsFacts { build: Some(22631), features: [(VM_PLATFORM.to_owned(), 1), (WINDOWS_SANDBOX.to_owned(), 2)].into(), ..pro };
        assert_eq!(windows_sandbox_needs(&pro_23h2, false, false, false), vec![Need::WindowsSandbox, Need::WindowsUpdate]);
    }

    /// Asks this Windows: `cargo test -p g1t-runner -- --ignored this_windows --nocapture`.
    #[test]
    #[ignore]
    fn this_windows_says_what_it_has() {
        let facts = WindowsFacts::look();
        println!("{facts:#?}");
        assert!(facts.edition.is_some() && facts.build.is_some() && facts.booted.is_some(), "{facts:?}");
        assert!(facts.features.contains_key(VM_PLATFORM), "{facts:?}");
        // Kept until Windows restarts: asked once, then read back at once.
        let dir = std::env::temp_dir().join(format!("g1t-facts-{}", std::process::id()));
        let first = WindowsFacts::look_in(&dir);
        let started = std::time::Instant::now();
        assert_eq!(WindowsFacts::look_in(&dir), first);
        println!("read back in {:?}", started.elapsed());
        assert!(started.elapsed() < std::time::Duration::from_millis(100));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn what_windows_says_is_kept_until_it_restarts() {
        assert!(same_boot(1_760_000_000, 1_760_000_002));
        assert!(!same_boot(1_760_000_000, 1_760_003_600));
        let dir = std::env::temp_dir().join(format!("g1t-facts-kept-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let Some(boot) = booted_at() else { return };
        let kept = Kept { boot, facts: clean_home() };
        std::fs::write(dir.join(FACTS_FILE), serde_json::to_vec(&kept).unwrap()).unwrap();
        assert_eq!(WindowsFacts::look_in(&dir), clean_home());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wsl_says_its_version_in_any_language() {
        assert_eq!(wsl_version("WSL version: 2.5.9.0\nKernel version: 6.6.87.2-1\n"), Some((2, 5, 9)));
        assert_eq!(wsl_version("W\0S\0L\0-\0V\0e\0r\0s\0i\0o\0n\0:\0 \x002\0.\x000\0.\x004\0.\x000\0"), Some((2, 0, 4)));
        assert_eq!(wsl_version("Version de WSL : 1.2.5.0"), Some((1, 2, 5)));
        assert_eq!(wsl_version("Invalid command line option: --version"), None);
    }

    #[test]
    fn linux_says_what_kvm_lacks() {
        assert_eq!(cpu_flags("processor\t: 0\nflags\t\t: fpu vme sse vmx ept\n"), (Some(true), false));
        assert_eq!(cpu_flags("flags\t\t: fpu sse hypervisor\n"), (Some(false), true));
        assert_eq!(cpu_flags("Features\t: fp asimd\n"), (None, false));
        let all = KvmFacts { device: true, usable: true, cpu: Some(true), guest: false, qemu: true };
        assert_eq!(kvm_needs(&all), vec![]);
        assert_eq!(kvm_needs(&KvmFacts { usable: false, ..all.clone() }), vec![Need::KvmGroup]);
        assert_eq!(kvm_needs(&KvmFacts { device: false, usable: false, ..all.clone() }), vec![Need::KvmModule]);
        assert_eq!(kvm_needs(&KvmFacts { device: false, usable: false, cpu: Some(false), ..all.clone() }), vec![Need::Virtualization]);
        assert_eq!(
            kvm_needs(&KvmFacts { device: false, usable: false, cpu: Some(false), guest: true, qemu: false }),
            vec![Need::NestedVirtualization, Need::Qemu]
        );
    }

    #[test]
    fn a_mac_says_what_vfkit_lacks() {
        assert_eq!(macos_major("14.6.1\n"), Some(14));
        assert_eq!(vfkit_needs(Some(12), false, true), vec![Need::MacosUpdate]);
        assert_eq!(vfkit_needs(Some(15), false, false), vec![Need::Homebrew]);
        assert_eq!(vfkit_needs(Some(15), false, true), vec![Need::Vfkit]);
        assert_eq!(vfkit_needs(None, true, false), vec![]);
    }

    #[test]
    fn needs_are_said_by_name_and_old_apps_still_read_them() {
        assert_eq!(serde_json::to_string(&Need::VmPlatform).unwrap(), r#""vm_platform""#);
        assert_eq!(serde_json::from_str::<Need>(r#""nested_virtualization""#).unwrap(), Need::NestedVirtualization);
        // A desktop app from before `needs` reads the cause's words.
        assert!(Need::Wsl.said("linux").0.to_ascii_lowercase().contains("wsl is not installed"));
        assert!(Need::WindowsSandbox.said("windows").0.to_ascii_lowercase().contains("windows sandbox is not turned on"));
        assert!(Need::Virtualization.said("linux").0.to_ascii_lowercase().contains("vt-x"));
        assert!(Need::Homebrew.said("linux").0.contains("vfkit") && Need::Homebrew.said("linux").0.contains("not installed"));
        assert!(Need::WindowsUpdate.said("windows").0.contains("24H2"));
    }
}
