//! `g1t upgrade`: the CLI updates itself to the newest release, and says
//! now and then, in a terminal, that a newer one is out.
//!
//! Releases are at `https://g1t.sh/downloads/cli/` (`G1T_DOWNLOAD_URL`
//! names another, as for the install scripts): `latest.json`, the newest
//! release's manifest, and `latest.json.sig`, its Ed25519 signature with
//! g1t's release key (scripts/cli-release.mjs). The CLI trusts a manifest
//! only when the signature checks out against the key built into it
//! (`G1T_RUNNER_RELEASE_KEY` when it was built), and installs a download
//! only when its SHA-256 is the manifest's. A build without the key, such
//! as one built from source, cannot upgrade itself and says how to.

use std::io::IsTerminal;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::cli::UpgradeArgs;
use crate::error::{Error, Result};

/// This build's version.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// g1t's release key, as base64 of its 32 bytes: set when release builds
/// are made.
const RELEASE_KEY: Option<&str> = option_env!("G1T_RUNNER_RELEASE_KEY");
/// The install scripts, for a build that cannot upgrade itself.
const INSTALL: &str = "curl -fsSL https://g1t.sh/install | sh (on Windows: irm https://g1t.sh/install.ps1 | iex)";
/// How often the CLI looks for a newer release on its own.
const CHECK_EVERY: Duration = Duration::from_secs(24 * 60 * 60);
/// How long a command's end waits for that look before leaving it.
const NOTICE_WAIT: Duration = Duration::from_millis(400);

#[derive(Clone, Debug, Deserialize)]
pub struct File {
    pub name: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Manifest {
    pub version: String,
    /// By platform: `linux-x64`, `macos-arm64`, `windows-x64`…
    pub files: std::collections::BTreeMap<String, File>,
}

/// Where the CLI's releases are.
fn downloads() -> String {
    std::env::var("G1T_DOWNLOAD_URL")
        .ok()
        .filter(|url| !url.trim().is_empty())
        .unwrap_or_else(|| "https://g1t.sh/downloads/cli".to_owned())
        .trim_end_matches('/')
        .to_owned()
}

/// This machine's platform, as releases name it. Windows on ARM runs the x64 build.
pub fn platform() -> String {
    let os = match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        _ => "linux",
    };
    let arch = if std::env::consts::ARCH == "aarch64" && os != "windows" { "arm64" } else { "x64" };
    format!("{os}-{arch}")
}

/// `a.b.c` newer than `x.y.z`.
pub fn newer(candidate: &str, current: &str) -> bool {
    let parts = |v: &str| -> Vec<u64> { v.trim_start_matches('v').split(['.', '-']).take(3).map(|p| p.parse().unwrap_or(0)).collect() };
    parts(candidate) > parts(current)
}

pub fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Whether `signature` (base64) is the release key's over `message`.
pub fn verify(message: &[u8], signature: &str, key: &str) -> std::result::Result<(), String> {
    let key: [u8; 32] = STANDARD
        .decode(key.trim())
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or("the release key built into this g1t does not read")?;
    let signature: [u8; 64] =
        STANDARD.decode(signature.trim()).ok().and_then(|bytes| bytes.try_into().ok()).ok_or("the release's signature does not read")?;
    let key = ed25519_dalek::VerifyingKey::from_bytes(&key).map_err(|_| "the release key is not a key")?;
    key.verify_strict(message, &ed25519_dalek::Signature::from_bytes(&signature))
        .map_err(|_| "the release's signature is not g1t's".to_owned())
}

fn agent(timeout: Duration) -> ureq::Agent {
    crate::http::builder().timeout(timeout).user_agent(&format!("g1t/{VERSION}")).build()
}

fn download(agent: &ureq::Agent, url: &str) -> std::result::Result<Vec<u8>, String> {
    let response = agent.get(url).call().map_err(|error| format!("could not download {url}: {error}"))?;
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut response.into_reader(), &mut bytes).map_err(|error| format!("could not download {url}: {error}"))?;
    Ok(bytes)
}

/// The newest release, its signature checked with `key`.
fn latest(agent: &ureq::Agent, key: &str) -> std::result::Result<Manifest, String> {
    let base = downloads();
    let manifest = download(agent, &format!("{base}/latest.json"))?;
    let signature =
        String::from_utf8(download(agent, &format!("{base}/latest.json.sig"))?).map_err(|_| "the release's signature does not read")?;
    verify(&manifest, &signature, key)?;
    serde_json::from_slice(&manifest).map_err(|error| format!("the release's manifest does not read: {error}"))
}

/// Puts `bytes` where this program is. The running file is moved aside
/// first: Windows will not overwrite a running program, but lets it be
/// renamed. The old one is removed next time, when it no longer runs.
fn replace_self(bytes: &[u8]) -> std::result::Result<PathBuf, String> {
    let me = std::env::current_exe().map_err(|error| format!("could not find this program: {error}"))?;
    // A link to it (Homebrew-style) is followed to the file; Windows has none, and
    // canonicalizing there only adds a `\\?\` prefix.
    #[cfg(unix)]
    let me = std::fs::canonicalize(&me).unwrap_or(me);
    let new = me.with_extension("new");
    let old = me.with_extension("old");
    std::fs::write(&new, bytes).map_err(|error| format!("could not write {}: {error}", new.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&new, std::fs::Permissions::from_mode(0o755)).map_err(|error| error.to_string())?;
    }
    let _ = std::fs::remove_file(&old);
    if let Err(error) = std::fs::rename(&me, &old) {
        let _ = std::fs::remove_file(&new);
        return Err(format!("could not move {} aside: {error}", me.display()));
    }
    if let Err(error) = std::fs::rename(&new, &me) {
        let _ = std::fs::rename(&old, &me);
        return Err(format!("could not put the new version at {}: {error}", me.display()));
    }
    Ok(me)
}

/// What an earlier upgrade left: the version it replaced, once it no
/// longer runs.
fn tidy_old() {
    if let Ok(me) = std::env::current_exe() {
        let _ = std::fs::remove_file(me.with_extension("old"));
    }
}

/// `g1t upgrade`.
pub fn run(args: UpgradeArgs) -> Result<()> {
    let Some(key) = RELEASE_KEY else {
        return Err(Error::failed(format!(
            "this build of g1t ({VERSION}) was not made by a g1t release, so it cannot check releases. Install the newest one with: {INSTALL}"
        )));
    };
    let agent = agent(Duration::from_secs(120));
    let latest = latest(&agent, key).map_err(Error::failed)?;
    remember(&latest.version);
    if !newer(&latest.version, VERSION) {
        println!("g1t {VERSION} is the newest release.");
        return Ok(());
    }
    if args.check {
        println!("g1t {} is out; this is {VERSION}. Run `g1t upgrade` to install it.", latest.version);
        return Ok(());
    }
    let file =
        latest.files.get(&platform()).ok_or_else(|| Error::failed(format!("g1t {} has no build for {}.", latest.version, platform())))?;
    eprintln!("Downloading g1t {} ({})…", latest.version, platform());
    let bytes = download(&agent, &format!("{}/{}/{}", downloads(), latest.version, file.name)).map_err(Error::failed)?;
    let have = sha256(&bytes);
    if have != file.sha256 {
        return Err(Error::failed(format!("the download's SHA-256 is {have}, not the release's {}. Nothing was changed.", file.sha256)));
    }
    let at = replace_self(&bytes).map_err(Error::failed)?;
    println!("Upgraded g1t {VERSION} to {} at {}.", latest.version, at.display());
    Ok(())
}

// --- Saying a newer release is out -------------------------------------------

#[derive(Default, Serialize, Deserialize)]
struct Seen {
    /// Seconds since the epoch.
    checked_at: u64,
    version: String,
}

fn seen_path() -> Option<PathBuf> {
    crate::config::dir().ok().map(|dir| dir.join("latest-release.json"))
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

fn remember(version: &str) {
    if let Some(path) = seen_path() {
        let _ = std::fs::create_dir_all(path.parent().unwrap_or(&path));
        let seen = Seen { checked_at: now(), version: version.to_owned() };
        let _ = std::fs::write(path, serde_json::to_vec(&seen).unwrap_or_default());
    }
}

/// The line that says a newer release is out, if one is.
pub fn notice_for(newest: &str, current: &str) -> Option<String> {
    newer(newest, current).then(|| format!("g1t {newest} is out; this is {current}. Run `g1t upgrade` to install it."))
}

/// Looks for a newer release at most once a day, in the background, for
/// people at a terminal; [`Notice::finish`] says so after the command. Off
/// in CI, with `G1T_NO_UPDATE_NOTIFIER=1`, for `g1t upgrade` itself, and
/// in a build that cannot upgrade itself.
pub struct Notice {
    known: Option<String>,
    looking: Option<mpsc::Receiver<String>>,
}

impl Notice {
    pub fn start(upgrading: bool) -> Notice {
        tidy_old();
        let off = Notice { known: None, looking: None };
        let Some(key) = RELEASE_KEY else { return off };
        let quiet = |name: &str| std::env::var(name).is_ok_and(|value| !value.is_empty() && value != "0");
        if upgrading || quiet("G1T_NO_UPDATE_NOTIFIER") || quiet("CI") || !std::io::stderr().is_terminal() {
            return off;
        }
        let seen: Seen =
            seen_path().and_then(|path| std::fs::read(path).ok()).and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
        let known = (!seen.version.is_empty()).then(|| seen.version.clone());
        if now().saturating_sub(seen.checked_at) < CHECK_EVERY.as_secs() {
            return Notice { known, looking: None };
        }
        let (tell, looking) = mpsc::channel();
        std::thread::spawn(move || {
            if let Ok(latest) = latest(&agent(Duration::from_secs(5)), key) {
                remember(&latest.version);
                let _ = tell.send(latest.version);
            }
        });
        Notice { known, looking: Some(looking) }
    }

    /// After the command: says so when a newer release is out.
    pub fn finish(self) {
        let newest = self.looking.and_then(|looking| looking.recv_timeout(NOTICE_WAIT).ok()).or(self.known);
        if let Some(line) = newest.and_then(|newest| notice_for(&newest, VERSION)) {
            eprintln!("\n{line}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::Signer;

    #[test]
    fn versions_compare_as_numbers() {
        assert!(newer("0.10.0", "0.9.9"));
        assert!(newer("v1.0.0", "0.9.0"));
        assert!(!newer("0.3.3", "0.3.3"));
        assert!(!newer("0.3.2", "0.3.3"));
        assert_eq!(notice_for("0.3.2", "0.3.3"), None);
        assert_eq!(notice_for("0.4.0", "0.3.3").as_deref(), Some("g1t 0.4.0 is out; this is 0.3.3. Run `g1t upgrade` to install it."));
    }

    #[test]
    fn only_the_release_keys_signature_is_trusted() {
        let signing = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
        let key = STANDARD.encode(signing.verifying_key().to_bytes());
        let manifest = br#"{"version":"0.4.0","files":{}}"#;
        let signature = STANDARD.encode(signing.sign(manifest).to_bytes());
        assert!(verify(manifest, &signature, &key).is_ok());
        assert!(verify(br#"{"version":"9.9.9","files":{}}"#, &signature, &key).is_err());
        let other = STANDARD.encode(ed25519_dalek::SigningKey::from_bytes(&[8u8; 32]).verifying_key().to_bytes());
        assert!(verify(manifest, &signature, &other).is_err());
        assert!(verify(manifest, "not base64", &key).is_err());
    }

    /// Made by scripts/runner-release.mjs, whose signing the CLI's releases use.
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
        assert!(["linux-x64", "linux-arm64", "macos-arm64", "macos-x64", "windows-x64"].contains(&name.as_str()), "{name}");
        // The manifest the site publishes reads.
        let manifest: Manifest =
            serde_json::from_str(r#"{"version":"0.3.3","published_at":"2026-10-14T13:22:39.222Z","files":{"windows-x64":{"name":"g1t-windows-x64.exe","sha256":"61"}}}"#)
                .unwrap();
        assert_eq!(manifest.files["windows-x64"].name, "g1t-windows-x64.exe");
    }
}
