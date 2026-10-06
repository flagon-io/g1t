//! Artifacts and the cache: `actions/upload-artifact`,
//! `actions/download-artifact` and `actions/cache`, done natively against
//! g1t. Artifacts belong to the run; cache entries to the repository, found
//! by exact key or by the newest under a `restore-keys` prefix.
//!
//! A cache entry is a tar archive, compressed with zstd where the machine
//! has it (gzip otherwise), of up to 2 GB: uploaded in parts, and
//! downloaded straight to a file. Its `path` takes globs (`**` included)
//! and `!` patterns that leave paths out, as `actions/cache` does.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

use super::process::{self, Commands, Ended};
use super::{Job, Post, PostRun};

/// The largest artifact g1t takes at once, as the platform limits a request.
const MAX_UPLOAD: u64 = 60 * 1024 * 1024;
/// The largest cache entry, compressed (`g1t_contracts::actions::CACHE_MAX_ENTRY_BYTES`).
const MAX_CACHE_ENTRY: u64 = 2 * 1024 * 1024 * 1024;

fn lines(text: &str) -> Vec<String> {
    text.lines().map(str::trim).filter(|line| !line.is_empty() && !line.starts_with('#')).map(str::to_owned).collect()
}

fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

fn safe_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 200 && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ' ')) && !name.starts_with('.')
}

impl Job {
    fn url(&self, rest: &str) -> String {
        format!("{}/actions/jobs/{}/{rest}", self.log.api.base, self.log.api.job)
    }

    fn auth(&self) -> String {
        format!("Bearer {}", self.log.api.token)
    }

    /// Runs a shell line, logging its output; whether it succeeded.
    fn shell(&mut self, script: &str) -> bool {
        let mut command = Command::new("bash");
        command.args(["-c", script]).current_dir(&self.workspace);
        let mut commands = Commands::default();
        matches!(process::run(command, Duration::from_secs(1800), &mut self.log, &mut commands), Ok(Ended::Exited(0)))
    }

    fn upload(&mut self, rest: &str, file: &Path) -> Result<u64, String> {
        let size = std::fs::metadata(file).map_err(|e| e.to_string())?.len();
        if size > MAX_UPLOAD {
            return Err(format!("it is {} MB, more than g1t takes at once ({} MB)", size / 1_048_576, MAX_UPLOAD / 1_048_576));
        }
        let bytes = std::fs::read(file).map_err(|e| e.to_string())?;
        ureq::put(&self.url(rest))
            .set("authorization", &self.auth())
            .set("content-type", "application/gzip")
            .timeout(Duration::from_secs(600))
            .send_bytes(&bytes)
            .map_err(|e| e.to_string())?;
        Ok(size)
    }

    /// Downloads into `file`, as it comes; `Ok(None)` when there is
    /// nothing there.
    fn download(&mut self, rest: &str, file: &Path) -> Result<Option<String>, String> {
        let response = match ureq::get(&self.url(rest)).set("authorization", &self.auth()).timeout(Duration::from_secs(1800)).call() {
            Ok(response) => response,
            Err(ureq::Error::Status(404, _)) => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        let matched = response.header("x-g1t-key").map(str::to_owned).unwrap_or_default();
        let mut out = std::fs::File::create(file).map_err(|e| e.to_string())?;
        std::io::copy(&mut response.into_reader().take(MAX_CACHE_ENTRY + 1024), &mut out).map_err(|e| e.to_string())?;
        Ok(Some(matched))
    }

    /// Saves `file` as the cache entry `key`, in parts. `Ok(false)` when
    /// the key is already cached.
    fn upload_cache(&mut self, key: &str, file: &Path) -> Result<bool, String> {
        let size = std::fs::metadata(file).map_err(|e| e.to_string())?.len();
        if size > MAX_CACHE_ENTRY {
            return Err(format!("it is {} MB, more than a cache entry may be ({} MB)", size / 1_048_576, MAX_CACHE_ENTRY / 1_048_576));
        }
        let started = match ureq::post(&self.url(&format!("cache/uploads?key={}&size={size}", urlencode(key))))
            .set("authorization", &self.auth())
            .timeout(Duration::from_secs(60))
            .call()
        {
            Ok(response) => response.into_json::<serde_json::Value>().map_err(|e| e.to_string())?,
            Err(ureq::Error::Status(409, _)) => return Ok(false),
            Err(ureq::Error::Status(_, response)) => return Err(refusal(response)),
            Err(error) => return Err(error.to_string()),
        };
        let id = started["id"].as_str().unwrap_or_default().to_owned();
        let upload = started["upload"].as_str().unwrap_or_default().to_owned();
        let part_bytes = started["part_bytes"].as_u64().filter(|n| *n > 0).unwrap_or(32 * 1024 * 1024);
        let base = format!("cache/uploads/{}", urlencode(&id));
        let sent = self.send_parts(&base, &upload, file, part_bytes);
        let parts = match sent {
            Ok(parts) => parts,
            Err(error) => {
                let _ = ureq::delete(&self.url(&format!("{base}?upload={}", urlencode(&upload)))).set("authorization", &self.auth()).call();
                return Err(error);
            }
        };
        ureq::post(&self.url(&format!("{base}/complete?upload={}", urlencode(&upload))))
            .set("authorization", &self.auth())
            .timeout(Duration::from_secs(120))
            .send_json(serde_json::json!({ "size": size, "parts": parts }))
            .map_err(|e| match e {
                ureq::Error::Status(_, response) => refusal(response),
                other => other.to_string(),
            })?;
        Ok(true)
    }

    /// Sends `file` in parts of `part_bytes`; each part's number and etag.
    fn send_parts(&mut self, base: &str, upload: &str, file: &Path, part_bytes: u64) -> Result<Vec<serde_json::Value>, String> {
        let mut reader = std::fs::File::open(file).map_err(|e| e.to_string())?;
        let mut parts = Vec::new();
        let mut buffer = vec![0u8; part_bytes as usize];
        for number in 1u32.. {
            let mut filled = 0;
            while filled < buffer.len() {
                let read = reader.read(&mut buffer[filled..]).map_err(|e| e.to_string())?;
                if read == 0 {
                    break;
                }
                filled += read;
            }
            if filled == 0 && number > 1 {
                break;
            }
            let url = self.url(&format!("{base}/{number}?upload={}", urlencode(upload)));
            // A part that fails is sent again, twice at most.
            let mut tries = 0;
            let answer = loop {
                tries += 1;
                match ureq::put(&url).set("authorization", &self.auth()).timeout(Duration::from_secs(600)).send_bytes(&buffer[..filled]) {
                    Ok(response) => break response.into_json::<serde_json::Value>().map_err(|e| e.to_string())?,
                    Err(ureq::Error::Status(status, response)) if status < 500 => return Err(refusal(response)),
                    Err(error) if tries >= 3 => return Err(error.to_string()),
                    Err(_) => std::thread::sleep(Duration::from_secs(2 * tries)),
                }
            };
            parts.push(serde_json::json!({ "part": number, "etag": answer["etag"] }));
            if filled < buffer.len() {
                break;
            }
        }
        Ok(parts)
    }

    /// `actions/upload-artifact`.
    pub(crate) fn upload_artifact(&mut self, with: &BTreeMap<String, String>) -> (bool, BTreeMap<String, String>) {
        let name = with.get("name").filter(|n| !n.is_empty()).cloned().unwrap_or_else(|| "artifact".into());
        if !safe_name(&name) {
            self.log.line(&format!("##[error]`{name}` is not an artifact name g1t takes: letters, digits, spaces, `-`, `_` and `.`."));
            return (false, BTreeMap::new());
        }
        let paths = lines(with.get("path").map(String::as_str).unwrap_or_default());
        let missing = with.get("if-no-files-found").map(String::as_str).unwrap_or("warn").to_owned();
        let archive = self.temp.join(format!("artifact-{name}.tgz"));
        // As on GitHub: one folder uploads its contents; otherwise paths
        // are kept relative to the workspace.
        let single_dir = paths.len() == 1 && self.workspace.join(&paths[0]).is_dir();
        let script = if single_dir {
            format!("tar -czf {} -C {} .", quote(&archive.display().to_string()), quote(&paths[0]))
        } else {
            let patterns: Vec<String> = paths.iter().filter(|p| !p.starts_with('!')).map(|p| p.replace('\'', "")).collect();
            format!(
                "shopt -s globstar nullglob dotglob; files=( {} ); if [ ${{#files[@]}} -eq 0 ]; then exit 3; fi; tar -czf {} -- \"${{files[@]}}\"",
                patterns.join(" "),
                quote(&archive.display().to_string())
            )
        };
        let mut command = Command::new("bash");
        command.args(["-c", &script]).current_dir(&self.workspace);
        let mut commands = Commands::default();
        match process::run(command, Duration::from_secs(1800), &mut self.log, &mut commands) {
            Ok(Ended::Exited(0)) => {}
            Ok(Ended::Exited(3)) => {
                let message = format!("No files were found at {}.", paths.join(", "));
                return match missing.as_str() {
                    "error" => {
                        self.log.line(&format!("##[error]{message}"));
                        (false, BTreeMap::new())
                    }
                    "ignore" => (true, BTreeMap::new()),
                    _ => {
                        self.log.line(&format!("##[warning]{message} Nothing was uploaded."));
                        (true, BTreeMap::new())
                    }
                };
            }
            _ => {
                self.log.line("##[error]The files could not be packed.");
                return (false, BTreeMap::new());
            }
        }
        match self.upload(&format!("artifacts/{name}"), &archive) {
            Ok(size) => {
                self.log.line(&format!("Uploaded artifact {name} ({} KB). It is kept with the run for 14 days.", size.div_ceil(1024)));
                let mut outputs = BTreeMap::new();
                outputs.insert("artifact-id".into(), name.clone());
                (true, outputs)
            }
            Err(error) => {
                self.log.line(&format!("##[error]The artifact could not be uploaded: {error}"));
                (false, BTreeMap::new())
            }
        }
    }

    /// `actions/download-artifact`: one by name, or every artifact of the
    /// run, each into a folder of its name.
    pub(crate) fn download_artifact(&mut self, with: &BTreeMap<String, String>) -> (bool, BTreeMap<String, String>) {
        let dest = with.get("path").filter(|p| !p.is_empty()).map_or(self.workspace.clone(), |p| self.workspace.join(p));
        let names: Vec<String> = match with.get("name").filter(|n| !n.is_empty()) {
            Some(name) => vec![name.clone()],
            None => {
                let listed = ureq::get(&self.url("artifacts")).set("authorization", &self.auth()).call().ok().and_then(|r| r.into_json::<Vec<serde_json::Value>>().ok()).unwrap_or_default();
                listed.iter().filter_map(|a| a["name"].as_str().map(str::to_owned)).collect()
            }
        };
        let merge = with.get("merge-multiple").is_some_and(|m| m == "true");
        let single = with.get("name").is_some_and(|n| !n.is_empty());
        for name in &names {
            let archive = self.temp.join(format!("download-{name}.tgz"));
            match self.download(&format!("artifacts/{name}"), &archive) {
                Ok(Some(_)) => {}
                Ok(None) => {
                    self.log.line(&format!("##[error]This run has no artifact called {name}."));
                    return (false, BTreeMap::new());
                }
                Err(error) => {
                    self.log.line(&format!("##[error]The artifact {name} could not be downloaded: {error}"));
                    return (false, BTreeMap::new());
                }
            }
            let target = if single || merge { dest.clone() } else { dest.join(name) };
            let _ = std::fs::create_dir_all(&target);
            if !self.shell(&format!("tar -xzf {} -C {}", quote(&archive.display().to_string()), quote(&target.display().to_string()))) {
                return (false, BTreeMap::new());
            }
            self.log.line(&format!("Downloaded artifact {name} into {}", target.display()));
        }
        let mut outputs = BTreeMap::new();
        outputs.insert("download-path".into(), dest.display().to_string());
        (true, outputs)
    }

    /// The cache's `path`, each made absolute (`~/` is the home folder,
    /// anything else is under the workspace), `!` patterns kept as they
    /// came, with their `!`.
    fn cache_paths(&self, with: &BTreeMap<String, String>) -> Vec<String> {
        let home = self.base_env_value("HOME").unwrap_or_else(|| "/home/node".into());
        let workspace = self.workspace.display().to_string();
        cache_patterns(with.get("path").map(String::as_str).unwrap_or_default(), &home, &workspace)
    }

    /// `actions/cache` and `actions/cache/restore`: restores what it can,
    /// and for `actions/cache`, saves at the end of the job on a miss.
    pub(crate) fn cache(&mut self, with: &BTreeMap<String, String>, save_after: bool, title: &str) -> (bool, BTreeMap<String, String>) {
        let key = with.get("key").cloned().unwrap_or_default();
        if key.is_empty() {
            self.log.line("##[error]The cache needs a `key`.");
            return (false, BTreeMap::new());
        }
        let paths = self.cache_paths(with);
        let restore = lines(with.get("restore-keys").map(String::as_str).unwrap_or_default());
        let query = format!(
            "cache?key={}&restore={}",
            urlencode(&key),
            urlencode(&restore.join("\n"))
        );
        let archive = self.temp.join("cache-restore.tar");
        let started = Instant::now();
        let mut outputs = BTreeMap::new();
        let exact = match self.download(&query, &archive) {
            Ok(Some(matched)) => {
                let lookup_only = with.get("lookup-only").is_some_and(|v| v == "true");
                let size = std::fs::metadata(&archive).map(|m| m.len()).unwrap_or(0);
                // tar finds out from the archive whether it is zstd or gzip.
                if !lookup_only && !self.shell(&format!("tar -xPf {}", quote(&archive.display().to_string()))) {
                    self.log.line("##[warning]The cache was found but could not be unpacked.");
                }
                let _ = std::fs::remove_file(&archive);
                self.log.line(&format!("Cache restored from key: {matched} ({} in {:.1}s)", megabytes(size), started.elapsed().as_secs_f64()));
                outputs.insert("cache-matched-key".into(), matched.clone());
                matched == key
            }
            Ok(None) => {
                self.log.line(&format!("Cache not found for input keys: {}", std::iter::once(key.clone()).chain(restore).collect::<Vec<_>>().join(", ")));
                if with.get("fail-on-cache-miss").is_some_and(|v| v == "true") {
                    self.log.line("##[error]The cache missed, and `fail-on-cache-miss` is set.");
                    return (false, outputs);
                }
                false
            }
            Err(error) => {
                self.log.line(&format!("##[warning]The cache could not be read: {error}"));
                false
            }
        };
        outputs.insert("cache-hit".into(), exact.to_string());
        outputs.insert("cache-primary-key".into(), key.clone());
        if save_after && !exact {
            self.posts.push(Post {
                name: format!("Post {title}"),
                condition: "success()".into(),
                env: BTreeMap::new(),
                run: PostRun::CacheSave { key, paths },
            });
        }
        (true, outputs)
    }

    /// Saves paths under a key, unless the key is taken.
    pub(crate) fn cache_save(&mut self, key: &str, paths: &[String]) -> bool {
        if paths.iter().all(|p| p.starts_with('!')) {
            self.log.line("##[warning]Nothing to cache: no `path`.");
            return true;
        }
        let archive = self.temp.join("cache-save.tar");
        let started = Instant::now();
        match self.run_shell(&pack_script(paths, &archive.display().to_string())) {
            Some(0) => {}
            Some(3) => {
                self.log.line("##[warning]None of the cache's paths exist; nothing was saved.");
                return true;
            }
            _ => {
                self.log.line("##[warning]The cache could not be packed; nothing was saved.");
                return true;
            }
        }
        let size = std::fs::metadata(&archive).map(|m| m.len()).unwrap_or(0);
        let packed = started.elapsed().as_secs_f64();
        match self.upload_cache(key, &archive) {
            Ok(true) => self.log.line(&format!(
                "Cache saved with key: {key} ({}, packed in {packed:.1}s, sent in {:.1}s)",
                megabytes(size),
                started.elapsed().as_secs_f64() - packed
            )),
            Ok(false) => self.log.line(&format!("Cache not saved: {key} is already cached.")),
            // A cache that cannot be saved does not fail the job, as on GitHub.
            Err(error) => self.log.line(&format!("##[warning]The cache could not be saved: {error}")),
        }
        let _ = std::fs::remove_file(&archive);
        true
    }

    /// Runs a shell line, logging its output; its exit code.
    fn run_shell(&mut self, script: &str) -> Option<i32> {
        let mut command = Command::new("bash");
        command.args(["-c", script]).current_dir(&self.workspace);
        let mut commands = Commands::default();
        match process::run(command, Duration::from_secs(1800), &mut self.log, &mut commands) {
            Ok(Ended::Exited(code)) => Some(code),
            _ => None,
        }
    }

    /// `actions/cache/save`.
    pub(crate) fn cache_save_now(&mut self, with: &BTreeMap<String, String>) -> (bool, BTreeMap<String, String>) {
        let key = with.get("key").cloned().unwrap_or_default();
        let paths = self.cache_paths(with);
        (self.cache_save(&key, &paths), BTreeMap::new())
    }
}

/// The message of a refused request, from its JSON body.
fn refusal(response: ureq::Response) -> String {
    let status = response.status();
    let body: serde_json::Value = response.into_json().unwrap_or_default();
    body["error"]["message"].as_str().map_or_else(|| format!("g1t answered {status}"), str::to_owned)
}

fn megabytes(bytes: u64) -> String {
    if bytes < 1_048_576 { format!("{} KB", bytes.div_ceil(1024)) } else { format!("{:.1} MB", bytes as f64 / 1_048_576.0) }
}

/// The lines of a cache's `path`, absolute: `~/` is `home`, a relative
/// path is under `workspace`. A `!` pattern keeps its `!`.
fn cache_patterns(path: &str, home: &str, workspace: &str) -> Vec<String> {
    lines(path)
        .into_iter()
        .map(|line| {
            let (bang, p) = match line.strip_prefix('!') {
                Some(rest) => ("!", rest.trim().to_owned()),
                None => ("", line),
            };
            let p = if p == "~" {
                home.to_owned()
            } else if let Some(rest) = p.strip_prefix("~/") {
                format!("{home}/{rest}")
            } else {
                p
            };
            let p = if p.starts_with('/') { p } else { format!("{}/{}", workspace.trim_end_matches('/'), p.trim_start_matches("./")) };
            format!("{bang}{}", p.trim_end_matches('/'))
        })
        .collect()
}

/// A path pattern as a word bash expands as a glob: everything but `*`,
/// `?` and `[...]` escaped, so spaces and quotes stay literal.
fn glob_word(pattern: &str) -> String {
    let mut out = String::new();
    for c in pattern.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '*' | '?' | '[' | ']' | '/' | '.' | '-' | '_' | '~' | '+' | ',' | '=' | '@' | ':') {
            out.push(c);
        } else {
            out.push('\\');
            out.push(c);
        }
    }
    out
}

/// The script that packs a cache: its patterns expanded (`**` reaching
/// any depth), `!` patterns left out, into a tar archive compressed with
/// zstd where there is one, else gzip. Exits 3 when nothing matched.
fn pack_script(patterns: &[String], archive: &str) -> String {
    let includes: Vec<String> = patterns.iter().filter(|p| !p.starts_with('!')).map(|p| glob_word(p)).collect();
    let excludes: Vec<String> = patterns
        .iter()
        .filter_map(|p| p.strip_prefix('!'))
        // tar's patterns: `*` already crosses `/`, so `**` is the same.
        .map(|p| format!("--exclude={}", quote(&p.replace("**", "*"))))
        .collect();
    format!(
        "set -o pipefail; shopt -s globstar nullglob dotglob; found=( {} ); files=(); \
         for f in \"${{found[@]}}\"; do if [ -e \"$f\" ]; then files+=(\"$f\"); fi; done; \
         if [ ${{#files[@]}} -eq 0 ]; then exit 3; fi; \
         if command -v zstd >/dev/null; then compress='zstd -T0 -3'; else compress=gzip; fi; \
         tar -cPf {} -I \"$compress\" {} -- \"${{files[@]}}\"",
        includes.join(" "),
        quote(archive),
        excludes.join(" ")
    )
}

fn urlencode(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_paths_take_home_globs_and_exclusions() {
        let paths = cache_patterns("~/.cargo/registry/cache\ntarget/*/release/\n!target/**/incremental\n./dist\n/abs/x\n~", "/home/node", "/w/repo/");
        assert_eq!(
            paths,
            ["/home/node/.cargo/registry/cache", "/w/repo/target/*/release", "!/w/repo/target/**/incremental", "/w/repo/dist", "/abs/x", "/home/node"]
        );
        assert_eq!(glob_word("/w/my repo/target/**/*.rlib"), "/w/my\\ repo/target/**/*.rlib");
        assert_eq!(glob_word("/w/a'b"), "/w/a\\'b");
    }

    #[test]
    fn packing_expands_globs_and_leaves_exclusions_out() {
        let script = pack_script(&["/w/target/*/release".into(), "!/w/target/**/incremental".into()], "/t/c.tar");
        assert!(script.contains("found=( /w/target/*/release )"), "{script}");
        assert!(script.contains("--exclude='/w/target/*/incremental'"), "{script}");
        assert!(script.contains("zstd -T0"), "{script}");
        assert!(script.contains("exit 3"), "{script}");
    }

    /// Packs and unpacks for real, where bash and tar are (not on Windows).
    #[test]
    #[cfg(unix)]
    fn a_packed_cache_unpacks_without_what_was_left_out() {
        let dir = std::env::temp_dir().join(format!("g1t-cache-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for file in ["target/release/deps/a.rlib", "target/release/incremental/x.bin", "target/wasm/release/deps/b.rlib", "src/main.rs"] {
            let path = dir.join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, file).unwrap();
        }
        let root = dir.display().to_string();
        let patterns = cache_patterns("target/**/deps\ntarget/release/incremental\n!target/**/incremental", "/home/node", &root);
        let archive = dir.join("c.tar").display().to_string();
        let status = Command::new("bash").args(["-c", &pack_script(&patterns, &archive)]).status().unwrap();
        assert!(status.success());
        let listed = Command::new("tar").args(["-tPf", &archive]).output().unwrap();
        let listed = String::from_utf8_lossy(&listed.stdout);
        assert!(listed.contains("deps/a.rlib") && listed.contains("deps/b.rlib"), "{listed}");
        assert!(!listed.contains("incremental") && !listed.contains("main.rs"), "{listed}");
        let none = Command::new("bash").args(["-c", &pack_script(&[format!("{root}/nothing/*")], &archive)]).status().unwrap();
        assert_eq!(none.code(), Some(3));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn keys_are_encoded_and_names_checked() {
        assert_eq!(urlencode("Linux-node-abc/1 2"), "Linux-node-abc%2F1%202");
        assert!(safe_name("coverage report"));
        assert!(!safe_name("../etc"));
        assert_eq!(lines("dist/\n\n# note\n  coverage  \n"), ["dist/", "coverage"]);
    }
}
