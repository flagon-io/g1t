//! Linux with Sysbox: no VM is needed. The runner's image runs on the
//! machine's Docker Engine under `--runtime=sysbox-runc`, without the
//! machine's socket, exactly as the self-hosted runners guide's container
//! does; its registration is on a volume of its own, `g1t-sandbox-state`,
//! which outlives the container, so an update replaces the container and
//! keeps the runner. Two walls: the job's container, and the runner's,
//! whose root is no one on the machine.
//!
//! Without Sysbox the launcher uses a VM instead (vm.rs, QEMU with KVM).

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};

use super::guest::{GuestStatus, Settings, sysbox_run_args};
use super::image::Local;
use super::{Backend, Resources, StopMode};
use crate::selfhosted::RunnerStatus;
use crate::selfhosted::native::Availability;

pub const CONTAINER: &str = "g1t-sandbox";
pub const VOLUME: &str = "g1t-sandbox-state";

pub struct SysboxHost {
    pub dir: PathBuf,
}

fn docker() -> Command {
    Command::new("docker")
}

fn ok(command: &mut Command) -> bool {
    command.stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
}

/// Whether `docker info`'s runtimes have Sysbox's.
pub fn has_sysbox(runtimes_json: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(runtimes_json.trim()).ok().is_some_and(|v| v.get("sysbox-runc").is_some())
}

impl SysboxHost {
    fn settings_path(&self) -> PathBuf {
        self.dir.join("settings.json")
    }

    fn settings(&self) -> Result<Settings> {
        let bytes = std::fs::read(self.settings_path()).context("the sandbox has no settings: run `g1t-runner sandbox up`")?;
        Ok(serde_json::from_slice(&bytes)?)
    }

    fn container_running(&self) -> Option<bool> {
        let out = docker().args(["inspect", "-f", "{{.State.Running}}", CONTAINER]).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim() == "true")
    }

    fn registered(&self, image: &str) -> bool {
        ok(docker().args(["run", "--rm", "-v", &format!("{VOLUME}:/data"), "--entrypoint", "test", image, "-f", "/data/config.json"]))
    }
}

impl Backend for SysboxHost {
    fn name(&self) -> &'static str {
        "sysbox"
    }

    fn image_keys(&self) -> Vec<String> {
        Vec::new()
    }

    fn availability(&self) -> Availability {
        let Ok(out) = docker().args(["info", "--format", "{{json .Runtimes}}"]).output() else {
            return Availability::no("Docker is not installed.", "Install Docker Engine and Sysbox 0.7 or later (https://github.com/nestybox/sysbox), or QEMU with KVM for a VM.");
        };
        if !out.status.success() {
            return Availability::no("Docker does not answer, or this user may not use it.", "Start Docker, and add this user to the docker group.");
        }
        if !has_sysbox(&String::from_utf8_lossy(&out.stdout)) {
            return Availability::no("Docker has no Sysbox runtime.", "Install Sysbox 0.7 or later (https://github.com/nestybox/sysbox), or QEMU with KVM for a VM.");
        }
        Availability::yes()
    }

    fn exists(&self) -> bool {
        self.container_running().is_some()
    }

    fn running(&self) -> bool {
        self.container_running() == Some(true)
    }

    fn create(&self, local: &Local, _resources: &Resources) -> Result<()> {
        let Some(image) = &local.runner_image else { bail!("the release names no runner image for the sandbox") };
        if !ok(docker().args(["image", "inspect", image])) && !ok(docker().args(["pull", "-q", image])) {
            bail!("could not fetch the runner's image {image}");
        }
        Ok(())
    }

    fn configure(&self, settings: &Settings) -> Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        let mut merged = self.settings().unwrap_or_default();
        let given = settings.clone();
        merged = Settings {
            url: given.url.or(merged.url),
            token: given.token.or(merged.token),
            name: given.name.or(merged.name),
            labels: if given.labels.is_empty() { merged.labels } else { given.labels },
            group: given.group.or(merged.group),
            cpus: if given.cpus > 0 { given.cpus } else { merged.cpus },
            memory_mib: if given.memory_mib > 0 { given.memory_mib } else { merged.memory_mib },
            runner_image: if given.runner_image.is_empty() { merged.runner_image } else { given.runner_image },
            image_version: if given.image_version.is_empty() { merged.image_version } else { given.image_version },
            stop: None,
        };
        super::write_private(&self.settings_path(), &serde_json::to_vec_pretty(&merged)?)
    }

    fn load_image(&self, tar: &Path) -> Result<()> {
        if !ok(docker().args(["load", "-i"]).arg(tar)) {
            bail!("could not load {}", tar.display());
        }
        Ok(())
    }

    fn start(&self) -> Result<()> {
        if self.running() {
            return Ok(());
        }
        let mut settings = self.settings()?;
        let _ = docker().args(["rm", "-f", CONTAINER]).stdout(Stdio::null()).stderr(Stdio::null()).status();
        let register = !self.registered(&settings.runner_image);
        let env_file = self.dir.join("register.env");
        if register {
            super::write_private(&env_file, super::guest::register_env(&settings)?.as_bytes())?;
        }
        let args = sysbox_run_args(&settings, CONTAINER, VOLUME, register.then(|| env_file.to_str().unwrap_or_default()));
        let out = docker().args(&args).output().context("could not run docker")?;
        let _ = std::fs::remove_file(&env_file);
        if !out.status.success() {
            bail!("could not start the runner: {}", String::from_utf8_lossy(&out.stderr).trim());
        }
        if register {
            // The token goes once it has been handed over.
            settings.token = None;
            super::write_private(&self.settings_path(), &serde_json::to_vec_pretty(&settings)?)?;
        }
        Ok(())
    }

    fn guest_status(&self) -> Option<GuestStatus> {
        let running = self.container_running()?;
        let runner: Option<RunnerStatus> = docker()
            .args(["exec", CONTAINER, "cat", "/data/status.json"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| serde_json::from_slice(&o.stdout).ok());
        Some(GuestStatus { state: if running { "running" } else { "stopped" }.into(), runner, ..GuestStatus::default() })
    }

    fn stop(&self, mode: StopMode) -> Result<()> {
        if !self.running() {
            return Ok(());
        }
        let file = if mode == StopMode::Drain { "/data/drain" } else { "/data/stop" };
        let _ = docker().args(["exec", CONTAINER, "touch", file]).stdout(Stdio::null()).stderr(Stdio::null()).status();
        let limit = (mode == StopMode::Now).then(|| Instant::now() + Duration::from_secs(90));
        while self.running() {
            if limit.is_some_and(|l| Instant::now() > l) {
                let _ = docker().args(["stop", "-t", "30", CONTAINER]).stdout(Stdio::null()).stderr(Stdio::null()).status();
                break;
            }
            std::thread::sleep(Duration::from_secs(1));
        }
        Ok(())
    }

    fn export_state(&self) -> Result<Option<Vec<u8>>> {
        // The volume outlives the container.
        Ok(None)
    }

    fn import_state(&self, _bytes: &[u8]) -> Result<()> {
        Ok(())
    }

    fn remove_system(&self) -> Result<()> {
        self.stop(StopMode::Now)?;
        let _ = docker().args(["rm", "-f", CONTAINER]).stdout(Stdio::null()).stderr(Stdio::null()).status();
        Ok(())
    }

    fn remove(&self) -> Result<()> {
        self.remove_system()?;
        let _ = docker().args(["volume", "rm", "-f", VOLUME]).stdout(Stdio::null()).stderr(Stdio::null()).status();
        let _ = std::fs::remove_file(self.settings_path());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sysbox_is_found_among_the_runtimes() {
        assert!(has_sysbox(r#"{"io.containerd.runc.v2":{"path":"runc"},"runc":{"path":"runc"},"sysbox-runc":{"path":"/usr/bin/sysbox-runc"}}"#));
        assert!(!has_sysbox(r#"{"runc":{"path":"runc"}}"#));
        assert!(!has_sysbox("not json"));
    }

    #[test]
    fn on_linux_the_runner_keeps_its_registration_on_a_volume() {
        let settings = Settings { runner_image: "g1t.sh/flagon-io/g1t-runner@sha256:ab".into(), ..Settings::default() };
        let args = sysbox_run_args(&settings, CONTAINER, VOLUME, Some("/s/register.env")).join(" ");
        assert!(args.contains("--name g1t-sandbox --runtime=sysbox-runc"));
        assert!(args.contains("-v g1t-sandbox-state:/data"));
        assert!(args.contains("--env-file /s/register.env"));
        assert!(!args.contains("docker.sock"));
    }
}
