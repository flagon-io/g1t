//! Updates. The app asks g1t.sh/downloads/desktop/latest.json as it
//! starts and every hour after, and downloads a newer version in the
//! background. One found as it starts is installed straight away, and g1t
//! opens again on it, before anyone has begun working in it: so a person
//! whose copy misbehaves only has to open g1t again to be on the newest,
//! fixed one (unless the runner g1t runs itself is in the middle of a job,
//! which is never cut short; then it waits like any other). One found
//! later says so, with a notification and the tray's "Restart to update",
//! since nothing is installed under someone mid-sentence; the restart, or
//! quitting, installs it. The manifest is signed with g1t's
//! release key, built into the app, and a download whose signature does
//! not check out is thrown away (scripts/desktop-release.mjs).
//!
//! Restarting, to update or otherwise, and quitting go at once (`leave`):
//! the windows go, the tray says what g1t is doing until the process ends,
//! and the runner is seen to as runner/mod.rs `plan` says. The sandbox runs
//! on across a restart, its jobs with it, and the new version takes it up
//! again; a runner g1t runs itself is stopped, within about 10 seconds,
//! and if it is running a job the person is asked first (ask.rs). What
//! happened goes in the app's log, `g1t.log` in its log folder, and the
//! runner's.

use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::{Update, UpdaterExt};
use tauri_plugin_window_state::AppHandleExt;

use crate::ask::{self, Answer};
use crate::runner::{self, Going, Leave};
use crate::{config, settings, tray};

/// An update downloaded and checked, waiting to be installed.
pub struct Ready {
    pub version: String,
    update: Update,
    bytes: Vec<u8>,
}

/// The first look waits only for the window to be up.
const FIRST_CHECK: Duration = Duration::from_secs(3);
const EVERY: Duration = Duration::from_secs(60 * 60);
/// An update downloaded this soon after g1t started is installed at once:
/// nobody has begun working in it yet.
const AT_START: Duration = Duration::from_secs(2 * 60);

/// Checks as g1t starts, installing what it finds then, and every hour
/// after, unless settings turned that off; a person can still check from
/// the menu.
pub fn schedule(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let started = std::time::Instant::now();
        tokio::time::sleep(FIRST_CHECK).await;
        let mut first = true;
        loop {
            if config::settings(&app).auto_update {
                let at_start = first && started.elapsed() < AT_START;
                let found = look(&app, false, at_start).await;
                if at_start && let Some(version) = found.ok().as_deref().and_then(|answer| answer.strip_prefix("ready:")).map(str::to_owned)
                {
                    // Only a job the restart would cut short holds it back: a sandbox's runs on.
                    if runner::leaving(&app, Going::Restart).1 {
                        tell(
                            &app,
                            "g1t is ready to update",
                            &format!("Version {version} is downloaded. Restart g1t from the tray to use it."),
                        );
                    } else {
                        tell(&app, "Updating g1t", &format!("g1t opens again on version {version} in a moment."));
                        let _ = restart(&app);
                    }
                }
            }
            first = false;
            tokio::time::sleep(EVERY).await;
        }
    });
}

/// When the updater last heard back, in milliseconds since 1970.
pub fn checked_at(app: &AppHandle) -> Option<u64> {
    *app.state::<config::State>().checked_at.lock().unwrap()
}

fn heard_back(app: &AppHandle) {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|since| since.as_millis() as u64).ok();
    *app.state::<config::State>().checked_at.lock().unwrap() = now;
}

/// The version downloaded and waiting, if one is.
pub fn ready(app: &AppHandle) -> Option<String> {
    app.state::<config::State>().update.lock().unwrap().as_ref().map(|ready| ready.version.clone())
}

fn tell(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

/// Looks for an update and downloads it. `asked` is a person asking from
/// the tray or the site, who is told the answer either way; the timer
/// says nothing unless there is something to install.
pub async fn check(app: &AppHandle, asked: bool) -> Result<String, String> {
    look(app, asked, false).await
}

/// [`check`]; `at_start` says nothing of a download, which is installed at once.
async fn look(app: &AppHandle, asked: bool, at_start: bool) -> Result<String, String> {
    if let Some(version) = ready(app) {
        if asked {
            tell(app, "g1t is ready to update", &format!("Version {version} is downloaded. Restart g1t to use it."));
        }
        return Ok(format!("ready:{version}"));
    }
    let updater = app.updater().map_err(|error| error.to_string())?;
    let update = match updater.check().await {
        Ok(Some(update)) => {
            heard_back(app);
            update
        }
        Ok(None) => {
            heard_back(app);
            if asked {
                tell(app, "g1t is up to date", &format!("You have version {}.", env!("CARGO_PKG_VERSION")));
            }
            return Ok("current".into());
        }
        Err(error) => {
            if asked {
                tell(app, "g1t could not check for updates", &error.to_string());
            }
            return Err(error.to_string());
        }
    };
    let version = update.version.clone();
    match update.download(|_, _| {}, || {}).await {
        Ok(bytes) => {
            *app.state::<config::State>().update.lock().unwrap() = Some(Ready { version: version.clone(), update, bytes });
            tray::update_ready(&version);
            let _ = app.emit_to(settings::SETTINGS, settings::READY_EVENT, version.clone());
            // The settings the site draws, if they are open, say so too.
            let _ = app.emit_to(tauri::EventTarget::webview(crate::frame::SITE), settings::READY_EVENT, version.clone());
            if !at_start {
                tell(app, "g1t is ready to update", &format!("Version {version} is downloaded. Restart g1t from the tray to use it."));
            }
            Ok(format!("ready:{version}"))
        }
        Err(error) => {
            if asked {
                tell(app, "The update could not be downloaded", &error.to_string());
            }
            Err(error.to_string())
        }
    }
}

/// Installs what is downloaded, if anything. On Windows the installer
/// ends this process itself, and opens the new version once it is in;
/// elsewhere the caller goes on.
fn install(app: &AppHandle) -> bool {
    let ready = app.state::<config::State>().update.lock().unwrap().take();
    let Some(ready) = ready else { return false };
    log(app, &format!("Installing {}.", ready.version));
    // On Windows the installer starts once the app has let go: its runner
    // stopped (or the sandbox left to itself), its windows' places kept
    // (`leave`), its icon out of the tray.
    if cfg!(windows) {
        tray::gone(app);
    }
    match ready.update.install(ready.bytes) {
        Ok(()) => true,
        Err(error) => {
            log(app, &format!("The update could not be installed: {error}"));
            tell(app, "The update could not be installed", &error.to_string());
            false
        }
    }
}

/// The restart, from the tray, the menu, the settings or the update at
/// start: installs the update and starts the new version. Says whether g1t
/// is going, or stayed (the person kept it open for a job, or there is
/// nothing to install).
pub fn restart(app: &AppHandle) -> Receiver<bool> {
    let Some(version) = ready(app) else { return answered(false) };
    leave(app, Going::Restart, "Updating g1t…", move |app| {
        if install(app) {
            app.restart();
        }
        // It didn't install: g1t stays as it was, on the version it has.
        log(app, &format!("Staying on {} rather than {version}.", env!("CARGO_PKG_VERSION")));
        stay(app);
    })
}

/// Restarts g1t with no update, for a setting that needs it.
pub fn restart_only(app: &AppHandle) -> Receiver<bool> {
    leave(app, Going::Restart, "Restarting g1t…", |app| app.restart())
}

/// Quit, stopping the runner and installing a downloaded update on the way out.
pub fn quit(app: &AppHandle) -> Receiver<bool> {
    leave(app, Going::Quit, "Quitting g1t…", |app| {
        install(app);
        app.exit(0);
    })
}

/// g1t is on its way: a second press waits for the first.
static LEAVING: AtomicBool = AtomicBool::new(false);

fn answered(going: bool) -> Receiver<bool> {
    let (tx, rx) = mpsc::channel();
    let _ = tx.send(going);
    rx
}

/// Goes, then `then`, `doing` what the tray says. On a thread of its own:
/// restart and quit are asked on the main thread (menus, and the settings'
/// commands, which Windows runs there), and the runner, stopping, updates
/// the tray, which waits for the main thread; waiting on the runner there
/// froze g1t until its 30 seconds ran out.
///
/// If going would cut a job short, the person is asked first: keep g1t
/// open, stop the job, or go once it finishes, without asking again. Then
/// the windows go at once, the tray says what g1t is doing, and the runner
/// is seen to (runner::shut) before `then`. The answer is whether g1t goes.
fn leave(app: &AppHandle, going: Going, doing: &'static str, then: impl FnOnce(&AppHandle) + Send + 'static) -> Receiver<bool> {
    let (tx, rx) = mpsc::channel();
    if LEAVING.swap(true, Ordering::SeqCst) {
        let _ = tx.send(true);
        return rx;
    }
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("g1t-leave".into()).spawn({
        let app = app.clone();
        move || {
            let (leave, cuts_short) = runner::leaving(&app, going);
            let answer = if cuts_short { ask::job_running(going) } else { Answer::Now };
            if answer == Answer::Stay {
                log(&app, &format!("{doing} Kept open: a job is running on this computer."));
                LEAVING.store(false, Ordering::SeqCst);
                let _ = tx.send(false);
                return;
            }
            let _ = tx.send(true);
            log(&app, &format!("{doing} {}", said(leave, cuts_short, answer)));
            let _ = app.save_window_state(crate::KEPT);
            for window in app.windows().values() {
                let _ = window.hide();
            }
            let after_job = answer == Answer::WhenDone;
            tray::leaving(
                &app,
                Some(if after_job { format!("{} when the job finishes…", doing.trim_end_matches('…')) } else { doing.to_owned() }),
            );
            runner::shut(&app, going, after_job, || {
                if after_job {
                    log(&app, "The job finished.");
                    tray::leaving(&app, Some(doing.to_owned()));
                }
            });
            then(&app);
        }
    });
    if spawned.is_err() {
        runner::shutdown(&app);
        app.exit(0);
    }
    rx
}

/// What going does to the runner, for the app's log.
fn said(leave: Leave, cuts_short: bool, answer: Answer) -> &'static str {
    match (leave, cuts_short, answer) {
        (Leave::Running, _, _) => "The sandbox, if it runs, is left running, its jobs with it.",
        (Leave::Stop, true, Answer::WhenDone) => "Waiting for the job running on this computer, then stopping the runner.",
        (Leave::Stop, true, _) => "Stopping the runner and the job it is running, as asked.",
        (Leave::Stop, false, _) => "Stopping the runner, which has no job.",
    }
}

/// g1t stays after all: its windows and tray as they were, and its runner
/// started again (a sandbox left running is taken up again).
fn stay(app: &AppHandle) {
    LEAVING.store(false, Ordering::SeqCst);
    tray::leaving(app, None);
    tray::show(app);
    runner::install(app);
}

/// A line in the app's own log: `g1t.log` in its log folder, started over
/// past a megabyte.
fn log(app: &AppHandle, line: &str) {
    let Ok(dir) = app.path().app_log_dir() else { return };
    let path = dir.join("g1t.log");
    let _ = std::fs::create_dir_all(&dir);
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > 1024 * 1024) {
        let _ = std::fs::rename(&path, path.with_extension("log.old"));
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{} {} {line}", runner::timestamp(), env!("CARGO_PKG_VERSION"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_log_says_what_going_did_to_the_runner() {
        assert!(said(Leave::Running, false, Answer::Now).contains("left running"));
        assert!(said(Leave::Stop, true, Answer::WhenDone).starts_with("Waiting for the job"));
        assert!(said(Leave::Stop, true, Answer::Now).contains("the job it is running"));
        assert!(said(Leave::Stop, false, Answer::Now).contains("no job"));
    }
}
