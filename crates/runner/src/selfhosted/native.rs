//! Jobs native to the runner's own OS, each in a throwaway virtual machine
//! made for it and destroyed after: `vm` isolation (sandbox.rs).
//!
//! - **Windows: Windows Sandbox**, through its command line (`wsb`, in
//!   Windows 11 24H2 and later). Each job gets a fresh sandbox: a Hyper-V
//!   VM with its own kernel, started from the machine's own Windows image
//!   and discarded, disk and all, when it stops. Its configuration turns
//!   off everything that reaches the machine: no GPU, no clipboard, no
//!   printers, no microphone or camera, and one folder mapped read-only,
//!   which holds only a copy of the harness and the job's script. The
//!   runner on the machine starts the sandbox, runs the script in it as
//!   SYSTEM (`wsb exec`, which waits and returns the exit code) and stops
//!   it. Windows Sandbox needs Windows 11 Pro, Enterprise or Education
//!   with the Windows Sandbox feature on; it is not in Home.
//!
//!   Chosen over Hyper-V-isolated Windows containers, which need the
//!   Containers and Hyper-V features (Windows 11 Pro or Enterprise, and an
//!   administrator to turn them on), a container engine in Windows
//!   containers mode, and an image matching the machine's Windows build.
//!   A Windows Sandbox needs none of that, only the one feature, and its
//!   disposable VM is the same kind of wall.
//!
//! - **macOS: a cloned macOS VM** (designed, not run on a Mac yet). Each
//!   job gets an APFS clone of a signed macOS image, booted with Apple's
//!   Virtualization framework through `tart` with no display, no audio,
//!   no clipboard and no shared folder, and deleted after. Apple's licence
//!   allows two macOS VMs per Mac at once ([`MacVm::MAX_VMS`]); a runner
//!   runs one job at a time, so a Mac runs at most two such runners.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, Result, anyhow, bail};
use serde::Serialize;

use super::sandbox::{Isolation, SandboxDriver};

/// Whether a kind of sandbox can be made here, and if not, why and what
/// to do about it: what `g1t-runner sandbox status` reports for each
/// capability, and what the desktop app shows.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Availability {
    pub available: bool,
    /// Why it is not, in a sentence.
    pub cause: Option<String>,
    /// What the person can do about it, in a sentence.
    pub fix: Option<String>,
}

impl Availability {
    pub fn yes() -> Availability {
        Availability { available: true, cause: None, fix: None }
    }
    pub fn no(cause: impl Into<String>, fix: impl Into<String>) -> Availability {
        Availability { available: false, cause: Some(cause.into()), fix: Some(fix.into()) }
    }
}

// --- Windows Sandbox --------------------------------------------------------

/// Where the job's read-only folder appears inside the sandbox.
pub const DROP_IN_SANDBOX: &str = r"C:\g1t";
/// Where a workflow job keeps its files inside the sandbox.
pub const WORK_IN_SANDBOX: &str = r"C:\work";

/// Windows Sandbox, one per job.
pub struct WindowsSandbox;

/// What a machine has: the feature's program, and its command line.
#[derive(Clone, Copy, Debug, Default)]
pub struct WsbFound {
    /// `WindowsSandbox.exe` in System32: the feature is on.
    pub feature: bool,
    /// `wsb.exe` answers: Windows 11 24H2 or later.
    pub cli: bool,
}

impl WsbFound {
    pub fn look() -> WsbFound {
        let windir = std::env::var_os("windir").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        let feature = windir.join("System32").join("WindowsSandbox.exe").exists();
        let cli = feature && wsb().arg("--version").stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success());
        WsbFound { feature, cli }
    }

    pub fn availability(self) -> Availability {
        if !cfg!(windows) {
            return Availability::no("Windows Sandbox is only on Windows.", "Use a Windows machine for Windows jobs.");
        }
        if !self.feature {
            return Availability::no(
                "Windows Sandbox is not turned on, or this edition of Windows has none (Home does not).",
                "On Windows 11 Pro, Enterprise or Education, turn on Windows Sandbox under Settings, System, Optional features, More Windows features, then restart.",
            );
        }
        if !self.cli {
            return Availability::no(
                "This Windows has Windows Sandbox but not its command line, wsb, which came in Windows 11 24H2.",
                "Update Windows to 24H2 or later.",
            );
        }
        Availability::yes()
    }
}

impl SandboxDriver for WindowsSandbox {
    fn name(&self) -> &'static str {
        "Windows Sandbox"
    }
    fn preflight(&self) -> Result<Isolation> {
        let found = WsbFound::look().availability();
        if found.available {
            return Ok(Isolation::Vm);
        }
        bail!("{} {}", found.cause.unwrap_or_default(), found.fix.unwrap_or_default())
    }
}

fn wsb() -> Command {
    let mut command = Command::new("wsb");
    hide_window(&mut command);
    command
}

/// No console window flashes up for a command the runner runs.
pub fn hide_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = command;
}

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

/// A job's sandbox's configuration (a `.wsb` file's XML, which `wsb start
/// -c` takes as a string). Every redirection that reaches the machine is
/// off; the only folder is `drop`, read-only.
pub fn wsb_config(drop: &Path, memory_mib: u64) -> String {
    format!(
        "<Configuration>\
<vGPU>Disable</vGPU>\
<Networking>Enable</Networking>\
<AudioInput>Disable</AudioInput>\
<VideoInput>Disable</VideoInput>\
<ClipboardRedirection>Disable</ClipboardRedirection>\
<PrinterRedirection>Disable</PrinterRedirection>\
<ProtectedClient>Enable</ProtectedClient>\
<MemoryInMB>{memory_mib}</MemoryInMB>\
<MappedFolders><MappedFolder><HostFolder>{}</HostFolder><SandboxFolder>{DROP_IN_SANDBOX}</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder></MappedFolders>\
</Configuration>",
        xml_escape(&drop.display().to_string())
    )
}

/// A string in PowerShell's single quotes, where nothing is expanded and a
/// quote is written twice.
pub fn ps_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// The script a job runs in its sandbox: a firewall rule against the
/// machine, its variables, then the harness. The variables are written
/// here, in the job's read-only folder, rather than on `wsb exec`'s
/// command line, where the machine's other programs could read them.
///
/// The firewall rule keeps the job from the machine's own services on the
/// address the sandbox reaches it by (its gateway), but the job runs as
/// SYSTEM in its sandbox and could remove it: it is a speed bump, not a
/// wall. The wall is the VM.
pub fn job_script(env: &BTreeMap<String, String>) -> String {
    let mut script = String::from(
        "$ErrorActionPreference = 'Stop'\r\n\
$gateway = (Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Select-Object -First 1).NextHop\r\n\
if ($gateway) { New-NetFirewallRule -DisplayName 'g1t: not the machine' -Direction Outbound -Action Block -Protocol TCP -RemoteAddress $gateway | Out-Null }\r\n",
    );
    script.push_str(&format!("New-Item -ItemType Directory -Force -Path {} | Out-Null\r\n", ps_quote(WORK_IN_SANDBOX)));
    for (name, value) in env {
        // Names are the harness's own (`ACTIONS_TOKEN`, `MODE`…): only
        // letters, digits and underscores reach `$env:`.
        if name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            script.push_str(&format!("${{env:{name}}} = {}\r\n", ps_quote(value)));
        }
    }
    script.push_str(&format!("$env:G1T_RUNNER_ROOT = {}\r\n", ps_quote(WORK_IN_SANDBOX)));
    script.push_str(&format!("Set-Location {}\r\n", ps_quote(WORK_IN_SANDBOX)));
    script.push_str(&format!("& {}\r\nexit $LASTEXITCODE\r\n", ps_quote(&format!(r"{DROP_IN_SANDBOX}\g1t-runner.exe"))));
    script
}

/// What `wsb exec` runs.
pub fn exec_command() -> String {
    format!(r"powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File {DROP_IN_SANDBOX}\job.ps1")
}

/// `{"ExitCode": 7}`, from `wsb exec --raw`.
pub fn parse_exit_code(raw: &str) -> Option<i32> {
    let start = raw.find('{')?;
    let value: serde_json::Value = serde_json::from_str(raw[start..].trim()).ok()?;
    value.get("ExitCode").and_then(serde_json::Value::as_i64).map(|code| code as i32)
}

/// `{"Id": "…"}`, from `wsb start --raw`.
pub fn parse_id(raw: &str) -> Option<String> {
    let start = raw.find('{')?;
    let value: serde_json::Value = serde_json::from_str(raw[start..].trim()).ok()?;
    value.get("Id").and_then(serde_json::Value::as_str).map(str::to_owned)
}

/// A job's sandbox, while it exists.
pub struct WsbJob {
    pub id: String,
    /// The job's read-only folder on the machine, removed after.
    pub drop: PathBuf,
}

impl WsbJob {
    /// Makes the job's folder (a copy of this program, which is the
    /// harness, and its script) and starts its sandbox.
    pub fn start(drop: PathBuf, env: &BTreeMap<String, String>, memory_mib: u64) -> Result<WsbJob> {
        let _ = std::fs::remove_dir_all(&drop);
        std::fs::create_dir_all(&drop).with_context(|| format!("could not make {}", drop.display()))?;
        let me = std::env::current_exe().context("could not find this program, the job's harness")?;
        std::fs::copy(&me, drop.join("g1t-runner.exe")).context("could not copy the harness for the sandbox")?;
        std::fs::write(drop.join("job.ps1"), job_script(env))?;
        let output = wsb().args(["start", "--raw", "-c", &wsb_config(&drop, memory_mib)]).output().context("could not run wsb")?;
        let text = String::from_utf8_lossy(&output.stdout);
        let Some(id) = parse_id(&text).filter(|_| output.status.success()) else {
            let _ = std::fs::remove_dir_all(&drop);
            bail!("Windows Sandbox did not start: {} {}", text.trim(), String::from_utf8_lossy(&output.stderr).trim());
        };
        if let Some(parent) = drop.parent() {
            let _ = std::fs::write(parent.join("sandbox-id"), &id);
        }
        Ok(WsbJob { id, drop })
    }

    /// The process that runs the job and waits for it: its standard output
    /// carries the exit code ([`parse_exit_code`]).
    pub fn exec(&self) -> Command {
        let mut command = wsb();
        command.args(["exec", "--raw", "--id", &self.id, "-c", &exec_command(), "-r", "System"]);
        command.stdout(Stdio::piped()).stderr(Stdio::null()).stdin(Stdio::null());
        command
    }

    /// Stops the sandbox, which discards it.
    pub fn stop(&self) {
        let _ = wsb().args(["stop", "--id", &self.id]).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }

    pub fn clean(&self) {
        self.stop();
        let _ = std::fs::remove_dir_all(&self.drop);
        if let Some(parent) = self.drop.parent() {
            let _ = std::fs::remove_file(parent.join("sandbox-id"));
        }
    }
}

/// Where a runner notes the sandbox it is running, so that one, and only
/// that one, is stopped if the runner stopped mid-job: the person may have
/// Windows Sandboxes of their own open.
pub fn noted(folder: &Path) -> PathBuf {
    folder.join("native").join("sandbox-id")
}

/// Stops the sandbox an earlier run of this runner left, if any, and
/// removes the job folders it left: a runner stopped mid-job (a crash, or
/// `taskkill /F`) never cleaned its own, and a job's script holds the
/// job's token.
pub fn sweep(folder: &Path) {
    let note = noted(folder);
    if let Ok(id) = std::fs::read_to_string(&note) {
        let id = id.trim();
        if parse_list(&String::from_utf8_lossy(&wsb().args(["list", "--raw"]).output().map(|o| o.stdout).unwrap_or_default())).iter().any(|running| running == id) {
            let _ = wsb().args(["stop", "--id", id]).stdout(Stdio::null()).stderr(Stdio::null()).status();
        }
        let _ = std::fs::remove_file(&note);
    }
    for left in job_folders(&folder.join("native")) {
        let _ = std::fs::remove_dir_all(left);
    }
}

/// The job folders in a runner's `native` folder: `g1t-<job id>`, as
/// exec.rs names them.
pub fn job_folders(native: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(native) else { return Vec::new() };
    entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_dir()) && entry.file_name().to_string_lossy().starts_with("g1t-"))
        .map(|entry| entry.path())
        .collect()
}

/// The ids in `wsb list --raw`.
pub fn parse_list(raw: &str) -> Vec<String> {
    let Some(start) = raw.find('{') else { return Vec::new() };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw[start..].trim()) else { return Vec::new() };
    value
        .get("WindowsSandboxEnvironments")
        .and_then(serde_json::Value::as_array)
        .map(|all| all.iter().filter_map(|e| e.get("Id").and_then(serde_json::Value::as_str).map(str::to_owned)).collect())
        .unwrap_or_default()
}

// --- macOS VMs (designed) -----------------------------------------------------

/// A cloned macOS VM per job, through `tart` on Apple's Virtualization
/// framework. **Designed, not run on a Mac yet:** its commands are built
/// and tested here, and [`SandboxDriver::preflight`] says it is not
/// available, so no Mac registers as able to take macOS jobs until it has
/// been run on one.
///
/// - The image is an OCI image of a macOS VM, named by digest in the
///   signed release manifest, so `tart clone` fetches exactly that.
/// - `tart run --no-graphics --no-audio --no-clipboard`, with no `--dir`:
///   no display, no sound, no clipboard, no folder of the Mac's.
/// - The job runs through `tart exec` (the guest agent in the image), and
///   the VM is stopped and deleted after.
pub struct MacVm;

// The commands are built and tested ahead of the driver that runs them.
#[allow(dead_code)]
impl MacVm {
    /// Apple's macOS licence: two virtual copies per Mac.
    pub const MAX_VMS: u32 = 2;

    pub fn clone_args(image: &str, name: &str) -> Vec<String> {
        vec!["clone".into(), image.into(), name.into()]
    }

    pub fn run_args(name: &str) -> Vec<String> {
        vec!["run".into(), "--no-graphics".into(), "--no-audio".into(), "--no-clipboard".into(), name.into()]
    }

    pub fn exec_args(name: &str, script: &str) -> Vec<String> {
        vec!["exec".into(), name.into(), "/bin/bash".into(), "-lc".into(), script.into()]
    }

    pub fn delete_args(name: &str) -> Vec<String> {
        vec!["delete".into(), name.into()]
    }

    pub fn availability() -> Availability {
        if !cfg!(target_os = "macos") {
            return Availability::no("macOS VMs are only on a Mac.", "Use a Mac for macOS jobs.");
        }
        Availability::no(
            "Sandboxed macOS jobs are not released yet.",
            "Run macOS jobs on a runner registered with --no-docker (host mode, unsandboxed) for now, or wait for a release that has them.",
        )
    }
}

impl SandboxDriver for MacVm {
    fn name(&self) -> &'static str {
        "a cloned macOS VM per job"
    }
    fn preflight(&self) -> Result<Isolation> {
        let why = MacVm::availability();
        Err(anyhow!("{} {}", why.cause.unwrap_or_default(), why.fix.unwrap_or_default()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_job_sandbox_reaches_nothing_of_the_machines_but_its_read_only_folder() {
        let xml = wsb_config(Path::new(r"C:\Users\a & b\.g1t-runner\native\job_1"), 4096);
        for off in ["vGPU", "AudioInput", "VideoInput", "ClipboardRedirection", "PrinterRedirection"] {
            assert!(xml.contains(&format!("<{off}>Disable</{off}>")), "{off} in {xml}");
        }
        assert!(xml.contains("<ProtectedClient>Enable</ProtectedClient>"));
        assert_eq!(xml.matches("<MappedFolder>").count(), 1);
        assert!(xml.contains("<ReadOnly>true</ReadOnly>"));
        assert!(xml.contains(r"<HostFolder>C:\Users\a &amp; b\.g1t-runner\native\job_1</HostFolder>"));
        assert!(xml.contains("<MemoryInMB>4096</MemoryInMB>"));
        assert!(!xml.contains("LogonCommand"), "the job runs through wsb exec, not at logon");
    }

    #[test]
    fn the_job_script_quotes_every_value() {
        let mut env = BTreeMap::new();
        env.insert("ACTIONS_TOKEN".to_owned(), "it's $(evil) `x`".to_owned());
        env.insert("MODE".to_owned(), "actions".to_owned());
        env.insert("BAD NAME;rm".to_owned(), "x".to_owned());
        let script = job_script(&env);
        assert!(script.contains("${env:ACTIONS_TOKEN} = 'it''s $(evil) `x`'"), "{script}");
        assert!(script.contains("${env:MODE} = 'actions'"));
        assert!(!script.contains("BAD NAME"));
        assert!(script.contains(r"$env:G1T_RUNNER_ROOT = 'C:\work'"));
        assert!(script.ends_with("& 'C:\\g1t\\g1t-runner.exe'\r\nexit $LASTEXITCODE\r\n"));
        assert!(script.contains("New-NetFirewallRule"));
    }

    #[test]
    fn a_runner_stopped_mid_job_has_its_job_folders_swept() {
        let folder = std::env::temp_dir().join(format!("g1t-native-sweep-{}", std::process::id()));
        let native = folder.join("native");
        std::fs::create_dir_all(native.join("g1t-job_1")).unwrap();
        std::fs::write(native.join("g1t-job_1").join("job.ps1"), "${env:ACTIONS_TOKEN} = 't'").unwrap();
        std::fs::create_dir_all(native.join("native")).unwrap();
        std::fs::write(native.join("runner.log"), "").unwrap();
        assert_eq!(job_folders(&native), [native.join("g1t-job_1")]);
        // No sandbox was noted, so nothing is stopped; the job's folder goes.
        sweep(&folder);
        assert!(!native.join("g1t-job_1").exists());
        assert!(native.join("native").exists() && native.join("runner.log").exists(), "only job folders");
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn wsb_output_reads() {
        assert_eq!(parse_exit_code("{\n  \"ExitCode\": 7\n}\n"), Some(7));
        assert_eq!(parse_exit_code("nothing"), None);
        assert_eq!(parse_id("{\n  \"Id\": \"902c8565-4b36\"\n}"), Some("902c8565-4b36".into()));
        assert_eq!(parse_list("{\"WindowsSandboxEnvironments\": [{\"Id\": \"a\"}, {\"Id\": \"b\"}]}"), vec!["a", "b"]);
        assert!(parse_list("{\"WindowsSandboxEnvironments\": []}").is_empty());
        assert!(exec_command().ends_with(r"-File C:\g1t\job.ps1"));
    }

    #[test]
    fn what_is_missing_says_how_to_fix_it() {
        if cfg!(windows) {
            let off = WsbFound { feature: false, cli: false }.availability();
            assert!(!off.available);
            assert!(off.cause.unwrap().contains("not turned on"));
            assert!(off.fix.unwrap().contains("Pro, Enterprise or Education"));
            assert!(WsbFound { feature: true, cli: false }.availability().cause.unwrap().contains("24H2"));
            assert!(WsbFound { feature: true, cli: true }.availability().available);
        } else {
            assert!(!WsbFound { feature: true, cli: true }.availability().available);
        }
    }

    #[test]
    fn a_macos_vm_shares_nothing_and_is_not_offered_until_run() {
        let run = MacVm::run_args("g1t-job_1");
        assert!(run.iter().any(|a| a == "--no-graphics") && run.iter().any(|a| a == "--no-clipboard"));
        assert!(!run.iter().any(|a| a.starts_with("--dir")), "no folder of the Mac's");
        assert_eq!(MacVm::clone_args("g1t.sh/flagon-io/macos@sha256:ab", "g1t-job_1"), vec!["clone", "g1t.sh/flagon-io/macos@sha256:ab", "g1t-job_1"]);
        assert_eq!(MacVm::delete_args("x"), vec!["delete", "x"]);
        assert_eq!(MacVm::exec_args("x", "echo hi")[0], "exec");
        assert!(MacVm.preflight().is_err());
        assert_eq!(MacVm::MAX_VMS, 2);
    }

    /// Starts a real Windows Sandbox: run with `cargo test -p g1t-runner -- --ignored windows_sandbox`
    /// on a machine with the feature on.
    #[test]
    #[ignore]
    fn windows_sandbox_runs_a_script_and_keeps_its_folder_read_only() {
        let drop = std::env::temp_dir().join(format!("g1t-wsb-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&drop);
        std::fs::create_dir_all(&drop).unwrap();
        std::fs::write(
            drop.join("job.ps1"),
            "try { 'x' | Out-File C:\\g1t\\written.txt -ErrorAction Stop; exit 3 } catch { }\r\nif (Test-Path 'C:\\Users\\Public\\g1t-from-host') { exit 4 }\r\nexit 7\r\n",
        )
        .unwrap();
        let output = wsb().args(["start", "--raw", "-c", &wsb_config(&drop, 2048)]).output().unwrap();
        let id = parse_id(&String::from_utf8_lossy(&output.stdout)).expect("a sandbox id");
        let job = WsbJob { id, drop: drop.clone() };
        let out = job.exec().output().unwrap();
        let code = parse_exit_code(&String::from_utf8_lossy(&out.stdout));
        job.clean();
        assert_eq!(code, Some(7), "the script ran, and could not write to its folder");
        assert!(!drop.exists());
    }
}
