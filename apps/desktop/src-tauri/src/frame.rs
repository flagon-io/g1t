//! The window's frame. g1t draws its own title bar, as Slack and Discord
//! do, so the window is all g1t and looks the same on every system: on
//! Windows and Linux the system's frame goes and the bar has the menu
//! button, back and forward, search, and minimize, maximize and close; on
//! macOS the bar sits under the window's own traffic lights. The bar
//! itself is bridge.js's, drawn on every page the window shows, the
//! site's, the launcher's, and GitHub's while signing in; the site makes
//! room for it (`--frame-top`, apps/web/app/app.css). Settings can give
//! the window back its system frame, and the menu bar with it, from the
//! next start: the bar is a script each window gets as it opens.

use tauri::{AppHandle, LogicalPosition, Manager, Runtime, WebviewWindow, WebviewWindowBuilder};

use crate::{WINDOW, config, tray};

/// The bar's height, in CSS pixels; bridge.js draws it this tall.
pub const HEIGHT: f64 = 36.0;

/// Whether g1t draws its own title bar, as the settings say now.
pub fn custom(app: &AppHandle) -> bool {
    !config::settings(app).system_title_bar
}

/// The title bar g1t started with, which its windows keep until it restarts.
static STARTED_CUSTOM: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

/// Whether this run draws g1t's own title bar: decided once, at the start.
pub fn started(app: &AppHandle) -> bool {
    *STARTED_CUSTOM.get_or_init(|| custom(app))
}

/// A window with g1t's title bar, or the system's.
pub fn style<'a, R: Runtime, M: Manager<R>>(builder: WebviewWindowBuilder<'a, R, M>, custom: bool) -> WebviewWindowBuilder<'a, R, M> {
    if !custom {
        return builder;
    }
    #[cfg(target_os = "macos")]
    {
        // The traffic lights stay, over the bar and centred in it.
        builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(LogicalPosition::new(14.0, (HEIGHT - 14.0) / 2.0))
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder.decorations(false)
    }
}

/// The main window's menu bar: shown under the system's frame, and kept
/// hidden under g1t's, whose menu button opens the same menu (`menu`) and
/// whose shortcuts still work.
pub fn menu_bar(window: &WebviewWindow, custom: bool) {
    let _ = if custom { window.hide_menu() } else { window.show_menu() };
    // GTK shows everything in a window each time the window is shown, the
    // hidden menu bar too, unless the menu bar is told to sit that out.
    #[cfg(target_os = "linux")]
    if let Ok(vbox) = window.default_vbox() {
        use gtk::prelude::*;
        for child in vbox.children().into_iter().filter(|child| child.is::<gtk::MenuBar>()) {
            child.set_no_show_all(custom);
        }
    }
}

/// What a button on the bar asks of the window it is in.
pub fn control(app: &AppHandle, window: &WebviewWindow, action: &str) -> Result<bool, String> {
    let main = window.label() == WINDOW;
    match action {
        "minimize" => window.minimize().map_err(|error| error.to_string())?,
        "maximize" => {
            let maximized = window.is_maximized().unwrap_or(false);
            let _ = if maximized { window.unmaximize() } else { window.maximize() };
        }
        "close" if main => tray::close(app),
        "close" => window.close().map_err(|error| error.to_string())?,
        "drag" => window.start_dragging().map_err(|error| error.to_string())?,
        "maximized" => {}
        other => return Err(format!("the window cannot {other}")),
    }
    Ok(window.is_maximized().unwrap_or(false))
}

/// The menu button: the window's menu, under the button.
pub fn menu(window: &WebviewWindow, x: f64, y: f64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let menu = window.app_handle().menu();
    #[cfg(not(target_os = "macos"))]
    let menu = window.menu();
    let menu = menu.ok_or("the window has no menu")?;
    window.popup_menu_at(&menu, LogicalPosition::new(x, y)).map_err(|error| error.to_string())
}
