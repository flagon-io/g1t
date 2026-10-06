//! What `g1t-runner register` keeps: where g1t is, who this runner is, its
//! credential, and how it runs work. One JSON file in the runner's folder,
//! readable by its owner only.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Config {
    /// The site, as given to `--url`: `https://g1t.sh`.
    pub url: String,
    /// The API the runner calls: `https://api.g1t.sh`.
    pub api: String,
    /// The runner's id and name.
    pub runner: String,
    pub name: String,
    /// Its credential (`g1tr_…`). Rotated by g1t every day.
    pub credential: String,
    pub workspace: String,
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub group: Option<String>,
    pub labels: Vec<String>,
    /// Runs one job, then removes itself.
    #[serde(default)]
    pub ephemeral: bool,
    /// Where jobs keep their files when they run on this machine directly.
    pub work_dir: PathBuf,
    /// Runs work in Docker containers (the default), or directly.
    #[serde(default = "yes")]
    pub docker: bool,
    /// The image workflow jobs run in when they name no `container:`.
    #[serde(default)]
    pub image: Option<String>,
    /// The image agent work runs in: git, Node and the agent's CLI.
    #[serde(default)]
    pub agent_image: Option<String>,
    /// A Linux build of `g1t-runner` to run inside containers, instead of
    /// this binary (on Linux) or the release's (elsewhere).
    #[serde(default)]
    pub harness: Option<PathBuf>,
    /// Checks for new versions and updates itself.
    #[serde(default = "yes")]
    pub auto_update: bool,
}

fn yes() -> bool {
    true
}

/// The runner's folder: `--dir`, `G1T_RUNNER_DIR`, else `.g1t-runner` in
/// the home folder.
pub fn folder(given: Option<&str>) -> PathBuf {
    if let Some(dir) = given.filter(|d| !d.is_empty()) {
        return PathBuf::from(dir);
    }
    if let Some(dir) = std::env::var_os("G1T_RUNNER_DIR").filter(|d| !d.is_empty()) {
        return PathBuf::from(dir);
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".g1t-runner")
}

pub fn path(folder: &Path) -> PathBuf {
    folder.join("config.json")
}

pub fn load(folder: &Path) -> Result<Config> {
    let file = path(folder);
    let text = std::fs::read_to_string(&file)
        .with_context(|| format!("this runner is not registered ({} not found): run `g1t-runner register` first", file.display()))?;
    serde_json::from_str(&text).with_context(|| format!("{} does not read", file.display()))
}

/// Writes the configuration so only its owner can read it, through a
/// temporary file, so a crash never leaves half a credential.
pub fn save(folder: &Path, config: &Config) -> Result<()> {
    std::fs::create_dir_all(folder).with_context(|| format!("could not make {}", folder.display()))?;
    let file = path(folder);
    let temp = folder.join("config.json.new");
    std::fs::write(&temp, serde_json::to_string_pretty(config)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&temp, &file).with_context(|| format!("could not write {}", file.display()))?;
    Ok(())
}

pub fn forget(folder: &Path) {
    let _ = std::fs::remove_file(path(folder));
}

/// The API for a site: `https://g1t.sh` calls `https://api.g1t.sh`.
pub fn api_for(url: &str) -> String {
    let url = url.trim_end_matches('/');
    match url.split_once("://") {
        Some((scheme, host)) if !host.starts_with("api.") && !host.starts_with("localhost") && !host.starts_with("127.") => {
            format!("{scheme}://api.{host}")
        }
        _ => url.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_api_is_found_from_the_site() {
        assert_eq!(api_for("https://g1t.sh"), "https://api.g1t.sh");
        assert_eq!(api_for("https://g1t.sh/"), "https://api.g1t.sh");
        assert_eq!(api_for("https://api.g1t.sh"), "https://api.g1t.sh");
        assert_eq!(api_for("https://git.example.com"), "https://api.git.example.com");
        assert_eq!(api_for("http://localhost:8787"), "http://localhost:8787");
    }

    #[test]
    fn a_configuration_survives_a_round_trip() {
        let dir = std::env::temp_dir().join(format!("g1t-runner-config-{}", std::process::id()));
        let config = Config {
            url: "https://g1t.sh".into(),
            api: "https://api.g1t.sh".into(),
            runner: "rnr_1".into(),
            name: "build-01".into(),
            credential: "g1tr_x".into(),
            workspace: "acme".into(),
            repo: None,
            group: Some("Default".into()),
            labels: vec!["self-hosted".into(), "linux".into()],
            ephemeral: false,
            work_dir: dir.join("work"),
            docker: true,
            image: None,
            agent_image: None,
            harness: None,
            auto_update: true,
        };
        save(&dir, &config).unwrap();
        let back = load(&dir).unwrap();
        assert_eq!(back.runner, "rnr_1");
        assert_eq!(back.labels, config.labels);
        forget(&dir);
        assert!(load(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
