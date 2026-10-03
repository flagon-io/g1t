//! Artifacts and the cache: `actions/upload-artifact`,
//! `actions/download-artifact` and `actions/cache`, done natively against
//! g1t, which keeps them in R2. Artifacts belong to the run; cache entries
//! to the repository, found by exact key or by the newest under a
//! `restore-keys` prefix.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

use super::process::{self, Commands, Ended};
use super::{Job, Post, PostRun};

/// The largest upload g1t takes, as the platform limits a request.
const MAX_UPLOAD: u64 = 60 * 1024 * 1024;

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

    /// Downloads into `file`; `Ok(None)` when there is nothing there.
    fn download(&mut self, rest: &str, file: &Path) -> Result<Option<String>, String> {
        let response = match ureq::get(&self.url(rest)).set("authorization", &self.auth()).timeout(Duration::from_secs(600)).call() {
            Ok(response) => response,
            Err(ureq::Error::Status(404, _)) => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        let matched = response.header("x-g1t-key").map(str::to_owned).unwrap_or_default();
        let mut bytes = Vec::new();
        response.into_reader().take(MAX_UPLOAD * 2).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        std::fs::write(file, bytes).map_err(|e| e.to_string())?;
        Ok(Some(matched))
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

    fn cache_paths(&self, with: &BTreeMap<String, String>) -> Vec<String> {
        let home = self.base_env_value("HOME").unwrap_or_else(|| "/home/node".into());
        lines(with.get("path").map(String::as_str).unwrap_or_default())
            .into_iter()
            .map(|p| {
                let p = if let Some(rest) = p.strip_prefix("~/") { format!("{home}/{rest}") } else { p };
                if p.starts_with('/') { p } else { self.workspace.join(p).display().to_string() }
            })
            .collect()
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
        let archive = self.temp.join("cache-restore.tgz");
        let mut outputs = BTreeMap::new();
        let exact = match self.download(&query, &archive) {
            Ok(Some(matched)) => {
                let lookup_only = with.get("lookup-only").is_some_and(|v| v == "true");
                if !lookup_only && !self.shell(&format!("tar -xzPf {}", quote(&archive.display().to_string()))) {
                    self.log.line("##[warning]The cache was found but could not be unpacked.");
                }
                self.log.line(&format!("Cache restored from key: {matched}"));
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
        if paths.is_empty() {
            self.log.line("##[warning]Nothing to cache: no `path`.");
            return true;
        }
        let archive = self.temp.join("cache-save.tgz");
        let list: Vec<String> = paths.iter().filter(|p| Path::new(p).exists()).map(|p| quote(p)).collect();
        if list.is_empty() {
            self.log.line("##[warning]None of the cache's paths exist; nothing was saved.");
            return true;
        }
        if !self.shell(&format!("tar -czPf {} {}", quote(&archive.display().to_string()), list.join(" "))) {
            self.log.line("##[warning]The cache could not be packed; nothing was saved.");
            return true;
        }
        match self.upload(&format!("cache?key={}", urlencode(key)), &archive) {
            Ok(size) => self.log.line(&format!("Cache saved with key: {key} ({} KB)", size.div_ceil(1024))),
            // A cache that cannot be saved does not fail the job, as on GitHub.
            Err(error) => self.log.line(&format!("##[warning]The cache could not be saved: {error}")),
        }
        true
    }

    /// `actions/cache/save`.
    pub(crate) fn cache_save_now(&mut self, with: &BTreeMap<String, String>) -> (bool, BTreeMap<String, String>) {
        let key = with.get("key").cloned().unwrap_or_default();
        let paths = self.cache_paths(with);
        (self.cache_save(&key, &paths), BTreeMap::new())
    }
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
    fn keys_are_encoded_and_names_checked() {
        assert_eq!(urlencode("Linux-node-abc/1 2"), "Linux-node-abc%2F1%202");
        assert!(safe_name("coverage report"));
        assert!(!safe_name("../etc"));
        assert_eq!(lines("dist/\n\n# note\n  coverage  \n"), ["dist/", "coverage"]);
    }
}
