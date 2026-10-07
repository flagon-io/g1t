//! Where this installation is reached: the site, the REST API and the MCP
//! server. Hosted g1t sets none of the variables and gets g1t.sh's
//! addresses; a self-hosted one sets them from its PUBLIC_URL
//! (deploy/self-host/configs.mjs).
//!
//! The MCP server is on its own host hosted (`mcp.g1t.sh`). Self-hosted it
//! can be a path on the API's host instead (`http://localhost:8789/mcp`):
//! a request is for MCP when its host starts with `mcp.`, or when MCP_URL
//! has a path and the request is under it.

use worker::{Env, Url};

pub const HOSTED_SITE: &str = "https://g1t.sh";
pub const HOSTED_API: &str = "https://api.g1t.sh";
pub const HOSTED_MCP: &str = "https://mcp.g1t.sh";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Addresses {
    /// SITE_URL: where people sign in and approve, and where git remotes are.
    pub site: String,
    /// API_URL: the REST API, and the OAuth issuer.
    pub api: String,
    /// MCP_URL: the MCP server, and the OAuth protected resource.
    pub mcp: String,
}

impl Default for Addresses {
    fn default() -> Self {
        Addresses {
            site: HOSTED_SITE.to_owned(),
            api: HOSTED_API.to_owned(),
            mcp: HOSTED_MCP.to_owned(),
        }
    }
}

fn setting(value: Option<String>, default: &str) -> String {
    let value = value.unwrap_or_default();
    let value = value.trim().trim_end_matches('/');
    if value.is_empty() { default.to_owned() } else { value.to_owned() }
}

impl Addresses {
    pub fn from_settings(site: Option<String>, api: Option<String>, mcp: Option<String>) -> Addresses {
        Addresses {
            site: setting(site, HOSTED_SITE),
            api: setting(api, HOSTED_API),
            mcp: setting(mcp, HOSTED_MCP),
        }
    }

    pub fn from_env(env: &Env) -> Addresses {
        let var = |name: &str| env.var(name).ok().map(|value| value.to_string());
        Addresses::from_settings(var("SITE_URL"), var("API_URL"), var("MCP_URL"))
    }

    /// What a client is told when it must sign in first (RFC 9728).
    pub fn mcp_challenge(&self) -> String {
        format!("Bearer resource_metadata=\"{}\"", self.protected_resource())
    }

    /// The protected resource metadata, at the MCP server's origin with
    /// its path appended, as RFC 9728 places it.
    pub fn protected_resource(&self) -> String {
        match Url::parse(&self.mcp) {
            Ok(url) if url.path() != "/" => {
                let origin = url.origin().ascii_serialization();
                format!("{origin}/.well-known/oauth-protected-resource{}", url.path().trim_end_matches('/'))
            }
            _ => format!("{}/.well-known/oauth-protected-resource", self.mcp),
        }
    }

    /// A repository's git remote.
    pub fn git_remote(&self, owner: &str, name: &str) -> String {
        format!("{}/{owner}/{name}.git", self.site)
    }

    /// Whether a request to `url` is for the MCP server, and the path it
    /// asks for there.
    pub fn mcp_path(&self, url: &Url) -> Option<String> {
        if url.host_str().is_some_and(|host| host.starts_with("mcp.")) {
            return Some(url.path().to_owned());
        }
        // By path alone: behind a proxy the host a request names need not
        // be the one people use, and no REST route starts with it.
        let mcp = Url::parse(&self.mcp).ok()?;
        let base = mcp.path().trim_end_matches('/');
        if base.is_empty() {
            return None;
        }
        let rest = url.path().strip_prefix(base)?;
        (rest.is_empty() || rest.starts_with('/')).then(|| if rest.is_empty() { "/".to_owned() } else { rest.to_owned() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosted_is_the_default() {
        let hosted = Addresses::from_settings(None, Some(String::new()), Some("  ".into()));
        assert_eq!(hosted, Addresses::default());
        assert_eq!(
            hosted.mcp_challenge(),
            "Bearer resource_metadata=\"https://mcp.g1t.sh/.well-known/oauth-protected-resource\""
        );
        assert_eq!(hosted.git_remote("acme", "rocket"), "https://g1t.sh/acme/rocket.git");
        let on_mcp = Url::parse("https://mcp.g1t.sh/").unwrap();
        assert_eq!(hosted.mcp_path(&on_mcp).as_deref(), Some("/"));
        let on_api = Url::parse("https://api.g1t.sh/user").unwrap();
        assert_eq!(hosted.mcp_path(&on_api), None);
    }

    #[test]
    fn self_hosted_mcp_is_a_path_on_the_api() {
        let own = Addresses::from_settings(
            Some("http://localhost:8787/".into()),
            Some("http://localhost:8789".into()),
            Some("http://localhost:8789/mcp".into()),
        );
        assert_eq!(own.site, "http://localhost:8787");
        assert_eq!(
            own.protected_resource(),
            "http://localhost:8789/.well-known/oauth-protected-resource/mcp"
        );
        let url = |text: &str| Url::parse(text).unwrap();
        assert_eq!(own.mcp_path(&url("http://localhost:8789/mcp")).as_deref(), Some("/"));
        assert_eq!(own.mcp_path(&url("http://localhost:8789/mcp/")).as_deref(), Some("/"));
        assert_eq!(own.mcp_path(&url("http://localhost:8789/mcpx")), None);
        assert_eq!(own.mcp_path(&url("http://localhost:8789/user")), None);
        assert_eq!(own.mcp_path(&url("http://127.0.0.1:8789/mcp")).as_deref(), Some("/"), "by path, whatever the host");
        assert_eq!(own.git_remote("acme", "rocket"), "http://localhost:8787/acme/rocket.git");
    }
}
