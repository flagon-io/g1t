//! The g1t desktop app: g1t.sh, or a g1t of your own, in a window of its
//! own. The window loads the live site, so every change to g1t reaches it
//! the moment it is deployed and nothing here needs a new build for it;
//! only what is native lives in this program: notifications from the
//! system, a badge on the icon, a tray, a menu, `g1t://` links, the server
//! to use, the app's own settings, updates that install themselves, and a
//! self-hosted runner for the signed-in person (runner/mod.rs)
//! (docs.g1t.sh/guides/desktop/).
//!
//! The site finds the app at `window.g1tDesktop` (bridge.js), the one
//! contract between the two; what the page asks of it is answered by the
//! commands in bridge.rs, each of which checks that the page asking is the
//! configured server's.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod badge;
mod bridge;
mod config;
mod devtools;
mod frame;
mod links;
mod menu;
mod navigation;
mod runner;
mod settings;
mod tray;
mod updates;

use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::{RunEvent, WebviewUrl, WindowEvent};
use tauri_plugin_window_state::{StateFlags, WindowExt};

/// What the window keeps between launches: its size, place, and whether it
/// was maximized or full screen; not its frame.
const KEPT: StateFlags = StateFlags::all().difference(StateFlags::DECORATIONS);

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
        // The window's size and place come back in setup, without the plugin
        // also showing it: at sign-in g1t may start in the tray. Whether it
        // has the system's frame is the title bar setting's (frame.rs), never
        // what an earlier run left: kept, it would put the frame back round
        // g1t's own title bar.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(KEPT)
                .skip_initial_state(WINDOW)
                .with_denylist(&[settings::SETTINGS])
                .build(),
        )
        // Opening at sign-in, which settings turn on; the argument tells that start from someone's.
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec![settings::AT_LOGIN])))
        .manage(config::State::default())
        .manage(frame::State::default())
        .manage(runner::Shared::default())
        .invoke_handler(tauri::generate_handler![
            bridge::desktop_info,
            bridge::notify,
            bridge::set_badge,
            bridge::open_url,
            bridge::reachable,
            bridge::set_server,
            bridge::check_for_updates,
            bridge::open_settings,
            bridge::get_settings,
            bridge::save_settings,
            bridge::set_open_at_login,
            bridge::change_server,
            bridge::restart_to_update,
            bridge::restart,
            bridge::window_control,
            bridge::window_menu,
            bridge::title_bar_page,
            bridge::title_bar_current,
            bridge::title_bar_act,
            bridge::runner_status,
            bridge::runner_offer,
            bridge::runner_register,
            bridge::runner_control,
            bridge::site_ready,
            bridge::open_devtools,
        ])
        .on_menu_event(|app, event| menu::handle(app, event.id().as_ref()))
        .setup(|app| {
            let handle = app.handle().clone();
            config::note_dev_server(&handle);
            config::load(&handle);
            config::allow_site(&handle)?;
            let hidden = settings::starts_hidden(&handle);
            let prefs = config::settings(&handle);
            let custom = frame::started(&handle);
            // The site's web view: the launcher first, which goes on to the server.
            let site = WebviewBuilder::new(frame::SITE, WebviewUrl::App("index.html".into()))
                .initialization_script(bridge::script(custom))
                // The web inspector, as the Developer tools setting has it now (devtools.rs).
                .devtools(devtools::started(&handle))
                .on_navigation({
                    let handle = handle.clone();
                    move |url| navigation::allowed(&handle, url)
                })
                .on_page_load({
                    let handle = handle.clone();
                    move |_webview, payload| config::at(&handle, payload.url().clone(), matches!(payload.event(), PageLoadEvent::Started))
                });
            let builder = frame::main_window(app, custom)?;
            // macOS has one menu bar, the app's; elsewhere the menu is the window's own.
            #[cfg(target_os = "macos")]
            app.set_menu(menu::build(&handle)?)?;
            #[cfg(not(target_os = "macos"))]
            let builder = builder.menu(menu::build(&handle)?);
            let window = builder.build()?;
            // Opened at sign-in, g1t waits in the tray; otherwise the window comes up where it was.
            let _ = window.restore_state(KEPT - StateFlags::VISIBLE);
            frame::fill(&window, custom, site)?;
            frame::layout(&window);
            #[cfg(not(target_os = "macos"))]
            frame::menu_bar(&window, custom);
            if !hidden {
                let _ = window.show();
                if let Some(site) = frame::site(&handle) {
                    let _ = site.set_focus();
                }
            }
            if let Some(site) = frame::site(&handle).filter(|_| prefs.zoom != 1.0) {
                let _ = site.set_zoom(prefs.zoom);
            }
            // Closing the window keeps g1t running, for notifications, unless
            // settings say it quits. A new size gives the bar and the site theirs.
            window.on_window_event({
                let handle = handle.clone();
                let window = window.clone();
                move |event| match event {
                    WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        tray::close(&handle);
                    }
                    WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => frame::layout(&window),
                    _ => {}
                }
            });
            tray::install(&handle)?;
            links::install(&handle);
            updates::schedule(handle.clone());
            // The runner starts on a thread of its own, once the site's page is up, apart from the app (runner::supervise).
            runner::install(&handle);
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
            // However g1t ends, the runner it started ends with it.
            RunEvent::Exit => runner::shutdown(app),
            _ => {
                let _ = app;
            }
        });
}
