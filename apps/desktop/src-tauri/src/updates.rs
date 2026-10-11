//! Updates. The app asks g1t.sh/downloads/desktop/latest.json soon after
//! it starts and every six hours after, downloads a newer version in the
//! background, and then says so: a notification, and the tray's "Restart
//! to update". Nothing is installed under someone mid-sentence; the
//! restart, or quitting, installs it. The manifest is signed with g1t's
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

const FIRST_CHECK: Duration = Duration::from_secs(15);
const EVERY: Duration = Duration::from_secs(6 * 60 * 60);

/// Checks soon after the start, then every six hours, unless settings
/// turned that off; a person can still check from the menu.
pub fn schedule(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            if config::settings(&app).auto_update {
                let _ = check(&app, false).await;
            }
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
            tell(app, "g1t is ready to update", &format!("Version {version} is downloaded. Restart g1t from the tray to use it."));
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
pub fn restart(app: &AppHandle) {
    if install(app) {
        app.restart();
    }
}

/// Quit, installing a downloaded update on the way out.
pub fn quit(app: &AppHandle) {
    install(app);
    app.exit(0);
}
