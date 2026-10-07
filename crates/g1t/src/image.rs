//! A local image, read from what `docker save` writes: the OCI layout
//! (`index.json`, `oci-layout`, `blobs/sha256/*`) or the classic layout
//! (`manifest.json` and a tar per layer), turned into the blobs and the
//! manifest a registry takes.
//!
//! Layers already compressed are pushed as they are, and so is the image's
//! own manifest when nothing had to change. An uncompressed layer is gzipped,
//! and the manifest names the gzipped blob; the config, and so its
//! `diff_ids` (the digests of the uncompressed layers), stays as it was.

use flate2::Compression;
use flate2::write::GzEncoder;
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use std::collections::HashMap;
use std::fs::File;
use std::io::{self, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub const OCI_INDEX: &str = "application/vnd.oci.image.index.v1+json";
pub const OCI_MANIFEST: &str = "application/vnd.oci.image.manifest.v1+json";
pub const DOCKER_LIST: &str = "application/vnd.docker.distribution.manifest.list.v2+json";
pub const DOCKER_MANIFEST: &str = "application/vnd.docker.distribution.manifest.v2+json";
pub const DOCKER_CONFIG: &str = "application/vnd.docker.container.image.v1+json";
pub const DOCKER_LAYER_GZIP: &str = "application/vnd.docker.image.rootfs.diff.tar.gzip";
pub const OCI_LAYER_GZIP: &str = "application/vnd.oci.image.layer.v1.tar+gzip";

/// Where a blob's bytes are.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Source {
    /// `size` bytes at `offset` in the saved tar.
    Tar { offset: u64 },
    /// A file this push wrote (a gzipped layer).
    File(PathBuf),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Blob {
    pub digest: String,
    pub size: u64,
    pub source: Source,
}

#[derive(Debug)]
pub struct Image {
    pub config: Blob,
    pub layers: Vec<Blob>,
    pub manifest: Vec<u8>,
    pub media_type: String,
    /// Whether any layer was compressed for the push (so the manifest is new).
    pub converted: bool,
}

impl Image {
    pub fn manifest_digest(&self) -> String {
        sha256_of(&self.manifest)
    }
}

pub fn sha256_of(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

type Result<T> = std::result::Result<T, String>;

/// The files in a tar: where each one's bytes start, and how many.
struct TarIndex {
    files: HashMap<String, (u64, u64)>,
    links: HashMap<String, String>,
}

/// `./a/../b//c` → `b/c`.
fn normalize(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split(['/', '\\']) {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }
    parts.join("/")
}

impl TarIndex {
    fn read(file: &mut File) -> Result<TarIndex> {
        file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
        let mut archive = tar::Archive::new(&mut *file);
        let mut files = HashMap::new();
        let mut links = HashMap::new();
        let entries = archive
            .entries_with_seek()
            .map_err(|e| format!("The saved image is not a tar: {e}"))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("The saved image is not a readable tar: {e}"))?;
            let path = normalize(&entry.path().map_err(|e| e.to_string())?.to_string_lossy());
            let kind = entry.header().entry_type();
            if kind.is_file() {
                files.insert(path, (entry.raw_file_position(), entry.size()));
            } else if (kind.is_symlink() || kind.is_hard_link())
                && let Ok(Some(target)) = entry.link_name()
            {
                let target = target.to_string_lossy().into_owned();
                // A symlink is relative to its own directory; a hard link
                // to the top of the archive.
                let resolved = if kind.is_symlink() && !target.starts_with('/') {
                    let dir = path.rsplit_once('/').map_or("", |(dir, _)| dir);
                    normalize(&format!("{dir}/{target}"))
                } else {
                    normalize(&target)
                };
                links.insert(path, resolved);
            }
        }
        Ok(TarIndex { files, links })
    }

    fn find(&self, path: &str) -> Option<(u64, u64)> {
        let mut path = normalize(path);
        for _ in 0..16 {
            if let Some(found) = self.files.get(&path) {
                return Some(*found);
            }
            path = self.links.get(&path)?.clone();
        }
        None
    }
}

/// Reads the saved image in `tar`, writing any layer it has to compress
/// into `work`.
pub fn load(tar: &Path, work: &Path) -> Result<Image> {
    let mut file = File::open(tar).map_err(|e| format!("Could not open {}: {e}", tar.display()))?;
    let index = TarIndex::read(&mut file)?;
    let mut saved = Saved {
        file,
        index,
        work: work.to_owned(),
    };
    let has_oci = saved.index.find("index.json").is_some();
    let has_classic = saved.index.find("manifest.json").is_some();
    match (has_oci, has_classic) {
        (true, false) => saved.oci(),
        (true, true) => saved.oci().or_else(|oci| saved.classic().map_err(|_| oci)),
        (false, true) => saved.classic(),
        (false, false) => {
            Err("The saved image has neither index.json nor manifest.json.".to_owned())
        }
    }
}

struct Saved {
    file: File,
    index: TarIndex,
    work: PathBuf,
}

/// What a layer's first bytes say it is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Compressed {
    Gzip,
    Zstd,
    No,
}

impl Saved {
    fn read_path(&mut self, path: &str) -> Result<Vec<u8>> {
        let (offset, size) = self
            .index
            .find(path)
            .ok_or_else(|| format!("The saved image has no {path}."))?;
        if size > 64 * 1024 * 1024 {
            return Err(format!("{path} is too large to be a manifest or config."));
        }
        let mut bytes = vec![0; size as usize];
        self.file
            .seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        self.file
            .read_exact(&mut bytes)
            .map_err(|e| format!("Could not read {path}: {e}"))?;
        Ok(bytes)
    }

    fn read_json(&mut self, path: &str) -> Result<(Vec<u8>, Value)> {
        let bytes = self.read_path(path)?;
        let value =
            serde_json::from_slice(&bytes).map_err(|e| format!("{path} is not JSON: {e}"))?;
        Ok((bytes, value))
    }

    fn blob_path(digest: &str) -> Result<String> {
        let (algorithm, hex) = digest
            .split_once(':')
            .ok_or_else(|| format!("`{digest}` is not a digest."))?;
        Ok(format!("blobs/{algorithm}/{hex}"))
    }

    fn has_blob(&self, digest: &str) -> bool {
        Self::blob_path(digest).is_ok_and(|path| self.index.find(&path).is_some())
    }

    fn sniff(&mut self, offset: u64, size: u64) -> Result<Compressed> {
        let mut magic = [0u8; 4];
        let n = size.min(4) as usize;
        self.file
            .seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        self.file
            .read_exact(&mut magic[..n])
            .map_err(|e| e.to_string())?;
        Ok(match magic {
            [0x1f, 0x8b, ..] => Compressed::Gzip,
            [0x28, 0xb5, 0x2f, 0xfd] => Compressed::Zstd,
            _ => Compressed::No,
        })
    }

    /// Hashes `size` bytes at `offset`.
    fn hash_range(&mut self, offset: u64, size: u64) -> Result<String> {
        self.file
            .seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        let mut hasher = Sha256::new();
        io::copy(
            &mut (&mut self.file).take(size),
            &mut HashWriter(&mut hasher),
        )
        .map_err(|e| e.to_string())?;
        Ok(format!("sha256:{}", hex::encode(hasher.finalize())))
    }

    /// Gzips `size` bytes at `offset` into the work directory. Returns the
    /// gzipped blob and the digest of the bytes before compression.
    fn gzip(&mut self, offset: u64, size: u64, n: usize) -> Result<(Blob, String)> {
        let path = self.work.join(format!("layer-{n}.tar.gz"));
        let out =
            File::create(&path).map_err(|e| format!("Could not write {}: {e}", path.display()))?;
        let mut compressed_hash = Sha256::new();
        let mut counted = Counted {
            inner: BufWriter::with_capacity(1 << 20, out),
            hasher: &mut compressed_hash,
            bytes: 0,
        };
        let mut plain_hash = Sha256::new();
        {
            let mut encoder = GzEncoder::new(&mut counted, Compression::default());
            self.file
                .seek(SeekFrom::Start(offset))
                .map_err(|e| e.to_string())?;
            let mut reader = (&mut self.file).take(size);
            let mut buffer = vec![0u8; 1 << 20];
            loop {
                let read = reader.read(&mut buffer).map_err(|e| e.to_string())?;
                if read == 0 {
                    break;
                }
                plain_hash.update(&buffer[..read]);
                encoder
                    .write_all(&buffer[..read])
                    .map_err(|e| format!("Could not compress a layer: {e}"))?;
            }
            encoder
                .finish()
                .map_err(|e| format!("Could not compress a layer: {e}"))?;
        }
        counted.inner.flush().map_err(|e| e.to_string())?;
        let written = counted.bytes;
        drop(counted);
        let blob = Blob {
            digest: format!("sha256:{}", hex::encode(compressed_hash.finalize())),
            size: written,
            source: Source::File(path),
        };
        Ok((
            blob,
            format!("sha256:{}", hex::encode(plain_hash.finalize())),
        ))
    }

    /// A layer as the registry takes it: as it is when compressed, gzipped
    /// when not. `diff_id` is checked against what gets compressed.
    fn layer(&mut self, path: &str, n: usize, diff_id: Option<&str>) -> Result<(Blob, Compressed)> {
        let (offset, size) = self
            .index
            .find(path)
            .ok_or_else(|| format!("The saved image has no layer {path}."))?;
        match self.sniff(offset, size)? {
            Compressed::No => {
                let (blob, plain) = self.gzip(offset, size, n)?;
                if let Some(diff_id) = diff_id
                    && diff_id != plain
                {
                    return Err(format!(
                        "Layer {n} is {plain}, but the image's config says {diff_id}."
                    ));
                }
                Ok((blob, Compressed::No))
            }
            compressed => {
                let digest = match path.strip_prefix("blobs/sha256/") {
                    Some(hex) if hex.len() == 64 => format!("sha256:{hex}"),
                    _ => self.hash_range(offset, size)?,
                };
                Ok((
                    Blob {
                        digest,
                        size,
                        source: Source::Tar { offset },
                    },
                    compressed,
                ))
            }
        }
    }

    fn config_blob(&mut self, path: &str) -> Result<(Blob, Value)> {
        let (offset, size) = self
            .index
            .find(path)
            .ok_or_else(|| format!("The saved image has no config {path}."))?;
        let (bytes, config) = self.read_json(path)?;
        Ok((
            Blob {
                digest: sha256_of(&bytes),
                size,
                source: Source::Tar { offset },
            },
            config,
        ))
    }

    /// The OCI layout: index.json, down through any image index, to one
    /// image manifest whose blobs were saved.
    fn oci(&mut self) -> Result<Image> {
        let (_, index) = self.read_json("index.json")?;
        let mut descriptor = first_manifest(&index).ok_or("index.json lists no image.")?;
        let (bytes, manifest, media_type) = loop {
            let digest = descriptor
                .get("digest")
                .and_then(Value::as_str)
                .ok_or("A descriptor has no digest.")?
                .to_owned();
            let (bytes, value) = self.read_json(&Self::blob_path(&digest)?)?;
            let media_type = value
                .get("mediaType")
                .and_then(Value::as_str)
                .or_else(|| descriptor.get("mediaType").and_then(Value::as_str))
                .unwrap_or(OCI_MANIFEST)
                .to_owned();
            if media_type == OCI_INDEX
                || media_type == DOCKER_LIST
                || value.get("manifests").is_some()
            {
                descriptor = self
                    .pick_platform(&value)
                    .ok_or("No image in the saved index has all its layers saved.")?;
                continue;
            }
            break (bytes, value, media_type);
        };
        let config_digest = manifest
            .pointer("/config/digest")
            .and_then(Value::as_str)
            .ok_or("The manifest has no config.")?;
        let (config, config_json) = self.config_blob(&Self::blob_path(config_digest)?)?;
        if config.digest != config_digest {
            return Err(format!(
                "The saved config is {}, not {config_digest}.",
                config.digest
            ));
        }
        let diff_ids = diff_ids(&config_json);
        let descriptors = manifest
            .get("layers")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut new_manifest = manifest.clone();
        let mut layers = Vec::new();
        let mut converted = false;
        for (n, descriptor) in descriptors.iter().enumerate() {
            let digest = descriptor
                .get("digest")
                .and_then(Value::as_str)
                .ok_or("A layer has no digest.")?;
            let declared = descriptor
                .get("mediaType")
                .and_then(Value::as_str)
                .unwrap_or("");
            let (blob, compressed) = self.layer(
                &Self::blob_path(digest)?,
                n,
                diff_ids.get(n).map(String::as_str),
            )?;
            let media_type = layer_media_type(declared, compressed, &media_type);
            if blob.digest != digest || media_type != declared {
                converted = true;
                let entry = &mut new_manifest["layers"][n];
                entry["digest"] = json!(blob.digest);
                entry["size"] = json!(blob.size);
                entry["mediaType"] = json!(media_type);
            }
            layers.push(blob);
        }
        let manifest = if converted {
            serde_json::to_vec(&new_manifest).map_err(|e| e.to_string())?
        } else {
            bytes
        };
        Ok(Image {
            config,
            layers,
            manifest,
            media_type,
            converted,
        })
    }

    /// Of an index's images, the one for this machine whose blobs were all
    /// saved; attestations are not images.
    fn pick_platform(&self, index: &Value) -> Option<Value> {
        let arch = match std::env::consts::ARCH {
            "x86_64" => "amd64",
            "aarch64" => "arm64",
            other => other,
        };
        let candidates: Vec<&Value> = index
            .get("manifests")?
            .as_array()?
            .iter()
            .filter(|d| d.pointer("/platform/os").and_then(Value::as_str) != Some("unknown"))
            .filter(|d| {
                d.pointer("/annotations/vnd.docker.reference.type")
                    .is_none()
            })
            .filter(|d| {
                d.get("digest")
                    .and_then(Value::as_str)
                    .is_some_and(|digest| self.complete(digest))
            })
            .collect();
        let native = candidates.iter().find(|d| {
            d.pointer("/platform/os").and_then(Value::as_str) == Some("linux")
                && d.pointer("/platform/architecture").and_then(Value::as_str) == Some(arch)
        });
        native.or(candidates.first()).map(|d| (*d).clone())
    }

    /// Whether a manifest (or index) and everything it names were saved.
    fn complete(&self, digest: &str) -> bool {
        let Ok(path) = Self::blob_path(digest) else {
            return false;
        };
        let Some((offset, size)) = self.index.find(&path) else {
            return false;
        };
        let Ok(mut file) = self.file.try_clone() else {
            return false;
        };
        let mut bytes = vec![0; size.min(64 * 1024 * 1024) as usize];
        if file.seek(SeekFrom::Start(offset)).is_err() || file.read_exact(&mut bytes).is_err() {
            return false;
        }
        let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
            return false;
        };
        if let Some(children) = value.get("manifests").and_then(Value::as_array) {
            return children.iter().any(|c| {
                c.get("digest")
                    .and_then(Value::as_str)
                    .is_some_and(|d| self.complete(d))
            });
        }
        let config = value.pointer("/config/digest").and_then(Value::as_str);
        let layers = value.get("layers").and_then(Value::as_array);
        config.is_some_and(|c| self.has_blob(c))
            && layers.is_some_and(|l| {
                l.iter().all(|d| {
                    d.get("digest")
                        .and_then(Value::as_str)
                        .is_some_and(|d| self.has_blob(d))
                })
            })
    }

    /// The classic layout: manifest.json names the config and the layer
    /// tars, and the push gets a new Docker manifest.
    fn classic(&mut self) -> Result<Image> {
        let (_, saved) = self.read_json("manifest.json")?;
        let entry = saved
            .as_array()
            .and_then(|images| images.first())
            .ok_or("manifest.json lists no image.")?
            .clone();
        let config_path = entry
            .get("Config")
            .and_then(Value::as_str)
            .ok_or("manifest.json names no config.")?;
        let (config, config_json) = self.config_blob(config_path)?;
        let diff_ids = diff_ids(&config_json);
        let paths: Vec<String> = entry
            .get("Layers")
            .and_then(Value::as_array)
            .map(|l| {
                l.iter()
                    .filter_map(|p| p.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        if !diff_ids.is_empty() && diff_ids.len() != paths.len() {
            return Err(format!(
                "The image has {} layers, but its config lists {}.",
                paths.len(),
                diff_ids.len()
            ));
        }
        let mut layers = Vec::new();
        let mut descriptors = Vec::new();
        for (n, path) in paths.iter().enumerate() {
            let (blob, compressed) = self.layer(path, n, diff_ids.get(n).map(String::as_str))?;
            if compressed == Compressed::Zstd {
                return Err(format!(
                    "Layer {n} is zstd, which a Docker manifest cannot name."
                ));
            }
            descriptors.push(
                json!({ "mediaType": DOCKER_LAYER_GZIP, "size": blob.size, "digest": blob.digest }),
            );
            layers.push(blob);
        }
        let manifest = json!({
            "schemaVersion": 2,
            "mediaType": DOCKER_MANIFEST,
            "config": { "mediaType": DOCKER_CONFIG, "size": config.size, "digest": config.digest },
            "layers": descriptors,
        });
        let manifest = serde_json::to_vec(&manifest).map_err(|e| e.to_string())?;
        Ok(Image {
            config,
            layers,
            manifest,
            media_type: DOCKER_MANIFEST.to_owned(),
            converted: true,
        })
    }
}

fn first_manifest(index: &Value) -> Option<Value> {
    index.get("manifests")?.as_array()?.first().cloned()
}

fn diff_ids(config: &Value) -> Vec<String> {
    config
        .pointer("/rootfs/diff_ids")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(|d| d.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// The media type a layer is pushed with: what it said, when that matches
/// its bytes; gzip or zstd in the manifest's family when it does not.
fn layer_media_type(declared: &str, compressed: Compressed, manifest_type: &str) -> String {
    let docker = manifest_type == DOCKER_MANIFEST;
    let says_gzip = declared.ends_with("+gzip") || declared.ends_with(".gzip");
    let says_zstd = declared.ends_with("+zstd") || declared.ends_with(".zstd");
    match compressed {
        Compressed::Gzip if says_gzip => declared.to_owned(),
        Compressed::Zstd if says_zstd => declared.to_owned(),
        Compressed::Zstd => "application/vnd.oci.image.layer.v1.tar+zstd".to_owned(),
        // Gzipped by the push, or gzip that said otherwise.
        _ if docker || declared.starts_with("application/vnd.docker.") => {
            DOCKER_LAYER_GZIP.to_owned()
        }
        _ => OCI_LAYER_GZIP.to_owned(),
    }
}

struct HashWriter<'a>(&'a mut Sha256);

impl Write for HashWriter<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.update(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Writes through, hashing and counting what passes.
struct Counted<'a, W: Write> {
    inner: W,
    hasher: &'a mut Sha256,
    bytes: u64,
}

impl<W: Write> Write for Counted<'_, W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.hasher.update(&buf[..n]);
        self.bytes += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::read::GzDecoder;

    /// A scratch directory, gone when dropped.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Scratch {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir()
                .join(format!("g1t-test-{name}-{}-{nanos}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A layer: a tar holding one file.
    fn layer_tar(name: &str, contents: &[u8]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_size(contents.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder.append_data(&mut header, name, contents).unwrap();
        builder.into_inner().unwrap()
    }

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    fn hex_of(bytes: &[u8]) -> String {
        hex::encode(Sha256::digest(bytes))
    }

    enum Entry<'a> {
        File(&'a str, Vec<u8>),
        Symlink(&'a str, &'a str),
    }

    fn write_tar(path: &Path, entries: Vec<Entry>) {
        let mut builder = tar::Builder::new(File::create(path).unwrap());
        for entry in entries {
            let mut header = tar::Header::new_gnu();
            header.set_mode(0o644);
            match entry {
                Entry::File(name, bytes) => {
                    header.set_size(bytes.len() as u64);
                    header.set_cksum();
                    builder
                        .append_data(&mut header, name, bytes.as_slice())
                        .unwrap();
                }
                Entry::Symlink(name, target) => {
                    header.set_entry_type(tar::EntryType::Symlink);
                    header.set_size(0);
                    builder.append_link(&mut header, name, target).unwrap();
                }
            }
        }
        builder.finish().unwrap();
    }

    fn config_for(layers: &[&[u8]]) -> Vec<u8> {
        let ids: Vec<String> = layers
            .iter()
            .map(|l| format!("sha256:{}", hex_of(l)))
            .collect();
        serde_json::to_vec(&json!({
            "architecture": "amd64", "os": "linux",
            "config": { "Cmd": ["sh"] },
            "rootfs": { "type": "layers", "diff_ids": ids },
        }))
        .unwrap()
    }

    fn read_blob(blob: &Blob, tar: &Path) -> Vec<u8> {
        match &blob.source {
            Source::File(path) => std::fs::read(path).unwrap(),
            Source::Tar { offset } => {
                let mut file = File::open(tar).unwrap();
                file.seek(SeekFrom::Start(*offset)).unwrap();
                let mut bytes = vec![0; blob.size as usize];
                file.read_exact(&mut bytes).unwrap();
                bytes
            }
        }
    }

    fn gunzip(bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        GzDecoder::new(bytes).read_to_end(&mut out).unwrap();
        out
    }

    /// Every blob's digest and size match its bytes, and the manifest names
    /// exactly the blobs that will be pushed.
    fn assert_consistent(image: &Image, tar: &Path) {
        let manifest: Value = serde_json::from_slice(&image.manifest).unwrap();
        assert_eq!(manifest["mediaType"], image.media_type);
        let config_bytes = read_blob(&image.config, tar);
        assert_eq!(sha256_of(&config_bytes), image.config.digest);
        assert_eq!(manifest["config"]["digest"], image.config.digest);
        assert_eq!(manifest["config"]["size"], image.config.size);
        let config: Value = serde_json::from_slice(&config_bytes).unwrap();
        let listed = manifest["layers"].as_array().unwrap();
        assert_eq!(listed.len(), image.layers.len());
        for (n, (blob, descriptor)) in image.layers.iter().zip(listed).enumerate() {
            let bytes = read_blob(blob, tar);
            assert_eq!(bytes.len() as u64, blob.size);
            assert_eq!(sha256_of(&bytes), blob.digest);
            assert_eq!(descriptor["digest"], blob.digest);
            assert_eq!(descriptor["size"], blob.size);
            assert!(descriptor["mediaType"].as_str().unwrap().ends_with("gzip"));
            // The uncompressed layer is the one the config's diff_ids name.
            assert_eq!(config["rootfs"]["diff_ids"][n], sha256_of(&gunzip(&bytes)));
        }
    }

    #[test]
    fn the_classic_layout_gets_gzipped_layers_and_a_docker_manifest() {
        let scratch = Scratch::new("classic");
        let one = layer_tar("hello", b"hello world");
        let two = layer_tar("blob", &vec![7u8; 300_000]);
        let config = config_for(&[&one, &two]);
        let config_name = format!("{}.json", hex_of(&config));
        let saved = json!([{ "Config": config_name, "RepoTags": ["web:1"], "Layers": ["aaa/layer.tar", "bbb/layer.tar"] }]);
        let tar = scratch.0.join("save.tar");
        write_tar(
            &tar,
            vec![
                Entry::File(&config_name, config.clone()),
                Entry::File("aaa/layer.tar", one.clone()),
                Entry::File("bbb/layer.tar", two.clone()),
                Entry::File("manifest.json", serde_json::to_vec(&saved).unwrap()),
            ],
        );
        let image = load(&tar, &scratch.0).unwrap();
        assert!(image.converted);
        assert_eq!(image.media_type, DOCKER_MANIFEST);
        assert_eq!(image.config.digest, format!("sha256:{}", hex_of(&config)));
        assert_consistent(&image, &tar);
        let manifest: Value = serde_json::from_slice(&image.manifest).unwrap();
        assert_eq!(manifest["config"]["mediaType"], DOCKER_CONFIG);
        assert_eq!(manifest["layers"][0]["mediaType"], DOCKER_LAYER_GZIP);
        assert_eq!(image.manifest_digest(), sha256_of(&image.manifest));
    }

    #[test]
    fn the_classic_layout_through_docker_25_symlinks() {
        let scratch = Scratch::new("symlinks");
        let one = layer_tar("hello", b"hi");
        let config = config_for(&[&one]);
        let (config_hex, layer_hex) = (hex_of(&config), hex_of(&one));
        let saved = json!([{ "Config": format!("{config_hex}.json"), "Layers": [format!("{layer_hex}/layer.tar")] }]);
        let tar = scratch.0.join("save.tar");
        write_tar(
            &tar,
            vec![
                Entry::File(&format!("blobs/sha256/{config_hex}"), config.clone()),
                Entry::File(&format!("blobs/sha256/{layer_hex}"), one.clone()),
                Entry::Symlink(
                    &format!("{config_hex}.json"),
                    &format!("blobs/sha256/{config_hex}"),
                ),
                Entry::Symlink(
                    &format!("{layer_hex}/layer.tar"),
                    &format!("../blobs/sha256/{layer_hex}"),
                ),
                Entry::File("manifest.json", serde_json::to_vec(&saved).unwrap()),
            ],
        );
        let image = load(&tar, &scratch.0).unwrap();
        assert_consistent(&image, &tar);
    }

    #[test]
    fn a_layer_that_is_not_its_diff_id_is_refused() {
        let scratch = Scratch::new("mismatch");
        let one = layer_tar("hello", b"hello");
        let config = config_for(&[&layer_tar("other", b"other")]);
        let saved = json!([{ "Config": "c.json", "Layers": ["l/layer.tar"] }]);
        let tar = scratch.0.join("save.tar");
        write_tar(
            &tar,
            vec![
                Entry::File("c.json", config),
                Entry::File("l/layer.tar", one),
                Entry::File("manifest.json", serde_json::to_vec(&saved).unwrap()),
            ],
        );
        let error = load(&tar, &scratch.0).unwrap_err();
        assert!(error.contains("config says"), "{error}");
    }

    /// The OCI layout Docker 25+ writes from its own image store:
    /// uncompressed layers, which the push gzips.
    #[test]
    fn the_oci_layout_with_uncompressed_layers_is_gzipped() {
        let scratch = Scratch::new("oci-plain");
        let one = layer_tar("hello", b"hello world");
        let config = config_for(&[&one]);
        let manifest = serde_json::to_vec(&json!({
            "schemaVersion": 2, "mediaType": OCI_MANIFEST,
            "config": { "mediaType": "application/vnd.oci.image.config.v1+json", "digest": format!("sha256:{}", hex_of(&config)), "size": config.len() },
            "layers": [{ "mediaType": "application/vnd.oci.image.layer.v1.tar", "digest": format!("sha256:{}", hex_of(&one)), "size": one.len() }],
            "annotations": { "org.opencontainers.image.created": "2026-10-06T00:00:00Z" },
        }))
        .unwrap();
        let index = json!({ "schemaVersion": 2, "manifests": [{ "mediaType": OCI_MANIFEST, "digest": format!("sha256:{}", hex_of(&manifest)), "size": manifest.len() }] });
        let tar = scratch.0.join("save.tar");
        write_tar(
            &tar,
            vec![
                Entry::File(&format!("blobs/sha256/{}", hex_of(&config)), config.clone()),
                Entry::File(&format!("blobs/sha256/{}", hex_of(&one)), one.clone()),
                Entry::File(
                    &format!("blobs/sha256/{}", hex_of(&manifest)),
                    manifest.clone(),
                ),
                Entry::File("index.json", serde_json::to_vec(&index).unwrap()),
                Entry::File("oci-layout", br#"{"imageLayoutVersion":"1.0.0"}"#.to_vec()),
                Entry::File("manifest.json", b"[]".to_vec()),
            ],
        );
        let image = load(&tar, &scratch.0).unwrap();
        assert!(image.converted);
        assert_eq!(image.media_type, OCI_MANIFEST);
        assert_consistent(&image, &tar);
        let pushed: Value = serde_json::from_slice(&image.manifest).unwrap();
        assert_eq!(pushed["layers"][0]["mediaType"], OCI_LAYER_GZIP);
        // Everything else in the manifest stays.
        assert_eq!(
            pushed["annotations"]["org.opencontainers.image.created"],
            "2026-10-06T00:00:00Z"
        );
    }

    /// The containerd image store: an index of indexes, gzipped layers, and
    /// only this machine's platform saved. The manifest goes up unchanged.
    #[test]
    fn the_oci_layout_with_compressed_layers_keeps_its_manifest() {
        let scratch = Scratch::new("oci-gzip");
        let plain = layer_tar("hello", b"hello world");
        let one = gzip(&plain);
        let config = config_for(&[&plain]);
        let manifest = serde_json::to_vec(&json!({
            "schemaVersion": 2, "mediaType": OCI_MANIFEST,
            "config": { "mediaType": "application/vnd.oci.image.config.v1+json", "digest": format!("sha256:{}", hex_of(&config)), "size": config.len() },
            "layers": [{ "mediaType": OCI_LAYER_GZIP, "digest": format!("sha256:{}", hex_of(&one)), "size": one.len() }],
        }))
        .unwrap();
        let arch = match std::env::consts::ARCH {
            "x86_64" => "amd64",
            "aarch64" => "arm64",
            other => other,
        };
        let platforms = serde_json::to_vec(&json!({
            "schemaVersion": 2, "mediaType": OCI_INDEX,
            "manifests": [
                { "mediaType": OCI_MANIFEST, "digest": format!("sha256:{}", "1".repeat(64)), "size": 1, "platform": { "os": "linux", "architecture": "s390x" } },
                { "mediaType": OCI_MANIFEST, "digest": format!("sha256:{}", hex_of(&manifest)), "size": manifest.len(), "platform": { "os": "linux", "architecture": arch } },
                { "mediaType": OCI_MANIFEST, "digest": format!("sha256:{}", "2".repeat(64)), "size": 1, "platform": { "os": "unknown", "architecture": "unknown" } },
            ],
        }))
        .unwrap();
        let index = json!({ "schemaVersion": 2, "mediaType": OCI_INDEX, "manifests": [{ "mediaType": OCI_INDEX, "digest": format!("sha256:{}", hex_of(&platforms)), "size": platforms.len() }] });
        let tar = scratch.0.join("save.tar");
        write_tar(
            &tar,
            vec![
                Entry::File(&format!("blobs/sha256/{}", hex_of(&config)), config.clone()),
                Entry::File(&format!("blobs/sha256/{}", hex_of(&one)), one.clone()),
                Entry::File(
                    &format!("blobs/sha256/{}", hex_of(&manifest)),
                    manifest.clone(),
                ),
                Entry::File(
                    &format!("blobs/sha256/{}", hex_of(&platforms)),
                    platforms.clone(),
                ),
                Entry::File("index.json", serde_json::to_vec(&index).unwrap()),
            ],
        );
        let image = load(&tar, &scratch.0).unwrap();
        assert!(!image.converted);
        assert_eq!(image.manifest, manifest);
        assert_eq!(
            image.manifest_digest(),
            format!("sha256:{}", hex_of(&manifest))
        );
        assert_eq!(
            image.layers[0].source,
            Source::Tar {
                offset: image.layers[0].source_offset()
            }
        );
        assert_consistent(&image, &tar);
    }

    impl Blob {
        fn source_offset(&self) -> u64 {
            match self.source {
                Source::Tar { offset } => offset,
                Source::File(_) => panic!("expected a blob in the tar"),
            }
        }
    }

    #[test]
    fn paths_normalize() {
        assert_eq!(normalize("./a/../b//c"), "b/c");
        assert_eq!(normalize("blobs\\sha256\\x"), "blobs/sha256/x");
    }
}
