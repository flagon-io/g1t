//! `g1t://` links. `g1t://acme/-/chat/dm/chn_1` opens that page on the
//! server: the site, when the window is on it, is told the path and moves
//! without a reload; otherwise the window loads the page. A link that
//! started the app is read on the way up; one that arrives while it runs
//! comes through the deep-link plugin, from a second launch too.

use tauri::{AppHandle, Emitter, EventTarget};
use tauri_plugin_deep_link::DeepLinkExt;
use url::Url;

use crate::{config, frame, tray};

/// What the page listens for (bridge.js).
pub const EVENT: &str = "g1t-navigate";

pub fn install(app: &AppHandle) {
    // Installers register the scheme; a build run from the source tree,
    // and an AppImage, need it done here.
    #[cfg(any(windows, target_os = "linux"))]
    let _ = app.deep_link().register_all();
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            open(&handle, &url);
        }
    });
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        for url in urls {
            open(app, &url);
        }
    }
}

/// The site path a link names: `g1t://acme/-/chat?x` is `/acme/-/chat?x`.
pub fn path_of(url: &Url) -> Option<String> {
    if url.scheme() != "g1t" {
        return None;
    }
    let mut path = match url.host_str() {
        Some(host) if !host.is_empty() => format!("/{host}{}", url.path()),
        _ => url.path().to_string(),
    };
    if path.is_empty() || !path.starts_with('/') {
        path.insert(0, '/');
    }
    if let Some(query) = url.query() {
        path.push('?');
        path.push_str(query);
    }
    Some(path)
}

pub fn open(app: &AppHandle, url: &Url) {
    if let Some(path) = path_of(url) {
        go(app, &path);
    }
}

/// Takes the window to a path on the server.
pub fn go(app: &AppHandle, path: &str) {
    tray::show(app);
    if config::on_site(app) {
        let _ = app.emit_to(EventTarget::webview(frame::SITE), EVENT, path.to_string());
        return;
    }
    if let (Some(site), Ok(target)) = (frame::site(app), config::server(app).join(path.trim_start_matches('/'))) {
        let _ = site.navigate(target);
    }
}

#[cfg(test)]
mod tests {
    use super::path_of;
    use url::Url;

    #[test]
    fn a_link_names_a_site_path() {
        let path = |text: &str| path_of(&Url::parse(text).unwrap());
        assert_eq!(path("g1t://acme/-/chat/dm/chn_1").as_deref(), Some("/acme/-/chat/dm/chn_1"));
        assert_eq!(path("g1t://acme/hello/pull/4?tab=files").as_deref(), Some("/acme/hello/pull/4?tab=files"));
        assert_eq!(path("g1t://notifications").as_deref(), Some("/notifications"));
        assert_eq!(path("https://g1t.sh/acme"), None);
    }
}
