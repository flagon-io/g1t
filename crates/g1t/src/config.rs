//! The CLI's settings: the hosts it is signed in to, which account is active
//! on each, and aliases. One JSON file, `config.json`, in
//!
//! - `G1T_CONFIG_DIR`, when set;
//! - `%APPDATA%\g1t` on Windows;
//! - `$XDG_CONFIG_HOME/g1t`, or `~/.config/g1t`, elsewhere.
//!
//! Tokens are not kept here unless the system keychain cannot hold them
//! (see [`crate::auth`]); then the file is written readable by its owner only.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

use crate::error::{Error, Result};

pub const DEFAULT_HOST: &str = "g1t.sh";

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Config {
    /// The host commands talk to when nothing else names one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_host: Option<String>,
    #[serde(default)]
    pub hosts: BTreeMap<String, HostConfig>,
    #[serde(default)]
    pub aliases: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct HostConfig {
    /// The site, like https://g1t.sh: git remotes and pages.
    pub site: String,
    /// The REST API, like https://api.g1t.sh.
    pub api: String,
    /// The active account's username.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(default)]
    pub users: BTreeMap<String, UserConfig>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct UserConfig {
    /// Set only when the token could not go in the system keychain.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

pub fn dir() -> Result<PathBuf> {
    if let Some(dir) = std::env::var_os("G1T_CONFIG_DIR").filter(|d| !d.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    if cfg!(windows)
        && let Some(appdata) = std::env::var_os("APPDATA")
    {
        return Ok(PathBuf::from(appdata).join("g1t"));
    }
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME").filter(|d| !d.is_empty()) {
        return Ok(PathBuf::from(xdg).join("g1t"));
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or_else(|| {
            Error::failed("No home directory to keep settings in. Set G1T_CONFIG_DIR.")
        })?;
    Ok(PathBuf::from(home).join(".config").join("g1t"))
}

pub fn path() -> Result<PathBuf> {
    Ok(dir()?.join("config.json"))
}

impl Config {
    pub fn load() -> Result<Config> {
        let path = path()?;
        match std::fs::read_to_string(&path) {
            Ok(text) if text.trim().is_empty() => Ok(Config::default()),
            Ok(text) => serde_json::from_str(&text)
                .map_err(|e| Error::failed(format!("{} is not valid: {e}", path.display()))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
            Err(e) => Err(Error::failed(format!(
                "Could not read {}: {e}",
                path.display()
            ))),
        }
    }

    pub fn save(&self) -> Result<()> {
        let path = path()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| Error::failed(format!("Could not make {}: {e}", parent.display())))?;
        }
        let text = serde_json::to_string_pretty(self).expect("config serializes") + "\n";
        let tmp = path.with_extension("json.tmp");
        write_private(&tmp, text.as_bytes())
            .map_err(|e| Error::failed(format!("Could not write {}: {e}", tmp.display())))?;
        std::fs::rename(&tmp, &path)
            .map_err(|e| Error::failed(format!("Could not write {}: {e}", path.display())))?;
        Ok(())
    }

    pub fn host(&self, host: &str) -> Option<&HostConfig> {
        self.hosts.get(host)
    }
}

/// Writes a file only its owner can read: it may hold a token.
fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(bytes)
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_config_round_trips() {
        let config: Config = serde_json::from_str("{}").unwrap();
        assert_eq!(config, Config::default());
        let mut config = Config::default();
        config.hosts.insert(
            "g1t.sh".into(),
            HostConfig {
                site: "https://g1t.sh".into(),
                api: "https://api.g1t.sh".into(),
                user: Some("ana".into()),
                users: [("ana".to_owned(), UserConfig::default())].into(),
            },
        );
        config.aliases.insert("co".into(), "pr checkout".into());
        let text = serde_json::to_string(&config).unwrap();
        assert!(
            !text.contains("token"),
            "no token field when none is kept: {text}"
        );
        assert_eq!(serde_json::from_str::<Config>(&text).unwrap(), config);
    }
}
