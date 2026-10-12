//! The runner in the app: g1t's self-hosted runner, started for the
//! signed-in person when g1t opens and stopped when it quits, so their
//! computer runs their workspace's `runs-on: self-hosted` jobs with
//! nothing to install, register or start by hand
//! (docs.g1t.sh/guides/desktop/#the-runner).
//!
//! - **When.** On by default; settings turn it off ("Run jobs on this
//!   computer while g1t is open"), and Stop in settings or the tray stops
//!   it until Start, or until g1t starts again. It starts a few seconds
//!   after the window, never before.
//! - **How.** The backend settings choose (backend.rs): Sandboxed, the
//!   default, where nothing a job does reaches this computer; Docker; or
//!   directly on this computer. The two that are not sandboxes are only
//!   ever chosen by the person, and nothing falls back to them. Sandboxed
//!   is `g1t-runner sandbox` (launcher.rs) on every OS: `up` a few seconds
//!   after the window, `status` every few seconds while it runs, `down`
//!   as g1t quits, and `down --drain` when another backend is chosen.
//!   Each kind of job it runs (Linux jobs, Windows jobs) starts and stops
//!   on its own too: settings keep which are on (`runnerCapabilities`),
//!   every `up` names them (`--only`), and stopping one is `down --only`
//!   it, which leaves the other running. One that should run and doesn't
//!   while the other runs is tried again by itself, every few minutes, and
//!   every five while the newest release has no sandbox images.
//! - **Registering.** The first time, and when the workspace or backend
//!   changes, the app needs a registration token for the workspace. Only
//!   the site can make one, for an owner who is signed in: the app asks
//!   the site's page (`g1t-runner-wanted`), the page asks the server
//!   (`POST /-/desktop/runner-token`) and hands the token to the app
//!   (`runner_register` in bridge.rs), which gives it to `g1t-runner`
//!   once: in its environment, or to the sandbox's first `up`. It is never
//!   shown or written to the log. The registration is kept
//!   (registration.json and the runner's own folder; the sandbox keeps its
//!   own, and sandbox-registration.json says whose it is) and used on
//!   every later start.
//! - **Up to date.** Soon after it starts and every six hours, while the
//!   runner is idle, the app looks for a newer release and puts it in
//!   place, and has the sandbox take the newest image (`sandbox update`):
//!   never in the middle of a job.
//! - **Seen.** What it is doing, and when it is not running why and how to
//!   fix it (diagnosis.rs), is in the tray, in settings, and on the site's
//!   Runners page (`g1t-runner-status`), read from what its log says
//!   (log.rs), or for the sandbox from its status. The whole log is kept
//!   in `runner/runner.log`.
//!
//! All of it runs on a thread of its own, which owns the runner's process
//! and is told what happened through one channel.

mod backend;
pub mod diagnosis;
mod launcher;
mod log;
mod native;

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::Mutex;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, EventTarget, Manager};
use url::Url;

pub use backend::Backend;
use backend::{Engine, Missing};
use diagnosis::{Code, Diagnosis, Facts};
use launcher::{Down, State, Status};

use crate::{config, frame, settings, tray};

/// What settings, the tray and the site listen for: the runner's status changed.
pub const STATUS_EVENT: &str = "g1t-runner-status";
/// What the site's page listens for: the app needs a registration token for a workspace.
pub const WANTED_EVENT: &str = "g1t-runner-wanted";

/// How long after the window the runner starts.
const AFTER_START: Duration = Duration::from_secs(4);
/// How often the thread looks at the runner when nothing has happened.
const TICK: Duration = Duration::from_secs(5);
/// How long after starting the first look for an update is, then how often.
const FIRST_UPDATE: Duration = Duration::from_secs(90);
const UPDATE_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// How often a backend that cannot start is looked at again.
const LOOK_AGAIN: Duration = Duration::from_secs(30);
/// How long the app waits for the site to hand over a token before asking again.
const ASK_AGAIN: Duration = Duration::from_secs(60);
/// The longest the app waits before starting a runner that stopped by itself again.
const MOST_BACKOFF: Duration = Duration::from_secs(10 * 60);
/// The runner says when a poll fails, and nothing when one works: this
/// long without another failure, it is back (its longest wait is 60s).
const BACK_ONLINE: Duration = Duration::from_secs(75);
/// The runner's log is started over when it is bigger than this.
const LOG_LIMIT: u64 = 5 * 1024 * 1024;
/// The last lines of the log settings show.
const TAIL: usize = 40;

/// A workspace the site says the person may add runners to: those they own.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Offered {
    pub slug: String,
    #[serde(default)]
    pub name: Option<String>,
}

/// What the runner is doing, as the thread last said.
#[derive(Clone, Debug, Default, PartialEq)]
struct Now {
    code: Code,
    detail: Option<String>,
    exit_code: Option<i32>,
    wait_seconds: Option<u64>,
    job: Option<String>,
    version: Option<String>,
    /// What the sandbox says to do, for a cause in its own words.
    fix: Option<String>,
    /// How the sandbox is, while jobs run sandboxed.
    sandbox: Option<Status>,
    /// A sandbox run is up, or on its way.
    live: bool,
    /// The kinds of job a launcher command is starting now.
    starting: Vec<String>,
    /// How far the sandbox's image has downloaded, while it does.
    download: Option<launcher::Download>,
}

/// What the site last said about the person.
#[derive(Clone, Debug, Default, PartialEq)]
struct Site {
    /// Unknown until the site's first page loads.
    signed_in: Option<bool>,
    owned: Vec<Offered>,
    current: Option<String>,
}

/// What the rest of the app shares with the thread.
#[derive(Default)]
pub struct Shared {
    now: Mutex<Now>,
    /// The workspace a token is wanted for.
    wanted: Mutex<Option<String>>,
    site: Mutex<Site>,
    /// Stopped by the person until Start, or until g1t starts again.
    paused: Mutex<bool>,
    tail: Mutex<VecDeque<String>>,
    tx: Mutex<Option<Sender<Ask>>>,
}

/// What settings, the tray and the site are shown.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub diagnosis: Diagnosis,
    /// What the site says of this computer once g1t is closed on it.
    pub closed: Diagnosis,
    pub running: bool,
    pub version: Option<String>,
    pub backend: Backend,
    pub workspace: Option<String>,
    /// The workspaces it may run for, from the site.
    pub workspaces: Vec<Offered>,
    /// The setting: run jobs while g1t is open.
    pub enabled: bool,
    pub paused: bool,
    /// The workspace's Runners page.
    pub link: Option<String>,
    /// This computer's name, which the runner has on g1t.
    pub machine: String,
    pub platform: String,
    /// The last lines of the runner's log.
    pub log: Vec<String>,
}

/// What the thread is told.
enum Ask {
    /// Something changed: settings, Start or Stop, Retry.
    Look,
    /// A kind of job was started: start what should run now, stopping nothing.
    Soon,
    Retry,
    Token { workspace: String, token: String },
    Refused { workspace: String, allowed: bool, why: String },
    /// A line of the runner's output, or the launcher's; true from its standard output.
    Line(u64, String, bool),
    Exited(u64),
    /// What `sandbox status` said.
    Sandbox(u64, Result<Box<Status>, String>),
    Quit(Sender<()>),
}

/// The registration the app made, besides what the runner keeps itself.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct Registration {
    server: String,
    workspace: String,
    backend: Backend,
}

/// Whose the sandbox's registration is. The sandbox keeps its own, and
/// keeps it while another backend runs, so choosing Sandboxed again needs
/// no new one; this says which workspace it is for.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct SandboxRegistration {
    server: String,
    workspace: String,
    /// False from the `up` that was given a token until it registered.
    registered: bool,
}

impl SandboxRegistration {
    fn path(app: &AppHandle) -> PathBuf {
        folder(app).join("sandbox-registration.json")
    }
    fn load(app: &AppHandle) -> Option<SandboxRegistration> {
        std::fs::read(Self::path(app)).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok())
    }
    fn save(&self, app: &AppHandle) {
        let _ = std::fs::create_dir_all(folder(app));
        let _ = std::fs::write(Self::path(app), serde_json::to_vec_pretty(self).unwrap_or_default());
    }
    fn clear(app: &AppHandle) {
        let _ = std::fs::remove_file(Self::path(app));
    }
}

fn folder(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("sh.g1t.desktop")).join("runner")
}

impl Registration {
    fn path(app: &AppHandle) -> PathBuf {
        folder(app).join("registration.json")
    }
    fn load(app: &AppHandle) -> Option<Registration> {
        std::fs::read(Self::path(app)).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok())
    }
    fn save(&self, app: &AppHandle) {
        let _ = std::fs::create_dir_all(folder(app));
        let _ = std::fs::write(Self::path(app), serde_json::to_vec_pretty(self).unwrap_or_default());
    }
    fn clear(app: &AppHandle) {
        let _ = std::fs::remove_file(Self::path(app));
    }
}

/// Where a native runner of a backend keeps its configuration.
fn native_dir(app: &AppHandle, backend: Backend) -> PathBuf {
    folder(app).join(match backend {
        Backend::Docker => "docker",
        Backend::Host => "host",
        Backend::Sandboxed => launcher::FOLDER,
    })
}

/// The workspace the runner is for: the one settings name, else the one it
/// is registered with, else the one the person is in on the site, else the
/// first they own.
fn workspace(app: &AppHandle) -> Option<String> {
    let settings = config::settings(app);
    if let Some(chosen) = settings.runner_workspace.filter(|w| !w.is_empty()) {
        return Some(chosen);
    }
    let server = config::server(app).to_string();
    if let Some(registration) = Registration::load(app).filter(|r| r.server == server) {
        return Some(registration.workspace);
    }
    let site = app.state::<Shared>().site.lock().unwrap().clone();
    site.current.filter(|slug| site.owned.iter().any(|o| &o.slug == slug)).or_else(|| site.owned.first().map(|o| o.slug.clone()))
}

/// The kinds of job a sandbox can have.
const KINDS: [&str; 3] = ["linux", "windows", "macos"];

fn facts(app: &AppHandle, now: &Now) -> Facts {
    let server = config::server(app);
    let settings = config::settings(app);
    let backend = settings.runner_backend;
    Facts {
        workspace: workspace(app),
        backend: backend.label(),
        machine: backend::machine_name(),
        job: now.job.clone(),
        detail: now.detail.clone(),
        exit_code: now.exit_code,
        wait_seconds: now.wait_seconds,
        server: server.host_str().unwrap_or("g1t").to_owned(),
        site: server.as_str().trim_end_matches('/').to_owned(),
        platform: std::env::consts::OS.into(),
        fix: now.fix.clone(),
        sandbox: now.sandbox.clone().filter(|_| backend == Backend::Sandboxed),
        off: KINDS.iter().filter(|kind| !settings.runner_capabilities.on(kind)).map(|kind| (*kind).to_owned()).collect(),
        live: now.live,
        starting: now.starting.clone(),
        download: now.download.clone(),
        held: !settings.runner || *app.state::<Shared>().paused.lock().unwrap(),
    }
}

pub fn view(app: &AppHandle) -> View {
    let shared = app.state::<Shared>();
    let now = shared.now.lock().unwrap().clone();
    let settings = config::settings(app);
    let facts = facts(app, &now);
    let server = config::server(app);
    View {
        diagnosis: diagnosis::diagnose(now.code, &facts),
        closed: diagnosis::closed(&facts),
        running: matches!(now.code, Code::Idle | Code::Busy | Code::Offline) || facts.sandbox.as_ref().is_some_and(Status::running),
        version: now.version,
        backend: settings.runner_backend,
        link: facts.workspace.as_ref().and_then(|w| server.join(&format!("{w}/-/runners")).ok()).map(|u| u.to_string()),
        workspace: facts.workspace,
        workspaces: shared.site.lock().unwrap().owned.clone(),
        enabled: settings.runner,
        paused: *shared.paused.lock().unwrap(),
        machine: facts.machine,
        platform: facts.platform,
        log: shared.tail.lock().unwrap().iter().cloned().collect(),
    }
}

/// The tray's line: `Runner: Waiting for jobs`, at most 60 characters.
pub fn headline(view: &View) -> String {
    let line = format!("Runner: {}", view.diagnosis.title);
    if line.chars().count() > 60 { line.chars().take(59).collect::<String>() + "…" } else { line }
}

/// Tells everyone what the runner is doing now.
fn publish(app: &AppHandle) {
    let view = view(app);
    tray::runner_changed(app, &view);
    let _ = app.emit_to(settings::SETTINGS, STATUS_EVENT, view.clone());
    let _ = app.emit_to(EventTarget::webview(frame::SITE), STATUS_EVENT, view);
}

fn ask(app: &AppHandle, ask: Ask) {
    if let Some(tx) = app.state::<Shared>().tx.lock().unwrap().as_ref() {
        let _ = tx.send(ask);
    }
}

/// Starts the thread that keeps the runner, as the app starts.
pub fn install(app: &AppHandle) {
    let (tx, rx) = mpsc::channel();
    *app.state::<Shared>().tx.lock().unwrap() = Some(tx.clone());
    let handle = app.clone();
    let spawned = std::thread::Builder::new().name("g1t-runner".into()).spawn(move || Keeper::new(handle, tx).keep(rx));
    if let Err(error) = spawned {
        eprintln!("g1t: the runner's thread could not start: {error}");
    }
}

/// Settings changed: the thread looks again.
pub fn settings_changed(app: &AppHandle) {
    ask(app, Ask::Look);
    publish(app);
}

/// Start or Stop, from settings or the tray.
pub fn set_paused(app: &AppHandle, paused: bool) {
    *app.state::<Shared>().paused.lock().unwrap() = paused;
    // Start with the setting off turns the setting on: that is what was asked.
    if !paused && !config::settings(app).runner {
        let mut settings = config::settings(app);
        settings.runner = true;
        let _ = settings::apply(app, settings);
    }
    settings_changed(app);
}

/// Start or Stop on one kind of job's card: kept in settings, and the
/// thread starts or stops that kind alone. Starting one with the runner
/// off or stopped starts the runner too: that is what was asked.
pub fn set_kind(app: &AppHandle, kind: &str, on: bool) -> Result<(), String> {
    let mut settings = config::settings(app);
    if !settings.runner_capabilities.set(kind, on) {
        return Err(format!("g1t runs no {kind} jobs"));
    }
    if on {
        settings.runner = true;
        *app.state::<Shared>().paused.lock().unwrap() = false;
    }
    settings::apply(app, settings)?;
    if on {
        ask(app, Ask::Soon);
    }
    settings_changed(app);
    Ok(())
}

/// The tray's Start or Stop row.
pub fn toggle(app: &AppHandle) {
    let view = view(app);
    set_paused(app, view.enabled && !view.paused);
}

/// Retry and Restart: now, rather than when the wait is over.
pub fn retry(app: &AppHandle) {
    *app.state::<Shared>().paused.lock().unwrap() = false;
    ask(app, Ask::Retry);
}

/// What the site says about the person, on every page: whether they are
/// signed in, the workspaces they own, and the one they are in.
pub fn offer(app: &AppHandle, signed_in: bool, owned: Vec<Offered>, current: Option<String>) {
    let next = Site { signed_in: Some(signed_in), owned, current: current.map(|c| c.to_ascii_lowercase()) };
    let changed = {
        let shared = app.state::<Shared>();
        let mut site = shared.site.lock().unwrap();
        let changed = *site != next;
        *site = next;
        changed
    };
    if changed {
        settings_changed(app);
    }
}

/// The site handed over a registration token, or said why it could not:
/// `allowed` is false when the person may not add runners to the workspace.
pub fn register(app: &AppHandle, workspace: String, token: Option<String>, allowed: bool, error: Option<String>) {
    match token {
        Some(token) if token.starts_with("g1trt_") => ask(app, Ask::Token { workspace, token }),
        _ => ask(app, Ask::Refused { workspace, allowed, why: error.unwrap_or_else(|| "g1t didn't make a registration token.".into()) }),
    }
}

/// A diagnosis's button, or Start and Stop: from the settings window, or
/// from the site's card for this computer. With a kind of job (`linux`,
/// `windows`), Start and Stop are that kind's alone.
pub fn act(app: &AppHandle, action: &str, kind: Option<&str>) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let browse = |url: &str| app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string());
    if let ("start" | "stop", Some(kind)) = (action, kind) {
        return set_kind(app, kind, action == "start");
    }
    match action {
        "start" => {
            set_paused(app, false);
            retry(app);
        }
        "stop" => set_paused(app, true),
        "retry" | "restart" => retry(app),
        "sign_in" => crate::links::go(app, "/login"),
        "new_workspace" => crate::links::go(app, "/workspaces/new"),
        "view_runners" => match workspace(app) {
            Some(workspace) => crate::links::go(app, &format!("/{workspace}/-/runners")),
            None => crate::links::go(app, "/"),
        },
        "choose_workspace" | "choose_backend" => settings::open(app),
        "view_log" => {
            let path = log_file(app);
            if !path.exists() {
                return Err("The runner hasn't written a log yet.".into());
            }
            app.opener().open_path(path.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())?;
        }
        "open_docker" => open_docker(app)?,
        "copy_wsl_install" => copy(launcher::WSL_INSTALL)?,
        "copy_vfkit_install" => copy(launcher::VFKIT_INSTALL)?,
        "windows_features" => windows_features()?,
        "get_docker" => browse("https://docs.docker.com/get-started/get-docker/")?,
        "install_sysbox" => browse("https://github.com/nestybox/sysbox#installation")?,
        "learn_more" => browse("https://docs.g1t.sh/guides/desktop/#how-jobs-run")?,
        "report" => browse(config::server(app).join("support").map_err(|e| e.to_string())?.as_str())?,
        other => return Err(format!("the runner has no action called {other}")),
    }
    Ok(())
}

/// Starts Docker Desktop, where it is installed in its usual place.
fn open_docker(app: &AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if cfg!(target_os = "macos") {
        return app.opener().open_path("/Applications/Docker.app", None::<&str>).map_err(|e| e.to_string());
    }
    if cfg!(windows) {
        let program = std::env::var_os("ProgramFiles").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
        let desktop = program.join("Docker").join("Docker").join("Docker Desktop.exe");
        if desktop.exists() {
            return app.opener().open_path(desktop.to_string_lossy(), None::<&str>).map_err(|e| e.to_string());
        }
        return Err("Docker Desktop isn't installed in its usual place. Get Docker to install it.".into());
    }
    Err("Start Docker with your system's service manager, such as `sudo systemctl start docker`.".into())
}

/// Puts a command on the clipboard, for the person to paste where it runs.
fn copy(text: &str) -> Result<(), String> {
    let tools: &[(&str, &[&str])] = if cfg!(windows) {
        &[("clip", &[])]
    } else if cfg!(target_os = "macos") {
        &[("pbcopy", &[])]
    } else {
        &[("wl-copy", &[]), ("xclip", &["-selection", "clipboard"]), ("xsel", &["--clipboard", "--input"])]
    };
    for (program, args) in tools {
        let Ok(mut child) = backend::quiet(program).args(*args).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() else { continue };
        if let Some(mut input) = child.stdin.take() {
            let _ = input.write_all(text.as_bytes());
        }
        if child.wait().is_ok_and(|status| status.success()) {
            return Ok(());
        }
    }
    Err(format!("It couldn't be copied. The command is: {text}"))
}

/// Windows' "Turn Windows features on or off", where Windows Sandbox and
/// Virtual Machine Platform are.
fn windows_features() -> Result<(), String> {
    if !cfg!(windows) {
        return Err("Windows features are only on Windows.".into());
    }
    backend::quiet("optionalfeatures.exe").spawn().map(|_| ()).map_err(|e| format!("Windows features couldn't be opened: {e}"))
}

/// The workspace a token is wanted for now, if one is: the site asks as it loads.
pub fn wanted(app: &AppHandle) -> Option<String> {
    app.state::<Shared>().wanted.lock().unwrap().clone()
}

/// The runner's log, for the settings window to open.
pub fn log_file(app: &AppHandle) -> PathBuf {
    folder(app).join("runner.log")
}

/// Stops the runner as g1t quits or restarts, and waits for it.
pub fn shutdown(app: &AppHandle) {
    let tx = app.state::<Shared>().tx.lock().unwrap().take();
    if let Some(tx) = tx {
        let (done, wait) = mpsc::channel();
        if tx.send(Ask::Quit(done)).is_ok() {
            let _ = wait.recv_timeout(Duration::from_secs(30));
        }
    }
}

/// How the runner is started this time.
enum Process {
    /// `g1t-runner`, a child of the app, whose output is the runner's log.
    Child(Child),
    /// The sandbox, which runs on its own once `up` is done; the launcher
    /// command the app is waiting for, while there is one.
    Sandbox(Option<(Step, Child)>),
}

/// A launcher command that takes a while.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Step {
    Up,
    Update,
    /// `up --only <kind>`: one kind of job, started while the rest run.
    Start(String),
    /// `down --only <kind>`: one kind of job, stopped, the rest running on.
    Stop(String),
}

impl Step {
    fn name(&self) -> &'static str {
        match self {
            Step::Up | Step::Start(_) => "up",
            Step::Update => "update",
            Step::Stop(_) => "down",
        }
    }
}

struct Run {
    generation: u64,
    engine: Engine,
    backend: Backend,
    workspace: String,
    process: Process,
    /// Registered and polling.
    listening: bool,
    busy: bool,
    /// When a poll last failed to reach g1t.
    offline_at: Option<Instant>,
    /// Started with a registration token, which a container keeps in its configuration until replaced.
    with_token: bool,
    forgotten: bool,
    token_refused: bool,
    error: Option<String>,
    /// The status a launcher command is printing, line by line.
    json: Option<Vec<String>>,
    /// Asking the sandbox how it is, and when it was last asked.
    polling: bool,
    polled_at: Option<Instant>,
    /// A poll asked before a launcher command ended, whose answer is old.
    stale: bool,
}

impl Run {
    fn new(generation: u64, engine: Engine, backend: Backend, workspace: String, process: Process, with_token: bool) -> Run {
        Run {
            generation,
            engine,
            backend,
            workspace,
            process,
            listening: false,
            busy: false,
            offline_at: None,
            with_token,
            forgotten: false,
            token_refused: false,
            error: None,
            json: None,
            polling: false,
            polled_at: None,
            stale: false,
        }
    }

    fn step(&self) -> Option<Step> {
        match &self.process {
            Process::Sandbox(Some((step, _))) => Some(step.clone()),
            _ => None,
        }
    }
}

struct Keeper {
    app: AppHandle,
    tx: Sender<Ask>,
    run: Option<Run>,
    generation: u64,
    token: Option<(String, String)>,
    not_before: Instant,
    failures: u32,
    next_update: Instant,
    log: Option<File>,
    /// The runner was updated: the sandbox takes its image before it starts again.
    image_pending: bool,
    /// Why the last update failed, said until the next one works.
    update_failed: Option<String>,
    /// A kind of job that should run and doesn't, while another runs:
    /// when it is tried again, and how many times it has been.
    retry: Vec<(String, Instant, u32)>,
}

/// What a set of the state carries besides its code.
#[derive(Default)]
struct Extra {
    detail: Option<String>,
    exit_code: Option<i32>,
    wait_seconds: Option<u64>,
    fix: Option<String>,
}

fn detail(text: impl Into<String>) -> Extra {
    Extra { detail: Some(text.into()), ..Extra::default() }
}

impl Keeper {
    fn new(app: AppHandle, tx: Sender<Ask>) -> Keeper {
        let now = Instant::now();
        Keeper {
            app,
            tx,
            run: None,
            generation: 0,
            token: None,
            not_before: now + AFTER_START,
            failures: 0,
            next_update: now + FIRST_UPDATE,
            log: None,
            image_pending: false,
            update_failed: None,
            retry: Vec::new(),
        }
    }

    fn keep(mut self, rx: Receiver<Ask>) {
        self.reap();
        self.set(Code::Starting, detail("Starting after g1t's window."));
        loop {
            match rx.recv_timeout(TICK) {
                Ok(Ask::Quit(done)) => {
                    self.halt();
                    let _ = done.send(());
                    return;
                }
                Ok(ask) => self.handle(ask),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    self.halt();
                    return;
                }
            }
            self.look();
        }
    }

    fn set(&mut self, code: Code, extra: Extra) {
        let changed = {
            let shared = self.app.state::<Shared>();
            let mut now = shared.now.lock().unwrap();
            let job = if code == Code::Busy { now.job.clone() } else { None };
            let next = Now {
                code,
                detail: extra.detail,
                exit_code: extra.exit_code,
                wait_seconds: extra.wait_seconds,
                job,
                fix: extra.fix,
                live: self.run.as_ref().is_some_and(|run| run.engine == Engine::Launcher),
                ..now.clone()
            };
            let changed = *now != next;
            *now = next;
            changed
        };
        if changed {
            publish(&self.app);
        }
    }

    fn code(&self) -> Code {
        self.app.state::<Shared>().now.lock().unwrap().code
    }

    fn note(&mut self, job: Option<String>, version: Option<String>) {
        let shared = self.app.state::<Shared>();
        let mut now = shared.now.lock().unwrap();
        if job.is_some() {
            now.job = job;
        }
        if version.is_some() {
            now.version = version;
        }
    }

    /// A line of the runner's log, into the log file and the tail settings show.
    fn write_log(&mut self, line: &str) {
        {
            let shared = self.app.state::<Shared>();
            let mut tail = shared.tail.lock().unwrap();
            if tail.len() == TAIL {
                tail.pop_front();
            }
            tail.push_back(line.to_owned());
        }
        let path = log_file(&self.app);
        if self.log.is_none() {
            let _ = std::fs::create_dir_all(folder(&self.app));
            if std::fs::metadata(&path).is_ok_and(|m| m.len() > LOG_LIMIT) {
                let _ = std::fs::rename(&path, path.with_extension("log.old"));
            }
            self.log = OpenOptions::new().create(true).append(true).open(&path).ok();
        }
        if let Some(file) = self.log.as_mut() {
            let _ = writeln!(file, "{line}");
        }
    }

    fn handle(&mut self, ask: Ask) {
        match ask {
            Ask::Look | Ask::Quit(_) => {}
            Ask::Soon => {
                self.not_before = Instant::now();
                for (_, at, _) in &mut self.retry {
                    *at = Instant::now();
                }
            }
            Ask::Retry => {
                self.not_before = Instant::now();
                self.failures = 0;
                // Each kind of job that waits to be tried again is tried now.
                for (_, at, _) in &mut self.retry {
                    *at = Instant::now();
                }
                match self.code() {
                    // The runner is fine: only the update is tried again.
                    Code::UpdateFailed => {
                        self.next_update = Instant::now();
                        self.update_failed = None;
                    }
                    Code::Offline => self.halt(),
                    _ if self.run.as_ref().is_some_and(|run| !run.listening) => self.halt(),
                    _ => {}
                }
            }
            Ask::Token { workspace, token } => {
                let shared = self.app.state::<Shared>();
                let mut wanted = shared.wanted.lock().unwrap();
                if wanted.as_deref() == Some(workspace.as_str()) {
                    *wanted = None;
                    self.token = Some((workspace, token));
                    self.not_before = Instant::now();
                }
            }
            Ask::Refused { workspace, allowed, why } => {
                let matched = {
                    let shared = self.app.state::<Shared>();
                    let mut wanted = shared.wanted.lock().unwrap();
                    let matched = wanted.as_deref() == Some(workspace.as_str());
                    if matched {
                        *wanted = None;
                    }
                    matched
                };
                if matched {
                    self.not_before = Instant::now() + MOST_BACKOFF;
                    self.set(if allowed { Code::RegisterFailed } else { Code::NotAllowed }, detail(why));
                }
            }
            Ask::Line(generation, line, out) => self.line(generation, &line, out),
            Ask::Exited(generation) => self.exited(generation),
            Ask::Sandbox(generation, status) => self.polled(generation, status),
        }
    }

    fn line(&mut self, generation: u64, line: &str, out: bool) {
        let Some(run) = self.run.as_mut().filter(|run| run.generation == generation) else { return };
        if run.engine == Engine::Launcher {
            // The launcher's log, then its status, which is read when it ends.
            if out && (run.json.is_some() || launcher::starts_status(line)) {
                run.json.get_or_insert_with(Vec::new).push(line.to_owned());
            } else {
                if let Some(download) = launcher::download(line) {
                    let changed = {
                        let shared = self.app.state::<Shared>();
                        let mut now = shared.now.lock().unwrap();
                        let changed = now.download.as_ref() != Some(&download);
                        now.download = Some(download);
                        changed
                    };
                    if changed {
                        publish(&self.app);
                    }
                }
                self.write_log(line);
            }
            return;
        }
        let mut became = None;
        let mut job = None;
        let mut version = None;
        match log::read(line) {
            log::Event::Listening { version: v } => {
                run.listening = true;
                version = Some(v);
                became = Some(Code::Idle);
            }
            log::Event::Took { name, repo } => {
                run.busy = true;
                run.offline_at = None;
                job = Some(format!("{name} ({repo})"));
                became = Some(Code::Busy);
            }
            log::Event::Ended => {
                run.busy = false;
                became = Some(Code::Idle);
            }
            log::Event::Offline => {
                run.offline_at = Some(Instant::now());
                if !run.busy {
                    became = Some(Code::Offline);
                }
            }
            log::Event::Forgotten => run.forgotten = true,
            log::Event::TokenRefused => run.token_refused = true,
            log::Event::Failed(error) => run.error = Some(error),
            log::Event::Other => {}
        }
        let registered = version.is_some().then(|| Registration {
            server: config::server(&self.app).to_string(),
            workspace: run.workspace.clone(),
            backend: run.backend,
        });
        self.write_log(line);
        if let Some(registration) = registered {
            registration.save(&self.app);
            self.failures = 0;
        }
        self.note(job, version);
        if let Some(code) = became {
            self.set(code, Extra::default());
        }
    }

    fn exited(&mut self, generation: u64) {
        if self.run.as_ref().is_none_or(|run| run.generation != generation) {
            return;
        }
        if self.run.as_ref().is_some_and(|run| run.engine == Engine::Launcher) {
            return self.launched(generation);
        }
        let mut run = self.run.take().expect("checked above");
        let exit_code = match &mut run.process {
            Process::Child(child) => child.wait().ok().and_then(|status| status.code()),
            Process::Sandbox(_) => None,
        };
        self.stop(&mut run, Down::Now);
        if run.forgotten || run.token_refused {
            // The registration is no more, or was never made: the next start asks for a token.
            self.forget();
            self.not_before = Instant::now();
            return;
        }
        self.failures += 1;
        let wait = Duration::from_secs(15 * 2u64.pow(self.failures.min(6))).min(MOST_BACKOFF);
        self.not_before = Instant::now() + wait;
        let offline = run.error.as_deref().is_some_and(|e| e.contains("could not reach g1t"));
        if offline {
            self.set(Code::Offline, Extra::default());
        } else if !run.listening && Registration::load(&self.app).is_none() {
            self.set(Code::RegisterFailed, Extra { detail: run.error, ..Extra::default() });
        } else {
            self.set(Code::Crashed, Extra { detail: run.error, exit_code, wait_seconds: Some(wait.as_secs()), ..Extra::default() });
        }
    }

    /// Stops a run's process, the way it was started: the sandbox `how` says.
    fn stop(&mut self, run: &mut Run, how: Down) {
        match (&mut run.process, run.engine) {
            (Process::Sandbox(step), _) => {
                // A launcher command still going is ended first, then the sandbox stopped.
                if let Some((_, child)) = step.as_mut() {
                    native::stop(child);
                }
                let binary = native::binary(&folder(&self.app));
                // How it is once stopped, so each kind of job's card says so.
                let stopped = match launcher::down(&binary, &native_dir(&self.app, Backend::Sandboxed), how) {
                    Ok(status) => Some(status),
                    Err(why) => {
                        self.write_log(&format!("g1t: the sandbox didn't stop cleanly: {why}"));
                        None
                    }
                };
                let shared = self.app.state::<Shared>();
                let mut now = shared.now.lock().unwrap();
                now.sandbox = stopped.filter(|_| how != Down::Delete);
                now.starting.clear();
                now.download = None;
            }
            (Process::Child(child), Engine::Launcher) => native::stop(child),
            (Process::Child(child), Engine::Native { docker }) => {
                native::stop(child);
                // A job's container outlives the runner killed under it: removed now, not at its next start.
                if docker {
                    native::sweep(&native_dir(&self.app, run.backend));
                }
            }
        }
        let _ = std::fs::remove_file(folder(&self.app).join("pid"));
    }

    /// Stops whatever runs now.
    fn halt(&mut self) {
        self.halt_as(Down::Now);
    }

    /// Stops whatever runs: the sandbox now, after its job, or for good.
    fn halt_as(&mut self, how: Down) {
        self.generation += 1;
        if let Some(mut run) = self.run.take() {
            self.stop(&mut run, how);
        }
    }

    /// A runner an earlier g1t started and did not stop: it ended without quitting.
    fn reap(&self) {
        if let Some(pid) = std::fs::read_to_string(folder(&self.app).join("pid")).ok().and_then(|text| text.trim().parse().ok()) {
            native::reap(pid);
            let _ = std::fs::remove_file(folder(&self.app).join("pid"));
        }
    }

    /// Unregisters the runner the app registered, whatever backend it was.
    fn forget(&mut self) {
        let app = self.app.clone();
        let Some(registration) = Registration::load(&app) else { return };
        let binary = native::binary(&folder(&app));
        match registration.backend {
            // The sandbox keeps its registration for when it is chosen
            // again (sandbox-registration.json says whose): it only stops,
            // after its job.
            Backend::Sandboxed => {
                let _ = launcher::down(&binary, &native_dir(&app, Backend::Sandboxed), Down::Drain);
            }
            backend => native::forget(&binary, &native_dir(&app, backend)),
        }
        Registration::clear(&app);
    }

    /// Removes the sandbox and its registration: it was for another
    /// workspace, or g1t no longer knows its runners.
    fn forget_sandbox(&mut self) {
        let binary = native::binary(&folder(&self.app));
        if let Err(why) = launcher::down(&binary, &native_dir(&self.app, Backend::Sandboxed), Down::Delete) {
            self.write_log(&format!("g1t: the sandbox couldn't be removed: {why}"));
        }
        SandboxRegistration::clear(&self.app);
        if Registration::load(&self.app).is_some_and(|r| r.backend == Backend::Sandboxed) {
            Registration::clear(&self.app);
        }
    }

    /// Whether what a native runner keeps of a registration is still here.
    fn kept(&self, backend: Backend) -> bool {
        native_dir(&self.app, backend).join("config.json").exists()
    }

    /// Asks the site for a registration token for `workspace`.
    fn want(&mut self, workspace: &str) {
        *self.app.state::<Shared>().wanted.lock().unwrap() = Some(workspace.to_owned());
        let _ = self.app.emit_to(EventTarget::webview(frame::SITE), WANTED_EVENT, workspace.to_owned());
        self.not_before = Instant::now() + ASK_AGAIN;
        let signed_out = self.app.state::<Shared>().site.lock().unwrap().signed_in == Some(false);
        self.set(if signed_out { Code::SignedOut } else { Code::Registering }, Extra::default());
    }

    /// The thread's look round: what should run, and whether it does.
    fn look(&mut self) {
        let settings = config::settings(&self.app);
        let paused = *self.app.state::<Shared>().paused.lock().unwrap();
        if !settings.runner || paused {
            if self.run.is_some() {
                self.halt();
            }
            *self.app.state::<Shared>().wanted.lock().unwrap() = None;
            self.set(if paused { Code::Stopped } else { Code::Off }, Extra::default());
            return;
        }
        let workspace = workspace(&self.app);
        if let Some(run) = &self.run {
            let moved = run.backend != settings.runner_backend || Some(&run.workspace) != workspace.as_ref();
            let back = run.offline_at.is_some_and(|at| at.elapsed() >= BACK_ONLINE);
            let (busy, listening, stepping) = (run.busy, run.listening, run.step().is_some());
            if back {
                if let Some(run) = self.run.as_mut() {
                    run.offline_at = None;
                }
                self.set(Code::Idle, Extra::default());
            }
            // A change of backend or workspace waits for the job to end, as an update does.
            if moved && !busy && !stepping {
                self.halt_as(Down::Drain);
                self.not_before = Instant::now();
            } else if !busy && listening && !stepping && Instant::now() >= self.next_update {
                self.update();
            } else if !moved && !stepping {
                self.kinds(workspace.as_deref());
            }
            self.poll();
            return;
        }
        if Instant::now() < self.not_before {
            return;
        }
        self.start(settings.runner_backend, workspace);
    }

    fn start(&mut self, backend: Backend, workspace: Option<String>) {
        let app = self.app.clone();
        let engine = match backend::engine(backend) {
            Ok(engine) => engine,
            Err(missing) => {
                self.not_before = Instant::now() + LOOK_AGAIN;
                let code = match missing {
                    Missing::Docker => Code::NoDocker,
                };
                self.set(code, Extra::default());
                return;
            }
        };
        let Some(workspace) = workspace else {
            self.not_before = Instant::now() + LOOK_AGAIN;
            let code = match app.state::<Shared>().site.lock().unwrap().signed_in {
                Some(false) => Code::SignedOut,
                Some(true) => Code::NoWorkspace,
                None => Code::Starting,
            };
            self.set(code, detail("Waiting for g1t to open."));
            return;
        };
        if engine == Engine::Launcher {
            return self.start_sandbox(workspace);
        }
        let server = config::server(&app);
        let registration = Registration::load(&app);
        let ours = registration.as_ref().is_some_and(|r| r.server == server.as_str() && r.workspace == workspace && r.backend == backend) && self.kept(backend);
        let mut token = None;
        if !ours {
            if registration.is_some() {
                self.set(Code::Starting, detail("Removing this computer's earlier registration."));
                self.forget();
            }
            match self.token.take() {
                Some((for_workspace, given)) if for_workspace == workspace => token = Some(given),
                _ => return self.want(&workspace),
            }
        }
        self.hold_workspace(&workspace);
        self.set(Code::Starting, Extra::default());
        let envs = environment(&server, backend, token.as_deref());
        let generation = self.generation + 1;
        self.generation = generation;
        let started = self.ensure_binary(&server).and_then(|binary| {
            let child = native::spawn(&binary, &native_dir(&app, backend), &envs).map_err(|e| format!("g1t-runner could not start: {e}"))?;
            let _ = std::fs::write(folder(&app).join("pid"), child.id().to_string());
            Ok(child)
        });
        match started {
            Ok(mut child) => {
                self.follow(generation, &mut child);
                self.run = Some(Run::new(generation, engine, backend, workspace, Process::Child(child), token.is_some()));
                self.set(Code::Starting, Extra::default());
            }
            Err(why) => self.not_started(workspace, token, why),
        }
    }

    /// The runner couldn't be started: the token is kept for the next try,
    /// while it lasts, and it is tried again in a while.
    fn not_started(&mut self, workspace: String, token: Option<String>, why: String) {
        if let Some(given) = token {
            self.token = Some((workspace, given));
        }
        self.failures += 1;
        self.not_before = Instant::now() + LOOK_AGAIN;
        let offline = why.contains("error sending request") || why.contains("dns") || why.contains("connect");
        self.write_log(&format!("g1t: the runner could not start: {why}"));
        if offline {
            self.set(Code::Offline, Extra::default());
        } else {
            self.set(Code::Crashed, Extra { detail: Some(why), wait_seconds: Some(LOOK_AGAIN.as_secs()), ..Extra::default() });
        }
    }

    /// The setting names the workspace from now on, so browsing another one never moves the runner.
    fn hold_workspace(&self, workspace: &str) {
        if config::settings(&self.app).runner_workspace.as_deref() != Some(workspace) {
            let mut settings = config::settings(&self.app);
            settings.runner_workspace = Some(workspace.to_owned());
            let _ = config::set_settings(&self.app, settings);
        }
    }

    /// Reads the child's output, a line at a time, onto the thread's channel.
    fn follow(&self, generation: u64, child: &mut Child) {
        fn pipe(tx: Sender<Ask>, generation: u64, from: impl Read + Send + 'static, last: bool) {
            std::thread::spawn(move || {
                for line in BufReader::new(from).lines().map_while(Result::ok) {
                    if tx.send(Ask::Line(generation, line, last)).is_err() {
                        return;
                    }
                }
                if last {
                    let _ = tx.send(Ask::Exited(generation));
                }
            });
        }
        if let Some(err) = child.stderr.take() {
            pipe(self.tx.clone(), generation, err, false);
        }
        if let Some(out) = child.stdout.take() {
            pipe(self.tx.clone(), generation, out, true);
        }
    }

    /// `g1t-runner` installed, from the newest release when it is not.
    fn ensure_binary(&mut self, server: &Url) -> Result<PathBuf, String> {
        let folder = folder(&self.app);
        let binary = native::binary(&folder);
        if native::installed(&folder).is_some() {
            return Ok(binary);
        }
        self.set(Code::Updating, detail("Downloading g1t-runner."));
        let manifest = native::latest(server)?;
        let bytes = native::download(server, &manifest)?;
        native::put(&folder, &bytes, &manifest.version)?;
        self.note(None, Some(manifest.version));
        Ok(binary)
    }

    /// A newer release or image, put in place while the runner is idle.
    /// The new one is downloaded and checked before the runner stops, so
    /// one that fails leaves it running as it was.
    fn update(&mut self) {
        self.next_update = Instant::now() + UPDATE_EVERY;
        if !config::settings(&self.app).auto_update {
            return;
        }
        let Some(engine) = self.run.as_ref().map(|run| run.engine) else { return };
        let server = config::server(&self.app);
        let folder = folder(&self.app);
        let release = match self.newer_release(&server) {
            Ok(release) => release,
            Err(why) => {
                let why = format!("g1t-runner couldn't be updated: {why}");
                self.write_log(&format!("g1t: {why}"));
                self.update_failed = Some(why.clone());
                return self.set(Code::UpdateFailed, detail(why));
            }
        };
        let Some((version, bytes)) = release else {
            // The program is the newest; the sandbox's image may not be
            // (`update` does nothing when it is).
            if engine == Engine::Launcher {
                self.sandbox_step(Step::Update);
            }
            return;
        };
        self.set(Code::Updating, detail(format!("Updating g1t-runner to {version}.")));
        // The sandbox's runner for Windows jobs is this program too: it
        // stops, after its job, before the program is replaced.
        self.halt_as(Down::Drain);
        match native::put(&folder, &bytes, &version) {
            Ok(()) => {
                self.note(None, Some(version));
                self.update_failed = None;
                // The sandbox's image comes with each release.
                self.image_pending = engine == Engine::Launcher;
            }
            Err(why) => self.write_log(&format!("g1t: g1t-runner {version} couldn't be put in place: {why}")),
        }
        self.not_before = Instant::now();
    }

    /// A release newer than the `g1t-runner` here, downloaded and checked
    /// against its SHA-256: its version and program. None when this one is
    /// the newest, or the releases can't be asked now.
    fn newer_release(&self, server: &Url) -> Result<Option<(String, Vec<u8>)>, String> {
        let Ok(manifest) = native::latest(server) else { return Ok(None) };
        if !native::installed(&folder(&self.app)).is_none_or(|have| native::newer(&manifest.version, &have)) {
            return Ok(None);
        }
        let bytes = native::download(server, &manifest).map_err(|why| format!("{} didn't download: {why}", manifest.version))?;
        Ok(Some((manifest.version, bytes)))
    }

    // --- The sandbox (launcher.rs) ------------------------------------------------

    /// Starts the sandbox for `workspace`: registered with it the first
    /// time, with a token from the site; from its own registration after.
    fn start_sandbox(&mut self, workspace: String) {
        let app = self.app.clone();
        let server = config::server(&app);
        let binary = match self.ensure_binary(&server) {
            Ok(binary) => binary,
            Err(why) => return self.not_started(workspace, None, why),
        };
        let dir = native_dir(&app, Backend::Sandboxed);
        let mut status = match launcher::status(&binary, &dir) {
            Ok(status) => status,
            Err(why) => return self.no_status(why),
        };
        self.seen(&status);
        // Nothing here can be sandboxed: why, and how to fix it; looked at again in a while.
        if !status.anything_available() {
            self.not_before = Instant::now() + LOOK_AGAIN;
            let (code, extra) = shown(&status);
            return self.set(code, extra);
        }
        // Another backend's registration goes; the sandbox's own is kept for its workspace.
        if Registration::load(&app).is_some_and(|r| r.backend != Backend::Sandboxed) {
            self.set(Code::Starting, detail("Removing this computer's earlier registration."));
            self.forget();
        }
        let kept = SandboxRegistration::load(&app);
        let ours = kept.as_ref().is_some_and(|k| k.server == server.as_str() && k.workspace == workspace);
        let made = status.capabilities.iter().any(|c| c.state != State::Absent) || status.state != State::Absent;
        if !ours && made && kept.is_none() {
            // Made by hand (`g1t-runner sandbox up`), and there is one per computer: it is the person's to remove.
            self.not_before = Instant::now() + LOOK_AGAIN;
            return self.set(Code::SandboxTaken, Extra::default());
        }
        if !ours && made {
            // The app's sandbox, registered with another workspace or server.
            self.set(Code::Starting, detail("Removing this computer's sandbox for another workspace."));
            self.forget_sandbox();
            status = match launcher::status(&binary, &dir) {
                Ok(status) => status,
                Err(why) => return self.no_status(why),
            };
        }
        // The kinds of job the person stopped are stopped here too, before
        // anything starts (the launcher keeps them off); with every kind
        // stopped, nothing starts.
        let kinds = config::settings(&app).runner_capabilities;
        if status.per_kind() {
            let stopping: Vec<String> = status.capabilities.iter().filter(|c| !kinds.on(&c.id) && !c.off()).map(|c| c.id.clone()).collect();
            for kind in &stopping {
                if let Err(why) = launcher::down_only(&binary, &dir, kind) {
                    self.write_log(&format!("g1t: {} couldn't be stopped: {why}", diagnosis::kind_label(kind)));
                }
            }
            if !stopping.is_empty() {
                status = match launcher::status(&binary, &dir) {
                    Ok(status) => status,
                    Err(why) => return self.no_status(why),
                };
                self.seen(&status);
            }
        }
        let wanted: Vec<String> = status.capabilities.iter().filter(|c| c.available && kinds.on(&c.id)).map(|c| c.id.clone()).collect();
        if status.capabilities.iter().any(|c| c.available) && wanted.is_empty() {
            self.not_before = Instant::now() + LOOK_AGAIN;
            return self.set(Code::KindsStopped, Extra::default());
        }
        let mut token = None;
        if !ours || !kept.as_ref().is_some_and(|k| k.registered) || status.unregistered() {
            match self.token.take() {
                Some((for_workspace, given)) if for_workspace == workspace => token = Some(given),
                _ => return self.want(&workspace),
            }
            SandboxRegistration { server: server.to_string(), workspace: workspace.clone(), registered: false }.save(&app);
        }
        self.hold_workspace(&workspace);
        let generation = self.generation + 1;
        self.generation = generation;
        self.run = Some(Run::new(generation, Engine::Launcher, Backend::Sandboxed, workspace.clone(), Process::Sandbox(None), token.is_some()));
        // A new release's image first, then the sandbox starts again.
        let step = if self.image_pending && status.linux().state != State::Absent { Step::Update } else { Step::Up };
        self.image_pending = false;
        let name = backend::machine_name();
        let url = server.as_str().trim_end_matches('/').to_owned();
        let up = launcher::Up { url: &url, name: &name, labels: "desktop", token: token.as_deref(), only: wanted.iter().map(String::as_str).collect() };
        let (args, starting) = match step {
            Step::Update => (launcher::update_args(&dir), vec![]),
            _ => (launcher::up_args(&dir, &up), wanted.clone()),
        };
        if let Err(why) = self.spawn_step(step, args, up.token) {
            self.run = None;
            return self.not_started(workspace, token, why);
        }
        self.now_starting(starting);
        self.set(Code::Starting, detail(STARTING_SANDBOX));
    }

    /// Says which kinds of job a launcher command is starting now.
    fn now_starting(&self, kinds: Vec<String>) {
        let changed = {
            let shared = self.app.state::<Shared>();
            let mut now = shared.now.lock().unwrap();
            let changed = now.starting != kinds;
            now.starting = kinds;
            changed
        };
        if changed {
            publish(&self.app);
        }
    }

    /// Each kind of job as the person has it: one they stopped is stopped
    /// (`down --only`), one they started is started (`up --only`), and one
    /// that should run and doesn't while another runs is tried again in a
    /// while: every five minutes while the release has no sandbox images.
    /// One launcher command at a time, each leaving the others as they are.
    fn kinds(&mut self, workspace: Option<&str>) {
        if !self.run.as_ref().is_some_and(|run| run.engine == Engine::Launcher) {
            return;
        }
        let Some(status) = self.app.state::<Shared>().now.lock().unwrap().sandbox.clone() else { return };
        if !status.per_kind() {
            return;
        }
        let on = config::settings(&self.app).runner_capabilities;
        for capability in &status.capabilities {
            if !on.on(&capability.id) && !capability.off() {
                return self.kind_step(Step::Stop(capability.id.clone()), None);
            }
            if on.on(&capability.id) && capability.off() && capability.available {
                return self.start_kind(capability, workspace);
            }
        }
        // Nothing runs: the sandbox as a whole starts again (sandbox_stopped).
        if !status.running() {
            self.retry.clear();
            return;
        }
        let now = Instant::now();
        for capability in &status.capabilities {
            let id = capability.id.as_str();
            let wanting = on.on(id) && !capability.off() && capability.available && matches!(capability.state, State::Error | State::Stopped | State::Absent);
            if !wanting {
                self.retry.retain(|(kind, _, _)| kind != id);
                continue;
            }
            let images = id == "linux" && status.trouble().is_some_and(|(cause, _)| launcher::why(&cause) == launcher::Why::NoImages);
            match self.retry.iter().position(|(kind, _, _)| kind == id) {
                // Just seen not running: tried again in a while.
                None => self.retry.push((id.to_owned(), now + again(images, 1), 1)),
                Some(at) if now >= self.retry[at].1 => {
                    let tries = self.retry[at].2 + 1;
                    self.retry[at] = (id.to_owned(), now + again(images, tries), tries);
                    self.write_log(&format!("g1t: trying {} again.", diagnosis::kind_label(id)));
                    return self.start_kind(capability, workspace);
                }
                Some(_) => {}
            }
        }
    }

    /// Starts one kind of job; one never registered needs a token from the
    /// site first, which is asked for, and it starts once it is here.
    fn start_kind(&mut self, capability: &launcher::Capability, workspace: Option<&str>) {
        let mut token = None;
        if capability.state == State::Absent {
            let Some(workspace) = workspace else { return };
            match self.token.take() {
                Some((for_workspace, given)) if for_workspace == workspace => token = Some(given),
                other => {
                    self.token = other;
                    if wanted(&self.app).is_none() {
                        *self.app.state::<Shared>().wanted.lock().unwrap() = Some(workspace.to_owned());
                        let _ = self.app.emit_to(EventTarget::webview(frame::SITE), WANTED_EVENT, workspace.to_owned());
                    }
                    return;
                }
            }
        }
        self.kind_step(Step::Start(capability.id.clone()), token);
    }

    /// `up --only` or `down --only` one kind of job, while the rest run on.
    fn kind_step(&mut self, step: Step, token: Option<String>) {
        let dir = native_dir(&self.app, Backend::Sandboxed);
        let (args, starting, said) = match &step {
            Step::Start(kind) => {
                let url = config::server(&self.app).as_str().trim_end_matches('/').to_owned();
                let name = backend::machine_name();
                let up = launcher::Up { url: &url, name: &name, labels: "desktop", token: token.as_deref(), only: vec![kind.as_str()] };
                (launcher::up_args(&dir, &up), vec![kind.clone()], format!("starting {}", diagnosis::kind_label(kind)))
            }
            Step::Stop(kind) => (launcher::down_only_args(&dir, kind), vec![], format!("stopping {}", diagnosis::kind_label(kind))),
            Step::Up | Step::Update => return,
        };
        self.write_log(&format!("g1t: {said}."));
        match self.spawn_step(step, args, token.as_deref()) {
            Ok(()) => self.now_starting(starting),
            Err(why) => self.write_log(&format!("g1t: {why}")),
        }
    }

    /// `sandbox status` didn't answer: a `g1t-runner` from before its
    /// launcher, which a newer release replaces, or one that failed.
    fn no_status(&mut self, why: String) {
        self.write_log(&format!("g1t: the sandbox's status: {why}"));
        self.failures += 1;
        if why.contains("older than its sandbox launcher") {
            let server = config::server(&self.app);
            if let Ok(Some((version, bytes))) = self.newer_release(&server)
                && native::put(&folder(&self.app), &bytes, &version).is_ok()
            {
                self.note(None, Some(version));
                self.not_before = Instant::now();
                return;
            }
            self.not_before = Instant::now() + MOST_BACKOFF;
            return self.set(Code::NoLauncher, detail(why));
        }
        self.not_before = Instant::now() + LOOK_AGAIN;
        self.set(Code::SandboxFailed, Extra { detail: Some(why), wait_seconds: Some(LOOK_AGAIN.as_secs()), ..Extra::default() });
    }

    /// Runs a launcher command for the sandbox's run, reading its output.
    fn spawn_step(&mut self, step: Step, args: Vec<std::ffi::OsString>, token: Option<&str>) -> Result<(), String> {
        let binary = native::binary(&folder(&self.app));
        let mut command = launcher::command(&binary, args);
        launcher::with_token(&mut command, token);
        let mut child = command.spawn().map_err(|e| format!("g1t-runner sandbox {} could not start: {e}", step.name()))?;
        let _ = std::fs::write(folder(&self.app).join("pid"), child.id().to_string());
        let Some(generation) = self.run.as_ref().map(|run| run.generation) else {
            native::stop(&mut child);
            return Ok(());
        };
        self.follow(generation, &mut child);
        let run = self.run.as_mut().expect("checked above");
        run.json = None;
        run.process = Process::Sandbox(Some((step, child)));
        Ok(())
    }

    /// `update` on the running sandbox, while it has no job.
    fn sandbox_step(&mut self, step: Step) {
        if self.run.as_ref().is_none_or(|run| run.step().is_some()) {
            return;
        }
        let dir = native_dir(&self.app, Backend::Sandboxed);
        if let Err(why) = self.spawn_step(step, launcher::update_args(&dir), None) {
            self.write_log(&format!("g1t: {why}"));
        }
    }

    /// Asks the sandbox how it is, every few seconds, on a thread of its own.
    fn poll(&mut self) {
        let Some(run) = self.run.as_mut().filter(|run| run.engine == Engine::Launcher) else { return };
        if run.polling || run.polled_at.is_some_and(|at| at.elapsed() < launcher::STATUS_EVERY) {
            return;
        }
        run.polling = true;
        run.polled_at = Some(Instant::now());
        let (tx, generation) = (self.tx.clone(), run.generation);
        let binary = native::binary(&folder(&self.app));
        let dir = native_dir(&self.app, Backend::Sandboxed);
        let spawned = std::thread::Builder::new().name("g1t-sandbox-status".into()).spawn(move || {
            let _ = tx.send(Ask::Sandbox(generation, launcher::status(&binary, &dir).map(Box::new)));
        });
        if spawned.is_err() {
            run.polling = false;
        }
    }

    /// What a poll said.
    fn polled(&mut self, generation: u64, status: Result<Box<Status>, String>) {
        let Some(run) = self.run.as_mut().filter(|run| run.generation == generation) else { return };
        run.polling = false;
        if std::mem::take(&mut run.stale) {
            return;
        }
        match status {
            Ok(status) => self.sandbox_now(*status),
            // Once is nothing: the next poll asks again.
            Err(why) => self.write_log(&format!("g1t: the sandbox's status: {why}")),
        }
    }

    /// Keeps what a status says for the tray, settings and the site.
    fn seen(&mut self, status: &Status) {
        let shared = self.app.state::<Shared>();
        let mut now = shared.now.lock().unwrap();
        now.sandbox = Some(status.clone());
        if let Some(version) = status.version() {
            now.version = Some(version);
        }
        now.job = status.job().map(launcher::Job::said);
    }

    /// The sandbox as it is now, while it is the run.
    fn sandbox_now(&mut self, status: Status) {
        let had = self.app.state::<Shared>().now.lock().unwrap().job.clone();
        let Some(run) = self.run.as_mut() else { return };
        let step = run.step();
        let job = status.job().map(launcher::Job::said);
        let was = had.filter(|_| run.busy);
        run.busy = job.is_some();
        run.listening = status.running();
        let update_failed = self.update_failed.clone();
        if was != job {
            if let Some(ended) = &was {
                self.write_log(&format!("g1t: {ended} ended."));
            }
            if let Some(took) = &job {
                self.write_log(&format!("g1t: Took {took}."));
            }
        }
        self.seen(&status);
        match &step {
            Some(Step::Up) => return self.set(Code::Starting, detail(STARTING_SANDBOX)),
            Some(Step::Update) if status.state == State::Updating => return self.set(Code::Updating, detail("Updating the sandbox to the newest image.")),
            _ => {}
        }
        let (code, extra) = shown(&status);
        // Every kind of job stopped by the person: nothing to start again.
        if step.is_none() && status.all_off() && !status.running() {
            self.run = None;
            self.generation += 1;
            self.retry.clear();
            self.not_before = Instant::now() + LOOK_AGAIN;
            return self.set(Code::KindsStopped, Extra::default());
        }
        if step.is_none() && !status.running() && !matches!(status.state, State::Starting | State::Updating) {
            return self.sandbox_stopped(&status, code, extra);
        }
        match (code, update_failed) {
            (Code::Idle, Some(why)) => self.set(Code::UpdateFailed, detail(why)),
            (code, _) => self.set(code, extra),
        }
    }

    /// The sandbox stopped by itself, or never got going: started again,
    /// waiting longer each time, or registered again when that is why.
    fn sandbox_stopped(&mut self, status: &Status, code: Code, extra: Extra) {
        let error = status.error.clone().or_else(|| extra.detail.clone()).unwrap_or_default();
        if self.registration_trouble(&error) {
            return;
        }
        self.run = None;
        self.generation += 1;
        self.failures += 1;
        // A release without the sandbox's images is looked at again every few minutes.
        let wait = if code == Code::WaitingForImage { launcher::IMAGES_AGAIN } else { again(false, self.failures) };
        self.not_before = Instant::now() + wait;
        let (code, extra) = match code {
            Code::Idle | Code::Busy | Code::Starting | Code::Updating => (Code::SandboxFailed, Extra { detail: status.error.clone().or_else(|| some_text("The sandbox stopped by itself.")), ..Extra::default() }),
            code => (code, extra),
        };
        self.set(code, Extra { wait_seconds: Some(wait.as_secs()), ..extra });
    }

    /// When the sandbox's trouble is its registration: true when the app
    /// has seen to it, and the next start registers again.
    fn registration_trouble(&mut self, error: &str) -> bool {
        match launcher::why(error) {
            launcher::Why::TokenRefused | launcher::Why::Unregistered => {
                if let Some(mut kept) = SandboxRegistration::load(&self.app) {
                    kept.registered = false;
                    kept.save(&self.app);
                }
                self.halt();
                self.not_before = Instant::now();
                true
            }
            launcher::Why::Forgotten => {
                self.halt();
                self.forget_sandbox();
                self.not_before = Instant::now();
                true
            }
            _ => false,
        }
    }

    /// A launcher command ended: what it printed last is the sandbox's status.
    fn launched(&mut self, generation: u64) {
        let Some(run) = self.run.as_mut().filter(|run| run.generation == generation) else { return };
        let Process::Sandbox(slot) = &mut run.process else { return };
        let Some((step, mut child)) = slot.take() else { return };
        let worked = child.wait().is_ok_and(|status| status.success());
        let _ = std::fs::remove_file(folder(&self.app).join("pid"));
        let printed = run.json.take().unwrap_or_default().join("\n");
        run.stale = run.polling;
        let with_token = run.with_token;
        let status = launcher::parse(&printed);
        {
            let shared = self.app.state::<Shared>();
            let mut now = shared.now.lock().unwrap();
            now.starting.clear();
            now.download = None;
        }
        let error = match (&status, worked) {
            (Ok(status), true) => status.error.clone().filter(|_| !status.running()),
            (Ok(status), false) => Some(status.error.clone().unwrap_or_else(|| format!("g1t-runner sandbox {} failed.", step.name()))),
            (Err(why), _) => Some(why.clone()),
        };
        let status = status.ok();
        let running = status.as_ref().is_some_and(Status::running);
        if let Some(error) = &error {
            self.write_log(&format!("g1t: sandbox {}: {error}", step.name()));
        }
        // One kind of job started or stopped: how the sandbox is now says
        // the rest, and one that didn't start is tried again in a while.
        if matches!(step, Step::Start(_) | Step::Stop(_)) {
            if let Some(status) = status {
                self.sandbox_now(status);
            }
            return;
        }
        // Registered: from now on it starts with no token.
        if step == Step::Up && with_token && (error.is_none() || running) {
            let app = self.app.clone();
            if let Some(run) = self.run.as_mut() {
                run.with_token = false;
                let registration = Registration { server: config::server(&app).to_string(), workspace: run.workspace.clone(), backend: Backend::Sandboxed };
                SandboxRegistration { server: registration.server.clone(), workspace: registration.workspace.clone(), registered: true }.save(&app);
                registration.save(&app);
            }
        }
        if let Some(error) = error.clone() {
            if self.registration_trouble(&error) {
                return;
            }
            if step == Step::Update {
                self.update_failed = Some(format!("The sandbox's image couldn't be updated: {error}"));
            } else if !running {
                // Nothing runs: tidied away, and tried again in a while;
                // a release without the sandbox's images every few minutes.
                self.halt();
                self.failures += 1;
                let (code, cause, fix) = status
                    .as_ref()
                    .and_then(diagnosis::sandbox_trouble)
                    .unwrap_or_else(|| (diagnosis::sandbox_code(launcher::why(&error)), error.clone(), None));
                let wait = if code == Code::WaitingForImage { launcher::IMAGES_AGAIN } else { again(false, self.failures) };
                self.not_before = Instant::now() + wait;
                // The cards say why from what `up` said, not from the stopped sandbox.
                if let Some(failed) = status {
                    self.app.state::<Shared>().now.lock().unwrap().sandbox = Some(failed);
                }
                return self.set(code, Extra { detail: Some(cause), fix, wait_seconds: Some(wait.as_secs()), ..Extra::default() });
            }
        } else if step == Step::Up {
            self.failures = 0;
        } else {
            self.update_failed = None;
        }
        if step == Step::Update && !running {
            // Updated while stopped: it starts again with the new image.
            self.run = None;
            self.generation += 1;
            self.not_before = Instant::now();
            return;
        }
        if let Some(status) = status {
            self.sandbox_now(status);
        }
    }
}

/// What the tray says while the sandbox starts.
const STARTING_SANDBOX: &str = "Starting the sandbox. The first time, it downloads and checks the sandbox's image, which takes a few minutes.";

fn some_text(text: &str) -> Option<String> {
    Some(text.to_owned())
}

/// How long before trying again, the `tries`th time: every few minutes
/// while the release has no sandbox images, else longer each time.
fn again(images: bool, tries: u32) -> Duration {
    if images { launcher::IMAGES_AGAIN } else { Duration::from_secs(15 * 2u64.pow(tries.min(6))).min(MOST_BACKOFF) }
}

/// What the app shows for how the sandbox is, with no launcher command
/// running: what its runners do while one runs (each kind of job's card
/// says the rest), else what is wrong with Linux jobs.
fn shown(status: &Status) -> (Code, Extra) {
    if status.job().is_some() {
        return (Code::Busy, Extra::default());
    }
    if status.running() {
        return (Code::Idle, Extra::default());
    }
    if let Some((code, cause, fix)) = diagnosis::sandbox_trouble(status) {
        return (code, Extra { detail: Some(cause), fix, ..Extra::default() });
    }
    match status.linux().state {
        State::Starting => (Code::Starting, detail(STARTING_SANDBOX)),
        State::Updating => (Code::Updating, detail("Updating the sandbox to the newest image.")),
        _ if status.all_off() => (Code::KindsStopped, Extra::default()),
        _ => (Code::SandboxFailed, detail("The sandbox isn't running.")),
    }
}

/// What `register-and-run` reads: where g1t is, the runner's name and
/// labels, and the token, the first time only. The app updates the runner,
/// so the runner does not update itself; registering again takes the
/// place of this computer's earlier runner of the same name.
fn environment(server: &Url, backend: Backend, token: Option<&str>) -> Vec<(&'static str, String)> {
    let mut envs = vec![
        ("G1T_RUNNER_URL", server.as_str().trim_end_matches('/').to_owned()),
        ("G1T_RUNNER_NAME", backend::machine_name()),
        ("G1T_RUNNER_LABELS", "desktop".to_owned()),
        ("G1T_RUNNER_REPLACE", "1".to_owned()),
        ("G1T_RUNNER_NO_AUTO_UPDATE", "1".to_owned()),
    ];
    if backend == Backend::Host {
        envs.push(("G1T_RUNNER_NO_DOCKER", "1".to_owned()));
    }
    if let Some(token) = token {
        envs.push(("G1T_RUNNER_TOKEN", token.to_owned()));
    }
    envs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view(code: Code, job: Option<&str>) -> View {
        let facts = Facts { workspace: Some("acme".into()), backend: "sandboxed", machine: "box".into(), job: job.map(str::to_owned), ..Facts::default() };
        View {
            diagnosis: diagnosis::diagnose(code, &facts),
            closed: diagnosis::closed(&facts),
            running: code == Code::Idle,
            version: None,
            backend: Backend::Sandboxed,
            workspace: Some("acme".into()),
            workspaces: vec![],
            enabled: true,
            paused: false,
            link: None,
            machine: "box".into(),
            platform: "windows".into(),
            log: vec![],
        }
    }

    #[test]
    fn the_tray_says_what_the_runner_is_doing() {
        assert_eq!(headline(&view(Code::Idle, None)), "Runner: Waiting for jobs");
        assert_eq!(headline(&view(Code::Busy, Some("Build (acme/web)"))), "Runner: Running Build (acme/web)");
        assert_eq!(headline(&view(Code::NoDocker, None)), "Runner: Not running: Docker isn't running");
        assert_eq!(headline(&view(Code::Busy, Some(&"x".repeat(200)))).chars().count(), 60);
    }

    #[test]
    fn the_runner_is_told_where_and_who_and_the_token_only_once() {
        let server = Url::parse("https://g1t.sh/").unwrap();
        let envs = environment(&server, Backend::Host, Some("g1trt_abc"));
        let get = |name: &str| envs.iter().find(|(n, _)| *n == name).map(|(_, v)| v.as_str());
        assert_eq!(get("G1T_RUNNER_URL"), Some("https://g1t.sh"));
        assert_eq!(get("G1T_RUNNER_LABELS"), Some("desktop"));
        assert_eq!(get("G1T_RUNNER_NO_DOCKER"), Some("1"));
        assert_eq!(get("G1T_RUNNER_NO_AUTO_UPDATE"), Some("1"));
        assert_eq!(get("G1T_RUNNER_TOKEN"), Some("g1trt_abc"));
        let again = environment(&server, Backend::Docker, None);
        assert!(!again.iter().any(|(name, _)| *name == "G1T_RUNNER_TOKEN" || *name == "G1T_RUNNER_NO_DOCKER"));
    }

    fn status(json: &str) -> Status {
        launcher::parse(json).unwrap()
    }

    #[test]
    fn the_sandbox_shows_what_its_runners_do_and_linux_trouble_first() {
        let running = status(r#"{"schema":1,"state":"running","capabilities":[{"id":"linux","available":true,"state":"running"},{"id":"windows","available":false,"state":"absent","cause":"Windows Sandbox is not turned on, or this edition of Windows has none (Home does not)."}]}"#);
        assert_eq!(shown(&running).0, Code::Idle);
        let busy = status(r#"{"schema":1,"state":"running","job":{"kind":"workflow","id":"j","name":"build","repo":"acme/web"}}"#);
        assert_eq!(shown(&busy).0, Code::Busy);
        let starting = status(r#"{"schema":1,"state":"starting","capabilities":[{"id":"linux","available":true,"state":"starting"}]}"#);
        assert_eq!(shown(&starting).0, Code::Starting);
        let updating = status(r#"{"schema":1,"state":"updating","capabilities":[{"id":"linux","available":true,"state":"updating"}]}"#);
        assert_eq!(shown(&updating).0, Code::Updating);
        // Windows jobs run while WSL is missing: the runner waits for jobs,
        // and the Linux card says what is wrong (diagnosis.rs).
        let no_wsl = status(r#"{"schema":1,"state":"error","error":"WSL is not installed, and the sandbox for Linux jobs is a WSL distribution of its own.","capabilities":[
            {"id":"linux","available":false,"state":"error","cause":"WSL is not installed, and the sandbox for Linux jobs is a WSL distribution of its own.","fix":"Open a terminal as administrator and run `wsl --install --no-distribution`."},
            {"id":"windows","available":true,"state":"running"}]}"#);
        assert_eq!(shown(&no_wsl).0, Code::Idle);
        let (code, extra) = shown(&status(r#"{"schema":1,"state":"error","error":"WSL is not installed, and the sandbox for Linux jobs is a WSL distribution of its own.","capabilities":[
            {"id":"linux","available":false,"state":"error","cause":"WSL is not installed, and the sandbox for Linux jobs is a WSL distribution of its own."},
            {"id":"windows","available":false,"state":"absent"}]}"#));
        assert_eq!(code, Code::NoWsl);
        assert!(extra.detail.unwrap().starts_with("WSL is not installed"));
        // 0.3.0 without its images, on Home: waiting for them, not failing.
        let images = status(r#"{"schema":1,"state":"error","error":"release 0.3.0 has no sandbox images","capabilities":[{"id":"linux","available":true,"state":"error","turned_off":false},{"id":"windows","available":false,"state":"absent","turned_off":false}]}"#);
        assert_eq!(shown(&images).0, Code::WaitingForImage);
        assert_eq!(again(true, 5), launcher::IMAGES_AGAIN);
        assert_eq!(again(false, 1), Duration::from_secs(30));
        assert_eq!(again(false, 9), MOST_BACKOFF);
        // Every kind of job stopped by the person.
        let off = status(r#"{"schema":1,"state":"stopped","capabilities":[{"id":"linux","available":true,"state":"stopped","turned_off":true},{"id":"windows","available":true,"state":"stopped","turned_off":true}]}"#);
        assert_eq!(shown(&off).0, Code::KindsStopped);
        let failed = status(r#"{"schema":1,"state":"error","error":"the sandbox did not start within 180 seconds","capabilities":[{"id":"linux","available":true,"state":"error"}]}"#);
        let (code, extra) = shown(&failed);
        assert_eq!((code, extra.detail.as_deref()), (Code::SandboxFailed, Some("the sandbox did not start within 180 seconds")));
        let stopped = status(r#"{"schema":1,"state":"stopped","capabilities":[{"id":"linux","available":true,"state":"stopped"},{"id":"windows","available":true,"state":"stopped"}]}"#);
        assert_eq!(shown(&stopped).0, Code::SandboxFailed);
    }

    #[test]
    fn the_site_names_workspaces_in_its_own_words() {
        let offered: Vec<Offered> = serde_json::from_str(r#"[{"slug":"acme","name":"Acme"},{"slug":"solo"}]"#).unwrap();
        assert_eq!(offered[1], Offered { slug: "solo".into(), name: None });
    }
}
