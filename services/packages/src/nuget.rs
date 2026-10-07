//! What the NuGet feed needs that does not touch the network: package ids
//! and NuGet's normalized versions, the feed's paths, the `.nuspec` read
//! from a `.nupkg` (a zip), the multipart body `dotnet nuget push` sends,
//! and the service index, registration and search documents of the v3
//! protocol.
//!
//! A version keeps what the documents need from its `.nuspec` as its
//! metadata, made once when it is pushed. Unlisting (`dotnet nuget
//! delete`) is the version's `yanked` column: an unlisted version is still
//! downloaded by those who name it, but no longer searched or picked.

use std::cmp::Ordering;

use serde_json::{Value, json};

use crate::archive;
use crate::xml;

/// The longest id nuget.org takes.
pub const MAX_ID: usize = 100;
/// The largest `.nuspec` or README read from a package.
const MAX_ENTRY_BYTES: usize = 1024 * 1024;

/// An id: letters, digits and `_`, in parts joined by `.`, `-` or `_`.
pub fn valid_id(id: &str) -> bool {
    let word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let bytes = id.as_bytes();
    !id.is_empty()
        && id.len() <= MAX_ID
        && word(bytes[0])
        && word(bytes[bytes.len() - 1])
        && bytes.iter().all(|b| word(*b) || matches!(b, b'.' | b'-'))
        && !bytes.windows(2).any(|w| matches!(w[0], b'.' | b'-') && matches!(w[1], b'.' | b'-'))
}

/// A version as NuGet reads it: up to four numbers, a pre-release label,
/// and build metadata (which is not part of the version).
#[derive(Clone, Debug, PartialEq, Eq)]
struct Parsed {
    numbers: [u64; 4],
    release: Vec<String>,
}

fn parse(version: &str) -> Option<Parsed> {
    let version = version.trim();
    let core = version.split_once('+').map_or(version, |(core, build)| {
        if build.is_empty() { "" } else { core }
    });
    let (numbers, release) = core.split_once('-').map_or((core, None), |(n, r)| (n, Some(r)));
    let parts: Vec<&str> = numbers.split('.').collect();
    if parts.is_empty() || parts.len() > 4 {
        return None;
    }
    let mut out = [0u64; 4];
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) || part.len() > 18 {
            return None;
        }
        out[i] = part.parse().ok()?;
    }
    let release = match release {
        None => Vec::new(),
        Some(text) => {
            let labels: Vec<String> = text.split('.').map(str::to_owned).collect();
            if labels.iter().any(|l| l.is_empty() || !l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')) {
                return None;
            }
            labels
        }
    };
    Some(Parsed { numbers: out, release })
}

/// NuGet's normalized form: `1.0` is `1.0.0`, `1.0.0.0` is `1.0.0`,
/// `01.2.3` is `1.2.3`, and `+build` is dropped. `None` for a version
/// NuGet would not take.
pub fn normalize(version: &str) -> Option<String> {
    let parsed = parse(version)?;
    let [a, b, c, d] = parsed.numbers;
    let mut out = if d == 0 { format!("{a}.{b}.{c}") } else { format!("{a}.{b}.{c}.{d}") };
    if !parsed.release.is_empty() {
        out.push('-');
        out.push_str(&parsed.release.join("."));
    }
    Some(out)
}

pub fn is_prerelease(version: &str) -> bool {
    parse(version).is_some_and(|p| !p.release.is_empty())
}

/// NuGet's order: by number, then a release above its pre-releases, whose
/// labels compare as SemVer 2 says, ignoring case.
pub fn compare(a: &str, b: &str) -> Ordering {
    let (Some(a), Some(b)) = (parse(a), parse(b)) else {
        return a.cmp(b);
    };
    a.numbers.cmp(&b.numbers).then_with(|| match (a.release.is_empty(), b.release.is_empty()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (false, false) => {
            for (x, y) in a.release.iter().zip(&b.release) {
                let order = match (x.parse::<u64>(), y.parse::<u64>()) {
                    (Ok(x), Ok(y)) => x.cmp(&y),
                    (Ok(_), Err(_)) => Ordering::Less,
                    (Err(_), Ok(_)) => Ordering::Greater,
                    (Err(_), Err(_)) => x.to_ascii_lowercase().cmp(&y.to_ascii_lowercase()),
                };
                if order != Ordering::Equal {
                    return order;
                }
            }
            a.release.len().cmp(&b.release.len())
        }
    })
}

/// Which of a version's files a flat container path asks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Content {
    Nupkg,
    Nuspec,
}

/// One of the feed's endpoints, under `/-/nuget/<workspace>/`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NugetRoute {
    /// `v3/index.json`: the service index.
    Index,
    /// `v3/flatcontainer/<id>/index.json`: every version, lowercased.
    Versions { id: String },
    /// `v3/flatcontainer/<id>/<version>/<id>.<version>.nupkg` or `<id>.nuspec`.
    Content { id: String, version: String, file: Content },
    /// `v3/registration/<id>/index.json`.
    Registration { id: String },
    /// `v3/registration/<id>/<version>.json`.
    Leaf { id: String, version: String },
    /// `v3/query`.
    Search,
    /// `api/v2/package`: `dotnet nuget push`.
    Push,
    /// `api/v2/package/<id>/<version>`: `DELETE` unlists, `POST` lists again.
    Listing { id: String, version: String },
}

/// The workspace and endpoint a path is. Ids are checked; versions are
/// checked by the handler, which reads them as NuGet does.
pub fn route(path: &str) -> Option<(String, NugetRoute)> {
    let rest = path.strip_prefix("/-/nuget/")?;
    let (workspace, rest) = rest.split_once('/')?;
    let workspace = workspace.to_ascii_lowercase();
    if workspace.is_empty() {
        return None;
    }
    let parts: Vec<&str> = rest.trim_end_matches('/').split('/').collect();
    let id = |text: &str| valid_id(text).then(|| text.to_owned());
    let route = match parts.as_slice() {
        ["v3", "index.json"] => NugetRoute::Index,
        ["v3", "query"] => NugetRoute::Search,
        ["v3", "flatcontainer", name, "index.json"] => NugetRoute::Versions { id: id(name)? },
        ["v3", "flatcontainer", name, version, file] => {
            let lower = format!("{}.{}", name.to_ascii_lowercase(), version.to_ascii_lowercase());
            let file = if file.eq_ignore_ascii_case(&format!("{lower}.nupkg")) {
                Content::Nupkg
            } else if file.eq_ignore_ascii_case(&format!("{name}.nuspec")) {
                Content::Nuspec
            } else {
                return None;
            };
            NugetRoute::Content { id: id(name)?, version: (*version).to_owned(), file }
        }
        ["v3", "registration", name, "index.json"] => NugetRoute::Registration { id: id(name)? },
        ["v3", "registration", name, leaf] => NugetRoute::Leaf { id: id(name)?, version: leaf.strip_suffix(".json")?.to_owned() },
        ["api", "v2", "package"] => NugetRoute::Push,
        ["api", "v2", "package", name, version] => NugetRoute::Listing { id: id(name)?, version: (*version).to_owned() },
        _ => return None,
    };
    Some((workspace, route))
}

/// The `.nupkg` file in a `multipart/form-data` body, as `dotnet nuget
/// push` sends it; a body that is not multipart is taken as the file.
pub fn pushed_file<'a>(content_type: Option<&str>, body: &'a [u8]) -> Result<&'a [u8], String> {
    let Some(content_type) = content_type.filter(|c| c.to_ascii_lowercase().starts_with("multipart/")) else {
        return Ok(body);
    };
    let boundary = content_type
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .find(|(key, _)| key.trim().eq_ignore_ascii_case("boundary"))
        .map(|(_, value)| value.trim().trim_matches('"'))
        .filter(|b| !b.is_empty())
        .ok_or("The upload names no multipart boundary.")?;
    let find = |haystack: &[u8], needle: &[u8], from: usize| {
        haystack.get(from..).and_then(|rest| rest.windows(needle.len()).position(|w| w == needle)).map(|at| at + from)
    };
    let delimiter = format!("--{boundary}");
    let start = find(body, delimiter.as_bytes(), 0).ok_or("The upload holds no package.")?;
    let headers_end = find(body, b"\r\n\r\n", start).ok_or("The upload holds no package.")? + 4;
    let end = find(body, format!("\r\n{delimiter}").as_bytes(), headers_end).ok_or("The upload ends early.")?;
    Ok(&body[headers_end..end])
}

/// A dependency group: the framework it is for (none for every one), and
/// each dependency's id and version range.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Group {
    pub target_framework: Option<String>,
    pub dependencies: Vec<(String, String)>,
}

/// What is read from a `.nuspec`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Nuspec {
    pub id: String,
    pub version: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub summary: Option<String>,
    pub authors: Option<String>,
    pub tags: Vec<String>,
    pub project_url: Option<String>,
    pub repository_url: Option<String>,
    pub license_expression: Option<String>,
    pub license_url: Option<String>,
    pub icon_url: Option<String>,
    pub readme: Option<String>,
    pub require_license_acceptance: bool,
    pub groups: Vec<Group>,
}

/// A dependency's `version` as a range: `1.0` (at least 1.0) is
/// `[1.0, )`; an interval is kept; none is any version.
pub fn range(version: Option<&str>) -> String {
    match version.map(str::trim).filter(|v| !v.is_empty()) {
        None => "(, )".to_owned(),
        Some(v) if v.starts_with('[') || v.starts_with('(') => v.to_owned(),
        Some(v) => format!("[{v}, )"),
    }
}

pub fn read_nuspec(text: &str) -> Result<Nuspec, String> {
    let root = xml::parse(text).map_err(|problem| format!("The .nuspec is not XML: {problem}"))?;
    let metadata = root.child("metadata").ok_or("The .nuspec has no <metadata>.")?;
    let dependency = |d: &xml::Element| d.attribute("id").map(|id| (id.to_owned(), range(d.attribute("version"))));
    let mut groups = Vec::new();
    if let Some(deps) = metadata.child("dependencies") {
        let loose: Vec<_> = deps.children_named("dependency").filter_map(dependency).collect();
        if !loose.is_empty() {
            groups.push(Group { target_framework: None, dependencies: loose });
        }
        for group in deps.children_named("group") {
            groups.push(Group {
                target_framework: group.attribute("targetFramework").map(str::to_owned).filter(|t| !t.is_empty()),
                dependencies: group.children_named("dependency").filter_map(dependency).collect(),
            });
        }
    }
    let license = metadata.child("license");
    Ok(Nuspec {
        id: metadata.child_text("id").ok_or("The .nuspec has no <id>.")?,
        version: metadata.child_text("version").ok_or("The .nuspec has no <version>.")?,
        title: metadata.child_text("title"),
        description: metadata.child_text("description"),
        summary: metadata.child_text("summary"),
        authors: metadata.child_text("authors"),
        tags: metadata.child_text("tags").map(|t| t.split([' ', ',', ';']).filter(|t| !t.is_empty()).map(str::to_owned).collect()).unwrap_or_default(),
        project_url: metadata.child_text("projectUrl"),
        repository_url: metadata.child("repository").and_then(|r| r.attribute("url")).map(str::to_owned).filter(|u| !u.is_empty()),
        license_expression: license
            .filter(|l| l.attribute("type") == Some("expression"))
            .map(|l| l.text.trim().to_owned())
            .filter(|l| !l.is_empty()),
        license_url: metadata.child_text("licenseUrl"),
        icon_url: metadata.child_text("iconUrl"),
        readme: metadata.child_text("readme"),
        require_license_acceptance: metadata.child_text("requireLicenseAcceptance").is_some_and(|v| v.eq_ignore_ascii_case("true")),
        groups,
    })
}

/// A package's `.nuspec` (read and as its bytes) and the README it names.
pub struct Package {
    pub nuspec: Nuspec,
    pub nuspec_bytes: Vec<u8>,
    pub readme: Option<String>,
}

/// Reads a `.nupkg`: the `.nuspec` at its root, and its README.
pub fn read_package(nupkg: &[u8]) -> Result<Package, String> {
    let entries = archive::zip_entries(nupkg).map_err(|_| "The package is not a .nupkg: it is not a zip.".to_owned())?;
    let entry = entries
        .iter()
        .find(|e| !e.name.contains('/') && e.name.to_ascii_lowercase().ends_with(".nuspec"))
        .ok_or("The package has no .nuspec.")?;
    let nuspec_bytes = archive::zip_read(nupkg, entry, MAX_ENTRY_BYTES)?;
    let text = String::from_utf8(nuspec_bytes.clone()).map_err(|_| "The .nuspec is not UTF-8.".to_owned())?;
    let nuspec = read_nuspec(&text)?;
    let readme = match &nuspec.readme {
        Some(path) => {
            let wanted = path.replace('\\', "/").trim_start_matches('/').to_ascii_lowercase();
            entries
                .iter()
                .find(|e| e.name.to_ascii_lowercase() == wanted)
                .and_then(|e| archive::zip_read(nupkg, e, MAX_ENTRY_BYTES).ok())
                .and_then(|bytes| String::from_utf8(bytes).ok())
        }
        None => None,
    };
    Ok(Package { nuspec, nuspec_bytes, readme })
}

/// What a version keeps from its `.nuspec`, for the feed's documents.
pub fn stored(nuspec: &Nuspec, version: &str) -> Value {
    json!({
        "id": nuspec.id,
        "version": version,
        "title": nuspec.title,
        "description": nuspec.description,
        "summary": nuspec.summary,
        "authors": nuspec.authors,
        "tags": nuspec.tags,
        "project_url": nuspec.project_url,
        "license_expression": nuspec.license_expression,
        "license_url": nuspec.license_url,
        "icon_url": nuspec.icon_url,
        "require_license_acceptance": nuspec.require_license_acceptance,
        "dependency_groups": nuspec.groups.iter().map(|g| json!({
            "target_framework": g.target_framework,
            "dependencies": g.dependencies.iter().map(|(id, range)| json!({ "id": id, "range": range })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
    })
}

/// The service index: where the client finds each resource, under `base`
/// (`https://g1t.sh/-/nuget/acme`).
pub fn service_index(base: &str) -> Value {
    let resource = |id: String, kind: &str| json!({ "@id": id, "@type": kind });
    let registration = format!("{base}/v3/registration/");
    let query = format!("{base}/v3/query");
    json!({
        "version": "3.0.0",
        "resources": [
            resource(format!("{base}/v3/flatcontainer/"), "PackageBaseAddress/3.0.0"),
            resource(registration.clone(), "RegistrationsBaseUrl"),
            resource(registration.clone(), "RegistrationsBaseUrl/3.0.0-rc"),
            resource(registration.clone(), "RegistrationsBaseUrl/3.0.0-beta"),
            resource(registration.clone(), "RegistrationsBaseUrl/3.4.0"),
            resource(registration, "RegistrationsBaseUrl/3.6.0"),
            resource(query.clone(), "SearchQueryService"),
            resource(query.clone(), "SearchQueryService/3.0.0-rc"),
            resource(query.clone(), "SearchQueryService/3.0.0-beta"),
            resource(query, "SearchQueryService/3.5.0"),
            resource(format!("{base}/api/v2/package"), "PackagePublish/2.0.0"),
        ],
    })
}

/// One version as the registration and search documents list it.
pub struct Listed<'a> {
    pub version: &'a str,
    pub metadata: &'a Value,
    pub published: &'a str,
    pub listed: bool,
    pub downloads: u64,
}

/// The addresses of a version's documents and files.
pub struct Addresses {
    pub registration: String,
    pub leaf: String,
    pub content: String,
}

pub fn addresses(base: &str, id: &str, version: &str) -> Addresses {
    let (id, version) = (id.to_ascii_lowercase(), version.to_ascii_lowercase());
    Addresses {
        registration: format!("{base}/v3/registration/{id}/index.json"),
        leaf: format!("{base}/v3/registration/{id}/{version}.json"),
        content: format!("{base}/v3/flatcontainer/{id}/{version}/{id}.{version}.nupkg"),
    }
}

/// A version's registration leaf, with its catalog entry inlined.
pub fn leaf(base: &str, id: &str, listed: &Listed<'_>) -> Value {
    let at = addresses(base, id, listed.version);
    let m = listed.metadata;
    let groups: Vec<Value> = m["dependency_groups"]
        .as_array()
        .map(|groups| {
            groups
                .iter()
                .enumerate()
                .map(|(n, g)| {
                    let deps: Vec<Value> = g["dependencies"]
                        .as_array()
                        .map(|deps| deps.iter().map(|d| json!({ "@id": format!("{}#dependency/{n}/{}", at.leaf, d["id"].as_str().unwrap_or("")), "id": d["id"], "range": d["range"] })).collect())
                        .unwrap_or_default();
                    let mut group = json!({ "@id": format!("{}#dependencygroup/{n}", at.leaf), "dependencies": deps });
                    if let Some(target) = g["target_framework"].as_str() {
                        group["targetFramework"] = json!(target);
                    }
                    group
                })
                .collect()
        })
        .unwrap_or_default();
    let text = |key: &str| m[key].as_str().unwrap_or("").to_owned();
    json!({
        "@id": at.leaf,
        "@type": "Package",
        "catalogEntry": {
            "@id": format!("{}#catalog", at.leaf),
            "@type": "PackageDetails",
            "id": m["id"].as_str().unwrap_or(id),
            "version": listed.version,
            "title": text("title"),
            "description": text("description"),
            "summary": text("summary"),
            "authors": text("authors"),
            "tags": m["tags"].as_array().cloned().unwrap_or_default(),
            "projectUrl": text("project_url"),
            "licenseExpression": text("license_expression"),
            "licenseUrl": text("license_url"),
            "iconUrl": text("icon_url"),
            "requireLicenseAcceptance": m["require_license_acceptance"].as_bool().unwrap_or(false),
            "dependencyGroups": groups,
            "listed": listed.listed,
            "published": listed.published,
            "packageContent": at.content,
        },
        "packageContent": at.content,
        "registration": at.registration,
    })
}

/// The registration index: every version, oldest first, in one page.
pub fn registration(base: &str, id: &str, versions: &[Listed<'_>]) -> Value {
    let index = format!("{base}/v3/registration/{}/index.json", id.to_ascii_lowercase());
    let (lower, upper) = (versions.first().map_or("", |v| v.version), versions.last().map_or("", |v| v.version));
    json!({
        "@id": index,
        "count": 1,
        "items": [{
            "@id": format!("{index}#page/{lower}/{upper}"),
            "count": versions.len(),
            "lower": lower,
            "upper": upper,
            "items": versions.iter().map(|v| leaf(base, id, v)).collect::<Vec<_>>(),
        }],
    })
}

/// One package as search answers it: its listed versions, the newest as
/// its version. `None` when none is listed.
pub fn search_result(base: &str, id: &str, versions: &[Listed<'_>]) -> Option<Value> {
    let shown: Vec<&Listed<'_>> = versions.iter().filter(|v| v.listed).collect();
    let newest = shown.iter().max_by(|a, b| compare(a.version, b.version))?;
    let m = newest.metadata;
    let at = addresses(base, id, newest.version);
    let authors: Vec<&str> = m["authors"].as_str().map(|a| a.split(',').map(str::trim).filter(|a| !a.is_empty()).collect()).unwrap_or_default();
    Some(json!({
        "@id": at.registration,
        "@type": "Package",
        "registration": at.registration,
        "id": m["id"].as_str().unwrap_or(id),
        "version": newest.version,
        "description": m["description"].as_str().unwrap_or(""),
        "summary": m["summary"].as_str().unwrap_or(""),
        "title": m["title"].as_str().unwrap_or(""),
        "projectUrl": m["project_url"].as_str().unwrap_or(""),
        "licenseUrl": m["license_url"].as_str().unwrap_or(""),
        "iconUrl": m["icon_url"].as_str().unwrap_or(""),
        "authors": authors,
        "tags": m["tags"].as_array().cloned().unwrap_or_default(),
        "totalDownloads": shown.iter().map(|v| v.downloads).sum::<u64>(),
        "verified": false,
        "packageTypes": [{ "name": "Dependency" }],
        "versions": shown.iter().map(|v| json!({
            "version": v.version,
            "downloads": v.downloads,
            "@id": addresses(base, id, v.version).leaf,
        })).collect::<Vec<_>>(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_follow_nugets_rules() {
        for good in ["Acme.Web", "Newtonsoft.Json", "a", "my-lib_2", &"a".repeat(100)] {
            assert!(valid_id(good), "{good}");
        }
        for bad in ["", ".a", "a.", "a..b", "a b", "a/b", "a.-b", &"a".repeat(101)] {
            assert!(!valid_id(bad), "{bad}");
        }
    }

    #[test]
    fn versions_normalize_and_order_as_nuget_does() {
        assert_eq!(normalize("1.0").as_deref(), Some("1.0.0"));
        assert_eq!(normalize("1.0.0.0").as_deref(), Some("1.0.0"));
        assert_eq!(normalize("1.0.0.4").as_deref(), Some("1.0.0.4"));
        assert_eq!(normalize("01.02.3").as_deref(), Some("1.2.3"));
        assert_eq!(normalize("1.0.0-Beta.1+sha.abc").as_deref(), Some("1.0.0-Beta.1"));
        for bad in ["", "a.b", "1.0.0.0.0", "1..0", "1.0-", "1.0-a..b", "1.0+"] {
            assert_eq!(normalize(bad), None, "{bad}");
        }
        assert!(is_prerelease("1.0.0-rc.1") && !is_prerelease("1.0.0"));
        let mut versions = vec!["1.0.0", "1.0.0-beta.2", "1.0.0-beta.10", "1.0.0-alpha", "0.9.0", "1.0.0.1", "1.0.0-BETA"];
        versions.sort_by(|a, b| compare(a, b));
        assert_eq!(versions, ["0.9.0", "1.0.0-alpha", "1.0.0-BETA", "1.0.0-beta.2", "1.0.0-beta.10", "1.0.0", "1.0.0.1"]);
    }

    #[test]
    fn every_endpoint_is_routed() {
        let at = |route: NugetRoute| Some(("acme".to_owned(), route));
        assert_eq!(route("/-/nuget/Acme/v3/index.json"), at(NugetRoute::Index));
        assert_eq!(route("/-/nuget/acme/v3/query"), at(NugetRoute::Search));
        assert_eq!(route("/-/nuget/acme/v3/flatcontainer/acme.web/index.json"), at(NugetRoute::Versions { id: "acme.web".into() }));
        assert_eq!(
            route("/-/nuget/acme/v3/flatcontainer/acme.web/1.0.0/acme.web.1.0.0.nupkg"),
            at(NugetRoute::Content { id: "acme.web".into(), version: "1.0.0".into(), file: Content::Nupkg })
        );
        assert_eq!(
            route("/-/nuget/acme/v3/flatcontainer/acme.web/1.0.0/acme.web.nuspec"),
            at(NugetRoute::Content { id: "acme.web".into(), version: "1.0.0".into(), file: Content::Nuspec })
        );
        assert_eq!(route("/-/nuget/acme/v3/flatcontainer/acme.web/1.0.0/other.1.0.0.nupkg"), None);
        assert_eq!(route("/-/nuget/acme/v3/registration/acme.web/index.json"), at(NugetRoute::Registration { id: "acme.web".into() }));
        assert_eq!(route("/-/nuget/acme/v3/registration/acme.web/1.0.0.json"), at(NugetRoute::Leaf { id: "acme.web".into(), version: "1.0.0".into() }));
        assert_eq!(route("/-/nuget/acme/api/v2/package"), at(NugetRoute::Push));
        assert_eq!(route("/-/nuget/acme/api/v2/package/"), at(NugetRoute::Push));
        assert_eq!(route("/-/nuget/acme/api/v2/package/Acme.Web/1.0.0"), at(NugetRoute::Listing { id: "Acme.Web".into(), version: "1.0.0".into() }));
        assert_eq!(route("/-/nuget/acme/v3/flatcontainer/a..b/index.json"), None);
        assert_eq!(route("/-/nuget/acme"), None);
        assert_eq!(route("/-/nuget/acme/v2"), None);
    }

    #[test]
    fn the_push_body_is_multipart_with_the_package() {
        let body = b"--abc123\r\nContent-Type: application/octet-stream\r\nContent-Disposition: form-data; name=package; filename=package.nupkg\r\n\r\nPK\x03\x04data\r\n--abc\r\nmore\r\n--abc123--\r\n";
        assert_eq!(pushed_file(Some("multipart/form-data; boundary=\"abc123\""), body).unwrap(), b"PK\x03\x04data\r\n--abc\r\nmore");
        assert_eq!(pushed_file(Some("application/octet-stream"), b"PK raw").unwrap(), b"PK raw");
        assert_eq!(pushed_file(None, b"PK raw").unwrap(), b"PK raw");
        assert!(pushed_file(Some("multipart/form-data"), body).is_err(), "no boundary");
        assert!(pushed_file(Some("multipart/form-data; boundary=zzz"), body).is_err());
    }

    const NUSPEC: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd">
  <metadata>
    <id>Acme.Web</id>
    <version>1.2.0</version>
    <authors>Ada, Bo</authors>
    <description>The web client.</description>
    <license type="expression">MIT</license>
    <readme>docs\README.md</readme>
    <repository type="git" url="https://g1t.sh/acme/web.git" />
    <tags>http client</tags>
    <dependencies>
      <group targetFramework="net8.0">
        <dependency id="Newtonsoft.Json" version="13.0.1" exclude="Build,Analyzers" />
        <dependency id="Acme.Core" version="[1.0.0, 2.0.0)" />
      </group>
      <group targetFramework=".NETStandard2.0" />
    </dependencies>
  </metadata>
</package>"#;

    #[test]
    fn a_package_is_read_from_its_nuspec() {
        let nupkg = crate::composer::zip(&[
            ("Acme.Web.nuspec".to_owned(), NUSPEC.as_bytes().to_vec()),
            ("docs/README.md".to_owned(), b"# Acme.Web\n".to_vec()),
            ("lib/net8.0/Acme.Web.dll".to_owned(), b"MZ".to_vec()),
        ]);
        let package = read_package(&nupkg).unwrap();
        let spec = &package.nuspec;
        assert_eq!((spec.id.as_str(), spec.version.as_str()), ("Acme.Web", "1.2.0"));
        assert_eq!(spec.license_expression.as_deref(), Some("MIT"));
        assert_eq!(spec.repository_url.as_deref(), Some("https://g1t.sh/acme/web.git"));
        assert_eq!(spec.tags, ["http", "client"]);
        assert_eq!(package.readme.as_deref(), Some("# Acme.Web\n"));
        assert_eq!(spec.groups.len(), 2);
        assert_eq!(spec.groups[0].target_framework.as_deref(), Some("net8.0"));
        assert_eq!(spec.groups[0].dependencies, [("Newtonsoft.Json".into(), "[13.0.1, )".into()), ("Acme.Core".into(), "[1.0.0, 2.0.0)".into())]);
        assert!(spec.groups[1].dependencies.is_empty());
        assert!(read_package(b"not a zip").is_err());
        let empty = crate::composer::zip(&[("lib/a.dll".to_owned(), b"MZ".to_vec())]);
        assert!(read_package(&empty).is_err(), "no .nuspec");
        assert_eq!(range(None), "(, )");
    }

    #[test]
    fn the_documents_are_nugets_shape() {
        let index = service_index("https://g1t.sh/-/nuget/acme");
        let kinds: Vec<&str> = index["resources"].as_array().unwrap().iter().map(|r| r["@type"].as_str().unwrap()).collect();
        for kind in ["PackageBaseAddress/3.0.0", "RegistrationsBaseUrl", "SearchQueryService", "PackagePublish/2.0.0"] {
            assert!(kinds.contains(&kind), "{kind}");
        }
        let spec = read_nuspec(NUSPEC).unwrap();
        let (one, two) = (stored(&spec, "1.0.0"), stored(&spec, "1.2.0"));
        let versions = [
            Listed { version: "1.0.0", metadata: &one, published: "2026-10-01T00:00:00.000Z", listed: false, downloads: 3 },
            Listed { version: "1.2.0", metadata: &two, published: "2026-10-06T00:00:00.000Z", listed: true, downloads: 4 },
        ];
        let base = "https://g1t.sh/-/nuget/acme";
        let reg = registration(base, "Acme.Web", &versions);
        let page = &reg["items"][0];
        assert_eq!(page["lower"], "1.0.0");
        assert_eq!(page["upper"], "1.2.0");
        let entry = &page["items"][1]["catalogEntry"];
        assert_eq!(entry["id"], "Acme.Web");
        assert_eq!(entry["listed"], true);
        assert_eq!(entry["packageContent"], "https://g1t.sh/-/nuget/acme/v3/flatcontainer/acme.web/1.2.0/acme.web.1.2.0.nupkg");
        assert_eq!(entry["dependencyGroups"][0]["targetFramework"], "net8.0");
        assert_eq!(entry["dependencyGroups"][0]["dependencies"][1]["range"], "[1.0.0, 2.0.0)");
        assert_eq!(page["items"][0]["catalogEntry"]["listed"], false);
        let found = search_result(base, "Acme.Web", &versions).unwrap();
        assert_eq!(found["version"], "1.2.0");
        assert_eq!(found["versions"].as_array().unwrap().len(), 1, "unlisted versions are not searched");
        assert_eq!(found["totalDownloads"], 4);
        assert_eq!(found["authors"], json!(["Ada", "Bo"]));
        assert!(search_result(base, "Acme.Web", &versions[..1]).is_none());
    }
}
