//! What the RubyGems registry needs that does not touch the network: gem
//! names and versions, the registry's paths, the `Gem::Specification` read
//! from a `.gem` (a tar holding `metadata.gz`), the compact index
//! Bundler reads (`versions`, `info/<gem>` and `names`), and the full
//! index `gem install --source` reads: `specs.4.8.gz` and its latest and
//! pre-release kin, and each version's `quick/Marshal.4.8` specification.
//!
//! A version is keyed by its number and platform as the compact index
//! writes it (`1.0.0`, `1.0.0-x86_64-linux`), and keeps what its index
//! line needs as its metadata, made once when it is pushed.

use serde_json::{Value, json};

use std::cmp::Ordering;

use crate::archive;
use crate::marshal::{self, Value as Ruby};
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
    /// `specs.4.8.gz`, `latest_specs.4.8.gz` or `prerelease_specs.4.8.gz`.
    Specs(Specs),
    /// `quick/Marshal.4.8/<name>-<version>[-<platform>].gemspec.rz`: one
    /// version's specification.
    QuickSpec { stem: String },
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
        "specs.4.8.gz" => GemRoute::Specs(Specs::Released),
        "latest_specs.4.8.gz" => GemRoute::Specs(Specs::Latest),
        "prerelease_specs.4.8.gz" => GemRoute::Specs(Specs::Prerelease),
        other => {
            if let Some(file) = other.strip_prefix("quick/Marshal.4.8/") {
                let stem = file.strip_suffix(".gemspec.rz")?;
                if stem.contains('/') || candidates(stem).is_empty() {
                    return None;
                }
                return Some((workspace, GemRoute::QuickSpec { stem: stem.to_owned() }));
            }
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

/// Which of the full index's files: every released version, the highest
/// released version of each gem and platform, or every pre-release.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Specs {
    Released,
    Latest,
    Prerelease,
}

/// A version's parts as `Gem::Version` compares them: `1.0.0.rc1` is
/// `1 0 0 rc 1`, and `1.0.0-beta` is `1.0.0.pre.beta`.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Part {
    Number(u64),
    Word(String),
}

fn parts(version: &str) -> Vec<Part> {
    let version = version.trim().replace('-', ".pre.");
    let mut out = Vec::new();
    for piece in version.split('.') {
        let mut rest = piece;
        while !rest.is_empty() {
            let digits = rest.bytes().next().is_some_and(|b| b.is_ascii_digit());
            let len = rest.bytes().take_while(|b| b.is_ascii_digit() == digits).count();
            let (run, after) = rest.split_at(len);
            out.push(if digits { Part::Number(run.parse().unwrap_or(u64::MAX)) } else { Part::Word(run.to_owned()) });
            rest = after;
        }
    }
    out
}

/// `Gem::Version`'s order: by part, a missing part is 0, and a word (a
/// pre-release) is lower than any number.
pub fn compare(a: &str, b: &str) -> Ordering {
    let (a, b) = (parts(a), parts(b));
    for i in 0..a.len().max(b.len()) {
        let zero = Part::Number(0);
        let (x, y) = (a.get(i).unwrap_or(&zero), b.get(i).unwrap_or(&zero));
        let order = match (x, y) {
            (Part::Number(x), Part::Number(y)) => x.cmp(y),
            (Part::Word(x), Part::Word(y)) => x.cmp(y),
            (Part::Word(_), Part::Number(_)) => Ordering::Less,
            (Part::Number(_), Part::Word(_)) => Ordering::Greater,
        };
        if order != Ordering::Equal {
            return order;
        }
    }
    Ordering::Equal
}

/// One version in the full index: its gem, number and platform.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tuple {
    pub name: String,
    pub number: String,
    pub platform: String,
}

impl Tuple {
    /// What a version keeps says its number and platform.
    pub fn of(name: &str, key: &str, stored: &Value) -> Tuple {
        let platform = stored["platform"].as_str().filter(|p| !p.is_empty()).unwrap_or("ruby").to_owned();
        let number = stored["number"].as_str().map(str::to_owned).unwrap_or_else(|| {
            key.strip_suffix(&format!("-{platform}")).unwrap_or(key).to_owned()
        });
        Tuple { name: name.to_owned(), number, platform }
    }
}

/// A `Gem::Version`, marshalled as its `marshal_dump`: `[version]`.
fn gem_version(number: &str) -> Ruby {
    Ruby::UserMarshal { class: "Gem::Version".into(), data: Box::new(Ruby::Array(vec![Ruby::str(number)])) }
}

/// A full index file: each version of `tuples` that `which` lists, as
/// `[name, Gem::Version, platform]`, marshalled and gzipped.
pub fn specs_file(which: Specs, tuples: &[Tuple]) -> Vec<u8> {
    let mut chosen: Vec<&Tuple> = match which {
        Specs::Released => tuples.iter().filter(|t| !is_prerelease(&t.number)).collect(),
        Specs::Prerelease => tuples.iter().filter(|t| is_prerelease(&t.number)).collect(),
        Specs::Latest => {
            let mut highest: Vec<&Tuple> = Vec::new();
            for tuple in tuples.iter().filter(|t| !is_prerelease(&t.number)) {
                match highest.iter_mut().find(|h| h.name == tuple.name && h.platform == tuple.platform) {
                    Some(kept) if compare(&tuple.number, &kept.number) == Ordering::Greater => *kept = tuple,
                    Some(_) => {}
                    None => highest.push(tuple),
                }
            }
            highest
        }
    };
    chosen.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| compare(&a.number, &b.number)).then_with(|| a.platform.cmp(&b.platform)));
    let list = chosen
        .into_iter()
        .map(|t| Ruby::Array(vec![Ruby::str(&t.name), gem_version(&t.number), Ruby::str(&t.platform)]))
        .collect();
    archive::gzip(&marshal::dump(&Ruby::Array(list)))
}

/// A `Gem::Requirement` from the index's form (`< 4&>= 2.0`), marshalled
/// as its `marshal_dump`: `[[[op, Gem::Version], ...]]`.
fn gem_requirement(text: Option<&str>) -> Ruby {
    let mut pairs: Vec<Ruby> = text
        .unwrap_or("")
        .split('&')
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .map(|r| {
            let (op, number) = match r.split_once(' ') {
                Some((op, number)) => (op.trim(), number.trim()),
                None => ("=", r),
            };
            Ruby::Array(vec![Ruby::str(op), gem_version(number)])
        })
        .collect();
    if pairs.is_empty() {
        pairs.push(Ruby::Array(vec![Ruby::str(">="), gem_version("0")]));
    }
    Ruby::UserMarshal { class: "Gem::Requirement".into(), data: Box::new(Ruby::Array(vec![Ruby::Array(pairs)])) }
}

/// A `Gem::Platform` (`x86_64-linux` is cpu `x86_64`, os `linux`), or the
/// string `ruby` for a pure-Ruby gem, as RubyGems marshals it.
fn gem_platform(platform: &str) -> Ruby {
    if platform == "ruby" {
        return Ruby::str("ruby");
    }
    let parts: Vec<&str> = platform.splitn(3, '-').collect();
    let (cpu, os, version) = match parts.as_slice() {
        [os] => (None, *os, None),
        [cpu, os] => (Some(*cpu), *os, None),
        [cpu, os, version, ..] => (Some(*cpu), *os, Some(*version)),
        [] => (None, platform, None),
    };
    Ruby::Object {
        class: "Gem::Platform".into(),
        ivars: vec![("@cpu".into(), Ruby::opt(cpu)), ("@os".into(), Ruby::str(os)), ("@version".into(), Ruby::opt(version))],
    }
}

/// A version's `Gem::Specification`, from what it keeps, marshalled as
/// RubyGems' `_dump` writes it and deflated: the `.gemspec.rz` that
/// `gem install` reads before it downloads the gem.
pub fn quick_spec(name: &str, key: &str, stored: &Value, published_at: &str) -> Vec<u8> {
    let tuple = Tuple::of(name, key, stored);
    let text = |key: &str| stored[key].as_str().map(str::trim).filter(|t| !t.is_empty());
    let strings = |key: &str| Ruby::Array(texts(&stored[key]).into_iter().map(Ruby::Str).collect());
    let dependencies = stored["dependencies"]
        .as_array()
        .map(|deps| {
            deps.iter()
                .filter_map(|d| {
                    let name = d["name"].as_str()?;
                    let requirement = gem_requirement(d["requirement"].as_str());
                    Some(Ruby::Object {
                        class: "Gem::Dependency".into(),
                        ivars: vec![
                            ("@name".into(), Ruby::str(name)),
                            ("@requirement".into(), requirement.clone()),
                            ("@type".into(), Ruby::Symbol("runtime".into())),
                            ("@prerelease".into(), Ruby::Bool(false)),
                            ("@version_requirements".into(), requirement),
                        ],
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let mut metadata = Vec::new();
    if let Some(uri) = text("source_code_uri") {
        metadata.push((Ruby::str("source_code_uri"), Ruby::str(uri)));
    }
    let date = published_at.get(..10).filter(|d| d.len() == 10).unwrap_or("1980-01-02");
    // The fields of `Gem::Specification#_dump`, in its order.
    let fields = Ruby::Array(vec![
        Ruby::str(text("rubygems_version").unwrap_or("3.5.0")),
        Ruby::Int(4),
        Ruby::str(&tuple.name),
        gem_version(&tuple.number),
        Ruby::str(date),
        Ruby::str(text("summary").unwrap_or("")),
        gem_requirement(text("ruby")),
        gem_requirement(text("rubygems")),
        Ruby::str(&tuple.platform),
        Ruby::Array(dependencies),
        Ruby::str(""),
        Ruby::Nil,
        strings("authors"),
        Ruby::opt(text("description")),
        Ruby::opt(text("homepage")),
        Ruby::Bool(true),
        gem_platform(&tuple.platform),
        strings("licenses"),
        Ruby::Hash(metadata),
    ]);
    let spec = Ruby::UserDef { class: "Gem::Specification".into(), data: marshal::dump(&fields) };
    miniz_oxide::deflate::compress_to_vec_zlib(&marshal::dump(&spec), 6)
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
        let mut sorted = vec!["1.10.0", "1.0.0", "1.0.0.rc1", "1.0", "1.2.0-beta.1", "1.2.0", "0.9"];
        sorted.sort_by(|a, b| compare(a, b));
        assert_eq!(sorted, ["0.9", "1.0.0.rc1", "1.0.0", "1.0", "1.2.0-beta.1", "1.2.0", "1.10.0"]);
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
        assert_eq!(route("/-/rubygems/acme/specs.4.8.gz"), at(GemRoute::Specs(Specs::Released)));
        assert_eq!(route("/-/rubygems/acme/latest_specs.4.8.gz"), at(GemRoute::Specs(Specs::Latest)));
        assert_eq!(route("/-/rubygems/acme/prerelease_specs.4.8.gz"), at(GemRoute::Specs(Specs::Prerelease)));
        assert_eq!(
            route("/-/rubygems/acme/quick/Marshal.4.8/hello-world-0.1.0.gemspec.rz"),
            at(GemRoute::QuickSpec { stem: "hello-world-0.1.0".into() })
        );
        assert_eq!(route("/-/rubygems/acme/quick/Marshal.4.8/hello.gemspec.rz"), None, "no version");
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

    fn tuples() -> Vec<Tuple> {
        let tuple = |name: &str, number: &str, platform: &str| Tuple { name: name.into(), number: number.into(), platform: platform.into() };
        vec![
            tuple("hello", "0.2.0", "ruby"),
            tuple("hello", "0.10.0", "ruby"),
            tuple("hello", "1.0.0.rc1", "ruby"),
            tuple("hello", "0.10.0", "java"),
            tuple("abc", "1.0.0", "ruby"),
        ]
    }

    #[test]
    fn the_full_index_lists_versions_as_tuples() {
        let file = specs_file(Specs::Latest, &tuples());
        let bytes = archive::gunzip(&file, 1 << 20).unwrap();
        // By name, then version and platform: hello's highest of each.
        let dumped = marshal::dump(&Ruby::Array(vec![
            Ruby::Array(vec![Ruby::str("abc"), gem_version("1.0.0"), Ruby::str("ruby")]),
            Ruby::Array(vec![Ruby::str("hello"), gem_version("0.10.0"), Ruby::str("java")]),
            Ruby::Array(vec![Ruby::str("hello"), gem_version("0.10.0"), Ruby::str("ruby")]),
        ]));
        assert_eq!(bytes, dumped);
        let released = archive::gunzip(&specs_file(Specs::Released, &tuples()), 1 << 20).unwrap();
        assert_eq!(released.windows(5).filter(|w| *w == b"hello").count(), 3, "every released version");
        let pre = archive::gunzip(&specs_file(Specs::Prerelease, &tuples()), 1 << 20).unwrap();
        assert!(pre.windows(9).any(|w| w == b"1.0.0.rc1"));
        assert!(!pre.windows(6).any(|w| w == b"0.10.0"));
    }

    #[test]
    fn a_quick_spec_is_a_deflated_specification() {
        let stored = json!({
            "name": "hello-world", "number": "0.2.0", "platform": "ruby", "summary": "Says hello",
            "authors": ["Ada"], "licenses": ["MIT"], "homepage": "https://g1t.sh/acme/hello-world",
            "dependencies": [{ "name": "rack", "requirement": "< 4&>= 2.0" }], "ruby": ">= 3.0.0", "rubygems": null,
        });
        let rz = quick_spec("hello-world", "0.2.0", &stored, "2026-10-07T01:02:03.000Z");
        let bytes = miniz_oxide::inflate::decompress_to_vec_zlib(&rz).unwrap();
        assert_eq!(&bytes[..3], b"\x04\x08u");
        assert!(bytes.windows(18).any(|w| w == b"Gem::Specification"));
        assert!(bytes.windows(10).any(|w| w == b"2026-10-07"));
        assert!(bytes.windows(15).any(|w| w == b"Gem::Dependency"));
        // A gem built for a platform names it as a Gem::Platform too.
        let native = quick_spec("native", "1.0.0-x86_64-linux", &json!({ "number": "1.0.0", "platform": "x86_64-linux" }), "");
        let bytes = miniz_oxide::inflate::decompress_to_vec_zlib(&native).unwrap();
        assert!(bytes.windows(13).any(|w| w == b"Gem::Platform"));
        assert_eq!(Tuple::of("native", "1.0.0-x86_64-linux", &json!({})).number, "1.0.0-x86_64-linux", "no platform kept: the key");
        assert_eq!(Tuple::of("native", "1.0.0-java", &json!({ "platform": "java" })).number, "1.0.0");
    }

    /// Writes the full index for `tuples()` and a quick spec where a real
    /// Ruby can read them: `G1T_MARSHAL_OUT=<dir> cargo test marshal_files`,
    /// then `ruby -e` over the files (see the RubyGems guide's notes).
    #[test]
    fn marshal_files_for_ruby() {
        let Ok(dir) = std::env::var("G1T_MARSHAL_OUT") else { return };
        let dir = std::path::Path::new(&dir);
        std::fs::write(dir.join("specs.4.8.gz"), specs_file(Specs::Released, &tuples())).unwrap();
        std::fs::write(dir.join("latest_specs.4.8.gz"), specs_file(Specs::Latest, &tuples())).unwrap();
        let stored = json!({
            "name": "hello-world", "number": "0.2.0", "platform": "ruby", "summary": "Says hello", "description": "Says hello.",
            "authors": ["Ada"], "licenses": ["MIT"], "homepage": "https://g1t.sh/acme/hello-world", "source_code_uri": "https://g1t.sh/acme/hello-world",
            "dependencies": [{ "name": "rack", "requirement": "< 4&>= 2.0" }, { "name": "json", "requirement": ">= 0" }], "ruby": ">= 3.0.0",
        });
        std::fs::write(dir.join("hello-world-0.2.0.gemspec.rz"), quick_spec("hello-world", "0.2.0", &stored, "2026-10-07T00:00:00.000Z")).unwrap();
        let native = json!({ "name": "native", "number": "1.0.0", "platform": "x86_64-linux", "dependencies": [] });
        std::fs::write(dir.join("native-1.0.0-x86_64-linux.gemspec.rz"), quick_spec("native", "1.0.0-x86_64-linux", &native, "2026-10-07T00:00:00.000Z")).unwrap();
    }
}
