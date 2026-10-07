//! What the RubyGems registry needs that does not touch the network: gem
//! names and versions, the registry's paths, the `Gem::Specification` read
//! from a `.gem` (a tar holding `metadata.gz`), and the compact index
//! Bundler reads: `versions`, `info/<gem>` and `names`.
//!
//! A version is keyed by its number and platform as the compact index
//! writes it (`1.0.0`, `1.0.0-x86_64-linux`), and keeps what its index
//! line needs as its metadata, made once when it is pushed.

use serde_json::{Value, json};

use crate::archive;
use crate::yaml;

/// The longest gem name taken.
pub const MAX_NAME: usize = 128;
/// The largest `metadata.gz`, unpacked, read from a gem.
const MAX_METADATA_BYTES: usize = 4 * 1024 * 1024;

/// A gem's name: letters, digits, `.`, `-` and `_`, with a letter in it.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_NAME
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
        && name.bytes().any(|b| b.is_ascii_alphabetic())
        && name.as_bytes()[0].is_ascii_alphanumeric()
}

/// A version as `Gem::Version` takes it: numbers and words joined by dots,
/// starting with a number (`1.0.0`, `2.0.0.rc1`, `1.0.0-beta.1`).
pub fn valid_version(version: &str) -> bool {
    let (core, suffix) = version.split_once('-').map_or((version, None), |(c, s)| (c, Some(s)));
    let mut parts = core.split('.');
    let first_ok = parts.next().is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
    first_ok
        && version.len() <= 128
        && parts.all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_alphanumeric()))
        && suffix.is_none_or(|s| s.split('.').all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')))
}

/// A version with a letter in it is a pre-release, as RubyGems decides.
pub fn is_prerelease(version: &str) -> bool {
    version.bytes().any(|b| b.is_ascii_alphabetic())
}

/// The version as the index keys it: `1.0.0`, or `1.0.0-java` for a gem
/// built for a platform.
pub fn key(version: &str, platform: &str) -> String {
    if platform.is_empty() || platform == "ruby" { version.to_owned() } else { format!("{version}-{platform}") }
}

/// One of the registry's endpoints, under `/-/rubygems/<workspace>/`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GemRoute {
    /// `versions`: every gem and its versions, for Bundler.
    Versions,
    /// `info/<gem>`: a gem's versions, dependencies and checksums.
    Info { name: String },
    /// `names`: every gem's name.
    Names,
    /// `gems/<name>-<version>[-<platform>].gem`; the name and version are
    /// told apart by the handler, as names may hold `-`.
    Gem { stem: String },
    /// `api/v1/gems`: `gem push`.
    Push,
    /// `api/v1/gems/yank`: `gem yank`.
    Yank,
}

pub fn route(path: &str) -> Option<(String, GemRoute)> {
    let rest = path.strip_prefix("/-/rubygems/")?;
    let (workspace, rest) = rest.split_once('/')?;
    let workspace = workspace.to_ascii_lowercase();
    if workspace.is_empty() {
        return None;
    }
    let route = match rest.trim_end_matches('/') {
        "versions" => GemRoute::Versions,
        "names" => GemRoute::Names,
        "api/v1/gems" => GemRoute::Push,
        "api/v1/gems/yank" => GemRoute::Yank,
        other => {
            if let Some(name) = other.strip_prefix("info/") {
                if !valid_name(name) {
                    return None;
                }
                GemRoute::Info { name: name.to_owned() }
            } else {
                let file = other.strip_prefix("gems/")?;
                let stem = file.strip_suffix(".gem")?;
                if stem.contains('/') || candidates(stem).is_empty() {
                    return None;
                }
                GemRoute::Gem { stem: stem.to_owned() }
            }
        }
    };
    Some((workspace, route))
}

/// The ways a file's stem splits into a name and a version key: at each
/// `-` followed by a digit, longest name last (`a-b-1.0` is `a-b` `1.0`).
pub fn candidates(stem: &str) -> Vec<(String, String)> {
    stem.char_indices()
        .filter(|&(i, c)| c == '-' && stem[i + 1..].starts_with(|n: char| n.is_ascii_digit()))
        .map(|(i, _)| (stem[..i].to_owned(), stem[i + 1..].to_owned()))
        .filter(|(name, _)| valid_name(name))
        .collect()
}

/// What is read from a gem's specification.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Gemspec {
    pub name: String,
    pub version: String,
    pub platform: String,
    pub summary: Option<String>,
    pub description: Option<String>,
    pub homepage: Option<String>,
    pub source_code_uri: Option<String>,
    pub licenses: Vec<String>,
    pub authors: Vec<String>,
    /// Runtime dependencies: name and requirement (`>= 2.0&< 4`).
    pub dependencies: Vec<(String, String)>,
    pub ruby: Option<String>,
    pub rubygems: Option<String>,
}

/// A `Gem::Requirement` as the compact index writes it: `>= 2.0&< 4`.
pub fn requirement(value: &Value) -> String {
    value["requirements"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|pair| {
                    let op = pair.get(0)?.as_str()?;
                    let version = pair.get(1).map(|v| v.get("version").unwrap_or(v)).and_then(Value::as_str)?;
                    Some(format!("{op} {version}"))
                })
                .collect::<Vec<_>>()
                .join("&")
        })
        .unwrap_or_default()
}

/// A requirement that says nothing (`>= 0`), as left out of the index.
fn anything(requirement: &str) -> bool {
    requirement.is_empty() || requirement == ">= 0"
}

fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned)
}

fn texts(value: &Value) -> Vec<String> {
    match value {
        Value::Array(list) => list.iter().filter_map(text).collect(),
        Value::String(_) => text(value).into_iter().collect(),
        _ => Vec::new(),
    }
}

/// Reads a specification RubyGems wrote as YAML.
pub fn read_spec(text_yaml: &str) -> Result<Gemspec, String> {
    let spec = yaml::parse(text_yaml).map_err(|problem| format!("The gem's metadata is not YAML: {problem}"))?;
    if !spec.is_object() {
        return Err("The gem's metadata is not a specification.".to_owned());
    }
    let version = &spec["version"];
    let version = text(version.get("version").unwrap_or(version)).ok_or("The gem's metadata names no version.")?;
    let platform = match &spec["platform"] {
        Value::Object(map) => ["cpu", "os", "version"].iter().filter_map(|k| map.get(*k).and_then(text)).collect::<Vec<_>>().join("-"),
        other => text(other).unwrap_or_else(|| "ruby".to_owned()),
    };
    let dependencies = spec["dependencies"]
        .as_array()
        .map(|deps| {
            deps.iter()
                .filter(|d| d["type"].as_str().is_none_or(|t| t.trim_start_matches(':') == "runtime"))
                .filter_map(|d| {
                    let name = text(&d["name"])?;
                    let req = d.get("requirement").filter(|r| r.is_object()).or_else(|| d.get("version_requirements")).map(requirement).unwrap_or_default();
                    Some((name, if req.is_empty() { ">= 0".to_owned() } else { req }))
                })
                .collect()
        })
        .unwrap_or_default();
    let required = |key: &str| Some(requirement(&spec[key])).filter(|r| !anything(r));
    Ok(Gemspec {
        name: text(&spec["name"]).ok_or("The gem's metadata names no gem.")?,
        version,
        platform: if platform.is_empty() { "ruby".to_owned() } else { platform },
        summary: text(&spec["summary"]),
        description: text(&spec["description"]),
        homepage: text(&spec["homepage"]),
        source_code_uri: text(&spec["metadata"]["source_code_uri"]),
        licenses: texts(&spec["licenses"]),
        authors: texts(&spec["authors"]),
        dependencies,
        ruby: required("required_ruby_version"),
        rubygems: required("required_rubygems_version"),
    })
}

/// Reads a `.gem`: the specification in its `metadata.gz`.
pub fn read_gem(gem: &[u8]) -> Result<Gemspec, String> {
    let files = archive::tar_files(gem).map_err(|_| "The file is not a .gem: it is not a tar archive.".to_owned())?;
    let (_, metadata) = files.iter().find(|(name, _)| name == "metadata.gz").ok_or("The gem has no metadata.gz.")?;
    let yaml = archive::gunzip(metadata, MAX_METADATA_BYTES)?;
    read_spec(&String::from_utf8(yaml).map_err(|_| "The gem's metadata is not UTF-8.".to_owned())?)
}

/// What a version keeps for its index line and the gem's page.
pub fn stored(spec: &Gemspec) -> Value {
    json!({
        "name": spec.name,
        "number": spec.version,
        "platform": spec.platform,
        "summary": spec.summary,
        "description": spec.description,
        "homepage": spec.homepage,
        "source_code_uri": spec.source_code_uri,
        "licenses": spec.licenses,
        "authors": spec.authors,
        "dependencies": spec.dependencies.iter().map(|(name, req)| json!({ "name": name, "requirement": req })).collect::<Vec<_>>(),
        "ruby": spec.ruby,
        "rubygems": spec.rubygems,
    })
}

/// One line of a gem's info file: `1.0.0 rack:>= 2.0&< 4|checksum:<sha256>,ruby:>= 3.0`.
pub fn info_line(key: &str, stored: &Value, checksum: &str) -> String {
    let deps: Vec<String> = stored["dependencies"]
        .as_array()
        .map(|deps| {
            deps.iter()
                .filter_map(|d| Some(format!("{}:{}", d["name"].as_str()?, d["requirement"].as_str().unwrap_or(">= 0"))))
                .collect()
        })
        .unwrap_or_default();
    let mut requirements = vec![format!("checksum:{checksum}")];
    if let Some(ruby) = stored["ruby"].as_str() {
        requirements.push(format!("ruby:{ruby}"));
    }
    if let Some(rubygems) = stored["rubygems"].as_str() {
        requirements.push(format!("rubygems:{rubygems}"));
    }
    format!("{key} {}|{}", deps.join(","), requirements.join(","))
}

/// A gem's info file, from its versions' lines, oldest first.
pub fn info(lines: &[String]) -> String {
    let mut out = String::from("---\n");
    for line in lines {
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// The `versions` file: each gem's versions and its info file's MD5.
pub fn versions_file(created_at: &str, gems: &[(String, Vec<String>, String)]) -> String {
    let mut out = format!("created_at: {created_at}\n---\n");
    for (name, versions, md5) in gems {
        out.push_str(&format!("{name} {} {md5}\n", versions.join(",")));
    }
    out
}

pub fn names_file(names: &[String]) -> String {
    let mut out = String::from("---\n");
    for name in names {
        out.push_str(name);
        out.push('\n');
    }
    out
}

/// A value from a form body or query string (`gem_name=hello&version=1.0`).
pub fn form_value(form: &str, key: &str) -> Option<String> {
    let url = worker::Url::parse(&format!("http://form.invalid/?{form}")).ok()?;
    url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned()).filter(|v| !v.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_versions_follow_rubygems_rules() {
        for good in ["rails", "hello-world", "net_http2", "a1", "Hello.rb"] {
            assert!(valid_name(good), "{good}");
        }
        for bad in ["", "123", "-a", ".a", "a b", "a/b", &"a".repeat(129)] {
            assert!(!valid_name(bad), "{bad}");
        }
        for good in ["1.0.0", "0.1", "2.0.0.rc1", "1.0.0-beta.1", "3"] {
            assert!(valid_version(good), "{good}");
        }
        for bad in ["", "a.1", "1..0", "1.0 0", "1.0-"] {
            assert!(!valid_version(bad), "{bad}");
        }
        assert!(is_prerelease("2.0.0.rc1") && !is_prerelease("2.0.0"));
        assert_eq!(key("1.0.0", "ruby"), "1.0.0");
        assert_eq!(key("1.0.0", "x86_64-linux"), "1.0.0-x86_64-linux");
    }

    #[test]
    fn every_endpoint_is_routed() {
        let at = |route: GemRoute| Some(("acme".to_owned(), route));
        assert_eq!(route("/-/rubygems/Acme/versions"), at(GemRoute::Versions));
        assert_eq!(route("/-/rubygems/acme/names"), at(GemRoute::Names));
        assert_eq!(route("/-/rubygems/acme/info/hello-world"), at(GemRoute::Info { name: "hello-world".into() }));
        assert_eq!(route("/-/rubygems/acme/gems/hello-world-0.1.0.gem"), at(GemRoute::Gem { stem: "hello-world-0.1.0".into() }));
        assert_eq!(route("/-/rubygems/acme/api/v1/gems"), at(GemRoute::Push));
        assert_eq!(route("/-/rubygems/acme/api/v1/gems/yank"), at(GemRoute::Yank));
        assert_eq!(route("/-/rubygems/acme/gems/hello.gem"), None, "no version");
        assert_eq!(route("/-/rubygems/acme/info/a b"), None);
        assert_eq!(route("/-/rubygems/acme/other"), None);
        assert_eq!(route("/-/rubygems/acme"), None);
        assert_eq!(
            candidates("hello-world-0.1.0-x86_64-linux"),
            [("hello-world".to_owned(), "0.1.0-x86_64-linux".to_owned())],
            "x86_64 starts with a letter"
        );
        assert_eq!(candidates("a-2-1.0"), [("a".to_owned(), "2-1.0".to_owned()), ("a-2".to_owned(), "1.0".to_owned())]);
    }

    const SPEC: &str = r#"--- !ruby/object:Gem::Specification
name: hello-world
version: !ruby/object:Gem::Version
  version: 0.2.0
platform: ruby
authors:
- Ada
dependencies:
- !ruby/object:Gem::Dependency
  name: rack
  requirement: !ruby/object:Gem::Requirement
    requirements:
    - - "<"
      - !ruby/object:Gem::Version
        version: '4'
    - - ">="
      - !ruby/object:Gem::Version
        version: '2.0'
  type: :runtime
  prerelease: false
  version_requirements: !ruby/object:Gem::Requirement
    requirements:
    - - "<"
      - !ruby/object:Gem::Version
        version: '4'
- !ruby/object:Gem::Dependency
  name: json
  requirement: !ruby/object:Gem::Requirement
    requirements:
    - - ">="
      - !ruby/object:Gem::Version
        version: '0'
  type: :runtime
- !ruby/object:Gem::Dependency
  name: rspec
  requirement: !ruby/object:Gem::Requirement
    requirements:
    - - "~>"
      - !ruby/object:Gem::Version
        version: '3.0'
  type: :development
description: Says hello.
homepage: https://g1t.sh/acme/hello-world
licenses:
- MIT
metadata:
  source_code_uri: https://g1t.sh/acme/hello-world
required_ruby_version: !ruby/object:Gem::Requirement
  requirements:
  - - ">="
    - !ruby/object:Gem::Version
      version: 3.0.0
required_rubygems_version: !ruby/object:Gem::Requirement
  requirements:
  - - ">="
    - !ruby/object:Gem::Version
      version: '0'
summary: Says hello
"#;

    #[test]
    fn a_gem_is_read_from_its_metadata() {
        let mut gz = vec![0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3];
        gz.extend_from_slice(&miniz_oxide::deflate::compress_to_vec(SPEC.as_bytes(), 6));
        gz.extend_from_slice(&crate::composer::crc32(SPEC.as_bytes()).to_le_bytes());
        gz.extend_from_slice(&(SPEC.len() as u32).to_le_bytes());
        let mut gem = Vec::new();
        for (name, data) in [("metadata.gz", gz.as_slice()), ("data.tar.gz", b"x".as_slice())] {
            let mut header = [0u8; 512];
            header[..name.len()].copy_from_slice(name.as_bytes());
            header[124..136].copy_from_slice(format!("{:011o}\0", data.len()).as_bytes());
            header[156] = b'0';
            gem.extend_from_slice(&header);
            gem.extend_from_slice(data);
            gem.resize(gem.len().div_ceil(512) * 512, 0);
        }
        gem.extend_from_slice(&[0; 1024]);
        let spec = read_gem(&gem).unwrap();
        assert_eq!((spec.name.as_str(), spec.version.as_str(), spec.platform.as_str()), ("hello-world", "0.2.0", "ruby"));
        assert_eq!(spec.dependencies, [("rack".to_owned(), "< 4&>= 2.0".to_owned()), ("json".to_owned(), ">= 0".to_owned())], "runtime only");
        assert_eq!(spec.ruby.as_deref(), Some(">= 3.0.0"));
        assert_eq!(spec.rubygems, None, ">= 0 says nothing");
        assert_eq!(spec.source_code_uri.as_deref(), Some("https://g1t.sh/acme/hello-world"));
        assert_eq!(spec.licenses, ["MIT"]);
        assert!(read_gem(b"not a gem").is_err());

        let line = info_line(&key(&spec.version, &spec.platform), &stored(&spec), "abc123");
        assert_eq!(line, "0.2.0 rack:< 4&>= 2.0,json:>= 0|checksum:abc123,ruby:>= 3.0.0");
        let bare = info_line("1.0.0", &json!({ "dependencies": [] }), "ff");
        assert_eq!(bare, "1.0.0 |checksum:ff");
    }

    #[test]
    fn a_platform_mapping_reads_as_its_name() {
        let spec = read_spec("name: native\nversion: !ruby/object:Gem::Version\n  version: 1.0.0\nplatform: !ruby/object:Gem::Platform\n  cpu: x86_64\n  os: linux\n  version:\n").unwrap();
        assert_eq!(spec.platform, "x86_64-linux");
        assert!(read_spec("name: x\n").is_err(), "no version");
    }

    #[test]
    fn the_compact_index_is_bundlers_shape() {
        let info = info(&["0.1.0 |checksum:aa".to_owned(), "0.2.0 rack:>= 2|checksum:bb".to_owned()]);
        assert_eq!(info, "---\n0.1.0 |checksum:aa\n0.2.0 rack:>= 2|checksum:bb\n");
        let versions = versions_file("2026-10-06T00:00:00Z", &[("hello".into(), vec!["0.1.0".into(), "0.2.0".into()], "d41d8".into())]);
        assert_eq!(versions, "created_at: 2026-10-06T00:00:00Z\n---\nhello 0.1.0,0.2.0 d41d8\n");
        assert_eq!(names_file(&["a".into(), "b".into()]), "---\na\nb\n");
        assert_eq!(form_value("gem_name=hello-world&version=0.1.0&platform=", "gem_name").as_deref(), Some("hello-world"));
        assert_eq!(form_value("gem_name=a%2Bb", "gem_name").as_deref(), Some("a+b"));
        assert_eq!(form_value("version=1", "platform"), None);
    }
}
