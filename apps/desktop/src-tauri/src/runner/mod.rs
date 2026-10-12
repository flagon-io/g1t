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
//!   ever chosen by the person, and nothing falls back to them.
//! - **Registering.** The first time, and when the workspace or backend
//!   changes, the app needs a registration token for the workspace. Only
//!   the site can make one, for an owner who is signed in: the app asks
//!   the site's page (`g1t-runner-wanted`), the page asks the server
//!   (`POST /-/desktop/runner-token`) and hands the token to the app
//!   (`runner_register` in bridge.rs), which gives it to `g1t-runner` in
//!   its environment, once. It is never shown or written to the log. The
//!   registration is kept (registration.json, and the runner's own folder
//!   or volume) and used on every later start.
//! - **Up to date.** Soon after it starts and every six hours, while the
//!   runner is idle, the app looks for a newer release, or a newer image,
//!   and puts it in place: never in the middle of a job.
//! - **Seen.** What it is doing, and when it is not running why and how to
//!   fix it (diagnosis.rs), is in the tray, in settings, and on the site's
//!   Runners page (`g1t-runner-status`), read from what its log says
//!   (log.rs). The whole log is kept in `runner/runner.log`.
//!
//! All of it runs on a thread of its own, which owns the runner's process
//! and is told what happened through one channel.

mod backend;
mod container;
pub mod diagnosis;
mod launcher;
mod log;
mod native;

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::Child;
use std::sync::Mutex;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, EventTarget, Manager};
use url::Url;

pub use backend::Backend;
use backend::{Engine, Missing};
use diagnosis::{Code, Diagnosis, Facts};

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
    Retry,
    Token { workspace: String, token: String },
    Refused { workspace: String, allowed: bool, why: String },
    Line(u64, String),
    Exited(u64),
    Quit(Sender<()>),
}

/// The registration the app made, besides what the runner keeps itself.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct Registration {
    server: String,
    workspace: String,
    backend: Backend,
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

fn facts(app: &AppHandle, now: &Now) -> Facts {
    let server = config::server(app);
    Facts {
        workspace: workspace(app),
        backend: config::settings(app).runner_backend.label(),
        machine: backend::machine_name(),
        job: now.job.clone(),
        detail: now.detail.clone(),
        exit_code: now.exit_code,
        wait_seconds: now.wait_seconds,
        server: server.host_str().unwrap_or("g1t").to_owned(),
        platform: std::env::consts::OS.into(),
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
        running: matches!(now.code, Code::Idle | Code::Busy | Code::Offline),
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
/// from the site's card for this computer.
pub fn act(app: &AppHandle, action: &str) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let browse = |url: &str| app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string());
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
        "get_docker" => browse("https://docs.docker.com/get-started/get-docker/")?,
        "install_sysbox" => browse("https://github.com/nestybox/sysbox#installation")?,
        "learn_more" => browse("https://docs.g1t.sh/guides/desktop/#the-runner")?,
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
    /// `g1t-runner` or its sandbox launcher, a child of the app.
    Child(Child),
    /// The runner's container, and `docker logs --follow` on it.
    Container(Child),
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
}

/// What a set of the state carries besides its code.
#[derive(Default)]
struct Extra {
    detail: Option<String>,
    exit_code: Option<i32>,
    wait_seconds: Option<u64>,
}

fn detail(text: impl Into<String>) -> Extra {
    Extra { detail: Some(text.into()), ..Extra::default() }
}

impl Keeper {
    fn new(app: AppHandle, tx: Sender<Ask>) -> Keeper {
        let now = Instant::now();
        Keeper { app, tx, run: None, generation: 0, token: None, not_before: now + AFTER_START, failures: 0, next_update: now + FIRST_UPDATE, log: None }
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
            let next = Now { code, detail: extra.detail, exit_code: extra.exit_code, wait_seconds: extra.wait_seconds, job, version: now.version.clone() };
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
            Ask::Retry => {
                self.not_before = Instant::now();
                self.failures = 0;
                if self.run.as_ref().is_some_and(|run| !run.listening || matches!(self.code(), Code::UpdateFailed | Code::Offline)) {
                    self.halt();
                }
                if self.code() == Code::UpdateFailed {
                    self.next_update = Instant::now();
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
            Ask::Line(generation, line) => self.line(generation, &line),
            Ask::Exited(generation) => self.exited(generation),
        }
    }

    fn line(&mut self, generation: u64, line: &str) {
        let Some(run) = self.run.as_mut().filter(|run| run.generation == generation) else { return };
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
        // A container started with a token keeps it in its configuration:
        // it is replaced at once by one without, which needs no token.
        let replace = registered.is_some() && run.with_token && matches!(run.process, Process::Container(_));
        self.write_log(line);
        if let Some(registration) = registered {
            registration.save(&self.app);
            self.failures = 0;
        }
        self.note(job, version);
        if let Some(code) = became {
            self.set(code, Extra::default());
        }
        if replace {
            self.halt();
            self.not_before = Instant::now();
        }
    }

    fn exited(&mut self, generation: u64) {
        if self.run.as_ref().is_none_or(|run| run.generation != generation) {
            return;
        }
        let mut run = self.run.take().expect("checked above");
        let exit_code = match &mut run.process {
            Process::Child(child) => child.wait().ok().and_then(|status| status.code()),
            Process::Container(_) => container::exit_code(),
        };
        self.stop(&mut run);
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
            self.set(Code::Crashed, Extra { detail: run.error, exit_code, wait_seconds: Some(wait.as_secs()) });
        }
    }

    /// Stops a run's process, the way it was started.
    fn stop(&self, run: &mut Run) {
        match (&mut run.process, run.engine) {
            (Process::Container(logs), _) => container::stop(Some(logs)),
            (Process::Child(child), Engine::Launcher) => {
                launcher::down(&native::binary(&folder(&self.app)), &native_dir(&self.app, run.backend));
                native::stop(child);
            }
            (Process::Child(child), _) => native::stop(child),
        }
        let _ = std::fs::remove_file(folder(&self.app).join("pid"));
    }

    /// Stops whatever runs now.
    fn halt(&mut self) {
        self.generation += 1;
        if let Some(mut run) = self.run.take() {
            self.stop(&mut run);
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
            Backend::Sandboxed if launcher::READY => {
                launcher::down(&binary, &native_dir(&app, Backend::Sandboxed));
                let _ = std::fs::remove_dir_all(native_dir(&app, Backend::Sandboxed));
            }
            Backend::Sandboxed => {
                if backend::docker_ready() {
                    container::forget();
                }
            }
            backend => native::forget(&binary, &native_dir(&app, backend)),
        }
        Registration::clear(&app);
    }

    /// Whether what the runner keeps of a registration is still here.
    fn kept(&self, engine: Engine, backend: Backend) -> bool {
        match engine {
            Engine::Sysbox => container::registered(),
            Engine::Launcher => native_dir(&self.app, backend).exists(),
            Engine::Native { .. } => native_dir(&self.app, backend).join("config.json").exists(),
        }
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
            let (busy, listening) = (run.busy, run.listening);
            if back {
                if let Some(run) = self.run.as_mut() {
                    run.offline_at = None;
                }
                self.set(Code::Idle, Extra::default());
            }
            // A change of backend or workspace waits for the job to end, as an update does.
            if moved && !busy {
                self.halt();
                self.not_before = Instant::now();
            } else if !busy && listening && Instant::now() >= self.next_update {
                self.update();
            }
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
                    Missing::Sandbox => Code::NoSandbox,
                    Missing::Sysbox => Code::NoSysbox,
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
        let server = config::server(&app);
        let registration = Registration::load(&app);
        let ours = registration.as_ref().is_some_and(|r| r.server == server.as_str() && r.workspace == workspace && r.backend == backend) && self.kept(engine, backend);
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
        // The setting names the workspace from now on, so browsing another one never moves the runner.
        if config::settings(&app).runner_workspace.as_deref() != Some(workspace.as_str()) {
            let mut settings = config::settings(&app);
            settings.runner_workspace = Some(workspace.clone());
            let _ = config::set_settings(&app, settings);
        }
        self.set(Code::Starting, Extra::default());
        let envs = environment(&server, backend, token.as_deref());
        let generation = self.generation + 1;
        self.generation = generation;
        let started = match engine {
            Engine::Sysbox => {
                if !container::have_image() {
                    self.set(Code::Updating, detail("Downloading the runner's image."));
                    container::pull();
                }
                container::start(&envs).map(Process::Container)
            }
            Engine::Launcher | Engine::Native { .. } => self.ensure_binary(&server).and_then(|binary| {
                let dir = native_dir(&app, backend);
                let child = if engine == Engine::Launcher {
                    let mut command = launcher::up(&binary, &dir);
                    command.envs(envs.iter().map(|(name, value)| (*name, value.as_str())));
                    command.spawn()
                } else {
                    native::spawn(&binary, &dir, &envs)
                };
                let child = child.map_err(|e| format!("g1t-runner could not start: {e}"))?;
                let _ = std::fs::write(folder(&app).join("pid"), child.id().to_string());
                Ok(Process::Child(child))
            }),
        };
        match started {
            Ok(mut process) => {
                let child = match &mut process {
                    Process::Child(child) | Process::Container(child) => child,
                };
                self.follow(generation, child);
                self.run = Some(Run {
                    generation,
                    engine,
                    backend,
                    workspace,
                    process,
                    listening: false,
                    busy: false,
                    offline_at: None,
                    with_token: token.is_some(),
                    forgotten: false,
                    token_refused: false,
                    error: None,
                });
                self.set(Code::Starting, Extra::default());
            }
            Err(why) => {
                // The token is kept for the next try, while it lasts.
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
        }
    }

    /// Reads the child's output, a line at a time, onto the thread's channel.
    fn follow(&self, generation: u64, child: &mut Child) {
        fn pipe(tx: Sender<Ask>, generation: u64, from: impl Read + Send + 'static, last: bool) {
            std::thread::spawn(move || {
                for line in BufReader::new(from).lines().map_while(Result::ok) {
                    if tx.send(Ask::Line(generation, line)).is_err() {
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
        match engine {
            Engine::Sysbox => {
                if container::pull() || container::outdated() {
                    self.set(Code::Updating, detail("Starting the newest runner image."));
                    self.halt();
                    self.not_before = Instant::now();
                }
            }
            Engine::Launcher | Engine::Native { .. } => {
                let server = config::server(&self.app);
                let folder = folder(&self.app);
                let Ok(manifest) = native::latest(&server) else { return };
                if !native::installed(&folder).is_none_or(|have| native::newer(&manifest.version, &have)) {
                    return;
                }
                let bytes = match native::download(&server, &manifest) {
                    Ok(bytes) => bytes,
                    Err(why) => {
                        let why = format!("g1t-runner {} couldn't be installed: {why}", manifest.version);
                        self.write_log(&format!("g1t: {why}"));
                        return self.set(Code::UpdateFailed, detail(why));
                    }
                };
                self.set(Code::Updating, detail(format!("Updating g1t-runner to {}.", manifest.version)));
                self.halt();
                match native::put(&folder, &bytes, &manifest.version) {
                    Ok(()) if engine == Engine::Launcher => {
                        let backend = config::settings(&self.app).runner_backend;
                        launcher::update(&native::binary(&folder), &native_dir(&self.app, backend));
                    }
                    Ok(()) => {}
                    Err(why) => self.write_log(&format!("g1t: g1t-runner {} couldn't be put in place: {why}", manifest.version)),
                }
                self.not_before = Instant::now();
            }
        }
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

    #[test]
    fn the_site_names_workspaces_in_its_own_words() {
        let offered: Vec<Offered> = serde_json::from_str(r#"[{"slug":"acme","name":"Acme"},{"slug":"solo"}]"#).unwrap();
        assert_eq!(offered[1], Offered { slug: "solo".into(), name: None });
    }
}
