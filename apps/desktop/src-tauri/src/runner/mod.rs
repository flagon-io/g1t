//! The runner in the app: g1t's self-hosted runner, started for the
//! signed-in person when g1t opens and stopped when it quits, so their
//! computer runs their workspace's `runs-on: self-hosted` jobs with
//! nothing to install, register or start by hand
//! (docs.g1t.sh/guides/desktop/#the-runner).
//!
//! - **When.** On by default; settings turn it off ("Run jobs on this
//!   computer while g1t is open"), and Stop in settings or the tray stops
//!   it until Start, or until g1t starts again. It starts once the site's
//!   page has loaded (or 20 s have passed) and 5 s more, never before, on a
//!   thread of its own that a panic restarts rather than ending the app.
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
//! - **Up to date.** Soon after it starts and every hour, and when the
//!   person asks ("Check for runner updates"), the app looks for a newer
//!   release on a thread of its own: its manifest only when g1t's release
//!   key signed it (native.rs), its program only when its SHA-256 is the
//!   manifest's. What it finds waits, downloaded, until each kind of job
//!   is idle, and goes in kind by kind, never in the middle of a job: the
//!   sandbox's Linux jobs take its image (`sandbox update`, which drains
//!   them itself) once they have no job; its Windows jobs, whose runner is
//!   the program itself, are drained (`down --only windows --drain`), the
//!   program is replaced, and they start again; a runner in Docker or on
//!   this computer is stopped between jobs and started on the new one.
//!   "Download updates by themselves" off, it looks only when asked.
//! - **Seen.** What it is doing, and when it is not running why and how to
//!   fix it (diagnosis.rs), is in the title bar's chip, the Runner window
//!   (launcher/runner.html), the tray, a line in settings, and on the
//!   site's Runners page (`g1t-runner-status`), read from what its log says
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
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, EventTarget, Manager};
use url::Url;

pub use backend::Backend;
use backend::{Engine, Missing};
use diagnosis::{Code, Diagnosis, Facts};
use launcher::{Down, State, Status};
use native::Fault;

use crate::{config, frame, settings, tray};

/// What settings, the tray and the site listen for: the runner's status changed.
pub const STATUS_EVENT: &str = "g1t-runner-status";
/// What the site's page listens for: the app needs a registration token for a workspace.
pub const WANTED_EVENT: &str = "g1t-runner-wanted";

/// How long after the site's page has loaded the runner starts: the
/// window, the page and its first calls to the app come first.
const AFTER_START: Duration = Duration::from_secs(5);
/// The longest the runner waits for the site's page before starting
/// anyway (offline, the server picker, a site too old to say it loaded).
const SITE_WAIT: Duration = Duration::from_secs(20);
/// How long after the runner's thread failed it starts again.
const AFTER_PANIC: Duration = Duration::from_secs(15);

/// A lock that a failed runner thread can't take the app down with: a
/// panic while holding one leaves it poisoned, and `unwrap` on the main
/// thread would then end the app. The data is plain state, never half
/// written in a way that matters, so it is used as it is.
trait Held<T> {
    fn held(&self) -> MutexGuard<'_, T>;
}

impl<T> Held<T> for Mutex<T> {
    fn held(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(PoisonError::into_inner)
    }
}
/// How often the thread looks at the runner when nothing has happened.
const TICK: Duration = Duration::from_secs(5);
/// How long after starting the first look for an update is, then how often.
const FIRST_UPDATE: Duration = Duration::from_secs(90);
const UPDATE_EVERY: Duration = Duration::from_secs(60 * 60);
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

/// How the runner's updates stand, as the thread last said.
#[derive(Clone, Debug, Default, PartialEq)]
struct Updates {
    /// When the releases last answered.
    checked_at: Option<SystemTime>,
    checking: bool,
    /// A newer version, downloaded and checked, waiting.
    ready: Option<String>,
    /// Its program is still to be put in place.
    program: bool,
    /// The sandbox's image is still to take it.
    image: bool,
    /// The kinds of job taking it now.
    installing: Vec<String>,
}

/// What a look at the releases found.
struct Found {
    version: String,
    /// Newer than the program here.
    newer: bool,
    /// Its program, downloaded and checked: None when it isn't newer, or is
    /// already waiting.
    program: Option<Vec<u8>>,
    /// The release has the sandbox's images.
    images: bool,
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
    updates: Mutex<Updates>,
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
    /// In a few words, for the title bar's chip.
    pub chip: diagnosis::Chip,
}

/// What the thread is told.
enum Ask {
    /// Something changed: settings, Start or Stop, Retry.
    Look,
    /// A kind of job was started: start what should run now, stopping nothing.
    Soon,
    Retry,
    /// "Remove it and start again": the sandbox this computer has, removed
    /// with its registration, and the app's own made in its place.
    RemoveSandbox,
    /// "Check for runner updates": look now, and install what is found
    /// even with "Download updates by themselves" off.
    Check,
    /// What a look at the releases found.
    Checked(Result<Found, Fault>),
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

/// Where the runner keeps everything: its program, registrations, log and
/// the sandbox's VM. In the app's local data, which stays on this computer:
/// roaming data (Windows' %APPDATA%) is copied to a profile server on
/// networks with roaming profiles, and a VM's disk and a runner's
/// credential have no business there. A computer whose runner already
/// lives in roaming data keeps it there: its WSL distribution is
/// registered at that path, and moving its disk would break it. On macOS
/// and Linux the two are the same folder.
fn folder(app: &AppHandle) -> PathBuf {
    let fallback = || std::env::temp_dir().join("sh.g1t.desktop");
    let local = app.path().app_local_data_dir().unwrap_or_else(|_| fallback()).join("runner");
    let roaming = app.path().app_data_dir().unwrap_or_else(|_| fallback()).join("runner");
    chosen_folder(local, roaming)
}

/// The local folder, unless the runner was set up in the roaming one before.
fn chosen_folder(local: PathBuf, roaming: PathBuf) -> PathBuf {
    if !local.exists() && roaming.exists() { roaming } else { local }
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
    let site = app.state::<Shared>().site.held().clone();
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
        held: !settings.runner || *app.state::<Shared>().paused.held(),
        update: update_facts(app, now, backend),
    }
}

/// How the runner's updates stand, for the words: what is still to take a
/// waiting version. The sandbox's Windows jobs (any kind but Linux) take
/// its program while they run; a runner with no kinds of job takes it
/// itself.
fn update_facts(app: &AppHandle, now: &Now, backend: Backend) -> diagnosis::Update {
    let updates = app.state::<Shared>().updates.held().clone();
    let sandbox = now.sandbox.as_ref().filter(|_| backend == Backend::Sandboxed);
    let mut waiting = Vec::new();
    if updates.image {
        waiting.push("linux".to_owned());
    }
    if updates.program {
        match sandbox {
            Some(status) => waiting.extend(native_kinds(status).into_iter().map(|c| c.id.clone())),
            None => waiting.push("runner".to_owned()),
        }
    }
    diagnosis::Update {
        installed: native::installed(&folder(app)),
        checked_at: updates.checked_at.map(rfc3339),
        checked_ago: updates.checked_at.and_then(|at| at.elapsed().ok()).map(|ago| ago.as_secs()),
        checking: updates.checking,
        ready: updates.ready,
        waiting,
        installing: updates.installing,
    }
}

/// The kinds of job running on the program itself, which replacing it
/// stops: the sandbox's Windows jobs (not Linux jobs, which run in its VM).
fn native_kinds(status: &Status) -> Vec<&launcher::Capability> {
    status.capabilities.iter().filter(|c| c.id != "linux" && !c.off() && matches!(c.state, State::Running | State::Starting)).collect()
}

/// A time as RFC 3339, in UTC to the second: `2026-10-12T12:04:05Z`.
fn rfc3339(at: SystemTime) -> String {
    let seconds = at.duration_since(SystemTime::UNIX_EPOCH).map_or(0, |since| since.as_secs());
    let (days, rest) = (seconds / 86_400, seconds % 86_400);
    // Days since 1970 to a date in the proleptic Gregorian calendar (Howard Hinnant's civil_from_days).
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 { month_index + 3 } else { month_index - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", rest / 3600, rest % 3600 / 60, rest % 60)
}

pub fn view(app: &AppHandle) -> View {
    let shared = app.state::<Shared>();
    let now = shared.now.held().clone();
    let settings = config::settings(app);
    let facts = facts(app, &now);
    let server = config::server(app);
    let diagnosed = diagnosis::diagnose(now.code, &facts);
    View {
        chip: diagnosis::chip(&diagnosed),
        diagnosis: diagnosed,
        closed: diagnosis::closed(&facts),
        running: matches!(now.code, Code::Idle | Code::Busy | Code::Offline) || facts.sandbox.as_ref().is_some_and(Status::running),
        version: now.version,
        backend: settings.runner_backend,
        link: facts.workspace.as_ref().and_then(|w| server.join(&format!("{w}/-/runners")).ok()).map(|u| u.to_string()),
        workspace: facts.workspace,
        workspaces: shared.site.held().owned.clone(),
        enabled: settings.runner,
        paused: *shared.paused.held(),
        machine: facts.machine,
        platform: facts.platform,
        log: shared.tail.held().iter().cloned().collect(),
    }
}

/// Whether the runner is running a job: what restarts g1t waits for it,
/// since restarting stops the runner and would cut the job short.
pub fn busy(app: &AppHandle) -> bool {
    let now = app.state::<Shared>().now.held().clone();
    now.code == Code::Busy || now.sandbox.as_ref().is_some_and(|status| status.job().is_some())
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
    let _ = app.emit_to(settings::RUNNER, STATUS_EVENT, view.clone());
    let _ = app.emit_to(EventTarget::webview(frame::BAR), STATUS_EVENT, view.chip.clone());
    let _ = app.emit_to(EventTarget::webview(frame::SITE), STATUS_EVENT, view);
}

fn ask(app: &AppHandle, ask: Ask) {
    if let Some(tx) = app.state::<Shared>().tx.held().as_ref() {
        let _ = tx.send(ask);
    }
}

/// Starts the thread that keeps the runner, as the app starts.
pub fn install(app: &AppHandle) {
    let (tx, rx) = mpsc::channel();
    *app.state::<Shared>().tx.held() = Some(tx.clone());
    let handle = app.clone();
    let spawned = std::thread::Builder::new().name("g1t-runner".into()).spawn(move || supervise(handle, tx, rx));
    if let Err(error) = spawned {
        eprintln!("g1t: the runner's thread could not start: {error}");
    }
}

/// The runner's thread, kept apart from the app: it starts only once the
/// window and the site's page are up, and a panic in it ends neither the
/// app nor the runner for good: the keeper starts again a little later,
/// reaping what the last one left, as it does after a crash of the app.
fn supervise(app: AppHandle, tx: Sender<Ask>, rx: Receiver<Ask>) {
    let mut held = match settle(&app, &rx) {
        Ok(held) => held,
        Err(done) => {
            let _ = done.send(());
            return;
        }
    };
    loop {
        let keeper = Keeper::new(app.clone(), tx.clone());
        let asks = std::mem::take(&mut held);
        match catch_unwind(AssertUnwindSafe(|| keeper.keep(&rx, asks))) {
            Ok(()) => return,
            Err(panic) => {
                let why = panic.downcast_ref::<&str>().map(|s| (*s).to_owned()).or_else(|| panic.downcast_ref::<String>().cloned()).unwrap_or_default();
                eprintln!("g1t: the runner's thread failed ({why}); starting it again in {}s", AFTER_PANIC.as_secs());
                // Asks that come meanwhile wait for the next keeper; Quit ends it all.
                let until = Instant::now() + AFTER_PANIC;
                while let Some(left) = until.checked_duration_since(Instant::now()).filter(|d| !d.is_zero()) {
                    match rx.recv_timeout(left) {
                        Ok(Ask::Quit(done)) => {
                            let _ = done.send(());
                            return;
                        }
                        Ok(ask) => held.push(ask),
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                }
            }
        }
    }
}

/// Waits, doing nothing the window could notice, until the site's page has
/// loaded (or SITE_WAIT has passed) and AFTER_START more: the runner starts
/// with the app, but never in its way. What is asked meanwhile is kept for
/// after; Quit returns its sender at once.
fn settle(app: &AppHandle, rx: &Receiver<Ask>) -> Result<Vec<Ask>, Sender<()>> {
    let began = Instant::now();
    let mut loaded: Option<Instant> = None;
    let mut held = Vec::new();
    loop {
        if loaded.is_none() && (config::site_ready(app) || began.elapsed() >= SITE_WAIT) {
            loaded = Some(Instant::now());
        }
        if loaded.is_some_and(|at| at.elapsed() >= AFTER_START) {
            return Ok(held);
        }
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(Ask::Quit(done)) => return Err(done),
            Ok(ask) => held.push(ask),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return Ok(held),
        }
    }
}

/// Settings changed: the thread looks again.
pub fn settings_changed(app: &AppHandle) {
    ask(app, Ask::Look);
    publish(app);
}

/// Start or Stop, from settings or the tray.
pub fn set_paused(app: &AppHandle, paused: bool) {
    *app.state::<Shared>().paused.held() = paused;
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
        *app.state::<Shared>().paused.held() = false;
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
    *app.state::<Shared>().paused.held() = false;
    ask(app, Ask::Retry);
}

/// What the site says about the person, on every page: whether they are
/// signed in, the workspaces they own, and the one they are in.
pub fn offer(app: &AppHandle, signed_in: bool, owned: Vec<Offered>, current: Option<String>) {
    let next = Site { signed_in: Some(signed_in), owned, current: current.map(|c| c.to_ascii_lowercase()) };
    let changed = {
        let shared = app.state::<Shared>();
        let mut site = shared.site.held();
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
        "remove_sandbox" => {
            *app.state::<Shared>().paused.held() = false;
            ask(app, Ask::RemoveSandbox);
        }
        "check_updates" => ask(app, Ask::Check),
        "sign_in" => crate::links::go(app, "/login"),
        "new_workspace" => crate::links::go(app, "/workspaces/new"),
        "view_runners" => match workspace(app) {
            Some(workspace) => crate::links::go(app, &format!("/{workspace}/-/runners")),
            None => crate::links::go(app, "/"),
        },
        // They are chosen in the settings' Runner section.
        "choose_workspace" | "choose_backend" => settings::open_runner_settings(app),
        "open_runner" => settings::runner_menu(app, false, None),
        // The Runner window, bundled with the app: where jobs are taken out
        // of the sandbox, which no page from the network may do (bridge.rs).
        "runner_window" => settings::open_runner_window(app),
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
    app.state::<Shared>().wanted.held().clone()
}

/// The runner's log, for the settings window to open.
pub fn log_file(app: &AppHandle) -> PathBuf {
    folder(app).join("runner.log")
}

/// Stops the runner as g1t quits or restarts, and waits for it.
pub fn shutdown(app: &AppHandle) {
    let tx = app.state::<Shared>().tx.held().take();
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
    /// `down --only <kind> --drain`: one kind of job, stopped after its
    /// job, so the program its runner is can be replaced.
    Drain(String),
}

impl Step {
    fn name(&self) -> &'static str {
        match self {
            Step::Up | Step::Start(_) => "up",
            Step::Update => "update",
            Step::Stop(_) | Step::Drain(_) => "down",
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
    /// Why the last update failed (`UpdateFailed`, or `UpdateRefused` for
    /// a release g1t didn't sign), said while the runner is idle, until
    /// the next one works.
    update_failed: Option<(Code, String)>,
    /// A newer program, downloaded and checked, waiting for the kinds of
    /// job that run on it to be idle: its version and its bytes.
    program: Option<(String, Vec<u8>)>,
    /// The person asked for this update: it installs with "Download
    /// updates by themselves" off.
    asked: bool,
    /// When g1t last looked, as settings last said it.
    said_checked: String,
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
            update_failed: None,
            program: None,
            asked: false,
            said_checked: String::new(),
            retry: Vec::new(),
        }
    }

    fn keep(mut self, rx: &Receiver<Ask>, asks: Vec<Ask>) {
        self.reap();
        self.set(Code::Starting, detail("Starting after g1t's window."));
        for ask in asks {
            self.handle(ask);
        }
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
            self.said_when();
        }
    }

    /// Settings say when g1t last looked for a newer runner, in minutes
    /// and hours: said again as that changes.
    fn said_when(&mut self) {
        let (checked_at, checking) = self.with_updates(|updates| (updates.checked_at, updates.checking));
        let checked_ago = checked_at.and_then(|at| at.elapsed().ok()).map(|ago| ago.as_secs());
        let checked = diagnosis::checked(&diagnosis::Update { checked_ago, checking, ..diagnosis::Update::default() });
        if checked != self.said_checked {
            self.said_checked = checked;
            publish(&self.app);
        }
    }

    fn with_updates<R>(&self, change: impl FnOnce(&mut Updates) -> R) -> R {
        change(&mut self.app.state::<Shared>().updates.held())
    }

    /// What an idle runner shows: why its last update failed, until one works.
    fn idle(&self, code: Code) -> (Code, Extra) {
        match (&self.update_failed, code) {
            (Some((failed, why)), Code::Idle) => (*failed, detail(why.clone())),
            _ => (code, Extra::default()),
        }
    }

    fn set(&mut self, code: Code, extra: Extra) {
        let changed = {
            let shared = self.app.state::<Shared>();
            let mut now = shared.now.held();
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
        self.app.state::<Shared>().now.held().code
    }

    fn note(&mut self, job: Option<String>, version: Option<String>) {
        let shared = self.app.state::<Shared>();
        let mut now = shared.now.held();
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
            let mut tail = shared.tail.held();
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
            Ask::RemoveSandbox => {
                self.set(Code::Starting, detail("Removing this computer's sandbox."));
                self.halt();
                self.forget_sandbox();
                self.failures = 0;
                self.not_before = Instant::now();
                self.set(Code::Starting, detail("Starting a sandbox of g1t's own."));
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
                    Code::UpdateFailed | Code::UpdateRefused if self.run.is_some() => self.check(true),
                    Code::Offline => self.halt(),
                    _ if self.run.as_ref().is_some_and(|run| !run.listening) => self.halt(),
                    _ => {}
                }
            }
            Ask::Check => self.check(true),
            Ask::Checked(found) => self.checked(found),
            Ask::Token { workspace, token } => {
                let shared = self.app.state::<Shared>();
                let mut wanted = shared.wanted.held();
                if wanted.as_deref() == Some(workspace.as_str()) {
                    *wanted = None;
                    self.token = Some((workspace, token));
                    self.not_before = Instant::now();
                }
            }
            Ask::Refused { workspace, allowed, why } => {
                let matched = {
                    let shared = self.app.state::<Shared>();
                    let mut wanted = shared.wanted.held();
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
                        let mut now = shared.now.held();
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
            let (code, extra) = self.idle(code);
            self.set(code, extra);
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
                let mut now = shared.now.held();
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
        *self.app.state::<Shared>().wanted.held() = Some(workspace.to_owned());
        let _ = self.app.emit_to(EventTarget::webview(frame::SITE), WANTED_EVENT, workspace.to_owned());
        self.not_before = Instant::now() + ASK_AGAIN;
        let signed_out = self.app.state::<Shared>().site.held().signed_in == Some(false);
        self.set(if signed_out { Code::SignedOut } else { Code::Registering }, Extra::default());
    }

    /// The thread's look round: what should run, and whether it does.
    fn look(&mut self) {
        let settings = config::settings(&self.app);
        let paused = *self.app.state::<Shared>().paused.held();
        if !settings.runner || paused {
            if self.run.is_some() {
                self.halt();
            }
            *self.app.state::<Shared>().wanted.held() = None;
            self.set(if paused { Code::Stopped } else { Code::Off }, Extra::default());
            return;
        }
        // Looking needs a runner here to compare with; the first comes with the first start.
        if Instant::now() >= self.next_update && native::installed(&folder(&self.app)).is_some() {
            self.check(false);
        }
        let workspace = workspace(&self.app);
        if let Some(run) = &self.run {
            let moved = run.backend != settings.runner_backend || Some(&run.workspace) != workspace.as_ref();
            let back = run.offline_at.is_some_and(|at| at.elapsed() >= BACK_ONLINE);
            let (busy, stepping) = (run.busy, run.step().is_some());
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
            } else if !moved && !stepping && !self.install() {
                self.kinds(workspace.as_deref());
            }
            self.poll();
            return;
        }
        if Instant::now() < self.not_before {
            return;
        }
        // Nothing runs: a waiting program goes in before anything starts.
        if self.program.is_some()
            && self.allowed()
            && let Some((version, bytes)) = self.program.take()
        {
            self.put(version, &bytes);
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
            let code = match app.state::<Shared>().site.held().signed_in {
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
        let binary = match self.ensure_binary(&server) {
            Ok(binary) => binary,
            Err(fault) => return self.not_installed(workspace, token, fault),
        };
        let started = native::spawn(&binary, &native_dir(&app, backend), &envs).map_err(|e| format!("g1t-runner could not start: {e}")).inspect(|child| {
            let _ = std::fs::write(folder(&app).join("pid"), child.id().to_string());
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

    /// `g1t-runner` installed, from the newest release when it is not:
    /// one g1t signed, as every update is.
    fn ensure_binary(&mut self, server: &Url) -> Result<PathBuf, Fault> {
        let folder = folder(&self.app);
        let binary = native::binary(&folder);
        if native::installed(&folder).is_some() {
            return Ok(binary);
        }
        self.set(Code::Updating, detail("Downloading g1t-runner."));
        let manifest = native::latest(server)?;
        let bytes = native::download(server, &manifest).map_err(Fault::Failed)?;
        native::put(&folder, &bytes, &manifest.version).map_err(Fault::Failed)?;
        self.note(None, Some(manifest.version));
        self.with_updates(|updates| updates.checked_at = Some(SystemTime::now()));
        Ok(binary)
    }

    /// There is no `g1t-runner` here, and none could be had: a release g1t
    /// didn't sign is refused, and asked for again in a while.
    fn not_installed(&mut self, workspace: String, token: Option<String>, fault: Fault) {
        match fault {
            Fault::Failed(why) => self.not_started(workspace, token, why),
            Fault::Unsigned(why) => {
                if let Some(given) = token {
                    self.token = Some((workspace, given));
                }
                self.write_log(&format!("g1t: g1t-runner wasn't installed: {why}"));
                self.not_before = Instant::now() + MOST_BACKOFF;
                self.set(Code::UpdateRefused, detail(why));
            }
        }
    }

    // --- Updates ------------------------------------------------------------------

    /// Looks for a newer release on a thread of its own, so the runner is
    /// looked after meanwhile: its signed manifest, and its program when it
    /// is newer than the one here. `asked` is the person asking, which
    /// works with "Download updates by themselves" off.
    fn check(&mut self, asked: bool) {
        self.next_update = Instant::now() + UPDATE_EVERY;
        if !asked && !config::settings(&self.app).auto_update {
            return;
        }
        if self.with_updates(|updates| std::mem::replace(&mut updates.checking, true)) {
            return;
        }
        self.asked |= asked;
        publish(&self.app);
        let (server, folder) = (config::server(&self.app), folder(&self.app));
        let waiting = self.program.as_ref().map(|(version, _)| version.clone());
        let tx = self.tx.clone();
        let spawned = std::thread::Builder::new().name("g1t-runner-releases".into()).spawn(move || {
            let _ = tx.send(Ask::Checked(look_for_release(&server, &folder, waiting.as_deref())));
        });
        if spawned.is_err() {
            self.with_updates(|updates| updates.checking = false);
        }
    }

    /// What the look found: a newer program waits for its kinds of job to
    /// be idle, and so does the sandbox's image when it is older than the
    /// release's. A release g1t didn't sign, or one that didn't download,
    /// leaves the runner as it is, and is said while it is idle.
    fn checked(&mut self, found: Result<Found, Fault>) {
        self.with_updates(|updates| updates.checking = false);
        let found = match found {
            Ok(found) => found,
            Err(fault) => {
                let failed = match fault {
                    Fault::Unsigned(why) => (Code::UpdateRefused, why),
                    Fault::Failed(why) => (Code::UpdateFailed, format!("g1t-runner couldn't be updated: {why}")),
                };
                self.write_log(&format!("g1t: {}", failed.1));
                self.update_failed = Some(failed);
                self.asked = false;
                if matches!(self.code(), Code::Idle | Code::UpdateFailed | Code::UpdateRefused) {
                    let (code, extra) = self.idle(Code::Idle);
                    self.set(code, extra);
                }
                return publish(&self.app);
            }
        };
        if let Some(bytes) = found.program {
            self.program = Some((found.version.clone(), bytes));
        }
        if !found.newer {
            self.program = None;
        }
        // The sandbox's image is the release's version; one older takes the newest.
        let sandbox = self.app.state::<Shared>().now.held().sandbox.clone();
        let launcher = self.run.as_ref().is_some_and(|run| run.engine == Engine::Launcher);
        let image = launcher
            && found.images
            && sandbox.is_some_and(|status| status.linux().state != State::Absent && status.image_version.as_deref().is_some_and(|have| native::newer(&found.version, have)));
        let program = self.program.is_some();
        self.with_updates(|updates| {
            updates.checked_at = Some(SystemTime::now());
            updates.program = program;
            updates.image = image;
            updates.ready = (program || image).then(|| found.version.clone());
        });
        if program || image {
            self.write_log(&format!("g1t: g1t-runner {} is ready, and installs as each kind of job is idle.", found.version));
        } else {
            self.asked = false;
        }
        // It worked: what the last failure said goes.
        if self.update_failed.take().is_some() && matches!(self.code(), Code::UpdateFailed | Code::UpdateRefused) {
            self.set(Code::Idle, Extra::default());
        }
        publish(&self.app);
    }

    /// Whether a waiting update may go in: "Download updates by
    /// themselves" is on, or the person asked for it. Turned off since it
    /// downloaded, it no longer waits.
    fn allowed(&mut self) -> bool {
        if self.asked || config::settings(&self.app).auto_update {
            return true;
        }
        self.program = None;
        self.with_updates(|updates| {
            updates.program = false;
            updates.image = false;
            updates.ready = None;
        });
        false
    }

    /// Puts a waiting update in, kind by kind, as each kind of job is idle:
    /// true when it started something, which is waited for. Never in the
    /// middle of a job.
    fn install(&mut self) -> bool {
        let image = self.with_updates(|updates| updates.image);
        if (self.program.is_none() && !image) || !self.allowed() {
            return false;
        }
        let Some((engine, busy, listening)) = self.run.as_ref().map(|run| (run.engine, run.busy, run.listening)) else { return false };
        if engine != Engine::Launcher {
            // A runner in Docker or on this computer is the program: stopped between jobs, started on the new one.
            if busy || !listening {
                return false;
            }
            let Some((version, bytes)) = self.program.take() else { return false };
            self.set(Code::Updating, detail(format!("Updating g1t-runner to {version}.")));
            self.halt();
            self.put(version, &bytes);
            self.not_before = Instant::now();
            return true;
        }
        let Some(status) = self.app.state::<Shared>().now.held().sandbox.clone() else { return false };
        if self.program.is_some() {
            let running = native_kinds(&status);
            if running.is_empty() {
                // Nothing runs on the program: it is replaced now, and
                // kinds() starts what was drained on the new one first,
                // before the image, which takes minutes, is updated.
                let (version, bytes) = self.program.take().expect("checked above");
                self.put(version, &bytes);
                return false;
            } else if !status.per_kind() {
                // A launcher from before kinds of job stopped on their own: the whole sandbox stops between jobs.
                if busy {
                    return false;
                }
                let (version, bytes) = self.program.take().expect("checked above");
                self.set(Code::Updating, detail(format!("Updating g1t-runner to {version}.")));
                self.halt_as(Down::Drain);
                self.put(version, &bytes);
                self.with_updates(|updates| updates.image = true);
                self.not_before = Instant::now();
                return true;
            } else if let Some(idle) = running.iter().find(|kind| kind.job.is_none()) {
                // Stopped after any job it takes meanwhile; replaced once it has.
                let kind = idle.id.clone();
                self.with_updates(|updates| updates.installing = vec![kind.clone()]);
                self.kind_step(Step::Drain(kind), None);
                return true;
            }
        }
        // Linux jobs take the image once they have no job (`update` drains them itself too).
        let image = self.with_updates(|updates| updates.image);
        if image && status.linux().job.is_none() {
            self.with_updates(|updates| updates.installing.push("linux".into()));
            self.sandbox_step(Step::Update);
            return true;
        }
        false
    }

    /// Puts a downloaded program in place, with nothing running on it.
    fn put(&mut self, version: String, bytes: &[u8]) {
        match native::put(&folder(&self.app), bytes, &version) {
            Ok(()) => {
                self.write_log(&format!("g1t: g1t-runner {version} is in place."));
                if self.run.as_ref().is_none_or(|run| run.engine != Engine::Launcher) {
                    self.note(None, Some(version));
                }
            }
            Err(why) => {
                let why = format!("g1t-runner {version} couldn't be put in place: {why}");
                self.write_log(&format!("g1t: {why}"));
                self.update_failed = Some((Code::UpdateFailed, why));
            }
        }
        self.done_with(|updates| {
            updates.program = false;
            updates.installing.retain(|kind| kind == "linux");
        });
    }

    /// Part of an update is done: what waits is said again.
    fn done_with(&mut self, change: impl FnOnce(&mut Updates)) {
        let left = self.with_updates(|updates| {
            change(updates);
            if !updates.program && !updates.image {
                updates.ready = None;
            }
            updates.program || updates.image
        });
        if !left {
            self.asked = false;
        }
        publish(&self.app);
    }

    // --- The sandbox (launcher.rs) ------------------------------------------------

    /// Starts the sandbox for `workspace`: registered with it the first
    /// time, with a token from the site; from its own registration after.
    fn start_sandbox(&mut self, workspace: String) {
        let app = self.app.clone();
        let server = config::server(&app);
        let binary = match self.ensure_binary(&server) {
            Ok(binary) => binary,
            Err(fault) => return self.not_installed(workspace, None, fault),
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
        let image = self.with_updates(|updates| std::mem::take(&mut updates.image));
        let step = if image && status.linux().state != State::Absent { Step::Update } else { Step::Up };
        if step == Step::Update {
            self.with_updates(|updates| updates.installing.push("linux".into()));
        } else if image {
            self.done_with(|_| {});
        }
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
            let mut now = shared.now.held();
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
        let Some(status) = self.app.state::<Shared>().now.held().sandbox.clone() else { return };
        if !status.per_kind() {
            return;
        }
        let on = config::settings(&self.app).runner_capabilities;
        // A kind of job drained for a new program starts on the new one, once it is in.
        let replacing = self.program.is_some();
        for capability in &status.capabilities {
            if !on.on(&capability.id) && !capability.off() {
                return self.kind_step(Step::Stop(capability.id.clone()), None);
            }
            if on.on(&capability.id) && capability.off() && capability.available && !(replacing && capability.id != "linux") {
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
                        *self.app.state::<Shared>().wanted.held() = Some(workspace.to_owned());
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
            Step::Drain(kind) => (launcher::drain_only_args(&dir, kind), vec![], format!("stopping {} after their job, to update g1t-runner", diagnosis::kind_label(kind))),
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
            let (server, folder) = (config::server(&self.app), folder(&self.app));
            if let Ok(Found { version, program: Some(bytes), .. }) = look_for_release(&server, &folder, None)
                && native::put(&folder, &bytes, &version).is_ok()
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
        let mut now = shared.now.held();
        now.sandbox = Some(status.clone());
        if let Some(version) = status.version() {
            now.version = Some(version);
        }
        now.job = status.job().map(launcher::Job::said);
    }

    /// The sandbox as it is now, while it is the run.
    fn sandbox_now(&mut self, status: Status) {
        let had = self.app.state::<Shared>().now.held().job.clone();
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
            (Code::Idle, Some((failed, why))) => self.set(failed, detail(why)),
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
            let mut now = shared.now.held();
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
        // Drained for a new program, which goes in on the next look; one
        // that didn't stop leaves the update for the next one, rather than
        // being asked again and again.
        if let (Step::Drain(_), Some(error)) = (&step, &error) {
            self.program = None;
            self.update_failed = Some((Code::UpdateFailed, format!("g1t-runner couldn't be updated: {error}")));
            self.done_with(|updates| {
                updates.program = false;
                updates.installing.retain(|kind| kind == "linux");
            });
        }
        // One kind of job started or stopped: how the sandbox is now says
        // the rest, and one that didn't start is tried again in a while.
        if matches!(step, Step::Start(_) | Step::Stop(_) | Step::Drain(_)) {
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
        // The image is taken, or failed to be: the next look says whether another waits.
        if step == Step::Update {
            self.done_with(|updates| {
                updates.image = false;
                updates.installing.retain(|kind| kind != "linux");
            });
        }
        if let Some(error) = error.clone() {
            if self.registration_trouble(&error) {
                return;
            }
            if step == Step::Update {
                self.update_failed = Some((Code::UpdateFailed, format!("The sandbox's image couldn't be updated: {error}")));
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
                    self.app.state::<Shared>().now.held().sandbox = Some(failed);
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

/// The newest release, signed, and its program when it is newer than the
/// one in `folder` and isn't already `waiting`: downloaded and checked
/// against its SHA-256. On the update thread, never the runner's.
fn look_for_release(server: &Url, folder: &std::path::Path, waiting: Option<&str>) -> Result<Found, Fault> {
    let manifest = native::latest(server)?;
    let newer = native::installed(folder).is_none_or(|have| native::newer(&manifest.version, &have));
    let program = if newer && waiting != Some(manifest.version.as_str()) {
        Some(native::download(server, &manifest).map_err(|why| Fault::Failed(format!("{} didn't download: {why}", manifest.version)))?)
    } else {
        None
    };
    Ok(Found { images: manifest.has_images(), version: manifest.version, newer, program })
}

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
        let diagnosed = diagnosis::diagnose(code, &facts);
        View {
            chip: diagnosis::chip(&diagnosed),
            diagnosis: diagnosed,
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
    fn a_new_runner_lives_in_local_data_and_an_old_one_stays_put() {
        let base = std::env::temp_dir().join(format!("g1t-desktop-folders-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (local, roaming) = (base.join("local").join("runner"), base.join("roaming").join("runner"));
        assert_eq!(chosen_folder(local.clone(), roaming.clone()), local);
        std::fs::create_dir_all(&roaming).unwrap();
        assert_eq!(chosen_folder(local.clone(), roaming.clone()), roaming);
        std::fs::create_dir_all(&local).unwrap();
        assert_eq!(chosen_folder(local.clone(), roaming), local);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn when_is_said_as_the_site_reads_it() {
        let at = |seconds: u64| rfc3339(SystemTime::UNIX_EPOCH + Duration::from_secs(seconds));
        assert_eq!(at(0), "1970-01-01T00:00:00Z");
        assert_eq!(at(1_791_806_645), "2026-10-12T12:04:05Z");
        // The day after February 29th of a leap year.
        assert_eq!(at(1_709_251_199 + 1), "2024-03-01T00:00:00Z");
        assert_eq!(at(951_782_400), "2000-02-29T00:00:00Z");
    }

    /// What is running on the program itself, which an update drains first:
    /// Windows jobs running or starting, not Linux jobs, nor ones stopped.
    #[test]
    fn an_update_drains_only_what_runs_on_the_program() {
        let kinds = |json: &str| native_kinds(&status(json)).iter().map(|c| c.id.clone()).collect::<Vec<_>>();
        assert_eq!(
            kinds(r#"{"schema":1,"state":"running","capabilities":[{"id":"linux","available":true,"state":"running","turned_off":false},{"id":"windows","available":true,"state":"running","turned_off":false}]}"#),
            ["windows"]
        );
        assert!(kinds(r#"{"schema":1,"state":"running","capabilities":[{"id":"linux","available":true,"state":"running","turned_off":false},{"id":"windows","available":true,"state":"stopped","turned_off":true}]}"#).is_empty());
        assert!(kinds(r#"{"schema":1,"state":"running","capabilities":[{"id":"linux","available":true,"state":"running"},{"id":"windows","available":false,"state":"absent"}]}"#).is_empty());
    }

    #[test]
    fn the_site_names_workspaces_in_its_own_words() {
        let offered: Vec<Offered> = serde_json::from_str(r#"[{"slug":"acme","name":"Acme"},{"slug":"solo"}]"#).unwrap();
        assert_eq!(offered[1], Offered { slug: "solo".into(), name: None });
    }
}
