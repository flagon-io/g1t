//! The app's menu: File, Edit, View, Go, Window and Help, as a desktop app
//! has. On macOS it is the menu bar at the top of the screen, with g1t's
//! own menu first; on Windows and Linux it sits under the window's title,
//! and settings can hide it. The tray's menu (tray.rs) shares its ids, and
//! every menu event, from either, comes to `handle`.

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Wry};
use tauri_plugin_opener::OpenerExt;

use crate::{links, settings, tray, updates};

const DOCS: &str = "https://docs.g1t.sh/guides/desktop/";
const STATUS: &str = "https://status.g1t.sh/";

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let separator = || PredefinedMenuItem::separator(app);
    let item = |id: &str, text: &str, accelerator: Option<&str>| MenuItem::with_id(app, id, text, true, accelerator);

    let settings_item = item("settings", if cfg!(target_os = "macos") { "Settings…" } else { "Settings" }, Some("CmdOrCtrl+,"))?;
    let check = item("check", "Check for updates…", None)?;
    let server = item("server", "Use another g1t…", None)?;
    let quit = item("quit", "Quit g1t", Some("CmdOrCtrl+Q"))?;

    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &separator()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &item("reload", "Reload", Some("CmdOrCtrl+R"))?,
            &separator()?,
            &item("zoom-reset", "Actual size", Some("CmdOrCtrl+0"))?,
            &item("zoom-in", "Zoom in", Some("CmdOrCtrl+="))?,
            &item("zoom-out", "Zoom out", Some("CmdOrCtrl+-"))?,
            &separator()?,
            &PredefinedMenuItem::fullscreen(app, None)?,
            &separator()?,
            &crate::devtools::item(app)?,
        ],
    )?;
    let go = Submenu::with_items(
        app,
        "Go",
        true,
        &[
            &item("back", "Back", Some(if cfg!(target_os = "macos") { "Cmd+[" } else { "Alt+Left" }))?,
            &item("forward", "Forward", Some(if cfg!(target_os = "macos") { "Cmd+]" } else { "Alt+Right" }))?,
            &separator()?,
            &item("home", "Home", None)?,
            &item("notifications", "Notifications", None)?,
        ],
    )?;
    let window =
        Submenu::with_items(app, "Window", true, &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, None)?])?;
    let help = Submenu::with_items(
        app,
        "Help",
        true,
        &[
            &item("docs", "Desktop app guide", None)?,
            &item("status", "g1t.sh status", None)?,
            &separator()?,
            &check,
            &tray::restart_item(app)?,
        ],
    )?;
    // macOS keeps About in g1t's own menu; elsewhere it closes Help.
    #[cfg(not(target_os = "macos"))]
    {
        help.append(&separator()?)?;
        help.append(&PredefinedMenuItem::about(app, Some("About g1t"), Some(about()))?)?;
    }

    #[cfg(target_os = "macos")]
    {
        let g1t = Submenu::with_items(
            app,
            "g1t",
            true,
            &[
                &PredefinedMenuItem::about(app, Some("About g1t"), Some(about()))?,
                &separator()?,
                &settings_item,
                &server,
                &separator()?,
                &PredefinedMenuItem::services(app, None)?,
                &separator()?,
                &PredefinedMenuItem::hide(app, None)?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &PredefinedMenuItem::show_all(app, None)?,
                &separator()?,
                &quit,
            ],
        )?;
        let file = Submenu::with_items(app, "File", true, &[&PredefinedMenuItem::close_window(app, None)?])?;
        Menu::with_items(app, &[&g1t, &file, &edit, &view, &go, &window, &help])
    }
    #[cfg(not(target_os = "macos"))]
    {
        let file = Submenu::with_items(
            app,
            "File",
            true,
            &[&settings_item, &server, &separator()?, &item("close", "Close window", Some("CmdOrCtrl+W"))?, &quit],
        )?;
        Menu::with_items(app, &[&file, &edit, &view, &go, &window, &help])
    }
}

fn about() -> AboutMetadata<'static> {
    AboutMetadata {
        name: Some("g1t".into()),
        version: Some(env!("CARGO_PKG_VERSION").into()),
        copyright: Some("Flagon, Inc.".into()),
        website: Some("https://g1t.sh".into()),
        website_label: Some("g1t.sh".into()),
        ..Default::default()
    }
}

/// Runs the script on the main window's page.
fn eval(app: &AppHandle, script: &str) {
    if let Some(site) = crate::frame::site(app) {
        let _ = site.eval(script);
    }
}

/// A menu row was chosen, from the app's menu or the tray's.
pub fn handle(app: &AppHandle, id: &str) {
    match id {
        "open" => tray::show(app),
        "settings" => settings::open(app),
        "runner-status" => settings::runner_menu(app, false, None),
        "runner-toggle" => crate::runner::toggle(app),
        "server" => tray::launcher(app, "change"),
        // The settings ask, and show the answer where it cannot be missed.
        "check" => settings::open_and_check(app),
        "restart" => {
            let _ = updates::restart(app);
        }
        "quit" => {
            let _ = updates::quit(app);
        }
        "close" => tray::close(app),
        "reload" => {
            if let Some(site) = crate::frame::site(app) {
                let _ = site.reload();
            }
        }
        "zoom-in" => settings::zoom(app, 1),
        "zoom-out" => settings::zoom(app, -1),
        "zoom-reset" => settings::zoom(app, 0),
        // Off with the setting, as the row is.
        "devtools" => {
            let _ = crate::devtools::toggle(app);
        }
        "back" => eval(app, "history.back()"),
        "forward" => eval(app, "history.forward()"),
        "home" => links::go(app, "/"),
        "notifications" => links::go(app, "/notifications"),
        "docs" => {
            let _ = app.opener().open_url(DOCS, None::<&str>);
        }
        "status" => {
            let _ = app.opener().open_url(STATUS, None::<&str>);
        }
        _ => {}
    }
}
