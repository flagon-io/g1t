//! What the site may ask of the app: the commands behind `window.g1tDesktop`
//! (bridge.js), and the launcher's own.
//!
//! Every command checks who is asking. The site's commands answer only a
//! page of the configured server; the launcher's only the page bundled
//! with the app. A page from anywhere else gets nothing, whatever it
//! loads.

use serde::Serialize;
use tauri::{AppHandle, Manager, UserAttentionType, Webview};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use url::Url;

use crate::settings::{self, Settings};
use crate::{WINDOW, badge, config, updates};

const SCRIPT: &str = include_str!("bridge.js");

/// The bridge, run at the start of every page a window loads: `window` is
/// its label, and `custom` whether it draws g1t's title bar (frame.rs).
pub fn script(window: &str, custom: bool) -> String {
    SCRIPT
        .replace("__WINDOW__", window)
        .replace("__FRAME__", if custom { "custom" } else { "system" })
        .replace("\"__HEIGHT__\"", &crate::frame::HEIGHT.to_string())
        .replace("__VERSION__", env!("CARGO_PKG_VERSION"))
        .replace("__PLATFORM__", std::env::consts::OS)
        .replace("\"__OUTSIDE__\"", &serde_json::to_string(crate::navigation::OUTSIDE).expect("a list of paths is JSON"))
}

/// What the site and the launcher learn about the app.
#[derive(Serialize)]
pub struct Info {
    pub version: String,
    pub platform: String,
    pub server: String,
    /// The version downloaded and waiting for a restart, if one is.
    pub update_ready: Option<String>,
}

fn caller(webview: &Webview) -> Result<Url, String> {
    webview.url().map_err(|error| error.to_string())
}

/// The page asking is one of the server's.
fn from_site(app: &AppHandle, webview: &Webview) -> Result<(), String> {
    let url = caller(webview)?;
    if config::is_server(app, &url) { Ok(()) } else { Err("only g1t's own pages may ask that".into()) }
}

/// The page asking is the launcher.
fn from_launcher(webview: &Webview) -> Result<(), String> {
    let url = caller(webview)?;
    if config::is_launcher(&url) { Ok(()) } else { Err("only the launcher may ask that".into()) }
}

/// The page asking is the settings window's, bundled with the app.
fn from_settings(webview: &Webview) -> Result<(), String> {
    from_launcher(webview)?;
    if webview.label() == settings::SETTINGS { Ok(()) } else { Err("only the settings window may ask that".into()) }
}

fn from_either(app: &AppHandle, webview: &Webview) -> Result<(), String> {
    from_site(app, webview).or_else(|_| from_launcher(webview))
}

/// The page asking is one the title bar is drawn on: the site's, the
/// app's own, or GitHub's while signing in.
fn from_frame(app: &AppHandle, webview: &Webview) -> Result<(), String> {
    let url = caller(webview)?;
    if config::is_server(app, &url) || config::is_launcher(&url) || crate::navigation::signing_in(&url) {
        Ok(())
    } else {
        Err("only g1t's own pages may ask that".into())
    }
}

#[tauri::command]
pub fn desktop_info(app: AppHandle, webview: Webview) -> Result<Info, String> {
    from_either(&app, &webview)?;
    Ok(Info {
        version: env!("CARGO_PKG_VERSION").into(),
        platform: std::env::consts::OS.into(),
        server: config::server(&app).to_string(),
        update_ready: updates::ready(&app),
    })
}

/// A notification from the system: the site asks for one when a message
/// is for the person and the window is behind another.
#[tauri::command]
pub fn notify(app: AppHandle, webview: Webview, title: String, body: String) -> Result<(), String> {
    from_site(&app, &webview)?;
    let settings = config::settings(&app);
    if let Some(window) = app.get_webview_window(WINDOW).filter(|window| settings.flash && !window.is_focused().unwrap_or(false)) {
        let _ = window.request_user_attention(Some(UserAttentionType::Informational));
    }
    if !settings.notifications {
        return Ok(());
    }
    app.notification().builder().title(title).body(body).show().map_err(|error| error.to_string())
}

/// What needs the person, on the icon and the tray; 0 clears it.
#[tauri::command]
pub fn set_badge(app: AppHandle, webview: Webview, count: i64) -> Result<(), String> {
    from_site(&app, &webview)?;
    badge::set(&app, count.max(0));
    Ok(())
}

/// A link to somewhere else, opened in the browser the system uses.
#[tauri::command]
pub fn open_url(app: AppHandle, webview: Webview, url: String) -> Result<(), String> {
    from_either(&app, &webview)?;
    let parsed = Url::parse(&url).map_err(|error| error.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https" | "mailto") {
        return Err(format!("{} links stay in the app", parsed.scheme()));
    }
    app.opener().open_url(parsed.as_str(), None::<&str>).map_err(|error| error.to_string())
}

/// Whether a server answers at all: the launcher asks before the window
/// goes there, so a machine with no network sees a page of ours, not the
/// web view's own error.
#[tauri::command]
pub async fn reachable(app: AppHandle, webview: Webview, url: Option<String>) -> Result<bool, String> {
    from_launcher(&webview)?;
    let target = match url {
        Some(text) => config::parse(&text).ok_or("That is not a web address.")?,
        None => config::server(&app),
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(6))
        .build()
        .map_err(|error| error.to_string())?;
    Ok(client.head(target).send().await.is_ok())
}

/// The launcher chose a server: it is kept, and the window goes there next.
#[tauri::command]
pub fn set_server(app: AppHandle, webview: Webview, url: String) -> Result<String, String> {
    from_launcher(&webview)?;
    config::set_server(&app, &url).map(|server| server.to_string())
}

/// Looks for an update now: `current`, `ready:<version>`, or an error.
/// The settings window shows the answer itself; anyone else asking is also
/// told with a notification.
#[tauri::command]
pub async fn check_for_updates(app: AppHandle, webview: Webview) -> Result<String, String> {
    from_either(&app, &webview)?;
    updates::check(&app, webview.label() != settings::SETTINGS).await
}

/// A title bar button: `minimize`, `maximize` (which toggles), `close`,
/// `drag`, or `maximized` to ask. Answers whether the window is maximized.
#[tauri::command]
pub fn window_control(app: AppHandle, webview: Webview, action: String) -> Result<bool, String> {
    from_frame(&app, &webview)?;
    let window = app.get_webview_window(webview.label()).ok_or("no such window")?;
    crate::frame::control(&app, &window, &action)
}

/// The title bar's menu button: the app's menu, at that place in the window.
#[tauri::command]
pub fn window_menu(app: AppHandle, webview: Webview, x: f64, y: f64) -> Result<(), String> {
    from_frame(&app, &webview)?;
    let window = app.get_webview_window(WINDOW).filter(|_| webview.label() == WINDOW).ok_or("only the main window has a menu")?;
    crate::frame::menu(&window, x, y)
}

/// Restarts g1t, installing a downloaded update on the way: the settings
/// window offers it after a change that needs one.
#[tauri::command]
pub fn restart(app: AppHandle, webview: Webview) -> Result<(), String> {
    from_settings(&webview)?;
    if updates::ready(&app).is_some() {
        updates::restart(&app);
    }
    app.restart()
}

/// The settings window's "Restart now": installs the downloaded update and starts it.
#[tauri::command]
pub fn restart_to_update(app: AppHandle, webview: Webview) -> Result<(), String> {
    from_settings(&webview)?;
    updates::restart(&app);
    Ok(())
}

/// Opens the app's settings window: the site's account menu asks for it.
#[tauri::command]
pub fn open_settings(app: AppHandle, webview: Webview) -> Result<(), String> {
    from_either(&app, &webview)?;
    settings::open(&app);
    Ok(())
}

/// What the settings window shows.
#[tauri::command]
pub fn get_settings(app: AppHandle, webview: Webview) -> Result<settings::View, String> {
    from_settings(&webview)?;
    Ok(settings::view(&app))
}

/// The settings window changed something: everything but opening at sign-in.
#[tauri::command]
pub fn save_settings(app: AppHandle, webview: Webview, settings: Settings) -> Result<settings::View, String> {
    from_settings(&webview)?;
    settings::apply(&app, settings)?;
    Ok(settings::view(&app))
}

/// Opening at sign-in, which the system keeps.
#[tauri::command]
pub fn set_open_at_login(app: AppHandle, webview: Webview, on: bool) -> Result<settings::View, String> {
    from_settings(&webview)?;
    settings::open_at_login(&app, on)?;
    Ok(settings::view(&app))
}

/// The settings window's "Change…": the main window goes to the launcher's choice of server.
#[tauri::command]
pub fn change_server(app: AppHandle, webview: Webview) -> Result<(), String> {
    from_settings(&webview)?;
    if let Some(window) = app.get_webview_window(settings::SETTINGS) {
        let _ = window.close();
    }
    crate::tray::launcher(&app, "change");
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_bridge_has_nothing_left_to_fill_in() {
        let script = super::script("main", true);
        for placeholder in ["__VERSION__", "__PLATFORM__", "__OUTSIDE__", "__WINDOW__", "__FRAME__", "__HEIGHT__"] {
            assert!(!script.contains(placeholder), "{placeholder} is left in the bridge");
        }
        assert!(script.contains(r#"var HEIGHT = 36;"#) && script.contains(r#"var FRAME = "custom";"#));
        assert!(super::script("settings", false).contains(r#"var FRAME = "system";"#));
        assert!(script.contains(r#"var OUTSIDE = ["/pricing""#));
    }
}
