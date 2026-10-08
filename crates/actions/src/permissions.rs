//! `permissions:`: what a job's `GITHUB_TOKEN` (g1t's `G1T_TOKEN`) may
//! do, written as on GitHub, at the workflow's top level or on a job, and
//! the g1t scopes each grants.
//!
//! As on GitHub, a job's own `permissions` replace the workflow's; once
//! either is written, every permission it leaves out is `none`, except
//! `metadata`, which is always `read`. `read-all` and `write-all` set every
//! one; `{}` sets none. A workflow that writes neither gets the
//! repository's default: read-only (`contents: read`, `packages: read`),
//! or every permission at `write` where the repository chose that.

use std::collections::BTreeMap;

use serde_json::Value;

/// Every permission GitHub's token has, as workflows name them.
pub const NAMES: [&str; 16] = [
    "actions",
    "attestations",
    "checks",
    "contents",
    "deployments",
    "discussions",
    "id-token",
    "issues",
    "metadata",
    "models",
    "packages",
    "pages",
    "pull-requests",
    "repository-projects",
    "security-events",
    "statuses",
];

/// Permissions g1t has nothing behind: accepted, and they grant nothing.
pub const WITHOUT_EFFECT: [&str; 5] = ["attestations", "discussions", "id-token", "models", "repository-projects"];

/// How much of one permission.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub enum Access {
    #[default]
    None,
    Read,
    Write,
}

impl Access {
    fn parse(text: &str) -> Option<Access> {
        match text.trim().to_ascii_lowercase().as_str() {
            "none" => Some(Access::None),
            "read" => Some(Access::Read),
            "write" => Some(Access::Write),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Access::None => "none",
            Access::Read => "read",
            Access::Write => "write",
        }
    }
}

/// A token's permissions: each name's level; a name left out is `none`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Permissions {
    levels: BTreeMap<&'static str, Access>,
}

/// The repository's choice for workflows that write no `permissions`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TokenDefault {
    /// `contents: read` and `packages: read`: g1t's default.
    #[default]
    Restricted,
    /// Every permission at `write`.
    Permissive,
}

impl TokenDefault {
    pub fn parse(text: &str) -> Option<TokenDefault> {
        match text.trim() {
            "read" | "restricted" => Some(TokenDefault::Restricted),
            "write" | "permissive" => Some(TokenDefault::Permissive),
            _ => None,
        }
    }

    /// As the API names it: `read` or `write`, as GitHub's
    /// `default_workflow_permissions` does.
    pub fn as_str(self) -> &'static str {
        match self {
            TokenDefault::Restricted => "read",
            TokenDefault::Permissive => "write",
        }
    }
}

impl Permissions {
    /// Every permission at `access`.
    pub fn all(access: Access) -> Permissions {
        Permissions { levels: NAMES.iter().map(|name| (*name, access)).collect() }
    }

    /// What a workflow that writes no `permissions` gets.
    pub fn default_for(default: TokenDefault) -> Permissions {
        match default {
            TokenDefault::Permissive => Permissions::all(Access::Write),
            TokenDefault::Restricted => {
                let mut permissions = Permissions::default();
                permissions.set("contents", Access::Read);
                permissions.set("packages", Access::Read);
                permissions
            }
        }
    }

    fn set(&mut self, name: &str, access: Access) {
        if let Some(name) = NAMES.iter().find(|known| **known == name) {
            self.levels.insert(name, access);
        }
    }

    /// One permission's level. `metadata` is always at least `read`.
    pub fn get(&self, name: &str) -> Access {
        let level = self.levels.get(name).copied().unwrap_or_default();
        if name == "metadata" { level.max(Access::Read) } else { level }
    }

    /// The same, with nothing above `read`: a pull request from outside
    /// the repository gets no more, whatever its workflow asks for.
    pub fn read_only(&self) -> Permissions {
        Permissions { levels: self.levels.iter().map(|(name, access)| (*name, (*access).min(Access::Read))).collect() }
    }

    /// Each permission at the lower of this and `cap`: a called workflow's
    /// jobs get no more than the job that calls it.
    pub fn capped_by(&self, cap: &Permissions) -> Permissions {
        Permissions { levels: NAMES.iter().map(|name| (*name, self.get(name).min(cap.get(name)))).collect() }
    }

    /// Each permission and its level, `metadata` included, in name order,
    /// as the run's page and the job's log show them.
    pub fn listed(&self) -> Vec<(&'static str, Access)> {
        NAMES.iter().map(|name| (*name, self.get(name))).collect()
    }

    /// The g1t scopes the token is given, as `resource:level`.
    pub fn scopes(&self) -> Vec<&'static str> {
        let mut scopes: Vec<&'static str> = vec!["repo:read"];
        let mut add = |name: &str, read: &[&'static str], write: &[&'static str]| match self.get(name) {
            Access::None => {}
            Access::Read => scopes.extend_from_slice(read),
            Access::Write => {
                scopes.extend_from_slice(read);
                scopes.extend_from_slice(write);
            }
        };
        add("contents", &["code:read"], &["code:write", "repo:write"]);
        add("pull-requests", &["pull_requests:read"], &["pull_requests:write"]);
        add("issues", &["issues:read"], &["issues:write"]);
        add("actions", &["workflows:read"], &["workflows:write"]);
        add("checks", &["checks:read"], &["checks:write"]);
        add("statuses", &["checks:read"], &["checks:write"]);
        add("deployments", &["deployments:read"], &["deployments:write"]);
        add("pages", &["deployments:read"], &["deployments:write"]);
        add("packages", &["packages:read"], &["packages:write"]);
        add("security-events", &["security:read"], &["security:write"]);
        let mut seen = Vec::new();
        scopes.retain(|scope| {
            let fresh = !seen.contains(scope);
            seen.push(*scope);
            fresh
        });
        scopes
    }
}

/// Reads a `permissions:` value. `Err` names what is wrong with it; the
/// second part of `Ok` lists names it does not know, which grant nothing.
pub fn parse(value: &Value) -> Result<(Permissions, Vec<String>), String> {
    match value {
        Value::String(text) => match text.trim() {
            "read-all" => Ok((Permissions::all(Access::Read), Vec::new())),
            "write-all" => Ok((Permissions::all(Access::Write), Vec::new())),
            other => Err(format!("`permissions: {other}` is not `read-all`, `write-all` or a mapping of permissions to `read`, `write` or `none`.")),
        },
        Value::Object(map) => {
            let mut permissions = Permissions::default();
            let mut unknown = Vec::new();
            for (name, level) in map {
                let Some(access) = level.as_str().and_then(Access::parse) else {
                    return Err(format!("`permissions.{name}` is `read`, `write` or `none`."));
                };
                if NAMES.contains(&name.as_str()) {
                    permissions.set(name, access);
                } else {
                    unknown.push(name.clone());
                }
            }
            Ok((permissions, unknown))
        }
        Value::Null => Ok((Permissions::default(), Vec::new())),
        _ => Err("`permissions` is `read-all`, `write-all` or a mapping of permissions to `read`, `write` or `none`.".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_default_is_read_only() {
        let restricted = Permissions::default_for(TokenDefault::Restricted);
        assert_eq!(restricted.get("contents"), Access::Read);
        assert_eq!(restricted.get("packages"), Access::Read);
        assert_eq!(restricted.get("issues"), Access::None);
        assert_eq!(restricted.get("metadata"), Access::Read);
        assert_eq!(restricted.scopes(), ["repo:read", "code:read", "packages:read"]);
        let permissive = Permissions::default_for(TokenDefault::Permissive);
        assert!(permissive.scopes().contains(&"code:write"));
        assert!(permissive.scopes().contains(&"pull_requests:write"));
        assert_eq!(TokenDefault::parse("write"), Some(TokenDefault::Permissive));
        assert_eq!(TokenDefault::parse("read"), Some(TokenDefault::Restricted));
    }

    #[test]
    fn written_permissions_leave_the_rest_at_none() {
        let (permissions, unknown) = parse(&json!({ "contents": "write", "pull-requests": "write", "issues": "read" })).unwrap();
        assert!(unknown.is_empty());
        assert_eq!(
            permissions.scopes(),
            ["repo:read", "code:read", "code:write", "repo:write", "pull_requests:read", "pull_requests:write", "issues:read"]
        );
        assert_eq!(permissions.get("packages"), Access::None);
        // `{}` is nothing but metadata.
        let (none, _) = parse(&json!({})).unwrap();
        assert_eq!(none.scopes(), ["repo:read"]);
    }

    #[test]
    fn every_permission_has_its_scopes() {
        let (all, _) = parse(&json!("write-all")).unwrap();
        let scopes = all.scopes();
        for scope in [
            "workflows:write", "checks:write", "deployments:write", "packages:write", "security:write", "issues:write",
        ] {
            assert!(scopes.contains(&scope), "{scope}");
        }
        // Statuses and checks are one resource on g1t; each scope once.
        let (statuses, _) = parse(&json!({ "statuses": "write", "checks": "read" })).unwrap();
        assert_eq!(statuses.scopes(), ["repo:read", "checks:read", "checks:write"]);
        // What g1t has nothing behind grants nothing.
        let (oidc, _) = parse(&json!({ "id-token": "write", "discussions": "write" })).unwrap();
        assert_eq!(oidc.scopes(), ["repo:read"]);
    }

    #[test]
    fn outside_pull_requests_read_only() {
        let (permissions, _) = parse(&json!("write-all")).unwrap();
        let capped = permissions.read_only();
        assert!(capped.scopes().iter().all(|scope| scope.ends_with(":read")), "{:?}", capped.scopes());
        assert_eq!(capped.get("contents"), Access::Read);
    }

    #[test]
    fn a_called_workflow_gets_no_more_than_its_caller() {
        let (callee, _) = parse(&json!("write-all")).unwrap();
        let (caller, _) = parse(&json!({ "contents": "write", "issues": "read" })).unwrap();
        let capped = callee.capped_by(&caller);
        assert_eq!(capped.get("contents"), Access::Write);
        assert_eq!(capped.get("issues"), Access::Read);
        assert_eq!(capped.get("pull-requests"), Access::None);
    }

    #[test]
    fn mistakes_and_unknown_names() {
        assert!(parse(&json!("read")).is_err());
        assert!(parse(&json!({ "contents": "admin" })).is_err());
        assert!(parse(&json!(["contents"])).is_err());
        let (_, unknown) = parse(&json!({ "contents": "read", "wiki": "write" })).unwrap();
        assert_eq!(unknown, ["wiki"]);
    }
}
