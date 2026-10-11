//! The badge: what needs the person, on the app's icon and in the tray's
//! hover text. macOS and Linux draw a count on the icon; Windows has no
//! count, so it gets a lavender dot over the taskbar icon instead. With
//! the badge turned off in settings, the icon stays clean and only the
//! tray's hover text counts.

use tauri::{AppHandle, Manager};

use crate::{WINDOW, config, tray};

pub fn set(app: &AppHandle, count: i64) {
    *app.state::<config::State>().waiting.lock().unwrap() = count;
    let shown = if config::settings(app).badge { count } else { 0 };
    if let Some(window) = app.get_webview_window(WINDOW) {
        #[cfg(target_os = "windows")]
        let _ = window.set_overlay_icon(if shown > 0 { Some(dot()) } else { None });
        #[cfg(not(target_os = "windows"))]
        let _ = window.set_badge_count(if shown > 0 { Some(shown) } else { None });
    }
    if let Some(tray) = app.tray_by_id(tray::TRAY) {
        let text = match count {
            0 => "g1t".to_string(),
            1 => "g1t · 1 thing waiting for you".to_string(),
            n => format!("g1t · {n} things waiting for you"),
        };
        let _ = tray.set_tooltip(Some(text));
    }
}

/// Draws the badge again, after the setting changed.
pub fn refresh(app: &AppHandle) {
    let count = *app.state::<config::State>().waiting.lock().unwrap();
    set(app, count);
}

/// A lavender dot with a dark edge, 32 pixels square, drawn here so
/// nothing needs loading.
#[cfg(target_os = "windows")]
fn dot() -> tauri::image::Image<'static> {
    const SIZE: usize = 32;
    let mut rgba = vec![0u8; SIZE * SIZE * 4];
    let centre = (SIZE as f32 - 1.0) / 2.0;
    let radius = SIZE as f32 / 2.0;
    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f32 - centre;
            let dy = y as f32 - centre;
            let distance = (dx * dx + dy * dy).sqrt();
            // Lavender inside, a thin dark ring, then nothing; the edges blend.
            let (colour, alpha) = if distance <= radius - 3.0 {
                ([0xb6, 0xa8, 0xff], 1.0)
            } else if distance <= radius - 0.5 {
                ([0x0f, 0x0f, 0x11], 1.0)
            } else if distance <= radius + 0.5 {
                ([0x0f, 0x0f, 0x11], radius + 0.5 - distance)
            } else {
                ([0, 0, 0], 0.0)
            };
            let at = (y * SIZE + x) * 4;
            rgba[at] = colour[0];
            rgba[at + 1] = colour[1];
            rgba[at + 2] = colour[2];
            rgba[at + 3] = (alpha.clamp(0.0, 1.0) * 255.0) as u8;
        }
    }
    tauri::image::Image::new_owned(rgba, SIZE as u32, SIZE as u32)
}
