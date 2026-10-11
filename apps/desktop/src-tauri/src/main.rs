//! The g1t desktop app: g1t.sh, or a g1t of your own, in a window of its
//! own. The window loads the live site, so every change to g1t reaches it
//! the moment it is deployed and nothing here needs a new build for it;
//! only what is native lives in this program: notifications from the
//! system, a badge on the icon, a tray, `g1t://` links, the server to use,
//! and updates that install themselves (docs.g1t.sh/guides/desktop/).
//!
//! The site finds the app at `window.g1tDesktop` (bridge.js), the one
//! contract between the two; what the page asks of it is answered by the
//! commands in bridge.rs, each of which checks that the page asking is the
//! configured server's.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod badge;
mod bridge;
mod config;
mod links;
mod navigation;
mod tray;
mod updates;

use tauri::{RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_window_state::{StateFlags, WindowExt};

/// The one window's label.
pub const WINDOW: &str = "main";

fn main() {
    tauri::Builder::default()
        // A second launch (a g1t:// link, or the icon clicked again) goes to
        // the app already running: the link reaches links.rs through the
        // deep-link plugin, and the window comes forward.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| tray::show(app)))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .manage(config::State::default())
        .invoke_handler(tauri::generate_handler![
            bridge::desktop_info,
            bridge::notify,
            bridge::set_badge,
            bridge::open_url,
            bridge::reachable,
            bridge::set_server,
            bridge::check_for_updates,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            config::load(&handle);
            config::allow_site(&handle)?;
            let window = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("index.html".into()))
                .title("g1t")
                .inner_size(1280.0, 840.0)
                .min_inner_size(720.0, 480.0)
                .initialization_script(bridge::script())
                .on_navigation({
                    let handle = handle.clone();
                    move |url| navigation::allowed(&handle, url)
                })
                .on_page_load({
                    let handle = handle.clone();
                    move |_webview, payload| config::at(&handle, payload.url().clone())
                })
                .build()?;
            let _ = window.restore_state(StateFlags::all());
            // Closing the window keeps g1t running, for notifications; Quit in the tray ends it.
            window.on_window_event({
                let handle = handle.clone();
                move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        tray::hide(&handle);
                    }
                }
            });
            tray::install(&handle)?;
            links::install(&handle);
            updates::schedule(handle);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("g1t could not start")
        .run(|app, event| match event {
            // The dock icon, clicked while the window is hidden.
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => tray::show(app),
            // No window open is not a reason to quit: the tray is still there.
            RunEvent::ExitRequested { api, code: None, .. } => api.prevent_exit(),
            _ => {
                let _ = app;
            }
        });
}
