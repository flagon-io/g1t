//! What the site may ask of the app: the commands behind `window.g1tDesktop`
//! (bridge.js), and the launcher's own.
//!
//! Every command checks who is asking. The site's commands answer only a
//! page of the configured server; the launcher's only the page bundled
//! with the app. A page from anywhere else gets nothing, whatever it
//! loads.

use serde::Serialize;
use tauri::{AppHandle, Webview};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use url::Url;

use crate::{badge, config, updates};

const SCRIPT: &str = include_str!("bridge.js");

/// The bridge, run at the start of every page the window loads.
pub fn script() -> String {
    SCRIPT.replace("__VERSION__", env!("CARGO_PKG_VERSION")).replace("__PLATFORM__", std::env::consts::OS)
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

fn from_either(app: &AppHandle, webview: &Webview) -> Result<(), String> {
    from_site(app, webview).or_else(|_| from_launcher(webview))
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
#[tauri::command]
pub async fn check_for_updates(app: AppHandle, webview: Webview) -> Result<String, String> {
    from_either(&app, &webview)?;
    updates::check(&app, true).await
}
