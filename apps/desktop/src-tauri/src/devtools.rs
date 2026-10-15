//! The web inspector, for the site's page in the window: off unless
//! someone turns on Developer tools in settings, for when a page goes
//! wrong and they want its console. With it on, View › Developer tools
//! (Ctrl+Shift+I, or ⌥⌘I on macOS), F12 on the page (bridge.js), and the
//! site's own `g1tDesktop.devtools.open()` open it; with it off, none of
//! them do anything.
//!
//! Release builds have the inspector only through Tauri's `devtools`
//! feature (Cargo.toml). Whether a web view has it at all is decided when
//! the web view is made. On Windows, WebView2 lets it change while running,
//! its own F12, Ctrl+Shift+I and Inspect with it, so the setting takes
//! effect at once. WebKit, on macOS and Linux, keeps what it was made with,
//! and its Inspect Element with it, until g1t restarts; the settings then
//! offer the restart, as they do for the title bar.

use std::sync::Mutex;

use tauri::menu::MenuItem;
use tauri::{AppHandle, Webview, Wry};

use crate::config;

/// Whether the setting is on now.
pub fn on(app: &AppHandle) -> bool {
    config::settings(app).developer_tools
}

/// Whether the site's web view was made with the inspector, which WebKit
/// keeps until g1t restarts: decided once, as it is made.
static STARTED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

/// Whether this run's site web view has the inspector.
pub fn started(app: &AppHandle) -> bool {
    *STARTED.get_or_init(|| on(app))
}

/// The setting differs from what the site's web view was made with, and
/// only a restart changes that: never on Windows, where it changes at once.
pub fn changed(app: &AppHandle) -> bool {
    !cfg!(windows) && started(app) != on(app)
}

/// The menu's Developer tools rows, kept so a change of the setting can
/// turn them on or off; a row that is off has no shortcut either.
static ITEMS: Mutex<Vec<MenuItem<Wry>>> = Mutex::new(Vec::new());

/// The menu row, with its shortcut: Ctrl+Shift+I, or ⌥⌘I on macOS.
pub fn item(app: &AppHandle) -> tauri::Result<MenuItem<Wry>> {
    let shortcut = if cfg!(target_os = "macos") { "Cmd+Alt+I" } else { "Ctrl+Shift+I" };
    let item = MenuItem::with_id(app, "devtools", "Developer tools", on(app), Some(shortcut))?;
    ITEMS.lock().unwrap().push(item.clone());
    Ok(item)
}

/// Whether the inspector opens now: the setting is on, and the site's web
/// view was made with it, or is WebView2's, which takes it at once.
pub fn usable(app: &AppHandle) -> bool {
    on(app) && !changed(app)
}

/// The setting changed: the menu rows follow it, and so does WebView2's
/// own way in. Turned off, an inspector that is open closes where the
/// system can close it (not on Windows, whose WebView2 has no way to).
pub fn setting_changed(app: &AppHandle) {
    let on = on(app);
    // Out of the lock first, as in tray::runner_changed: off the main thread
    // set_enabled waits for the main thread.
    let items = ITEMS.lock().unwrap().clone();
    for item in &items {
        let _ = item.set_enabled(usable(app));
    }
    allow(app, on);
    if !on && let Some(site) = crate::frame::site(app) {
        site.close_devtools();
    }
}

/// Lets WebView2 open the inspector, from its own F12, Ctrl+Shift+I and
/// Inspect as well as when g1t asks, or not. WebKit keeps what its web
/// view was made with.
#[cfg(windows)]
pub fn allow(app: &AppHandle, on: bool) {
    let Some(site) = crate::frame::site(app) else { return };
    let _ = site.with_webview(move |webview| {
        // SAFETY: the controller is the site's, alive while the web view is,
        // and this runs on the thread that owns it.
        let _ = unsafe { webview.controller().CoreWebView2().and_then(|core| core.Settings()).and_then(|settings| settings.SetAreDevToolsEnabled(on)) };
    });
}

#[cfg(not(windows))]
pub fn allow(_app: &AppHandle, _on: bool) {}

/// The site's web view, while the inspector opens: an error otherwise,
/// which the site's `devtools.open()` sees.
fn site_if_on(app: &AppHandle) -> Result<Webview, String> {
    if !on(app) {
        return Err("Developer tools are off. Turn them on in the app's settings, under Window.".into());
    }
    if changed(app) {
        return Err("Developer tools turn on when g1t restarts.".into());
    }
    crate::frame::site(app).ok_or_else(|| "g1t's page is not open".into())
}

/// Opens the inspector for the site's page.
pub fn open(app: &AppHandle) -> Result<(), String> {
    site_if_on(app)?.open_devtools();
    Ok(())
}

/// The menu row and the shortcuts: opens the inspector, or closes it if it
/// is open. WebView2 can't tell whether it is, nor close it, so on
/// Windows it only opens, and the inspector's own window closes it.
pub fn toggle(app: &AppHandle) -> Result<(), String> {
    let site = site_if_on(app)?;
    if site.is_devtools_open() { site.close_devtools() } else { site.open_devtools() }
    Ok(())
}
