//! What the npm registry needs that does not touch the network: package
//! names, versions, the integrity of a tarball, the documents npm reads
//! (packuments), and when a version may still be unpublished.
//!
//! A package is `@<workspace>/<name>`: the scope is the workspace. Its
//! versions' `package.json` fields are kept as npm sent them, beside the
//! tarball's digest; the packument is put together from them on each read.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Map, Value, json};
use sha1::Sha1;
use sha2::{Digest as _, Sha512};

/// The longest name npm allows, scope included.
const MAX_NAME: usize = 214;
/// How long after publishing a version anyone who may publish may still
/// unpublish it; after that it takes Admin.
pub const UNPUBLISH_WINDOW_MS: u64 = 72 * 60 * 60 * 1000;
pub const ABBREVIATED: &str = "application/vnd.npm.install-v1+json";

/// A scoped package's name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NpmName {
    /// The scope without `@`: the workspace.
    pub workspace: String,
    pub name: String,
}

impl NpmName {
    /// `@acme/web`.
    pub fn full(&self) -> String {
        format!("@{}/{}", self.workspace, self.name)
    }

    /// The tarball's file name, as npm names it: `web-1.0.0.tgz`.
    pub fn tarball(&self, version: &str) -> String {
        format!("{}-{version}.tgz", self.name)
    }
}

/// Reads `@scope/name` (the `/` as is or as `%2f`) and checks npm's rules:
/// lowercase, URL-safe, not starting with `.` or `_`, at most 214
/// characters. The scope must look like a workspace's slug.
pub fn parse_name(text: &str) -> Result<NpmName, String> {
    let text = text.replace("%2f", "/").replace("%2F", "/");
    let Some(scoped) = text.strip_prefix('@') else {
        return Err(format!(
            "{text} has no scope. Packages on g1t are scoped by workspace: @<workspace>/<name>."
        ));
    };
    let Some((workspace, name)) = scoped.split_once('/') else {
        return Err(format!("{text} is not @<workspace>/<name>."));
    };
    if text.len() > MAX_NAME {
        return Err(format!("A package name is at most {MAX_NAME} characters."));
    }
    let workspace_ok = !workspace.is_empty()
        && workspace.len() <= 39
        && workspace.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !workspace.starts_with('-')
        && !workspace.ends_with('-')
        && !workspace.contains("--");
    if !workspace_ok {
        return Err(format!("@{workspace} is not a workspace."));
    }
    let name_ok = !name.is_empty()
        && !name.starts_with('.')
        && !name.starts_with('_')
        && name.trim() == name
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'.' | b'_' | b'~'));
    if !name_ok {
        return Err(format!(
            "{name} is not a valid package name: lowercase letters, digits, `-`, `.`, `_` and `~`, not starting with `.` or `_`."
        ));
    }
    Ok(NpmName { workspace: workspace.to_owned(), name: name.to_owned() })
}

/// Whether `version` is semver: `MAJOR.MINOR.PATCH`, with an optional
/// `-prerelease` and `+build`, numbers without leading zeros.
pub fn valid_version(version: &str) -> bool {
    let (core, build) = version.split_once('+').map_or((version, None), |(c, b)| (c, Some(b)));
    let (core, pre) = core.split_once('-').map_or((core, None), |(c, p)| (c, Some(p)));
    let ident = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    let number = |part: &str| {
        !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()) && (part == "0" || !part.starts_with('0'))
    };
    let numbers: Vec<&str> = core.split('.').collect();
    numbers.len() == 3
        && numbers.iter().all(|n| number(n))
        && pre.is_none_or(|p| p.split('.').all(|part| ident(part) && (!part.bytes().all(|b| b.is_ascii_digit()) || number(part))))
        && build.is_none_or(|b| b.split('.').all(ident))
        && version.len() <= 256
}

/// A tag's shape: anything npm accepts that is not itself a version.
pub fn valid_tag(tag: &str) -> bool {
    !tag.is_empty()
        && tag.len() <= 128
        && !valid_version(tag)
        && tag.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_'))
}

/// What a tarball is checked and named by: `sha512-<base64>` (`dist.integrity`)
/// and its SHA-1 in hex (`dist.shasum`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Integrity {
    pub integrity: String,
    pub shasum: String,
}

pub fn integrity(bytes: &[u8]) -> Integrity {
    Integrity {
        integrity: format!("sha512-{}", STANDARD.encode(Sha512::digest(bytes))),
        shasum: hex::encode(Sha1::digest(bytes)),
    }
}

/// Whether what a client says about the tarball agrees with the tarball.
/// What it leaves out is not checked. An `integrity` may list several
/// hashes; the sha512 one must match when there is one.
pub fn agrees(computed: &Integrity, integrity: Option<&str>, shasum: Option<&str>) -> bool {
    let integrity_ok = match integrity {
        None => true,
        Some(given) => {
            let sha512: Vec<&str> = given.split_whitespace().filter(|h| h.starts_with("sha512-")).collect();
            sha512.is_empty() || sha512.contains(&computed.integrity.as_str())
        }
    };
    integrity_ok && shasum.is_none_or(|given| given.eq_ignore_ascii_case(&computed.shasum))
}

/// Whether a version published at `published_ms` may be unpublished at
/// `now_ms` by someone who may publish: within 72 hours. Admins may always.
pub fn may_unpublish(published_ms: u64, now_ms: u64, admin: bool) -> bool {
    admin || now_ms.saturating_sub(published_ms) < UNPUBLISH_WINDOW_MS
}

/// The repository a package's `repository` field names, as `(workspace,
/// name)`, when it is on `host`: `git+https://g1t.sh/acme/web.git`,
/// `https://g1t.sh/acme/web`, `{ "url": ... }`.
pub fn repository_of(field: &Value, host: &str) -> Option<(String, String)> {
    let url = match field {
        Value::String(url) => url.as_str(),
        Value::Object(map) => map.get("url")?.as_str()?,
        _ => return None,
    };
    let url = url.trim().trim_start_matches("git+");
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let rest = rest.split_once('@').map_or(rest, |(_, rest)| rest);
    let rest = rest.strip_prefix(host)?;
    let rest = rest.strip_prefix('/').or_else(|| rest.strip_prefix(':'))?;
    let mut parts = rest.trim_end_matches('/').split('/');
    let (workspace, name) = (parts.next()?, parts.next()?);
    let name = name.strip_suffix(".git").unwrap_or(name);
    (!workspace.is_empty() && !name.is_empty()).then(|| (workspace.to_lowercase(), name.to_lowercase()))
}

/// One version as kept: its `package.json` fields as npm sent them (with
/// `dist` holding the integrity), and what the registry adds.
pub struct StoredVersion {
    pub version: String,
    pub manifest: Value,
    pub deprecated: Option<String>,
    pub published_at: String,
}

/// What a packument is made from.
pub struct Packument<'a> {
    pub name: &'a NpmName,
    pub versions: &'a [StoredVersion],
    /// Tag and the version it points to.
    pub tags: &'a [(String, String)],
    pub created: &'a str,
    pub modified: &'a str,
    pub readme: Option<&'a str>,
    /// Where tarballs are: `https://g1t.sh/-/npm`.
    pub base: &'a str,
}

/// The fields npm's abbreviated packument keeps of each version.
const ABBREVIATED_FIELDS: [&str; 16] = [
    "name",
    "version",
    "dependencies",
    "optionalDependencies",
    "devDependencies",
    "bundleDependencies",
    "bundledDependencies",
    "peerDependencies",
    "peerDependenciesMeta",
    "bin",
    "directories",
    "engines",
    "os",
    "cpu",
    "_hasShrinkwrap",
    "hasInstallScript",
];

impl Packument<'_> {
    /// The revision npm sends back when it changes the packument. Any
    /// revision is taken; this one only changes when the package does.
    pub fn rev(&self) -> String {
        let digest = hex::encode(Sha1::digest(self.modified.as_bytes()));
        format!("{}-{}", self.versions.len().max(1), &digest[..16])
    }

    fn version_json(&self, stored: &StoredVersion) -> Value {
        let mut manifest = match &stored.manifest {
            Value::Object(map) => map.clone(),
            _ => Map::new(),
        };
        let full = self.name.full();
        manifest.insert("name".into(), json!(full));
        manifest.insert("version".into(), json!(stored.version));
        manifest.insert("_id".into(), json!(format!("{full}@{}", stored.version)));
        let mut dist = match manifest.remove("dist") {
            Some(Value::Object(dist)) => dist,
            _ => Map::new(),
        };
        dist.insert(
            "tarball".into(),
            json!(format!("{}/{full}/-/{}", self.base, self.name.tarball(&stored.version))),
        );
        manifest.insert("dist".into(), Value::Object(dist));
        match &stored.deprecated {
            Some(message) => {
                manifest.insert("deprecated".into(), json!(message));
            }
            None => {
                manifest.remove("deprecated");
            }
        }
        Value::Object(manifest)
    }

    fn dist_tags(&self) -> Value {
        Value::Object(self.tags.iter().map(|(tag, version)| (tag.clone(), json!(version))).collect())
    }

    /// The whole document, as `npm view` and `npm publish` read it.
    pub fn full(&self) -> Value {
        let mut versions = Map::new();
        let mut time = Map::new();
        time.insert("created".into(), json!(self.created));
        time.insert("modified".into(), json!(self.modified));
        for stored in self.versions {
            versions.insert(stored.version.clone(), self.version_json(stored));
            time.insert(stored.version.clone(), json!(stored.published_at));
        }
        let latest = self
            .tags
            .iter()
            .find(|(tag, _)| tag == "latest")
            .and_then(|(_, v)| self.versions.iter().find(|s| &s.version == v));
        let mut document = json!({
            "_id": self.name.full(),
            "_rev": self.rev(),
            "name": self.name.full(),
            "dist-tags": self.dist_tags(),
            "versions": versions,
            "time": time,
        });
        if let Some(latest) = latest {
            for key in ["description", "keywords", "license", "repository", "homepage", "bugs", "author"] {
                if let Some(value) = latest.manifest.get(key) {
                    document[key] = value.clone();
                }
            }
        }
        if let Some(readme) = self.readme {
            document["readme"] = json!(readme);
        }
        document
    }

    /// What `npm install` asks for: each version's install fields only.
    pub fn abbreviated(&self) -> Value {
        let mut versions = Map::new();
        for stored in self.versions {
            let full = self.version_json(stored);
            let mut kept = Map::new();
            for key in ABBREVIATED_FIELDS.iter().chain(["dist", "deprecated"].iter()) {
                if let Some(value) = full.get(*key) {
                    kept.insert((*key).to_owned(), value.clone());
                }
            }
            versions.insert(stored.version.clone(), Value::Object(kept));
        }
        json!({
            "name": self.name.full(),
            "modified": self.modified,
            "dist-tags": self.dist_tags(),
            "versions": versions,
        })
    }
}

/// A version's `package.json` as kept: without its README (kept once, for
/// the package) and the registry's own fields, with the integrity in `dist`.
pub fn stored_manifest(sent: &Value, computed: &Integrity) -> Value {
    let mut manifest = match sent {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    for key in ["readme", "readmeFilename", "_id", "_rev", "_attachments", "deprecated", "_npmUser", "maintainers"] {
        manifest.remove(key);
    }
    manifest.insert(
        "dist".into(),
        json!({ "integrity": computed.integrity, "shasum": computed.shasum }),
    );
    Value::Object(manifest)
}

/// One of the registry's endpoints, under `/-/npm`. Names are unchecked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NpmRoute {
    Ping,
    Whoami,
    /// `npm login --auth-type=legacy`: `/-/user/org.couchdb.user:<name>`.
    Login,
    DistTags { name: String, tag: Option<String> },
    /// The packument: read, publish, or (with a revision) change.
    Package { name: String, rev: Option<String> },
    Tarball { name: String, file: String, rev: Option<String> },
}

/// Which endpoint a path is. `/-/npm/@acme%2fweb`, `/-/npm/@acme/web`,
/// `/-/npm/@acme/web/-/web-1.0.0.tgz`, `/-/npm/-/package/@acme%2fweb/dist-tags/next`...
pub fn route(path: &str) -> Option<NpmRoute> {
    let rest = path.strip_prefix("/-/npm")?;
    let rest = rest.strip_prefix('/').unwrap_or(rest);
    match rest {
        "-/ping" => return Some(NpmRoute::Ping),
        "-/whoami" => return Some(NpmRoute::Whoami),
        _ => {}
    }
    if rest.starts_with("-/user/org.couchdb.user:") {
        return Some(NpmRoute::Login);
    }
    // The name: `@scope%2fname`, one segment, or `@scope/name`, two.
    let split = |text: &str| -> Option<(String, String)> {
        let lower = text.to_ascii_lowercase();
        if lower.starts_with('@') && !lower.split('/').next()?.contains("%2f") {
            let mut parts = text.splitn(3, '/');
            let (scope, name) = (parts.next()?, parts.next()?);
            Some((format!("{scope}/{name}"), parts.next().unwrap_or("").to_owned()))
        } else {
            let mut parts = text.splitn(2, '/');
            Some((parts.next()?.to_owned(), parts.next().unwrap_or("").to_owned()))
        }
    };
    if let Some(after) = rest.strip_prefix("-/package/") {
        let (name, tail) = split(after)?;
        let tag = match tail.as_str() {
            "dist-tags" => None,
            t => Some(t.strip_prefix("dist-tags/")?.to_owned()).filter(|t| !t.is_empty() && !t.contains('/')),
        };
        if tail != "dist-tags" && tag.is_none() {
            return None;
        }
        return Some(NpmRoute::DistTags { name, tag });
    }
    if rest.starts_with("-/") || rest.is_empty() {
        return None;
    }
    let (name, tail) = split(rest)?;
    if tail.is_empty() {
        return Some(NpmRoute::Package { name, rev: None });
    }
    if let Some(rev) = tail.strip_prefix("-rev/") {
        return Some(NpmRoute::Package { name, rev: Some(rev.to_owned()) });
    }
    let file = tail.strip_prefix("-/")?;
    let (file, rev) = match file.split_once("/-rev/") {
        Some((file, rev)) => (file, Some(rev.to_owned())),
        None => (file, None),
    };
    (file.ends_with(".tgz") && !file.contains('/')).then(|| NpmRoute::Tarball { name, file: file.to_owned(), rev })
}

/// The version a tarball's file name names: `web-1.2.3.tgz` of `web`.
pub fn version_of_file(name: &NpmName, file: &str) -> Option<String> {
    let version = file.strip_prefix(&format!("{}-", name.name))?.strip_suffix(".tgz")?;
    valid_version(version).then(|| version.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_endpoint_is_routed() {
        let package = |name: &str, rev: Option<&str>| Some(NpmRoute::Package { name: name.into(), rev: rev.map(str::to_owned) });
        assert_eq!(route("/-/npm/-/ping"), Some(NpmRoute::Ping));
        assert_eq!(route("/-/npm/-/whoami"), Some(NpmRoute::Whoami));
        assert_eq!(route("/-/npm/-/user/org.couchdb.user:ana"), Some(NpmRoute::Login));
        assert_eq!(route("/-/npm/@acme%2fweb"), package("@acme%2fweb", None));
        assert_eq!(route("/-/npm/@acme%2Fweb"), package("@acme%2Fweb", None));
        assert_eq!(route("/-/npm/@acme/web"), package("@acme/web", None));
        assert_eq!(route("/-/npm/@acme%2fweb/-rev/3-abc"), package("@acme%2fweb", Some("3-abc")));
        assert_eq!(
            route("/-/npm/@acme/web/-/web-1.0.0.tgz"),
            Some(NpmRoute::Tarball { name: "@acme/web".into(), file: "web-1.0.0.tgz".into(), rev: None })
        );
        assert_eq!(
            route("/-/npm/@acme/web/-/web-1.0.0.tgz/-rev/2-x"),
            Some(NpmRoute::Tarball { name: "@acme/web".into(), file: "web-1.0.0.tgz".into(), rev: Some("2-x".into()) })
        );
        assert_eq!(route("/-/npm/-/package/@acme%2fweb/dist-tags"), Some(NpmRoute::DistTags { name: "@acme%2fweb".into(), tag: None }));
        assert_eq!(
            route("/-/npm/-/package/@acme/web/dist-tags/next"),
            Some(NpmRoute::DistTags { name: "@acme/web".into(), tag: Some("next".into()) })
        );
        assert_eq!(route("/-/npm/-/package/@acme/web/other"), None);
        assert_eq!(route("/-/npm/"), None);
        assert_eq!(route("/-/npm/@acme/web/-/notes.txt"), None);
        assert_eq!(route("/v2/acme/web"), None);
        let name = parse_name("@acme/web").unwrap();
        assert_eq!(version_of_file(&name, "web-1.2.3-rc.1.tgz").as_deref(), Some("1.2.3-rc.1"));
        assert_eq!(version_of_file(&name, "other-1.2.3.tgz"), None);
    }

    #[test]
    fn names_are_scoped_by_workspace_and_follow_npms_rules() {
        let name = parse_name("@acme/web-ui").unwrap();
        assert_eq!((name.workspace.as_str(), name.name.as_str()), ("acme", "web-ui"));
        assert_eq!(parse_name("@acme%2fweb").unwrap().full(), "@acme/web");
        assert_eq!(parse_name("@acme%2Fweb.js").unwrap().tarball("1.0.0"), "web.js-1.0.0.tgz");
        assert!(parse_name("web").unwrap_err().contains("scope"));
        assert!(parse_name("@acme").is_err());
        assert!(parse_name("@Acme/web").is_err());
        assert!(parse_name("@acme/Web").is_err());
        assert!(parse_name("@acme/.hidden").is_err());
        assert!(parse_name("@acme/_private").is_err());
        assert!(parse_name("@acme/a b").is_err());
        assert!(parse_name("@acme/a/b").is_err());
        assert!(parse_name(&format!("@acme/{}", "a".repeat(210))).is_err());
    }

    #[test]
    fn versions_are_semver_and_tags_are_not() {
        for good in ["1.0.0", "0.0.1", "10.20.30", "1.0.0-rc.1", "1.0.0-alpha-2.x", "1.0.0+build.5", "1.0.0-0"] {
            assert!(valid_version(good), "{good}");
        }
        for bad in ["1.0", "01.0.0", "1.0.0-", "1.0.0-01", "v1.0.0", "1.0.0+", "a.b.c", ""] {
            assert!(!valid_version(bad), "{bad}");
        }
        assert!(valid_tag("latest"));
        assert!(valid_tag("next-1"));
        assert!(!valid_tag("1.0.0"));
        assert!(!valid_tag("bad tag"));
    }

    #[test]
    fn integrity_is_npms_sha512_and_sha1() {
        let computed = integrity(b"hello");
        assert_eq!(computed.shasum, "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d");
        assert_eq!(
            computed.integrity,
            "sha512-m3HSJL1i83hdltRq0+o9czGb+8KJDKra4t/3JRlnPKcjI8PZm6XBHXx6zG4UuMXaDEZjR1wuXDre9G9zvN7AQw=="
        );
        assert!(agrees(&computed, Some(&computed.integrity), Some("AAF4C61DDCC5E8A2DABEDE0F3B482CD9AEA9434D")));
        assert!(agrees(&computed, None, None));
        assert!(agrees(&computed, Some("sha1-whatever"), None), "only sha512 is checked");
        assert!(!agrees(&computed, Some("sha512-AAAA"), None));
        assert!(!agrees(&computed, None, Some("0000")));
    }

    #[test]
    fn unpublishing_is_open_for_72_hours_then_needs_admin() {
        let hour = 60 * 60 * 1000;
        assert!(may_unpublish(0, 71 * hour, false));
        assert!(!may_unpublish(0, 72 * hour, false));
        assert!(may_unpublish(0, 1000 * hour, true));
    }

    #[test]
    fn a_repository_on_g1t_is_read_from_package_json() {
        let at = |w: &str, n: &str| Some((w.to_owned(), n.to_owned()));
        assert_eq!(repository_of(&json!("git+https://g1t.sh/acme/web.git"), "g1t.sh"), at("acme", "web"));
        assert_eq!(repository_of(&json!({ "type": "git", "url": "https://g1t.sh/Acme/Web" }), "g1t.sh"), at("acme", "web"));
        assert_eq!(repository_of(&json!("git@g1t.sh:acme/web.git"), "g1t.sh"), at("acme", "web"));
        assert_eq!(repository_of(&json!("https://example.com/acme/web"), "g1t.sh"), None);
        assert_eq!(repository_of(&json!("https://g1t.sh/acme"), "g1t.sh"), None);
        assert_eq!(repository_of(&json!(42), "g1t.sh"), None);
    }

    fn stored(version: &str, deprecated: Option<&str>) -> StoredVersion {
        StoredVersion {
            version: version.to_owned(),
            manifest: stored_manifest(
                &json!({ "name": "@acme/web", "version": version, "description": "Web", "dependencies": { "a": "^1" }, "scripts": { "test": "x" }, "readme": "# big" }),
                &integrity(version.as_bytes()),
            ),
            deprecated: deprecated.map(str::to_owned),
            published_at: "2026-10-06T00:00:00.000Z".to_owned(),
        }
    }

    #[test]
    fn the_packument_names_every_version_its_tarball_and_tags() {
        let name = parse_name("@acme/web").unwrap();
        let versions = [stored("1.0.0", None), stored("1.1.0", Some("use 2"))];
        let tags = [("latest".to_owned(), "1.1.0".to_owned())];
        let packument = Packument {
            name: &name,
            versions: &versions,
            tags: &tags,
            created: "2026-10-01T00:00:00.000Z",
            modified: "2026-10-06T00:00:00.000Z",
            readme: Some("# Web"),
            base: "https://g1t.sh/-/npm",
        };
        let full = packument.full();
        assert_eq!(full["name"], "@acme/web");
        assert_eq!(full["dist-tags"]["latest"], "1.1.0");
        assert_eq!(full["description"], "Web");
        assert_eq!(full["readme"], "# Web");
        let v1 = &full["versions"]["1.0.0"];
        assert_eq!(v1["_id"], "@acme/web@1.0.0");
        assert_eq!(v1["dist"]["tarball"], "https://g1t.sh/-/npm/@acme/web/-/web-1.0.0.tgz");
        assert_eq!(v1["dist"]["integrity"], integrity(b"1.0.0").integrity);
        assert!(v1.get("readme").is_none(), "the README is kept once, not per version");
        assert!(v1.get("deprecated").is_none());
        assert_eq!(full["versions"]["1.1.0"]["deprecated"], "use 2");
        assert_eq!(full["time"]["1.0.0"], "2026-10-06T00:00:00.000Z");
        assert!(full["_rev"].as_str().unwrap().starts_with("2-"));

        let short = packument.abbreviated();
        let v1 = &short["versions"]["1.0.0"];
        assert_eq!(v1["dependencies"]["a"], "^1");
        assert!(v1.get("scripts").is_none(), "install fields only");
        assert!(v1.get("description").is_none());
        assert_eq!(v1["dist"]["shasum"], integrity(b"1.0.0").shasum);
        assert_eq!(short["versions"]["1.1.0"]["deprecated"], "use 2");
        assert!(short.get("readme").is_none());
    }
}
