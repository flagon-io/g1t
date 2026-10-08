//! What versions a package has, from its registry: npm's, crates.io (or a
//! Cargo sparse index), the Go module proxy and PyPI (or a simple index),
//! or a private registry the dependency update file names in their place.
//! Reading each registry's answer is kept apart from fetching it, so it is
//! tested on its own.

use serde_json::Value;

use g1t_contracts::time::parse_rfc3339;

/// One published version.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Release {
    pub version: String,
    /// When it was published, in milliseconds; unknown for some registries.
    pub published_ms: Option<u64>,
    /// Yanked or deprecated: never updated to.
    pub withdrawn: bool,
}

/// What a registry says about a package.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Package {
    pub releases: Vec<Release>,
    /// Its source repository, for links in the pull request.
    pub source: Option<String>,
    /// Its changelog or release notes, when the registry names one.
    pub changelog: Option<String>,
    /// Its page on the registry.
    pub page: Option<String>,
}

/// A registry to ask, with what it needs to answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Source {
    /// Without a trailing slash.
    pub url: String,
    /// The `authorization` header's value.
    pub authorization: Option<String>,
}

/// A repository URL as registries write it (`git+https://…/x.git`,
/// `github:owner/repo`), as a page a person can open.
pub fn web_url(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let raw = raw.strip_prefix("git+").unwrap_or(raw);
    let raw = raw.strip_suffix(".git").unwrap_or(raw);
    if let Some(path) = raw.strip_prefix("github:") {
        return Some(format!("https://github.com/{path}"));
    }
    let raw = raw.replace("git://", "https://").replace("ssh://git@", "https://");
    let raw = raw.strip_prefix("git@").map(|rest| format!("https://{}", rest.replacen(':', "/", 1))).unwrap_or(raw);
    (raw.starts_with("https://") || raw.starts_with("http://")).then_some(raw)
}

/// npm's package document: `versions`, `time` and `repository`.
pub fn npm(document: &Value, name: &str) -> Package {
    let times = document.get("time");
    let releases = document
        .get("versions")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .map(|(version, manifest)| Release {
            version: version.clone(),
            published_ms: times.and_then(|times| times.get(version)).and_then(Value::as_str).and_then(parse_rfc3339),
            withdrawn: manifest.get("deprecated").is_some_and(|deprecated| deprecated.as_str().is_some_and(|text| !text.is_empty())),
        })
        .collect();
    let repository = document.get("repository").and_then(|repository| repository.as_str().or_else(|| repository.get("url")?.as_str()));
    Package {
        releases,
        source: repository.and_then(web_url),
        changelog: None,
        page: Some(format!("https://www.npmjs.com/package/{name}")),
    }
}

/// crates.io's `/api/v1/crates/<name>`: the crate and its versions.
pub fn crates_io(document: &Value, name: &str) -> Package {
    let releases = document
        .get("versions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|version| {
            Some(Release {
                version: version.get("num")?.as_str()?.to_owned(),
                published_ms: version.get("created_at").and_then(Value::as_str).and_then(normalized_time),
                withdrawn: version.get("yanked").and_then(Value::as_bool).unwrap_or(false),
            })
        })
        .collect();
    let krate = document.get("crate");
    Package {
        releases,
        source: krate.and_then(|krate| krate.get("repository")).and_then(Value::as_str).and_then(web_url),
        changelog: None,
        page: Some(format!("https://crates.io/crates/{name}")),
    }
}

/// A Cargo sparse index file: one JSON object per line.
pub fn sparse_index(text: &str) -> Package {
    let releases = text
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|entry| {
            Some(Release {
                version: entry.get("vers")?.as_str()?.to_owned(),
                published_ms: entry.get("pubtime").and_then(Value::as_str).and_then(normalized_time),
                withdrawn: entry.get("yanked").and_then(Value::as_bool).unwrap_or(false),
            })
        })
        .collect();
    Package { releases, ..Package::default() }
}

/// Where a crate's sparse index file is: `se/rd/serde`, `3/a/abc`, `1/a`.
pub fn sparse_path(name: &str) -> String {
    let name = name.to_lowercase();
    match name.len() {
        1 => format!("1/{name}"),
        2 => format!("2/{name}"),
        3 => format!("3/{}/{name}", &name[..1]),
        _ => format!("{}/{}/{name}", &name[..2], &name[2..4]),
    }
}

/// A Go module path as the proxy takes it: capitals as `!` and the letter.
pub fn go_escape(module: &str) -> String {
    let mut out = String::with_capacity(module.len());
    for c in module.chars() {
        if c.is_ascii_uppercase() {
            out.push('!');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// The proxy's `@v/list`: one version per line. When each was published
/// is asked of `@v/<version>.info` only for the versions that matter.
pub fn go_list(text: &str, module: &str) -> Package {
    let releases = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.contains("+incompatible"))
        .map(|version| Release { version: version.to_owned(), published_ms: None, withdrawn: false })
        .collect();
    let source = ["github.com/", "gitlab.com/", "bitbucket.org/", "g1t.sh/"]
        .iter()
        .any(|host| module.starts_with(host))
        .then(|| format!("https://{}", module.split('/').take(3).collect::<Vec<_>>().join("/")));
    Package { releases, source, changelog: None, page: Some(format!("https://pkg.go.dev/{module}")) }
}

/// `@v/<version>.info`'s `Time`.
pub fn go_info_time(document: &Value) -> Option<u64> {
    document.get("Time").and_then(Value::as_str).and_then(normalized_time)
}

/// PyPI's `/pypi/<name>/json`: every release's files, and the project's links.
pub fn pypi(document: &Value, name: &str) -> Package {
    let releases = document
        .get("releases")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(version, files)| {
            let files = files.as_array()?;
            if files.is_empty() {
                return None;
            }
            let published_ms = files
                .iter()
                .filter_map(|file| file.get("upload_time_iso_8601").and_then(Value::as_str).and_then(normalized_time))
                .min();
            let withdrawn = files.iter().all(|file| file.get("yanked").and_then(Value::as_bool).unwrap_or(false));
            Some(Release { version: version.clone(), published_ms, withdrawn })
        })
        .collect();
    let info = document.get("info");
    let urls = info.and_then(|info| info.get("project_urls")).and_then(Value::as_object);
    let link = |keys: &[&str]| -> Option<String> {
        urls?.iter().find(|(key, _)| keys.iter().any(|wanted| key.eq_ignore_ascii_case(wanted))).and_then(|(_, url)| url.as_str()).map(str::to_owned)
    };
    Package {
        releases,
        source: link(&["Source", "Source Code", "Repository", "Code", "GitHub"]).and_then(|url| web_url(&url)),
        changelog: link(&["Changelog", "Changes", "Release Notes", "Release notes", "History"]),
        page: Some(format!("https://pypi.org/project/{name}/")),
    }
}

/// A simple index's JSON page (PEP 691 and 700): its `versions`, and when
/// each file was uploaded.
pub fn simple_index(document: &Value) -> Package {
    let versions: Vec<String> =
        document.get("versions").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
    let files: Vec<&Value> = document.get("files").and_then(Value::as_array).into_iter().flatten().collect();
    let releases = versions
        .into_iter()
        .map(|version| {
            let mine: Vec<&&Value> = files
                .iter()
                .filter(|file| {
                    file.get("filename").and_then(Value::as_str).is_some_and(|name| name.contains(&format!("-{version}-")) || name.contains(&format!("-{version}.")))
                })
                .collect();
            Release {
                published_ms: mine.iter().filter_map(|file| file.get("upload-time").and_then(Value::as_str).and_then(normalized_time)).min(),
                withdrawn: !mine.is_empty() && mine.iter().all(|file| file.get("yanked").is_some_and(|yanked| yanked.as_bool() != Some(false))),
                version,
            }
        })
        .collect();
    Package { releases, ..Package::default() }
}

/// An ISO 8601 time with or without fractions or a zone offset, as
/// registries write them, as milliseconds.
pub fn normalized_time(text: &str) -> Option<u64> {
    let text = text.trim();
    let (main, offset_minutes) = if let Some(stripped) = text.strip_suffix('Z') {
        (stripped, 0i64)
    } else if let Some(at) = text.rfind(['+', '-']).filter(|at| *at > 10) {
        let (main, zone) = text.split_at(at);
        let sign = if zone.starts_with('-') { -1 } else { 1 };
        let digits: String = zone[1..].chars().filter(char::is_ascii_digit).collect();
        let hours: i64 = digits.get(..2)?.parse().ok()?;
        let minutes: i64 = digits.get(2..4).unwrap_or("00").parse().ok()?;
        (main, sign * (hours * 60 + minutes))
    } else {
        (text, 0)
    };
    let (date, time) = main.split_once('T').or_else(|| main.split_once(' '))?;
    let (clock, fraction) = time.split_once('.').unwrap_or((time, ""));
    let millis: String = fraction.chars().take_while(char::is_ascii_digit).chain("000".chars()).take(3).collect();
    let ms = parse_rfc3339(&format!("{date}T{clock}.{millis}Z"))? as i64 - offset_minutes * 60_000;
    u64::try_from(ms).ok()
}

/// The URL to ask about `name` in `ecosystem`, given the registry to use
/// (`None` for the public one).
pub fn package_url(ecosystem: &str, name: &str, private: Option<&Source>) -> Option<String> {
    Some(match (ecosystem, private) {
        ("npm", None) => format!("https://registry.npmjs.org/{}", name.replace('/', "%2f")),
        ("npm", Some(source)) => format!("{}/{}", source.url, name.replace('/', "%2f")),
        ("cargo", None) => format!("https://crates.io/api/v1/crates/{name}"),
        ("cargo", Some(source)) => format!("{}/{}", source.url, sparse_path(name)),
        ("gomod", None) => format!("https://proxy.golang.org/{}/@v/list", go_escape(name)),
        ("gomod", Some(source)) => format!("{}/{}/@v/list", source.url, go_escape(name)),
        ("pip", None) => format!("https://pypi.org/pypi/{name}/json"),
        ("pip", Some(source)) => format!("{}/{name}/", source.url),
        _ => return None,
    })
}

/// Reads a registry's answer for `name` in `ecosystem`.
pub fn read(ecosystem: &str, name: &str, private: bool, body: &str) -> Package {
    let json = || serde_json::from_str::<Value>(body).unwrap_or(Value::Null);
    match (ecosystem, private) {
        ("npm", _) => npm(&json(), name),
        ("cargo", false) => crates_io(&json(), name),
        ("cargo", true) => sparse_index(body),
        ("gomod", _) => go_list(body, name),
        ("pip", false) => pypi(&json(), name),
        ("pip", true) => simple_index(&json()),
        _ => Package::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn npm_documents() {
        let document = json!({
            "versions": {"4.17.20": {}, "4.17.21": {}, "5.0.0-beta": {"deprecated": "do not use"}},
            "time": {"4.17.20": "2020-08-13T16:53:54.152Z", "4.17.21": "2021-02-20T15:42:16.891Z"},
            "repository": {"type": "git", "url": "git+https://github.com/lodash/lodash.git"},
        });
        let package = npm(&document, "lodash");
        assert_eq!(package.releases.len(), 3);
        let latest = package.releases.iter().find(|r| r.version == "4.17.21").unwrap();
        assert_eq!(latest.published_ms, Some(parse_rfc3339("2021-02-20T15:42:16.891Z").unwrap()));
        assert!(package.releases.iter().find(|r| r.version == "5.0.0-beta").unwrap().withdrawn);
        assert_eq!(package.source.as_deref(), Some("https://github.com/lodash/lodash"));
        assert_eq!(package.page.as_deref(), Some("https://www.npmjs.com/package/lodash"));
        assert_eq!(package_url("npm", "@babel/core", None).unwrap(), "https://registry.npmjs.org/@babel%2fcore");
    }

    #[test]
    fn crates_documents() {
        let document = json!({
            "crate": {"repository": "https://github.com/serde-rs/serde"},
            "versions": [
                {"num": "1.0.200", "created_at": "2024-05-01T10:00:00.123456+00:00", "yanked": false},
                {"num": "1.0.199", "created_at": "2024-04-01T10:00:00+00:00", "yanked": true}
            ]
        });
        let package = crates_io(&document, "serde");
        assert_eq!(package.releases[0].published_ms, Some(parse_rfc3339("2024-05-01T10:00:00.123Z").unwrap()));
        assert!(package.releases[1].withdrawn);
        assert_eq!(package.source.as_deref(), Some("https://github.com/serde-rs/serde"));
        let sparse = sparse_index("{\"name\":\"x\",\"vers\":\"0.1.0\",\"yanked\":false}\n{\"name\":\"x\",\"vers\":\"0.2.0\",\"yanked\":true,\"pubtime\":\"2025-01-01T00:00:00Z\"}\n");
        assert_eq!(sparse.releases.len(), 2);
        assert!(sparse.releases[1].withdrawn && sparse.releases[1].published_ms.is_some());
        assert_eq!(sparse_path("serde"), "se/rd/serde");
        assert_eq!(sparse_path("abc"), "3/a/abc");
        assert_eq!(sparse_path("ab"), "2/ab");
        assert_eq!(sparse_path("A"), "1/a");
    }

    #[test]
    fn go_proxy() {
        assert_eq!(go_escape("github.com/BurntSushi/toml"), "github.com/!burnt!sushi/toml");
        let package = go_list("v0.7.0\nv0.23.0\nv2.0.0+incompatible\n\n", "golang.org/x/net");
        assert_eq!(package.releases.iter().map(|r| r.version.as_str()).collect::<Vec<_>>(), ["v0.7.0", "v0.23.0"]);
        assert_eq!(go_list("", "github.com/gin-gonic/gin/v2").source.as_deref(), Some("https://github.com/gin-gonic/gin"));
        assert_eq!(go_info_time(&json!({"Version": "v0.23.0", "Time": "2024-04-04T17:13:08Z"})), parse_rfc3339("2024-04-04T17:13:08Z"));
        assert_eq!(package_url("gomod", "github.com/BurntSushi/toml", None).unwrap(), "https://proxy.golang.org/github.com/!burnt!sushi/toml/@v/list");
    }

    #[test]
    fn pypi_documents() {
        let document = json!({
            "info": {"project_urls": {"Changelog": "https://docs.example/changes", "Source": "https://github.com/psf/requests"}},
            "releases": {
                "2.31.0": [{"upload_time_iso_8601": "2023-05-22T15:12:44.175893Z", "yanked": false}],
                "2.30.0": [{"upload_time_iso_8601": "2023-05-03T15:00:00Z", "yanked": true}],
                "0.0.1": []
            }
        });
        let package = pypi(&document, "requests");
        assert_eq!(package.releases.len(), 2);
        assert!(package.releases.iter().find(|r| r.version == "2.30.0").unwrap().withdrawn);
        assert_eq!(package.changelog.as_deref(), Some("https://docs.example/changes"));
        assert_eq!(package.source.as_deref(), Some("https://github.com/psf/requests"));
        let simple = simple_index(&json!({
            "versions": ["1.0", "1.1"],
            "files": [
                {"filename": "pkg-1.0-py3-none-any.whl", "upload-time": "2024-01-01T00:00:00Z"},
                {"filename": "pkg-1.1.tar.gz", "upload-time": "2024-02-01T00:00:00Z", "yanked": "broken"}
            ]
        }));
        assert_eq!(simple.releases.len(), 2);
        assert!(!simple.releases[0].withdrawn && simple.releases[1].withdrawn);
    }

    #[test]
    fn times_and_urls() {
        assert_eq!(normalized_time("2024-01-01T02:00:00+02:00"), parse_rfc3339("2024-01-01T00:00:00Z"));
        assert_eq!(normalized_time("2024-01-01 00:00:00"), parse_rfc3339("2024-01-01T00:00:00Z"));
        assert_eq!(web_url("git@github.com:a/b.git").as_deref(), Some("https://github.com/a/b"));
        assert_eq!(web_url("github:a/b").as_deref(), Some("https://github.com/a/b"));
        assert_eq!(web_url("not a url"), None);
    }
}
