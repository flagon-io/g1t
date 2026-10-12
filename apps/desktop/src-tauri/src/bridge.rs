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
use crate::{badge, config, frame, runner, updates};

const SCRIPT: &str = include_str!("bridge.js");

/// The bridge, run at the start of every page the site's web view loads:
/// `custom` is whether g1t's title bar is above it (frame.rs).
pub fn script(custom: bool) -> String {
    SCRIPT
        .replace("__FRAME__", if custom { "custom" } else { "system" })
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

/// The page asking is the server's, in the main window under the title
/// bar: the one that draws the settings dialog and the runner menu.
fn from_site_page(app: &AppHandle, webview: &Webview) -> Result<(), String> {
    from_site(app, webview)?;
    if webview.label() == frame::SITE { Ok(()) } else { Err("only g1t's page in the window may ask that".into()) }
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

/// The Runner window, a page bundled with the app (launcher/runner.html).
fn from_runner(webview: &Webview) -> Result<(), String> {
    from_launcher(webview)?;
    if webview.label() == settings::RUNNER { Ok(()) } else { Err("only the Runner window may ask that".into()) }
}

/// The settings window, or the Runner window, which keeps the runner's settings.
fn from_settings_or_runner(webview: &Webview) -> Result<(), String> {
    from_settings(webview).or_else(|_| from_runner(webview))
}

fn from_either(app: &AppHandle, webview: &Webview) -> Result<(), String> {
    from_site(app, webview).or_else(|_| from_launcher(webview))
}

/// The page asking is the one under the title bar, whichever it is: the
/// site's, the launcher, or GitHub's while signing in.
fn from_page(app: &AppHandle, webview: &Webview) -> Result<(), String> {
    let url = caller(webview)?;
    let shown = config::is_server(app, &url) || config::is_launcher(&url) || crate::navigation::signing_in(&url);
    if webview.label() == frame::SITE && shown { Ok(()) } else { Err("only the page in the window may ask that".into()) }
}

/// The page asking is the title bar's, bundled with the app.
fn from_bar(webview: &Webview) -> Result<(), String> {
    from_launcher(webview)?;
    if webview.label() == frame::BAR { Ok(()) } else { Err("only the title bar may ask that".into()) }
}

/// The page asking has window buttons: the title bar, or the settings or Runner window's own.
fn from_frame(webview: &Webview) -> Result<(), String> {
    from_bar(webview).or_else(|_| from_settings_or_runner(webview))
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
    if let Some(window) = crate::frame::window(&app).filter(|window| settings.flash && !window.is_focused().unwrap_or(false)) {
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
/// The settings, in their window or the dialog over the site (`shown`),
/// show the answer themselves; anyone else asking is also told with a
/// notification.
#[tauri::command]
pub async fn check_for_updates(app: AppHandle, webview: Webview, shown: Option<bool>) -> Result<String, String> {
    from_either(&app, &webview)?;
    let shown = webview.label() == settings::SETTINGS || shown == Some(true);
    updates::check(&app, !shown).await
}

/// A title bar button: `minimize`, `maximize` (which toggles), `close`,
/// `drag`, or `maximized` to ask. Answers whether the window is maximized.
#[tauri::command]
pub fn window_control(app: AppHandle, webview: Webview, action: String) -> Result<bool, String> {
    from_frame(&webview)?;
    crate::frame::control(&app, &webview.window(), &action)
}

/// The title bar's menu button: the app's menu, at that place in the window.
#[tauri::command]
pub fn window_menu(webview: Webview, x: f64, y: f64) -> Result<(), String> {
    from_bar(&webview)?;
    crate::frame::menu(&webview.window(), x, y)
}

/// The page under the title bar says what it is: its title, its search,
/// whether there is a way back, its colours (frame.rs).
#[tauri::command]
pub fn title_bar_page(app: AppHandle, webview: Webview, page: frame::Page) -> Result<(), String> {
    from_page(&app, &webview)?;
    frame::page(&app, page);
    Ok(())
}

/// What the title bar shows now: it asks as it loads.
#[tauri::command]
pub fn title_bar_current(app: AppHandle, webview: Webview) -> Result<frame::Page, String> {
    from_bar(&webview)?;
    Ok(frame::current(&app))
}

/// A title bar button that acts on the page: `back`, `forward`, `search`,
/// `focus`, `settings`, or `runner`, with `at` where its dot is across the
/// bar, as a share of the bar's width.
#[tauri::command]
pub fn title_bar_act(app: AppHandle, webview: Webview, action: String, at: Option<f64>) -> Result<(), String> {
    from_bar(&webview)?;
    frame::act(&app, &action, at)
}

/// Restarts g1t, installing a downloaded update on the way: the settings
/// window offers it after a change that needs one.
#[tauri::command]
pub fn restart(app: AppHandle, webview: Webview) -> Result<(), String> {
    from_settings(&webview).or_else(|_| from_site_page(&app, &webview))?;
    if updates::ready(&app).is_some() {
        updates::restart(&app);
    }
    runner::shutdown(&app);
    app.restart()
}

/// The settings window's "Restart now": installs the downloaded update and starts it.
#[tauri::command]
pub fn restart_to_update(app: AppHandle, webview: Webview) -> Result<(), String> {
    from_settings(&webview).or_else(|_| from_site_page(&app, &webview))?;
    updates::restart(&app);
    Ok(())
}

/// Opens the app's settings: the site's account menu asks for it. They
/// open over the site, or in their own window when it can't draw them.
#[tauri::command]
pub fn open_settings(app: AppHandle, webview: Webview) -> Result<(), String> {
    from_either(&app, &webview)?;
    settings::open(&app);
    Ok(())
}

/// The site's page says it draws the settings dialog and the runner menu
/// itself, once it can (true), or no longer (false). Until it says so, each
/// page loaded in the window has them open in windows of their own.
#[tauri::command]
pub fn site_ready(app: AppHandle, webview: Webview, ready: bool) -> Result<(), String> {
    from_site_page(&app, &webview)?;
    config::set_site_ready(&app, ready);
    Ok(())
}

/// What the settings show.
#[tauri::command]
pub fn get_settings(app: AppHandle, webview: Webview) -> Result<settings::View, String> {
    from_settings_or_runner(&webview).or_else(|_| from_site_page(&app, &webview))?;
    Ok(settings::view(&app))
}

/// The settings changed something: everything but opening at sign-in.
///
/// The site's page may change all of it but one thing: it can't take the
/// runner out of its sandbox. Jobs that run in Docker or directly on the
/// computer can reach the person's files, so that choice is made only in
/// the Runner window, a page bundled with the app, and never by a page
/// from the network, whatever it loads.
#[tauri::command]
pub fn save_settings(app: AppHandle, webview: Webview, settings: Settings) -> Result<settings::View, String> {
    if from_settings_or_runner(&webview).is_err() {
        from_site_page(&app, &webview)?;
        if !site_may_choose(config::settings(&app).runner_backend, settings.runner_backend) {
            return Err("How jobs run outside the sandbox is chosen in the Runner window.".into());
        }
    }
    settings::apply(&app, settings)?;
    Ok(settings::view(&app))
}

/// Whether the site's page may change how jobs run from `before` to
/// `after`: keeping it, or putting it back in the sandbox.
fn site_may_choose(before: runner::Backend, after: runner::Backend) -> bool {
    after == before || after == runner::Backend::Sandboxed
}

/// Opening at sign-in, which the system keeps.
#[tauri::command]
pub fn set_open_at_login(app: AppHandle, webview: Webview, on: bool) -> Result<settings::View, String> {
    from_settings(&webview).or_else(|_| from_site_page(&app, &webview))?;
    settings::open_at_login(&app, on)?;
    Ok(settings::view(&app))
}

/// The settings window's "Change…": the main window goes to the launcher's choice of server.
#[tauri::command]
pub fn change_server(app: AppHandle, webview: Webview) -> Result<(), String> {
    from_settings(&webview).or_else(|_| from_site_page(&app, &webview))?;
    if let Some(window) = app.get_webview_window(settings::SETTINGS) {
        let _ = window.close();
    }
    crate::tray::launcher(&app, "change");
    Ok(())
}

/// The runner's state, diagnosis and recent log: for the site's card for
/// this computer and the settings window.
#[tauri::command]
pub fn runner_status(app: AppHandle, webview: Webview) -> Result<runner::View, String> {
    from_site(&app, &webview).or_else(|_| from_settings_or_runner(&webview)).or_else(|_| from_bar(&webview))?;
    Ok(runner::view(&app))
}

/// The site, on every page: whether someone is signed in, the workspaces
/// they own (the only ones they can add runners to), and the one they are
/// in. Answers the workspace a registration token is wanted for, if one is.
#[tauri::command]
pub fn runner_offer(app: AppHandle, webview: Webview, signed_in: bool, workspaces: Vec<runner::Offered>, current: Option<String>) -> Result<Option<String>, String> {
    from_site(&app, &webview)?;
    runner::offer(&app, signed_in, workspaces, current);
    Ok(runner::wanted(&app))
}

/// The site made a registration token for the workspace the app asked
/// for, or says why not: `allowed` is false when the person may not add
/// runners there. The token goes to the runner and nowhere else.
#[tauri::command]
pub fn runner_register(app: AppHandle, webview: Webview, workspace: String, token: Option<String>, allowed: bool, error: Option<String>) -> Result<(), String> {
    from_site(&app, &webview)?;
    runner::register(&app, workspace, token, allowed, error);
    Ok(())
}

/// A button for the runner: Start, Stop, or a diagnosis's fix
/// (runner/diagnosis.rs), from settings or the site's card. With a kind
/// of job (`capability`: `linux`, `windows`), Start and Stop are its alone.
#[tauri::command]
pub fn runner_control(app: AppHandle, webview: Webview, action: String, capability: Option<String>) -> Result<(), String> {
    from_site(&app, &webview).or_else(|_| from_settings_or_runner(&webview))?;
    runner::act(&app, &action, capability.as_deref())
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_bridge_has_nothing_left_to_fill_in() {
        let script = super::script(true);
        for placeholder in ["__VERSION__", "__PLATFORM__", "__OUTSIDE__", "__FRAME__"] {
            assert!(!script.contains(placeholder), "{placeholder} is left in the bridge");
        }
        assert!(script.contains(r#"var FRAME = "custom";"#));
        assert!(super::script(false).contains(r#"var FRAME = "system";"#));
        assert!(script.contains(r#"var OUTSIDE = ["/pricing""#));
    }

    #[test]
    fn the_site_cannot_take_the_runner_out_of_its_sandbox() {
        use crate::runner::Backend::{Docker, Host, Sandboxed};
        assert!(super::site_may_choose(Sandboxed, Sandboxed));
        assert!(super::site_may_choose(Host, Host));
        assert!(super::site_may_choose(Docker, Sandboxed));
        assert!(super::site_may_choose(Host, Sandboxed));
        assert!(!super::site_may_choose(Sandboxed, Host));
        assert!(!super::site_may_choose(Sandboxed, Docker));
        assert!(!super::site_may_choose(Docker, Host));
    }
}
