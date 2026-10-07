//! What the Maven repository needs that does not touch the network: the
//! standard layout's paths (`com/acme/web/1.0.0/web-1.0.0.jar`), the
//! checksum files beside each file, the `maven-metadata.xml` made for each
//! artifact and SNAPSHOT version, Maven's version order, and the few
//! things read from a POM.
//!
//! A package is an artifact, named `groupId:artifactId`. A version holds
//! every file uploaded into its directory, by file name; a SNAPSHOT
//! version holds each build's timestamped files, and its metadata names
//! the newest of each.

use std::cmp::Ordering;

use crate::xml;

/// The checksum files Maven and Gradle upload and ask for beside a file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Checksum {
    Md5,
    Sha1,
    Sha256,
    Sha512,
}

impl Checksum {
    const ALL: [Checksum; 4] = [Checksum::Md5, Checksum::Sha1, Checksum::Sha256, Checksum::Sha512];

    pub fn suffix(self) -> &'static str {
        match self {
            Checksum::Md5 => ".md5",
            Checksum::Sha1 => ".sha1",
            Checksum::Sha256 => ".sha256",
            Checksum::Sha512 => ".sha512",
        }
    }

    /// This checksum of `bytes`, in hex.
    pub fn of(self, bytes: &[u8]) -> String {
        use sha2::Digest as _;
        match self {
            Checksum::Md5 => format!("{:x}", md5::compute(bytes)),
            Checksum::Sha1 => hex::encode(sha1::Sha1::digest(bytes)),
            Checksum::Sha256 => hex::encode(sha2::Sha256::digest(bytes)),
            Checksum::Sha512 => hex::encode(sha2::Sha512::digest(bytes)),
        }
    }

    /// This checksum from the ones kept for a file, and its SHA-256 digest.
    pub fn pick(self, sums: &crate::db::Checksums, sha256: &str) -> String {
        match self {
            Checksum::Md5 => sums.md5.clone(),
            Checksum::Sha1 => sums.sha1.clone(),
            Checksum::Sha256 => sha256.to_owned(),
            Checksum::Sha512 => sums.sha512.clone(),
        }
    }
}

/// A file name without its checksum suffix, and which checksum it is.
pub fn split_checksum(file: &str) -> (&str, Option<Checksum>) {
    for checksum in Checksum::ALL {
        if let Some(base) = file.strip_suffix(checksum.suffix()) {
            return (base, Some(checksum));
        }
    }
    (file, None)
}

/// The hex a checksum file holds: its first word (some tools add the file
/// name after it), in lowercase.
pub fn sent_checksum(body: &[u8]) -> String {
    String::from_utf8_lossy(body).split_whitespace().next().unwrap_or("").to_ascii_lowercase()
}

const METADATA: &str = "maven-metadata.xml";
pub const MAX_PART: usize = 128;

/// One directory of a groupId: `com` and `acme` of `com.acme`.
fn valid_group_part(part: &str) -> bool {
    !part.is_empty() && part.len() <= MAX_PART && part.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

/// An artifactId: letters, digits, `-`, `_` and `.`, not starting with `.`.
pub fn valid_artifact(artifact: &str) -> bool {
    !artifact.is_empty()
        && artifact.len() <= MAX_PART
        && !artifact.starts_with('.')
        && artifact.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

/// A version: letters, digits, `.`, `-`, `_` and `+`, starting with a
/// letter or digit.
pub fn valid_version(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= MAX_PART
        && version.as_bytes()[0].is_ascii_alphanumeric()
        && version.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'+'))
        && version != METADATA
}

pub fn is_snapshot(version: &str) -> bool {
    version.ends_with("-SNAPSHOT")
}

/// The package's name: `com.acme:web`.
pub fn package_name(group: &str, artifact: &str) -> String {
    format!("{group}:{artifact}")
}

/// What a path under `/-/maven/<workspace>/` is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MavenPath {
    /// `com/acme/web/maven-metadata.xml`: an artifact's versions.
    ArtifactMetadata { group: String, artifact: String, checksum: Option<Checksum> },
    /// `com/acme/web/1.0-SNAPSHOT/maven-metadata.xml`: a SNAPSHOT's builds.
    VersionMetadata { group: String, artifact: String, version: String, checksum: Option<Checksum> },
    /// `acme/maven-metadata.xml`: a one-part group's plugins, by prefix.
    /// A deeper group's (`com/acme/plugins/maven-metadata.xml`) reads as an
    /// artifact's, and is answered with the plugins of the group the whole
    /// path names when there is no such artifact.
    GroupMetadata { group: String, checksum: Option<Checksum> },
    /// `com/acme/web/1.0.0/web-1.0.0.jar`: one of a version's files.
    File { group: String, artifact: String, version: String, file: String, checksum: Option<Checksum> },
}

/// The workspace and what the path is. Names and versions are checked,
/// and a file's name has to start with its artifactId.
pub fn route(path: &str) -> Option<(String, MavenPath)> {
    let rest = path.strip_prefix("/-/maven/")?;
    let (workspace, rest) = rest.split_once('/')?;
    let workspace = workspace.to_ascii_lowercase();
    if workspace.is_empty() {
        return None;
    }
    let parts: Vec<&str> = rest.split('/').collect();
    let last = *parts.last()?;
    let (base, checksum) = split_checksum(last);
    let group_of = |parts: &[&str]| -> Option<String> { (!parts.is_empty() && parts.iter().all(|p| valid_group_part(p))).then(|| parts.join(".")) };
    let n = parts.len();
    if base == METADATA {
        if n >= 4 && is_snapshot(parts[n - 2]) && valid_version(parts[n - 2]) && valid_artifact(parts[n - 3])
            && let Some(group) = group_of(&parts[..n - 3]) {
                let (artifact, version) = (parts[n - 3].to_owned(), parts[n - 2].to_owned());
                return Some((workspace, MavenPath::VersionMetadata { group, artifact, version, checksum }));
            }
        if n == 2 && valid_group_part(parts[0]) {
            return Some((workspace, MavenPath::GroupMetadata { group: parts[0].to_owned(), checksum }));
        }
        if n < 3 || !valid_artifact(parts[n - 2]) {
            return None;
        }
        let group = group_of(&parts[..n - 2])?;
        return Some((workspace, MavenPath::ArtifactMetadata { group, artifact: parts[n - 2].to_owned(), checksum }));
    }
    if n < 4 {
        return None;
    }
    let (artifact, version) = (parts[n - 3], parts[n - 2]);
    if !valid_artifact(artifact) || !valid_version(version) {
        return None;
    }
    parse_file(artifact, version, base)?;
    let group = group_of(&parts[..n - 3])?;
    Some((
        workspace,
        MavenPath::File { group, artifact: artifact.to_owned(), version: version.to_owned(), file: base.to_owned(), checksum },
    ))
}

/// What a file's name says: `web-1.0.0-sources.jar` is the `sources`
/// classifier's `jar`; `web-1.0-20261006.120000-3.pom` is build 3 of the
/// SNAPSHOT `1.0-SNAPSHOT`, made at that time (UTC).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileName {
    pub classifier: Option<String>,
    pub extension: String,
    /// For a SNAPSHOT's timestamped file: `20261006.120000` and the build.
    pub build: Option<(String, u32)>,
}

impl FileName {
    /// The version its name holds: the SNAPSHOT's timestamped one.
    pub fn value(&self, version: &str) -> String {
        match &self.build {
            Some((timestamp, build)) => format!("{}-{timestamp}-{build}", version.trim_end_matches("-SNAPSHOT")),
            None => version.to_owned(),
        }
    }
}

/// `20261006.120000-3`: a SNAPSHOT build's time and number.
fn snapshot_build(text: &str) -> Option<(String, u32, usize)> {
    let bytes = text.as_bytes();
    if bytes.len() < 17 || !bytes[..8].iter().all(u8::is_ascii_digit) || bytes[8] != b'.' || !bytes[9..15].iter().all(u8::is_ascii_digit) || bytes[15] != b'-' {
        return None;
    }
    let digits = bytes[16..].iter().take_while(|b| b.is_ascii_digit()).count();
    let build = text[16..16 + digits].parse().ok()?;
    Some((text[..15].to_owned(), build, 16 + digits))
}

pub fn parse_file(artifact: &str, version: &str, file: &str) -> Option<FileName> {
    let rest = file.strip_prefix(artifact)?.strip_prefix('-')?;
    let (after, build) = if let Some(after) = rest.strip_prefix(version) {
        (after, None)
    } else {
        let base = version.strip_suffix("-SNAPSHOT")?;
        let stamped = rest.strip_prefix(base)?.strip_prefix('-')?;
        let (timestamp, build, used) = snapshot_build(stamped)?;
        (&stamped[used..], Some((timestamp, build)))
    };
    let (classifier, extension) = if let Some(ext) = after.strip_prefix('.') {
        (None, ext)
    } else {
        let (classifier, ext) = after.strip_prefix('-')?.split_once('.')?;
        if classifier.is_empty() {
            return None;
        }
        (Some(classifier.to_owned()), ext)
    };
    if extension.is_empty() || extension.contains('/') {
        return None;
    }
    Some(FileName { classifier, extension: extension.to_owned(), build })
}

/// The media type a file is served with.
pub fn media_type(file: &str) -> &'static str {
    let ext = file.rsplit('.').next().unwrap_or("");
    match ext {
        "pom" | "xml" => "application/xml",
        "jar" | "war" | "ear" | "aar" => "application/java-archive",
        "module" | "json" => "application/json",
        "asc" => "application/pgp-signature",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Item {
    /// A qualifier, by its rank, then by name for those Maven does not know.
    Qualifier(u8, String),
    Number(u64),
}

/// Maven's order of the qualifiers it knows; a release (no qualifier) is
/// `ga`, `final` and `release`.
fn rank(word: &str) -> (u8, String) {
    match word {
        "alpha" | "a" => (1, String::new()),
        "beta" | "b" => (2, String::new()),
        "milestone" | "m" => (3, String::new()),
        "rc" | "cr" => (4, String::new()),
        "snapshot" => (5, String::new()),
        "" | "ga" | "final" | "release" => (6, String::new()),
        "sp" => (7, String::new()),
        other => (8, other.to_owned()),
    }
}

fn items(version: &str) -> Vec<Item> {
    let lower = version.to_ascii_lowercase();
    let mut out = Vec::new();
    let mut word = String::new();
    let mut digits: Option<bool> = None;
    let flush = |word: &mut String, out: &mut Vec<Item>, number: bool| {
        if number {
            out.push(Item::Number(word.parse().unwrap_or(u64::MAX)));
        } else {
            let (r, name) = rank(word);
            out.push(Item::Qualifier(r, name));
        }
        word.clear();
    };
    for c in lower.chars() {
        if c == '.' || c == '-' || c == '_' {
            if let Some(number) = digits.take() {
                flush(&mut word, &mut out, number);
            }
            continue;
        }
        let is_digit = c.is_ascii_digit();
        if digits.is_some_and(|d| d != is_digit) {
            flush(&mut word, &mut out, digits.unwrap_or(false));
        }
        digits = Some(is_digit);
        word.push(c);
    }
    if let Some(number) = digits {
        flush(&mut word, &mut out, number);
    }
    // Trailing zeros and releases say nothing: 1.0 is 1 is 1.0.0-ga.
    while matches!(out.last(), Some(Item::Number(0)) | Some(Item::Qualifier(6, _))) {
        out.pop();
    }
    out
}

/// Maven's order of versions: `1.0-alpha` < `1.0-rc1` < `1.0-SNAPSHOT` <
/// `1.0` < `1.0.1` < `1.1`.
pub fn compare(a: &str, b: &str) -> Ordering {
    let (a, b) = (items(a), items(b));
    let missing = |item: &Item| match item {
        Item::Number(n) => (*n).cmp(&0),
        Item::Qualifier(r, _) => r.cmp(&6),
    };
    for i in 0..a.len().max(b.len()) {
        let order = match (a.get(i), b.get(i)) {
            (Some(x), Some(y)) => x.cmp(y),
            (Some(x), None) => missing(x),
            (None, Some(y)) => missing(y).reverse(),
            (None, None) => Ordering::Equal,
        };
        if order != Ordering::Equal {
            return order;
        }
    }
    Ordering::Equal
}

/// `yyyyMMddHHmmss` from an RFC 3339 time, as Maven writes `lastUpdated`.
pub fn last_updated(rfc3339: &str) -> String {
    rfc3339.chars().filter(char::is_ascii_digit).take(14).collect()
}

/// An artifact's `maven-metadata.xml`: its versions in Maven's order, the
/// highest as `latest`, and the highest that is not a SNAPSHOT as `release`.
pub fn artifact_metadata(group: &str, artifact: &str, versions: &[String], updated: &str) -> String {
    let mut sorted: Vec<&String> = versions.iter().collect();
    sorted.sort_by(|a, b| compare(a, b));
    sorted.dedup();
    let latest = sorted.last();
    let release = sorted.iter().rev().find(|v| !is_snapshot(v));
    let mut xml = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<metadata>\n");
    xml.push_str(&format!("  <groupId>{}</groupId>\n  <artifactId>{}</artifactId>\n  <versioning>\n", xml::escape(group), xml::escape(artifact)));
    if let Some(latest) = latest {
        xml.push_str(&format!("    <latest>{}</latest>\n", xml::escape(latest)));
    }
    if let Some(release) = release {
        xml.push_str(&format!("    <release>{}</release>\n", xml::escape(release)));
    }
    xml.push_str("    <versions>\n");
    for version in &sorted {
        xml.push_str(&format!("      <version>{}</version>\n", xml::escape(version)));
    }
    xml.push_str(&format!("    </versions>\n    <lastUpdated>{}</lastUpdated>\n  </versioning>\n</metadata>\n", last_updated(updated)));
    xml
}

/// The newest build among a SNAPSHOT's files: its timestamp and number.
pub fn newest_build(artifact: &str, version: &str, files: &[String]) -> Option<(String, u32)> {
    files
        .iter()
        .filter_map(|file| parse_file(artifact, version, file)?.build)
        .max_by(|a, b| (a.1, &a.0).cmp(&(b.1, &b.0)))
}

/// A SNAPSHOT version's `maven-metadata.xml`, from its files' names: the
/// newest build, and the newest file of each classifier and extension.
pub fn snapshot_metadata(group: &str, artifact: &str, version: &str, files: &[String]) -> Option<String> {
    let mut newest: Vec<(FileName, String)> = Vec::new();
    for file in files {
        let Some(name) = parse_file(artifact, version, file) else { continue };
        let Some(build) = name.build.clone() else { continue };
        let key = (name.classifier.clone(), name.extension.clone());
        match newest.iter_mut().find(|(n, _)| (n.classifier.clone(), n.extension.clone()) == key) {
            Some(kept) => {
                let had = kept.0.build.clone().unwrap_or_default();
                if (build.1, &build.0) > (had.1, &had.0) {
                    *kept = (name, file.clone());
                }
            }
            None => newest.push((name, file.clone())),
        }
    }
    let (timestamp, build) = newest.iter().filter_map(|(n, _)| n.build.clone()).max_by(|a, b| (a.1, &a.0).cmp(&(b.1, &b.0)))?;
    newest.sort_by(|a, b| (&a.0.extension, &a.0.classifier).cmp(&(&b.0.extension, &b.0.classifier)));
    let updated = |stamp: &str| stamp.replace('.', "");
    let mut xml = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<metadata modelVersion=\"1.1.0\">\n");
    xml.push_str(&format!(
        "  <groupId>{}</groupId>\n  <artifactId>{}</artifactId>\n  <version>{}</version>\n  <versioning>\n",
        xml::escape(group),
        xml::escape(artifact),
        xml::escape(version)
    ));
    xml.push_str(&format!("    <snapshot>\n      <timestamp>{timestamp}</timestamp>\n      <buildNumber>{build}</buildNumber>\n    </snapshot>\n"));
    xml.push_str(&format!("    <lastUpdated>{}</lastUpdated>\n    <snapshotVersions>\n", updated(&timestamp)));
    for (name, _) in &newest {
        xml.push_str("      <snapshotVersion>\n");
        if let Some(classifier) = &name.classifier {
            xml.push_str(&format!("        <classifier>{}</classifier>\n", xml::escape(classifier)));
        }
        let stamp = name.build.as_ref().map(|b| b.0.clone()).unwrap_or_default();
        xml.push_str(&format!(
            "        <extension>{}</extension>\n        <value>{}</value>\n        <updated>{}</updated>\n      </snapshotVersion>\n",
            xml::escape(&name.extension),
            xml::escape(&name.value(version)),
            updated(&stamp)
        ));
    }
    xml.push_str("    </snapshotVersions>\n  </versioning>\n</metadata>\n");
    Some(xml)
}

/// What is read from a POM.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Pom {
    pub group: String,
    pub artifact: String,
    pub version: String,
    pub name: Option<String>,
    pub description: Option<String>,
    /// `<scm><url>`, else `<url>`: where its source is.
    pub source: Option<String>,
    /// `jar` when it names none; `maven-plugin` for a plugin.
    pub packaging: String,
}

/// Reads a POM, with the groupId and version a `<parent>` gives it.
pub fn read_pom(bytes: &[u8]) -> Result<Pom, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "The POM is not UTF-8.".to_owned())?;
    let project = xml::parse(text).map_err(|problem| format!("The POM is not XML: {problem}"))?;
    if project.name != "project" {
        return Err("The POM has no <project>.".to_owned());
    }
    let parent = project.child("parent");
    let inherited = |key: &str| project.child_text(key).or_else(|| parent.and_then(|p| p.child_text(key)));
    Ok(Pom {
        group: inherited("groupId").ok_or("The POM names no groupId.")?,
        artifact: project.child_text("artifactId").ok_or("The POM names no artifactId.")?,
        version: inherited("version").ok_or("The POM names no version.")?,
        name: project.child_text("name"),
        description: project.child_text("description"),
        source: project.child("scm").and_then(|scm| scm.child_text("url")).or_else(|| project.child_text("url")),
        packaging: project.child_text("packaging").unwrap_or_else(|| "jar".to_owned()),
    })
}

/// The prefix Maven gives a plugin that names none: its artifactId without
/// `maven` and `plugin` (`acme-maven-plugin` and `maven-acme-plugin` are
/// `acme`), as `mvn acme:<goal>` calls it.
pub fn default_prefix(artifact: &str) -> String {
    if artifact == "maven-plugin-plugin" {
        return "plugin".to_owned();
    }
    let strip = |text: &str, word: &str| -> String {
        // `-?word-?`, as Maven's regular expression removes it.
        let mut out = text.to_owned();
        while let Some(at) = out.find(word) {
            let start = if at > 0 && out.as_bytes()[at - 1] == b'-' { at - 1 } else { at };
            let mut end = at + word.len();
            if out.as_bytes().get(end) == Some(&b'-') {
                end += 1;
            }
            out.replace_range(start..end, "");
        }
        out
    };
    strip(&strip(artifact, "maven"), "plugin")
}

/// The plugin descriptor's prefix and name, from the
/// `META-INF/maven/plugin.xml` that `maven-plugin-plugin` puts in the jar.
pub fn plugin_descriptor(text: &str) -> Option<(Option<String>, Option<String>)> {
    let plugin = xml::parse(text).ok()?;
    (plugin.name == "plugin").then(|| (plugin.child_text("goalPrefix"), plugin.child_text("name")))
}

/// One plugin as a group's `maven-metadata.xml` lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plugin {
    pub prefix: String,
    pub artifact: String,
    pub name: String,
}

/// The `<plugins>` of a group's `maven-metadata.xml`, by prefix, which is
/// how Maven finds `mvn <prefix>:<goal>` among the groups it is told of.
pub fn plugins_block(plugins: &[Plugin]) -> String {
    let mut sorted: Vec<&Plugin> = plugins.iter().collect();
    sorted.sort_by(|a, b| (&a.prefix, &a.artifact).cmp(&(&b.prefix, &b.artifact)));
    let mut xml = String::from("  <plugins>
");
    for plugin in sorted {
        xml.push_str(&format!(
            "    <plugin>
      <name>{}</name>
      <prefix>{}</prefix>
      <artifactId>{}</artifactId>
    </plugin>
",
            xml::escape(&plugin.name),
            xml::escape(&plugin.prefix),
            xml::escape(&plugin.artifact)
        ));
    }
    xml.push_str("  </plugins>
");
    xml
}

/// A group's `maven-metadata.xml`: its plugins alone, or added to an
/// artifact's metadata when the path is both.
pub fn group_metadata(artifact_xml: Option<String>, plugins: &[Plugin]) -> String {
    let block = plugins_block(plugins);
    match artifact_xml {
        Some(xml) => match xml.rfind("</metadata>") {
            Some(at) => format!("{}{block}{}", &xml[..at], &xml[at..]),
            None => xml,
        },
        None => format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<metadata>
{block}</metadata>
"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(group: &str, artifact: &str, version: &str, file: &str, checksum: Option<Checksum>) -> Option<(String, MavenPath)> {
        Some((
            "acme".to_owned(),
            MavenPath::File { group: group.into(), artifact: artifact.into(), version: version.into(), file: file.into(), checksum },
        ))
    }

    #[test]
    fn paths_are_the_standard_layout() {
        assert_eq!(route("/-/maven/Acme/com/acme/web/1.0.0/web-1.0.0.jar"), file("com.acme", "web", "1.0.0", "web-1.0.0.jar", None));
        assert_eq!(
            route("/-/maven/acme/com/acme/web/1.0.0/web-1.0.0.pom.sha1"),
            file("com.acme", "web", "1.0.0", "web-1.0.0.pom", Some(Checksum::Sha1))
        );
        assert_eq!(
            route("/-/maven/acme/io/g1t/core-lib/2.1/core-lib-2.1-sources.jar.asc"),
            file("io.g1t", "core-lib", "2.1", "core-lib-2.1-sources.jar.asc", None)
        );
        assert_eq!(
            route("/-/maven/acme/com/acme/web/1.0-SNAPSHOT/web-1.0-20261006.120000-3.module.sha512"),
            file("com.acme", "web", "1.0-SNAPSHOT", "web-1.0-20261006.120000-3.module", Some(Checksum::Sha512))
        );
        assert_eq!(
            route("/-/maven/acme/com/acme/web/maven-metadata.xml"),
            Some(("acme".into(), MavenPath::ArtifactMetadata { group: "com.acme".into(), artifact: "web".into(), checksum: None }))
        );
        assert_eq!(
            route("/-/maven/acme/com/acme/web/maven-metadata.xml.md5"),
            Some(("acme".into(), MavenPath::ArtifactMetadata { group: "com.acme".into(), artifact: "web".into(), checksum: Some(Checksum::Md5) }))
        );
        assert_eq!(
            route("/-/maven/acme/com/acme/web/1.0-SNAPSHOT/maven-metadata.xml"),
            Some((
                "acme".into(),
                MavenPath::VersionMetadata { group: "com.acme".into(), artifact: "web".into(), version: "1.0-SNAPSHOT".into(), checksum: None }
            ))
        );
        // Not a file of the artifact, or not in the layout.
        assert_eq!(route("/-/maven/acme/com/acme/web/1.0.0/other-1.0.0.jar"), None);
        assert_eq!(route("/-/maven/acme/com/acme/web/1.0.0/web-1.0.1"), None);
        assert_eq!(route("/-/maven/acme/web/1.0.0/web-1.0.0.jar"), None, "no groupId");
        assert_eq!(route("/-/maven/acme/com/../web/1.0.0/web-1.0.0.jar"), None);
        assert_eq!(route("/-/maven/acme/com/acme/web/1.0.0/"), None);
        assert_eq!(route("/-/maven/acme/maven-metadata.xml"), None);
        assert_eq!(
            route("/-/maven/acme/acme/maven-metadata.xml.sha1"),
            Some(("acme".into(), MavenPath::GroupMetadata { group: "acme".into(), checksum: Some(Checksum::Sha1) }))
        );
        assert_eq!(route("/-/maven/"), None);
    }

    #[test]
    fn file_names_say_their_classifier_extension_and_build() {
        assert_eq!(parse_file("web", "1.0.0", "web-1.0.0.jar"), Some(FileName { classifier: None, extension: "jar".into(), build: None }));
        assert_eq!(
            parse_file("web", "1.0.0", "web-1.0.0-javadoc.jar"),
            Some(FileName { classifier: Some("javadoc".into()), extension: "jar".into(), build: None })
        );
        assert_eq!(parse_file("web", "1.0.0", "web-1.0.0.tar.gz").unwrap().extension, "tar.gz");
        let stamped = parse_file("web", "1.0-SNAPSHOT", "web-1.0-20261006.120000-12-sources.jar").unwrap();
        assert_eq!(stamped.build, Some(("20261006.120000".into(), 12)));
        assert_eq!(stamped.classifier.as_deref(), Some("sources"));
        assert_eq!(stamped.value("1.0-SNAPSHOT"), "1.0-20261006.120000-12");
        assert_eq!(parse_file("web", "1.0-SNAPSHOT", "web-1.0-SNAPSHOT.jar").unwrap().build, None);
        assert_eq!(parse_file("web", "1.0.0", "web-1.0.0"), None);
        assert_eq!(parse_file("web", "1.0.0", "web-1.0.0-.jar"), None);
        assert_eq!(parse_file("web", "1.0", "web-1.0-20261006.120000-1.jar").unwrap().build, None, "timestamps are a SNAPSHOT's");
    }

    #[test]
    fn versions_sort_as_maven_sorts_them() {
        let mut versions = vec!["1.10", "1.0", "1.0-SNAPSHOT", "1.0-rc1", "1.0-alpha", "1.0.1", "1.2", "1.0-beta-2", "2.0.0-M1", "1.0-sp1"];
        versions.sort_by(|a, b| compare(a, b));
        assert_eq!(versions, ["1.0-alpha", "1.0-beta-2", "1.0-rc1", "1.0-SNAPSHOT", "1.0", "1.0-sp1", "1.0.1", "1.2", "1.10", "2.0.0-M1"]);
        assert_eq!(compare("1.0", "1.0.0"), Ordering::Equal);
        assert_eq!(compare("1.0-ga", "1"), Ordering::Equal);
        assert!(valid_version("1.0.0") && valid_version("2024.1+build") && !valid_version("-1") && !valid_version("1 0"));
    }

    #[test]
    fn artifact_metadata_lists_versions_with_latest_and_release() {
        let xml = artifact_metadata("com.acme", "web", &["1.1.0".into(), "1.0.0".into(), "1.2.0-SNAPSHOT".into()], "2026-10-06T12:30:05.000Z");
        let doc = xml::parse(&xml).unwrap();
        let versioning = doc.child("versioning").unwrap();
        assert_eq!(doc.child_text("groupId").as_deref(), Some("com.acme"));
        assert_eq!(versioning.child_text("latest").as_deref(), Some("1.2.0-SNAPSHOT"));
        assert_eq!(versioning.child_text("release").as_deref(), Some("1.1.0"));
        let listed: Vec<String> = versioning.child("versions").unwrap().children_named("version").map(|v| v.text.clone()).collect();
        assert_eq!(listed, ["1.0.0", "1.1.0", "1.2.0-SNAPSHOT"]);
        assert_eq!(versioning.child_text("lastUpdated").as_deref(), Some("20261006123005"));
    }

    #[test]
    fn snapshot_metadata_names_the_newest_build_of_each_file() {
        let files: Vec<String> = [
            "web-1.0-20261006.120000-1.jar",
            "web-1.0-20261006.120000-1.pom",
            "web-1.0-20261007.090000-2.jar",
            "web-1.0-20261007.090000-2.pom",
            "web-1.0-20261006.120000-1-sources.jar",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let xml = snapshot_metadata("com.acme", "web", "1.0-SNAPSHOT", &files).unwrap();
        let doc = xml::parse(&xml).unwrap();
        assert_eq!(doc.child_text("version").as_deref(), Some("1.0-SNAPSHOT"));
        let versioning = doc.child("versioning").unwrap();
        let snapshot = versioning.child("snapshot").unwrap();
        assert_eq!(snapshot.child_text("timestamp").as_deref(), Some("20261007.090000"));
        assert_eq!(snapshot.child_text("buildNumber").as_deref(), Some("2"));
        let shown: Vec<(Option<String>, String, String)> = versioning
            .child("snapshotVersions")
            .unwrap()
            .children_named("snapshotVersion")
            .map(|v| (v.child_text("classifier"), v.child_text("extension").unwrap(), v.child_text("value").unwrap()))
            .collect();
        assert_eq!(
            shown,
            [
                (None, "jar".to_owned(), "1.0-20261007.090000-2".to_owned()),
                (Some("sources".to_owned()), "jar".to_owned(), "1.0-20261006.120000-1".to_owned()),
                (None, "pom".to_owned(), "1.0-20261007.090000-2".to_owned()),
            ]
        );
        assert_eq!(snapshot_metadata("com.acme", "web", "1.0-SNAPSHOT", &[]), None);
        assert_eq!(newest_build("web", "1.0-SNAPSHOT", &files), Some(("20261007.090000".to_owned(), 2)));
        assert_eq!(newest_build("web", "1.0-SNAPSHOT", &["web-1.0-SNAPSHOT.jar".to_owned()]), None);
    }

    #[test]
    fn a_pom_says_its_coordinates_and_source() {
        let pom = read_pom(
            br#"<?xml version="1.0"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <parent><groupId>com.acme</groupId><artifactId>parent</artifactId><version>1.0.0</version></parent>
  <artifactId>web</artifactId>
  <name>Acme web</name>
  <description>The web client</description>
  <url>https://acme.example</url>
  <scm><url>https://g1t.sh/acme/web</url></scm>
</project>"#,
        )
        .unwrap();
        assert_eq!((pom.group.as_str(), pom.artifact.as_str(), pom.version.as_str()), ("com.acme", "web", "1.0.0"));
        assert_eq!(pom.description.as_deref(), Some("The web client"));
        assert_eq!(pom.source.as_deref(), Some("https://g1t.sh/acme/web"));
        assert_eq!(pom.packaging, "jar");
        let plugin = read_pom(b"<project><groupId>com.acme</groupId><artifactId>acme-maven-plugin</artifactId><version>1</version><packaging>maven-plugin</packaging></project>").unwrap();
        assert_eq!(plugin.packaging, "maven-plugin");
        assert!(read_pom(b"<project><artifactId>x</artifactId></project>").is_err(), "no groupId");
        assert!(read_pom(b"not xml").is_err());
    }

    #[test]
    fn plugins_are_listed_by_prefix() {
        assert_eq!(default_prefix("acme-maven-plugin"), "acme");
        assert_eq!(default_prefix("maven-acme-plugin"), "acme");
        assert_eq!(default_prefix("hello-plugin"), "hello");
        assert_eq!(default_prefix("maven-plugin-plugin"), "plugin");
        assert_eq!(default_prefix("tools"), "tools");
        assert_eq!(
            plugin_descriptor("<plugin><name>Acme</name><groupId>com.acme</groupId><goalPrefix>acme</goalPrefix><mojos/></plugin>"),
            Some((Some("acme".to_owned()), Some("Acme".to_owned())))
        );
        assert_eq!(plugin_descriptor("<project/>"), None);
        let plugins = [
            Plugin { prefix: "zed".into(), artifact: "zed-maven-plugin".into(), name: "Zed".into() },
            Plugin { prefix: "acme".into(), artifact: "acme-maven-plugin".into(), name: "Acme & co".into() },
        ];
        let doc = xml::parse(&group_metadata(None, &plugins)).unwrap();
        let listed: Vec<(String, String, String)> = doc
            .child("plugins")
            .unwrap()
            .children_named("plugin")
            .map(|p| (p.child_text("prefix").unwrap(), p.child_text("artifactId").unwrap(), p.child_text("name").unwrap()))
            .collect();
        assert_eq!(
            listed,
            [
                ("acme".to_owned(), "acme-maven-plugin".to_owned(), "Acme & co".to_owned()),
                ("zed".to_owned(), "zed-maven-plugin".to_owned(), "Zed".to_owned())
            ]
        );
        // A path that is an artifact and a group says both.
        let both = group_metadata(Some(artifact_metadata("com", "acme", &["1.0".into()], "2026-10-06T00:00:00Z")), &plugins[..1]);
        let doc = xml::parse(&both).unwrap();
        assert!(doc.child("versioning").is_some() && doc.child("plugins").is_some());
    }

    #[test]
    fn checksums_are_hex_of_the_file() {
        assert_eq!(split_checksum("web-1.0.jar.sha1"), ("web-1.0.jar", Some(Checksum::Sha1)));
        assert_eq!(split_checksum("web-1.0.jar"), ("web-1.0.jar", None));
        assert_eq!(Checksum::Md5.of(b"abc"), "900150983cd24fb0d6963f7d28e17f72");
        assert_eq!(Checksum::Sha1.of(b"abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(sent_checksum(b"A9993E364706816ABA3E25717850C26C9CD0D89D  web-1.0.jar\n"), "a9993e364706816aba3e25717850c26c9cd0d89d");
        let sums = crate::db::Checksums::of(b"abc");
        assert_eq!(Checksum::Sha1.pick(&sums, "x"), Checksum::Sha1.of(b"abc"));
        assert_eq!(Checksum::Sha512.pick(&sums, "x"), Checksum::Sha512.of(b"abc"));
    }
}
