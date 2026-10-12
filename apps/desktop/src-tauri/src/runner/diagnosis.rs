//! What the runner is doing, and when it is not running or is failing, why
//! and how to fix it: the one catalogue of those words. The tray shows a
//! diagnosis's title, the settings window all of it with its buttons, and
//! the site shows it as the app sends it, word for word, on its Runners
//! page (and keeps it, so a person's other computers are listed with
//! theirs). The site adds nothing of its own: what it says of a computer
//! whose g1t is closed is `closed` here, sent with every report.
//!
//! Each action is an id the settings window and the site turn into a
//! button; bridge.rs and settings.js do what it says.
//!
//! The sandbox (launcher.rs) says why something is wrong in its own
//! sentences. Those this catalogue knows (WSL not installed, virtualization
//! off, Windows Sandbox off, …) are said in its words, with a fix and its
//! buttons; any other is shown as the launcher wrote it. With the sandbox,
//! each kind of job it runs (Linux jobs, Windows jobs) has a line of its
//! own as well (`capabilities`), since one can run while the other cannot.

use serde::Serialize;

use super::launcher::{self, State, Status, Why};

/// Every state the runner can be in.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Code {
    /// Running jobs is turned off in settings.
    #[default]
    Off,
    /// The person pressed Stop.
    Stopped,
    Starting,
    /// Waiting for the site to make a registration token.
    Registering,
    /// Nobody is signed in to g1t in the app.
    SignedOut,
    /// Signed in, owning no workspace: nowhere to register.
    NoWorkspace,
    /// The person may not add runners to the workspace.
    NotAllowed,
    RegisterFailed,
    Idle,
    Busy,
    NoDocker,
    /// The `g1t-runner` here is from before its sandbox launcher.
    NoLauncher,
    /// Windows, without WSL, which holds the sandbox's Linux VM.
    NoWsl,
    /// WSL set to mirrored networking, which reaches this computer's localhost.
    WslMirrored,
    /// The computer's virtualization is turned off.
    NoVirtualization,
    /// macOS, without vfkit, which runs the sandbox's VM.
    NoVfkit,
    /// Linux, with neither Sysbox in Docker nor KVM.
    NoSysbox,
    /// The sandbox's image couldn't be downloaded, or isn't the release's.
    ImageFailed,
    /// The sandbox can't be made here, for a reason in the launcher's words.
    SandboxUnavailable,
    /// The sandbox failed, in the launcher's words.
    SandboxFailed,
    /// The computer has a sandbox the app didn't make, and has room for one.
    SandboxTaken,
    Updating,
    UpdateFailed,
    Offline,
    Crashed,
}

/// How a state should look: a dot's colour.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Tone {
    Ok,
    Working,
    Off,
    Warning,
    Problem,
}

/// A one-click fix.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Action {
    pub id: &'static str,
    pub label: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Diagnosis {
    pub code: Code,
    pub tone: Tone,
    /// One line: the tray's, and the heading everywhere else.
    pub title: String,
    /// Why, in a sentence.
    pub cause: Option<String>,
    /// What to do about it.
    pub fix: Option<String>,
    pub actions: Vec<Action>,
    /// With the sandbox: each kind of job it runs, on its own line.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<CapabilityLine>,
}

/// One kind of job the sandbox runs, `linux` or `windows` (or `macos`),
/// and how it is: Linux jobs can run while Windows jobs cannot.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CapabilityLine {
    pub id: String,
    /// `Linux jobs`.
    pub label: String,
    pub tone: Tone,
    /// `Waiting for jobs`, `Not available`.
    pub title: String,
    pub cause: Option<String>,
    pub fix: Option<String>,
    pub actions: Vec<Action>,
}

/// What the words are filled in with.
#[derive(Clone, Debug, Default)]
pub struct Facts {
    pub workspace: Option<String>,
    /// How jobs run, as `sandboxed`, `in Docker`, `on this computer`.
    pub backend: &'static str,
    pub machine: String,
    pub job: Option<String>,
    pub detail: Option<String>,
    pub exit_code: Option<i32>,
    pub wait_seconds: Option<u64>,
    /// The server's host: `g1t.sh`.
    pub server: String,
    pub platform: String,
    /// What the sandbox says to do, for a cause in its own words.
    pub fix: Option<String>,
    /// How the sandbox is, when jobs run sandboxed.
    pub sandbox: Option<Status>,
}

const START: Action = Action { id: "start", label: "Start" };
const TURN_ON: Action = Action { id: "start", label: "Turn on" };
const RETRY: Action = Action { id: "retry", label: "Retry" };
const RESTART: Action = Action { id: "restart", label: "Restart" };
const SIGN_IN: Action = Action { id: "sign_in", label: "Sign in" };
const CHOOSE_WORKSPACE: Action = Action { id: "choose_workspace", label: "Choose workspace" };
const NEW_WORKSPACE: Action = Action { id: "new_workspace", label: "Create a workspace" };
const CHOOSE_BACKEND: Action = Action { id: "choose_backend", label: "Choose how jobs run" };
const OPEN_DOCKER: Action = Action { id: "open_docker", label: "Open Docker" };
const GET_DOCKER: Action = Action { id: "get_docker", label: "Get Docker" };
const INSTALL_SYSBOX: Action = Action { id: "install_sysbox", label: "Install Sysbox" };
const COPY_WSL_INSTALL: Action = Action { id: "copy_wsl_install", label: "Copy command" };
const COPY_VFKIT_INSTALL: Action = Action { id: "copy_vfkit_install", label: "Copy command" };
const WINDOWS_FEATURES: Action = Action { id: "windows_features", label: "Open Windows features" };
const LEARN_MORE: Action = Action { id: "learn_more", label: "Learn more" };
const VIEW_LOG: Action = Action { id: "view_log", label: "View log" };
const REPORT: Action = Action { id: "report", label: "Report" };
const VIEW_RUNNERS: Action = Action { id: "view_runners", label: "View on g1t" };

fn some(text: impl Into<String>) -> Option<String> {
    Some(text.into())
}

/// The catalogue.
pub fn diagnose(code: Code, facts: &Facts) -> Diagnosis {
    let workspace = facts.workspace.as_deref().unwrap_or("your workspace");
    let detail = facts.detail.clone();
    let (tone, title, cause, fix, actions): (Tone, String, Option<String>, Option<String>, Vec<Action>) = match code {
        Code::Off => (
            Tone::Off,
            "Not running: turned off".into(),
            some("Running jobs on this computer is turned off in g1t's settings."),
            some("Turn it on to run your workspace's self-hosted jobs here while g1t is open."),
            vec![TURN_ON],
        ),
        Code::Stopped => (
            Tone::Off,
            "Not running: stopped".into(),
            some("You stopped the runner. It starts again when you press Start, or when g1t next opens."),
            None,
            vec![START],
        ),
        Code::Starting => (Tone::Working, "Starting".into(), detail, None, vec![]),
        Code::Registering => (
            Tone::Working,
            format!("Registering with {workspace}"),
            some(format!("g1t is registering {} as a runner for {workspace}.", facts.machine)),
            some("Keep g1t open and signed in; it takes a few seconds."),
            vec![],
        ),
        Code::SignedOut => (
            Tone::Warning,
            "Not running: signed out".into(),
            some("This computer isn't registered yet, and registering it needs you signed in to g1t."),
            some("Sign in, as an owner of the workspace the runner is for."),
            vec![SIGN_IN],
        ),
        Code::NoWorkspace => (
            Tone::Warning,
            "Not running: no workspace to run jobs for".into(),
            some("Only a workspace's owners add runners to it, and you don't own one."),
            some("Ask an owner of your workspace to run it, or create a workspace of your own."),
            vec![NEW_WORKSPACE],
        ),
        Code::NotAllowed => (
            Tone::Problem,
            format!("Couldn't register with {workspace}"),
            some(format!("You can't add runners to {workspace}: only its owners can.")),
            some(format!("Ask an owner of {workspace} to make you one, or choose a workspace you own.")),
            vec![CHOOSE_WORKSPACE],
        ),
        Code::RegisterFailed => (
            Tone::Problem,
            format!("Couldn't register with {workspace}"),
            detail.or_else(|| some("g1t didn't make a registration for this computer.")),
            some("It tries again by itself in a few minutes."),
            vec![RETRY, VIEW_LOG],
        ),
        Code::Idle => (
            Tone::Ok,
            "Waiting for jobs".into(),
            some(format!("Running {} for {workspace} on {}.", facts.backend, facts.machine)),
            None,
            vec![VIEW_RUNNERS],
        ),
        Code::Busy => (
            Tone::Working,
            format!("Running {}", facts.job.as_deref().unwrap_or("a job")),
            some(format!("Running {} for {workspace} on {}.", facts.backend, facts.machine)),
            None,
            vec![VIEW_RUNNERS],
        ),
        Code::NoDocker => {
            let app = match facts.platform.as_str() {
                "windows" | "macos" => "Docker Desktop",
                _ => "Docker",
            };
            (
                Tone::Problem,
                "Not running: Docker isn't running".into(),
                some(format!("Running jobs {} needs Docker, and Docker isn't running on this computer, or isn't installed.", facts.backend)),
                some(format!("Start {app}, or install it. The runner starts by itself once Docker answers.")),
                if app == "Docker Desktop" { vec![OPEN_DOCKER, GET_DOCKER] } else { vec![GET_DOCKER] },
            )
        }
        Code::NoLauncher => (
            Tone::Warning,
            "Not running: this g1t-runner has no sandbox".into(),
            some("The g1t-runner g1t downloaded is older than its sandbox launcher, so it can't make a sandbox."),
            some("g1t looks for a newer one by itself; Retry looks now. Or choose to run jobs in Docker or directly on this computer: neither is a sandbox, and settings say what each can reach."),
            vec![RETRY, CHOOSE_BACKEND],
        ),
        Code::NoWsl => (
            Tone::Problem,
            "Not running: WSL isn't installed".into(),
            some("Linux jobs run in a WSL distribution of the runner's own, and WSL isn't installed on this computer."),
            some(format!("Run `{}` in an admin terminal, then restart Windows. It works on every edition of Windows 11, Home included.", launcher::WSL_INSTALL)),
            vec![COPY_WSL_INSTALL, LEARN_MORE],
        ),
        Code::WslMirrored => (
            Tone::Problem,
            "Not running: WSL uses mirrored networking".into(),
            some("WSL is set to mirrored networking, in which Linux reaches this computer's own localhost, so the sandbox won't start."),
            some("Remove networkingMode=mirrored from %USERPROFILE%\\.wslconfig, run `wsl --shutdown`, then Retry."),
            vec![RETRY, LEARN_MORE],
        ),
        Code::NoVirtualization => (
            Tone::Problem,
            "Not running: virtualization is off".into(),
            some("The sandbox is a small virtual machine, and this computer has virtualization turned off."),
            some(if facts.platform == "windows" {
                "Turn on virtualization (Intel VT-x or AMD-V) in this computer's firmware settings, and Virtual Machine Platform in Windows features; then restart."
            } else {
                "Turn on virtualization (Intel VT-x or AMD-V) in this computer's firmware settings, then restart."
            }),
            if facts.platform == "windows" { vec![WINDOWS_FEATURES, LEARN_MORE] } else { vec![RETRY, LEARN_MORE] },
        ),
        Code::NoVfkit => (
            Tone::Problem,
            "Not running: vfkit isn't installed".into(),
            some("Linux jobs run in a small VM that vfkit runs with Apple's Virtualization framework, and vfkit isn't installed."),
            some(format!("Run `{}` in Terminal (macOS 13 or later). The runner starts by itself once it's there.", launcher::VFKIT_INSTALL)),
            vec![COPY_VFKIT_INSTALL, LEARN_MORE],
        ),
        Code::NoSysbox => (
            Tone::Problem,
            "Not running: no Sysbox or KVM".into(),
            some("The sandbox on Linux is the runner's image under Sysbox, or a VM under QEMU with KVM, and this computer has neither."),
            some("Install Sysbox 0.7 or later, or turn on virtualization and install QEMU so /dev/kvm exists. The runner starts by itself once one is there."),
            vec![INSTALL_SYSBOX, CHOOSE_BACKEND],
        ),
        Code::ImageFailed => (
            Tone::Problem,
            "Not running: the sandbox's image didn't download".into(),
            detail.or_else(|| some("The sandbox's image couldn't be downloaded, or wasn't the release's, so it wasn't used.")),
            some("It's only ever used once its signature and SHA-256 are the release's. g1t tries again by itself; check the connection, or report it if it keeps happening."),
            vec![RETRY, REPORT],
        ),
        Code::SandboxUnavailable => (
            Tone::Problem,
            "Not running: the sandbox can't run here".into(),
            detail.or_else(|| some("The sandbox can't be made on this computer.")),
            facts.fix.clone().or_else(|| some("Choose to run jobs in Docker or directly on this computer instead: neither is a sandbox, and settings say what each can reach.")),
            vec![RETRY, LEARN_MORE, CHOOSE_BACKEND],
        ),
        Code::SandboxFailed => (
            Tone::Problem,
            "Not running: the sandbox failed".into(),
            detail.or_else(|| some("The sandbox stopped, and didn't say why.")),
            Some(match facts.wait_seconds {
                Some(wait) => format!("It starts again by itself in {wait} seconds. Retry now, or look at its log."),
                None => "Retry, or look at its log.".into(),
            }),
            vec![RETRY, VIEW_LOG],
        ),
        Code::SandboxTaken => (
            Tone::Warning,
            "Not running: this computer has another sandbox".into(),
            some("This computer already has a g1t-runner sandbox that g1t didn't make, such as one started with `g1t-runner sandbox up`, and it has room for one."),
            some("Remove it with `g1t-runner sandbox down --delete`, then Retry; its runners stay listed on g1t until you remove them there. Or keep it, and turn off running jobs in g1t."),
            vec![RETRY, LEARN_MORE],
        ),
        Code::Updating => (Tone::Working, "Updating".into(), detail, some("The runner starts again as soon as it's done."), vec![]),
        Code::UpdateFailed => (
            Tone::Warning,
            "Update failed".into(),
            detail,
            some("The runner keeps running the version it has. Try again, or report it if it keeps happening."),
            vec![RETRY, REPORT],
        ),
        Code::Offline => (
            Tone::Warning,
            format!("Offline: {} unreachable", facts.server),
            some(format!("This computer can't reach {}, so the runner can't take jobs.", facts.server)),
            some("Check the connection. The runner carries on by itself when it's back."),
            vec![RETRY],
        ),
        Code::Crashed => (
            Tone::Problem,
            match facts.exit_code {
                Some(exit) => format!("Runner stopped (exit code {exit})"),
                None => "Runner stopped".into(),
            },
            detail,
            Some(match facts.wait_seconds {
                Some(wait) => format!("It starts again by itself in {wait} seconds. Restart now, or look at its log."),
                None => "Restart it, or look at its log.".into(),
            }),
            vec![RESTART, VIEW_LOG],
        ),
    };
    let capabilities = facts.sandbox.as_ref().map(|status| capabilities(status, facts)).unwrap_or_default();
    Diagnosis { code, tone, title, cause, fix, actions, capabilities }
}

/// What the app calls a sandbox's problem with Linux jobs, from the
/// launcher's sentence about it, which goes with it as its detail.
pub fn sandbox_code(why: Why) -> Code {
    match why {
        Why::NoWsl => Code::NoWsl,
        Why::WslMirrored => Code::WslMirrored,
        Why::NoVirtualization => Code::NoVirtualization,
        Why::NoVfkit => Code::NoVfkit,
        Why::NoSysboxOrKvm => Code::NoSysbox,
        Why::Image => Code::ImageFailed,
        _ => Code::SandboxFailed,
    }
}

/// The code for what is wrong with Linux jobs, as a status says it, and
/// the launcher's own words for it.
pub fn sandbox_trouble(status: &Status) -> Option<(Code, String, Option<String>)> {
    let (cause, fix) = status.trouble()?;
    let code = match launcher::why(&cause) {
        Why::Other if !status.linux().available => Code::SandboxUnavailable,
        why => sandbox_code(why),
    };
    Some((code, cause, fix))
}

/// Each kind of job the sandbox runs, on a line of its own.
fn capabilities(status: &Status, facts: &Facts) -> Vec<CapabilityLine> {
    let listed = if status.capabilities.is_empty() { vec![status.linux()] } else { status.capabilities.clone() };
    listed.iter().map(|capability| capability_line(status, capability, facts)).collect()
}

fn capability_line(status: &Status, capability: &launcher::Capability, facts: &Facts) -> CapabilityLine {
    let label = match capability.id.as_str() {
        "linux" => "Linux jobs".to_owned(),
        "windows" => "Windows jobs".to_owned(),
        "macos" => "macOS jobs".to_owned(),
        other => format!("{other} jobs"),
    };
    let line = |tone: Tone, title: String, cause: Option<String>, fix: Option<String>, actions: Vec<Action>| CapabilityLine {
        id: capability.id.clone(),
        label: label.clone(),
        tone,
        title,
        cause,
        fix,
        actions,
    };
    let title = if capability.available { "Not running" } else { "Not available" };
    if capability.id == "linux" {
        if let Some((code, cause, fix)) = sandbox_trouble(status) {
            // The same words as the whole runner's when Linux jobs are what is wrong.
            let said = diagnose(code, &Facts { detail: Some(cause), fix, wait_seconds: None, sandbox: None, ..facts.clone() });
            return line(Tone::Problem, title.into(), said.cause, said.fix, said.actions);
        }
    } else if !capability.available || capability.state == State::Error {
        let cause = capability.cause.clone();
        return match cause.as_deref().map(launcher::why) {
            Some(Why::WindowsSandboxOff) => line(
                Tone::Off,
                title.into(),
                some("Windows Sandbox is off, or this edition of Windows has none: Home doesn't."),
                some("Linux jobs still run. For Windows jobs, on Windows 11 Pro, Enterprise or Education, turn on Windows Sandbox in Windows features, then restart."),
                vec![WINDOWS_FEATURES],
            ),
            Some(Why::NoWsb) => line(
                Tone::Off,
                title.into(),
                some("This Windows has Windows Sandbox, but not its wsb command, which came with Windows 11 24H2."),
                some("Linux jobs still run. For Windows jobs, update Windows to 24H2 or later."),
                vec![],
            ),
            Some(Why::MacNotReleased) => line(Tone::Off, title.into(), some("Sandboxed macOS jobs aren't released yet."), some("Linux jobs still run."), vec![]),
            _ => line(if capability.available { Tone::Problem } else { Tone::Off }, title.into(), cause, capability.fix.clone(), vec![]),
        };
    }
    match capability.state {
        State::Running => match &capability.job {
            Some(job) => line(Tone::Working, format!("Running {}", job.said()), None, None, vec![]),
            None => line(Tone::Ok, "Waiting for jobs".into(), None, None, vec![]),
        },
        State::Starting => line(Tone::Working, "Starting".into(), None, None, vec![]),
        State::Updating => line(Tone::Working, "Updating".into(), None, None, vec![]),
        State::Stopped => line(Tone::Off, "Stopped".into(), None, None, vec![]),
        State::Absent => line(Tone::Off, "Not set up yet".into(), None, None, vec![]),
        State::Error | State::Unknown => line(Tone::Off, "Not running".into(), capability.cause.clone(), capability.fix.clone(), vec![]),
    }
}

/// What the site says of this computer while g1t is closed on it.
pub fn closed(facts: &Facts) -> Diagnosis {
    Diagnosis {
        code: Code::Off,
        tone: Tone::Off,
        title: format!("g1t is closed on {}", facts.machine),
        cause: some(format!("This runner runs while g1t is open on {}.", facts.machine)),
        fix: some(format!("Open g1t on {} to run jobs there again.", facts.machine)),
        actions: vec![],
        capabilities: vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> Facts {
        Facts { workspace: Some("acme".into()), backend: "sandboxed", machine: "build-box".into(), server: "g1t.sh".into(), platform: "windows".into(), ..Facts::default() }
    }

    #[test]
    fn every_failure_says_why_and_how_to_fix_it() {
        for code in [Code::SignedOut, Code::NoWorkspace, Code::NotAllowed, Code::RegisterFailed, Code::NoDocker,
            Code::NoLauncher, Code::NoWsl, Code::WslMirrored, Code::NoVirtualization, Code::NoVfkit, Code::NoSysbox, Code::ImageFailed, Code::SandboxUnavailable, Code::SandboxFailed,
            Code::SandboxTaken, Code::UpdateFailed, Code::Offline, Code::Crashed,
        ] {
            let diagnosis = diagnose(code, &Facts { detail: Some("why".into()), ..facts() });
            assert!(diagnosis.cause.is_some(), "{code:?} has no cause");
            assert!(diagnosis.fix.is_some(), "{code:?} has no fix");
            assert!(!diagnosis.actions.is_empty(), "{code:?} has no action");
            assert!(matches!(diagnosis.tone, Tone::Warning | Tone::Problem), "{code:?}");
        }
    }

    #[test]
    fn the_words_name_the_workspace_the_machine_and_the_job() {
        let not_allowed = diagnose(Code::NotAllowed, &facts());
        assert_eq!(not_allowed.cause.as_deref(), Some("You can't add runners to acme: only its owners can."));
        assert_eq!(not_allowed.actions[0].id, "choose_workspace");
        let busy = diagnose(Code::Busy, &Facts { job: Some("Build (acme/web)".into()), ..facts() });
        assert_eq!(busy.title, "Running Build (acme/web)");
        assert_eq!(busy.cause.as_deref(), Some("Running sandboxed for acme on build-box."));
        let crashed = diagnose(Code::Crashed, &Facts { exit_code: Some(101), wait_seconds: Some(30), ..facts() });
        assert_eq!(crashed.title, "Runner stopped (exit code 101)");
        assert_eq!(crashed.actions.iter().map(|a| a.id).collect::<Vec<_>>(), ["restart", "view_log"]);
        assert_eq!(diagnose(Code::NoDocker, &facts()).actions[0].id, "open_docker");
        assert_eq!(closed(&facts()).title, "g1t is closed on build-box");
    }

    fn status(json: &str) -> Status {
        launcher::parse(json).unwrap()
    }

    const NO_WSL_PRO: &str = r#"{"schema":1,"state":"error","backend":"wsl2","launcher_version":"0.2.1",
        "error":"WSL is not installed, and the sandbox for Linux jobs is a WSL distribution of its own.",
        "capabilities":[
          {"id":"linux","available":false,"state":"error","isolation":"nested-container",
           "cause":"WSL is not installed, and the sandbox for Linux jobs is a WSL distribution of its own.",
           "fix":"Open a terminal as administrator and run `wsl --install --no-distribution`, then restart Windows. It works on every edition of Windows 11, Home included."},
          {"id":"windows","available":true,"state":"running","isolation":"vm","runner_version":"0.2.1","job":null}]}"#;

    #[test]
    fn without_wsl_the_fix_is_the_command_to_copy_and_windows_jobs_still_show() {
        let status = status(NO_WSL_PRO);
        let (code, cause, _) = sandbox_trouble(&status).unwrap();
        assert_eq!(code, Code::NoWsl);
        let diagnosis = diagnose(code, &Facts { detail: Some(cause), sandbox: Some(status), ..facts() });
        assert_eq!(diagnosis.title, "Not running: WSL isn't installed");
        assert_eq!(diagnosis.fix.as_deref(), Some("Run `wsl --install --no-distribution` in an admin terminal, then restart Windows. It works on every edition of Windows 11, Home included."));
        assert_eq!(diagnosis.actions[0], COPY_WSL_INSTALL);
        let [linux, windows] = &diagnosis.capabilities[..] else { panic!("{:?}", diagnosis.capabilities) };
        assert_eq!((linux.label.as_str(), linux.title.as_str(), linux.tone), ("Linux jobs", "Not available", Tone::Problem));
        assert_eq!(linux.fix, diagnosis.fix);
        assert_eq!(linux.actions[0].id, "copy_wsl_install");
        assert_eq!((windows.label.as_str(), windows.title.as_str(), windows.tone), ("Windows jobs", "Waiting for jobs", Tone::Ok));
    }

    #[test]
    fn on_home_windows_jobs_are_unavailable_and_linux_jobs_still_run() {
        let status = status(
            r#"{"schema":1,"state":"running","backend":"wsl2","runner_version":"0.3.0","launcher_version":"0.3.0",
            "job":{"kind":"workflow","id":"job_1","name":"build","repo":"acme/web"},
            "capabilities":[
              {"id":"linux","available":true,"state":"running","runner_version":"0.3.0","job":{"kind":"workflow","id":"job_1","name":"build","repo":"acme/web"}},
              {"id":"windows","available":false,"state":"absent","cause":"Windows Sandbox is not turned on, or this edition of Windows has none (Home does not).","fix":"On Windows 11 Pro…"}]}"#,
        );
        assert_eq!(sandbox_trouble(&status), None);
        let busy = diagnose(Code::Busy, &Facts { job: status.job().map(launcher::Job::said), sandbox: Some(status), ..facts() });
        assert_eq!(busy.title, "Running build (acme/web)");
        let [linux, windows] = &busy.capabilities[..] else { panic!() };
        assert_eq!((linux.title.as_str(), linux.tone), ("Running build (acme/web)", Tone::Working));
        assert_eq!((windows.title.as_str(), windows.tone), ("Not available", Tone::Off));
        assert_eq!(windows.cause.as_deref(), Some("Windows Sandbox is off, or this edition of Windows has none: Home doesn't."));
        assert!(windows.fix.as_deref().unwrap().starts_with("Linux jobs still run."));
        assert_eq!(windows.actions[0].id, "windows_features");
    }

    #[test]
    fn each_launcher_trouble_has_its_words() {
        let trouble = |linux_available: bool, text: &str| {
            let json = serde_json::json!({
                "schema": 1, "state": "error", "error": text,
                "capabilities": [{"id": "linux", "available": linux_available, "state": "error", "cause": if linux_available { None } else { Some(text) }, "fix": "the launcher's fix"}]
            });
            sandbox_trouble(&status(&json.to_string())).unwrap()
        };
        assert_eq!(trouble(true, "WSL could not import the sandbox: Please enable the Virtual Machine Platform Windows feature and ensure virtualization is enabled in the BIOS.").0, Code::NoVirtualization);
        assert_eq!(trouble(false, "vfkit, which runs the sandbox's VM with Apple's Virtualization framework, is not installed.").0, Code::NoVfkit);
        assert_eq!(trouble(false, "This machine has neither Sysbox nor KVM, so there is nothing to sandbox the runner with.").0, Code::NoSysbox);
        assert_eq!(trouble(false, "WSL is set to mirrored networking, in which Linux reaches this computer's own localhost.").0, Code::WslMirrored);
        assert_eq!(trouble(true, "the sandbox image wsl-x64.tar.gz's SHA-256 is not the release's; not using it").0, Code::ImageFailed);
        // Unknown words: shown as the launcher wrote them, its fix with them.
        let (code, cause, fix) = trouble(false, "This user may not use /dev/kvm.");
        assert_eq!(code, Code::SandboxUnavailable);
        let unavailable = diagnose(code, &Facts { detail: Some(cause), fix, ..facts() });
        assert_eq!(unavailable.cause.as_deref(), Some("This user may not use /dev/kvm."));
        assert_eq!(unavailable.fix.as_deref(), Some("the launcher's fix"));
        let (code, cause, _) = trouble(true, "the sandbox did not start within 600 seconds");
        assert_eq!(code, Code::SandboxFailed);
        let failed = diagnose(code, &Facts { detail: Some(cause), wait_seconds: Some(60), ..facts() });
        assert_eq!(failed.cause.as_deref(), Some("the sandbox did not start within 600 seconds"));
        assert_eq!(failed.fix.as_deref(), Some("It starts again by itself in 60 seconds. Retry now, or look at its log."));
        let image = diagnose(Code::ImageFailed, &Facts { detail: Some("could not fetch https://g1t.sh/x: dns error".into()), ..facts() });
        assert_eq!(image.cause.as_deref(), Some("could not fetch https://g1t.sh/x: dns error"));
        assert_eq!(diagnose(Code::NoVirtualization, &Facts { platform: "macos".into(), ..facts() }).actions[0].id, "retry");
        assert_eq!(diagnose(Code::NoVfkit, &facts()).actions[0].id, "copy_vfkit_install");
    }

    #[test]
    fn a_diagnosis_without_the_sandbox_lists_no_capabilities() {
        let json = serde_json::to_value(diagnose(Code::Idle, &Facts { backend: "in Docker", ..facts() })).unwrap();
        assert!(json.get("capabilities").is_none());
        let sandboxed = serde_json::to_value(diagnose(Code::Idle, &Facts { sandbox: Some(status(NO_WSL_PRO)), ..facts() })).unwrap();
        assert_eq!(sandboxed["capabilities"][1]["id"], "windows");
    }
}
