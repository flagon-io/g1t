//! Running `g1t-runner` as a service that starts with the machine and
//! restarts if it stops: systemd on Linux, launchd on macOS, the Service
//! Control Manager on Windows.
//!
//!     g1t-runner service install     # then it is running
//!     g1t-runner service stop|start|status
//!     g1t-runner service uninstall

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, bail};

use super::config::Config;
use super::log;

/// What the service is called: one per runner, so a machine can run several.
pub fn service_name(config: &Config) -> String {
    let clean: String = config
        .name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c.to_ascii_lowercase() } else { '-' })
        .collect();
    format!("g1t-runner-{clean}")
}

fn run(program: &str, args: &[&str]) -> Result<()> {
    let status = Command::new(program).args(args).status().with_context(|| format!("could not run {program}"))?;
    if !status.success() {
        bail!("{program} {} failed ({status})", args.join(" "));
    }
    Ok(())
}

/// The systemd unit for a runner.
pub fn systemd_unit(exe: &Path, folder: &Path, user: Option<&str>) -> String {
    let user = user.map(|u| format!("User={u}\n")).unwrap_or_default();
    format!(
        "[Unit]\nDescription=g1t self-hosted runner\nAfter=network-online.target docker.service\nWants=network-online.target\n\n\
         [Service]\nExecStart={} run --dir {}\n{user}Restart=always\nRestartSec=5\nKillSignal=SIGINT\nTimeoutStopSec=60\n\n\
         [Install]\nWantedBy=multi-user.target\n",
        exe.display(),
        folder.display()
    )
}

/// The launchd job for a runner.
pub fn launchd_plist(label: &str, exe: &Path, folder: &Path) -> String {
    let log = folder.join("runner.log");
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <plist version=\"1.0\">\n<dict>\n  <key>Label</key><string>{label}</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>{}</string>\n    <string>run</string>\n    <string>--dir</string>\n    <string>{}</string>\n  </array>\n\
         \x20 <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>StandardOutPath</key><string>{}</string>\n  <key>StandardErrorPath</key><string>{}</string>\n</dict>\n</plist>\n",
        exe.display(),
        folder.display(),
        log.display(),
        log.display()
    )
}

fn launchd_path(label: &str) -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    home.join("Library/LaunchAgents").join(format!("{label}.plist"))
}

pub fn main(action: &str, config: &Config, folder: &Path) -> Result<()> {
    let exe = std::env::current_exe()?;
    let name = service_name(config);
    if cfg!(target_os = "linux") {
        let unit = PathBuf::from(format!("/etc/systemd/system/{name}.service"));
        match action {
            "install" => {
                let user = std::env::var("SUDO_USER").ok().or_else(|| std::env::var("USER").ok()).filter(|u| u != "root");
                std::fs::write(&unit, systemd_unit(&exe, folder, user.as_deref()))
                    .with_context(|| format!("could not write {} (run with sudo)", unit.display()))?;
                run("systemctl", &["daemon-reload"])?;
                run("systemctl", &["enable", "--now", &name])?;
                log(&format!("Installed and started {name}. Its log: journalctl -u {name} -f"));
            }
            "uninstall" => {
                let _ = run("systemctl", &["disable", "--now", &name]);
                std::fs::remove_file(&unit).with_context(|| format!("could not remove {} (run with sudo)", unit.display()))?;
                run("systemctl", &["daemon-reload"])?;
                log(&format!("Removed {name}."));
            }
            "start" | "stop" | "status" => run("systemctl", &[action, &name])?,
            _ => bail!("service takes install, uninstall, start, stop or status"),
        }
        return Ok(());
    }
    if cfg!(target_os = "macos") {
        let label = format!("sh.g1t.{name}");
        let plist = launchd_path(&label);
        match action {
            "install" => {
                std::fs::create_dir_all(plist.parent().unwrap_or(folder))?;
                std::fs::write(&plist, launchd_plist(&label, &exe, folder))?;
                run("launchctl", &["load", "-w", &plist.display().to_string()])?;
                log(&format!("Installed and started {label}. Its log: {}", folder.join("runner.log").display()));
            }
            "uninstall" => {
                let _ = run("launchctl", &["unload", "-w", &plist.display().to_string()]);
                let _ = std::fs::remove_file(&plist);
                log(&format!("Removed {label}."));
            }
            "start" => run("launchctl", &["load", "-w", &plist.display().to_string()])?,
            "stop" => run("launchctl", &["unload", &plist.display().to_string()])?,
            "status" => run("launchctl", &["list", &label])?,
            _ => bail!("service takes install, uninstall, start, stop or status"),
        }
        return Ok(());
    }
    if cfg!(windows) {
        match action {
            "install" => {
                let bin = format!("\"{}\" service run --dir \"{}\"", exe.display(), folder.display());
                run("sc.exe", &["create", &name, "binPath=", &bin, "start=", "auto", "DisplayName=", &format!("g1t runner {}", config.name)])
                    .context("could not create the service (run from an Administrator prompt)")?;
                let _ = run("sc.exe", &["description", &name, "g1t self-hosted runner: runs this workspace's workflow jobs."]);
                let _ = run("sc.exe", &["failure", &name, "reset=", "86400", "actions=", "restart/5000/restart/5000/restart/30000"]);
                run("sc.exe", &["start", &name])?;
                log(&format!("Installed and started the {name} service."));
            }
            "uninstall" => {
                let _ = run("sc.exe", &["stop", &name]);
                run("sc.exe", &["delete", &name])?;
                log(&format!("Removed the {name} service."));
            }
            "start" => run("sc.exe", &["start", &name])?,
            "stop" => run("sc.exe", &["stop", &name])?,
            "status" => run("sc.exe", &["query", &name])?,
            "run" => windows::serve(&name)?,
            _ => bail!("service takes install, uninstall, start, stop or status"),
        }
        return Ok(());
    }
    bail!("services are not supported on {}; run `g1t-runner run` under your own supervisor", std::env::consts::OS)
}

/// The Service Control Manager's side: when Windows starts the service,
/// the runner's loop runs on another thread while this one answers the
/// manager, and a stop request ends the loop between polls.
#[cfg(windows)]
mod windows {
    use std::ffi::c_void;
    use std::sync::atomic::Ordering;

    use anyhow::{Result, bail};

    #[repr(C)]
    struct ServiceTableEntry {
        name: *const u16,
        main: Option<unsafe extern "system" fn(u32, *mut *mut u16)>,
    }

    #[repr(C)]
    struct ServiceStatus {
        service_type: u32,
        current_state: u32,
        controls_accepted: u32,
        win32_exit_code: u32,
        service_exit_code: u32,
        check_point: u32,
        wait_hint: u32,
    }

    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn StartServiceCtrlDispatcherW(table: *const ServiceTableEntry) -> i32;
        fn RegisterServiceCtrlHandlerExW(
            name: *const u16,
            handler: Option<unsafe extern "system" fn(u32, u32, *mut c_void, *mut c_void) -> u32>,
            context: *mut c_void,
        ) -> *mut c_void;
        fn SetServiceStatus(handle: *mut c_void, status: *const ServiceStatus) -> i32;
    }

    const OWN_PROCESS: u32 = 0x10;
    const STOPPED: u32 = 1;
    const STOP_PENDING: u32 = 3;
    const RUNNING: u32 = 4;
    const ACCEPT_STOP: u32 = 1 | 4; // stop, shutdown
    const CONTROL_STOP: u32 = 1;
    const CONTROL_SHUTDOWN: u32 = 5;

    static HANDLE: std::sync::atomic::AtomicPtr<c_void> = std::sync::atomic::AtomicPtr::new(std::ptr::null_mut());
    static NAME: std::sync::OnceLock<Vec<u16>> = std::sync::OnceLock::new();

    fn status(state: u32, exit: u32) {
        let status = ServiceStatus {
            service_type: OWN_PROCESS,
            current_state: state,
            controls_accepted: if state == RUNNING { ACCEPT_STOP } else { 0 },
            win32_exit_code: exit,
            service_exit_code: 0,
            check_point: 0,
            wait_hint: if state == STOP_PENDING { 60_000 } else { 0 },
        };
        let handle = HANDLE.load(Ordering::SeqCst);
        if !handle.is_null() {
            // SAFETY: the handle came from RegisterServiceCtrlHandlerExW, and
            // the manager allows SetServiceStatus from any thread.
            unsafe {
                SetServiceStatus(handle, &status);
            }
        }
    }

    unsafe extern "system" fn handler(control: u32, _: u32, _: *mut c_void, _: *mut c_void) -> u32 {
        if control == CONTROL_STOP || control == CONTROL_SHUTDOWN {
            super::super::STOP.store(true, Ordering::SeqCst);
            status(STOP_PENDING, 0);
        }
        0
    }

    unsafe extern "system" fn service_main(_: u32, _: *mut *mut u16) {
        let name = NAME.get().cloned().unwrap_or_default();
        // SAFETY: the name is a NUL-terminated UTF-16 string that lives as
        // long as the process; the handler is a plain function.
        let handle = unsafe { RegisterServiceCtrlHandlerExW(name.as_ptr(), Some(handler), std::ptr::null_mut()) };
        HANDLE.store(handle, Ordering::SeqCst);
        status(RUNNING, 0);
        let code = super::super::serve_from_service();
        status(STOPPED, if code == 0 { 0 } else { 1066 });
    }

    pub fn serve(name: &str) -> Result<()> {
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let _ = NAME.set(wide.clone());
        let table = [
            ServiceTableEntry { name: wide.as_ptr(), main: Some(service_main) },
            ServiceTableEntry { name: std::ptr::null(), main: None },
        ];
        // SAFETY: the table is terminated by a null entry and outlives the
        // call, which returns when the service stops.
        if unsafe { StartServiceCtrlDispatcherW(table.as_ptr()) } == 0 {
            bail!("`service run` is for Windows to start; use `g1t-runner run` from a prompt");
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod windows {
    pub fn serve(_: &str) -> anyhow::Result<()> {
        anyhow::bail!("`service run` is for Windows")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn units_run_this_runner_from_its_folder() {
        let unit = systemd_unit(Path::new("/usr/local/bin/g1t-runner"), Path::new("/home/ci/.g1t-runner"), Some("ci"));
        assert!(unit.contains("ExecStart=/usr/local/bin/g1t-runner run --dir /home/ci/.g1t-runner"));
        assert!(unit.contains("User=ci"));
        assert!(unit.contains("Restart=always"));
        let plist = launchd_plist("sh.g1t.g1t-runner-mac", Path::new("/opt/g1t-runner"), Path::new("/Users/ci/.g1t-runner"));
        assert!(plist.contains("<string>run</string>"));
        assert!(plist.contains("<key>KeepAlive</key><true/>"));
    }
}
