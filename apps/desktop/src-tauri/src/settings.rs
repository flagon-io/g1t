//! The app's own settings: how it starts, what closing the window does,
//! how it tells the person something arrived, its title bar, zoom, the
//! web inspector, updates, and the runner. They open as a dialog over the site, which the
//! site's page draws (apps/web components/desktop-settings.tsx), from the
//! title bar, the menu, the tray, or the site's account menu. While the
//! window shows no page of the site's (the launcher, the offline page,
//! signing in), they open in a window of their own instead
//! (`launcher/settings.html`). They are kept with the server in
//! `desktop.json` (config.rs). Whether g1t opens when someone signs in to
//! their computer is kept by the system itself, through the autostart
//! plugin, and read back from it.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, EventTarget, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt;

use crate::config;

/// The settings window's label: the settings when the site can't draw them.
pub const SETTINGS: &str = "settings";
/// The Runner window's label: the runner on its own (launcher/runner.html),
/// when the site can't draw its menu under the title bar's dot.
pub const RUNNER: &str = "runner";

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
    /// The web inspector for the site's page, from the View menu, F12 and
    /// Ctrl+Shift+I (⌥⌘I on macOS); off unless someone turns it on
    /// (devtools.rs). On macOS and Linux it takes effect when g1t restarts.
    pub developer_tools: bool,
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
            developer_tools: false,
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
    /// The developer tools setting differs from the one the site's page
    /// has, on macOS and Linux: a restart applies it (devtools.rs).
    pub developer_tools_changed: bool,
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
        developer_tools_changed: crate::devtools::changed(app),
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
    if before.developer_tools != settings.developer_tools {
        crate::devtools::setting_changed(app);
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
/// What the site's page listens for: open the settings dialog (`Opening`).
pub const OPEN_EVENT: &str = "g1t-open-settings";
/// What the site's page listens for: the runner menu under the title
/// bar's dot (`RunnerMenu`).
pub const RUNNER_MENU_EVENT: &str = "g1t-runner-menu";

/// The settings dialog, opened at a section (`runner`, `updates`), and
/// looking for updates as it opens when `check` is set.
#[derive(Clone, Debug, Serialize)]
pub struct Opening {
    pub section: Option<&'static str>,
    pub check: bool,
}

/// The runner menu: `toggle`, from the dot, or `open`. `at` is where the
/// dot is across the bar, as a share of its width, so the menu hangs under
/// it whatever the site's zoom.
#[derive(Clone, Debug, Serialize)]
pub struct RunnerMenu {
    pub action: &'static str,
    pub at: Option<f64>,
}

/// Whether the site's page can draw the settings and the runner menu
/// itself: the window is on one of the server's pages, and that page said
/// it can (`site_ready` in bridge.rs). A page of an older site never says
/// so, and they open in windows of their own, as they did.
fn in_site(app: &AppHandle) -> bool {
    config::on_site(app) && config::site_ready(app)
}

/// Opens the settings, or brings them forward.
pub fn open(app: &AppHandle) {
    open_at(app, None, false);
}

/// "Check for updates…" in a menu: the settings open at Updates and check,
/// and say what they found, the download included.
pub fn open_and_check(app: &AppHandle) {
    open_at(app, Some("updates"), true);
}

/// The settings at their Runner section: how jobs run, the workspace, each
/// kind of job. A fix that asks the person to choose one opens them there.
pub fn open_runner_settings(app: &AppHandle) {
    if in_site(app) {
        open_at(app, Some("runner"), false);
    } else {
        open_runner_window(app);
    }
}

/// The settings over the site, the main window shown if it was hidden; in
/// a window of their own while the site isn't there to draw them.
fn open_at(app: &AppHandle, section: Option<&'static str>, check: bool) {
    if in_site(app) {
        crate::tray::show(app);
        let _ = app.emit_to(EventTarget::webview(crate::frame::SITE), OPEN_EVENT, Opening { section, check });
        return;
    }
    show(app, check);
}

/// The runner menu, opened (the tray's runner row) or, from the title
/// bar's dot, opened or closed. While the site can't draw it, the Runner
/// window.
pub fn runner_menu(app: &AppHandle, toggle: bool, at: Option<f64>) {
    if in_site(app) {
        crate::tray::show(app);
        let at = at.filter(|at| at.is_finite()).map(|at| at.clamp(0.0, 1.0));
        let menu = RunnerMenu { action: if toggle { "toggle" } else { "open" }, at };
        let _ = app.emit_to(EventTarget::webview(crate::frame::SITE), RUNNER_MENU_EVENT, menu);
        return;
    }
    open_runner_window(app);
}

/// Opens the Runner window, or brings it forward.
pub fn open_runner_window(app: &AppHandle) {
    if !forward(app, RUNNER) {
        made_aside(app, Window { label: RUNNER, page: "runner.html", title: "g1t runner", size: (720.0, 760.0) });
    }
}

/// Brings a window that is open forward: false when it isn't.
fn forward(app: &AppHandle, label: &str) -> bool {
    let Some(window) = app.get_webview_window(label) else { return false };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    true
}

fn show(app: &AppHandle, check: bool) {
    if forward(app, SETTINGS) {
        if check {
            let _ = app.emit_to(SETTINGS, CHECK_EVENT, ());
        }
        return;
    }
    // A window still loading has no listener yet: the address asks instead.
    let page = if check { "settings.html?check" } else { "settings.html" };
    made_aside(app, Window { label: SETTINGS, page, title: "g1t settings", size: (620.0, 720.0) });
}

/// A window of the app's own pages.
struct Window {
    label: &'static str,
    page: &'static str,
    title: &'static str,
    size: (f64, f64),
}

/// Makes a window on a thread of its own, whoever asks. The app's windows
/// open from synchronous commands too (the title bar's buttons, the site's
/// account menu), which run on the main thread, and on Windows a window
/// made there deadlocks: it appears, white, and its page never loads. From
/// another thread, Tauri hands the making to the event loop and waits.
fn made_aside(app: &AppHandle, window: Window) {
    let app = app.clone();
    let spawned = std::thread::Builder::new().name(format!("g1t-{}-window", window.label)).spawn(move || build(&app, &window));
    if let Err(error) = spawned {
        eprintln!("g1t: a window could not open: {error}");
    }
}

fn build(app: &AppHandle, window: &Window) {
    let custom = crate::frame::started(app);
    let builder = WebviewWindowBuilder::new(app, window.label, WebviewUrl::App(window.page.into()))
        .title(window.title);
    let built = crate::frame::dialog(builder, custom)
        .inner_size(window.size.0, window.size.1)
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
        Err(error) => eprintln!("g1t: the {} window could not open: {error}", window.label),
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
        // The web inspector is off for someone who never turned it on.
        assert!(!settings.developer_tools);
        let developer: Settings = serde_json::from_str(r#"{"developerTools":true}"#).unwrap();
        assert!(developer.developer_tools);
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
