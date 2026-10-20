//! Hosts and their tokens.
//!
//! A host is a g1t: g1t.sh, or one run by its owner. Each has a site (git
//! remotes, pages) and an API; g1t.sh's are built in, and any other is found
//! from its `/.well-known/g1t.json` when signing in.
//!
//! A token is the first of:
//!
//! 1. `G1T_TOKEN`, for whatever host the command talks to;
//! 2. the system keychain (macOS Keychain, Windows Credential Manager, the
//!    Secret Service on Linux), under the service `g1t:<host>`;
//! 3. `config.json`, where a token goes only when there is no keychain
//!    (a server, a container) or `--insecure-storage` asked for it.
//!
//! `G1T_KEYRING=off` keeps the keychain out of it entirely.

use serde_json::Value;

use crate::config::{Config, DEFAULT_HOST, HostConfig, UserConfig};
use crate::error::{Error, Result};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Host {
    /// How it is named: `g1t.sh`, `git.example.com`, `localhost:8787`.
    pub name: String,
    pub site: String,
    pub api: String,
}

impl Host {
    pub fn hosted() -> Host {
        Host {
            name: DEFAULT_HOST.to_owned(),
            site: "https://g1t.sh".to_owned(),
            api: "https://api.g1t.sh".to_owned(),
        }
    }
}

/// `git.example.com`, `https://git.example.com/` or `http://localhost:8787`:
/// the host's name and its site's address.
pub fn parse_hostname(input: &str) -> Result<(String, String)> {
    let input = input.trim().trim_end_matches('/');
    let (scheme, rest) = match input.split_once("://") {
        Some((scheme @ ("http" | "https"), rest)) => (scheme, rest),
        Some((scheme, _)) => {
            return Err(Error::usage(format!(
                "`{scheme}://` is not a g1t address: use https://."
            )));
        }
        None => ("https", input),
    };
    let name = rest.split('/').next().unwrap_or(rest).to_lowercase();
    if name.is_empty() || name.contains(char::is_whitespace) {
        return Err(Error::usage(format!("`{input}` is not a hostname.")));
    }
    Ok((name.clone(), format!("{scheme}://{name}")))
}

/// The host named by `--hostname`/`G1T_HOST`, or the default one.
pub fn resolve(config: &Config, hostname: Option<&str>) -> Result<Host> {
    let wanted = match hostname {
        Some(h) if !h.trim().is_empty() => h.to_owned(),
        _ => match std::env::var("G1T_HOST")
            .ok()
            .filter(|h| !h.trim().is_empty())
        {
            Some(h) => h,
            None => config
                .default_host
                .clone()
                .unwrap_or_else(|| DEFAULT_HOST.to_owned()),
        },
    };
    let (name, site) = parse_hostname(&wanted)?;
    let mut host = match config.host(&name) {
        Some(h) => Host {
            name,
            site: h.site.clone(),
            api: h.api.clone(),
        },
        None if name == DEFAULT_HOST => Host::hosted(),
        // Not signed in to it: guess the API's address the way g1t is set
        // up (api.<host>); `auth login` asks the host instead.
        None => {
            let api = site.replacen("://", "://api.", 1);
            Host { name, site, api }
        }
    };
    if let Some(api) = std::env::var("G1T_API_URL")
        .ok()
        .filter(|a| !a.trim().is_empty())
    {
        host.api = api.trim_end_matches('/').to_owned();
    }
    Ok(host)
}

/// Asks `site` where its API is.
pub fn discover(name: &str, site: &str) -> Result<Host> {
    if name == DEFAULT_HOST {
        return Ok(Host::hosted());
    }
    let url = format!("{site}/.well-known/g1t.json");
    let text = crate::http::agent().get(&url)
        .timeout(std::time::Duration::from_secs(15))
        .call()
        .map_err(|e| Error::failed(format!("{name} did not say where its API is ({url}): {e}")))?
        .into_string()
        .map_err(|e| Error::failed(format!("Could not read {url}: {e}")))?;
    let found: Value = serde_json::from_str(&text)
        .map_err(|e| Error::failed(format!("{url} is not g1t's: {e}")))?;
    let api = found["api"]
        .as_str()
        .ok_or_else(|| Error::failed(format!("{url} names no API.")))?;
    let site_said = found["site"].as_str().unwrap_or(site);
    Ok(Host {
        name: name.to_owned(),
        site: site_said.trim_end_matches('/').to_owned(),
        api: api.trim_end_matches('/').to_owned(),
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Env,
    Keyring,
    File,
}

impl Source {
    pub fn label(self) -> &'static str {
        match self {
            Source::Env => "G1T_TOKEN",
            Source::Keyring => "keychain",
            Source::File => "config file",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Token {
    pub value: String,
    pub source: Source,
    /// Whose it is, when the store knows.
    pub user: Option<String>,
}

fn keyring_enabled() -> bool {
    !matches!(
        std::env::var("G1T_KEYRING")
            .ok()
            .as_deref()
            .map(str::to_lowercase)
            .as_deref(),
        Some("off" | "0" | "false" | "no")
    )
}

fn service(host: &str) -> String {
    format!("g1t:{host}")
}

fn keyring_get(host: &str, user: &str) -> Option<String> {
    if !keyring_enabled() {
        return None;
    }
    let entry = keyring::Entry::new(&service(host), user).ok()?;
    entry.get_password().ok().filter(|t| !t.is_empty())
}

fn keyring_set(host: &str, user: &str, token: &str) -> std::result::Result<(), String> {
    if !keyring_enabled() {
        return Err("G1T_KEYRING is off".to_owned());
    }
    let entry = keyring::Entry::new(&service(host), user).map_err(|e| e.to_string())?;
    entry.set_password(token).map_err(|e| e.to_string())?;
    // Some stores accept a write they cannot read back (a locked keyring).
    match entry.get_password() {
        Ok(back) if back == token => Ok(()),
        _ => Err("the keychain did not keep it".to_owned()),
    }
}

fn keyring_delete(host: &str, user: &str) {
    if keyring_enabled()
        && let Ok(entry) = keyring::Entry::new(&service(host), user)
    {
        let _ = entry.delete_credential();
    }
}

/// The token for `host`, and the account it is for when known.
pub fn token(config: &Config, host: &str, user: Option<&str>) -> Option<Token> {
    if user.is_none()
        && let Some(value) = std::env::var("G1T_TOKEN")
            .ok()
            .map(|t| t.trim().to_owned())
            .filter(|t| !t.is_empty())
    {
        return Some(Token {
            value,
            source: Source::Env,
            user: None,
        });
    }
    let entry = config.host(host)?;
    let user = user.map(str::to_owned).or_else(|| entry.user.clone())?;
    stored_token(host, &user, entry.users.get(&user))
}

fn stored_token(host: &str, user: &str, entry: Option<&UserConfig>) -> Option<Token> {
    if let Some(value) = entry
        .and_then(|u| u.token.clone())
        .filter(|t| !t.is_empty())
    {
        return Some(Token {
            value,
            source: Source::File,
            user: Some(user.to_owned()),
        });
    }
    keyring_get(host, user).map(|value| Token {
        value,
        source: Source::Keyring,
        user: Some(user.to_owned()),
    })
}

/// Keeps `token` for `user` on `host` and makes that account the active one.
/// Returns where it went.
pub fn store(config: &mut Config, host: &Host, user: &str, token: &str, insecure: bool) -> Source {
    let source = if !insecure && keyring_set(&host.name, user, token).is_ok() {
        Source::Keyring
    } else {
        Source::File
    };
    let entry = config
        .hosts
        .entry(host.name.clone())
        .or_insert_with(|| HostConfig {
            site: host.site.clone(),
            api: host.api.clone(),
            ..HostConfig::default()
        });
    entry.site = host.site.clone();
    entry.api = host.api.clone();
    entry.user = Some(user.to_owned());
    entry.users.insert(
        user.to_owned(),
        UserConfig {
            token: (source == Source::File).then(|| token.to_owned()),
        },
    );
    if config.default_host.is_none() {
        config.default_host = Some(host.name.clone());
    }
    source
}

/// Forgets `user` on `host`; the next account there, if any, becomes active.
pub fn forget(config: &mut Config, host: &str, user: &str) {
    keyring_delete(host, user);
    let Some(entry) = config.hosts.get_mut(host) else {
        return;
    };
    entry.users.remove(user);
    if entry.user.as_deref() == Some(user) {
        entry.user = entry.users.keys().next().cloned();
    }
    if entry.users.is_empty() {
        config.hosts.remove(host);
        if config.default_host.as_deref() == Some(host) {
            config.default_host = config.hosts.keys().next().cloned();
        }
    }
}

/// Every account's token on `host`, for `auth status`.
pub fn accounts(config: &Config, host: &str) -> Vec<(String, Option<Token>, bool)> {
    let Some(entry) = config.host(host) else {
        return Vec::new();
    };
    entry
        .users
        .iter()
        .map(|(user, u)| {
            (
                user.clone(),
                stored_token(host, user, Some(u)),
                entry.user.as_deref() == Some(user),
            )
        })
        .collect()
}

/// The token `g1t push` signs in to a registry with, when one is stored for
/// its host.
pub fn registry_token(host: &str) -> Option<String> {
    let config = Config::load().ok()?;
    let (name, _) = parse_hostname(host).ok()?;
    let entry = config.host(&name)?;
    let user = entry.user.clone()?;
    stored_token(&name, &user, entry.users.get(&user)).map(|t| t.value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hostnames_take_any_form() {
        assert_eq!(
            parse_hostname("g1t.sh").unwrap(),
            ("g1t.sh".into(), "https://g1t.sh".into())
        );
        assert_eq!(
            parse_hostname("https://Git.Example.com/").unwrap(),
            ("git.example.com".into(), "https://git.example.com".into())
        );
        assert_eq!(
            parse_hostname("http://localhost:8787").unwrap(),
            ("localhost:8787".into(), "http://localhost:8787".into())
        );
        assert!(parse_hostname("ssh://g1t.sh").is_err());
        assert!(parse_hostname("").is_err());
    }

    #[test]
    fn file_tokens_are_kept_and_forgotten() {
        // SAFETY: tests that touch G1T_KEYRING all set it to off.
        unsafe { std::env::set_var("G1T_KEYRING", "off") };
        let mut config = Config::default();
        let host = Host::hosted();
        assert_eq!(
            store(&mut config, &host, "ana", "g1t_a", false),
            Source::File
        );
        store(&mut config, &host, "bo", "g1t_b", true);
        assert_eq!(config.host("g1t.sh").unwrap().user.as_deref(), Some("bo"));
        let t = stored_token(
            "g1t.sh",
            "ana",
            config.host("g1t.sh").unwrap().users.get("ana"),
        )
        .unwrap();
        assert_eq!((t.value.as_str(), t.source), ("g1t_a", Source::File));
        forget(&mut config, "g1t.sh", "bo");
        assert_eq!(config.host("g1t.sh").unwrap().user.as_deref(), Some("ana"));
        forget(&mut config, "g1t.sh", "ana");
        assert!(config.hosts.is_empty());
        assert_eq!(config.default_host, None);
    }
}
