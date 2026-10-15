//! Set up: what the sandbox still needs on Windows that Windows can do
//! itself, done at once behind one administrator prompt, as Docker
//! Desktop does. The launcher says what is missing, by name, before
//! anything is downloaded (`needs`, crates/runner/src/selfhosted/needs.rs);
//! this turns on the Virtual Machine Platform and Windows Sandbox features
//! and installs or updates WSL, for the kinds of job the person has on.
//!
//! The script is the app's own and fixed: nothing in it comes from the
//! network or from a file another program could change between writing it
//! and Windows running it as administrator. It goes to PowerShell as
//! `-EncodedCommand`, and its only values are the app's own paths.
//!
//! What it turned on that takes a restart, it says by writing this boot's
//! time to the launcher's `restart-pending`: the launcher then says
//! `restart` for the kinds of job that wait on it, until Windows has
//! restarted. After a restart g1t opens again (RunOnce, if it doesn't open
//! at sign-in anyway) and starts the runner as it always does.
//!
//! Everything here runs on a thread of its own: the prompt waits on the
//! person, and installing WSL takes minutes.

use std::path::Path;

use super::launcher::Status;

/// The needs Set up meets.
pub const FIXABLE: [&str; 4] = ["vm_platform", "wsl", "wsl_update", "windows_sandbox"];
/// The launcher's file that says a restart is still to be done (needs.rs's RESTART_FILE).
pub const RESTART_FILE: &str = "restart-pending";
/// What Windows' installer says when it worked and wants a restart.
const NEEDS_RESTART: u32 = 3010;
/// What Windows says when the person said No to the prompt (ERROR_CANCELLED).
const CANCELLED: u32 = 1223;

/// What Set up is to do.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Plan {
    /// Windows features to turn on.
    pub features: Vec<&'static str>,
    pub wsl: Option<Wsl>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Wsl {
    Install,
    Update,
}

impl Plan {
    pub fn is_empty(&self) -> bool {
        self.features.is_empty() && self.wsl.is_none()
    }

    /// What it does, said: `turns on Virtual Machine Platform and installs WSL`.
    pub fn said(&self) -> String {
        let mut steps: Vec<String> = Vec::new();
        let named: Vec<&str> = self
            .features
            .iter()
            .map(|feature| match *feature {
                "VirtualMachinePlatform" => "Virtual Machine Platform",
                "Containers-DisposableClientVM" => "Windows Sandbox",
                other => other,
            })
            .collect();
        if !named.is_empty() {
            steps.push(format!("turns on {}", named.join(" and ")));
        }
        match self.wsl {
            Some(Wsl::Install) => steps.push("installs WSL".into()),
            Some(Wsl::Update) => steps.push("updates WSL".into()),
            None => {}
        }
        steps.join(" and ")
    }
}

/// Whether a kind of job's needs are all ones Set up meets.
pub fn fixable(needs: &[String]) -> bool {
    !needs.is_empty() && needs.iter().all(|need| FIXABLE.contains(&need.as_str()))
}

/// What Set up does for the kinds of job that are on (`on`) and wait only on it.
pub fn plan(status: &Status, on: impl Fn(&str) -> bool) -> Plan {
    plan_of(&needs(status, on))
}

/// The needs of the kinds of job that are on (`on`).
pub fn needs(status: &Status, on: impl Fn(&str) -> bool) -> Vec<String> {
    status.capabilities.iter().filter(|c| on(&c.id) && !c.off()).flat_map(|c| c.needs.iter().cloned()).collect()
}

/// What Set up does for these needs.
pub fn plan_of(needs: &[String]) -> Plan {
    let mut plan = Plan::default();
    for need in needs {
        match need.as_str() {
            "vm_platform" if !plan.features.contains(&"VirtualMachinePlatform") => plan.features.push("VirtualMachinePlatform"),
            "windows_sandbox" if !plan.features.contains(&"Containers-DisposableClientVM") => plan.features.push("Containers-DisposableClientVM"),
            "wsl" => plan.wsl = Some(Wsl::Install),
            "wsl_update" if plan.wsl.is_none() => plan.wsl = Some(Wsl::Update),
            _ => {}
        }
    }
    plan
}

/// A path as a PowerShell single-quoted string.
fn quoted(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', "''"))
}

/// The script, run as administrator: it logs to `log`, and leaves this
/// boot's time in `marker` when what it did takes a restart.
pub fn script(plan: &Plan, log: &Path, marker: &Path) -> String {
    let features = plan.features.iter().map(|f| format!("'{f}'")).collect::<Vec<_>>().join(", ");
    let wsl = match plan.wsl {
        Some(Wsl::Install) => "Install-Wsl '--install', '--no-distribution'",
        Some(Wsl::Update) => "Install-Wsl '--update'",
        None => "",
    };
    format!(
        r#"$ErrorActionPreference = 'Stop'
$log = {log}
$env:WSL_UTF8 = '1'
function Say($text) {{ Add-Content -LiteralPath $log -Value ('g1t setup: ' + $text) }}
function Install-Wsl {{
  # From GitHub first (--web-download), which needs no Microsoft Store; else from the Store.
  foreach ($from in @(@('--web-download'), @())) {{
    $out = Join-Path $env:TEMP 'g1t-setup-wsl.txt'
    $p = Start-Process -FilePath 'wsl.exe' -ArgumentList ($args + $from) -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput $out
    Get-Content -LiteralPath $out -ErrorAction SilentlyContinue | Where-Object {{ $_.Trim() }} | ForEach-Object {{ Say ('wsl: ' + $_.Trim()) }}
    Remove-Item -LiteralPath $out -ErrorAction SilentlyContinue
    if ($p.ExitCode -eq 0) {{ return }}
    Say ('wsl.exe ' + (($args + $from) -join ' ') + ' exited with ' + $p.ExitCode)
  }}
  throw 'WSL could not be installed or updated.'
}}
$restart = $false
function Restart-Pending {{
  Set-Content -LiteralPath {marker} -Value (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')
}}
try {{
  foreach ($name in @({features})) {{
    $feature = Get-WindowsOptionalFeature -Online -FeatureName $name
    if ($feature.State -ne 'Enabled') {{
      Say "Turning on $name."
      $result = Enable-WindowsOptionalFeature -Online -FeatureName $name -All -NoRestart -WarningAction SilentlyContinue
      if ($result.RestartNeeded) {{ $restart = $true }}
    }}
  }}
  {wsl}
  if ($restart) {{
    Restart-Pending
    Say 'Done; Windows needs a restart to finish.'
    exit {NEEDS_RESTART}
  }}
  Say 'Done.'
  exit 0
}} catch {{
  Say ('Failed: ' + $_.Exception.Message)
  # What was turned on still takes the restart; after it, Set up offers what is left.
  if ($restart) {{
    Restart-Pending
    Say 'Windows needs a restart for what was turned on; Set up does the rest after it.'
    exit {NEEDS_RESTART}
  }}
  exit 1
}}
"#,
        log = quoted(log),
        marker = quoted(marker),
    )
}

/// PowerShell's `-EncodedCommand`: UTF-16LE in base64.
pub fn encoded(script: &str) -> String {
    use base64::Engine;
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// How Set up went.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    Done,
    /// Done, and Windows needs a restart to finish.
    Restart,
    /// The person said No to Windows' prompt.
    Declined,
    Failed(String),
}

/// What an exit code means.
pub fn outcome(code: u32) -> Outcome {
    match code {
        0 => Outcome::Done,
        NEEDS_RESTART => Outcome::Restart,
        CANCELLED => Outcome::Declined,
        other => Outcome::Failed(format!("Set up stopped (exit code {other}).")),
    }
}

/// Runs the script as administrator, asking Windows first (its prompt,
/// in front of `window`), and waits for it.
#[cfg(windows)]
pub fn run_elevated(script: &str, window: isize) -> Outcome {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    #[repr(C)]
    struct ShellExecuteInfo {
        size: u32,
        mask: u32,
        window: isize,
        verb: *const u16,
        file: *const u16,
        parameters: *const u16,
        directory: *const u16,
        show: i32,
        instance: isize,
        id_list: *mut std::ffi::c_void,
        class: *const u16,
        class_key: isize,
        hot_key: u32,
        icon_or_monitor: isize,
        process: isize,
    }
    #[link(name = "shell32")]
    unsafe extern "system" {
        fn ShellExecuteExW(info: *mut ShellExecuteInfo) -> i32;
    }
    unsafe extern "system" {
        fn WaitForSingleObject(handle: isize, millis: u32) -> u32;
        fn GetExitCodeProcess(handle: isize, code: *mut u32) -> i32;
        fn CloseHandle(handle: isize) -> i32;
        fn GetLastError() -> u32;
    }
    const SEE_MASK_NOCLOSEPROCESS: u32 = 0x40;
    const SEE_MASK_NOASYNC: u32 = 0x100;
    const SW_HIDE: i32 = 0;
    const INFINITE: u32 = u32::MAX;

    let wide = |text: &str| OsStr::new(text).encode_wide().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let verb = wide("runas");
    let file = wide("powershell.exe");
    let parameters = wide(&format!("-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand {}", encoded(script)));
    let mut info = ShellExecuteInfo {
        size: std::mem::size_of::<ShellExecuteInfo>() as u32,
        mask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC,
        window,
        verb: verb.as_ptr(),
        file: file.as_ptr(),
        parameters: parameters.as_ptr(),
        directory: std::ptr::null(),
        show: SW_HIDE,
        instance: 0,
        id_list: std::ptr::null_mut(),
        class: std::ptr::null(),
        class_key: 0,
        hot_key: 0,
        icon_or_monitor: 0,
        process: 0,
    };
    // SAFETY: `info` and the strings it points to live until the call returns.
    if unsafe { ShellExecuteExW(&mut info) } == 0 {
        let error = unsafe { GetLastError() };
        return if error == CANCELLED { Outcome::Declined } else { Outcome::Failed(format!("Windows couldn't start Set up (error {error}).")) };
    }
    if info.process == 0 {
        return Outcome::Failed("Windows started Set up without a process to wait for.".into());
    }
    let mut code = 0u32;
    // SAFETY: the process handle is ours until CloseHandle.
    unsafe {
        WaitForSingleObject(info.process, INFINITE);
        GetExitCodeProcess(info.process, &mut code);
        CloseHandle(info.process);
    }
    outcome(code)
}

#[cfg(not(windows))]
pub fn run_elevated(_script: &str, _window: isize) -> Outcome {
    Outcome::Failed("Set up is for Windows; the runner's card says what to do here.".into())
}

/// What Windows' own dialog asks before g1t restarts it.
pub const RESTART_QUESTION: &str = "Restart Windows now to finish setting up the runner?\n\nSave your work first. g1t opens again after the restart and carries on by itself.";

/// Asks with Windows' own dialog, which no page can answer for the
/// person, and restarts Windows on Yes: on a thread of its own, as the
/// dialog waits for them. Restarting is asked this way wherever the button
/// is, the site's pages included.
pub fn ask_and_restart(app_exe: std::path::PathBuf) -> Result<(), String> {
    if !cfg!(windows) {
        return Err("Only Windows is restarted from g1t.".into());
    }
    std::thread::Builder::new()
        .name("g1t-restart-windows".into())
        .spawn(move || {
            if asked_yes(RESTART_QUESTION) {
                let _ = restart_windows(&app_exe);
            }
        })
        .map(|_| ())
        .map_err(|e| format!("Windows couldn't be asked: {e}"))
}

#[cfg(windows)]
fn asked_yes(question: &str) -> bool {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "user32")]
    unsafe extern "system" {
        fn MessageBoxW(window: isize, text: *const u16, caption: *const u16, kind: u32) -> i32;
    }
    const MB_YESNO: u32 = 0x4;
    const MB_ICONQUESTION: u32 = 0x20;
    const MB_DEFBUTTON2: u32 = 0x100;
    const MB_SETFOREGROUND: u32 = 0x1_0000;
    const MB_TOPMOST: u32 = 0x4_0000;
    const IDYES: i32 = 6;
    let wide = |text: &str| OsStr::new(text).encode_wide().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (text, caption) = (wide(question), wide("g1t"));
    // SAFETY: both strings live until the call returns. No owner window: this
    // isn't the window's thread, and the dialog stays on top by itself.
    unsafe { MessageBoxW(0, text.as_ptr(), caption.as_ptr(), MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2 | MB_SETFOREGROUND | MB_TOPMOST) == IDYES }
}

#[cfg(not(windows))]
fn asked_yes(_question: &str) -> bool {
    false
}

/// Restarts Windows now. g1t opens again after, once (RunOnce), and
/// carries on setting up.
fn restart_windows(app_exe: &Path) -> Result<(), String> {
    open_after_restart(app_exe);
    let status = super::backend::quiet("shutdown.exe")
        .args(["/r", "/t", "0", "/c", "g1t is restarting Windows to finish setting up the runner."])
        .status()
        .map_err(|e| format!("Windows couldn't be restarted: {e}"))?;
    if status.success() { Ok(()) } else { Err("Windows didn't restart: restart it from the Start menu.".into()) }
}

/// g1t opens once when the person next signs in to Windows, after the
/// restart (`RunOnce`, which Windows clears as it runs it), whether or not
/// it opens at sign-in anyway: setup carries on from there.
pub fn open_after_restart(app_exe: &Path) {
    if cfg!(windows) {
        let _ = super::backend::quiet("reg")
            .args(["add", r"HKCU\Software\Microsoft\Windows\CurrentVersion\RunOnce", "/v", "g1t", "/t", "REG_SZ", "/d", &format!("\"{}\"", app_exe.display()), "/f"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(json: &str) -> Status {
        super::super::launcher::parse(json).unwrap()
    }

    #[test]
    fn set_up_does_what_the_kinds_that_are_on_need() {
        let clean = status(
            r#"{"schema":1,"state":"error","capabilities":[
              {"id":"linux","available":false,"state":"error","needs":["vm_platform","wsl"]},
              {"id":"windows","available":false,"state":"absent","needs":["windows_sandbox"]}]}"#,
        );
        let both = plan(&clean, |_| true);
        assert_eq!(both.features, ["VirtualMachinePlatform", "Containers-DisposableClientVM"]);
        assert_eq!(both.wsl, Some(Wsl::Install));
        assert_eq!(both.said(), "turns on Virtual Machine Platform and Windows Sandbox and installs WSL");
        // Windows jobs stopped by the person: their feature is left alone.
        let linux = plan(&clean, |kind| kind == "linux");
        assert_eq!(linux.features, ["VirtualMachinePlatform"]);
        assert_eq!(linux.said(), "turns on Virtual Machine Platform and installs WSL");
        let update = status(r#"{"schema":1,"state":"error","capabilities":[{"id":"linux","available":false,"needs":["wsl_update"]}]}"#);
        assert_eq!(plan(&update, |_| true).said(), "updates WSL");
        // Home: nothing Set up can do for Windows jobs.
        let home = status(r#"{"schema":1,"state":"running","capabilities":[{"id":"linux","available":true,"state":"running"},{"id":"windows","available":false,"needs":["windows_edition"]}]}"#);
        assert!(plan(&home, |_| true).is_empty());
        assert!(fixable(&["vm_platform".into(), "wsl".into()]));
        assert!(!fixable(&["virtualization".into(), "vm_platform".into()]));
        assert!(!fixable(&[]));
    }

    #[test]
    fn the_script_is_fixed_and_says_a_restart_by_its_exit_code() {
        let plan = Plan { features: vec!["VirtualMachinePlatform"], wsl: Some(Wsl::Install) };
        let script = script(&plan, Path::new(r"C:\Users\o'neil\AppData\Local\sh.g1t\runner\setup.log"), Path::new(r"C:\x\restart-pending"));
        assert!(script.contains(r"$log = 'C:\Users\o''neil\AppData\Local\sh.g1t\runner\setup.log'"));
        assert!(script.contains("foreach ($name in @('VirtualMachinePlatform'))"));
        assert!(script.contains("Install-Wsl '--install', '--no-distribution'"));
        assert!(script.contains("exit 3010"));
        assert!(!script.contains("{features}") && !script.contains("{wsl}"));
        assert_eq!(outcome(0), Outcome::Done);
        assert_eq!(outcome(3010), Outcome::Restart);
        assert_eq!(outcome(1223), Outcome::Declined);
        assert!(matches!(outcome(1), Outcome::Failed(_)));
        // UTF-16LE in base64, as PowerShell reads it: "a" is 61 00.
        assert_eq!(encoded("a"), "YQA=");
    }

    /// Runs the script as administrator, through Windows' prompt, with
    /// nothing to do: the prompt shows, and its answer comes back.
    /// `cargo test -- --ignored as_administrator --nocapture`, and say Yes.
    #[test]
    #[ignore]
    fn as_administrator_with_nothing_to_do_it_is_done() {
        let dir = std::env::temp_dir().join(format!("g1t-setup-admin-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (log, marker) = (dir.join("setup.log"), dir.join(RESTART_FILE));
        let outcome = run_elevated(&script(&Plan::default(), &log, &marker), 0);
        let said = std::fs::read_to_string(&log).unwrap_or_default();
        println!("{outcome:?}\n{said}");
        assert_eq!(outcome, Outcome::Done, "{said}");
        assert_eq!(said.trim(), "g1t setup: Done.");
        assert!(!marker.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Runs the script's WSL step as this user with `--version`, which
    /// changes nothing: wsl.exe started hidden, what it said logged line by
    /// line, and its exit code read. `cargo test -- --ignored the_wsl_step --nocapture`.
    #[test]
    #[ignore]
    fn the_wsl_step_runs_wsl_and_logs_what_it_said() {
        let dir = std::env::temp_dir().join(format!("g1t-setup-wsl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (log, marker) = (dir.join("setup.log"), dir.join(RESTART_FILE));
        let script = script(&Plan { features: vec![], wsl: Some(Wsl::Update) }, &log, &marker).replace("Install-Wsl '--update'", "Install-Wsl '--version'");
        let code = super::super::backend::quiet("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", &encoded(&script)])
            .status()
            .unwrap()
            .code()
            .unwrap();
        let said = std::fs::read_to_string(&log).unwrap();
        println!("exit {code}\n{said}");
        assert_eq!(outcome(code as u32), Outcome::Done, "{said}");
        assert!(said.contains("g1t setup: wsl: "), "{said}");
        assert!(said.trim_end().ends_with("g1t setup: Done."), "{said}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Runs the script as this user, not as administrator, so it changes
    /// nothing: it must parse, log, and fail plainly. Windows only:
    /// `cargo test -- --ignored the_script_runs --nocapture`.
    #[test]
    #[ignore]
    fn the_script_runs_and_without_an_administrator_says_why() {
        let dir = std::env::temp_dir().join(format!("g1t-setup-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (log, marker) = (dir.join("setup.log"), dir.join(RESTART_FILE));
        let plan = Plan { features: vec!["VirtualMachinePlatform"], wsl: Some(Wsl::Update) };
        let code = super::super::backend::quiet("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", &encoded(&script(&plan, &log, &marker))])
            .status()
            .unwrap()
            .code()
            .unwrap();
        let said = std::fs::read_to_string(&log).unwrap();
        println!("exit {code}\n{said}");
        assert_eq!(outcome(code as u32), Outcome::Failed("Set up stopped (exit code 1).".into()));
        assert!(said.contains("g1t setup: Failed:"), "{said}");
        assert!(!marker.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
