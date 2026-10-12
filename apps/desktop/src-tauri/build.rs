// The app's own commands (src/bridge.rs) each get a permission,
// `allow-<command>`, so a page can call only what its capability grants:
// the launcher and the settings window theirs (capabilities/), the site
// and GitHub's sign-in pages theirs, given at run time (src/config.rs).
// Without these, Tauri lets no remote page call an app command at all.
fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
        "desktop_info",
        "notify",
        "set_badge",
        "open_url",
        "reachable",
        "set_server",
        "check_for_updates",
        "open_settings",
        "get_settings",
        "save_settings",
        "set_open_at_login",
        "change_server",
        "restart_to_update",
        "restart",
        "window_control",
        "window_menu",
    ])))
    .expect("the app's build could not be prepared");
}
