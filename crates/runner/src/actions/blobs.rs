//! Artifacts and the cache: `actions/upload-artifact`, its `merge`,
//! `actions/download-artifact` and `actions/cache`, done natively against
//! g1t. Artifacts belong to the run; cache entries to the repository, found
//! by exact key or by the newest under a `restore-keys` prefix.
//!
//! An artifact is a ZIP file, as GitHub's v4 actions make it (zip.rs), of
//! the files its `path` finds (glob.rs): uploaded in parts with its SHA-256,
//! and downloaded straight to a file before it is unpacked.
//!
//! A cache entry is a tar archive, compressed with zstd where the machine
//! has it (gzip otherwise), of up to 2 GB: uploaded in parts, and
//! downloaded straight to a file. Its `path` takes globs (`**` included)
//! and `!` patterns that leave paths out, as `actions/cache` does. Each is
//! saved and found under a version, the hash of its `path` and compression,
//! and g1t keeps it under the ref whose run saved it.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use super::process::{self, Commands, Ended};
use super::{Job, Post, PostRun, glob, zip};

/// The largest cache entry, compressed (`g1t_contracts::actions::CACHE_MAX_ENTRY_BYTES`).
const MAX_CACHE_ENTRY: u64 = 2 * 1024 * 1024 * 1024;

fn lines(text: &str) -> Vec<String> {
    text.lines().map(str::trim).filter(|line| !line.is_empty() && !line.starts_with('#')).map(str::to_owned).collect()
}

fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
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
    fn upload_cache(&mut self, key: &str, version: &str, file: &Path) -> Result<bool, String> {
        let size = std::fs::metadata(file).map_err(|e| e.to_string())?.len();
        if size > MAX_CACHE_ENTRY {
            return Err(format!("it is {} MB, more than a cache entry may be ({} MB)", size / 1_048_576, MAX_CACHE_ENTRY / 1_048_576));
        }
        let started = match ureq::post(&self.url(&format!("cache/uploads?key={}&size={size}&version={}", urlencode(key), urlencode(version))))
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

    /// A value of the `github` context, as text.
    fn github_value(&self, key: &str) -> String {
        match self.contexts.get("github").and_then(|github| github.get(key)) {
            Some(serde_json::Value::String(text)) => text.clone(),
            Some(serde_json::Value::Null) | None => String::new(),
            Some(other) => other.to_string(),
        }
    }

    fn home(&self) -> String {
        self.base_env_value("HOME").unwrap_or_else(|| "/home/node".into())
    }

    /// `actions/upload-artifact`: the files `path` names, packed into one
    /// ZIP and uploaded in parts.
    pub(crate) fn upload_artifact(&mut self, with: &BTreeMap<String, String>) -> (bool, BTreeMap<String, String>) {
        let name = input(with, "name").unwrap_or("artifact").to_owned();
        let missing = input(with, "if-no-files-found").unwrap_or("warn").to_ascii_lowercase();
        let checked = check_name(&name)
            .and_then(|()| keep(with, true))
            .and_then(|keep| if matches!(missing.as_str(), "warn" | "error" | "ignore") { Ok(keep) } else { Err(format!("`if-no-files-found` is `{missing}`; it takes warn, error or ignore.")) });
        let keep = match checked {
            Ok(keep) => keep,
            Err(message) => {
                self.log.line(&format!("##[error]{message}"));
                return (false, BTreeMap::new());
            }
        };
        let paths = lines(input(with, "path").unwrap_or_default());
        let found = glob::find(&paths, &self.workspace.display().to_string(), &self.home(), keep.hidden);
        if found.files.is_empty() {
            let message = format!("No files were found with the provided path: {}. No artifacts will be uploaded.", paths.join(", "));
            return match missing.as_str() {
                "error" => {
                    self.log.line(&format!("##[error]{message}"));
                    (false, BTreeMap::new())
                }
                "ignore" => {
                    self.log.line(&message);
                    (true, BTreeMap::new())
                }
                _ => {
                    self.log.line(&format!("##[warning]{message}"));
                    (true, BTreeMap::new())
                }
            };
        }
        self.log.line(&format!("Found {} with the provided path, stored relative to {}.", count(found.files.len(), "file"), found.root));
        self.send_artifact(&name, &found.files, &keep)
    }

    /// Packs `files` into a ZIP and uploads it as the artifact `name`;
    /// whether it worked, and the outputs `upload-artifact` sets.
    fn send_artifact(&mut self, name: &str, files: &[(String, std::path::PathBuf)], keep: &Keep) -> (bool, BTreeMap<String, String>) {
        let archive = self.temp.join(format!("artifact-{}.zip", super::rand_id()));
        let sent = zip::write(&archive, files, keep.level)
            .map_err(|e| format!("The files could not be packed: {e}"))
            .and_then(|packed| self.post_artifact(name, &archive, keep).map(|done| (packed, done)));
        let _ = std::fs::remove_file(&archive);
        let (packed, done) = match sent {
            Ok(sent) => sent,
            Err(error) => {
                self.log.line(&format!("##[error]{error}"));
                return (false, BTreeMap::new());
            }
        };
        let kept = done.retention.map(|days| format!(" It is kept for {}.", count(days as usize, "day"))).unwrap_or_default();
        self.log.line(&format!("Uploaded artifact {name} ({}, {}).{kept}", megabytes(packed.size), count(packed.files, "file")));
        let url = format!(
            "{}/{}/actions/runs/{}/artifacts/{}",
            self.github_value("server_url").trim_end_matches('/'),
            self.github_value("repository"),
            self.github_value("run_id"),
            done.id
        );
        self.log.line(&format!("Artifact download URL: {url}"));
        let mut outputs = BTreeMap::new();
        outputs.insert("artifact-id".into(), done.id.to_string());
        outputs.insert("artifact-url".into(), url);
        outputs.insert("artifact-digest".into(), done.digest);
        (true, outputs)
    }

    /// Uploads the ZIP file `archive` as the artifact `name`, in parts,
    /// giving the upload up when a part or the end fails.
    fn post_artifact(&mut self, name: &str, archive: &Path, keep: &Keep) -> Result<Sent, String> {
        let size = std::fs::metadata(archive).map_err(|e| e.to_string())?.len();
        let digest = sha256_file(archive).map_err(|e| e.to_string())?;
        let query = format!(
            "artifacts/uploads?name={}&size={size}&retention_days={}&overwrite={}&format=zip",
            urlencode(name),
            keep.retention,
            keep.overwrite
        );
        let failed = |e: ureq::Error| match e {
            ureq::Error::Status(_, response) => format!("The artifact could not be uploaded: {}", refusal(response)),
            other => format!("The artifact could not be uploaded: {other}"),
        };
        let started = ureq::post(&self.url(&query))
            .set("authorization", &self.auth())
            .timeout(Duration::from_secs(60))
            .call()
            .map_err(failed)?
            .into_json::<serde_json::Value>()
            .map_err(|e| e.to_string())?;
        let id = number(&started["id"]).ok_or("g1t did not say which artifact the upload is")?;
        let upload = started["upload"].as_str().unwrap_or_default().to_owned();
        let part_bytes = started["part_bytes"].as_u64().filter(|n| *n > 0).unwrap_or(32 * 1024 * 1024);
        let retention = started["retention_days"].as_u64();
        if let Some(applied) = retention
            && keep.retention != 0
            && applied != u64::from(keep.retention)
        {
            self.log.line(&format!(
                "##[notice]The artifact is kept for {}, not the {} asked for: the most this repository keeps artifacts.",
                count(applied as usize, "day"),
                keep.retention
            ));
        }
        let base = format!("artifacts/uploads/{id}");
        let give_up = |job: &Job| {
            let _ = ureq::delete(&job.url(&format!("{base}?upload={}", urlencode(&upload)))).set("authorization", &job.auth()).call();
        };
        let parts = match self.send_parts(&base, &upload, archive, part_bytes) {
            Ok(parts) => parts,
            Err(error) => {
                give_up(self);
                return Err(format!("The artifact could not be uploaded: {error}"));
            }
        };
        let done = ureq::post(&self.url(&format!("{base}/complete?upload={}", urlencode(&upload))))
            .set("authorization", &self.auth())
            .timeout(Duration::from_secs(120))
            .send_json(serde_json::json!({ "size": size, "parts": parts, "digest": format!("sha256:{digest}") }));
        let done = match done {
            Ok(response) => response.into_json::<serde_json::Value>().unwrap_or_default(),
            Err(error) => {
                give_up(self);
                return Err(failed(error));
            }
        };
        Ok(Sent { id: number(&done["id"]).unwrap_or(id), digest, retention: retention.map(|d| d as u32).or((keep.retention != 0).then_some(keep.retention)) })
    }

    /// The artifacts of this run, or of the run `run_id` of this
    /// repository; one per name, the newest.
    fn list_artifacts(&mut self, run_id: Option<&str>) -> Result<Vec<Listed>, String> {
        let rest = match run_id {
            Some(run) => format!("artifacts?run_id={}", urlencode(run)),
            None => "artifacts".to_owned(),
        };
        let listed = ureq::get(&self.url(&rest))
            .set("authorization", &self.auth())
            .timeout(Duration::from_secs(60))
            .call()
            .map_err(|e| match e {
                ureq::Error::Status(_, response) => refusal(response),
                other => other.to_string(),
            })?
            .into_json::<Vec<serde_json::Value>>()
            .map_err(|e| e.to_string())?;
        Ok(newest(listed.iter().filter_map(Listed::from_json).collect()))
    }

    /// Downloads an artifact to a file, as it comes, and unpacks it into
    /// `into`.
    fn fetch_artifact(&mut self, artifact: &Listed, into: &Path) -> Result<(), String> {
        let file = self.temp.join(format!("download-{}.zip", super::rand_id()));
        let fetched = self.fetch_to(artifact, &file).and_then(|format| {
            if format == "tgz" {
                std::fs::create_dir_all(into).map_err(|e| e.to_string())?;
                let script = format!("tar -xzf {} -C {}", quote(&file.display().to_string()), quote(&into.display().to_string()));
                if self.shell(&script) { Ok(()) } else { Err("it could not be unpacked".into()) }
            } else {
                zip::extract(&file, into).map(|_| ()).map_err(|e| format!("it could not be unpacked: {e}"))
            }
        });
        let _ = std::fs::remove_file(&file);
        fetched
    }

    /// Downloads an artifact into `file`, checking its digest; how it is
    /// packed, `zip` or `tgz`.
    fn fetch_to(&mut self, artifact: &Listed, file: &Path) -> Result<String, String> {
        let response = match ureq::get(&self.url(&format!("artifacts/{}/download", artifact.id)))
            .set("authorization", &self.auth())
            .timeout(Duration::from_secs(4 * 3600))
            .call()
        {
            Ok(response) => response,
            Err(ureq::Error::Status(404, _)) => return Err("it is gone: it expired or was deleted".into()),
            Err(ureq::Error::Status(_, response)) => return Err(refusal(response)),
            Err(error) => return Err(error.to_string()),
        };
        let format = response.header("x-g1t-format").map(str::to_owned).unwrap_or_else(|| artifact.format.clone());
        let mut reader = response.into_reader();
        let mut out = std::io::BufWriter::new(std::fs::File::create(file).map_err(|e| e.to_string())?);
        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; 256 * 1024];
        loop {
            let n = reader.read(&mut buffer).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            hasher.update(&buffer[..n]);
            out.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
        }
        out.flush().map_err(|e| e.to_string())?;
        let got = hex::encode(hasher.finalize());
        if let Some(expected) = artifact.digest.as_deref().map(|d| d.trim_start_matches("sha256:"))
            && !expected.is_empty()
            && !expected.eq_ignore_ascii_case(&got)
        {
            self.log.line(&format!("##[warning]Artifact {} does not match its digest (sha256:{got}, not sha256:{expected}): it may have been changed since it was uploaded.", artifact.name));
        }
        Ok(format)
    }

    /// Where artifacts are downloaded: `path`, under the workspace unless
    /// absolute, `~` the home folder.
    fn download_dir(&self, path: Option<&str>) -> std::path::PathBuf {
        match path {
            None => self.workspace.clone(),
            Some(path) => {
                let home = self.home();
                let path = if path == "~" {
                    home
                } else if let Some(rest) = path.strip_prefix("~/") {
                    format!("{}/{rest}", home.trim_end_matches('/'))
                } else {
                    path.to_owned()
                };
                self.workspace.join(path)
            }
        }
    }

    /// `actions/download-artifact`: one artifact by name straight into
    /// `path`, or the run's artifacts (by `pattern` or `artifact-ids`) each
    /// into a folder of its name, or all into `path` with `merge-multiple`.
    pub(crate) fn download_artifact(&mut self, with: &BTreeMap<String, String>) -> (bool, BTreeMap<String, String>) {
        let fail = |job: &mut Job, message: &str| {
            job.log.line(&format!("##[error]{message}"));
            (false, BTreeMap::new())
        };
        let name = input(with, "name");
        let ids = match artifact_ids(input(with, "artifact-ids").unwrap_or_default()) {
            Ok(ids) => ids,
            Err(message) => return fail(self, &message),
        };
        if name.is_some() && !ids.is_empty() {
            return fail(self, "Inputs 'name' and 'artifact-ids' cannot be used together. Please specify only one.");
        }
        let merge = match flag(with, "merge-multiple", false) {
            Ok(merge) => merge,
            Err(message) => return fail(self, &message),
        };
        let dest = self.download_dir(input(with, "path"));
        // Another run's artifacts, as v4 has it: with a token and a run id.
        let run_id = match (input(with, "github-token"), input(with, "run-id")) {
            (Some(_), Some(run)) => {
                let own = self.github_value("repository");
                let repository = input(with, "repository").unwrap_or(&own);
                if !repository.eq_ignore_ascii_case(&own) {
                    return fail(self, &format!("g1t downloads artifacts from other runs of the same repository only; {repository} is not this run's repository, {own}."));
                }
                Some(run.to_owned())
            }
            _ => None,
        };
        let listed = match self.list_artifacts(run_id.as_deref()) {
            Ok(listed) => listed,
            Err(error) => return fail(self, &format!("The artifacts could not be listed: {error}")),
        };
        let chosen: Vec<Listed> = if let Some(name) = name {
            match listed.into_iter().find(|a| a.name == name) {
                Some(artifact) => vec![artifact],
                None => return fail(self, &format!("Unable to download artifact(s): Artifact not found for name: {name}")),
            }
        } else if !ids.is_empty() {
            let chosen: Vec<Listed> = listed.into_iter().filter(|a| ids.contains(&a.id)).collect();
            if chosen.is_empty() {
                return fail(self, "Unable to download artifact(s): None of the provided artifact IDs were found.");
            }
            if chosen.len() < ids.len() {
                self.log.line(&format!("##[warning]Could only find {} of {} artifact IDs.", chosen.len(), ids.len()));
            }
            chosen
        } else {
            match input(with, "pattern") {
                Some(pattern) => listed.into_iter().filter(|a| glob::matches_part(pattern, &a.name)).collect(),
                None => listed,
            }
        };
        let mut outputs = BTreeMap::new();
        outputs.insert("download-path".into(), dest.display().to_string());
        if chosen.is_empty() {
            match input(with, "pattern") {
                Some(pattern) => self.log.line(&format!("No artifacts matched the pattern {pattern}; nothing was downloaded.")),
                None => self.log.line("The run has no artifacts; nothing was downloaded."),
            }
            return (true, outputs);
        }
        let targets = download_targets(&dest, &chosen, name.is_some(), !ids.is_empty(), merge);
        for (artifact, target) in chosen.iter().zip(targets) {
            let Some(target) = target else {
                return fail(self, &format!("The artifact {} cannot be downloaded into a folder of its name.", artifact.name));
            };
            if let Err(error) = self.fetch_artifact(artifact, &target) {
                return fail(self, &format!("The artifact {} could not be downloaded: {error}", artifact.name));
            }
            self.log.line(&format!("Downloaded artifact {} ({}) into {}", artifact.name, megabytes(artifact.size), target.display()));
        }
        if chosen.len() > 1 {
            self.log.line(&format!("Downloaded {}.", count(chosen.len(), "artifact")));
        }
        (true, outputs)
    }

    /// `actions/upload-artifact/merge`: the run's artifacts matching
    /// `pattern`, downloaded together and uploaded again as one.
    pub(crate) fn merge_artifacts(&mut self, with: &BTreeMap<String, String>) -> (bool, BTreeMap<String, String>) {
        let fail = |job: &mut Job, message: &str| {
            job.log.line(&format!("##[error]{message}"));
            (false, BTreeMap::new())
        };
        let name = input(with, "name").unwrap_or("merged-artifacts").to_owned();
        let pattern = input(with, "pattern").unwrap_or("*").to_owned();
        let options = check_name(&name).and_then(|()| {
            let keep = keep(with, false)?;
            Ok((keep, flag(with, "separate-directories", false)?, flag(with, "delete-merged", false)?))
        });
        let (keep, separate, delete) = match options {
            Ok(options) => options,
            Err(message) => return fail(self, &message),
        };
        let listed = match self.list_artifacts(None) {
            Ok(listed) => listed,
            Err(error) => return fail(self, &format!("The artifacts could not be listed: {error}")),
        };
        let chosen: Vec<Listed> = listed.into_iter().filter(|a| glob::matches_part(&pattern, &a.name)).collect();
        if chosen.is_empty() {
            return fail(self, &format!("No artifacts found matching pattern '{pattern}'."));
        }
        self.log.line(&format!("Merging {}: {}", count(chosen.len(), "artifact"), chosen.iter().map(|a| a.name.as_str()).collect::<Vec<_>>().join(", ")));
        let folder = self.temp.join(format!("merge-{}", super::rand_id()));
        let targets = download_targets(&folder, &chosen, false, false, !separate);
        let mut result = None;
        for (artifact, target) in chosen.iter().zip(targets) {
            let Some(target) = target else {
                result = Some(fail(self, &format!("The artifact {} cannot be merged into a folder of its name.", artifact.name)));
                break;
            };
            if let Err(error) = self.fetch_artifact(artifact, &target) {
                result = Some(fail(self, &format!("The artifact {} could not be downloaded: {error}", artifact.name)));
                break;
            }
        }
        let result = result.unwrap_or_else(|| {
            let root = folder.display().to_string();
            let found = glob::find(std::slice::from_ref(&root), &root, &self.home(), keep.hidden);
            if found.files.is_empty() {
                fail(self, "The artifacts matched hold no files to merge.")
            } else {
                self.send_artifact(&name, &found.files, &keep)
            }
        });
        let _ = std::fs::remove_dir_all(&folder);
        if result.0 && delete {
            for artifact in &chosen {
                match ureq::delete(&self.url(&format!("artifacts/{}", artifact.id))).set("authorization", &self.auth()).timeout(Duration::from_secs(60)).call() {
                    Ok(_) => self.log.line(&format!("Deleted artifact {}.", artifact.name)),
                    Err(ureq::Error::Status(_, response)) => self.log.line(&format!("##[warning]Artifact {} could not be deleted: {}", artifact.name, refusal(response))),
                    Err(error) => self.log.line(&format!("##[warning]Artifact {} could not be deleted: {error}", artifact.name)),
                }
            }
        }
        result
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
        let version = cache_version(with.get("path").map(String::as_str).unwrap_or_default(), compression());
        let restore = lines(with.get("restore-keys").map(String::as_str).unwrap_or_default());
        let query = format!(
            "cache?key={}&restore={}&version={}",
            urlencode(&key),
            urlencode(&restore.join("\n")),
            urlencode(&version)
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
                run: PostRun::CacheSave { key, paths, version },
            });
        }
        (true, outputs)
    }

    /// Saves paths under a key, unless the key is taken.
    pub(crate) fn cache_save(&mut self, key: &str, paths: &[String], version: &str) -> bool {
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
        match self.upload_cache(key, version, &archive) {
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
        let version = cache_version(with.get("path").map(String::as_str).unwrap_or_default(), compression());
        (self.cache_save(&key, &paths, &version), BTreeMap::new())
    }
}

/// An input, trimmed; `None` when empty.
fn input<'a>(with: &'a BTreeMap<String, String>, key: &str) -> Option<&'a str> {
    with.get(key).map(|v| v.trim()).filter(|v| !v.is_empty())
}

/// A true-or-false input, as `core.getBooleanInput` reads it.
fn flag(with: &BTreeMap<String, String>, key: &str, default: bool) -> Result<bool, String> {
    match input(with, key) {
        None => Ok(default),
        Some("true" | "True" | "TRUE") => Ok(true),
        Some("false" | "False" | "FALSE") => Ok(false),
        Some(other) => Err(format!("`{key}` is `{other}`; it takes true or false.")),
    }
}

/// `1 file`, `3 files`.
fn count(n: usize, what: &str) -> String {
    if n == 1 { format!("1 {what}") } else { format!("{n} {what}s") }
}

/// An id that came as a number or as text.
fn number(value: &serde_json::Value) -> Option<u64> {
    value.as_u64().or_else(|| value.as_str().and_then(|s| s.parse().ok()))
}

/// Whether a name is one GitHub takes for an artifact: not empty, at most
/// 256 characters, none of `" : < > | * ? \ /` or a line break.
fn check_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("The artifact needs a name.".into());
    }
    if name.chars().count() > 256 {
        return Err(format!("The artifact name `{name}` is longer than 256 characters."));
    }
    if let Some(bad) = name.chars().find(|c| matches!(c, '"' | ':' | '<' | '>' | '|' | '*' | '?' | '\r' | '\n' | '\\' | '/')) {
        let shown = match bad {
            '\r' => "a carriage return".to_owned(),
            '\n' => "a line break".to_owned(),
            c => format!("`{c}`"),
        };
        return Err(format!("The artifact name `{name}` is not valid: it contains {shown}. A name may not contain \" : < > | * ? \\ / or line breaks."));
    }
    Ok(())
}

/// How an artifact is packed and kept, from the inputs `upload-artifact`
/// and its merge share.
#[derive(Debug, PartialEq)]
struct Keep {
    /// Days; 0 for the repository's own setting.
    retention: u32,
    /// 0 (stored) to 9.
    level: u32,
    overwrite: bool,
    /// Whether files and folders whose names start with `.` are taken.
    hidden: bool,
}

fn keep(with: &BTreeMap<String, String>, takes_overwrite: bool) -> Result<Keep, String> {
    let retention = match input(with, "retention-days") {
        None => 0,
        Some(text) => match text.parse::<u32>() {
            Ok(days @ 0..=90) => days,
            _ => return Err(format!("`retention-days` is `{text}`; it takes a number of days from 1 to 90, or nothing for the repository's setting.")),
        },
    };
    let level = match input(with, "compression-level") {
        None => 6,
        Some(text) => match text.parse::<u32>() {
            Ok(level @ 0..=9) => level,
            _ => return Err(format!("`compression-level` is `{text}`; it takes 0 (no compression) to 9.")),
        },
    };
    Ok(Keep {
        retention,
        level,
        overwrite: takes_overwrite && flag(with, "overwrite", false)?,
        hidden: flag(with, "include-hidden-files", false)?,
    })
}

/// What finishing an upload gave: the artifact's id, the ZIP's SHA-256 in
/// hex, and the days it is kept, when known.
struct Sent {
    id: u64,
    digest: String,
    retention: Option<u32>,
}

/// An artifact as g1t lists it.
#[derive(Debug, Clone, PartialEq)]
struct Listed {
    id: u64,
    name: String,
    size: u64,
    digest: Option<String>,
    /// `zip`, or `tgz` for an artifact an older runner stored.
    format: String,
}

impl Listed {
    fn from_json(value: &serde_json::Value) -> Option<Listed> {
        Some(Listed {
            id: number(&value["id"])?,
            name: value["name"].as_str()?.to_owned(),
            size: value["size"].as_u64().unwrap_or(0),
            digest: value["digest"].as_str().map(str::to_owned),
            format: value["format"].as_str().unwrap_or("zip").to_owned(),
        })
    }
}

/// One artifact per name, the newest (highest id), in name order.
fn newest(listed: Vec<Listed>) -> Vec<Listed> {
    let mut by_name: BTreeMap<String, Listed> = BTreeMap::new();
    for artifact in listed {
        if by_name.get(&artifact.name).is_none_or(|kept| kept.id < artifact.id) {
            by_name.insert(artifact.name.clone(), artifact);
        }
    }
    by_name.into_values().collect()
}

/// `artifact-ids`: numbers, separated by commas.
fn artifact_ids(text: &str) -> Result<Vec<u64>, String> {
    text.split(',')
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(|id| id.parse::<u64>().map_err(|_| format!("`artifact-ids` takes artifact ids, numbers separated by commas; `{id}` is not one.")))
        .collect()
}

/// The folder each artifact is unpacked into: `dest` itself for one
/// artifact by name, for `merge-multiple`, and for a single artifact by
/// id; otherwise a folder of the artifact's name in `dest`. `None` for a
/// name that cannot be a folder.
fn download_targets(dest: &Path, chosen: &[Listed], by_name: bool, by_ids: bool, merge: bool) -> Vec<Option<std::path::PathBuf>> {
    let straight = by_name || merge || (by_ids && chosen.len() == 1);
    chosen
        .iter()
        .map(|artifact| {
            if straight {
                Some(dest.to_path_buf())
            } else if artifact.name.is_empty() || artifact.name == "." || artifact.name == ".." || artifact.name.contains(['/', '\\']) {
                None
            } else {
                Some(dest.join(&artifact.name))
            }
        })
        .collect()
}

/// The SHA-256 of a file, in hex, read as it comes.
fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
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

/// How this machine compresses cache entries: zstd where it has it, else
/// gzip, as `pack_script` decides.
fn compression() -> &'static str {
    let zstd = Command::new("sh").args(["-c", "command -v zstd"]).output().is_ok_and(|out| out.status.success());
    if zstd { "zstd" } else { "gzip" }
}

/// An entry's version: the hash of its `path` lines, as written, and its
/// compression, as `actions/cache` makes one. The same key saved for other
/// paths, or packed another way, is another entry.
fn cache_version(path: &str, compression: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut parts = lines(path);
    parts.push(compression.to_owned());
    hex::encode(Sha256::digest(parts.join("|").as_bytes()))
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
    fn a_cache_entrys_version_follows_its_paths_and_compression() {
        let version = cache_version("~/.cargo/registry\ntarget", "zstd");
        assert_eq!(version.len(), 64);
        assert_eq!(version, cache_version("~/.cargo/registry\n\ntarget\n", "zstd"), "blank lines do not count");
        assert_ne!(version, cache_version("~/.cargo/registry", "zstd"));
        assert_ne!(version, cache_version("~/.cargo/registry\ntarget", "gzip"));
    }

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
        assert!(check_name("coverage report").is_ok());
        assert!(check_name("dist-linux_x64.1 (debug)").is_ok());
        assert!(check_name("ünïcødé").is_ok());
        assert!(check_name(&"a".repeat(256)).is_ok());
        assert!(check_name(&"a".repeat(257)).is_err());
        assert!(check_name("").is_err());
        for bad in ["a/b", "a\\b", "a:b", "a*b", "a?b", "a\"b", "a<b", "a>b", "a|b", "a\nb", "a\rb"] {
            assert!(check_name(bad).is_err(), "{bad}");
        }
        assert_eq!(lines("dist/\n\n# note\n  coverage  \n"), ["dist/", "coverage"]);
    }

    fn with(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn upload_inputs_are_read_as_v4_reads_them() {
        assert_eq!(keep(&with(&[]), true).unwrap(), Keep { retention: 0, level: 6, overwrite: false, hidden: false });
        let set = with(&[("retention-days", "14"), ("compression-level", "0"), ("overwrite", "true"), ("include-hidden-files", "True")]);
        assert_eq!(keep(&set, true).unwrap(), Keep { retention: 14, level: 0, overwrite: true, hidden: true });
        // The merge takes no `overwrite`.
        assert!(!keep(&set, false).unwrap().overwrite);
        assert_eq!(keep(&with(&[("retention-days", "0")]), true).unwrap().retention, 0);
        assert!(keep(&with(&[("retention-days", "91")]), true).is_err());
        assert!(keep(&with(&[("retention-days", "-1")]), true).is_err());
        assert!(keep(&with(&[("retention-days", "two")]), true).is_err());
        assert!(keep(&with(&[("compression-level", "10")]), true).is_err());
        assert!(keep(&with(&[("overwrite", "yes")]), true).is_err());
        assert_eq!(artifact_ids(" 12, 34 ,,").unwrap(), [12, 34]);
        assert!(artifact_ids("12,abc").is_err());
        assert_eq!(count(1, "file"), "1 file");
        assert_eq!(count(37, "file"), "37 files");
    }

    fn listed(id: u64, name: &str) -> Listed {
        Listed { id, name: name.into(), size: 0, digest: None, format: "zip".into() }
    }

    #[test]
    fn listings_read_and_keep_the_newest_of_a_name() {
        let json = serde_json::json!([
            { "id": 1, "name": "dist", "size": 10, "digest": null, "format": "tgz", "created_at": "x", "expires_at": "y" },
            { "id": "3", "name": "dist", "size": 30, "digest": "sha256:ab", "format": "zip" },
            { "id": 2, "name": "logs", "size": 5 },
            { "name": "no id" }
        ]);
        let all: Vec<Listed> = json.as_array().unwrap().iter().filter_map(Listed::from_json).collect();
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].format, "tgz");
        let kept = newest(all);
        assert_eq!(kept.iter().map(|a| (a.id, a.name.as_str())).collect::<Vec<_>>(), [(3, "dist"), (2, "logs")]);
        assert_eq!(kept[0].digest.as_deref(), Some("sha256:ab"));
    }

    #[test]
    fn downloads_land_where_v4_puts_them() {
        let dest = Path::new("/w/out");
        let one = [listed(1, "dist")];
        let two = [listed(1, "dist"), listed(2, "logs")];
        let at = |targets: Vec<Option<std::path::PathBuf>>| targets.into_iter().map(|t| t.unwrap()).collect::<Vec<_>>();
        // By name: straight into `path`.
        assert_eq!(at(download_targets(dest, &one, true, false, false)), [dest.to_path_buf()]);
        // Every artifact, or by pattern: a folder each.
        assert_eq!(at(download_targets(dest, &two, false, false, false)), [dest.join("dist"), dest.join("logs")]);
        assert_eq!(at(download_targets(dest, &one, false, false, false)), [dest.join("dist")]);
        // merge-multiple: all into `path`.
        assert_eq!(at(download_targets(dest, &two, false, false, true)), [dest.to_path_buf(), dest.to_path_buf()]);
        // By id: one straight into `path`, several a folder each.
        assert_eq!(at(download_targets(dest, &one, false, true, false)), [dest.to_path_buf()]);
        assert_eq!(at(download_targets(dest, &two, false, true, false)), [dest.join("dist"), dest.join("logs")]);
        // A name that is no folder is refused.
        assert!(download_targets(dest, &[listed(1, ".."), listed(2, "x")], false, false, false)[0].is_none());
        assert!(glob::matches_part("dist-*", "dist-linux"));
        assert!(!glob::matches_part("dist-*", "logs"));
    }
}
