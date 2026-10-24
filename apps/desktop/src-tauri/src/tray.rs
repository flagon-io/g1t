//! The tray icon and its menu, and showing and hiding the window. Closing
//! the window hides it, unless settings say closing quits; g1t keeps
//! running for notifications, and the tray's Open, or the icon, brings it
//! back. The runner's state is a row of its own, which opens the runner's
//! menu under the title bar's dot, with Start or Stop under it
//! (runner/mod.rs). Quit is here too. The menu's rows are handled with the
//! app menu's (menu.rs).

use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Wry};

use crate::{config, updates};

pub const TRAY: &str = "g1t";

/// The menu rows that restart into a downloaded update, the tray's and
/// the Help menu's: off until one is.
static RESTART: Mutex<Vec<MenuItem<Wry>>> = Mutex::new(Vec::new());

/// The runner's rows: what it is doing, and Start or Stop.
static RUNNER: Mutex<Option<(MenuItem<Wry>, MenuItem<Wry>)>> = Mutex::new(None);

/// What g1t is doing as it goes, "Updating g1t…", said by the tooltip and
/// the restart rows until the process ends (updates.rs `leave`).
static LEAVING: Mutex<Option<String>> = Mutex::new(None);

/// A row that restarts into the update, kept so `update_ready` can turn it on.
pub fn restart_item(app: &AppHandle) -> tauri::Result<MenuItem<Wry>> {
    let item = MenuItem::with_id(app, "restart", "Restart to finish updating", false, None::<&str>)?;
    RESTART.lock().unwrap().push(item.clone());
    Ok(item)
}

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open g1t", true, None::<&str>)?;
    let check = MenuItem::with_id(app, "check", "Check for updates…", true, None::<&str>)?;
    let restart = restart_item(app)?;
    let runner_view = crate::runner::view(app);
    let runner = MenuItem::with_id(app, "runner-status", crate::runner::headline(&runner_view), true, None::<&str>)?;
    let runner_toggle = MenuItem::with_id(app, "runner-toggle", toggle_text(&runner_view), true, None::<&str>)?;
    *RUNNER.lock().unwrap() = Some((runner.clone(), runner_toggle.clone()));
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let server = MenuItem::with_id(app, "server", "Use another g1t…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit g1t", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &PredefinedMenuItem::separator(app)?,
            &runner,
            &runner_toggle,
            &PredefinedMenuItem::separator(app)?,
            &check,
            &restart,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &server,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let mut tray =
        TrayIconBuilder::with_id(TRAY).menu(&menu).show_menu_on_left_click(false).tooltip("g1t").on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn toggle_text(view: &crate::runner::View) -> &'static str {
    if view.enabled && !view.paused { "Stop running jobs" } else { "Start running jobs" }
}

/// The runner changed: its rows, and the icon's tooltip, say what it is doing now.
///
/// The change is handed to the main thread and not waited for: off the
/// main thread `set_text` waits for the main thread to make it, so the
/// runner's thread would stall on a busy window, and holding `RUNNER`
/// across it while the main thread came here too (the site's
/// `runner_offer`) froze the app, the window marked Not Responding.
pub fn runner_changed(app: &AppHandle, view: &crate::runner::View) {
    let headline = crate::runner::headline(view);
    let toggle_line = toggle_text(view);
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let rows = RUNNER.lock().unwrap().clone();
        if let Some((status, toggle)) = rows {
            let _ = status.set_text(&headline);
            let _ = toggle.set_text(toggle_line);
        }
        // Going, the tooltip says so, whatever the runner does meanwhile.
        if let Some(tray) = handle.tray_by_id(TRAY).filter(|_| LEAVING.lock().unwrap().is_none()) {
            let _ = tray.set_tooltip(Some(format!("g1t · {headline}")));
        }
    });
}

/// g1t is going: the tooltip and the restart rows say what it is doing,
/// "Updating g1t…", until the process ends; None, it stayed after all.
pub fn leaving(app: &AppHandle, doing: Option<String>) {
    *LEAVING.lock().unwrap() = doing.clone();
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let items = RESTART.lock().unwrap().clone();
        let ready = crate::updates::ready(&handle);
        for item in &items {
            let _ = match (&doing, &ready) {
                (Some(doing), _) => item.set_text(doing),
                (None, Some(version)) => item.set_text(format!("Restart to update to {version}")),
                (None, None) => item.set_text("Restart to finish updating"),
            };
            let _ = item.set_enabled(doing.is_none() && ready.is_some());
        }
        if let Some(tray) = handle.tray_by_id(TRAY) {
            // Back from `gone`, when the update didn't install.
            if doing.is_none() {
                let _ = tray.set_visible(true);
            }
            let _ = tray.set_tooltip(Some(doing.unwrap_or_else(|| "g1t".into())));
        }
    });
}

/// The moment before the process ends: the icon goes with it, rather than
/// staying in the tray until the pointer passes over it, as an icon whose
/// process ended does on Windows. Waits for the main thread to take it away.
pub fn gone(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id(TRAY) {
        let _ = tray.set_visible(false);
    }
}

/// The update is downloaded: the menus say so, and offer the restart.
pub fn update_ready(version: &str) {
    // Out of the lock first, as in runner_changed: this runs off the main thread.
    let items = RESTART.lock().unwrap().clone();
    for item in &items {
        let _ = item.set_text(format!("Restart to update to {version}"));
        let _ = item.set_enabled(true);
    }
}

pub fn show(app: &AppHandle) {
    if let Some(window) = crate::frame::window(app) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    if let Some(site) = crate::frame::site(app) {
        let _ = site.set_focus();
    }
}

/// The window was closed: it waits in the tray, or g1t quits, as settings say.
pub fn close(app: &AppHandle) {
    if config::settings(app).close_to_tray {
        hide(app);
    } else {
        let _ = updates::quit(app);
    }
}

pub fn hide(app: &AppHandle) {
    if let Some(window) = crate::frame::window(app) {
        let _ = window.hide();
    }
}

/// The address of the launcher page bundled with the app.
pub fn launcher_url(query: &str) -> url::Url {
    let base = if cfg!(windows) { "http://tauri.localhost/" } else { "tauri://localhost/" };
    let mut url = config::dev_server().cloned().unwrap_or_else(|| url::Url::parse(base).expect("the launcher's address is a URL"));
    url.set_path("/index.html");
    if !query.is_empty() {
        url.set_query(Some(query));
    }
    url
}

/// Takes the window to the launcher: `change` to choose another server.
pub fn launcher(app: &AppHandle, query: &str) {
    if let Some(site) = crate::frame::site(app) {
        let _ = site.navigate(launcher_url(query));
        show(app);
    }
}
