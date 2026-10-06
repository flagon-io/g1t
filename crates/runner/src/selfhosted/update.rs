//! Releases: where `g1t-runner` is published, how it updates itself, and
//! the Linux build it runs inside containers.
//!
//! Every release is at `<site>/downloads/runner/<version>/`: one binary per
//! platform (`g1t-runner-linux-x64`, `-linux-arm64`, `-macos-arm64`,
//! `-macos-x64`, `-windows-x64.exe`), `SHA256SUMS`, and `manifest.json`.
//! `<site>/downloads/runner/latest.json` is the newest release's manifest,
//! and `latest.json.sig` its Ed25519 signature, made with g1t's release key
//! (`scripts/runner-release.mjs`). A runner only trusts a manifest whose
//! signature checks out against the key built into it, and only runs a
//! binary whose SHA-256 is the manifest's.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::api::download;
use super::config::Config;
use super::{VERSION, log};

/// g1t's release key, as base64 of its 32 bytes: set when release builds
/// are made. Without it a runner never updates itself and only takes the
/// Linux harness from the release when its SHA-256 matches the unsigned
/// manifest it fetched over HTTPS.
const RELEASE_KEY: Option<&str> = option_env!("G1T_RUNNER_RELEASE_KEY");

#[derive(Clone, Debug, Deserialize)]
pub struct File {
    pub name: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Manifest {
    pub version: String,
    /// The image agent work runs in.
    #[serde(default)]
    pub agent_image: Option<String>,
    /// By platform: `linux-x64`, `macos-arm64`, `windows-x64`…
    pub files: std::collections::BTreeMap<String, File>,
}

/// This machine's platform, as releases name it.
pub fn platform() -> String {
    let os = match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        _ => "linux",
    };
    let arch = if std::env::consts::ARCH == "aarch64" { "arm64" } else { "x64" };
    format!("{os}-{arch}")
}

fn downloads(config: &Config) -> String {
    format!("{}/downloads/runner", config.url.trim_end_matches('/'))
}

/// `a.b.c` newer than `x.y.z`.
pub fn newer(candidate: &str, current: &str) -> bool {
    let parts = |v: &str| -> Vec<u64> { v.trim_start_matches('v').split(['.', '-']).take(3).map(|p| p.parse().unwrap_or(0)).collect() };
    parts(candidate) > parts(current)
}

pub fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Whether `signature` (base64) is g1t's release key's over `message`.
pub fn verify(message: &[u8], signature: &str, key: &str) -> Result<()> {
    let key: [u8; 32] = STANDARD
        .decode(key.trim())
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| anyhow!("the release key built into this runner does not read"))?;
    let signature: [u8; 64] = STANDARD
        .decode(signature.trim())
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| anyhow!("the release's signature does not read"))?;
    let key = ed25519_dalek::VerifyingKey::from_bytes(&key).map_err(|_| anyhow!("the release key is not a key"))?;
    key.verify_strict(message, &ed25519_dalek::Signature::from_bytes(&signature))
        .map_err(|_| anyhow!("the release's signature is not g1t's"))
}

/// The newest release, signed. `None` when this build has no release key.
fn latest_signed(config: &Config) -> Result<Option<Manifest>> {
    let Some(key) = RELEASE_KEY else { return Ok(None) };
    let base = downloads(config);
    let manifest = download(&format!("{base}/latest.json"))?;
    let signature = String::from_utf8(download(&format!("{base}/latest.json.sig"))?)?;
    verify(&manifest, &signature, key)?;
    Ok(Some(serde_json::from_slice(&manifest)?))
}

/// The manifest of a version: signed when this build can check, otherwise
/// as fetched over HTTPS.
fn manifest_of(config: &Config, version: &str) -> Result<Manifest> {
    if let Some(latest) = latest_signed(config)?.filter(|m| m.version == version) {
        return Ok(latest);
    }
    let bytes = download(&format!("{}/{version}/manifest.json", downloads(config)))?;
    Ok(serde_json::from_slice(&bytes)?)
}

/// The image agent work runs in, from the release.
pub fn agent_image(config: &Config) -> Option<String> {
    manifest_of(config, VERSION).ok().and_then(|m| m.agent_image)
}

/// A Linux build of the harness to mount into containers: `--harness`;
/// this program, on Linux; else the release's for this version, fetched
/// once and checked.
pub fn linux_harness(config: &Config, folder: &Path) -> Result<PathBuf> {
    if let Some(path) = &config.harness {
        return Ok(path.clone());
    }
    if cfg!(target_os = "linux") {
        return std::env::current_exe().context("could not find this program");
    }
    let arch = if std::env::consts::ARCH == "aarch64" { "arm64" } else { "x64" };
    let path = folder.join("harness").join(VERSION).join("g1t-runner");
    if path.exists() {
        return Ok(path);
    }
    let manifest = manifest_of(config, VERSION)?;
    let file = manifest
        .files
        .get(&format!("linux-{arch}"))
        .ok_or_else(|| anyhow!("release {VERSION} has no Linux build for {arch}"))?;
    log(&format!("Fetching the Linux harness for containers ({})", file.name));
    let bytes = download(&format!("{}/{VERSION}/{}", downloads(config), file.name))?;
    if sha256(&bytes) != file.sha256 {
        bail!("the Linux harness's SHA-256 is not the release's; not using it");
    }
    std::fs::create_dir_all(path.parent().unwrap_or(folder))?;
    std::fs::write(&path, bytes)?;
    Ok(path)
}

/// Updates this program to the newest release, if there is one. Returns
/// the new version when it did.
pub fn update(config: &Config) -> Result<Option<String>> {
    let Some(latest) = latest_signed(config)? else {
        bail!("this build of g1t-runner has no release key, so it cannot check releases; download a release from {}", downloads(config));
    };
    if !newer(&latest.version, VERSION) {
        return Ok(None);
    }
    let file = latest
        .files
        .get(&platform())
        .ok_or_else(|| anyhow!("release {} has no build for {}", latest.version, platform()))?;
    let bytes = download(&format!("{}/{}/{}", downloads(config), latest.version, file.name))?;
    if sha256(&bytes) != file.sha256 {
        bail!("the download's SHA-256 is not the release's; not updating");
    }
    replace_self(&bytes)?;
    Ok(Some(latest.version))
}

/// Puts `bytes` where this program is. The running file is moved aside
/// first: Windows will not overwrite a running program, but lets it be
/// renamed.
fn replace_self(bytes: &[u8]) -> Result<()> {
    let me = std::env::current_exe()?;
    let new = me.with_extension("new");
    let old = me.with_extension("old");
    std::fs::write(&new, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&new, std::fs::Permissions::from_mode(0o755))?;
    }
    let _ = std::fs::remove_file(&old);
    std::fs::rename(&me, &old).context("could not move the old version aside")?;
    if let Err(error) = std::fs::rename(&new, &me) {
        let _ = std::fs::rename(&old, &me);
        return Err(error).context("could not put the new version in place");
    }
    Ok(())
}

/// Whether this build can update itself.
pub fn can_update() -> bool {
    RELEASE_KEY.is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::Signer;

    #[test]
    fn versions_compare_as_numbers() {
        assert!(newer("0.10.0", "0.9.9"));
        assert!(newer("v1.0.0", "0.9.0"));
        assert!(!newer("0.2.0", "0.2.0"));
        assert!(!newer("0.1.9", "0.2.0"));
    }

    #[test]
    fn only_the_release_keys_signature_is_trusted() {
        let signing = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
        let key = STANDARD.encode(signing.verifying_key().to_bytes());
        let manifest = br#"{"version":"0.2.0","files":{}}"#;
        let signature = STANDARD.encode(signing.sign(manifest).to_bytes());
        assert!(verify(manifest, &signature, &key).is_ok());
        assert!(verify(br#"{"version":"9.9.9","files":{}}"#, &signature, &key).is_err());
        let other = STANDARD.encode(ed25519_dalek::SigningKey::from_bytes(&[8u8; 32]).verifying_key().to_bytes());
        assert!(verify(manifest, &signature, &other).is_err());
        assert!(verify(manifest, "not base64", &key).is_err());
    }

    /// Made by scripts/runner-release.mjs: what it signs, the runner checks.
    #[test]
    fn the_release_scripts_signatures_check_out() {
        let key = "4wuwkRbieiO9sWq1UBAcGDjAjin4cwJRG2F8LJVyr6U=";
        let signature = "aXjDOfxYhm+iHacZwsxMadNxoHX07p62evYNqsXX4UZoDQ7pwWtFnF4jKfiqvAk+AmGVkcE+/uioMR2v+FixCw==";
        assert!(verify(br#"{"version":"0.2.0","files":{}}"#, signature, key).is_ok());
        assert!(verify(br#"{"version":"0.2.1","files":{}}"#, signature, key).is_err());
    }

    #[test]
    fn platforms_are_named_as_releases_name_them() {
        let name = platform();
        assert!(["linux-x64", "linux-arm64", "macos-arm64", "macos-x64", "windows-x64", "windows-arm64"].contains(&name.as_str()), "{name}");
        assert_eq!(sha256(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
}
