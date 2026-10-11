//! The tray icon and its menu, and showing and hiding the window. Closing
//! the window hides it; g1t keeps running for notifications, and the
//! tray's Open, or the icon, brings it back. Quit is here too.

use std::sync::OnceLock;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::{WINDOW, updates};

pub const TRAY: &str = "g1t";

/// The menu row that restarts into a downloaded update: off until one is.
static RESTART: OnceLock<MenuItem<Wry>> = OnceLock::new();

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open g1t", true, None::<&str>)?;
    let check = MenuItem::with_id(app, "check", "Check for updates…", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "Restart to finish updating", false, None::<&str>)?;
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
            &server,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let _ = RESTART.set(restart);
    let mut tray = TrayIconBuilder::with_id(TRAY)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("g1t")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show(app),
            "check" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = updates::check(&app, true).await;
                });
            }
            "restart" => updates::restart(app),
            "server" => launcher(app, "change"),
            "quit" => updates::quit(app),
            _ => {}
        })
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

/// The update is downloaded: the menu says so, and offers the restart.
pub fn update_ready(version: &str) {
    if let Some(item) = RESTART.get() {
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

pub fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.hide();
    }
}

/// The address of the launcher page bundled with the app.
pub fn launcher_url(query: &str) -> url::Url {
    let base = if cfg!(windows) { "http://tauri.localhost/" } else { "tauri://localhost/" };
    let mut url = url::Url::parse(base).expect("the launcher's address is a URL");
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
