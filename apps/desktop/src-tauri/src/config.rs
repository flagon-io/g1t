//! What the app keeps between launches, and what it knows while running.
//!
//! The server, `https://g1t.sh` unless someone runs a g1t of their own,
//! and the app's own settings (settings.rs) are kept in `desktop.json` in
//! the app's config folder (`~/.config/sh.g1t.desktop` on Linux,
//! `~/Library/Application Support/sh.g1t.desktop` on macOS,
//! `%APPDATA%\sh.g1t.desktop` on Windows). The server's pages are the only
//! remote pages allowed to talk to the app (`allow_site`).

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::ipc::CapabilityBuilder;
use tauri::{AppHandle, Manager};
use url::Url;

use crate::WINDOW;

pub const DEFAULT_SERVER: &str = "https://g1t.sh";

/// What the running app knows: the server, where the window is, and what
/// the updater has ready.
#[derive(Default)]
pub struct State {
    /// The server, as an origin with a trailing slash: `https://g1t.sh/`.
    pub server: Mutex<Option<Url>>,
    /// The page the window last started loading.
    pub at: Mutex<Option<Url>>,
    /// Origins whose pages may call the app, each given its capability once.
    pub allowed: Mutex<Vec<String>>,
    /// An update downloaded and waiting to be installed, and its version.
    pub update: Mutex<Option<updates::Ready>>,
    /// When the updater last heard back from g1t.sh, in milliseconds since 1970.
    pub checked_at: Mutex<Option<u64>>,
    /// What the badge shows.
    pub waiting: Mutex<i64>,
    /// The app's own settings, as the settings window last left them.
    pub settings: Mutex<Settings>,
}

use crate::settings::Settings;
use crate::updates;

#[derive(Default, Serialize, Deserialize)]
struct File {
    #[serde(default)]
    server: Option<String>,
    #[serde(flatten)]
    settings: Settings,
}

fn path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join("desktop.json"))
}

/// A server as typed: http or https, with a host; only its origin is kept.
pub fn parse(text: &str) -> Option<Url> {
    let text = text.trim();
    let text = if text.contains("://") { text.to_string() } else { format!("https://{text}") };
    let mut url = Url::parse(&text).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return None;
    }
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(None);
    Some(url)
}

/// Reads the saved server, or takes g1t.sh, and the saved settings.
pub fn load(app: &AppHandle) {
    let file: File = path(app)
        .and_then(|path| fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let server = file.server.as_deref().and_then(parse).unwrap_or_else(|| Url::parse(DEFAULT_SERVER).expect("the default server is a URL"));
    let state = app.state::<State>();
    *state.server.lock().unwrap() = Some(server);
    *state.settings.lock().unwrap() = file.settings;
}

/// Writes the server and the settings as they are now.
fn save(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<State>();
    let file = File {
        server: state.server.lock().unwrap().as_ref().map(Url::to_string),
        settings: state.settings.lock().unwrap().clone(),
    };
    let path = path(app).ok_or("The app has no folder to keep its settings in.")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    }
    fs::write(&path, serde_json::to_vec_pretty(&file).map_err(|error| error.to_string())?).map_err(|error| error.to_string())
}

pub fn settings(app: &AppHandle) -> Settings {
    app.state::<State>().settings.lock().unwrap().clone()
}

/// Keeps new settings.
pub fn set_settings(app: &AppHandle, settings: Settings) -> Result<(), String> {
    *app.state::<State>().settings.lock().unwrap() = settings;
    save(app)
}

pub fn server(app: &AppHandle) -> Url {
    app.state::<State>()
        .server
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| Url::parse(DEFAULT_SERVER).expect("the default server is a URL"))
}

/// Saves a new server and lets its pages talk to the app.
pub fn set_server(app: &AppHandle, text: &str) -> Result<Url, String> {
    let server = parse(text).ok_or("That is not a web address. It looks like https://g1t.example.com.")?;
    *app.state::<State>().server.lock().unwrap() = Some(server.clone());
    save(app)?;
    allow_site(app).map_err(|error| error.to_string())?;
    Ok(server)
}

pub fn origin(url: &Url) -> String {
    url.origin().ascii_serialization()
}

/// Whether a page is the server's.
pub fn is_server(app: &AppHandle, url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https") && origin(url) == origin(&server(app))
}

/// Where the bundled pages are served under `tauri dev`: with no `devUrl`
/// in tauri.conf.json, the Tauri CLI serves `launcher/` itself, from
/// localhost, and the window starts there. Unset in a release build, which
/// serves them from inside the app.
static DEV_SERVER: std::sync::OnceLock<Option<Url>> = std::sync::OnceLock::new();

/// Notes the dev server, once, as the app starts.
pub fn note_dev_server(app: &AppHandle) {
    let dev = if cfg!(debug_assertions) { app.config().build.dev_url.clone() } else { None };
    let _ = DEV_SERVER.set(dev);
}

pub fn dev_server() -> Option<&'static Url> {
    DEV_SERVER.get().and_then(Option::as_ref)
}

/// Whether a page is the launcher, bundled with the app.
pub fn is_launcher(url: &Url) -> bool {
    url.scheme() == "tauri"
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"))
        || dev_server().is_some_and(|dev| origin(dev) == origin(url))
}

/// What the server's pages may call: the bridge's commands (bridge.rs).
const SITE: &[&str] = &[
    "core:event:allow-listen",
    "core:event:allow-unlisten",
    "allow-desktop-info",
    "allow-notify",
    "allow-set-badge",
    "allow-open-url",
    "allow-check-for-updates",
    "allow-open-settings",
    "allow-window-control",
    "allow-window-menu",
];

/// What GitHub's pages may call while someone signs in: the title bar's buttons.
const FRAME: &[&str] = &["allow-window-control", "allow-window-menu"];

/// Lets the server's pages call the app: a capability for its origin,
/// added once. Pages from anywhere else get no IPC at all, and bridge.rs
/// checks the caller again on every command.
pub fn allow_site(app: &AppHandle) -> tauri::Result<()> {
    let origin = origin(&server(app));
    let state = app.state::<State>();
    let mut allowed = state.allowed.lock().unwrap();
    if allowed.iter().any(|known| *known == origin) {
        return Ok(());
    }
    let mut site = CapabilityBuilder::new(format!("site-{}", allowed.len())).window(WINDOW).remote(format!("{origin}/*"));
    for permission in SITE {
        site = site.permission(*permission);
    }
    app.add_capability(site)?;
    // Signing in with GitHub: its pages get the title bar's buttons, and nothing else.
    if allowed.is_empty() {
        let mut sign_in = CapabilityBuilder::new("sign-in").window(WINDOW).remote("https://github.com/*".to_string());
        for permission in FRAME {
            sign_in = sign_in.permission(*permission);
        }
        app.add_capability(sign_in)?;
    }
    allowed.push(origin);
    Ok(())
}

/// The window started loading a page.
pub fn at(app: &AppHandle, url: Url) {
    *app.state::<State>().at.lock().unwrap() = Some(url);
}

/// Whether the window is on one of the server's pages now.
pub fn on_site(app: &AppHandle) -> bool {
    app.state::<State>().at.lock().unwrap().as_ref().is_some_and(|url| is_server(app, url))
}

#[cfg(test)]
mod tests {
    use super::parse;

    #[test]
    fn a_server_is_its_origin() {
        assert_eq!(parse("https://g1t.sh/acme/-/chat?x#y").unwrap().as_str(), "https://g1t.sh/");
        assert_eq!(parse("  g1t.example.com  ").unwrap().as_str(), "https://g1t.example.com/");
        assert_eq!(parse("http://localhost:5173/login").unwrap().as_str(), "http://localhost:5173/");
        assert!(parse("ftp://g1t.sh").is_none());
        assert!(parse("not a url").is_none());
        assert!(parse("").is_none());
    }
}
