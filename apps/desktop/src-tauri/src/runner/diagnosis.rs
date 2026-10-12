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
//! off, Windows Sandbox off, a release without the sandbox's images, …)
//! are said in its words, with a fix and its buttons; any other is shown as
//! the launcher wrote it. With the sandbox, each kind of job it runs (Linux
//! jobs, Windows jobs) is a card of its own (`capabilities`), with its own
//! state, cause, fix and Start or Stop, since one can run while the other
//! cannot, or is stopped. The whole runner's diagnosis then only says what
//! the cards don't (`in_capabilities` is false): signed out, no workspace,
//! not allowed, no launcher, the whole sandbox down.

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
    /// Sandboxed, the person stopped every kind of job there is here.
    KindsStopped,
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
    /// The newest release is published without the sandbox's images yet.
    WaitingForImage,
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
    /// The newest release's manifest isn't signed with g1t's release key.
    UpdateRefused,
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
    /// Its button stays busy, after a click, until the runner's status
    /// that follows changes (or an error, or a while with no change): the
    /// runner starting, stopping, retrying or looking for updates. One
    /// that opens a page, a window or copies is done once the app has it.
    pub waits: bool,
    /// What the person is asked before it goes ahead, for a fix that can't be undone.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirm: Option<&'static str>,
}

impl Action {
    /// A fix that is done the moment the app has it.
    const fn now(id: &'static str, label: &'static str) -> Self {
        Self { id, label, waits: false, confirm: None }
    }

    /// A fix whose effect the runner's status shows when it comes.
    const fn waits(id: &'static str, label: &'static str) -> Self {
        Self { id, label, waits: true, confirm: None }
    }

    const fn confirming(self, question: &'static str) -> Self {
        Self { confirm: Some(question), ..self }
    }
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
    /// With the sandbox: each kind of job it runs, as a card of its own.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<CapabilityLine>,
    /// The cards say all of this, each for its kind of job: a page that
    /// shows them shows no line of the whole runner's as well.
    #[serde(skip_serializing_if = "is_false")]
    pub in_capabilities: bool,
    /// How the runner's updates stand: when g1t last looked, and a newer
    /// one waiting. None for what is said once g1t is closed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update: Option<UpdateLine>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// The runner's updates, as settings and the site's Desktops show them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct UpdateLine {
    /// When g1t last heard from the runner's releases, RFC 3339: the site,
    /// which shows a report for minutes, says how long ago itself.
    pub checked_at: Option<String>,
    /// `Checked 12 min ago`, `Checking for updates…`.
    pub checked: String,
    pub checking: bool,
    /// A newer version, downloaded and checked, waiting to be installed.
    pub ready: Option<String>,
    /// What becomes of it, for a runner with no kinds of job of its own
    /// (Docker, or on this computer): `0.3.2 ready, installs after this
    /// job`. A sandbox's cards each say it for their own kind.
    pub note: Option<String>,
    /// Looks now: "Check for runner updates".
    pub check: Action,
}

/// How one kind of job is, as its card's label says it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum KindState {
    /// Running a job.
    Busy,
    /// Waiting for jobs.
    Idle,
    Starting,
    /// Downloading the sandbox's image, which `progress` says how far.
    Downloading,
    Updating,
    /// Waiting for something g1t sees to by itself, such as the release's images.
    Waiting,
    /// Stopped: by the person (`enabled` is false), or with the whole runner.
    Stopped,
    /// This computer can't run it, and `cause` says why.
    Unavailable,
    /// It should run and doesn't: `cause` and `fix`.
    Problem,
}

/// One kind of job the sandbox runs, `linux` or `windows` (or `macos`),
/// and how it is: Linux jobs can run while Windows jobs cannot.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CapabilityLine {
    pub id: String,
    /// `Linux jobs`.
    pub label: String,
    pub tone: Tone,
    pub state: KindState,
    /// Its state in a few words, for its label: `Waiting for jobs`, `Not available`.
    pub title: String,
    /// What it is, in a line: `A Linux VM of its own, each job in a fresh container`.
    pub about: String,
    /// What is wrong, in a few words, over its cause: `WSL isn't installed`.
    pub headline: Option<String>,
    pub cause: Option<String>,
    pub fix: Option<String>,
    pub actions: Vec<Action>,
    /// On in settings: the person hasn't stopped it.
    pub enabled: bool,
    /// This computer can run it.
    pub available: bool,
    /// It can be started and stopped on its own here (the launcher can).
    pub can_toggle: bool,
    /// What it is running now.
    pub job: Option<JobLine>,
    /// How far its image has downloaded, in percent.
    pub progress: Option<u8>,
    /// How it keeps jobs from the computer: `nested-container`, `vm`.
    pub isolation: Option<String>,
    /// Its runner's name on g1t: `build-box-linux`.
    pub runner: Option<String>,
    /// Its runner's version.
    pub version: Option<String>,
    /// A newer version waiting for it: `0.3.2 ready, installs after this job`.
    pub update: Option<String>,
}

/// The job a kind of job is running, with where to see it on g1t.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct JobLine {
    /// `workflow` or `agent`.
    pub kind: String,
    pub name: String,
    pub repo: String,
    /// The repository's Actions (or Agents) page, where its run is.
    pub link: Option<String>,
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
    /// The server's address, for links: `https://g1t.sh`.
    pub site: String,
    pub platform: String,
    /// What the sandbox says to do, for a cause in its own words.
    pub fix: Option<String>,
    /// How the sandbox is, when jobs run sandboxed.
    pub sandbox: Option<Status>,
    /// The kinds of job the person stopped in settings.
    pub off: Vec<String>,
    /// The sandbox is up, or on its way: a kind of job that should run
    /// and doesn't is failing, rather than stopped with everything else.
    pub live: bool,
    /// The kinds of job a launcher command is starting now.
    pub starting: Vec<String>,
    /// How far the sandbox's image has downloaded, while it does.
    pub download: Option<launcher::Download>,
    /// The person stopped the whole runner, or turned it off.
    pub held: bool,
    pub update: Update,
}

/// How the runner's updates stand.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Update {
    /// The g1t-runner here.
    pub installed: Option<String>,
    /// When g1t last heard from the releases, RFC 3339, and how long ago.
    pub checked_at: Option<String>,
    pub checked_ago: Option<u64>,
    pub checking: bool,
    /// A newer release, downloaded and checked, waiting to be put in place.
    pub ready: Option<String>,
    /// What is still to take it: `linux` (the sandbox's image), `windows`
    /// (the program its runner is), or `runner` for a runner with no kinds
    /// of job of its own.
    pub waiting: Vec<String>,
    /// Those taking it now.
    pub installing: Vec<String>,
}

/// When g1t last looked for a newer runner: `Checked 12 min ago`.
pub fn checked(update: &Update) -> String {
    if update.checking {
        return "Checking for updates…".into();
    }
    let Some(ago) = update.checked_ago else { return "Not checked yet".into() };
    let plural = |n: u64, one: &str| if n == 1 { format!("Checked 1 {one} ago") } else { format!("Checked {n} {one}s ago") };
    match ago {
        0..=59 => "Checked just now".into(),
        60..=3599 => format!("Checked {} min ago", ago / 60),
        3600..=86_399 => plural(ago / 3600, "hour"),
        _ => plural(ago / 86_400, "day"),
    }
}

/// What becomes of a newer version waiting for `what` (a kind of job, or
/// `runner`), whose job is running when `busy`. None when nothing waits.
fn waiting(update: &Update, what: &str, busy: bool) -> Option<String> {
    let version = update.ready.as_deref()?;
    if update.installing.iter().any(|kind| kind == what) {
        return some(format!("Installing {version}"));
    }
    if !update.waiting.iter().any(|kind| kind == what) {
        return None;
    }
    some(if busy { format!("{version} ready, installs after this job") } else { format!("{version} ready, installs in a moment") })
}

fn update_line(facts: &Facts, code: Code) -> UpdateLine {
    let update = &facts.update;
    UpdateLine {
        checked_at: update.checked_at.clone(),
        checked: checked(update),
        checking: update.checking,
        ready: update.ready.clone(),
        note: waiting(update, "runner", code == Code::Busy),
        check: CHECK_UPDATES,
    }
}

const START: Action = Action::waits("start", "Start");
const TURN_ON: Action = Action::waits("start", "Turn on");
const RETRY: Action = Action::waits("retry", "Retry");
const CHECK_NOW: Action = Action::waits("retry", "Check now");
/// Looks for a newer runner now, and installs it as soon as its kinds of job are idle.
const CHECK_UPDATES: Action = Action::waits("check_updates", "Check for runner updates");
const CHECK_AGAIN: Action = Action::waits("check_updates", "Check again");
/// Removes the sandbox this computer has (`sandbox down --delete`, in the
/// app's own folder for it) and starts the app's own: what the command a
/// person would type does, without needing to know where that folder is.
const REMOVE_SANDBOX: Action = Action::waits("remove_sandbox", "Remove it and start again").confirming(
    "Remove this computer's sandbox? Its VM and registration go, and g1t makes its own in their place, registered with your workspace. Its old runners stay listed on g1t until you remove them there.",
);
const RESTART: Action = Action::waits("restart", "Restart");
const SIGN_IN: Action = Action::now("sign_in", "Sign in");
const CHOOSE_WORKSPACE: Action = Action::now("choose_workspace", "Choose workspace");
const NEW_WORKSPACE: Action = Action::now("new_workspace", "Create a workspace");
const CHOOSE_BACKEND: Action = Action::now("choose_backend", "Choose how jobs run");
/// Docker takes a while to start; the runner's status says when it has.
const OPEN_DOCKER: Action = Action::waits("open_docker", "Open Docker");
const GET_DOCKER: Action = Action::now("get_docker", "Get Docker");
const INSTALL_SYSBOX: Action = Action::now("install_sysbox", "Install Sysbox");
const COPY_WSL_INSTALL: Action = Action::now("copy_wsl_install", "Copy command");
const COPY_VFKIT_INSTALL: Action = Action::now("copy_vfkit_install", "Copy command");
const WINDOWS_FEATURES: Action = Action::now("windows_features", "Open Windows features");
const LEARN_MORE: Action = Action::now("learn_more", "Learn more");
const VIEW_LOG: Action = Action::now("view_log", "View log");
const REPORT: Action = Action::now("report", "Report");
const VIEW_RUNNERS: Action = Action::now("view_runners", "View on g1t");

fn some(text: impl Into<String>) -> Option<String> {
    Some(text.into())
}

/// A wait, said: `30 seconds`, `5 minutes`.
fn said_wait(seconds: u64) -> String {
    match seconds {
        0..=1 => "a moment".into(),
        2..=89 => format!("{seconds} seconds"),
        _ => format!("{} minutes", seconds.div_ceil(60)),
    }
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
        Code::KindsStopped => (
            Tone::Off,
            "Not running: every kind of job is stopped".into(),
            some("You stopped each kind of job this computer can run."),
            some("Start one to run jobs here again."),
            vec![],
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
            some("g1t asks again by itself in a few minutes; Retry asks now. Its log says more."),
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
            some("g1t looks for a newer one by itself every few minutes; Retry looks now. Or choose to run jobs in Docker or directly on this computer: neither is a sandbox, and settings say what each can reach."),
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
        Code::WaitingForImage => {
            let (release, image) = detail.as_deref().and_then(launcher::missing_images).map_or((None, None), |(release, image)| (Some(release), image));
            let release = release.map_or_else(|| "The newest g1t-runner".to_owned(), |release| format!("g1t-runner {release}"));
            (
                Tone::Warning,
                "Waiting for the sandbox's image".into(),
                some(match image {
                    Some(image) => format!("{release} is published without the sandbox's image for this kind of computer ({image}) yet, so Linux jobs can't start."),
                    None => format!("{release} is published without the sandbox's images yet, so Linux jobs can't start."),
                }),
                some("g1t checks again every few minutes and starts Linux jobs once they're out. There's nothing for you to do."),
                vec![CHECK_NOW],
            )
        }
        Code::ImageFailed => {
            let said = detail.clone().unwrap_or_default().to_ascii_lowercase();
            if said.contains("sha-256") || said.contains("signature") {
                (
                    Tone::Problem,
                    "Not running: the sandbox's image didn't check out".into(),
                    some("The sandbox's image that downloaded isn't the one g1t's release signed, so it wasn't used."),
                    some(format!(
                        "g1t downloads it again by itself{}. If this keeps happening, something between this computer and {} is changing downloads, such as a proxy or antivirus: report it.",
                        facts.wait_seconds.map(|wait| format!(" in {}", said_wait(wait))).unwrap_or_default(),
                        facts.server
                    )),
                    vec![RETRY, REPORT],
                )
            } else {
                (
                    Tone::Problem,
                    "Not running: the sandbox's image didn't download".into(),
                    some(match &detail {
                        Some(detail) => format!("The sandbox's image couldn't be downloaded: {detail}"),
                        None => "The sandbox's image couldn't be downloaded.".into(),
                    }),
                    some(format!(
                        "g1t tries again by itself{}. Check that this computer can reach {}; Retry tries now.",
                        facts.wait_seconds.map(|wait| format!(" in {}", said_wait(wait))).unwrap_or_default(),
                        facts.server
                    )),
                    vec![RETRY, VIEW_LOG],
                )
            }
        }
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
            some(match facts.wait_seconds {
                Some(wait) => format!("It starts again by itself in {}. If it keeps stopping, its log says why; Retry starts it now.", said_wait(wait)),
                None => "Retry starts it again; its log says why it stopped.".into(),
            }),
            vec![RETRY, VIEW_LOG],
        ),
        Code::SandboxTaken => (
            Tone::Warning,
            "Not running: this computer has another sandbox".into(),
            some("This computer already has a g1t-runner sandbox that this copy of g1t has no record of making, such as one from before g1t was installed again, or one started with `g1t-runner sandbox up`. A computer has room for one."),
            some("Remove it and start again: g1t removes it, with the jobs' VM and its registration, and makes its own, registered with your workspace. Its old runners stay listed on g1t, offline, until you remove them there. Or keep it, and turn off running jobs in g1t."),
            vec![REMOVE_SANDBOX, LEARN_MORE],
        ),
        Code::Updating => (Tone::Working, "Updating".into(), detail, some("The runner starts again as soon as it's done."), vec![]),
        Code::UpdateFailed => (
            Tone::Warning,
            "Update failed".into(),
            detail,
            some("The runner keeps running the version it has, and g1t tries the update again within the hour. Check again tries now; if it keeps failing, report it."),
            vec![CHECK_AGAIN, REPORT],
        ),
        Code::UpdateRefused => {
            let why = detail.unwrap_or_else(|| "its signature didn't check out".into());
            let tampered = format!(
                "If this keeps happening, something between this computer and {} is changing downloads, such as a proxy or antivirus: report it.",
                facts.server
            );
            match facts.update.installed.as_deref() {
                Some(version) => (
                    Tone::Warning,
                    "Update refused: not signed by g1t".into(),
                    some(format!("The newest g1t-runner release from {} isn't signed with g1t's release key ({why}), so g1t didn't install it.", facts.server)),
                    some(format!("The runner keeps running g1t-runner {version}, and g1t checks again within the hour. {tampered}")),
                    vec![CHECK_AGAIN, REPORT],
                ),
                None => (
                    Tone::Problem,
                    "Not running: the runner's release isn't signed by g1t".into(),
                    some(format!("The g1t-runner release from {} isn't signed with g1t's release key ({why}), so g1t didn't install it, and has no runner to start.", facts.server)),
                    some(format!("g1t tries again by itself in a few minutes; Retry tries now. {tampered}")),
                    vec![RETRY, REPORT],
                ),
            }
        }
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
                Some(wait) => format!("It starts again by itself in {}. If it keeps stopping, its log says why; Restart starts it now.", said_wait(wait)),
                None => "Restart starts it again; its log says why it stopped.".into(),
            }),
            vec![RESTART, VIEW_LOG],
        ),
    };
    let capabilities = facts.sandbox.as_ref().map(|status| capabilities(status, facts)).unwrap_or_default();
    let in_capabilities = !capabilities.is_empty()
        && match code {
            Code::Idle | Code::Busy | Code::KindsStopped => true,
            Code::Starting | Code::Updating => facts.live,
            // Said by a card, for its kind of job, word for word.
            Code::NoWsl
            | Code::WslMirrored
            | Code::NoVirtualization
            | Code::NoVfkit
            | Code::NoSysbox
            | Code::WaitingForImage
            | Code::ImageFailed
            | Code::SandboxUnavailable
            | Code::SandboxFailed => cause.is_some() && capabilities.iter().any(|c| c.cause == cause),
            _ => false,
        };
    let update = Some(update_line(facts, code));
    Diagnosis { code, tone, title, cause, fix, actions, capabilities, in_capabilities, update }
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
        Why::NoImages => Code::WaitingForImage,
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

/// Each kind of job the sandbox runs, as a card of its own.
fn capabilities(status: &Status, facts: &Facts) -> Vec<CapabilityLine> {
    let listed = if status.capabilities.is_empty() { vec![status.linux()] } else { status.capabilities.clone() };
    listed.iter().map(|capability| capability_line(status, capability, facts)).collect()
}

/// `Linux jobs`.
pub fn kind_label(id: &str) -> String {
    match id {
        "linux" => "Linux jobs".to_owned(),
        "windows" => "Windows jobs".to_owned(),
        "macos" => "macOS jobs".to_owned(),
        other => format!("{other} jobs"),
    }
}

/// What a kind of job is, in a line, by how the sandbox makes it.
fn about(id: &str, backend: Option<&str>) -> String {
    match (id, backend) {
        ("linux", Some("sysbox")) => "The runner under Sysbox, each job in a fresh container".into(),
        ("linux", _) => "A Linux VM of its own, each job in a fresh container".into(),
        ("windows", _) => "Each job in a Windows Sandbox, discarded after".into(),
        ("macos", _) => "Each job in a macOS VM of its own, discarded after".into(),
        _ => "Each job sandboxed".into(),
    }
}

/// A catalogue title as a card's headline: `Not running: virtualization is off` is `Virtualization is off`.
fn headline(title: &str) -> String {
    let said = title.strip_prefix("Not running: ").unwrap_or(title);
    let mut letters = said.chars();
    letters.next().map(|first| first.to_uppercase().chain(letters).collect()).unwrap_or_default()
}

fn capability_line(status: &Status, capability: &launcher::Capability, facts: &Facts) -> CapabilityLine {
    let id = capability.id.as_str();
    let label = kind_label(id);
    let enabled = !facts.off.iter().any(|off| off == id);
    let per_kind = status.per_kind();
    let mut line = CapabilityLine {
        id: id.to_owned(),
        label: label.clone(),
        tone: Tone::Off,
        state: KindState::Stopped,
        title: "Stopped".into(),
        about: about(id, status.backend.as_deref()),
        headline: None,
        cause: None,
        fix: None,
        actions: vec![],
        enabled,
        available: capability.available,
        // Nothing to start or stop where it can't run, nor while the whole runner is
        // stopped, whose own Start starts it (one the person stopped can be started).
        can_toggle: per_kind && (capability.available || !enabled) && !(facts.held && enabled),
        job: None,
        progress: None,
        isolation: capability.isolation.clone().filter(|_| capability.available),
        runner: capability.available.then(|| format!("{}-{id}", facts.machine)),
        version: capability.runner_version.clone(),
        update: waiting(&facts.update, id, capability.job.is_some()),
    };
    let said = |line: &mut CapabilityLine, state: KindState, tone: Tone, cause: Option<String>, fix: Option<String>, actions: Vec<Action>| {
        line.state = state;
        line.tone = tone;
        line.title = match state {
            KindState::Busy => "Running a job",
            KindState::Idle => "Waiting for jobs",
            KindState::Starting => "Starting",
            KindState::Downloading => "Downloading image",
            KindState::Updating => "Updating",
            KindState::Waiting => "Waiting for image",
            KindState::Stopped => "Stopped",
            KindState::Unavailable => "Not available",
            KindState::Problem => "Problem",
        }
        .into();
        line.cause = cause;
        line.fix = fix;
        line.actions = actions;
    };
    let again = |what: &str| format!("g1t {what} again by itself in a few minutes; Retry {what} now.");
    let starting = facts.starting.iter().any(|kind| kind == id) || matches!(capability.state, State::Starting);

    // Stopped by the person: nothing is wrong with it.
    if capability.off() || (!enabled && per_kind) {
        said(&mut line, KindState::Stopped, Tone::Off, some(format!("You stopped {label} on this computer. They stay stopped until you start them.")), None, vec![]);
        return line;
    }
    // This computer can't run it, and why.
    if !capability.available {
        if id == "linux"
            && let Some((code, cause, fix)) = sandbox_trouble(status)
        {
            let whole = diagnose(code, &Facts { detail: Some(cause), fix, sandbox: None, ..facts.clone() });
            said(&mut line, KindState::Unavailable, Tone::Warning, whole.cause, whole.fix, whole.actions);
            line.headline = Some(headline(&whole.title));
            return line;
        }
        let cause = capability.cause.clone();
        let (headline, cause, fix, actions) = match cause.as_deref().map(launcher::why) {
            Some(Why::WindowsSandboxOff) => (
                "Windows Sandbox is off",
                some("Windows Sandbox is turned off, or this edition of Windows has none: Home doesn't."),
                some("On Windows 11 Pro, Enterprise or Education, turn on Windows Sandbox in Windows features, then restart."),
                vec![WINDOWS_FEATURES],
            ),
            Some(Why::NoWsb) => (
                "Windows needs an update",
                some("This Windows has Windows Sandbox, but not its wsb command, which came with Windows 11 24H2."),
                some("Update Windows to 24H2 or later, then restart g1t."),
                vec![],
            ),
            Some(Why::MacNotReleased) => (
                "Not released yet",
                some("Sandboxed macOS jobs aren't released yet."),
                some("They come with a g1t-runner update, which g1t downloads by itself. There's nothing for you to do."),
                vec![],
            ),
            _ => ("Can't run here", cause, capability.fix.clone(), vec![LEARN_MORE]),
        };
        said(&mut line, KindState::Unavailable, Tone::Off, cause, fix, actions);
        line.headline = Some(headline.into());
        return line;
    }
    // Linux jobs that should run and don't, in the catalogue's words.
    if id == "linux"
        && !starting
        && !matches!(capability.state, State::Updating)
        && let Some((code, cause, fix)) = sandbox_trouble(status)
    {
        let wait_seconds = if facts.live { None } else { facts.wait_seconds };
        let whole = diagnose(code, &Facts { detail: Some(cause), fix, wait_seconds, sandbox: None, ..facts.clone() });
        let state = if code == Code::WaitingForImage { KindState::Waiting } else { KindState::Problem };
        said(&mut line, state, whole.tone, whole.cause, whole.fix, whole.actions);
        line.headline = Some(headline(&whole.title));
        return line;
    }
    // A native kind of job whose runner didn't start, in the launcher's words.
    if id != "linux" && capability.state == State::Error && !starting {
        let cause = capability.cause.clone().or_else(|| some("Its runner didn't start, and didn't say why."));
        said(&mut line, KindState::Problem, Tone::Problem, cause, some(again("tries")), vec![RETRY, VIEW_LOG]);
        line.headline = Some("Its runner didn't start".into());
        return line;
    }
    let downloading = facts.download.as_ref().filter(|_| id == "linux");
    match capability.state {
        _ if starting || capability.state == State::Updating => match downloading {
            Some(download) => {
                said(&mut line, KindState::Downloading, Tone::Working, some("Downloading and checking the sandbox's image, once: it takes a few minutes."), None, vec![]);
                line.progress = Some(download.percent);
            }
            None if capability.state == State::Updating => said(&mut line, KindState::Updating, Tone::Working, some("Taking the newest sandbox image; it takes jobs again when it's done."), None, vec![]),
            None if capability.state == State::Absent => said(&mut line, KindState::Starting, Tone::Working, some(format!("Registering it with {}.", facts.workspace.as_deref().unwrap_or("your workspace"))), None, vec![]),
            None => said(&mut line, KindState::Starting, Tone::Working, None, None, vec![]),
        },
        State::Running => match &capability.job {
            Some(job) => {
                said(&mut line, KindState::Busy, Tone::Working, None, None, vec![]);
                // Every job a runner takes is on the repository's Actions page:
                // workflow jobs, and the queue, merge check and checks tasks
                // the runner's wire still calls `agent` work.
                let link = (!job.repo.is_empty() && !facts.site.is_empty()).then(|| format!("{}/{}/actions", facts.site.trim_end_matches('/'), job.repo));
                line.job = Some(JobLine { kind: job.kind.clone(), name: job.name.clone(), repo: job.repo.clone(), link });
            }
            None => said(&mut line, KindState::Idle, Tone::Ok, None, None, vec![]),
        },
        // Up while the others run, yet not running: it stopped by itself,
        // or is to be registered.
        State::Stopped | State::Absent if facts.live && status.running() => {
            if capability.state == State::Absent {
                said(&mut line, KindState::Starting, Tone::Working, some(format!("Registering it with {}.", facts.workspace.as_deref().unwrap_or("your workspace"))), None, vec![]);
            } else {
                said(&mut line, KindState::Problem, Tone::Problem, some("Its runner stopped by itself."), some(again("starts it")), vec![RETRY, VIEW_LOG]);
                line.headline = Some("Its runner stopped".into());
            }
        }
        State::Stopped | State::Absent => said(&mut line, KindState::Stopped, Tone::Off, None, None, vec![]),
        State::Error | State::Unknown | State::Starting | State::Updating => {
            said(&mut line, KindState::Problem, Tone::Problem, capability.cause.clone().or_else(|| status.error.clone()), capability.fix.clone(), vec![RETRY, VIEW_LOG]);
        }
    }
    // The person stopped it, and this launcher can't stop one kind alone yet.
    if !enabled && line.fix.is_none() {
        line.fix = some(format!("This g1t-runner can't stop {label} on their own; the next one can, and g1t downloads it by itself."));
    }
    line
}

/// The runner in a few words, for the chip beside the title bar's settings
/// button, which opens the Runner window: `Runner running`, `Running 2 jobs`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Chip {
    pub tone: Tone,
    pub label: String,
}

/// The chip, from the whole runner's diagnosis and its kinds of job: what
/// it is doing, and whether anything there wants the person.
pub fn chip(diagnosis: &Diagnosis) -> Chip {
    let jobs = diagnosis.capabilities.iter().filter(|kind| kind.job.is_some()).count().max(usize::from(diagnosis.code == Code::Busy));
    let wanting = diagnosis.capabilities.iter().any(|kind| kind.enabled && matches!(kind.tone, Tone::Problem | Tone::Warning));
    let (tone, label) = match diagnosis.code {
        _ if jobs > 1 => (Tone::Working, format!("Running {jobs} jobs")),
        _ if jobs == 1 => (Tone::Working, "Running a job".to_owned()),
        Code::Idle => (if wanting { Tone::Warning } else { Tone::Ok }, "Runner running".to_owned()),
        Code::Starting | Code::Registering => (Tone::Working, "Runner starting".to_owned()),
        Code::Updating => (Tone::Working, "Runner updating".to_owned()),
        Code::UpdateFailed | Code::UpdateRefused => (Tone::Warning, "Runner running".to_owned()),
        Code::Off => (Tone::Off, "Runner off".to_owned()),
        Code::Stopped | Code::KindsStopped => (Tone::Off, "Runner stopped".to_owned()),
        Code::Offline => (Tone::Warning, "Runner offline".to_owned()),
        _ => (diagnosis.tone, "Runner needs you".to_owned()),
    };
    Chip { tone, label }
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
        in_capabilities: false,
        update: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> Facts {
        Facts {
            workspace: Some("acme".into()),
            backend: "sandboxed",
            machine: "build-box".into(),
            server: "g1t.sh".into(),
            site: "https://g1t.sh".into(),
            platform: "windows".into(),
            ..Facts::default()
        }
    }

    #[test]
    fn a_fix_that_changes_the_runner_waits_for_its_status() {
        for action in [START, TURN_ON, RETRY, CHECK_NOW, CHECK_UPDATES, CHECK_AGAIN, REMOVE_SANDBOX, RESTART, OPEN_DOCKER] {
            assert!(action.waits, "{} waits for the status that follows", action.id);
        }
        for action in [SIGN_IN, CHOOSE_WORKSPACE, CHOOSE_BACKEND, GET_DOCKER, COPY_WSL_INSTALL, LEARN_MORE, VIEW_LOG, VIEW_RUNNERS] {
            assert!(!action.waits, "{} is done once the app has it", action.id);
        }
        // Only what can't be undone asks first.
        assert!(REMOVE_SANDBOX.confirm.is_some_and(|question| question.ends_with('.') && question.contains('?')));
        assert!(RETRY.confirm.is_none());
        let said = serde_json::to_value(RETRY).unwrap();
        assert_eq!(said, serde_json::json!({ "id": "retry", "label": "Retry", "waits": true }));
    }

    #[test]
    fn every_failure_says_why_and_how_to_fix_it() {
        for code in [
            Code::SignedOut,
            Code::NoWorkspace,
            Code::NotAllowed,
            Code::RegisterFailed,
            Code::NoDocker,
            Code::NoLauncher,
            Code::NoWsl,
            Code::WslMirrored,
            Code::NoVirtualization,
            Code::NoVfkit,
            Code::NoSysbox,
            Code::WaitingForImage,
            Code::ImageFailed,
            Code::SandboxUnavailable,
            Code::SandboxFailed,
            Code::SandboxTaken,
            Code::UpdateFailed,
            Code::UpdateRefused,
            Code::Offline,
            Code::Crashed,
        ] {
            let diagnosis = diagnose(code, &Facts { detail: Some("why".into()), ..facts() });
            assert!(diagnosis.cause.is_some(), "{code:?} has no cause");
            assert!(diagnosis.fix.is_some(), "{code:?} has no fix");
            assert!(!diagnosis.actions.is_empty(), "{code:?} has no action");
            assert!(matches!(diagnosis.tone, Tone::Warning | Tone::Problem), "{code:?}");
            // No fix sends the person off to check their connection or report it
            // when that isn't what is wrong.
            let fix = diagnosis.fix.unwrap();
            if !matches!(code, Code::Offline | Code::ImageFailed) {
                assert!(!fix.contains("check the connection") && !fix.contains("Check the connection"), "{code:?}: {fix}");
            }
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
        assert_eq!(crashed.fix.as_deref(), Some("It starts again by itself in 30 seconds. If it keeps stopping, its log says why; Restart starts it now."));
        assert_eq!(crashed.actions.iter().map(|a| a.id).collect::<Vec<_>>(), ["restart", "view_log"]);
        assert_eq!(diagnose(Code::NoDocker, &facts()).actions[0].id, "open_docker");
        assert_eq!(closed(&facts()).title, "g1t is closed on build-box");
        assert_eq!(said_wait(300), "5 minutes");
        assert_eq!(said_wait(45), "45 seconds");
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
        let diagnosis = diagnose(code, &Facts { detail: Some(cause), sandbox: Some(status), live: true, ..facts() });
        assert_eq!(diagnosis.title, "Not running: WSL isn't installed");
        assert_eq!(diagnosis.fix.as_deref(), Some("Run `wsl --install --no-distribution` in an admin terminal, then restart Windows. It works on every edition of Windows 11, Home included."));
        assert_eq!(diagnosis.actions[0], COPY_WSL_INSTALL);
        let [linux, windows] = &diagnosis.capabilities[..] else { panic!("{:?}", diagnosis.capabilities) };
        assert_eq!((linux.label.as_str(), linux.title.as_str(), linux.state), ("Linux jobs", "Not available", KindState::Unavailable));
        assert_eq!(linux.headline.as_deref(), Some("WSL isn't installed"));
        assert_eq!(linux.fix, diagnosis.fix);
        assert_eq!(linux.actions[0].id, "copy_wsl_install");
        assert_eq!((windows.label.as_str(), windows.title.as_str(), windows.tone), ("Windows jobs", "Waiting for jobs", Tone::Ok));
        assert_eq!(windows.runner.as_deref(), Some("build-box-windows"));
        assert_eq!(windows.about, "Each job in a Windows Sandbox, discarded after");
        // The Linux card says it all: the whole runner's line isn't shown as well.
        assert!(diagnosis.in_capabilities);
        // An older launcher can't stop one kind of job alone.
        assert!(!windows.can_toggle);
    }

    #[test]
    fn on_home_windows_jobs_are_unavailable_and_linux_jobs_still_run() {
        let status = status(
            r#"{"schema":1,"state":"running","backend":"wsl2","runner_version":"0.3.0","launcher_version":"0.3.0",
            "job":{"kind":"workflow","id":"job_1","name":"build","repo":"acme/web"},
            "capabilities":[
              {"id":"linux","available":true,"state":"running","runner_version":"0.3.0","isolation":"nested-container","turned_off":false,"job":{"kind":"workflow","id":"job_1","name":"build","repo":"acme/web"}},
              {"id":"windows","available":false,"state":"absent","turned_off":false,"cause":"Windows Sandbox is not turned on, or this edition of Windows has none (Home does not).","fix":"On Windows 11 Pro…"}]}"#,
        );
        assert_eq!(sandbox_trouble(&status), None);
        let busy = diagnose(Code::Busy, &Facts { job: status.job().map(launcher::Job::said), sandbox: Some(status), live: true, ..facts() });
        assert_eq!(busy.title, "Running build (acme/web)");
        assert!(busy.in_capabilities);
        let [linux, windows] = &busy.capabilities[..] else { panic!() };
        assert_eq!((linux.title.as_str(), linux.state, linux.tone), ("Running a job", KindState::Busy, Tone::Working));
        let job = linux.job.as_ref().unwrap();
        assert_eq!((job.name.as_str(), job.repo.as_str(), job.link.as_deref()), ("build", "acme/web", Some("https://g1t.sh/acme/web/actions")));
        assert!(linux.can_toggle && linux.enabled);
        assert_eq!((windows.title.as_str(), windows.tone, windows.state), ("Not available", Tone::Off, KindState::Unavailable));
        assert_eq!(windows.headline.as_deref(), Some("Windows Sandbox is off"));
        assert_eq!(windows.cause.as_deref(), Some("Windows Sandbox is turned off, or this edition of Windows has none: Home doesn't."));
        assert_eq!(windows.actions[0].id, "windows_features");
        // Nothing to start or stop where it can't run.
        assert!(!windows.can_toggle);
        assert_eq!(windows.runner, None);
    }

    /// 0.3.0 was published without the sandbox's images: Linux jobs wait for
    /// them, plainly, while Windows jobs run.
    const NO_IMAGES: &str = r#"{"schema":1,"state":"error","backend":"wsl2","launcher_version":"0.3.0",
        "error":"Windows jobs are sandboxed and running, but Linux jobs are not: release 0.3.0 has no sandbox images",
        "capabilities":[
          {"id":"linux","available":true,"state":"error","isolation":"nested-container","turned_off":false},
          {"id":"windows","available":true,"state":"running","isolation":"vm","runner_version":"0.3.0","turned_off":false}]}"#;

    #[test]
    fn a_release_without_images_is_waited_for_not_reported() {
        let status = status(NO_IMAGES);
        let (code, cause, _) = sandbox_trouble(&status).unwrap();
        assert_eq!(code, Code::WaitingForImage);
        let whole = diagnose(code, &Facts { detail: Some(cause), ..facts() });
        assert_eq!(whole.title, "Waiting for the sandbox's image");
        assert_eq!(whole.cause.as_deref(), Some("g1t-runner 0.3.0 is published without the sandbox's images yet, so Linux jobs can't start."));
        assert_eq!(whole.fix.as_deref(), Some("g1t checks again every few minutes and starts Linux jobs once they're out. There's nothing for you to do."));
        assert_eq!(whole.actions, [CHECK_NOW]);
        assert!(!whole.fix.unwrap().contains("report"));
        // Windows jobs run: the runner waits for jobs, and the Linux card says what it waits for.
        let idle = diagnose(Code::Idle, &Facts { sandbox: Some(status), live: true, ..facts() });
        assert!(idle.in_capabilities);
        let [linux, windows] = &idle.capabilities[..] else { panic!() };
        assert_eq!((linux.state, linux.title.as_str(), linux.tone), (KindState::Waiting, "Waiting for image", Tone::Warning));
        assert_eq!(linux.headline.as_deref(), Some("Waiting for the sandbox's image"));
        assert_eq!(windows.state, KindState::Idle);
        let image = diagnose(Code::ImageFailed, &Facts { detail: Some("the sandbox image wsl-x64.tar.gz's SHA-256 is not the release's; not using it".into()), ..facts() });
        assert_eq!(image.title, "Not running: the sandbox's image didn't check out");
        let fetch = diagnose(Code::ImageFailed, &Facts { detail: Some("could not fetch https://g1t.sh/x: dns error".into()), wait_seconds: Some(60), ..facts() });
        assert_eq!(fetch.cause.as_deref(), Some("The sandbox's image couldn't be downloaded: could not fetch https://g1t.sh/x: dns error"));
        assert_eq!(fetch.fix.as_deref(), Some("g1t tries again by itself in 60 seconds. Check that this computer can reach g1t.sh; Retry tries now."));
    }

    #[test]
    fn a_kind_the_person_stopped_says_so_and_is_not_failing() {
        let status = status(
            r#"{"schema":1,"state":"running","backend":"wsl2","capabilities":[
              {"id":"linux","available":true,"state":"running","turned_off":false},
              {"id":"windows","available":true,"state":"stopped","turned_off":true}]}"#,
        );
        let idle = diagnose(Code::Idle, &Facts { sandbox: Some(status.clone()), live: true, off: vec!["windows".into()], ..facts() });
        let [linux, windows] = &idle.capabilities[..] else { panic!() };
        assert_eq!(linux.state, KindState::Idle);
        assert_eq!((windows.state, windows.tone, windows.enabled), (KindState::Stopped, Tone::Off, false));
        assert_eq!(windows.cause.as_deref(), Some("You stopped Windows jobs on this computer. They stay stopped until you start them."));
        assert!(windows.can_toggle && windows.actions.is_empty());
        // Stopped by itself while Linux jobs run is a problem, with Retry.
        let died = launcher::parse(&serde_json::to_string(&serde_json::json!({"schema":1,"state":"running","capabilities":[
            {"id":"linux","available":true,"state":"running","turned_off":false},
            {"id":"windows","available":true,"state":"stopped","turned_off":false}]})).unwrap()).unwrap();
        let idle = diagnose(Code::Idle, &Facts { sandbox: Some(died.clone()), live: true, ..facts() });
        assert_eq!((idle.capabilities[1].state, idle.capabilities[1].actions[0].id), (KindState::Problem, "retry"));
        // With the whole runner stopped, it is only stopped.
        let stopped = diagnose(Code::Stopped, &Facts { sandbox: Some(died), live: false, held: true, ..facts() });
        // Its own Start or Stop waits for the runner's: the line above the cards starts it.
        assert!(!stopped.capabilities[0].can_toggle);
        assert_eq!(stopped.capabilities[1].state, KindState::Stopped);
        assert!(!stopped.in_capabilities);
    }

    #[test]
    fn a_download_shows_how_far_it_is() {
        let status = status(r#"{"schema":1,"state":"starting","capabilities":[{"id":"linux","available":true,"state":"starting","turned_off":false},{"id":"windows","available":true,"state":"absent","turned_off":false}]}"#);
        let facts = Facts { sandbox: Some(status), live: true, starting: vec!["linux".into(), "windows".into()], download: Some(launcher::Download { key: "wsl-x64".into(), percent: 40 }), ..facts() };
        let starting = diagnose(Code::Starting, &facts);
        assert!(starting.in_capabilities);
        let [linux, windows] = &starting.capabilities[..] else { panic!() };
        assert_eq!((linux.state, linux.title.as_str(), linux.progress), (KindState::Downloading, "Downloading image", Some(40)));
        assert_eq!((windows.state, windows.progress), (KindState::Starting, None));
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
        assert_eq!(trouble(true, "release 0.3.0 has no sandbox images").0, Code::WaitingForImage);
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
        assert_eq!(failed.fix.as_deref(), Some("It starts again by itself in 60 seconds. If it keeps stopping, its log says why; Retry starts it now."));
        assert_eq!(diagnose(Code::NoVirtualization, &Facts { platform: "macos".into(), ..facts() }).actions[0].id, "retry");
        assert_eq!(diagnose(Code::NoVfkit, &facts()).actions[0].id, "copy_vfkit_install");
    }

    #[test]
    fn when_g1t_last_looked_for_a_runner_is_said_plainly() {
        let ago = |seconds: u64| checked(&Update { checked_ago: Some(seconds), ..Update::default() });
        assert_eq!(checked(&Update::default()), "Not checked yet");
        assert_eq!(checked(&Update { checking: true, checked_ago: Some(30), ..Update::default() }), "Checking for updates…");
        assert_eq!(ago(20), "Checked just now");
        assert_eq!(ago(12 * 60 + 5), "Checked 12 min ago");
        assert_eq!(ago(3600), "Checked 1 hour ago");
        assert_eq!(ago(5 * 3600), "Checked 5 hours ago");
        assert_eq!(ago(2 * 86_400), "Checked 2 days ago");
    }

    /// 0.3.2 is downloaded: Linux jobs take its image after the job they
    /// are running, Windows jobs, idle, take its program now.
    #[test]
    fn a_waiting_update_is_said_on_each_kind_of_jobs_card() {
        let status = status(
            r#"{"schema":1,"state":"running","backend":"wsl2","image_version":"0.3.1","capabilities":[
              {"id":"linux","available":true,"state":"running","runner_version":"0.3.1","turned_off":false,"job":{"kind":"workflow","id":"j","name":"build","repo":"acme/web"}},
              {"id":"windows","available":true,"state":"running","runner_version":"0.3.1","turned_off":false}]}"#,
        );
        let update = Update {
            installed: Some("0.3.1".into()),
            checked_at: Some("2026-10-12T12:00:00Z".into()),
            checked_ago: Some(12 * 60),
            ready: Some("0.3.2".into()),
            waiting: vec!["linux".into(), "windows".into()],
            ..Update::default()
        };
        let busy = diagnose(Code::Busy, &Facts { sandbox: Some(status.clone()), live: true, update: update.clone(), ..facts() });
        let [linux, windows] = &busy.capabilities[..] else { panic!() };
        assert_eq!(linux.version.as_deref(), Some("0.3.1"));
        assert_eq!(linux.update.as_deref(), Some("0.3.2 ready, installs after this job"));
        assert_eq!(windows.update.as_deref(), Some("0.3.2 ready, installs in a moment"));
        let line = busy.update.unwrap();
        assert_eq!((line.checked.as_str(), line.ready.as_deref(), line.checked_at.as_deref()), ("Checked 12 min ago", Some("0.3.2"), Some("2026-10-12T12:00:00Z")));
        // The cards say it, each for its own kind: nothing is said for the whole runner.
        assert_eq!(line.note, None);
        assert_eq!((line.check.id, line.check.label), ("check_updates", "Check for runner updates"));
        // Windows jobs stop while the program is replaced: installing, then nothing waits.
        let installing = Update { installing: vec!["windows".into()], ..update.clone() };
        let busy = diagnose(Code::Busy, &Facts { sandbox: Some(status.clone()), live: true, update: installing, ..facts() });
        assert_eq!(busy.capabilities[1].update.as_deref(), Some("Installing 0.3.2"));
        let done = Update { waiting: vec!["linux".into()], ..update.clone() };
        let busy = diagnose(Code::Busy, &Facts { sandbox: Some(status), live: true, update: done, ..facts() });
        assert_eq!(busy.capabilities[1].update, None);
        // In Docker or on this computer there are no cards: the whole runner says it.
        let docker = Update { waiting: vec!["runner".into()], ..update };
        let busy = diagnose(Code::Busy, &Facts { backend: "in Docker", job: Some("build (acme/web)".into()), update: docker.clone(), ..facts() });
        assert_eq!(busy.update.unwrap().note.as_deref(), Some("0.3.2 ready, installs after this job"));
        let idle = diagnose(Code::Idle, &Facts { backend: "in Docker", update: docker, ..facts() });
        assert_eq!(idle.update.unwrap().note.as_deref(), Some("0.3.2 ready, installs in a moment"));
        // What is said once g1t is closed knows nothing of updates.
        assert_eq!(closed(&facts()).update, None);
    }

    #[test]
    fn a_release_not_signed_by_g1t_is_refused_and_said_so() {
        let detail = Some("the release's signature isn't g1t's".to_owned());
        let running = diagnose(Code::UpdateRefused, &Facts { detail: detail.clone(), update: Update { installed: Some("0.3.1".into()), ..Update::default() }, ..facts() });
        assert_eq!(running.title, "Update refused: not signed by g1t");
        assert_eq!(
            running.cause.as_deref(),
            Some("The newest g1t-runner release from g1t.sh isn't signed with g1t's release key (the release's signature isn't g1t's), so g1t didn't install it.")
        );
        assert!(running.fix.as_deref().unwrap().starts_with("The runner keeps running g1t-runner 0.3.1, and g1t checks again within the hour."));
        assert_eq!(running.actions, [CHECK_AGAIN, REPORT]);
        assert_eq!(running.tone, Tone::Warning);
        // With no runner yet, nothing runs until a signed one downloads.
        let nothing = diagnose(Code::UpdateRefused, &Facts { detail, ..facts() });
        assert_eq!(nothing.title, "Not running: the runner's release isn't signed by g1t");
        assert_eq!((nothing.tone, nothing.actions[0].id), (Tone::Problem, "retry"));
        assert!(!nothing.in_capabilities);
    }

    #[test]
    fn the_title_bars_chip_says_the_runner_in_a_few_words() {
        let said = |code: Code, facts: &Facts| {
            let chip = chip(&diagnose(code, facts));
            (chip.tone, chip.label)
        };
        assert_eq!(said(Code::Idle, &facts()), (Tone::Ok, "Runner running".into()));
        assert_eq!(said(Code::Busy, &Facts { job: Some("build (acme/web)".into()), ..facts() }), (Tone::Working, "Running a job".into()));
        assert_eq!(said(Code::Starting, &facts()), (Tone::Working, "Runner starting".into()));
        assert_eq!(said(Code::Stopped, &facts()), (Tone::Off, "Runner stopped".into()));
        assert_eq!(said(Code::Off, &facts()), (Tone::Off, "Runner off".into()));
        assert_eq!(said(Code::NoWsl, &facts()), (Tone::Problem, "Runner needs you".into()));
        assert_eq!(said(Code::UpdateFailed, &Facts { detail: Some("x".into()), ..facts() }).1, "Runner running");
        // Both kinds of job busy at once.
        let both = status(
            r#"{"schema":1,"state":"running","capabilities":[
              {"id":"linux","available":true,"state":"running","turned_off":false,"job":{"kind":"workflow","id":"a","name":"build","repo":"acme/web"}},
              {"id":"windows","available":true,"state":"running","turned_off":false,"job":{"kind":"workflow","id":"b","name":"installer","repo":"acme/app"}}]}"#,
        );
        assert_eq!(said(Code::Busy, &Facts { sandbox: Some(both), live: true, ..facts() }), (Tone::Working, "Running 2 jobs".into()));
        // Linux jobs run while Windows jobs can't start: running, and wanting a look.
        let one_failing = status(NO_WSL_PRO);
        assert_eq!(said(Code::Idle, &Facts { sandbox: Some(one_failing), live: true, ..facts() }), (Tone::Warning, "Runner running".into()));
    }

    #[test]
    fn a_diagnosis_without_the_sandbox_lists_no_capabilities() {
        let json = serde_json::to_value(diagnose(Code::Idle, &Facts { backend: "in Docker", ..facts() })).unwrap();
        assert!(json.get("capabilities").is_none());
        assert!(json.get("in_capabilities").is_none());
        let sandboxed = serde_json::to_value(diagnose(Code::Idle, &Facts { sandbox: Some(status(NO_WSL_PRO)), ..facts() })).unwrap();
        assert_eq!(sandboxed["capabilities"][1]["id"], "windows");
        assert_eq!(sandboxed["capabilities"][1]["state"], "idle");
        assert_eq!(sandboxed["in_capabilities"], true);
        // What affects everything is said once, above the cards.
        let signed_out = diagnose(Code::SignedOut, &Facts { sandbox: Some(status(NO_WSL_PRO)), ..facts() });
        assert!(!signed_out.in_capabilities);
    }
}
