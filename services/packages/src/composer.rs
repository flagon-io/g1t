//! What the Composer registry needs that does not touch the network:
//! package names, versions read from tags and branches as Composer reads
//! them, the metadata Composer installs from, `export-ignore`, and zips.
//!
//! A Composer package is not uploaded: it is a repository of the workspace
//! with a `composer.json` at its root. Each tag that reads as a version is a
//! version, and each branch a `dev-` one, with the metadata of that ref's
//! `composer.json`, a git source on g1t.sh, and a zip of the commit as its
//! dist, made when it is first asked for.

use serde_json::{Map, Value, json};

/// Composer's rule for a package name: `vendor/name`, lowercase, words
/// joined by `.`, `_` or `-`.
pub fn valid_name(name: &str) -> bool {
    let Some((vendor, project)) = name.split_once('/') else {
        return false;
    };
    let part = |text: &str, double_dash: bool| {
        let bytes = text.as_bytes();
        if bytes.is_empty() || !bytes[0].is_ascii_alphanumeric() || !bytes[bytes.len() - 1].is_ascii_alphanumeric() {
            return false;
        }
        let mut run = String::new();
        for byte in bytes {
            if byte.is_ascii_lowercase() || byte.is_ascii_digit() {
                if !run.is_empty() && !(run == "." || run == "_" || run == "-" || (double_dash && run == "--")) {
                    return false;
                }
                run.clear();
            } else if matches!(byte, b'.' | b'_' | b'-') {
                run.push(*byte as char);
            } else {
                return false;
            }
        }
        true
    };
    !project.contains('/') && part(vendor, false) && part(project, true) && name.len() <= 200
}

/// A version Composer can install, as Packagist names it: the tag or
/// branch's own `version`, and `version_normalized` to compare by.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Version {
    pub version: String,
    pub normalized: String,
}

impl Version {
    pub fn is_dev(&self) -> bool {
        self.normalized.starts_with("dev-") || self.normalized.ends_with("-dev")
    }
}

/// The stability words Composer reads after a version, as it writes them.
fn stability(word: &str) -> Option<&'static str> {
    match word.to_ascii_lowercase().as_str() {
        "stable" => Some(""),
        "beta" | "b" => Some("beta"),
        "rc" => Some("RC"),
        "alpha" | "a" => Some("alpha"),
        "patch" | "pl" | "p" => Some("patch"),
        _ => None,
    }
}

/// A tag's version, the way Composer's version parser reads it:
/// `v1.2.3`, `1.2`, `1.0.0-beta.2`, `2.0.0-RC1`. Anything else is not a
/// version, and its tag is left out.
pub fn tag_version(tag: &str) -> Option<Version> {
    let text = tag.strip_prefix('v').or_else(|| tag.strip_prefix('V')).unwrap_or(tag);
    let digits_end = text.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(text.len());
    let (numbers, rest) = text.split_at(digits_end);
    let numbers = numbers.trim_end_matches('.');
    let parts: Vec<&str> = numbers.split('.').collect();
    if parts.is_empty() || parts.len() > 4 || parts.iter().any(|p| p.is_empty() || p.len() > 9) {
        return None;
    }
    if numbers.len() != text[..digits_end].len() && !rest.is_empty() {
        // `1.2.` followed by more is not a version.
        return None;
    }
    let mut normalized: Vec<String> = parts.iter().map(|p| p.trim_start_matches('0').to_owned()).map(|p| if p.is_empty() { "0".into() } else { p }).collect();
    while normalized.len() < 4 {
        normalized.push("0".into());
    }
    let mut normalized = normalized.join(".");
    let rest = rest.trim_start_matches(['-', '_', '.']);
    if !rest.is_empty() {
        let (word, tail) = rest.split_at(rest.find(|c: char| !c.is_ascii_alphabetic()).unwrap_or(rest.len()));
        let word = stability(word)?;
        let number = tail.trim_start_matches(['-', '.']);
        let (number, dev) = match number.strip_suffix("dev") {
            Some(n) => (n.trim_end_matches(['-', '.']), true),
            None => (number, false),
        };
        if !number.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
            return None;
        }
        if !word.is_empty() {
            normalized.push('-');
            normalized.push_str(word);
            normalized.push_str(&number.replace('.', ""));
        }
        if dev {
            normalized.push_str("-dev");
        }
    }
    Some(Version { version: tag.to_owned(), normalized })
}

/// A branch's version: `dev-<branch>`, or for a branch named like a
/// version (`1.x`, `2.1`) that version's `-dev`, as Composer reads them.
pub fn branch_version(branch: &str) -> Version {
    let text = branch.strip_prefix('v').unwrap_or(branch);
    let parts: Vec<&str> = text.split('.').collect();
    let numeric = !text.is_empty()
        && parts.len() <= 4
        && parts[0].bytes().all(|b| b.is_ascii_digit())
        && !parts[0].is_empty()
        && parts.iter().all(|p| !p.is_empty() && (p.bytes().all(|b| b.is_ascii_digit()) || matches!(*p, "x" | "X" | "*")));
    if !numeric {
        return Version { version: format!("dev-{branch}"), normalized: format!("dev-{branch}") };
    }
    let mut nines: Vec<String> = parts
        .iter()
        .map(|p| if p.bytes().all(|b| b.is_ascii_digit()) { (*p).to_owned() } else { "9999999".to_owned() })
        .collect();
    while nines.len() < 4 {
        nines.push("9999999".to_owned());
    }
    let version = if parts.last().is_some_and(|p| matches!(*p, "x" | "X" | "*")) {
        format!("{branch}-dev")
    } else {
        format!("{branch}.x-dev")
    };
    Version { version, normalized: format!("{}-dev", nines.join(".")) }
}

/// The fields of `composer.json` a version's metadata keeps, as Packagist
/// serves them.
const KEPT: [&str; 25] = [
    "name",
    "description",
    "keywords",
    "homepage",
    "readme",
    "license",
    "authors",
    "type",
    "support",
    "funding",
    "autoload",
    "autoload-dev",
    "extra",
    "bin",
    "include-path",
    "target-dir",
    "require",
    "require-dev",
    "suggest",
    "provide",
    "replace",
    "conflict",
    "archive",
    "abandoned",
    "notification-url",
];

/// Where one version installs from.
pub struct Origin<'a> {
    /// `https://g1t.sh/acme/lib.git`.
    pub git_url: &'a str,
    /// `https://g1t.sh/-/composer/acme/dist/acme/lib/<commit>.zip`.
    pub dist_url: &'a str,
    pub commit: &'a str,
    /// Set on the default branch's version, as Composer 2 marks it.
    pub default_branch: bool,
}

/// A version's metadata: its `composer.json`, kept fields only, named
/// `name`, with its version, source and dist.
pub fn version_entry(composer: &Value, name: &str, version: &Version, origin: &Origin<'_>) -> Value {
    let mut entry = Map::new();
    if let Value::Object(fields) = composer {
        for key in KEPT {
            if let Some(value) = fields.get(key) {
                entry.insert(key.to_owned(), value.clone());
            }
        }
    }
    // A single license is a list of one, as Packagist writes it.
    if let Some(Value::String(license)) = entry.get("license") {
        let license = license.clone();
        entry.insert("license".into(), json!([license]));
    }
    entry.entry("type").or_insert(json!("library"));
    entry.insert("name".into(), json!(name));
    entry.insert("version".into(), json!(version.version));
    entry.insert("version_normalized".into(), json!(version.normalized));
    entry.insert("source".into(), json!({ "type": "git", "url": origin.git_url, "reference": origin.commit }));
    entry.insert(
        "dist".into(),
        json!({ "type": "zip", "url": origin.dist_url, "reference": origin.commit, "shasum": "" }),
    );
    if origin.default_branch {
        entry.insert("default-branch".into(), json!(true));
    }
    Value::Object(entry)
}

/// `p2/<vendor>/<name>.json`: every version, as Composer reads them
/// (not minified: each entry whole).
pub fn p2(name: &str, versions: &[Value]) -> Value {
    json!({ "packages": { name: versions } })
}

/// `packages.json` of a workspace.
pub fn root(workspace: &str, available: &[String]) -> Value {
    json!({
        "packages": [],
        "metadata-url": format!("/-/composer/{workspace}/p2/%package%.json"),
        "available-packages": available,
        "notify-batch": format!("/-/composer/{workspace}/downloads"),
    })
}

/// Whether `pattern` matches `text`, `*` any run of characters but `/`,
/// `?` any one.
fn glob(pattern: &[u8], text: &[u8]) -> bool {
    match (pattern.first(), text.first()) {
        (None, None) => true,
        (Some(b'*'), _) => {
            glob(&pattern[1..], text) || (!text.is_empty() && text[0] != b'/' && glob(pattern, &text[1..]))
        }
        (Some(b'?'), Some(c)) if *c != b'/' => glob(&pattern[1..], &text[1..]),
        (Some(p), Some(c)) if p == c => glob(&pattern[1..], &text[1..]),
        _ => false,
    }
}

/// The patterns a `.gitattributes` marks `export-ignore`.
pub fn export_ignores(gitattributes: &str) -> Vec<String> {
    gitattributes
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.starts_with('#') {
                return None;
            }
            let mut words = line.split_whitespace();
            let pattern = words.next()?;
            words.any(|attr| attr == "export-ignore").then(|| pattern.to_owned())
        })
        .collect()
}

/// Whether a file is left out of an archive by an `export-ignore`
/// pattern: a pattern without `/` matches a name at any depth, one with a
/// `/` matches from the root, and a directory's pattern everything in it.
pub fn ignored(patterns: &[String], path: &str) -> bool {
    patterns.iter().any(|pattern| {
        let (pattern, dir_only) = match pattern.strip_suffix('/') {
            Some(p) => (p, true),
            None => (pattern.as_str(), false),
        };
        let anchored = pattern.contains('/');
        let pattern = pattern.trim_start_matches('/');
        let parts: Vec<&str> = path.split('/').collect();
        // Each directory the file is in, and (unless only directories
        // match) the file itself.
        let candidates = (1..=parts.len()).filter(|n| !dir_only || *n < parts.len());
        for n in candidates {
            let prefix = parts[..n].join("/");
            let subject = if anchored { prefix.as_str() } else { parts[n - 1] };
            if glob(pattern.as_bytes(), subject.as_bytes()) {
                return true;
            }
        }
        false
    })
}

/// CRC-32, as zip records each file's.
pub(crate) fn crc32(bytes: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (i, entry) in table.iter_mut().enumerate() {
        let mut c = i as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
        }
        *entry = c;
    }
    let mut crc = 0xFFFF_FFFFu32;
    for byte in bytes {
        crc = table[((crc ^ u32::from(*byte)) & 0xFF) as usize] ^ (crc >> 8);
    }
    !crc
}

/// A zip of `files` (path and bytes), deflated where that is smaller. No
/// directory entries, a fixed time, so the same files make the same zip.
pub fn zip(files: &[(String, Vec<u8>)]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (path, data) in files {
        let crc = crc32(data);
        let deflated = miniz_oxide::deflate::compress_to_vec(data, 6);
        let (method, body): (u16, &[u8]) = if deflated.len() < data.len() { (8, &deflated) } else { (0, data) };
        let offset = out.len() as u32;
        let name = path.as_bytes();
        let header = |sig: u32, central_entry: bool| {
            let mut h = Vec::with_capacity(46 + name.len());
            h.extend_from_slice(&sig.to_le_bytes());
            if central_entry {
                h.extend_from_slice(&0x031Eu16.to_le_bytes()); // made by: Unix, 3.0
            }
            h.extend_from_slice(&20u16.to_le_bytes()); // version needed
            h.extend_from_slice(&0x0800u16.to_le_bytes()); // UTF-8 names
            h.extend_from_slice(&method.to_le_bytes());
            h.extend_from_slice(&0u16.to_le_bytes()); // time
            h.extend_from_slice(&0x0021u16.to_le_bytes()); // date: 1980-01-01
            h.extend_from_slice(&crc.to_le_bytes());
            h.extend_from_slice(&(body.len() as u32).to_le_bytes());
            h.extend_from_slice(&(data.len() as u32).to_le_bytes());
            h.extend_from_slice(&(name.len() as u16).to_le_bytes());
            h.extend_from_slice(&0u16.to_le_bytes()); // extra
            if central_entry {
                h.extend_from_slice(&0u16.to_le_bytes()); // comment
                h.extend_from_slice(&0u16.to_le_bytes()); // disk
                h.extend_from_slice(&0u16.to_le_bytes()); // internal attributes
                h.extend_from_slice(&(0o100644u32 << 16).to_le_bytes());
                h.extend_from_slice(&offset.to_le_bytes());
            }
            h.extend_from_slice(name);
            h
        };
        out.extend_from_slice(&header(0x0403_4b50, false));
        out.extend_from_slice(body);
        central.extend_from_slice(&header(0x0201_4b50, true));
    }
    let central_offset = out.len() as u32;
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0, 0, 0, 0]); // disks
    out.extend_from_slice(&(files.len() as u16).to_le_bytes());
    out.extend_from_slice(&(files.len() as u16).to_le_bytes());
    out.extend_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&central_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_follow_composers_rule() {
        for good in ["acme/lib", "acme-co/http.client", "a1/b_2", "acme/my--lib"] {
            assert!(valid_name(good), "{good}");
        }
        for bad in ["acme", "Acme/lib", "acme/lib/x", "-acme/lib", "acme/lib-", "acme/l b", "acme/a..b", "ac--me/lib"] {
            assert!(!valid_name(bad), "{bad}");
        }
    }

    #[test]
    fn tags_read_as_composer_reads_them() {
        let v = |tag: &str| tag_version(tag).map(|v| v.normalized);
        assert_eq!(v("v1.2.3").as_deref(), Some("1.2.3.0"));
        assert_eq!(v("1.2").as_deref(), Some("1.2.0.0"));
        assert_eq!(v("2.0.0-RC1").as_deref(), Some("2.0.0.0-RC1"));
        assert_eq!(v("1.0.0-beta.2").as_deref(), Some("1.0.0.0-beta2"));
        assert_eq!(v("1.0.0-alpha").as_deref(), Some("1.0.0.0-alpha"));
        assert_eq!(v("1.0.0-p1").as_deref(), Some("1.0.0.0-patch1"));
        assert_eq!(v("1.0.0-stable").as_deref(), Some("1.0.0.0"));
        assert_eq!(v("01.02.003").as_deref(), Some("1.2.3.0"));
        assert_eq!(tag_version("v1.0.0").unwrap().version, "v1.0.0", "the tag's own name is the version");
        for bad in ["latest", "release-1", "1.0.0-nope", "1.2.3.4.5", "v", ""] {
            assert_eq!(tag_version(bad), None, "{bad}");
        }
        assert!(!tag_version("1.0.0").unwrap().is_dev());
    }

    #[test]
    fn branches_are_dev_versions() {
        assert_eq!(branch_version("main"), Version { version: "dev-main".into(), normalized: "dev-main".into() });
        assert_eq!(
            branch_version("1.x"),
            Version { version: "1.x-dev".into(), normalized: "1.9999999.9999999.9999999-dev".into() }
        );
        assert_eq!(
            branch_version("2.1"),
            Version { version: "2.1.x-dev".into(), normalized: "2.1.9999999.9999999-dev".into() }
        );
        assert_eq!(branch_version("feature/x").version, "dev-feature/x");
        assert!(branch_version("main").is_dev());
    }

    #[test]
    fn a_versions_metadata_is_its_composer_json_with_where_it_installs_from() {
        let composer = json!({
            "name": "acme/lib",
            "description": "A library",
            "license": "MIT",
            "require": { "php": ">=8.1" },
            "autoload": { "psr-4": { "Acme\\Lib\\": "src/" } },
            "scripts": { "test": "phpunit" },
            "config": { "sort-packages": true },
        });
        let version = tag_version("v1.0.0").unwrap();
        let origin = Origin {
            git_url: "https://g1t.sh/acme/lib.git",
            dist_url: "https://g1t.sh/-/composer/acme/dist/acme/lib/abc.zip",
            commit: "abc",
            default_branch: false,
        };
        let entry = version_entry(&composer, "acme/lib", &version, &origin);
        assert_eq!(entry["version"], "v1.0.0");
        assert_eq!(entry["version_normalized"], "1.0.0.0");
        assert_eq!(entry["license"], json!(["MIT"]));
        assert_eq!(entry["type"], "library");
        assert_eq!(entry["require"]["php"], ">=8.1");
        assert_eq!(entry["autoload"]["psr-4"]["Acme\\Lib\\"], "src/");
        assert_eq!(entry["source"], json!({ "type": "git", "url": "https://g1t.sh/acme/lib.git", "reference": "abc" }));
        assert_eq!(entry["dist"]["type"], "zip");
        assert_eq!(entry["dist"]["reference"], "abc");
        assert!(entry.get("scripts").is_none(), "only what installs");
        assert!(entry.get("config").is_none());
        assert!(entry.get("default-branch").is_none());
        let p2 = p2("acme/lib", &[entry]);
        assert_eq!(p2["packages"]["acme/lib"][0]["version"], "v1.0.0");
        let root = root("acme", &["acme/lib".to_owned()]);
        assert_eq!(root["metadata-url"], "/-/composer/acme/p2/%package%.json");
        assert_eq!(root["available-packages"], json!(["acme/lib"]));
    }

    #[test]
    fn export_ignore_leaves_files_out_as_git_archive_does() {
        let patterns = export_ignores("# dev only\n/tests export-ignore\n.github/ export-ignore\n*.md export-ignore\n/phpunit.xml.dist export-ignore\nsrc/* text\n");
        assert_eq!(patterns, ["/tests", ".github/", "*.md", "/phpunit.xml.dist"]);
        assert!(ignored(&patterns, "tests/LibTest.php"));
        assert!(ignored(&patterns, ".github/workflows/ci.yml"));
        assert!(ignored(&patterns, "README.md"));
        assert!(ignored(&patterns, "docs/guide.md"));
        assert!(ignored(&patterns, "phpunit.xml.dist"));
        assert!(!ignored(&patterns, "src/Lib.php"));
        assert!(!ignored(&patterns, "src/tests/Helper.php"), "/tests is anchored at the root");
        assert!(!ignored(&patterns, "composer.json"));
    }

    #[test]
    fn a_zip_holds_its_files_and_their_checksums() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        let files = vec![
            ("composer.json".to_owned(), br#"{"name":"acme/lib"}"#.to_vec()),
            ("src/Lib.php".to_owned(), "<?php\n".repeat(100).into_bytes()),
        ];
        let zip = zip(&files);
        assert_eq!(&zip[..4], &0x0403_4b50u32.to_le_bytes());
        // The end record counts both files.
        let end = &zip[zip.len() - 22..];
        assert_eq!(&end[..4], &0x0605_4b50u32.to_le_bytes());
        assert_eq!(u16::from_le_bytes([end[10], end[11]]), 2);
        // The repetitive file was deflated, the short one stored.
        assert!(zip.len() < 600, "{}", zip.len());
        assert_eq!(super::zip(&files), zip, "the same files make the same zip");
    }
}
