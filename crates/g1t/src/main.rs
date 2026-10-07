//! The g1t command line.

mod chunk;
mod credentials;
mod image;
mod reference;
mod registry;

use reference::Reference;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};

const HELP: &str = "\
g1t, the command line for g1t.sh

Usage:
  g1t push <image>[:<tag>] [--as g1t.sh/<workspace>/<name>:<tag>]
           [--chunk-size 90MB] [--token-stdin]
  g1t push --archive <file.tar> --as g1t.sh/<workspace>/<name>:<tag>
  g1t help
  g1t --version

Commands:
  push      Send a local docker image to g1t.sh. Each layer goes up in
            chunks, so a layer can be any size.

Push options:
  --as <address>      Where to push, when the image's own name is not an
                      address on g1t.sh. The tag defaults to latest.
  --chunk-size <n>    How much of a layer each request carries: 5MB to
                      95MB, 90MB unless set. MB and MiB both mean 1,048,576
                      bytes.
  --token-stdin       Read the g1t token from stdin.
  --archive <file>    Push a tarball `docker save` wrote, instead of asking
                      docker for the image.

The token is the first of: --token-stdin, the G1T_TOKEN environment
variable, or what `docker login g1t.sh` stored.
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        None | Some("help" | "-h" | "--help") => {
            print!("{HELP}");
            Ok(())
        }
        Some("-V" | "--version" | "version") => {
            println!("g1t {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Some("push") if args.iter().any(|a| a == "-h" || a == "--help") => {
            print!("{HELP}");
            Ok(())
        }
        Some("push") => PushArgs::parse(&args[1..]).and_then(|push| push.run()),
        Some(other) => Err(format!("Unknown command `{other}`. See `g1t help`.")),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("g1t: {error}");
            ExitCode::FAILURE
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct PushArgs {
    /// The local image, or the tarball it was saved to.
    image: Option<String>,
    archive: Option<PathBuf>,
    target: Reference,
    chunk_size: u64,
    token_stdin: bool,
}

impl PushArgs {
    fn parse(args: &[String]) -> Result<PushArgs, String> {
        let mut image = None;
        let mut target = None;
        let mut chunk_size = chunk::DEFAULT_CHUNK;
        let mut token_stdin = false;
        let mut archive = None;
        let mut args = args.iter();
        while let Some(arg) = args.next() {
            let (flag, inline) = match arg.split_once('=') {
                Some((flag, value)) if flag.starts_with("--") => (flag, Some(value.to_owned())),
                _ => (arg.as_str(), None),
            };
            let mut value = |name: &str| {
                inline
                    .clone()
                    .or_else(|| args.next().cloned())
                    .ok_or_else(|| format!("{name} needs a value."))
            };
            match flag {
                "--as" => target = Some(value("--as")?),
                "--chunk-size" => {
                    chunk_size = chunk::check_chunk(chunk::parse_size(&value("--chunk-size")?)?)?
                }
                "--token-stdin" => token_stdin = true,
                "--archive" => archive = Some(PathBuf::from(value("--archive")?)),
                flag if flag.starts_with('-') => {
                    return Err(format!("Unknown option `{flag}`. See `g1t help`."));
                }
                _ if image.is_none() => image = Some(arg.clone()),
                _ => return Err(format!("`{arg}`: push takes one image.")),
            }
        }
        if image.is_some() && archive.is_some() {
            return Err("Push an image or an --archive, not both.".to_owned());
        }
        let target = match (target, &image) {
            (Some(address), _) => Reference::parse(&address)?
                .ok_or_else(|| format!("`{address}` does not name a registry, like g1t.sh/<workspace>/<name>:<tag>."))?,
            (None, Some(image)) => Reference::parse(image)?.ok_or_else(|| {
                format!("`{image}` is not an address on g1t.sh. Say where to push it: --as g1t.sh/<workspace>/<name>:<tag>.")
            })?,
            (None, None) if archive.is_some() => return Err("Say where to push the archive: --as g1t.sh/<workspace>/<name>:<tag>.".to_owned()),
            (None, None) => return Err("Name the image to push: g1t push <image>[:<tag>].".to_owned()),
        };
        Ok(PushArgs {
            image,
            archive,
            target,
            chunk_size,
            token_stdin,
        })
    }

    fn run(self) -> Result<(), String> {
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

    fn parse(args: &[&str]) -> Result<PushArgs, String> {
        PushArgs::parse(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>())
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
