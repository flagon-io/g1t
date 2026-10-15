//! Windows: the sandbox is a WSL 2 distribution of its own, `g1t-sandbox`,
//! imported from the release's signed root filesystem.
//!
//! Why WSL 2 rather than a Hyper-V VM: WSL 2 is on every edition of
//! Windows 11, Home included, and once it is installed (one administrator
//! step, `wsl --install --no-distribution`, which many people have done
//! already), importing, starting and removing a distribution needs no
//! administrator. A Hyper-V VM needs the Hyper-V feature, which Home does
//! not have, and membership of Hyper-V Administrators to make or start a
//! VM. A WSL 2 distribution is a real Linux kernel in a VM, not the
//! Windows kernel.
//!
//! What WSL would otherwise share with Windows is turned off: the image's
//! `/etc/wsl.conf` mounts no drives and starts no Windows programs, and
//! the supervisor inside unmounts what WSL mounts into every distribution
//! anyway and refuses to run while anything of the computer's is reachable
//! (guest.rs). The distribution is started by a hidden `wsl.exe` that the
//! launcher keeps running (WSL stops a distribution once nothing of
//! Windows' is attached to it); nothing listens on the computer.
//!
//! What it cannot do: every WSL 2 distribution, the person's own
//! included, runs in one utility VM with one kernel, so root in this
//! distribution could reach theirs. That is why nothing a job runs is root
//! here: the runner is a Sysbox container and each job a container inside
//! it. Global WSL settings (`%USERPROFILE%\.wslconfig`) apply too: with
//! `networkingMode=mirrored` Linux reaches Windows' own `localhost`, so the
//! launcher refuses to start with it.

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use anyhow::{Context, Result, bail};

use super::guest::{GuestStatus, Settings};
use super::image::{self, Local};
use super::{Backend, Resources, StopMode, process_alive};
use crate::selfhosted::native::{Availability, hide_window};
use crate::selfhosted::needs::{self, WindowsFacts, WslFacts};

/// What the distribution is called.
pub const DISTRO: &str = "g1t-sandbox";
const GUEST: &str = "/usr/local/bin/g1t-runner";

pub struct Wsl {
    pub distro: String,
    /// The launcher's state folder: the distribution's disk is in `vm`.
    pub dir: PathBuf,
}

fn wsl() -> Command {
    let mut command = Command::new("wsl.exe");
    command.env("WSL_UTF8", "1");
    hide_window(&mut command);
    command
}

/// `wsl.exe --list --verbose`: each distribution's name and state.
pub fn parse_list(text: &str) -> Vec<(String, String)> {
    text.replace('\0', "")
        .lines()
        .skip(1)
        .filter_map(|line| {
            let fields: Vec<&str> = line.trim().trim_start_matches('*').split_whitespace().collect();
            (fields.len() >= 2).then(|| (fields[0].to_owned(), fields[1].to_owned()))
        })
        .collect()
}

/// Whether `wsl.exe --list --verbose` lists a WSL 2 distribution: WSL 2
/// works here.
pub fn has_wsl2(text: &str) -> bool {
    text.replace('\0', "").lines().skip(1).any(|line| line.trim().trim_start_matches('*').split_whitespace().nth(2) == Some("2"))
}

/// Whether `.wslconfig` puts WSL on mirrored networking, where Linux
/// reaches Windows' own `localhost`.
pub fn mirrored(wslconfig: &str) -> bool {
    let mut section = String::new();
    for line in wslconfig.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            section = line.trim_matches(['[', ']']).trim().to_ascii_lowercase();
        } else if section == "wsl2"
            && let Some((key, value)) = line.split_once('=')
            && key.trim().eq_ignore_ascii_case("networkingMode")
        {
            return value.split('#').next().unwrap_or("").trim().eq_ignore_ascii_case("mirrored");
        }
    }
    false
}

impl Wsl {
    fn list(&self) -> Vec<(String, String)> {
        wsl().args(["--list", "--verbose"]).output().map(|o| parse_list(&String::from_utf8_lossy(&o.stdout))).unwrap_or_default()
    }

    fn state(&self) -> Option<String> {
        self.list().into_iter().find(|(name, _)| name.eq_ignore_ascii_case(&self.distro)).map(|(_, state)| state)
    }

    fn keepalive_pid(&self) -> PathBuf {
        self.dir.join("keepalive.pid")
    }

    /// `g1t-runner sandbox guest …` inside the distribution.
    fn guest(&self, args: &[&str], input: Option<&[u8]>) -> Result<Output> {
        let mut command = wsl();
        command.args(["-d", &self.distro, "-u", "root", "--exec", GUEST, "sandbox", "guest"]).args(args);
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        command.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() });
        let mut child = command.spawn().context("could not run wsl.exe")?;
        if let Some(bytes) = input {
            use std::io::Write;
            let mut stdin = child.stdin.take().expect("piped");
            stdin.write_all(bytes)?;
        }
        let output = child.wait_with_output()?;
        if !output.status.success() {
            bail!("the sandbox said: {}", String::from_utf8_lossy(&output.stderr).trim().trim_start_matches("g1t-runner: "));
        }
        Ok(output)
    }
}

impl Backend for Wsl {
    fn name(&self) -> &'static str {
        "wsl2"
    }

    fn image_keys(&self) -> Vec<String> {
        vec![format!("wsl-{}", image::arch())]
    }

    fn availability(&self) -> Availability {
        let installed = wsl().arg("--status").stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success());
        let config = std::env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join(".wslconfig"));
        if installed && config.and_then(|c| std::fs::read_to_string(c).ok()).is_some_and(|text| mirrored(&text)) {
            return Availability::no(
                "WSL is set to mirrored networking, in which Linux reaches this computer's own localhost.",
                "Remove networkingMode=mirrored from %USERPROFILE%\\.wslconfig, run `wsl --shutdown`, and start the sandbox again.",
            );
        }
        // Made already: WSL works, and what goes wrong from here starting it says.
        if installed && self.exists() {
            return Availability::yes();
        }
        let version = || wsl().arg("--version").stderr(Stdio::null()).output().ok().filter(|o| o.status.success()).and_then(|o| needs::wsl_version(&String::from_utf8_lossy(&o.stdout)));
        let listed = || wsl().args(["--list", "--verbose"]).output().map(|o| has_wsl2(&String::from_utf8_lossy(&o.stdout))).unwrap_or(false);
        let facts = WslFacts { installed, version: if installed { version() } else { None }, has_wsl2: installed && listed() };
        let windows = WindowsFacts::look();
        Availability::needing(needs::wsl_needs(&windows, &facts, needs::restart_pending(&self.dir, &windows)), "linux")
    }

    fn exists(&self) -> bool {
        self.state().is_some()
    }

    fn running(&self) -> bool {
        self.state().is_some_and(|s| s.eq_ignore_ascii_case("Running"))
    }

    fn create(&self, local: &Local, _resources: &Resources) -> Result<()> {
        let key = &self.image_keys()[0];
        let Some(rootfs) = local.files.get(key) else { bail!("no {key} image") };
        let vm = self.dir.join("vm");
        std::fs::create_dir_all(&vm)?;
        let output = wsl().args(import_args(&self.distro, &vm, rootfs)).output().context("could not run wsl.exe")?;
        if !output.status.success() {
            bail!("WSL could not import the sandbox: {}{}", String::from_utf8_lossy(&output.stdout).trim(), String::from_utf8_lossy(&output.stderr).trim());
        }
        // The disk is not limited to `disk_gib`: `wsl --manage --resize`
        // only works with all of WSL shut down, which would stop the
        // person's own distributions and Docker Desktop. It grows as
        // needed, up to WSL's default of 1 TB.
        Ok(())
    }

    fn configure(&self, settings: &Settings) -> Result<()> {
        self.guest(&["configure"], Some(&serde_json::to_vec(settings)?))?;
        Ok(())
    }

    fn load_image(&self, tar: &Path) -> Result<()> {
        let bytes = std::fs::read(tar).with_context(|| format!("could not read {}", tar.display()))?;
        self.guest(&["load-image"], Some(&bytes))?;
        Ok(())
    }

    fn start(&self) -> Result<()> {
        let pid_file = self.keepalive_pid();
        if std::fs::read_to_string(&pid_file).ok().and_then(|p| p.trim().parse().ok()).is_some_and(process_alive) && self.running() {
            return Ok(());
        }
        let log = std::fs::File::create(self.dir.join("sandbox.log"))?;
        let mut command = wsl();
        command
            .args(["-d", &self.distro, "-u", "root", "--exec", GUEST, "sandbox", "guest", "run"])
            .stdin(Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log);
        let child = super::spawn_detached(command)?;
        std::fs::write(&pid_file, child.to_string())?;
        Ok(())
    }

    fn guest_status(&self) -> Option<GuestStatus> {
        if !self.running() {
            return None;
        }
        let output = self.guest(&["status"], None).ok()?;
        serde_json::from_slice(&output.stdout).ok()
    }

    fn stop(&self, mode: StopMode) -> Result<()> {
        if self.running() {
            let args: Vec<&str> = match mode {
                StopMode::Drain => vec!["stop"],
                StopMode::Now => vec!["stop", "--now", "--wait", "120"],
            };
            // Stopping now goes on to end the distribution whatever the
            // guest said; a drain that failed must not.
            if let Err(error) = self.guest(&args, None)
                && mode == StopMode::Drain
            {
                return Err(error);
            }
        }
        let _ = wsl().args(["--terminate", &self.distro]).stdout(Stdio::null()).stderr(Stdio::null()).status();
        if let Some(pid) = std::fs::read_to_string(self.keepalive_pid()).ok().and_then(|p| p.trim().parse::<u32>().ok()) {
            if process_alive(pid) {
                let _ = Command::new("taskkill").args(["/F", "/PID", &pid.to_string()]).stdout(Stdio::null()).stderr(Stdio::null()).status();
            }
            let _ = std::fs::remove_file(self.keepalive_pid());
        }
        Ok(())
    }

    fn export_state(&self) -> Result<Option<Vec<u8>>> {
        if !self.exists() {
            return Ok(None);
        }
        // Not registered yet: nothing to carry.
        Ok(self.guest(&["export-state"], None).ok().map(|o| o.stdout).filter(|b| !b.is_empty()))
    }

    fn import_state(&self, bytes: &[u8]) -> Result<()> {
        self.guest(&["import-state"], Some(bytes))?;
        Ok(())
    }

    fn remove(&self) -> Result<()> {
        self.stop(StopMode::Now)?;
        if self.exists() {
            let output = wsl().args(["--unregister", &self.distro]).output().context("could not run wsl.exe")?;
            if !output.status.success() {
                bail!("WSL could not remove the sandbox: {}", String::from_utf8_lossy(&output.stdout).trim());
            }
        }
        let _ = std::fs::remove_dir_all(self.dir.join("vm"));
        Ok(())
    }
}

/// `wsl.exe --import`: a WSL 2 distribution with its disk in `vm`.
pub fn import_args(distro: &str, vm: &Path, rootfs: &Path) -> Vec<String> {
    vec!["--import".into(), distro.into(), vm.display().to_string(), rootfs.display().to_string(), "--version".into(), "2".into()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_list_reads_with_its_default_marker() {
        let text = "  NAME              STATE           VERSION\n* Ubuntu            Stopped         2\n  g1t-sandbox       Running         2\n  docker-desktop    Running         2\n";
        let list = parse_list(text);
        assert_eq!(list[0], ("Ubuntu".to_owned(), "Stopped".to_owned()));
        assert_eq!(list[1], ("g1t-sandbox".to_owned(), "Running".to_owned()));
        assert_eq!(list.len(), 3);
        assert!(has_wsl2(text));
        assert!(!has_wsl2("  NAME      STATE           VERSION\n* Ubuntu    Stopped         1\n"));
        assert!(!has_wsl2(""));
        // wsl.exe without WSL_UTF8 writes UTF-16: its NULs are dropped.
        assert_eq!(parse_list("N\0A\0M\0E\0\n\0g\x001\0t\0 \0R\0u\0n\0\n")[0].0, "g1t");
    }

    #[test]
    fn mirrored_networking_is_found() {
        assert!(mirrored("[wsl2]\nmemory=16GB\nnetworkingMode = Mirrored # yes\n"));
        assert!(!mirrored("[wsl2]\nnetworkingMode=nat\n"));
        assert!(!mirrored("[experimental]\nnetworkingMode=mirrored\n"));
        assert!(!mirrored(""));
    }

    #[test]
    fn the_import_is_wsl2_with_a_size() {
        let args = import_args("g1t-sandbox", Path::new(r"C:\s\vm"), Path::new(r"C:\s\images\0.3.0\g1t-sandbox-wsl-x64.tar.gz"));
        assert_eq!(args[..3], ["--import", "g1t-sandbox", r"C:\s\vm"]);
        assert!(args.windows(2).any(|w| w == ["--version", "2"]));
    }
}
