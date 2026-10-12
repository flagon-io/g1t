//! `g1t push`: a local image to g1t's registry, each layer in chunks.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::cli::PushArgs;
use crate::reference::Reference;
use crate::{chunk, credentials, image, registry};

#[derive(Debug, PartialEq, Eq)]
pub struct Push {
    /// The local image, or the tarball it was saved to.
    pub image: Option<String>,
    pub archive: Option<PathBuf>,
    pub target: Reference,
    pub chunk_size: u64,
    pub token_stdin: bool,
}

impl Push {
    pub fn from_args(args: PushArgs) -> Result<Push, String> {
        let PushArgs {
            image,
            target,
            chunk_size,
            token_stdin,
            archive,
        } = args;
        let target = match (target, &image) {
            (Some(address), _) => Reference::parse(&address)?
                .ok_or_else(|| format!("`{address}` does not name a registry, like g1t.sh/<workspace>/<name>:<tag>."))?,
            (None, Some(image)) => Reference::parse(image)?.ok_or_else(|| {
                format!("`{image}` is not an address on g1t.sh. Say where to push it: --as g1t.sh/<workspace>/<name>:<tag>.")
            })?,
            (None, None) if archive.is_some() => {
                return Err("Say where to push the archive: --as g1t.sh/<workspace>/<name>:<tag>.".to_owned());
            }
            (None, None) => return Err("Name the image to push: g1t push <image>[:<tag>].".to_owned()),
        };
        Ok(Push {
            image,
            archive,
            target,
            chunk_size,
            token_stdin,
        })
    }

    pub fn run(self) -> Result<(), String> {
        let credentials = credentials::find(&self.target.host, self.token_stdin)?;
        let work = WorkDir::new()?;
        let tar = match (&self.archive, &self.image) {
            (Some(archive), _) => {
                println!("Reading {}", archive.display());
                archive.clone()
            }
            (None, image) => {
                let image = image.as_deref().unwrap_or_default();
                println!("Reading {image} from docker");
                let tar = work.0.join("image.tar");
                docker_save(image, &tar)?;
                tar
            }
        };
        let image = image::load(&tar, &work.0)?;
        let compressed = image
            .layers
            .iter()
            .filter(|l| matches!(l.source, image::Source::File(_)))
            .count();
        if image.converted {
            println!(
                "Compressed {compressed} layer(s) saved uncompressed, and wrote the image a manifest naming them"
            );
        }
        let mut registry = registry::Registry::new(
            self.target.base_url(),
            self.target.host.clone(),
            self.target.name.clone(),
            credentials,
        );
        registry.sign_in()?;
        println!("Pushing to {}", self.target);
        let blobs = std::iter::once(("config", &image.config))
            .chain(image.layers.iter().map(|l| ("layer", l)));
        let mut seen = std::collections::HashSet::new();
        for (kind, blob) in blobs {
            if !seen.insert(blob.digest.clone()) {
                continue;
            }
            let short = &blob.digest[..blob.digest.len().min(19)];
            let size = chunk::human(blob.size);
            let outcome = registry.push_blob(blob, &tar, self.chunk_size)?;
            let said = match outcome {
                registry::Outcome::Exists => "already on the registry, skipped".to_owned(),
                registry::Outcome::Uploaded { chunks: 1 } => "uploaded".to_owned(),
                registry::Outcome::Uploaded { chunks } => format!("uploaded in {chunks} chunks"),
            };
            println!("  {kind:<6} {short}  {size:>10}  {said}");
        }
        let ours = image.manifest_digest();
        let theirs =
            registry.push_manifest(&self.target.tag, &image.media_type, &image.manifest)?;
        if !theirs.is_empty() && theirs != ours {
            return Err(format!(
                "The registry kept the manifest as {theirs}, not {ours}."
            ));
        }
        println!("Pushed {}", self.target);
        println!("digest: {ours}");
        Ok(())
    }
}

/// `docker save <image>`, streamed into `out`.
fn docker_save(image: &str, out: &Path) -> Result<(), String> {
    let mut file = std::fs::File::create(out)
        .map_err(|e| format!("Could not write {}: {e}", out.display()))?;
    let mut child = Command::new("docker")
        .args(["save", image])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not run docker: {e}"))?;
    let mut stdout = child.stdout.take().ok_or("docker gave no output.")?;
    let copied = std::io::copy(&mut stdout, &mut file);
    let output = child
        .wait_with_output()
        .map_err(|e| format!("docker save failed: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("docker save {image} failed: {}", stderr.trim()));
    }
    copied.map_err(|e| format!("Could not save the image: {e}"))?;
    Ok(())
}

/// A directory for the saved image and compressed layers, removed after.
struct WorkDir(PathBuf);

impl WorkDir {
    fn new() -> Result<WorkDir, String> {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let dir = std::env::temp_dir().join(format!("g1t-push-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Could not make {}: {e}", dir.display()))?;
        Ok(WorkDir(dir))
    }
}

impl Drop for WorkDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{Cli, Command};
    use clap::Parser;

    fn parse(args: &[&str]) -> Result<Push, String> {
        let argv = std::iter::once("g1t")
            .chain(std::iter::once("push"))
            .chain(args.iter().copied());
        let cli = Cli::try_parse_from(argv).map_err(|e| e.to_string())?;
        match cli.command {
            Command::Push(args) => Push::from_args(args),
            _ => unreachable!(),
        }
    }

    #[test]
    fn an_image_named_for_g1t_pushes_to_itself() {
        let push = parse(&["g1t.sh/acme/web:1"]).unwrap();
        assert_eq!(push.target.to_string(), "g1t.sh/acme/web:1");
        assert_eq!(push.chunk_size, chunk::DEFAULT_CHUNK);
        assert!(!push.token_stdin);
    }

    #[test]
    fn as_names_the_destination() {
        let push = parse(&[
            "web:dev",
            "--as",
            "g1t.sh/acme/web:2",
            "--chunk-size=50MB",
            "--token-stdin",
        ])
        .unwrap();
        assert_eq!(push.image.as_deref(), Some("web:dev"));
        assert_eq!(push.target.to_string(), "g1t.sh/acme/web:2");
        assert_eq!(push.chunk_size, 50 * chunk::MIB);
        assert!(push.token_stdin);
    }

    #[test]
    fn bad_pushes_are_explained() {
        assert!(parse(&["web:dev"]).unwrap_err().contains("--as"));
        assert!(parse(&[]).is_err());
        assert!(
            parse(&["g1t.sh/acme/web", "--chunk-size", "200MB"])
                .unwrap_err()
                .contains("95MiB")
        );
        assert!(parse(&["g1t.sh/acme/web", "--bogus"]).is_err());
        assert!(parse(&["a", "b", "--as", "g1t.sh/acme/web"]).is_err());
        assert!(
            parse(&["--archive", "web.tar"])
                .unwrap_err()
                .contains("--as")
        );
        assert!(parse(&["web:dev", "--archive", "web.tar", "--as", "g1t.sh/acme/web"]).is_err());
    }

    #[test]
    fn an_archive_pushes_without_docker() {
        let push = parse(&["--archive", "web.tar", "--as", "g1t.sh/acme/web:3"]).unwrap();
        assert_eq!(push.archive, Some(PathBuf::from("web.tar")));
        assert_eq!(push.image, None);
    }
}
