//! The tray icon and its menu, and showing and hiding the window. Closing
//! the window hides it, unless settings say closing quits; g1t keeps
//! running for notifications, and the tray's Open, or the icon, brings it
//! back. Quit is here too. The menu's rows are handled with the app
//! menu's (menu.rs).

use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::{WINDOW, config, updates};

pub const TRAY: &str = "g1t";

/// The menu rows that restart into a downloaded update, the tray's and
/// the Help menu's: off until one is.
static RESTART: Mutex<Vec<MenuItem<Wry>>> = Mutex::new(Vec::new());

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
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let server = MenuItem::with_id(app, "server", "Use another g1t…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit g1t", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
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
    let mut tray = TrayIconBuilder::with_id(TRAY)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("g1t")
        .on_tray_icon_event(|tray, event| {
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

/// The update is downloaded: the menus say so, and offer the restart.
pub fn update_ready(version: &str) {
    for item in RESTART.lock().unwrap().iter() {
        let _ = item.set_text(format!("Restart to update to {version}"));
        let _ = item.set_enabled(true);
    }
}

pub fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// The window was closed: it waits in the tray, or g1t quits, as settings say.
pub fn close(app: &AppHandle) {
    if config::settings(app).close_to_tray {
        hide(app);
    } else {
        updates::quit(app);
    }
}

pub fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW) {
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
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.navigate(launcher_url(query));
        show(app);
    }
}
