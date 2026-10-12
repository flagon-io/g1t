//! The window's frame. g1t draws its own title bar, as Slack and Discord
//! do, so the window is all g1t and looks the same on every system: on
//! Windows and Linux the system's frame goes and the bar has the menu
//! button, back and forward, search, and minimize, maximize and close; on
//! macOS the bar sits under the window's own traffic lights.
//!
//! The main window holds two web views, one above the other: the bar, a
//! page bundled with the app (`launcher/titlebar.html`), across the top,
//! and the site under it. The site is never drawn under the bar, so no page
//! of it, or of GitHub's while signing in, needs to know the bar is there.
//! What the bar shows of the page (its title, its search, whether there is
//! a way back, its colours) the page's bridge reports (`page`), and what
//! the bar is asked to do comes back to the page through the app (`act`).
//!
//! Settings can give the window back its system frame, and the menu bar
//! with it, from the next start; the site then has the window to itself.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::webview::WebviewBuilder;
use tauri::window::{Color, WindowBuilder};
use tauri::{AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, Runtime, Webview, WebviewUrl, WebviewWindowBuilder, Window};

use crate::{WINDOW, config, tray};

/// The bar's height, in CSS pixels.
pub const HEIGHT: f64 = 36.0;

/// The site's web view, in the main window.
pub const SITE: &str = "site";
/// The bar's web view, across the top of the main window.
pub const BAR: &str = "titlebar";

/// What the bar listens for: what to show (`Page`).
pub const PAGE_EVENT: &str = "g1t-title-bar";
/// What the site listens for: the bar's search was clicked.
pub const SEARCH_EVENT: &str = "g1t-search";

/// g1t's rail, dark, which the window is painted while a page loads.
const RAIL: Color = Color(5, 5, 7, 255);

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

/// The main window, holding the bar and the site.
pub fn window(app: &AppHandle) -> Option<Window> {
    app.get_window(WINDOW)
}

/// The site's web view.
pub fn site(app: &AppHandle) -> Option<Webview> {
    app.get_webview(SITE)
}

/// The main window, before its web views: g1t's frame, or the system's.
pub fn main_window<'a, R: Runtime, M: Manager<R>>(app: &'a M, custom: bool) -> tauri::Result<WindowBuilder<'a, R, M>> {
    #[cfg(target_os = "macos")]
    let builder = if custom {
        // The traffic lights stay, over the bar and centred in it.
        let config = tauri::utils::config::WindowConfig {
            label: WINDOW.into(),
            traffic_light_position: Some(tauri::utils::config::LogicalPosition { x: 14.0, y: (HEIGHT - 14.0) / 2.0 }),
            ..Default::default()
        };
        WindowBuilder::from_config(app, &config)?.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true)
    } else {
        WindowBuilder::new(app, WINDOW)
    };
    #[cfg(not(target_os = "macos"))]
    let builder = WindowBuilder::new(app, WINDOW).decorations(!custom);
    Ok(builder.title("g1t").inner_size(1280.0, 840.0).min_inner_size(720.0, 480.0).visible(false))
}

/// The bar's and the site's web views, in the main window, as tall as the window leaves them.
pub fn fill(window: &Window, custom: bool, site: WebviewBuilder<tauri::Wry>) -> tauri::Result<()> {
    let size = logical_size(window);
    let top = if custom { HEIGHT } else { 0.0 };
    if custom {
        window.add_child(
            WebviewBuilder::new(BAR, WebviewUrl::App("titlebar.html".into())).background_color(RAIL).on_navigation(config::is_launcher),
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(size.width, HEIGHT),
        )?;
    }
    window.add_child(site.background_color(RAIL), LogicalPosition::new(0.0, top), LogicalSize::new(size.width, (size.height - top).max(0.0)))?;
    #[cfg(target_os = "linux")]
    if custom {
        pack_bar(window);
    }
    Ok(())
}

/// On Linux the web views sit in a GTK box, one under the other, which
/// shares the window between them equally whatever size they are given:
/// the bar is told to keep its height, and the site takes the rest.
#[cfg(target_os = "linux")]
fn pack_bar(window: &Window) {
    use gtk::prelude::*;
    let Ok(vbox) = window.default_vbox() else { return };
    // The bar is the first web view added; the menu bar, hidden, is not one.
    if let Some(bar) = vbox.children().into_iter().find(|child| child.type_().name() == "WebKitWebView") {
        vbox.set_child_packing(&bar, false, true, 0, gtk::PackType::Start);
        bar.set_size_request(-1, HEIGHT as i32);
    }
}

fn logical_size(window: &Window) -> LogicalSize<f64> {
    let scale = window.scale_factor().unwrap_or(1.0);
    window.inner_size().map(|size| size.to_logical(scale)).unwrap_or(LogicalSize::new(1280.0, 840.0))
}

/// The window changed size: the bar keeps its height, and the site takes the rest.
pub fn layout(window: &Window) {
    let app = window.app_handle();
    let size = logical_size(window);
    let bar = app.get_webview(BAR);
    let top = if bar.is_some() { HEIGHT } else { 0.0 };
    if let Some(bar) = bar {
        let _ = bar.set_position(LogicalPosition::new(0.0, 0.0));
        let _ = bar.set_size(LogicalSize::new(size.width, HEIGHT));
    }
    if let Some(site) = site(app) {
        let _ = site.set_position(LogicalPosition::new(0.0, top));
        let _ = site.set_size(LogicalSize::new(size.width, (size.height - top).max(0.0)));
    }
}

/// The settings window: g1t's frame, or the system's. Its page draws its
/// own bar (launcher/settings.html), being g1t's own.
pub fn dialog<'a, R: Runtime, M: Manager<R>>(builder: WebviewWindowBuilder<'a, R, M>, custom: bool) -> WebviewWindowBuilder<'a, R, M> {
    if !custom {
        return builder;
    }
    #[cfg(target_os = "macos")]
    {
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
pub fn menu_bar(window: &Window, custom: bool) {
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

/// What a window button asks of the window it is in: `minimize`,
/// `maximize` (which toggles), `close`, `drag`, or `maximized` to ask.
/// Answers whether the window is maximized.
pub fn control(app: &AppHandle, window: &Window, action: &str) -> Result<bool, String> {
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
pub fn menu(window: &Window, x: f64, y: f64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let menu = window.app_handle().menu();
    #[cfg(not(target_os = "macos"))]
    let menu = window.menu();
    let menu = menu.ok_or("the window has no menu")?;
    window.popup_menu_at(&menu, LogicalPosition::new(x, y)).map_err(|error| error.to_string())
}

/// The page's colours, as the bar takes them: CSS colours, resolved.
#[derive(Clone, Default, Debug, PartialEq, Serialize, Deserialize)]
pub struct Colors {
    pub background: String,
    pub foreground: String,
    pub muted: String,
    pub accent: String,
    /// Whether the page is dark, for the bar's own hover shades.
    pub dark: bool,
}

/// What the bar shows of the page in the window under it.
#[derive(Clone, Default, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub title: String,
    /// The site's search, by its label ("Search Flagon"), when it has handed one over.
    pub search: Option<String>,
    /// Whether there is a page to go back or forward to; absent where the web view cannot tell.
    pub can_go_back: Option<bool>,
    pub can_go_forward: Option<bool>,
    pub colors: Option<Colors>,
    /// The runner menu the site draws under the bar's dot is open.
    #[serde(default)]
    pub runner_menu: bool,
}

/// The page as last reported, kept for a bar that loads after it.
#[derive(Default)]
pub struct State(Mutex<Page>);

/// The site's page reported what it is: the bar is told.
pub fn page(app: &AppHandle, mut page: Page) {
    page.title.truncate(300);
    if let Some(search) = page.search.as_mut() {
        search.truncate(120);
    }
    let state = app.state::<State>();
    let mut kept = state.0.lock().unwrap();
    // A page that knows no colours of its own keeps the last ones.
    if page.colors.is_none() {
        page.colors = kept.colors.clone();
    }
    if *kept == page {
        return;
    }
    *kept = page.clone();
    drop(kept);
    let _ = app.emit_to(EventTarget::webview(BAR), PAGE_EVENT, page);
}

/// What the bar shows now: it asks as it loads.
pub fn current(app: &AppHandle) -> Page {
    app.state::<State>().0.lock().unwrap().clone()
}

/// A button on the bar that acts on the page: `back`, `forward`, `search`,
/// `settings`, `runner` (the dot beside the settings, `at` where it is
/// across the bar), or `focus`, which hands the keyboard back to the page
/// after a click on the bar.
pub fn act(app: &AppHandle, action: &str, at: Option<f64>) -> Result<(), String> {
    let site = site(app).ok_or("there is no page")?;
    match action {
        "back" => site.eval("history.back()").map_err(|error| error.to_string())?,
        "forward" => site.eval("history.forward()").map_err(|error| error.to_string())?,
        "search" => app.emit_to(EventTarget::webview(SITE), SEARCH_EVENT, ()).map_err(|error| error.to_string())?,
        // The app's settings, a click away rather than only in its menu:
        // a dialog the site draws over itself.
        "settings" => {
            crate::settings::open(app);
            return Ok(());
        }
        // The runner's menu, hanging under its dot beside the settings button.
        "runner" => {
            crate::settings::runner_menu(app, true, at);
            return Ok(());
        }
        "focus" => {}
        other => return Err(format!("the bar cannot {other}")),
    }
    let _ = site.set_focus();
    Ok(())
}
