//! Updates. The app asks g1t.sh/downloads/desktop/latest.json as it
//! starts and every hour after, and downloads a newer version in the
//! background. One found as it starts is installed straight away, and g1t
//! opens again on it, before anyone has begun working in it: so a person
//! whose copy misbehaves only has to open g1t again to be on the newest,
//! fixed one (unless the runner is in the middle of a job, which is never
//! cut short; then it waits like any other). One found later says so, with
//! a notification and the tray's "Restart to update", since nothing is
//! installed under someone mid-sentence; the restart, or quitting,
//! installs it. The manifest is signed with g1t's
//! release key, built into the app, and a download whose signature does
//! not check out is thrown away (scripts/desktop-release.mjs).

use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::{Update, UpdaterExt};

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
                if at_start && let Some(version) = found.ok().as_deref().and_then(|answer| answer.strip_prefix("ready:")).map(str::to_owned) {
                    if crate::runner::busy(&app) {
                        tell(&app, "g1t is ready to update", &format!("Version {version} is downloaded. Restart g1t from the tray to use it."));
                    } else {
                        tell(&app, "Updating g1t", &format!("g1t opens again on version {version} in a moment."));
                        restart(&app);
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
/// ends this process itself; elsewhere the caller goes on.
fn install(app: &AppHandle) -> bool {
    let ready = app.state::<config::State>().update.lock().unwrap().take();
    let Some(ready) = ready else { return false };
    match ready.update.install(ready.bytes) {
        Ok(()) => true,
        Err(error) => {
            tell(app, "The update could not be installed", &error.to_string());
            false
        }
    }
}

/// The tray's restart: installs the update and starts the new version.
/// The runner stops first, since on Windows the installer ends g1t.
pub fn restart(app: &AppHandle) {
    if ready(app).is_none() {
        return;
    }
    crate::runner::shutdown(app);
    if install(app) {
        app.restart();
    }
}

/// Quit, stopping the runner and installing a downloaded update on the way out.
pub fn quit(app: &AppHandle) {
    crate::runner::shutdown(app);
    install(app);
    app.exit(0);
}
