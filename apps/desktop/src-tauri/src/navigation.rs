//! Where the window may go: the launcher, the server's pages, and the
//! pages that sign someone in there. Any other address opens in the
//! browser the system uses, and the window stays where it is.

use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use url::Url;

use crate::config;

/// Signing in with GitHub goes there and comes back.
const SIGN_IN_HOSTS: &[&str] = &["github.com", "www.github.com"];

/// Whether the window may load `url`.
pub fn allowed(app: &AppHandle, url: &Url) -> bool {
    match url.scheme() {
        "about" | "blob" | "data" => return true,
        "http" | "https" | "tauri" => {}
        _ => return false,
    }
    if config::is_launcher(url) || config::is_server(app, url) {
        return true;
    }
    if url.host_str().is_some_and(|host| SIGN_IN_HOSTS.contains(&host)) {
        return true;
    }
    let _ = app.opener().open_url(url.as_str(), None::<&str>);
    false
}
