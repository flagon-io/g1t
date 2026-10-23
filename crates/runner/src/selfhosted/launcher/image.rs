//! The sandbox's images: fetched from the release they belong to, checked
//! against the signed manifest, and kept by version in the state folder.
//!
//! The trust model is the runner's own (update.rs): `latest.json` is only
//! believed when its Ed25519 signature is g1t's release key's, built into
//! this program, and a file is only used when its SHA-256 is the one the
//! signed manifest names. A file already on disk is checked again before
//! each use. The runner's image inside the sandbox is named by digest in
//! the same manifest, so the engine that pulls it checks it too.
//!
//! A build without the release key (a developer's) cannot check anything,
//! so it fetches nothing: `--image-file` gives it a local image instead,
//! and it says loudly that it is unchecked.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use sha2::{Digest, Sha256};

use crate::selfhosted::update::{self, HostedImage, SandboxFile, SandboxRelease};

/// The images a sandbox needs, on disk and checked.
#[derive(Clone, Debug, Default)]
pub struct Local {
    pub version: String,
    /// By kind (`wsl-x64`, `vm-arm64-disk`…).
    pub files: BTreeMap<String, PathBuf>,
    /// Each file's SHA-256, as the signed release names it, by kind: none
    /// for a local image (`--image-file`), which no release names.
    pub hashes: BTreeMap<String, String>,
    /// The runner's image, by digest.
    pub runner_image: Option<String>,
    /// g1t's machine image for this machine's architecture, as the release
    /// names it: none on arm64, which it isn't built for.
    pub hosted_image: Option<HostedImage>,
}

/// g1t's machine image a release names for this machine's architecture.
pub fn hosted_image(sandbox: &SandboxRelease) -> Option<HostedImage> {
    hosted_image_for(sandbox, arch())
}

pub fn hosted_image_for(sandbox: &SandboxRelease, arch: &str) -> Option<HostedImage> {
    sandbox.hosted_images.get(arch).filter(|hosted| !hosted.image.trim().is_empty()).cloned()
}

/// This machine's architecture, as releases name it.
pub fn arch() -> &'static str {
    if std::env::consts::ARCH == "aarch64" { "arm64" } else { "x64" }
}

/// SHA-256 of a file, read in pieces.
pub fn sha256_file(path: &Path) -> Result<String> {
    let mut file = std::fs::File::open(path).with_context(|| format!("could not open {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Whether a release's sandbox has every file of `keys`, and the newest
/// signed release's version.
pub fn latest(site: &str) -> Result<update::Manifest> {
    update::latest_signed_at(site)?.ok_or_else(|| {
        anyhow!("this build of g1t-runner has no release key, so it cannot check the sandbox's images: pass --image-file with an image you built (scripts/sandbox-image.mjs)")
    })
}

/// Fetches (or finds) and checks the files of `keys` from the signed
/// release `manifest`.
pub fn obtain(site: &str, manifest: &update::Manifest, keys: &[String], images: &Path, progress: &dyn Fn(&str)) -> Result<Local> {
    let sandbox = manifest.sandbox.as_ref().ok_or_else(|| anyhow!("release {} has no sandbox images", manifest.version))?;
    let dir = images.join(&manifest.version);
    std::fs::create_dir_all(&dir).with_context(|| format!("could not make {}", dir.display()))?;
    let (mut files, mut hashes) = (BTreeMap::new(), BTreeMap::new());
    for key in keys {
        let file = sandbox.files.get(key).ok_or_else(|| anyhow!("release {} has no sandbox image {key} for this machine", manifest.version))?;
        let path = dir.join(safe_name(&file.name)?);
        if !(path.exists() && sha256_file(&path)? == file.sha256) {
            progress(&format!("Fetching the sandbox's {key} image ({} MB)", file.size.div_ceil(1_000_000)));
            download_checked(&format!("{}/{}/{}", update::downloads_at(site), manifest.version, file.name), &path, file, &|percent| {
                progress(&said_progress(key, percent, file.size));
            })?;
        }
        files.insert(key.clone(), path);
        hashes.insert(key.clone(), file.sha256.clone());
    }
    Ok(Local { version: manifest.version.clone(), files, hashes, runner_image: sandbox.runner_image.clone(), hosted_image: hosted_image(sandbox) })
}

/// How far a download is, as a log line the desktop app reads for its
/// progress bar: `Fetching the sandbox's wsl-x64 image: 40% of 612 MB`.
pub fn said_progress(key: &str, percent: u64, size: u64) -> String {
    format!("Fetching the sandbox's {key} image: {percent}% of {} MB", size.div_ceil(1_000_000))
}

/// A file name from a manifest, which must not name a folder.
fn safe_name(name: &str) -> Result<&str> {
    if name.is_empty() || name.contains(['/', '\\']) || name.starts_with('.') {
        bail!("the release names a sandbox image {name:?}, which is not a file name");
    }
    Ok(name)
}

/// Downloads to `path`, hashing as it goes; the file only takes its name
/// once its SHA-256 is the manifest's. Says how far it is at each tenth
/// (`progress`, in percent), when the manifest gives the file's size.
fn download_checked(url: &str, path: &Path, want: &SandboxFile, progress: &dyn Fn(u64)) -> Result<()> {
    let response = crate::http::agent().get(url).timeout(std::time::Duration::from_secs(3600)).call().map_err(|e| anyhow!("could not fetch {url}: {e}"))?;
    let part = path.with_extension("part");
    let mut out = std::fs::File::create(&part).with_context(|| format!("could not write {}", part.display()))?;
    let mut reader = response.into_reader();
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    let (mut done, mut said) = (0u64, 0u64);
    loop {
        let read = reader.read(&mut buffer).with_context(|| format!("the download of {url} broke off"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        out.write_all(&buffer[..read])?;
        done += read as u64;
        let tenth = tenths(done, want.size);
        if tenth > said {
            said = tenth;
            progress(tenth * 10);
        }
    }
    out.sync_all()?;
    drop(out);
    if hex::encode(hasher.finalize()) != want.sha256 {
        let _ = std::fs::remove_file(&part);
        bail!("the sandbox image {}'s SHA-256 is not the release's; not using it", want.name);
    }
    std::fs::rename(&part, path)?;
    Ok(())
}

/// How many whole tenths of `size` are `done`, below ten: the last is
/// said by the download ending. None of a file of no known size.
fn tenths(done: u64, size: u64) -> u64 {
    done.saturating_mul(10).checked_div(size).map_or(0, |tenths| tenths.min(9))
}

/// A local image (`--image-file`), unchecked: for a build of the sandbox
/// that is not released.
pub fn local(keys: &[String], given: &Path, runner_image: Option<String>) -> Result<Local> {
    if !given.exists() {
        bail!("{} does not exist", given.display());
    }
    let mut files = BTreeMap::new();
    if keys.len() == 1 {
        files.insert(keys[0].clone(), given.to_path_buf());
    } else {
        // A folder holding the VM's files, named as a release names them.
        for key in keys {
            let suffix = key.rsplit('-').next().unwrap_or(key);
            let found = std::fs::read_dir(given)?
                .flatten()
                .map(|e| e.path())
                .find(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.contains(suffix)))
                .ok_or_else(|| anyhow!("{} has no {key} file", given.display()))?;
            files.insert(key.clone(), found);
        }
    }
    Ok(Local { version: "local".into(), files, hashes: BTreeMap::new(), runner_image, hosted_image: None })
}

/// Removes every version but `keep`.
pub fn prune(images: &Path, keep: &str) {
    let Ok(entries) = std::fs::read_dir(images) else { return };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy() != keep {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_files_hash_is_read_in_pieces() {
        let dir = std::env::temp_dir().join(format!("g1t-sandbox-image-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("x");
        std::fs::write(&path, b"abc").unwrap();
        assert_eq!(sha256_file(&path).unwrap(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_manifest_cannot_name_a_folder() {
        assert!(safe_name("g1t-sandbox-wsl-x64.tar.gz").is_ok());
        for bad in ["../x", "a/b", "a\\b", ".hidden", ""] {
            assert!(safe_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_release_without_the_sandbox_is_refused() {
        let manifest: update::Manifest = serde_json::from_str(r#"{"version":"0.2.0","files":{}}"#).unwrap();
        let refused = obtain("https://g1t.sh", &manifest, &["wsl-x64".into()], Path::new("."), &|_| {}).unwrap_err();
        assert!(refused.to_string().contains("no sandbox images"));
        let manifest: update::Manifest =
            serde_json::from_str(r#"{"version":"0.3.0","files":{},"sandbox":{"runner_image":"r@sha256:1","files":{"wsl-x64":{"name":"w.tar.gz","sha256":"00"}}}}"#).unwrap();
        let refused = obtain("https://g1t.sh", &manifest, &["vm-arm64-disk".into()], &std::env::temp_dir(), &|_| {}).unwrap_err();
        assert!(refused.to_string().contains("no sandbox image vm-arm64-disk"));
    }

    #[test]
    fn g1ts_machine_image_is_named_for_x64_alone() {
        let manifest: update::Manifest = serde_json::from_str(
            r#"{"version":"0.3.7","files":{},"sandbox":{"runner_image":"r@sha256:1","hosted_images":{"x64":{"image":"g1t.sh/flagon-io/g1t-hosted@sha256:d5","size":5636544756}},"files":{}}}"#,
        )
        .unwrap();
        let sandbox = manifest.sandbox.unwrap();
        let x64 = hosted_image_for(&sandbox, "x64").unwrap();
        assert_eq!((x64.image.as_str(), x64.size), ("g1t.sh/flagon-io/g1t-hosted@sha256:d5", Some(5_636_544_756)));
        assert_eq!(hosted_image_for(&sandbox, "arm64"), None, "an arm64 sandbox can't run it, so it isn't given it");
        let older: update::Manifest = serde_json::from_str(r#"{"version":"0.3.6","files":{},"sandbox":{"runner_image":"r@sha256:1","files":{}}}"#).unwrap();
        assert_eq!(hosted_image_for(&older.sandbox.unwrap(), "x64"), None, "a release from before it names none");
    }

    #[test]
    fn a_download_says_how_far_it_is_by_tenths() {
        assert_eq!(tenths(0, 600), 0);
        assert_eq!(tenths(59, 600), 0);
        assert_eq!(tenths(60, 600), 1);
        assert_eq!(tenths(599, 600), 9);
        assert_eq!(tenths(600, 600), 9);
        assert_eq!(tenths(5, 0), 0);
        assert_eq!(said_progress("wsl-x64", 40, 612_000_000), "Fetching the sandbox's wsl-x64 image: 40% of 612 MB");
    }

    #[test]
    fn a_local_vm_image_is_found_by_its_parts() {
        let dir = std::env::temp_dir().join(format!("g1t-sandbox-local-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for name in ["g1t-sandbox-vm-arm64-kernel", "g1t-sandbox-vm-arm64-initrd", "g1t-sandbox-vm-arm64-disk.raw.gz"] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        let keys: Vec<String> = ["kernel", "initrd", "disk"].iter().map(|k| format!("vm-arm64-{k}")).collect();
        let found = local(&keys, &dir, None).unwrap();
        assert!(found.files["vm-arm64-disk"].to_string_lossy().ends_with("disk.raw.gz"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
