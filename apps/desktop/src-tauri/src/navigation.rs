//! Where the window may go: the launcher, the server's pages, and the
//! pages that sign someone in there. Any other address opens in the
//! browser the system uses, and the window stays where it is. So do the
//! server's pages for reading about g1t rather than using it (`OUTSIDE`):
//! the window is for working in, the browser for browsing. bridge.js
//! sends the same pages out when a link inside the site goes to one.

use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use url::Url;

use crate::config;

/// Signing in with GitHub goes there and comes back.
const SIGN_IN_HOSTS: &[&str] = &["github.com", "www.github.com"];

/// The server's pages that open in the browser: pricing, policies,
/// security, support, the desktop app's own downloads, and status. An
/// entry ending in `/` is every page under it.
pub const OUTSIDE: &[&str] = &["/pricing", "/policies", "/policies/", "/security", "/support", "/download", "/downloads/", "/status"];

/// Whether a path on the server is one for the browser.
pub fn outside(path: &str) -> bool {
    let path = if path.len() > 1 { path.trim_end_matches('/') } else { path };
    OUTSIDE.iter().any(|page| if page.ends_with('/') { path.starts_with(page) } else { path == *page })
}

/// Whether the window may load `url`.
pub fn allowed(app: &AppHandle, url: &Url) -> bool {
    match url.scheme() {
        "about" | "blob" | "data" => return true,
        "http" | "https" | "tauri" => {}
        _ => return false,
    }
    if config::is_launcher(url) || (config::is_server(app, url) && !outside(url.path())) {
        return true;
    }
    if url.host_str().is_some_and(|host| SIGN_IN_HOSTS.contains(&host)) {
        return true;
    }
    let _ = app.opener().open_url(url.as_str(), None::<&str>);
    false
}

#[cfg(test)]
mod tests {
    use super::outside;

    #[test]
    fn reading_about_g1t_is_for_the_browser() {
        assert!(outside("/pricing"));
        assert!(outside("/pricing/"));
        assert!(outside("/policies/terms"));
        assert!(outside("/downloads/desktop/latest.json"));
        assert!(!outside("/"));
        assert!(!outside("/login"));
        assert!(!outside("/acme/-/chat"));
        assert!(!outside("/pricingx"));
        assert!(!outside("/acme/security"));
    }
}
