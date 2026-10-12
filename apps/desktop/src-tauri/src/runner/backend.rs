//! How the runner runs on this computer, which is the person's choice in
//! settings, and what each choice needs before it can start.
//!
//! | Backend | How | What a job can reach |
//! | --- | --- | --- |
//! | Sandboxed (the default) | The runner in a sandbox of its own: its image under Sysbox on Linux today (container.rs), a VM that `g1t-runner sandbox` makes on Windows and macOS once it is built (launcher.rs). Jobs are containers inside it: `nested-container` isolation. | Its own container. Not this computer. |
//! | Docker | `g1t-runner` on this computer, driving this computer's Docker (native.rs): `container` isolation. | Its own container; but the runner controls this computer's Docker, which on Docker Desktop is a VM with the person's files shared into it. Not a sandbox. |
//! | On this computer | `g1t-runner --no-docker` (native.rs): `host` isolation. | Everything the person's account can. |
//!
//! The two that are not sandboxes are only ever chosen; nothing falls back
//! to them. When the chosen one cannot start, the app says why and runs
//! nothing.

use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

use super::launcher;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Backend {
    #[default]
    Sandboxed,
    Docker,
    Host,
}

impl Backend {
    /// How it is said in the tray and the log.
    pub fn label(self) -> &'static str {
        match self {
            Backend::Sandboxed => "sandboxed",
            Backend::Docker => "in Docker",
            Backend::Host => "on this computer",
        }
    }
}

/// What starts the runner for a backend, here.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Engine {
    /// The runner's image under Sysbox, through this computer's Docker.
    Sysbox,
    /// `g1t-runner sandbox`, which makes and owns the sandbox.
    Launcher,
    /// `g1t-runner` itself, as a child of the app; `docker` is whether its
    /// jobs run in this computer's Docker or directly on it.
    Native { docker: bool },
}

/// Why a backend cannot start here (diagnosis.rs says it).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Missing {
    /// Docker is not installed, or not running.
    Docker,
    /// No sandbox can be made on this computer yet.
    Sandbox,
    /// Linux, whose sandbox needs Sysbox in its Docker, which has none.
    Sysbox,
}

/// A program run without a console window flashing up on Windows.
pub fn quiet(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.stdin(Stdio::null());
    command
}

/// Whether this computer's Docker answers.
pub fn docker_ready() -> bool {
    quiet("docker")
        .args(["version", "--format", "{{.Server.Version}}"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// Whether this computer's Docker has Sysbox's runtime.
fn sysbox_ready() -> bool {
    quiet("docker")
        .args(["info", "--format", "{{json .Runtimes}}"])
        .stderr(Stdio::null())
        .output()
        .is_ok_and(|out| out.status.success() && String::from_utf8_lossy(&out.stdout).contains("sysbox-runc"))
}

/// What a backend needs, checked now: how to start it, or why it cannot.
pub fn engine(backend: Backend) -> Result<Engine, Missing> {
    match backend {
        Backend::Sandboxed => {
            if launcher::READY {
                return Ok(Engine::Launcher);
            }
            if !cfg!(target_os = "linux") {
                return Err(Missing::Sandbox);
            }
            if !docker_ready() {
                return Err(Missing::Docker);
            }
            if !sysbox_ready() {
                return Err(Missing::Sysbox);
            }
            Ok(Engine::Sysbox)
        }
        Backend::Docker => {
            if docker_ready() {
                Ok(Engine::Native { docker: true })
            } else {
                Err(Missing::Docker)
            }
        }
        Backend::Host => Ok(Engine::Native { docker: false }),
    }
}

/// This computer's name, as the runner is called on g1t: what `g1t-runner`
/// would choose itself, given here so a runner in a container, whose own
/// host name is the container's, has the computer's.
pub fn machine_name() -> String {
    let given = ["COMPUTERNAME", "HOSTNAME"]
        .iter()
        .find_map(|name| std::env::var(name).ok().map(|v| v.trim().to_owned()).filter(|v| !v.is_empty()))
        .or_else(|| {
            quiet("hostname")
                .output()
                .ok()
                .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_owned())
                .filter(|name| !name.is_empty())
        })
        .unwrap_or_else(|| "desktop".into());
    let name: String = given
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '-' })
        .take(64)
        .collect();
    if name.is_empty() { "desktop".into() } else { name }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sandbox_is_the_default_and_names_read() {
        assert_eq!(Backend::default(), Backend::Sandboxed);
        assert_eq!(serde_json::to_string(&Backend::Host).unwrap(), r#""host""#);
        assert_eq!(serde_json::from_str::<Backend>(r#""docker""#).unwrap(), Backend::Docker);
    }

    #[test]
    fn on_this_computer_needs_nothing_more() {
        assert_eq!(engine(Backend::Host), Ok(Engine::Native { docker: false }));
    }

    #[test]
    fn a_machine_name_is_one_g1t_takes() {
        let name = machine_name();
        assert!(!name.is_empty() && name.len() <= 64);
        assert!(name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')), "{name}");
    }
}
