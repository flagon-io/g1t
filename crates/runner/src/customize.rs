//! What a job's Claude Code gets from the workspace's Customize
//! (docs.g1t.sh/guides/self-hosted-runners/, "What a run gets from
//! Customize"): the plugins the workspace installed, fetched at the commit
//! each is pinned to; the library's skills, written as a plugin of their
//! own; and the connectors that reach the job's agent, signed in. Read once
//! per run with the run's agent token, before Claude Code starts, and never
//! fatal: a run whose bundle cannot be read goes on without it, and the
//! transcript says so.
//!
//! Plugins land in `/work/.g1t/plugins/<name>/` and are passed with
//! `--plugin-dir`, one flag each, so a plugin's skills are
//! `/<plugin>:<skill>` and the library's `/g1t-library:<skill>`. Connectors
//! join the `--mcp-config` file's `mcpServers` by name, beside g1t's own
//! server, so their tools are `mcp__<name>__<tool>`. The bundle holds the
//! connectors' secrets: they go into that file and nowhere else, and are
//! kept out of the transcript.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// Where plugins are written, one folder each.
pub(crate) const PLUGINS_DIR: &str = "/work/.g1t/plugins";
/// Downloads and clones on their way to `PLUGINS_DIR`.
const TEMP_DIR: &str = "/work/.g1t/tmp";
/// The library's skills, as a plugin of their own.
pub(crate) const LIBRARY: &str = "g1t-library";
/// How long one download or clone may take.
const TIMEOUT: Duration = Duration::from_secs(120);
/// The most a plugin's archive may be.
const MAX_ARCHIVE: u64 = 256 * 1024 * 1024;

/// What a run loaded from Customize: for Claude Code's command line and the
/// run's transcript.
#[derive(Debug, Default, PartialEq)]
pub struct Loaded {
    /// `--plugin-dir <dir>` for each plugin, the library included.
    pub flags: Vec<String>,
    pub plugins: usize,
    pub skills: usize,
    pub connectors: usize,
    /// The connectors' header values, to keep out of the transcript.
    pub secrets: Vec<String>,
    /// What could not be loaded, one line each.
    pub problems: Vec<String>,
}

impl Loaded {
    /// Whether there is anything to say in the transcript.
    pub fn is_empty(&self) -> bool {
        self.plugins == 0 && self.skills == 0 && self.connectors == 0 && self.problems.is_empty()
    }

    /// One note for the run's transcript.
    pub fn note(&self) -> String {
        let count = |n: usize, one: &str| if n == 1 { format!("1 {one}") } else { format!("{n} {one}s") };
        let mut note = format!(
            "Loaded {}, {} and {} from the workspace's Customize.",
            count(self.plugins, "plugin"),
            count(self.skills, "library skill"),
            count(self.connectors, "connector")
        );
        for problem in &self.problems {
            note.push(' ');
            note.push_str(problem);
        }
        note
    }
}

/// The workspace a job's repository belongs to: the `owner` of
/// `owner/name`, which is the workspace for a workspace's repositories.
pub(crate) fn workspace_of(repo: &str) -> Option<&str> {
    let (owner, name) = repo.trim().trim_matches('/').split_once('/')?;
    (!owner.is_empty() && !name.is_empty() && !name.contains('/')).then_some(owner)
}

/// A name that is safe as one path segment and as a plugin's: letters,
/// digits, `.`, `_` and `-`, not starting with `.` or `-`.
fn safe_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(first) if first.is_ascii_alphanumeric() || first == '_')
        && name.len() <= 100
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// `owner/name`, both safe.
fn safe_repo(repo: &str) -> bool {
    matches!(repo.split_once('/'), Some((owner, name)) if safe_name(owner) && safe_name(name))
}

/// A git ref or commit as an argument: never an option, never a path trick.
fn safe_ref(git_ref: &str) -> bool {
    let mut chars = git_ref.chars();
    matches!(chars.next(), Some(first) if first.is_ascii_alphanumeric())
        && git_ref.len() <= 200
        && !git_ref.contains("..")
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/'))
}

/// A path inside a repository, `a/b/c` or empty for its root.
fn safe_path(path: &str) -> bool {
    path.is_empty() || path.split('/').all(safe_name)
}

/// Where a plugin is fetched from, as the bundle's `fetch` says.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Source {
    /// GitHub's tarball of `repo` at a commit or ref (`HEAD` when neither).
    Github { repo: String, at: String, path: String },
    /// A repository on this g1t, cloned at a ref (`HEAD` when none).
    G1t { repo: String, git_ref: String, path: String },
    /// A zip at a URL, checked against `sha256` when given.
    Archive { url: String, sha256: Option<String> },
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Plugin {
    pub name: String,
    pub source: Source,
}

/// A plugin entry of the bundle, read: its name as a folder and where its
/// files come from, or why it cannot be fetched here.
pub(crate) fn plugin_of(entry: &Value) -> Result<Plugin, String> {
    let name = entry["name"].as_str().unwrap_or_default().trim();
    let shown = entry["ref"].as_str().unwrap_or(name);
    if !safe_name(name) || name == LIBRARY {
        return Err(format!("{shown}: not a name a plugin folder can have."));
    }
    let fetch = &entry["fetch"];
    let text = |key: &str| fetch[key].as_str().map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned);
    // `./plugins/x/`, `plugins/x` and `.` all name the same folder.
    let given = text("path").unwrap_or_default();
    let parts: Vec<&str> = given.split('/').filter(|part| !part.is_empty() && *part != ".").collect();
    if !parts.iter().all(|part| safe_name(part)) {
        return Err(format!("{shown}: its path in the repository will not do."));
    }
    let path = parts.join("/");
    let source = match fetch["kind"].as_str() {
        Some("github") => {
            let repo = text("repo").filter(|repo| safe_repo(repo)).ok_or_else(|| format!("{shown}: no GitHub repository to read."))?;
            let at = text("sha").or_else(|| text("ref")).unwrap_or_else(|| "HEAD".to_owned());
            if !safe_ref(&at) {
                return Err(format!("{shown}: {at} is not a commit or ref."));
            }
            Source::Github { repo, at, path }
        }
        Some("g1t") => {
            let repo = text("repo").filter(|repo| safe_repo(repo)).ok_or_else(|| format!("{shown}: no repository on g1t to read."))?;
            let git_ref = text("ref").unwrap_or_else(|| "HEAD".to_owned());
            if !safe_ref(&git_ref) {
                return Err(format!("{shown}: {git_ref} is not a commit or ref."));
            }
            Source::G1t { repo, git_ref, path }
        }
        Some("archive") => {
            let url = text("url").filter(|url| url.starts_with("https://")).ok_or_else(|| format!("{shown}: its archive has no https address."))?;
            let sha256 = text("sha256").map(|sha| sha.to_ascii_lowercase());
            if sha256.as_deref().is_some_and(|sha| sha.len() != 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit())) {
                return Err(format!("{shown}: its archive's sha256 will not do."));
            }
            Source::Archive { url, sha256 }
        }
        Some("unsupported") => {
            return Err(format!("{shown}: {}", fetch["why"].as_str().unwrap_or("g1t cannot fetch it here.")));
        }
        _ => return Err(format!("{shown}: g1t does not know where to fetch it from.")),
    };
    Ok(Plugin { name: name.to_owned(), source })
}

/// A plugin's folder.
pub(crate) fn plugin_dir(name: &str) -> String {
    format!("{PLUGINS_DIR}/{name}")
}

/// `--plugin-dir <dir>` for each folder.
pub(crate) fn plugin_flags<'a>(dirs: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    dirs.into_iter().flat_map(|dir| ["--plugin-dir".to_owned(), dir.to_owned()]).collect()
}

/// The library plugin's files, relative to its folder: its manifest and
/// each skill's files under `skills/<name>/`. Skills that cannot be written
/// as given are left out; how many were kept comes back with the files.
pub(crate) fn library_files(skills: &[Value]) -> (Vec<(String, Vec<u8>)>, usize) {
    let mut files = vec![(
        ".claude-plugin/plugin.json".to_owned(),
        json!({ "name": LIBRARY, "description": "The workspace's skill library on g1t." }).to_string().into_bytes(),
    )];
    let mut kept = 0;
    for skill in skills {
        let name = skill["name"].as_str().unwrap_or_default().trim();
        let Some(entries) = skill["files"].as_array().filter(|files| !files.is_empty()) else { continue };
        if !safe_name(name) {
            continue;
        }
        let mut own = Vec::new();
        for file in entries {
            let path = file["path"].as_str().unwrap_or_default().trim().trim_matches('/');
            if path.is_empty() || !safe_path(path) {
                own.clear();
                break;
            }
            let content = file["content"].as_str().unwrap_or_default();
            let bytes = if file["encoding"] == "base64" {
                match STANDARD.decode(content.trim()) {
                    Ok(bytes) => bytes,
                    Err(_) => {
                        own.clear();
                        break;
                    }
                }
            } else {
                content.as_bytes().to_vec()
            };
            own.push((format!("skills/{name}/{path}"), bytes));
        }
        if own.iter().any(|(path, _)| path.ends_with("/SKILL.md")) {
            files.extend(own);
            kept += 1;
        }
    }
    (files, kept)
}

/// Adds the connectors to the MCP config's `mcpServers`, each as an HTTP
/// server by its name with the headers that sign it in. g1t's own server
/// stays whatever a connector is called. Returns how many were added and
/// the header values, which must never reach the transcript.
pub(crate) fn merge_connectors(config: &mut Value, connectors: &[Value]) -> (usize, Vec<String>) {
    if !config["mcpServers"].is_object() {
        config["mcpServers"] = json!({});
    }
    let mut added = 0;
    let mut secrets = Vec::new();
    for connector in connectors {
        let name = connector["name"].as_str().unwrap_or_default().trim();
        let url = connector["url"].as_str().unwrap_or_default().trim();
        if name.is_empty() || name == "g1t" || !safe_name(name) || !url.starts_with("https://") {
            continue;
        }
        let headers: serde_json::Map<String, Value> = connector["headers"]
            .as_object()
            .map(|headers| headers.iter().filter(|(_, value)| value.is_string()).map(|(key, value)| (key.clone(), value.clone())).collect())
            .unwrap_or_default();
        secrets.extend(headers.values().filter_map(Value::as_str).filter(|value| value.len() >= 8).map(str::to_owned));
        config["mcpServers"][name] = json!({ "type": "http", "url": url, "headers": headers });
        added += 1;
    }
    (added, secrets)
}

/// This g1t's git origin, for cloning its repositories: where the job's
/// own clone came from, else the API's host without its `api.`.
pub(crate) fn origin_of(remote: Option<&str>, api: Option<&str>) -> String {
    if let Some(remote) = remote
        && let Some((scheme, rest)) = remote.split_once("://")
        && let Some(host) = rest.split('/').next().filter(|host| !host.is_empty() && !host.contains('@'))
    {
        return format!("{scheme}://{host}");
    }
    let api = api.unwrap_or("https://api.g1t.sh").trim_end_matches('/');
    api.replacen("://api.", "://", 1)
}

/// Reads the bundle with the run's agent token.
fn fetch_bundle(api: &str, workspace: &str, token: &str) -> Result<Value, String> {
    let response = ureq::get(&format!("{api}/workspaces/{workspace}/customize/bundle"))
        .set("authorization", &format!("Bearer {token}"))
        .timeout(TIMEOUT)
        .call()
        .map_err(|error| match error {
            ureq::Error::Status(code, response) => {
                let body: Value = response.into_json().unwrap_or(Value::Null);
                body["error"]["message"].as_str().map_or_else(|| format!("g1t answered {code}"), str::to_owned)
            }
            other => other.to_string(),
        })?;
    response.into_json().map_err(|error| error.to_string())
}

/// Downloads `url` to `to`, up to `MAX_ARCHIVE` bytes.
fn download(url: &str, to: &Path) -> Result<(), String> {
    let response = ureq::get(url).timeout(TIMEOUT).call().map_err(|error| error.to_string())?;
    let mut file = std::fs::File::create(to).map_err(|error| error.to_string())?;
    let mut reader = response.into_reader().take(MAX_ARCHIVE + 1);
    let copied = std::io::copy(&mut reader, &mut file).map_err(|error| error.to_string())?;
    if copied > MAX_ARCHIVE {
        return Err("it is larger than 256 MB".to_owned());
    }
    Ok(())
}

/// `tar -xzf archive -C into --strip-components=1`.
fn untar(archive: &Path, into: &Path) -> Result<(), String> {
    std::fs::create_dir_all(into).map_err(|error| error.to_string())?;
    let output = Command::new("tar")
        .arg("-xzf")
        .arg(archive)
        .arg("-C")
        .arg(into)
        .arg("--strip-components=1")
        .output()
        .map_err(|error| format!("could not run tar: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!("tar failed: {}", String::from_utf8_lossy(&output.stderr).trim()))
    }
}

/// Moves `path` inside `extracted` (its root when empty) to `dest`.
fn take_path(extracted: &Path, path: &str, dest: &Path) -> Result<(), String> {
    let source = if path.is_empty() { extracted.to_path_buf() } else { extracted.join(path) };
    if !source.is_dir() {
        return Err(format!("it has no folder {}", if path.is_empty() { "at its root" } else { path }));
    }
    let _ = std::fs::remove_dir_all(dest);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::rename(&source, dest).map_err(|error| error.to_string())
}

/// A fresh folder under `TEMP_DIR`.
fn scratch(label: &str) -> Result<PathBuf, String> {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let dir = Path::new(TEMP_DIR).join(format!("{label}-{nanos}"));
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn fetch_github(repo: &str, at: &str, path: &str, dest: &Path) -> Result<(), String> {
    let temp = scratch("github")?;
    let archive = temp.join("plugin.tar.gz");
    let extracted = temp.join("extracted");
    let result = download(&format!("https://codeload.github.com/{repo}/tar.gz/{at}"), &archive)
        .and_then(|()| untar(&archive, &extracted))
        .and_then(|()| take_path(&extracted, path, dest));
    let _ = std::fs::remove_dir_all(&temp);
    result
}

fn fetch_g1t(repo: &str, git_ref: &str, path: &str, dest: &Path, token: &str) -> Result<(), String> {
    let temp = scratch("g1t")?;
    let clone = temp.join("clone");
    let origin = origin_of(std::env::var("GIT_REMOTE").ok().as_deref(), std::env::var("G1T_API").ok().as_deref());
    let auth = crate::auth_option("x-access-token", token);
    let result = std::fs::create_dir_all(&clone)
        .map_err(|error| error.to_string())
        .and_then(|()| crate::git(&clone, &["init", "--quiet"]).map_err(|error| error.to_string()))
        .and_then(|_| crate::git(&clone, &["remote", "add", "origin", &format!("{origin}/{repo}.git")]).map_err(|error| error.to_string()))
        .and_then(|_| {
            crate::git(&clone, &["-c", &auth, "fetch", "--quiet", "--depth=1", "--no-tags", "origin", git_ref]).map_err(|error| error.to_string())
        })
        .and_then(|_| crate::git(&clone, &["checkout", "--quiet", "--force", "--detach", "FETCH_HEAD"]).map_err(|error| error.to_string()))
        .and_then(|_| {
            // The clone's history is not the plugin's business.
            let _ = std::fs::remove_dir_all(clone.join(".git"));
            take_path(&clone, path, dest)
        });
    let _ = std::fs::remove_dir_all(&temp);
    result
}

fn fetch_archive(url: &str, sha256: Option<&str>, dest: &Path) -> Result<(), String> {
    let temp = scratch("archive")?;
    let zip = temp.join("plugin.zip");
    let extracted = temp.join("extracted");
    let result = download(url, &zip)
        .and_then(|()| match sha256 {
            Some(expected) => {
                let bytes = std::fs::read(&zip).map_err(|error| error.to_string())?;
                let actual = hex::encode(Sha256::digest(&bytes));
                if actual == expected { Ok(()) } else { Err("its sha256 is not the one the marketplace gave".to_owned()) }
            }
            None => Ok(()),
        })
        .and_then(|()| crate::actions::zip::extract(&zip, &extracted).map(|_| ()).map_err(|error| error.to_string()))
        .and_then(|()| {
            // A zip of one folder holds the plugin inside it.
            let mut entries: Vec<PathBuf> = std::fs::read_dir(&extracted).map_err(|error| error.to_string())?.filter_map(|entry| entry.ok().map(|entry| entry.path())).collect();
            let root = match entries.as_slice() {
                [only] if only.is_dir() && !extracted.join(".claude-plugin").exists() => entries.remove(0),
                _ => extracted.clone(),
            };
            take_path(&root, "", dest)
        });
    let _ = std::fs::remove_dir_all(&temp);
    result
}

fn fetch_plugin(plugin: &Plugin, token: &str) -> Result<String, String> {
    let dir = plugin_dir(&plugin.name);
    let dest = Path::new(&dir);
    match &plugin.source {
        Source::Github { repo, at, path } => fetch_github(repo, at, path, dest)?,
        Source::G1t { repo, git_ref, path } => fetch_g1t(repo, git_ref, path, dest, token)?,
        Source::Archive { url, sha256 } => fetch_archive(url, sha256.as_deref(), dest)?,
    }
    Ok(dir)
}

/// Writes the library plugin; its folder, or None when there is nothing
/// to write or it could not be.
fn write_library(skills: &[Value]) -> Result<Option<(String, usize)>, String> {
    let (files, kept) = library_files(skills);
    if kept == 0 {
        return Ok(None);
    }
    let dir = plugin_dir(LIBRARY);
    let root = Path::new(&dir);
    let _ = std::fs::remove_dir_all(root);
    for (path, bytes) in files {
        let target = root.join(&path);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        std::fs::write(&target, bytes).map_err(|error| error.to_string())?;
    }
    Ok(Some((dir, kept)))
}

/// Reads the workspace's bundle with the run's agent token and makes it
/// ready for Claude Code: plugins and the library on disk, as `--plugin-dir`
/// flags, and connectors merged into `config`, the `--mcp-config` file.
/// Never fails the run: whatever could not be loaded is in `problems`.
pub fn prepare(token: &str, config: &mut Value) -> Loaded {
    let mut loaded = Loaded::default();
    let api = std::env::var("G1T_API").unwrap_or_else(|_| "https://api.g1t.sh".to_owned());
    let repo = std::env::var("G1T_REPO").unwrap_or_default();
    let Some(workspace) = workspace_of(&repo) else {
        return loaded;
    };
    let bundle = match fetch_bundle(&api, workspace, token) {
        Ok(bundle) => bundle,
        Err(why) => {
            loaded.problems.push(format!("Could not read the workspace's Customize ({why}); the run goes on without its plugins, skills and connectors."));
            return loaded;
        }
    };
    let mut dirs = Vec::new();
    for entry in bundle["plugins"].as_array().map(Vec::as_slice).unwrap_or_default() {
        match plugin_of(entry).and_then(|plugin| fetch_plugin(&plugin, token)) {
            Ok(dir) => {
                dirs.push(dir);
                loaded.plugins += 1;
            }
            Err(why) => loaded.problems.push(format!("The plugin {why}", why = why.trim_end_matches('.')) + " was not loaded."),
        }
    }
    match write_library(bundle["skills"].as_array().map(Vec::as_slice).unwrap_or_default()) {
        Ok(Some((dir, kept))) => {
            dirs.push(dir);
            loaded.skills = kept;
        }
        Ok(None) => {}
        Err(why) => loaded.problems.push(format!("The library's skills were not written ({why}).")),
    }
    let (connectors, secrets) = merge_connectors(config, bundle["connectors"].as_array().map(Vec::as_slice).unwrap_or_default());
    loaded.connectors = connectors;
    loaded.secrets = secrets;
    loaded.flags = plugin_flags(dirs.iter().map(String::as_str));
    loaded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_workspace_is_the_repositorys_owner() {
        assert_eq!(workspace_of("flagon-io/g1t"), Some("flagon-io"));
        assert_eq!(workspace_of("/acme/web/"), Some("acme"));
        assert_eq!(workspace_of("acme"), None);
        assert_eq!(workspace_of("a/b/c"), None);
        assert_eq!(workspace_of(""), None);
    }

    #[test]
    fn a_plugin_is_fetched_at_its_pinned_commit() {
        let entry = json!({
            "ref": "commit-commands@claude-plugins-official",
            "name": "commit-commands",
            "fetch": { "kind": "github", "repo": "anthropics/claude-plugins-official", "ref": "main", "sha": "9c1f4a6e8b0d2c4f6a8e1b3d5f7a9c1e3b5d7f90", "path": "plugins/commit-commands" },
        });
        assert_eq!(
            plugin_of(&entry).unwrap(),
            Plugin {
                name: "commit-commands".into(),
                source: Source::Github {
                    repo: "anthropics/claude-plugins-official".into(),
                    at: "9c1f4a6e8b0d2c4f6a8e1b3d5f7a9c1e3b5d7f90".into(),
                    path: "plugins/commit-commands".into(),
                },
            }
        );
        // Without a commit, the ref; without either, HEAD.
        let by_ref = json!({ "name": "x", "fetch": { "kind": "github", "repo": "a/b", "ref": "v1.2", "sha": null, "path": "" } });
        assert!(matches!(plugin_of(&by_ref).unwrap().source, Source::Github { at, path, .. } if at == "v1.2" && path.is_empty()));
        let head = json!({ "name": "x", "fetch": { "kind": "github", "repo": "a/b", "ref": null, "sha": null, "path": "./" } });
        assert!(matches!(plugin_of(&head).unwrap().source, Source::Github { at, .. } if at == "HEAD"));
        let here = json!({ "name": "release-notes", "fetch": { "kind": "g1t", "repo": "flagon-io/plugins", "ref": null, "path": "plugins/release-notes" } });
        assert_eq!(
            plugin_of(&here).unwrap().source,
            Source::G1t { repo: "flagon-io/plugins".into(), git_ref: "HEAD".into(), path: "plugins/release-notes".into() }
        );
        let zipped = json!({ "name": "z", "fetch": { "kind": "archive", "url": "https://example.com/z.zip", "sha256": "A".repeat(64) } });
        assert_eq!(plugin_of(&zipped).unwrap().source, Source::Archive { url: "https://example.com/z.zip".into(), sha256: Some("a".repeat(64)) });
    }

    #[test]
    fn plugins_that_cannot_be_fetched_say_why_and_never_escape_their_folder() {
        let bad = |entry: Value| plugin_of(&entry).unwrap_err();
        assert!(bad(json!({ "name": "npm-thing", "fetch": { "kind": "unsupported", "why": "npm packages are not read on g1t." } })).contains("npm packages"));
        assert!(bad(json!({ "name": "../etc", "fetch": { "kind": "github", "repo": "a/b" } })).contains("folder"));
        assert!(bad(json!({ "name": "g1t-library", "fetch": { "kind": "github", "repo": "a/b" } })).contains("folder"));
        assert!(bad(json!({ "name": "x", "fetch": { "kind": "github", "repo": "a/b", "path": "../../home" } })).contains("path"));
        assert!(bad(json!({ "name": "x", "fetch": { "kind": "github", "repo": "a/b", "ref": "--upload-pack=evil" } })).contains("not a commit"));
        assert!(bad(json!({ "name": "x", "fetch": { "kind": "github", "repo": "a b/c" } })).contains("no GitHub repository"));
        assert!(bad(json!({ "name": "x", "fetch": { "kind": "archive", "url": "http://plain.example/z.zip" } })).contains("https"));
        assert!(bad(json!({ "name": "x", "fetch": { "kind": "archive", "url": "https://x/z.zip", "sha256": "abc" } })).contains("sha256"));
        assert!(bad(json!({ "name": "x", "fetch": { "kind": "command" } })).contains("where to fetch"));
    }

    #[test]
    fn each_plugin_folder_is_one_flag() {
        assert_eq!(
            plugin_flags([plugin_dir("a").as_str(), plugin_dir("g1t-library").as_str()]),
            vec!["--plugin-dir", "/work/.g1t/plugins/a", "--plugin-dir", "/work/.g1t/plugins/g1t-library"]
        );
        assert!(plugin_flags([]).is_empty());
    }

    #[test]
    fn library_skills_become_a_plugin_of_their_own() {
        let skills = vec![
            json!({ "name": "house-style", "plugin": null, "files": [
                { "path": "SKILL.md", "content": "---\nname: house-style\n---\nHow we write.", "encoding": "utf8" },
                { "path": "examples/commit.md", "content": "IyBBIGdvb2QgY29tbWl0", "encoding": "base64" },
            ] }),
            // No SKILL.md: not a skill Claude Code can read.
            json!({ "name": "broken", "plugin": null, "files": [{ "path": "notes.md", "content": "x", "encoding": "utf8" }] }),
            // A path that leaves its folder takes the whole skill out.
            json!({ "name": "sneaky", "plugin": null, "files": [
                { "path": "SKILL.md", "content": "x", "encoding": "utf8" },
                { "path": "../../etc/passwd", "content": "x", "encoding": "utf8" },
            ] }),
            json!({ "name": "../up", "plugin": null, "files": [{ "path": "SKILL.md", "content": "x", "encoding": "utf8" }] }),
            json!({ "name": "empty", "plugin": null, "files": [] }),
        ];
        let (files, kept) = library_files(&skills);
        assert_eq!(kept, 1);
        let paths: Vec<&str> = files.iter().map(|(path, _)| path.as_str()).collect();
        assert_eq!(paths, vec![".claude-plugin/plugin.json", "skills/house-style/SKILL.md", "skills/house-style/examples/commit.md"]);
        let manifest: Value = serde_json::from_slice(&files[0].1).unwrap();
        assert_eq!(manifest["name"], "g1t-library");
        assert_eq!(files[2].1, b"# A good commit");
    }

    #[test]
    fn connectors_join_the_mcp_config_beside_g1ts_own_server() {
        let mut config = json!({ "mcpServers": { "g1t": { "type": "http", "url": "https://mcp.g1t.sh", "headers": { "Authorization": "Bearer run-token" } } } });
        let connectors = vec![
            json!({ "name": "linear", "url": "https://mcp.linear.app/mcp", "headers": { "Authorization": "Bearer lin_oauth_secret_value" } }),
            json!({ "name": "docs-search", "url": "https://mcp.flagon.dev/docs", "headers": { "X-Api-Key": "fd_live_key_value" } }),
            // Nothing takes g1t's own place, and nothing unsafe is written.
            json!({ "name": "g1t", "url": "https://evil.example/mcp", "headers": {} }),
            json!({ "name": "plain", "url": "http://insecure.example/mcp", "headers": {} }),
            json!({ "name": "bad name", "url": "https://x.example/mcp", "headers": {} }),
        ];
        let (added, secrets) = merge_connectors(&mut config, &connectors);
        assert_eq!(added, 2);
        assert_eq!(secrets, vec!["Bearer lin_oauth_secret_value", "fd_live_key_value"]);
        let servers = config["mcpServers"].as_object().unwrap();
        assert_eq!(servers.len(), 3);
        assert_eq!(servers["g1t"]["url"], "https://mcp.g1t.sh");
        assert_eq!(servers["linear"], json!({ "type": "http", "url": "https://mcp.linear.app/mcp", "headers": { "Authorization": "Bearer lin_oauth_secret_value" } }));
        assert_eq!(servers["docs-search"]["type"], "http");
        // A config without servers gets the map.
        let mut bare = json!({});
        assert_eq!(merge_connectors(&mut bare, &connectors[..1]).0, 1);
        assert!(bare["mcpServers"]["linear"].is_object());
    }

    #[test]
    fn the_g1t_origin_comes_from_the_clone_or_the_api() {
        assert_eq!(origin_of(Some("https://g1t.sh/flagon-io/g1t.git"), None), "https://g1t.sh");
        assert_eq!(origin_of(Some("https://git.example.com/acme/web"), Some("https://api.example.com")), "https://git.example.com");
        assert_eq!(origin_of(None, Some("https://api.g1t.sh")), "https://g1t.sh");
        assert_eq!(origin_of(None, Some("https://api.self-hosted.example/")), "https://self-hosted.example");
        assert_eq!(origin_of(Some("not a url"), None), "https://g1t.sh");
        // A credential in the remote is never copied into a clone address.
        assert_eq!(origin_of(Some("https://user:token@g1t.sh/a/b"), Some("https://api.g1t.sh")), "https://g1t.sh");
    }

    #[test]
    fn the_note_counts_what_was_loaded_and_says_what_was_not() {
        let loaded = Loaded { plugins: 2, skills: 1, connectors: 0, problems: vec!["The plugin x@y: tar failed was not loaded.".into()], ..Loaded::default() };
        assert_eq!(
            loaded.note(),
            "Loaded 2 plugins, 1 library skill and 0 connectors from the workspace's Customize. The plugin x@y: tar failed was not loaded."
        );
        assert!(Loaded::default().is_empty());
        assert!(!loaded.is_empty());
    }
}
