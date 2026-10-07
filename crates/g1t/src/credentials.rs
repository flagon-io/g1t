//! Where the push's g1t token comes from: `G1T_TOKEN`, `--token-stdin`, or
//! what `docker login` stored.

use base64::Engine as _;
use serde_json::Value;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};

/// A username and a g1t token, for the registry's token endpoint.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Credentials {
    pub username: String,
    pub secret: String,
}

/// Any username will do with a token; this is the one g1t sends.
const USERNAME: &str = "g1t";

pub fn find(host: &str, token_stdin: bool) -> Result<Credentials, String> {
    if token_stdin {
        let mut token = String::new();
        std::io::stdin()
            .read_to_string(&mut token)
            .map_err(|e| format!("Could not read the token from stdin: {e}"))?;
        return token_credentials(token.trim())
            .ok_or_else(|| "--token-stdin read an empty token.".to_owned());
    }
    if let Some(credentials) = std::env::var("G1T_TOKEN")
        .ok()
        .and_then(|t| token_credentials(t.trim()))
    {
        return Ok(credentials);
    }
    let config = docker_config_path().and_then(|path| std::fs::read_to_string(path).ok());
    if let Some(found) = config.and_then(|config| from_docker_config(&config, host, &run_helper)) {
        return Ok(found);
    }
    Err(format!(
        "No token for {host}. Set G1T_TOKEN, pass one with --token-stdin, or sign in with `docker login {host}`."
    ))
}

fn token_credentials(token: &str) -> Option<Credentials> {
    (!token.is_empty()).then(|| Credentials {
        username: USERNAME.to_owned(),
        secret: token.to_owned(),
    })
}

fn docker_config_path() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("DOCKER_CONFIG") {
        return Some(PathBuf::from(dir).join("config.json"));
    }
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(home).join(".docker").join("config.json"))
}

/// Looks `host` up in a docker `config.json` the way docker does: its own
/// credential helper first, then the credential store, then a plain `auth`.
/// `helper` runs `docker-credential-<name> get`.
pub fn from_docker_config(
    config: &str,
    host: &str,
    helper: &dyn Fn(&str, &str) -> Option<Credentials>,
) -> Option<Credentials> {
    let config: Value = serde_json::from_str(config).ok()?;
    let servers = [host.to_owned(), format!("https://{host}")];
    if let Some(name) = config
        .get("credHelpers")
        .and_then(|h| h.get(host))
        .and_then(Value::as_str)
    {
        return servers.iter().find_map(|server| helper(name, server));
    }
    if let Some(name) = config
        .get("credsStore")
        .and_then(Value::as_str)
        .filter(|n| !n.is_empty())
        && let Some(found) = servers.iter().find_map(|server| helper(name, server))
    {
        return Some(found);
    }
    let auths = config.get("auths")?.as_object()?;
    auths
        .iter()
        .find(|(key, _)| server_host(key) == host)
        .and_then(|(_, entry)| {
            let auth = entry.get("auth")?.as_str()?;
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(auth.trim())
                .ok()?;
            let decoded = String::from_utf8(decoded).ok()?;
            let (username, secret) = decoded.split_once(':')?;
            (!secret.is_empty()).then(|| Credentials {
                username: username.to_owned(),
                secret: secret.to_owned(),
            })
        })
}

/// `https://g1t.sh/v2/` and `g1t.sh` are the same server.
fn server_host(key: &str) -> &str {
    let key = key
        .strip_prefix("https://")
        .or_else(|| key.strip_prefix("http://"))
        .unwrap_or(key);
    key.split('/').next().unwrap_or(key)
}

/// `docker-credential-<name> get`, with the server on stdin.
fn run_helper(name: &str, server: &str) -> Option<Credentials> {
    let mut child = Command::new(format!("docker-credential-{name}"))
        .arg("get")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    child.stdin.take()?.write_all(server.as_bytes()).ok()?;
    let output = child.wait_with_output().ok()?;
    if !output.status.success() {
        return None;
    }
    parse_helper_output(&output.stdout)
}

pub fn parse_helper_output(stdout: &[u8]) -> Option<Credentials> {
    let found: Value = serde_json::from_slice(stdout).ok()?;
    let secret = found.get("Secret")?.as_str()?.to_owned();
    let username = found
        .get("Username")
        .and_then(Value::as_str)
        .unwrap_or(USERNAME)
        .to_owned();
    (!secret.is_empty()).then_some(Credentials { username, secret })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn no_helper(_: &str, _: &str) -> Option<Credentials> {
        None
    }

    fn creds(user: &str, secret: &str) -> Credentials {
        Credentials {
            username: user.into(),
            secret: secret.into(),
        }
    }

    #[test]
    fn a_plain_auth_entry_is_decoded() {
        // "syntaqx:g1t_secret"
        let config = r#"{"auths":{"g1t.sh":{"auth":"c3ludGFxeDpnMXRfc2VjcmV0"}}}"#;
        assert_eq!(
            from_docker_config(config, "g1t.sh", &no_helper),
            Some(creds("syntaqx", "g1t_secret"))
        );
    }

    #[test]
    fn auth_keys_may_be_urls() {
        let config = r#"{"auths":{"https://g1t.sh/v2/":{"auth":"c3ludGFxeDpnMXRfc2VjcmV0"}}}"#;
        assert_eq!(
            from_docker_config(config, "g1t.sh", &no_helper),
            Some(creds("syntaqx", "g1t_secret"))
        );
        assert_eq!(
            from_docker_config(config, "other.example", &no_helper),
            None
        );
    }

    #[test]
    fn a_credential_store_is_asked_for_the_host() {
        let config = r#"{"auths":{"g1t.sh":{}},"credsStore":"desktop"}"#;
        let asked = RefCell::new(Vec::new());
        let helper = |name: &str, server: &str| {
            asked.borrow_mut().push(format!("{name} {server}"));
            (server == "g1t.sh").then(|| creds("syntaqx", "from-store"))
        };
        assert_eq!(
            from_docker_config(config, "g1t.sh", &helper),
            Some(creds("syntaqx", "from-store"))
        );
        assert_eq!(asked.borrow().as_slice(), ["desktop g1t.sh"]);
    }

    #[test]
    fn a_credential_store_without_the_host_falls_back_to_auths() {
        let config =
            r#"{"auths":{"g1t.sh":{"auth":"c3ludGFxeDpnMXRfc2VjcmV0"}},"credsStore":"desktop"}"#;
        assert_eq!(
            from_docker_config(config, "g1t.sh", &no_helper),
            Some(creds("syntaqx", "g1t_secret"))
        );
    }

    #[test]
    fn a_host_helper_comes_before_the_store() {
        let config = r#"{"credsStore":"desktop","credHelpers":{"g1t.sh":"g1t"}}"#;
        let helper = |name: &str, _: &str| (name == "g1t").then(|| creds("u", "from-helper"));
        assert_eq!(
            from_docker_config(config, "g1t.sh", &helper),
            Some(creds("u", "from-helper"))
        );
    }

    #[test]
    fn nothing_stored_is_none() {
        assert_eq!(
            from_docker_config(r#"{"auths":{}}"#, "g1t.sh", &no_helper),
            None
        );
        assert_eq!(from_docker_config("not json", "g1t.sh", &no_helper), None);
    }

    #[test]
    fn helper_output_is_read() {
        let out = br#"{"ServerURL":"g1t.sh","Username":"syntaqx","Secret":"s"}"#;
        assert_eq!(parse_helper_output(out), Some(creds("syntaqx", "s")));
        assert_eq!(parse_helper_output(b"credentials not found"), None);
    }
}
