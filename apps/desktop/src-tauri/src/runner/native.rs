//! `g1t-runner` itself, kept in the app's data folder and run as a child
//! of the app: for the Docker and On this computer backends, and for the
//! sandbox launcher, which is the same program.
//!
//! The app installs and updates it from the server's releases: the
//! newest one's manifest is `<server>/downloads/runner/latest.json`, which
//! names each platform's file and its SHA-256, and a download whose
//! SHA-256 is not the manifest's is thrown away. The runner's own
//! updating is turned off (`G1T_RUNNER_NO_AUTO_UPDATE`), so only the app
//! replaces it, and only while it runs nothing.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::time::Duration;

use serde::Deserialize;
use sha2::{Digest, Sha256};
use url::Url;

use super::backend::quiet;

#[derive(Deserialize)]
pub struct File {
    pub name: String,
    pub sha256: String,
}

#[derive(Deserialize)]
pub struct Manifest {
    pub version: String,
    pub files: BTreeMap<String, File>,
}

/// This computer's platform, as releases name it.
pub fn platform() -> String {
    let os = match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        _ => "linux",
    };
    let arch = if std::env::consts::ARCH == "aarch64" { "arm64" } else { "x64" };
    format!("{os}-{arch}")
}

/// Where the program is kept.
pub fn binary(folder: &Path) -> PathBuf {
    folder.join("bin").join(if cfg!(windows) { "g1t-runner.exe" } else { "g1t-runner" })
}

/// The version installed, as the manifest named it.
pub fn installed(folder: &Path) -> Option<String> {
    binary(folder).exists().then(|| std::fs::read_to_string(folder.join("bin").join("version")).ok()).flatten().map(|v| v.trim().to_owned())
}

/// `a.b.c` newer than `x.y.z`.
pub fn newer(candidate: &str, current: &str) -> bool {
    let parts = |v: &str| -> Vec<u64> { v.trim_start_matches('v').split(['.', '-']).take(3).map(|p| p.parse().unwrap_or(0)).collect() };
    parts(candidate) > parts(current)
}

pub fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

fn downloads(server: &Url) -> String {
    format!("{}downloads/runner", server.as_str())
}

fn get(url: &str) -> Result<Vec<u8>, String> {
    tauri::async_runtime::block_on(async {
        let client = reqwest::Client::builder().timeout(Duration::from_secs(300)).build().map_err(|e| e.to_string())?;
        let response = client.get(url).send().await.map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!("{url} answered {}", response.status()));
        }
        response.bytes().await.map(|bytes| bytes.to_vec()).map_err(|e| e.to_string())
    })
}

/// The newest release's manifest.
pub fn latest(server: &Url) -> Result<Manifest, String> {
    let bytes = get(&format!("{}/latest.json", downloads(server)))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("the runner's release manifest does not read: {e}"))
}

/// Downloads a release's program for this platform and checks it against
/// the manifest's SHA-256.
pub fn download(server: &Url, manifest: &Manifest) -> Result<Vec<u8>, String> {
    let file = manifest.files.get(&platform()).ok_or_else(|| format!("g1t-runner {} has no build for {}", manifest.version, platform()))?;
    let bytes = get(&format!("{}/{}/{}", downloads(server), manifest.version, file.name))?;
    if sha256(&bytes) != file.sha256.to_ascii_lowercase() {
        return Err("the download's SHA-256 isn't the release's, so it was thrown away".into());
    }
    Ok(bytes)
}

/// Puts a checked program in place. The runner must not be running:
/// Windows will not replace a program that is.
pub fn put(folder: &Path, bytes: &[u8], version: &str) -> Result<(), String> {
    let path = binary(folder);
    let dir = path.parent().unwrap_or(folder);
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let new = path.with_extension("new");
    std::fs::write(&new, bytes).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&new, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&new, &path).map_err(|e| format!("could not put g1t-runner in place: {e}"))?;
    std::fs::write(dir.join("version"), version).map_err(|e| e.to_string())
}

/// Starts `register-and-run`, which registers the first time (from
/// `G1T_RUNNER_*` in the environment the caller sets) and then runs.
pub fn spawn(binary: &Path, dir: &Path, envs: &[(&str, String)]) -> std::io::Result<Child> {
    let mut command = quiet(binary);
    command.arg("register-and-run").arg("--dir").arg(dir);
    // What the app's own environment may have set for another runner is not this one's.
    for (name, _) in std::env::vars_os() {
        if name.to_string_lossy().starts_with("G1T_RUNNER_") {
            command.env_remove(&name);
        }
    }
    command.envs(envs.iter().map(|(name, value)| (*name, value.as_str())));
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    // A group of its own, so stopping it reaches what it started.
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    command.spawn()
}

/// Unregisters the runner whose configuration is in `dir`, and forgets it.
pub fn forget(binary: &Path, dir: &Path) {
    if binary.exists() && dir.join("config.json").exists() {
        let _ = quiet(binary).arg("remove").arg("--dir").arg(dir).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    let _ = std::fs::remove_file(dir.join("config.json"));
}

/// Stops the runner and what it started: the job it ran in host mode
/// included. A job cut short this way fails on g1t.
pub fn stop(child: &mut Child) {
    let pid = child.id().to_string();
    if cfg!(windows) {
        let _ = quiet("taskkill").args(["/T", "/F", "/PID", &pid]).stdout(Stdio::null()).stderr(Stdio::null()).status();
    } else {
        let _ = quiet("kill").args(["-TERM", &format!("-{pid}")]).stdout(Stdio::null()).stderr(Stdio::null()).status();
        for _ in 0..40 {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Removes the containers, networks and volumes of the jobs of the runner
/// registered in `dir`, as `g1t-runner` does itself when it starts: each
/// carries the label `sh.g1t.runner=<its id>`.
pub fn sweep(dir: &Path) {
    #[derive(Deserialize)]
    struct Registered {
        runner: String,
    }
    let Some(registered) = std::fs::read(dir.join("config.json")).ok().and_then(|bytes| serde_json::from_slice::<Registered>(&bytes).ok()) else { return };
    let label = format!("label=sh.g1t.runner={}", registered.runner);
    for (list, remove) in [
        (vec!["ps", "-aq", "--filter", &label], vec!["rm", "-f", "-v"]),
        (vec!["network", "ls", "-q", "--filter", &label], vec!["network", "rm"]),
        (vec!["volume", "ls", "-q", "--filter", &label], vec!["volume", "rm", "-f"]),
    ] {
        let Ok(out) = quiet("docker").args(&list).stderr(Stdio::null()).output() else { return };
        let ids: Vec<String> = String::from_utf8_lossy(&out.stdout).split_whitespace().map(str::to_owned).collect();
        if !ids.is_empty() {
            let _ = quiet("docker").args(&remove).args(&ids).stdout(Stdio::null()).stderr(Stdio::null()).status();
        }
    }
}

/// A runner the app started before and did not stop (it was ended
/// without quitting): stopped, if that process is still `g1t-runner`.
pub fn reap(pid: u32) {
    let pid = pid.to_string();
    if cfg!(windows) {
        let _ = quiet("taskkill")
            .args(["/T", "/F", "/FI", "IMAGENAME eq g1t-runner.exe", "/PID", &pid])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    } else {
        let named = quiet("ps").args(["-p", &pid, "-o", "comm="]).output().is_ok_and(|out| String::from_utf8_lossy(&out.stdout).trim().ends_with("g1t-runner"));
        if named {
            let _ = quiet("kill").args(["-TERM", &pid]).status();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn releases_are_named_and_compared_as_the_runner_does() {
        assert!(["linux-x64", "linux-arm64", "macos-arm64", "macos-x64", "windows-x64", "windows-arm64"].contains(&platform().as_str()));
        assert!(newer("0.10.0", "0.9.9"));
        assert!(!newer("0.2.0", "0.2.0"));
        assert_eq!(sha256(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        let manifest: Manifest = serde_json::from_str(r#"{"version":"0.2.3","agent_image":null,"files":{"windows-x64":{"name":"g1t-runner-windows-x64.exe","sha256":"ab"}}}"#).unwrap();
        assert_eq!(manifest.files["windows-x64"].name, "g1t-runner-windows-x64.exe");
        assert_eq!(downloads(&Url::parse("https://g1t.sh/").unwrap()), "https://g1t.sh/downloads/runner");
    }

    #[test]
    fn nothing_is_installed_in_an_empty_folder() {
        let dir = std::env::temp_dir().join(format!("g1t-desktop-runner-{}", std::process::id()));
        assert_eq!(installed(&dir), None);
        assert!(binary(&dir).ends_with(if cfg!(windows) { "bin/g1t-runner.exe" } else { "bin/g1t-runner" }));
    }
}
