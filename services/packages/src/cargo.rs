//! What the Cargo registry needs that does not touch the network: crate
//! names, where a crate's index file is, the publish body cargo sends, and
//! the index line each version is.
//!
//! A version keeps its index entry (without `yanked`, which is a column of
//! its own) as its metadata, made once when it is published; the index
//! file is those entries, one JSON line each, oldest first.

use serde_json::{Map, Value, json};

/// The longest crate name crates.io allows.
pub const MAX_NAME: usize = 64;

/// Names Windows keeps for devices: a crate named so could not be checked
/// out of a git index, and cargo refuses them too.
const RESERVED: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3",
    "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Checks crates.io's rules for a crate name: ASCII letters, digits, `-`
/// and `_`, starting with a letter, at most 64 characters.
pub fn valid_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("The crate has no name.".to_owned());
    }
    if name.len() > MAX_NAME {
        return Err(format!("A crate name is at most {MAX_NAME} characters."));
    }
    if !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err(format!("{name} is not a valid crate name: ASCII letters, digits, `-` and `_` only."));
    }
    if !name.as_bytes()[0].is_ascii_alphabetic() {
        return Err(format!("{name} is not a valid crate name: it must start with a letter."));
    }
    if RESERVED.contains(&name.to_ascii_lowercase().as_str()) {
        return Err(format!("{name} is a reserved name."));
    }
    Ok(())
}

/// The name two crates may not share: case and `-` against `_` aside, as
/// crates.io decides whether a name is taken.
pub fn folded(name: &str) -> String {
    name.to_ascii_lowercase().replace('_', "-")
}

/// Where a crate's file is in a sparse index, lowercased: `1/a`, `2/ab`,
/// `3/a/abc`, `se/rd/serde`.
pub fn index_path(name: &str) -> String {
    let name = name.to_ascii_lowercase();
    match name.len() {
        1 => format!("1/{name}"),
        2 => format!("2/{name}"),
        3 => format!("3/{}/{name}", &name[..1]),
        _ => format!("{}/{}/{name}", &name[..2], &name[2..4]),
    }
}

/// The crate an index path names, when it is where that crate's file is.
/// Cargo asks with the lowercased path; any case is taken.
pub fn name_of_index_path(path: &str) -> Option<String> {
    let name = path.rsplit('/').next()?;
    valid_name(name).ok()?;
    (index_path(name) == path.to_ascii_lowercase()).then(|| name.to_owned())
}

/// One of the registry's endpoints, under `/-/cargo/<workspace>/`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CargoRoute {
    /// `index/config.json`.
    Config,
    /// `index/<path>`: a crate's index file.
    Index { name: String },
    /// `api/v1/crates/new`.
    Publish,
    /// `api/v1/crates?q=`: `cargo search`.
    Search,
    Yank { name: String, version: String },
    Unyank { name: String, version: String },
    Download { name: String, version: String },
    Owners { name: String },
}

/// The workspace and endpoint a path is. Names are checked; versions are not.
pub fn route(path: &str) -> Option<(String, CargoRoute)> {
    let rest = path.strip_prefix("/-/cargo/")?;
    let (workspace, rest) = rest.split_once('/')?;
    let workspace = workspace.to_ascii_lowercase();
    if workspace.is_empty() {
        return None;
    }
    if let Some(index) = rest.strip_prefix("index/") {
        if index == "config.json" {
            return Some((workspace, CargoRoute::Config));
        }
        return name_of_index_path(index).map(|name| (workspace, CargoRoute::Index { name }));
    }
    let crates = rest.strip_prefix("api/v1/crates")?;
    if crates.is_empty() || crates == "/" {
        return Some((workspace, CargoRoute::Search));
    }
    let parts: Vec<&str> = crates.strip_prefix('/')?.split('/').collect();
    let named = |name: &str| valid_name(name).is_ok().then(|| name.to_owned());
    let route = match parts.as_slice() {
        ["new"] => CargoRoute::Publish,
        [name, "owners"] => CargoRoute::Owners { name: named(name)? },
        [name, version, action] if !version.is_empty() => {
            let (name, version) = (named(name)?, (*version).to_owned());
            match *action {
                "yank" => CargoRoute::Yank { name, version },
                "unyank" => CargoRoute::Unyank { name, version },
                "download" => CargoRoute::Download { name, version },
                _ => return None,
            }
        }
        _ => return None,
    };
    Some((workspace, route))
}

/// The two parts of `cargo publish`'s body: a little-endian `u32` length
/// and the JSON metadata, then a `u32` length and the `.crate` file.
pub fn parse_publish(body: &[u8]) -> Result<(Value, &[u8]), String> {
    let take = |at: usize| -> Result<(usize, usize), String> {
        let length = body.get(at..at + 4).ok_or("The publish ends early.")?;
        let length = u32::from_le_bytes([length[0], length[1], length[2], length[3]]) as usize;
        let start = at + 4;
        if body.len() < start + length {
            return Err("The publish ends early.".to_owned());
        }
        Ok((start, start + length))
    };
    let (json_start, json_end) = take(0)?;
    let metadata: Value = serde_json::from_slice(&body[json_start..json_end]).map_err(|_| "The publish's metadata is not JSON.")?;
    if !metadata.is_object() {
        return Err("The publish's metadata is not a JSON object.".to_owned());
    }
    let (crate_start, crate_end) = take(json_end)?;
    if crate_end != body.len() {
        return Err("The publish has bytes after the .crate file.".to_owned());
    }
    Ok((metadata, &body[crate_start..crate_end]))
}

/// The version without its build metadata: `1.0.0+abc` is `1.0.0`. Two
/// versions that differ only in it may not both be published.
pub fn without_build(version: &str) -> &str {
    version.split_once('+').map_or(version, |(core, _)| core)
}

/// Whether a feature's list uses the syntax only newer cargo reads
/// (`dep:name`, `name?/feature`), so it belongs in `features2`.
fn new_syntax(values: &Value) -> bool {
    values
        .as_array()
        .is_some_and(|values| values.iter().filter_map(Value::as_str).any(|v| v.starts_with("dep:") || v.contains("?/")))
}

/// A dependency as the index lists it, from how `cargo publish` sends it:
/// `version_req` is `req`, and a renamed one (`explicit_name_in_toml`) is
/// listed by its new name with `package` naming the crate.
fn index_dependency(sent: &Value) -> Result<Value, String> {
    let name = sent["name"].as_str().ok_or("A dependency has no name.")?;
    let req = sent["version_req"].as_str().ok_or_else(|| format!("The dependency {name} has no version requirement."))?;
    let mut dep = Map::new();
    let renamed = sent["explicit_name_in_toml"].as_str().filter(|n| !n.is_empty());
    dep.insert("name".into(), json!(renamed.unwrap_or(name)));
    dep.insert("req".into(), json!(req));
    dep.insert("features".into(), sent.get("features").filter(|f| f.is_array()).cloned().unwrap_or_else(|| json!([])));
    dep.insert("optional".into(), json!(sent["optional"].as_bool().unwrap_or(false)));
    dep.insert("default_features".into(), json!(sent["default_features"].as_bool().unwrap_or(true)));
    dep.insert("target".into(), sent.get("target").filter(|t| t.is_string()).cloned().unwrap_or(Value::Null));
    dep.insert("kind".into(), json!(sent["kind"].as_str().unwrap_or("normal")));
    if let Some(registry) = sent["registry"].as_str() {
        dep.insert("registry".into(), json!(registry));
    }
    if renamed.is_some() {
        dep.insert("package".into(), json!(name));
    }
    Ok(Value::Object(dep))
}

/// A version's index entry, from the publish's metadata and the `.crate`
/// file's SHA-256 in hex. `yanked` is left out: it is added on each read.
pub fn index_entry(metadata: &Value, cksum: &str) -> Result<Value, String> {
    let name = metadata["name"].as_str().ok_or("The publish names no crate.")?;
    let vers = metadata["vers"].as_str().ok_or("The publish names no version.")?;
    let deps = match &metadata["deps"] {
        Value::Null => Vec::new(),
        Value::Array(deps) => deps.iter().map(index_dependency).collect::<Result<Vec<_>, _>>()?,
        _ => return Err("The publish's dependencies are not a list.".to_owned()),
    };
    let (mut features, mut features2) = (Map::new(), Map::new());
    match &metadata["features"] {
        Value::Null => {}
        Value::Object(sent) => {
            for (feature, values) in sent {
                if !values.is_array() {
                    return Err(format!("The feature {feature} is not a list."));
                }
                let into = if new_syntax(values) { &mut features2 } else { &mut features };
                into.insert(feature.clone(), values.clone());
            }
        }
        _ => return Err("The publish's features are not an object.".to_owned()),
    }
    let mut entry = Map::new();
    entry.insert("name".into(), json!(name));
    entry.insert("vers".into(), json!(vers));
    entry.insert("deps".into(), Value::Array(deps));
    entry.insert("cksum".into(), json!(cksum));
    entry.insert("features".into(), Value::Object(features));
    entry.insert("links".into(), metadata.get("links").filter(|l| l.is_string()).cloned().unwrap_or(Value::Null));
    if !features2.is_empty() {
        entry.insert("features2".into(), Value::Object(features2));
        entry.insert("v".into(), json!(2));
    }
    if let Some(rust_version) = metadata["rust_version"].as_str() {
        entry.insert("rust_version".into(), json!(rust_version));
    }
    Ok(Value::Object(entry))
}

/// One line of a crate's index file: the version's entry as kept, with
/// whether it is yanked.
pub fn index_line(entry: &Value, yanked: bool) -> String {
    let mut entry = match entry {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    entry.insert("yanked".into(), json!(yanked));
    Value::Object(entry).to_string()
}

/// What `index/config.json` says: where crates are downloaded from and the
/// web API is, under `base` (`https://g1t.sh/-/cargo/acme`), and whether
/// cargo must send its token for every request.
pub fn config(base: &str, auth_required: bool) -> Value {
    json!({ "dl": format!("{base}/api/v1/crates"), "api": base, "auth-required": auth_required })
}

/// The token in cargo's `Authorization` header, which is the token alone;
/// `Bearer <token>` is taken too.
pub fn token(header: &str) -> Option<&str> {
    let header = header.trim();
    let token = match header.split_once(' ') {
        Some((scheme, rest)) if scheme.eq_ignore_ascii_case("bearer") => rest.trim(),
        Some(_) => return None,
        None => header,
    };
    (!token.is_empty()).then_some(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_follow_crates_io_rules() {
        for good in ["serde", "serde_json", "tokio-util", "a", "A1", "Inflector", &"a".repeat(64)] {
            assert!(valid_name(good).is_ok(), "{good}");
        }
        for bad in ["", "1abc", "-abc", "_abc", "a.b", "a b", "naïve", "a/b", "nul", "COM1", &"a".repeat(65)] {
            assert!(valid_name(bad).is_err(), "{bad}");
        }
        assert_eq!(folded("Serde_Json"), folded("serde-json"), "case and -/_ are one name");
        assert_ne!(folded("serde"), folded("serde-json"));
    }

    #[test]
    fn index_paths_are_the_standard_sparse_ones_in_lowercase() {
        assert_eq!(index_path("a"), "1/a");
        assert_eq!(index_path("ab"), "2/ab");
        assert_eq!(index_path("abc"), "3/a/abc");
        assert_eq!(index_path("serde"), "se/rd/serde");
        assert_eq!(index_path("Inflector"), "in/fl/inflector");
        assert_eq!(index_path("cargo"), "ca/rg/cargo");
        assert_eq!(name_of_index_path("se/rd/serde").as_deref(), Some("serde"));
        assert_eq!(name_of_index_path("3/a/abc").as_deref(), Some("abc"));
        assert_eq!(name_of_index_path("in/fl/Inflector").as_deref(), Some("Inflector"));
        assert_eq!(name_of_index_path("xx/rd/serde"), None, "not where serde's file is");
        assert_eq!(name_of_index_path("3/b/abc"), None);
        assert_eq!(name_of_index_path("1/ab"), None);
        assert_eq!(name_of_index_path("se/rd/se.de"), None);
    }

    #[test]
    fn every_endpoint_is_routed() {
        let at = |route: CargoRoute| Some(("acme".to_owned(), route));
        let nv = |name: &str, version: &str| (name.to_owned(), version.to_owned());
        assert_eq!(route("/-/cargo/acme/index/config.json"), at(CargoRoute::Config));
        assert_eq!(route("/-/cargo/Acme/index/se/rd/serde"), at(CargoRoute::Index { name: "serde".into() }));
        assert_eq!(route("/-/cargo/acme/index/1/a"), at(CargoRoute::Index { name: "a".into() }));
        assert_eq!(route("/-/cargo/acme/api/v1/crates/new"), at(CargoRoute::Publish));
        assert_eq!(route("/-/cargo/acme/api/v1/crates"), at(CargoRoute::Search));
        let (name, version) = nv("serde", "1.0.0");
        assert_eq!(
            route("/-/cargo/acme/api/v1/crates/serde/1.0.0/yank"),
            at(CargoRoute::Yank { name: name.clone(), version: version.clone() })
        );
        assert_eq!(
            route("/-/cargo/acme/api/v1/crates/serde/1.0.0/unyank"),
            at(CargoRoute::Unyank { name: name.clone(), version: version.clone() })
        );
        assert_eq!(route("/-/cargo/acme/api/v1/crates/serde/1.0.0/download"), at(CargoRoute::Download { name, version }));
        assert_eq!(route("/-/cargo/acme/api/v1/crates/serde/owners"), at(CargoRoute::Owners { name: "serde".into() }));
        assert_eq!(route("/-/cargo/acme/api/v1/crates/serde/1.0.0/other"), None);
        assert_eq!(route("/-/cargo/acme/api/v1/crates/se.de/1.0.0/download"), None);
        assert_eq!(route("/-/cargo/acme/index/xx/yy/serde"), None);
        assert_eq!(route("/-/cargo/acme"), None);
        assert_eq!(route("/-/npm/@acme/web"), None);
    }

    fn body(metadata: &[u8], krate: &[u8]) -> Vec<u8> {
        let mut body = (metadata.len() as u32).to_le_bytes().to_vec();
        body.extend_from_slice(metadata);
        body.extend_from_slice(&(krate.len() as u32).to_le_bytes());
        body.extend_from_slice(krate);
        body
    }

    #[test]
    fn the_publish_body_is_two_length_prefixed_parts() {
        let sent = body(br#"{"name":"web","vers":"1.0.0"}"#, b"\x1f\x8bcrate");
        let (metadata, krate) = parse_publish(&sent).unwrap();
        assert_eq!(metadata["name"], "web");
        assert_eq!(krate, b"\x1f\x8bcrate");
        let empty = body(br#"{"name":"web"}"#, b"");
        assert_eq!(parse_publish(&empty).unwrap().1, b"");

        assert!(parse_publish(b"").is_err());
        assert!(parse_publish(&[10, 0, 0, 0, b'{']).is_err(), "shorter than it says");
        assert!(parse_publish(&body(b"not json", b"x")).is_err());
        assert!(parse_publish(&body(b"[1]", b"x")).is_err());
        let mut cut = sent.clone();
        cut.pop();
        assert!(parse_publish(&cut).is_err(), "the crate is cut short");
        let mut long = sent.clone();
        long.push(0);
        assert!(parse_publish(&long).is_err(), "bytes after the crate");
        let no_crate = br#"{"name":"web"}"#;
        let mut half = (no_crate.len() as u32).to_le_bytes().to_vec();
        half.extend_from_slice(no_crate);
        assert!(parse_publish(&half).is_err(), "no crate length");
    }

    #[test]
    fn index_lines_are_cargos_shape() {
        let metadata = json!({
            "name": "Web",
            "vers": "1.2.0",
            "deps": [
                { "name": "serde", "version_req": "^1", "features": ["derive"], "optional": false, "default_features": true, "target": null, "kind": "normal", "registry": "https://github.com/rust-lang/crates.io-index" },
                { "name": "core-lib", "version_req": "=0.3.0", "features": [], "optional": true, "default_features": false, "target": "cfg(unix)", "kind": "normal", "explicit_name_in_toml": "core" },
                { "name": "tempfile", "version_req": "^3", "kind": "dev" }
            ],
            "features": { "default": ["std"], "std": [], "derive": ["dep:core", "serde?/derive"] },
            "links": null,
            "rust_version": "1.75",
            "description": "kept elsewhere",
        });
        let entry = index_entry(&metadata, "ab12").unwrap();
        let line: Value = serde_json::from_str(&index_line(&entry, false)).unwrap();
        assert_eq!(line["name"], "Web");
        assert_eq!(line["vers"], "1.2.0");
        assert_eq!(line["cksum"], "ab12");
        assert_eq!(line["yanked"], false);
        assert_eq!(line["links"], Value::Null);
        assert_eq!(line["rust_version"], "1.75");
        assert!(line.get("description").is_none(), "the index holds what resolving needs");
        assert_eq!(line["features"], json!({ "default": ["std"], "std": [] }));
        assert_eq!(line["features2"], json!({ "derive": ["dep:core", "serde?/derive"] }));
        assert_eq!(line["v"], 2);

        let deps = line["deps"].as_array().unwrap();
        assert_eq!(deps[0]["name"], "serde");
        assert_eq!(deps[0]["req"], "^1");
        assert_eq!(deps[0]["features"], json!(["derive"]));
        assert_eq!(deps[0]["registry"], "https://github.com/rust-lang/crates.io-index");
        assert!(deps[0].get("package").is_none());
        assert_eq!(deps[1]["name"], "core", "a renamed dependency by its new name");
        assert_eq!(deps[1]["package"], "core-lib");
        assert_eq!(deps[1]["optional"], true);
        assert_eq!(deps[1]["default_features"], false);
        assert_eq!(deps[1]["target"], "cfg(unix)");
        assert!(deps[1].get("registry").is_none(), "this registry");
        assert_eq!(deps[2]["kind"], "dev");
        assert_eq!(deps[2]["features"], json!([]));
        assert_eq!(deps[2]["default_features"], true);

        let yanked: Value = serde_json::from_str(&index_line(&entry, true)).unwrap();
        assert_eq!(yanked["yanked"], true);
        assert!(!index_line(&entry, true).contains('\n'), "one line");
    }

    #[test]
    fn a_crate_without_new_feature_syntax_is_index_version_1() {
        let entry = index_entry(&json!({ "name": "a", "vers": "0.1.0", "deps": [], "features": { "x": ["a/b"] }, "links": "z" }), "00").unwrap();
        assert!(entry.get("v").is_none());
        assert!(entry.get("features2").is_none());
        assert_eq!(entry["links"], "z");
        assert!(index_entry(&json!({ "vers": "0.1.0" }), "00").is_err());
        assert!(index_entry(&json!({ "name": "a", "vers": "0.1.0", "deps": [{ "name": "b" }] }), "00").is_err());
        assert!(index_entry(&json!({ "name": "a", "vers": "0.1.0", "features": { "x": "y" } }), "00").is_err());
    }

    #[test]
    fn config_names_the_download_and_api_addresses() {
        let config = config("https://g1t.sh/-/cargo/acme", true);
        assert_eq!(config["dl"], "https://g1t.sh/-/cargo/acme/api/v1/crates");
        assert_eq!(config["api"], "https://g1t.sh/-/cargo/acme");
        assert_eq!(config["auth-required"], true);
    }

    #[test]
    fn the_token_is_the_whole_header() {
        assert_eq!(token("g1t_abc"), Some("g1t_abc"));
        assert_eq!(token(" g1t_abc "), Some("g1t_abc"));
        assert_eq!(token("Bearer g1t_abc"), Some("g1t_abc"));
        assert_eq!(token("Basic YTpi"), None);
        assert_eq!(token(""), None);
        assert_eq!(without_build("1.0.0+build.1"), "1.0.0");
        assert_eq!(without_build("1.0.0-rc.1"), "1.0.0-rc.1");
    }
}
