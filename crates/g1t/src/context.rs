//! What every command starts from: the settings, the host, the repository,
//! and how to print.

use serde_json::Value;

use crate::auth::{self, Host};
use crate::cli::Global;
use crate::client::Client;
use crate::config::Config;
use crate::error::{Error, Result};
use crate::output::Output;
use crate::repo::{self, Repo};

pub struct Ctx {
    pub config: Config,
    pub global: Global,
    pub out: Output,
}

impl Ctx {
    pub fn new(global: Global) -> Result<Ctx> {
        let config = Config::load()?;
        let out = Output::detect(global.json.clone(), global.jq.clone());
        Ok(Ctx { config, global, out })
    }

    /// The host named by --hostname or G1T_HOST, or the default.
    pub fn host(&self) -> Result<Host> {
        auth::resolve(&self.config, self.global.hostname.as_deref())
    }

    pub fn client_for(&self, host: Host) -> Client {
        let token = auth::token(&self.config, &host.name, None).map(|t| t.value);
        Client::new(host, token)
    }

    /// A client for the host commands talk to when no repository is involved.
    pub fn client(&self) -> Result<Client> {
        Ok(self.client_for(self.host()?))
    }

    /// A client that must have a token.
    pub fn signed_in_client(&self) -> Result<Client> {
        let client = self.client()?;
        if !client.has_token() {
            return Err(not_signed_in(&client.host));
        }
        Ok(client)
    }

    /// The hosts a git remote may name: those signed in to, and g1t.sh.
    fn known_hosts(&self) -> Vec<String> {
        let mut hosts: Vec<String> = self.config.hosts.keys().cloned().collect();
        hosts.push(crate::config::DEFAULT_HOST.to_owned());
        if let Some(h) = self.global.hostname.as_deref().or(std::env::var("G1T_HOST").ok().as_deref())
            && let Ok((name, _)) = auth::parse_hostname(h)
        {
            hosts.push(name);
        }
        hosts
    }

    /// The repository: --repo, G1T_REPO, or the git remote.
    pub fn repo(&self) -> Result<Repo> {
        if let Some(flag) = self.global.repo.as_deref().filter(|r| !r.trim().is_empty()) {
            let host = self.host()?;
            return Repo::parse(flag, &host.name);
        }
        let remotes = crate::git::remotes();
        if remotes.is_empty() {
            return Err(Error::usage("Not in a git repository with a g1t remote. Say which repository with --repo OWNER/NAME."));
        }
        match repo::from_remotes(&remotes, &self.known_hosts()) {
            Some((_, found)) => Ok(found),
            None => Err(Error::usage(
                "None of this repository's remotes is on a g1t host you are signed in to. Pass --repo OWNER/NAME, or --hostname for a self-hosted g1t.",
            )),
        }
    }

    /// The repository and a client for its host. A pull request's working
    /// copy (`pulls/<id>`) is resolved to the repository it belongs to.
    pub fn repo_client(&self) -> Result<(Repo, Client)> {
        let repo = self.repo()?;
        let mut host = self.host()?;
        if repo.host != host.name {
            host = auth::resolve(&self.config, Some(&repo.host))?;
        }
        let client = self.client_for(host);
        if let Some(pull_id) = repo.pull_copy() {
            let parent = parent_of_copy(&client, &repo, pull_id)?;
            return Ok((parent, client));
        }
        Ok((repo, client))
    }

    /// The repository this working copy pushes to, and a client for its
    /// host: --repo or G1T_REPO, else the remote named origin. In a clone
    /// of a fork, origin is the fork and upstream the repository it came
    /// from, which `repo` prefers. Falls back to `repo_client`.
    pub fn pushed_repo_client(&self) -> Result<(Repo, Client)> {
        if self.global.repo.as_deref().is_some_and(|r| !r.trim().is_empty()) {
            return self.repo_client();
        }
        let hosts = self.known_hosts();
        let origin = crate::git::remotes()
            .into_iter()
            .filter(|(name, _)| name == "origin")
            .find_map(|(_, url)| repo::parse_remote(&url).filter(|r| hosts.contains(&r.host)));
        match origin {
            Some(found) if found.pull_copy().is_none() => {
                let host = auth::resolve(&self.config, Some(&found.host))?;
                Ok((found, self.client_for(host)))
            }
            _ => self.repo_client(),
        }
    }

    /// The signed-in account's username on the client's host.
    pub fn me(&self, client: &Client) -> Result<String> {
        if let Some(user) = self.config.host(&client.host.name).and_then(|h| h.user.clone())
            && std::env::var_os("G1T_TOKEN").is_none_or(|t| t.is_empty())
        {
            return Ok(user);
        }
        let user = client.op("whoami").send()?;
        user["username"].as_str().map(str::to_owned).ok_or_else(|| Error::failed("The API did not say who you are."))
    }
}

pub fn not_signed_in(host: &Host) -> Error {
    let flag = if host.name == crate::config::DEFAULT_HOST { String::new() } else { format!(" --hostname {}", host.name) };
    Error::auth(format!("Not signed in to {}. Run `g1t auth login{flag}`, or set G1T_TOKEN.", host.name))
}

/// The repository a pull request's working copy was made from.
fn parent_of_copy(client: &Client, copy: &Repo, pull_id: &str) -> Result<Repo> {
    let found = client.op("get_repo").repo(copy).send().map_err(|e| {
        Error::failed(format!(
            "This is pull request {pull_id}'s working copy, and its repository could not be found ({e}). Pass --repo OWNER/NAME."
        ))
    })?;
    let fork_of = &found["fork_of"];
    let parsed = match fork_of {
        Value::String(s) => Repo::parse(s, &copy.host).ok(),
        Value::Object(o) => {
            let owner = o.get("namespace").or_else(|| o.get("owner")).and_then(Value::as_str);
            let name = o.get("name").and_then(Value::as_str);
            owner.zip(name).map(|(owner, name)| Repo { host: copy.host.clone(), owner: owner.into(), name: name.into() })
        }
        _ => None,
    };
    parsed.ok_or_else(|| {
        Error::usage(format!("This is pull request {pull_id}'s working copy; say which repository it is for with --repo OWNER/NAME."))
    })
}
