//! The app's own settings: how it starts, what closing the window does,
//! how it tells the person something arrived, its title bar, zoom,
//! updates, and the runner. They live in their own window (`launcher/settings.html`),
//! opened from the menu, the tray, or the site's account menu, and are
//! kept with the server in `desktop.json` (config.rs). Whether g1t opens
//! when someone signs in to their computer is kept by the system itself,
//! through the autostart plugin, and read back from it.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt;

use crate::config;

/// The settings window's label.
pub const SETTINGS: &str = "settings";

/// The argument the system starts g1t with at sign-in, so it can tell a
/// start of its own from someone opening it.
pub const AT_LOGIN: &str = "--at-login";

/// The zoom levels the View menu steps through.
pub const ZOOMS: &[f64] = &[0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// Opened at sign-in, g1t waits in the tray instead of opening its window.
    pub start_hidden: bool,
    /// Closing the window leaves g1t running in the tray, for notifications;
    /// otherwise closing it quits.
    pub close_to_tray: bool,
    /// Notifications from the system, for what the site says needs the person.
    pub notifications: bool,
    /// The taskbar icon flashes, or the dock icon bounces, with a notification.
    pub flash: bool,
    /// What needs the person, counted on the icon.
    pub badge: bool,
    /// The system's title bar, and on Windows and Linux its menu bar, in
    /// place of g1t's own (frame.rs). Takes effect when g1t restarts.
    pub system_title_bar: bool,
    /// The site's zoom, 1 for as it is.
    pub zoom: f64,
    /// Updates download by themselves; a person can still check from the menu.
    /// The runner's own updates follow it too (runner/mod.rs).
    pub auto_update: bool,
    /// Runs the workspace's self-hosted jobs on this computer while g1t is
    /// open (runner/mod.rs). On unless someone turns it off.
    pub runner: bool,
    /// How the runner runs: sandboxed unless someone chooses otherwise.
    pub runner_backend: crate::runner::Backend,
    /// The workspace it runs for; the one the person is in when it first registers.
    pub runner_workspace: Option<String>,
    /// Sandboxed, each kind of job on or off on its own: Linux jobs can
    /// run while Windows jobs are stopped. All on unless someone stops one.
    pub runner_capabilities: RunnerCapabilities,
}

/// Each kind of job the sandbox runs, on or off (`runnerCapabilities` in
/// desktop.json: `{"linux": true, "windows": false}`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct RunnerCapabilities {
    pub linux: bool,
    pub windows: bool,
    pub macos: bool,
}

impl Default for RunnerCapabilities {
    fn default() -> Self {
        Self { linux: true, windows: true, macos: true }
    }
}

impl RunnerCapabilities {
    /// Whether a kind of job is on; one this app doesn't know is.
    pub fn on(&self, id: &str) -> bool {
        match id {
            "linux" => self.linux,
            "windows" => self.windows,
            "macos" => self.macos,
            _ => true,
        }
    }

    /// Turns a kind of job on or off: false for a kind this app doesn't know.
    pub fn set(&mut self, id: &str, on: bool) -> bool {
        let kind = match id {
            "linux" => &mut self.linux,
            "windows" => &mut self.windows,
            "macos" => &mut self.macos,
            _ => return false,
        };
        *kind = on;
        true
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            start_hidden: true,
            close_to_tray: true,
            notifications: true,
            flash: true,
            badge: true,
            system_title_bar: false,
            zoom: 1.0,
            auto_update: true,
            runner: true,
            runner_backend: crate::runner::Backend::Sandboxed,
            runner_workspace: None,
            runner_capabilities: RunnerCapabilities::default(),
        }
    }
}

impl Settings {
    /// A zoom the app offers, nearest to the one asked for.
    pub fn clamp_zoom(zoom: f64) -> f64 {
        ZOOMS.iter().copied().min_by(|a, b| (a - zoom).abs().total_cmp(&(b - zoom).abs())).unwrap_or(1.0)
    }
}

/// What the settings window shows: the settings, and what the app and the
/// system know.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    #[serde(flatten)]
    pub settings: Settings,
    pub open_at_login: bool,
    pub version: String,
    pub platform: String,
    pub server: String,
    pub update_ready: Option<String>,
    /// When the app last asked for updates and heard back, in milliseconds since 1970.
    pub checked_at: Option<u64>,
    /// The title bar setting differs from the one the windows have: a restart applies it.
    pub title_bar_changed: bool,
    /// Whether this window draws g1t's own title bar, which the page then draws (settings.html).
    pub custom_frame: bool,
    /// The runner's state, diagnosis and recent log.
    pub runner_view: crate::runner::View,
}

pub fn view(app: &AppHandle) -> View {
    View {
        settings: config::settings(app),
        open_at_login: app.autolaunch().is_enabled().unwrap_or(false),
        version: env!("CARGO_PKG_VERSION").into(),
        platform: std::env::consts::OS.into(),
        server: config::server(app).to_string(),
        update_ready: crate::updates::ready(app),
        checked_at: crate::updates::checked_at(app),
        title_bar_changed: crate::frame::started(app) != crate::frame::custom(app),
        custom_frame: crate::frame::started(app),
        runner_view: crate::runner::view(app),
    }
}

/// Keeps new settings and puts them to work at once.
pub fn apply(app: &AppHandle, mut settings: Settings) -> Result<(), String> {
    settings.zoom = Settings::clamp_zoom(settings.zoom);
    let before = config::settings(app);
    config::set_settings(app, settings.clone())?;
    if let Some(site) = crate::frame::site(app).filter(|_| before.zoom != settings.zoom) {
        let _ = site.set_zoom(settings.zoom);
    }
    if before.badge != settings.badge {
        crate::badge::refresh(app);
    }
    let runner = |s: &Settings| (s.runner, s.runner_backend, s.runner_workspace.clone(), s.runner_capabilities.clone());
    if runner(&before) != runner(&settings) {
        crate::runner::settings_changed(app);
    }
    Ok(())
}

/// Turns opening at sign-in on or off, with the system.
pub fn open_at_login(app: &AppHandle, on: bool) -> Result<(), String> {
    let autolaunch = app.autolaunch();
    let result = if on { autolaunch.enable() } else { autolaunch.disable() };
    result.map_err(|error| error.to_string())
}

/// Steps the zoom in (1), out (-1), or back to as it is (0).
pub fn zoom(app: &AppHandle, step: i32) {
    let mut settings = config::settings(app);
    let at = ZOOMS.iter().position(|zoom| *zoom == Settings::clamp_zoom(settings.zoom)).unwrap_or(4);
    settings.zoom = match step {
        0 => 1.0,
        1 => ZOOMS[(at + 1).min(ZOOMS.len() - 1)],
        _ => ZOOMS[at.saturating_sub(1)],
    };
    let _ = apply(app, settings);
}

/// Whether this launch is the system's, at sign-in, and g1t should wait in the tray.
pub fn starts_hidden(app: &AppHandle) -> bool {
    std::env::args().any(|arg| arg == AT_LOGIN) && config::settings(app).start_hidden
}

/// What the settings window listens for: check for updates now.
pub const CHECK_EVENT: &str = "g1t-check-updates";
/// What it listens for: an update is downloaded, with its version.
pub const READY_EVENT: &str = "g1t-update-ready";

/// Opens the settings window, or brings it forward.
pub fn open(app: &AppHandle) {
    show(app, false);
}

/// "Check for updates…" in a menu: the settings window opens and checks,
/// and says what it found, the download included, in its Updates section.
pub fn open_and_check(app: &AppHandle) {
    show(app, true);
}

fn show(app: &AppHandle, check: bool) {
    if let Some(window) = app.get_webview_window(SETTINGS) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        if check {
            let _ = app.emit_to(SETTINGS, CHECK_EVENT, ());
        }
        return;
    }
    // A window still loading has no listener yet: the address asks instead.
    let page = if check { "settings.html?check" } else { "settings.html" };
    let custom = crate::frame::started(app);
    let builder = WebviewWindowBuilder::new(app, SETTINGS, WebviewUrl::App(page.into()))
        .title("g1t settings");
    let built = crate::frame::dialog(builder, custom)
        .inner_size(620.0, 720.0)
        .min_inner_size(440.0, 420.0)
        .maximizable(false)
        .minimizable(false)
        .center()
        // The page is bundled with the app; its links go to the browser (settings.js).
        .on_navigation(config::is_launcher)
        .build();
    match built {
        Ok(window) => {
            let _ = window.set_focus();
        }
        Err(error) => eprintln!("g1t: the settings window could not open: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::Settings;

    #[test]
    fn a_missing_setting_is_its_default() {
        let settings: Settings = serde_json::from_str(r#"{"closeToTray":false}"#).unwrap();
        assert!(!settings.close_to_tray);
        assert!(settings.notifications);
        assert_eq!(settings.zoom, 1.0);
        // The runner is on, and sandboxed, for someone who never chose.
        assert!(settings.runner);
        assert_eq!(settings.runner_backend, crate::runner::Backend::Sandboxed);
        let chosen: Settings = serde_json::from_str(r#"{"runner":false,"runnerBackend":"host","runnerWorkspace":"acme"}"#).unwrap();
        assert!(!chosen.runner);
        assert_eq!(chosen.runner_backend, crate::runner::Backend::Host);
        assert_eq!(chosen.runner_workspace.as_deref(), Some("acme"));
        // Every kind of job is on until someone stops one; a kind left out is on.
        assert!(chosen.runner_capabilities.on("linux") && chosen.runner_capabilities.on("windows"));
        let one_off: Settings = serde_json::from_str(r#"{"runnerCapabilities":{"windows":false}}"#).unwrap();
        assert!(one_off.runner_capabilities.on("linux"));
        assert!(!one_off.runner_capabilities.on("windows"));
        let mut kinds = one_off.runner_capabilities.clone();
        assert!(kinds.set("windows", true) && kinds.on("windows"));
        assert!(!kinds.set("plan9", false));
    }

    #[test]
    fn zoom_is_one_the_app_offers() {
        assert_eq!(Settings::clamp_zoom(1.07), 1.1);
        assert_eq!(Settings::clamp_zoom(9.0), 2.0);
        assert_eq!(Settings::clamp_zoom(0.1), 0.67);
    }
}
