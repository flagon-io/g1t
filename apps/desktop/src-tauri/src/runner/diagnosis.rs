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

use serde::Serialize;

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
    NoSandbox,
    NoSysbox,
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
        Code::NoSandbox => (
            Tone::Warning,
            "Not running: a sandbox isn't available on this computer yet".into(),
            some("The sandbox keeps everything a job does away from this computer. It isn't built for this system yet."),
            some("Wait for it, or choose to run jobs in Docker or directly on this computer. Neither is a sandbox: settings say what each can reach."),
            vec![LEARN_MORE, CHOOSE_BACKEND],
        ),
        Code::NoSysbox => (
            Tone::Problem,
            "Not running: Sysbox isn't installed".into(),
            some("The sandbox on Linux is the runner's image under Sysbox, and this computer's Docker doesn't have Sysbox."),
            some("Install Sysbox; the runner starts by itself once Docker has it."),
            vec![INSTALL_SYSBOX, CHOOSE_BACKEND],
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
    Diagnosis { code, tone, title, cause, fix, actions }
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
        for code in [Code::SignedOut, Code::NoWorkspace, Code::NotAllowed, Code::RegisterFailed, Code::NoDocker, Code::NoSandbox, Code::NoSysbox, Code::UpdateFailed, Code::Offline, Code::Crashed] {
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
}
