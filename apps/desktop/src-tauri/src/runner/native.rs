//! `g1t-runner` itself, kept in the app's data folder and run as a child
//! of the app: for the Docker and On this computer backends, and for the
//! sandbox launcher, which is the same program.
//!
//! The app installs and updates it from the server's releases: the
//! newest one's manifest is `<server>/downloads/runner/latest.json`, which
//! names each platform's file and its SHA-256, and `latest.json.sig` is
//! its Ed25519 signature, made with g1t's release key
//! (scripts/runner-release.mjs). The app trusts a manifest only when that
//! signature checks out against the key built into it, as the runner does
//! with its own updates (crates/runner/src/selfhosted/update.rs), and
//! throws away a download whose SHA-256 is not the manifest's. The
//! runner's own updating is turned off (`G1T_RUNNER_NO_AUTO_UPDATE`), so
//! only the app replaces it, and only while it runs nothing.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use url::Url;

use super::backend::quiet;

/// g1t's release key, as base64 of its 32 bytes: the public half of the
/// key that signs every runner release (the repository variable
/// RUNNER_RELEASE_PUBLIC_KEY, which the runner's own builds take as
/// G1T_RUNNER_RELEASE_KEY). It is public, so it is kept here, where every
/// build has it, development builds included; someone who builds the app
/// for a g1t of their own, with their own release key, sets
/// G1T_RUNNER_RELEASE_KEY when they build it.
const RELEASE_KEY: &str = match option_env!("G1T_RUNNER_RELEASE_KEY") {
    Some(key) => key,
    None => "C8TxhitVxZpx+VLr3gtu0nq7I46q2awBsPZISwDzIgI=",
};

/// Why the releases couldn't be had.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Fault {
    /// The manifest isn't signed with g1t's release key: nothing in it is used.
    Unsigned(String),
    /// It couldn't be fetched or read, or a download didn't check out.
    Failed(String),
}

impl std::fmt::Display for Fault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Fault::Unsigned(why) | Fault::Failed(why) => f.write_str(why),
        }
    }
}

#[derive(Deserialize)]
pub struct File {
    pub name: String,
    pub sha256: String,
}

#[derive(Deserialize)]
pub struct Manifest {
    pub version: String,
    pub files: BTreeMap<String, File>,
    /// The sandbox's images, which `sandbox update` takes: none in
    /// releases from before them, or published without them.
    #[serde(default)]
    pub sandbox: Option<SandboxRelease>,
}

/// What a release names of the sandbox, to tell it from what the
/// sandbox was made from (launcher.rs `Status::image_behind`).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct SandboxRelease {
    /// The runner's image inside the sandbox, by digest.
    pub runner_image: Option<String>,
    /// Its image files by kind (`wsl-x64`…).
    pub files: BTreeMap<String, SandboxFile>,
    /// g1t's machine image by architecture (`x64` alone).
    pub hosted_images: BTreeMap<String, HostedImage>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct SandboxFile {
    pub sha256: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct HostedImage {
    pub image: String,
}

impl SandboxRelease {
    /// g1t's machine image it names for this computer's architecture.
    pub fn hosted_image(&self, arch: &str) -> Option<&str> {
        self.hosted_images.get(arch).map(|hosted| hosted.image.as_str()).filter(|image| !image.trim().is_empty())
    }
}

impl Manifest {
    /// Whether the release has the sandbox's images, so `sandbox update` has something to take.
    pub fn has_images(&self) -> bool {
        self.sandbox.as_ref().is_some_and(|sandbox| !sandbox.files.is_empty())
    }
}

/// This computer's architecture, as releases name it.
pub fn arch() -> &'static str {
    if std::env::consts::ARCH == "aarch64" { "arm64" } else { "x64" }
}

/// This computer's platform, as releases name it.
pub fn platform() -> String {
    let os = match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        _ => "linux",
    };
    format!("{os}-{}", arch())
}

/// Where the program is kept.
pub fn binary(folder: &Path) -> PathBuf {
    folder.join("bin").join(if cfg!(windows) { "g1t-runner.exe" } else { "g1t-runner" })
}

/// The version installed, as the manifest named it.
pub fn installed(folder: &Path) -> Option<String> {
    binary(folder).exists().then(|| std::fs::read_to_string(folder.join("bin").join("version")).ok()).flatten().map(|v| v.trim().to_owned())
}

/// The SHA-256 of the program installed, as a release names its file's.
pub fn installed_sha256(folder: &Path) -> Option<String> {
    std::fs::read(binary(folder)).ok().map(|bytes| sha256(&bytes))
}

/// Whether `manifest`'s program replaces the one installed (`installed`,
/// its version): a newer version does, and so does its own version
/// published again with another build for this platform (flagon-io#476),
/// told by the installed program's SHA-256 (`have`, read only then).
pub fn takes(manifest: &Manifest, installed: Option<&str>, have: impl FnOnce() -> Option<String>) -> bool {
    let Some(installed) = installed else { return true };
    if newer(&manifest.version, installed) {
        return true;
    }
    let same = manifest.version.trim_start_matches('v') == installed.trim_start_matches('v');
    same && manifest.files.get(&platform()).is_some_and(|file| have().is_some_and(|have| !file.sha256.eq_ignore_ascii_case(&have)))
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

/// Whether `signature` (base64) is the release key's over `message`.
pub fn verify(message: &[u8], signature: &str, key: &str) -> Result<(), Fault> {
    let unsigned = |why: &str| Fault::Unsigned(why.to_owned());
    let key: [u8; 32] = STANDARD
        .decode(key.trim())
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| unsigned("the release key built into g1t doesn't read"))?;
    let signature: [u8; 64] = STANDARD
        .decode(signature.trim())
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| unsigned("the release's signature doesn't read"))?;
    let key = ed25519_dalek::VerifyingKey::from_bytes(&key).map_err(|_| unsigned("the release key built into g1t isn't a key"))?;
    key.verify_strict(message, &ed25519_dalek::Signature::from_bytes(&signature))
        .map_err(|_| unsigned("the release's signature isn't g1t's"))
}

/// A manifest, once its signature checks out against `key`.
fn signed(manifest: &[u8], signature: &str, key: &str) -> Result<Manifest, Fault> {
    verify(manifest, signature, key)?;
    serde_json::from_slice(manifest).map_err(|e| Fault::Failed(format!("the runner's release manifest doesn't read: {e}")))
}

/// The newest release's manifest, signed by g1t. One without a
/// signature, or whose signature doesn't check out, is refused.
pub fn latest(server: &Url) -> Result<Manifest, Fault> {
    let base = downloads(server);
    let manifest = get(&format!("{base}/latest.json")).map_err(Fault::Failed)?;
    let signature = get(&format!("{base}/latest.json.sig")).map_err(|why| if why.contains("404") { Fault::Unsigned("the release has no signature".into()) } else { Fault::Failed(why) })?;
    signed(&manifest, &String::from_utf8_lossy(&signature), RELEASE_KEY)
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

/// Puts a checked program in place. The runner it replaces must not be
/// running, but a short launcher command may be (a `sandbox status` the
/// app is asking at that moment): the program there is moved aside first,
/// under a name of its own, since Windows won't overwrite a program that
/// is running but lets it be renamed. Those left from earlier updates are
/// removed here, once nothing runs them.
pub fn put(folder: &Path, bytes: &[u8], version: &str) -> Result<(), String> {
    let path = binary(folder);
    let dir = path.parent().unwrap_or(folder);
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        if entry.file_name().to_string_lossy().ends_with(".old") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    let new = path.with_extension("new");
    std::fs::write(&new, bytes).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&new, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |since| since.as_nanos());
    let old = dir.join(format!("g1t-runner-{stamp}.old"));
    let moved = path.exists() && std::fs::rename(&path, &old).is_ok();
    if let Err(error) = std::fs::rename(&new, &path) {
        if moved {
            let _ = std::fs::rename(&old, &path);
        }
        return Err(format!("could not put g1t-runner in place: {error}"));
    }
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
/// included. A job cut short this way fails on g1t. Ended within 8
/// seconds, inside the 10 that g1t going waits for it (mod.rs `bound`).
pub fn stop(child: &mut Child) {
    let pid = child.id().to_string();
    if cfg!(windows) {
        let _ = quiet("taskkill").args(["/T", "/F", "/PID", &pid]).stdout(Stdio::null()).stderr(Stdio::null()).status();
    } else {
        let _ = quiet("kill").args(["-TERM", &format!("-{pid}")]).stdout(Stdio::null()).stderr(Stdio::null()).status();
        for _ in 0..32 {
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

    /// A key pair of the tests' own: what it signs checks out, and nothing else does.
    #[test]
    fn only_a_manifest_signed_with_the_release_key_is_trusted() {
        use ed25519_dalek::Signer;
        let signing = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
        let key = STANDARD.encode(signing.verifying_key().to_bytes());
        let manifest = br#"{"version":"0.3.2","files":{"windows-x64":{"name":"g1t-runner-windows-x64.exe","sha256":"ab"}}}"#;
        let signature = STANDARD.encode(signing.sign(manifest).to_bytes());
        let trusted = signed(manifest, &signature, &key).unwrap();
        assert_eq!(trusted.version, "0.3.2");
        assert!(!trusted.has_images());
        // Changed after it was signed: a newer version slipped in.
        let changed = br#"{"version":"9.9.9","files":{"windows-x64":{"name":"g1t-runner-windows-x64.exe","sha256":"ab"}}}"#;
        assert_eq!(signed(changed, &signature, &key).err(), Some(Fault::Unsigned("the release's signature isn't g1t's".into())));
        // Signed with another key.
        let other = STANDARD.encode(ed25519_dalek::SigningKey::from_bytes(&[8u8; 32]).verifying_key().to_bytes());
        assert!(matches!(signed(manifest, &signature, &other), Err(Fault::Unsigned(_))));
        // No signature, or not one.
        assert!(matches!(signed(manifest, "", &key), Err(Fault::Unsigned(_))));
        assert!(matches!(signed(manifest, "not base64!", &key), Err(Fault::Unsigned(_))));
        // Signed, yet not a manifest: that is a failure, not a refusal.
        let junk = b"not json";
        assert!(matches!(signed(junk, &STANDARD.encode(signing.sign(junk).to_bytes()), &key), Err(Fault::Failed(_))));
    }

    /// Release 0.3.0's manifest and signature, as g1t.sh published them:
    /// the key built in is the one g1t's releases are signed with.
    #[test]
    fn g1ts_published_release_checks_out_against_the_key_built_in() {
        let manifest = include_bytes!("testdata/latest-0.3.0.json");
        let signature = include_str!("testdata/latest-0.3.0.json.sig");
        let release = signed(manifest, signature, RELEASE_KEY).unwrap();
        assert_eq!(release.version, "0.3.0");
        assert!(release.has_images());
        let mut changed = manifest.to_vec();
        let at = changed.windows(5).position(|five| five == b"0.3.0").unwrap();
        changed[at + 4] = b'9';
        assert!(matches!(signed(&changed, signature, RELEASE_KEY), Err(Fault::Unsigned(_))));
    }

    #[test]
    fn a_new_program_takes_the_old_ones_place_and_its_version() {
        let dir = std::env::temp_dir().join(format!("g1t-desktop-put-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        put(&dir, b"one", "0.3.1").unwrap();
        put(&dir, b"two", "0.3.2").unwrap();
        assert_eq!(std::fs::read(binary(&dir)).unwrap(), b"two");
        assert_eq!(installed(&dir).as_deref(), Some("0.3.2"));
        // The one moved aside goes with the next update, once nothing runs it.
        put(&dir, b"three", "0.3.3").unwrap();
        let old = std::fs::read_dir(dir.join("bin")).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".old")).count();
        assert_eq!(old, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_release_published_again_with_another_build_replaces_the_program() {
        let manifest: Manifest = serde_json::from_str(&format!(r#"{{"version":"0.3.7","files":{{"{}":{{"name":"g1t-runner","sha256":"aa"}}}}}}"#, platform())).unwrap();
        assert!(takes(&manifest, None, || None), "nothing installed");
        assert!(takes(&manifest, Some("0.3.6"), || panic!("a newer version isn't hashed for")));
        assert!(!takes(&manifest, Some("0.3.8"), || Some("bb".into())), "never an older one");
        assert!(takes(&manifest, Some("0.3.7"), || Some("bb".into())), "published again with another build");
        assert!(!takes(&manifest, Some("0.3.7"), || Some("AA".into())), "the same build");
        assert!(!takes(&manifest, Some("0.3.7"), || None), "one that can't be read stays");
        let elsewhere: Manifest = serde_json::from_str(r#"{"version":"0.3.7","files":{"plan9-x64":{"name":"g1t-runner","sha256":"aa"}}}"#).unwrap();
        assert!(!takes(&elsewhere, Some("0.3.7"), || Some("bb".into())), "no build for this platform");
    }

    #[test]
    fn a_sandbox_release_names_its_images_files_and_machine_image() {
        let manifest: Manifest = serde_json::from_str(
            r#"{"version":"0.3.7","files":{},"sandbox":{"runner_image":"r@sha256:d9","files":{"wsl-x64":{"name":"w.tar.gz","sha256":"aa","size":1}},"hosted_images":{"x64":{"image":"h@sha256:d5","size":5636544756}}}}"#,
        )
        .unwrap();
        let sandbox = manifest.sandbox.unwrap();
        assert_eq!(sandbox.runner_image.as_deref(), Some("r@sha256:d9"));
        assert_eq!(sandbox.files["wsl-x64"].sha256, "aa");
        assert_eq!(sandbox.hosted_image("x64"), Some("h@sha256:d5"));
        assert_eq!(sandbox.hosted_image("arm64"), None);
    }

    #[test]
    fn nothing_is_installed_in_an_empty_folder() {
        let dir = std::env::temp_dir().join(format!("g1t-desktop-runner-{}", std::process::id()));
        assert_eq!(installed(&dir), None);
        assert!(binary(&dir).ends_with(if cfg!(windows) { "bin/g1t-runner.exe" } else { "bin/g1t-runner" }));
    }
}
