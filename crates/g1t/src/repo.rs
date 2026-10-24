//! Which repository a command is about: `--repo`, `G1T_REPO`, or the
//! current directory's git remotes.

use std::fmt;

use crate::error::{Error, Result};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Repo {
    pub host: String,
    pub owner: String,
    pub name: String,
}

impl fmt::Display for Repo {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.owner, self.name)
    }
}

/// The namespace pull requests' working copies live under:
/// `https://g1t.sh/pulls/<pull id>.git`.
pub const PULLS: &str = "pulls";

impl Repo {
    /// `owner/name` or `host/owner/name`; a URL works too.
    pub fn parse(input: &str, default_host: &str) -> Result<Repo> {
        if let Some(found) = parse_remote(input) {
            return Ok(found);
        }
        let trimmed = input.trim().trim_end_matches('/').trim_end_matches(".git");
        let parts: Vec<&str> = trimmed.split('/').collect();
        let valid = |s: &&str| !s.is_empty() && !s.contains(char::is_whitespace);
        match parts.as_slice() {
            [owner, name] if valid(owner) && valid(name) => {
                Ok(Repo { host: default_host.to_owned(), owner: (*owner).to_owned(), name: (*name).to_owned() })
            }
            [host, owner, name] if valid(host) && valid(owner) && valid(name) => {
                Ok(Repo { host: host.to_lowercase(), owner: (*owner).to_owned(), name: (*name).to_owned() })
            }
            _ => Err(Error::usage(format!("`{input}` does not name a repository: write it as OWNER/NAME or HOST/OWNER/NAME."))),
        }
    }

    /// The pull request id, when this is a pull request's working copy.
    pub fn pull_copy(&self) -> Option<&str> {
        (self.owner == PULLS).then_some(self.name.as_str())
    }
}

/// A git remote's URL as a repository: `https://host/owner/name(.git)`,
/// `ssh://git@host/owner/name.git` or `git@host:owner/name.git`.
pub fn parse_remote(url: &str) -> Option<Repo> {
    let url = url.trim();
    let (host, path) = if let Some((scheme, rest)) = url.split_once("://") {
        if !matches!(scheme, "http" | "https" | "ssh" | "git") {
            return None;
        }
        let (authority, path) = rest.split_once('/')?;
        let host = authority.rsplit('@').next()?;
        // ssh's port is not part of the host's name; http's is.
        let host = if scheme == "ssh" { host.split(':').next()? } else { host };
        (host, path)
    } else {
        // scp-like: [user@]host:path
        let (left, path) = url.split_once(':')?;
        // C:/code/web is a Windows path, as git reads it too.
        let drive = left.len() == 1 && left.chars().all(|c| c.is_ascii_alphabetic());
        if drive || left.contains('/') || path.starts_with("//") {
            return None;
        }
        (left.rsplit('@').next()?, path)
    };
    let path = path.trim_matches('/').trim_end_matches(".git");
    let mut parts = path.split('/');
    let (owner, name) = (parts.next()?, parts.next()?);
    if parts.next().is_some() || owner.is_empty() || name.is_empty() || host.is_empty() {
        return None;
    }
    Some(Repo { host: host.to_lowercase(), owner: owner.to_owned(), name: name.to_owned() })
}

/// Picks the repository from `remotes` on one of `hosts`: `upstream` first,
/// then `origin`, then the first one listed.
pub fn from_remotes(remotes: &[(String, String)], hosts: &[String]) -> Option<(String, Repo)> {
    let found: Vec<(String, Repo)> = remotes
        .iter()
        .filter_map(|(name, url)| parse_remote(url).map(|r| (name.clone(), r)))
        .filter(|(_, r)| hosts.iter().any(|h| h == &r.host))
        .collect();
    for preferred in ["upstream", "origin"] {
        if let Some(hit) = found.iter().find(|(n, _)| n == preferred) {
            return Some(hit.clone());
        }
    }
    found.into_iter().next()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(host: &str, owner: &str, name: &str) -> Repo {
        Repo { host: host.into(), owner: owner.into(), name: name.into() }
    }

    #[test]
    fn remotes_parse_in_every_form() {
        assert_eq!(parse_remote("https://g1t.sh/acme/web.git"), Some(r("g1t.sh", "acme", "web")));
        assert_eq!(parse_remote("https://ana@g1t.sh/acme/web"), Some(r("g1t.sh", "acme", "web")));
        assert_eq!(parse_remote("http://localhost:8787/acme/web.git"), Some(r("localhost:8787", "acme", "web")));
        assert_eq!(parse_remote("ssh://git@g1t.sh:22/acme/web.git"), Some(r("g1t.sh", "acme", "web")));
        assert_eq!(parse_remote("git@g1t.sh:acme/web.git"), Some(r("g1t.sh", "acme", "web")));
        assert_eq!(parse_remote("https://g1t.sh/acme/web/tree/main"), None);
        assert_eq!(parse_remote("C:/code/web"), None);
        assert_eq!(parse_remote("/srv/git/web.git"), None);
    }

    #[test]
    fn names_parse_with_and_without_a_host() {
        assert_eq!(Repo::parse("acme/web", "g1t.sh").unwrap(), r("g1t.sh", "acme", "web"));
        assert_eq!(Repo::parse("git.example.com/acme/web", "g1t.sh").unwrap(), r("git.example.com", "acme", "web"));
        assert_eq!(Repo::parse("https://g1t.sh/acme/web", "x").unwrap(), r("g1t.sh", "acme", "web"));
        assert!(Repo::parse("web", "g1t.sh").is_err());
        assert!(Repo::parse("a/b/c/d", "g1t.sh").is_err());
    }

    #[test]
    fn upstream_then_origin_then_the_first() {
        let hosts = vec!["g1t.sh".to_owned()];
        let remotes = vec![
            ("mine".to_owned(), "https://g1t.sh/ana/web.git".to_owned()),
            ("origin".to_owned(), "https://g1t.sh/acme/web.git".to_owned()),
            ("gh".to_owned(), "https://example.com/acme/web.git".to_owned()),
        ];
        assert_eq!(from_remotes(&remotes, &hosts).unwrap().1, r("g1t.sh", "acme", "web"));
        let remotes = vec![("mine".to_owned(), "https://g1t.sh/ana/web.git".to_owned())];
        assert_eq!(from_remotes(&remotes, &hosts).unwrap().1, r("g1t.sh", "ana", "web"));
        let remotes = vec![("gh".to_owned(), "https://example.com/acme/web.git".to_owned())];
        assert_eq!(from_remotes(&remotes, &hosts), None);
    }
}
