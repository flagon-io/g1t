//! The one place the app meets `g1t-runner sandbox`: the launcher that
//! makes a Linux VM of its own on this computer (Hyper-V or WSL on
//! Windows, Apple's Virtualization framework on macOS, Sysbox or KVM on
//! Linux) and runs the runner inside it, so jobs are containers inside the
//! runner's sandbox and none of it reaches this computer
//! (`nested-container` isolation).
//!
//! It is being built in crates/runner. Until it is released, `READY` is
//! false: the Sandboxed backend uses the runner's image under Sysbox where
//! this computer's Docker has it (container.rs), and says a sandbox isn't
//! available everywhere else. The commands below are the expected shape
//! (`sandbox up|down|update`, configured like `register-and-run`, from
//! `G1T_RUNNER_*` in the environment); when the launcher lands, this file
//! is the only one that changes.

use std::path::Path;
use std::process::{Command, Stdio};

use super::backend::quiet;

/// Whether the released `g1t-runner` has its sandbox launcher.
pub const READY: bool = false;

/// The launcher's own folder under the app's runner folder: its VM and the
/// runner's registration inside it are kept there.
pub const FOLDER: &str = "sandbox";

fn sandbox(binary: &Path, action: &str, dir: &Path) -> Command {
    let mut command = quiet(binary);
    command.args(["sandbox", action, "--dir"]).arg(dir);
    command
}

/// Makes the sandbox if it is not there, starts it, and runs the runner
/// inside it until `down`: a child whose output is the runner's log.
pub fn up(binary: &Path, dir: &Path) -> Command {
    let mut command = sandbox(binary, "up", dir);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    command
}

/// Stops the runner and the sandbox around it, waiting for neither job nor VM to linger.
pub fn down(binary: &Path, dir: &Path) {
    let _ = sandbox(binary, "down", dir).stdout(Stdio::null()).stderr(Stdio::null()).status();
}

/// Brings the sandbox's image to the release of `binary`; true when it changed.
pub fn update(binary: &Path, dir: &Path) -> bool {
    sandbox(binary, "update", dir).stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|status| status.success())
}
