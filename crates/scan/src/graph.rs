//! A repository's dependency graph, as its lockfiles state it: every
//! package each lockfile resolves, whether the project asks for it itself
//! (direct) or gets it through another package (transitive), whether it is
//! for development only, and its license when the lockfile records one.
//!
//! Lockfiles differ in what they say. `package-lock.json`, `pnpm-lock.yaml`,
//! `Cargo.lock` and `go.mod` name the project's own dependencies; a
//! `requirements.txt` lists what is installed, and from pip-compile says
//! which came from where. `yarn.lock`, `go.sum` and `poetry.lock` do not
//! say, so their packages are [`Relationship::Unknown`].

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::lockfiles::{Ecosystem, Lockfile, Package};

/// How the project comes to depend on a package.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Relationship {
    Direct,
    Transitive,
    /// The lockfile does not say.
    Unknown,
}

impl Relationship {
    pub fn as_str(self) -> &'static str {
        match self {
            Relationship::Direct => "direct",
            Relationship::Transitive => "transitive",
            Relationship::Unknown => "unknown",
        }
    }

    pub fn parse(text: &str) -> Relationship {
        match text {
            "direct" => Relationship::Direct,
            "transitive" => Relationship::Transitive,
            _ => Relationship::Unknown,
        }
    }
}

/// One package in one lockfile.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Dependency {
    pub package: Package,
    /// The lockfile, from the repository's root.
    pub manifest: String,
    pub relationship: Relationship,
    /// For development or tests only, when the lockfile says so.
    pub development: bool,
    /// An SPDX license expression, when the lockfile records one.
    pub license: Option<String>,
}

impl Dependency {
    /// The package URL (purl) that names it everywhere: `pkg:npm/%40babel/core@7.0.0`.
    pub fn purl(&self) -> String {
        purl(self.package.ecosystem, &self.package.name, &self.package.version)
    }
}

/// The purl type for an ecosystem.
pub fn purl_type(ecosystem: Ecosystem) -> &'static str {
    match ecosystem {
        Ecosystem::Npm => "npm",
        Ecosystem::Cargo => "cargo",
        Ecosystem::Go => "golang",
        Ecosystem::PyPI => "pypi",
    }
}

fn purl_encode(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '@' => "%40".to_owned(),
            ' ' => "%20".to_owned(),
            '?' => "%3F".to_owned(),
            '#' => "%23".to_owned(),
            other => other.to_string(),
        })
        .collect()
}

/// A package URL, as the purl specification writes one.
pub fn purl(ecosystem: Ecosystem, name: &str, version: &str) -> String {
    let name = match ecosystem {
        // A scope is a namespace: `@babel/core` is `%40babel/core`.
        Ecosystem::Npm => purl_encode(name),
        Ecosystem::PyPI => name.to_lowercase().replace('_', "-"),
        _ => name.to_owned(),
    };
    format!("pkg:{}/{name}@{}", purl_type(ecosystem), purl_encode(version))
}

/// What a lockfile says beyond names and versions: the project's own
/// dependencies (`None` when it does not say), those for development, and
/// licenses by package.
#[derive(Default)]
struct Facts {
    direct: Option<BTreeSet<String>>,
    development: BTreeSet<(String, String)>,
    direct_development: BTreeSet<String>,
    licenses: BTreeMap<(String, String), String>,
}

/// Every package `text` resolves, with what it says about each.
pub fn dependencies(lockfile: Lockfile, manifest: &str, text: &str) -> Vec<Dependency> {
    let facts = match lockfile {
        Lockfile::PackageLock => package_lock(text),
        Lockfile::PnpmLock => pnpm_lock(text),
        Lockfile::CargoLock => cargo_lock(text),
        Lockfile::GoMod => go_mod(text),
        Lockfile::Requirements => requirements(text),
        Lockfile::YarnLock | Lockfile::GoSum | Lockfile::PoetryLock => Facts::default(),
    };
    let ecosystem = lockfile.ecosystem();
    lockfile
        .parse(text)
        .into_iter()
        .map(|package| {
            let relationship = match &facts.direct {
                Some(direct) if direct.contains(&ecosystem.normalize(&package.name)) => Relationship::Direct,
                Some(_) => Relationship::Transitive,
                None => Relationship::Unknown,
            };
            let key = (package.name.clone(), package.version.clone());
            let development = facts.development.contains(&key)
                || (relationship == Relationship::Direct && facts.direct_development.contains(&package.name));
            Dependency {
                license: facts.licenses.get(&key).cloned(),
                manifest: manifest.to_owned(),
                relationship,
                development,
                package,
            }
        })
        .collect()
}

fn keys(value: Option<&Value>) -> impl Iterator<Item = String> + '_ {
    value.and_then(Value::as_object).into_iter().flat_map(|object| object.keys().cloned())
}

/// `package-lock.json` v2 and v3: the root entry (`""`) names the project's
/// dependencies; each package says `dev` and, from npm 7, its `license`.
fn package_lock(text: &str) -> Facts {
    let Ok(lock) = serde_json::from_str::<Value>(text) else {
        return Facts::default();
    };
    let mut facts = Facts::default();
    if let Some(packages) = lock.get("packages").and_then(Value::as_object) {
        let mut direct = BTreeSet::new();
        for (path, entry) in packages {
            // The project and its workspaces: what they ask for is direct.
            if !path.contains("node_modules/") {
                for field in ["dependencies", "optionalDependencies", "peerDependencies"] {
                    direct.extend(keys(entry.get(field)));
                }
                for name in keys(entry.get("devDependencies")) {
                    facts.direct_development.insert(name.clone());
                    direct.insert(name);
                }
                continue;
            }
            let at = path.rfind("node_modules/").unwrap_or(0) + "node_modules/".len();
            let name = entry.get("name").and_then(Value::as_str).unwrap_or(&path[at..]).to_owned();
            let Some(version) = entry.get("version").and_then(Value::as_str) else { continue };
            let key = (name, version.to_owned());
            if entry.get("dev").and_then(Value::as_bool) == Some(true) {
                facts.development.insert(key.clone());
            }
            let license = match entry.get("license") {
                Some(Value::String(license)) => Some(license.clone()),
                Some(Value::Object(object)) => object.get("type").and_then(Value::as_str).map(str::to_owned),
                _ => None,
            };
            if let Some(license) = license.filter(|license| !license.trim().is_empty()) {
                facts.licenses.insert(key, license);
            }
        }
        facts.direct = Some(direct);
    } else if let Some(dependencies) = lock.get("dependencies").and_then(Value::as_object) {
        // v1 nests what each package needs under it; the top level is
        // everything hoisted, which is not the same as direct.
        for (name, entry) in dependencies {
            if entry.get("dev").and_then(Value::as_bool) == Some(true)
                && let Some(version) = entry.get("version").and_then(Value::as_str)
            {
                facts.development.insert((name.clone(), version.to_owned()));
            }
        }
    }
    facts
}

/// The name a pnpm importer line gives, unquoted: `  '@babel/core':`.
fn yaml_key(line: &str) -> Option<String> {
    let key = line.trim().strip_suffix(':').or_else(|| line.trim().split_once(": ").map(|(key, _)| key))?;
    let key = key.trim().trim_matches(['\'', '"']);
    (!key.is_empty()).then(|| key.to_owned())
}

fn indent(line: &str) -> usize {
    line.len() - line.trim_start_matches(' ').len()
}

/// `pnpm-lock.yaml`: v6 and v9 list each importer's dependencies under
/// `importers:`; v5 and single-project v6 at the top level.
fn pnpm_lock(text: &str) -> Facts {
    let mut direct = BTreeSet::new();
    let mut development = BTreeSet::new();
    let mut section = String::new();
    // Under `importers`: the indentation of the current dependency list,
    // and whether it is for development.
    let mut list: Option<(usize, bool)> = None;
    let mut found_any = false;
    for line in text.lines() {
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        let depth = indent(line);
        if depth == 0 {
            section = line.trim_end_matches(':').trim().to_owned();
            list = None;
            continue;
        }
        match section.as_str() {
            "dependencies" | "optionalDependencies" | "devDependencies" if depth == 2 => {
                if let Some(name) = yaml_key(line) {
                    found_any = true;
                    if section == "devDependencies" {
                        development.insert(name.clone());
                    }
                    direct.insert(name);
                }
            }
            "importers" => {
                let field = line.trim().trim_end_matches(':');
                if depth == 4 {
                    list = matches!(field, "dependencies" | "optionalDependencies" | "devDependencies")
                        .then_some((depth, field == "devDependencies"));
                } else if let Some((at, dev)) = list
                    && depth == at + 2
                    && let Some(name) = yaml_key(line)
                {
                    found_any = true;
                    if dev {
                        development.insert(name.clone());
                    }
                    direct.insert(name);
                } else if depth <= 2 {
                    list = None;
                }
            }
            _ => {}
        }
    }
    Facts {
        direct: found_any.then_some(direct),
        direct_development: development,
        ..Facts::default()
    }
}

/// `Cargo.lock`: the project's own crates have no `source`, and their
/// `dependencies` arrays name what they use directly.
fn cargo_lock(text: &str) -> Facts {
    let mut direct = BTreeSet::new();
    let mut local = false;
    let mut in_dependencies = false;
    let mut pending: Vec<String> = Vec::new();
    let flush = |local: bool, pending: &mut Vec<String>, direct: &mut BTreeSet<String>| {
        if local {
            direct.extend(pending.drain(..));
        }
        pending.clear();
    };
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && !in_dependencies {
            flush(local, &mut pending, &mut direct);
            local = trimmed == "[[package]]";
            continue;
        }
        if in_dependencies {
            if trimmed.starts_with(']') {
                in_dependencies = false;
                continue;
            }
            // `"serde"`, `"serde 1.0.0"`, `"serde 1.0.0 (registry+…)"`.
            if let Some(name) = trimmed.trim_end_matches(',').trim_matches('"').split_whitespace().next() {
                pending.push(name.to_owned());
            }
            continue;
        }
        if let Some((key, value)) = trimmed.split_once('=') {
            match key.trim() {
                "source" => local = false,
                "dependencies" => {
                    let value = value.trim();
                    if value.starts_with('[') && value.ends_with(']') {
                        for item in value.trim_matches(['[', ']']).split(',') {
                            if let Some(name) = item.trim().trim_matches('"').split_whitespace().next() {
                                pending.push(name.to_owned());
                            }
                        }
                    } else {
                        in_dependencies = true;
                    }
                }
                _ => {}
            }
        }
    }
    flush(local, &mut pending, &mut direct);
    Facts { direct: Some(direct), ..Facts::default() }
}

/// `go.mod`: a requirement marked `// indirect` is transitive.
fn go_mod(text: &str) -> Facts {
    let mut direct = BTreeSet::new();
    let mut block = false;
    for raw in text.lines() {
        let indirect = raw.contains("// indirect");
        let line = raw.split("//").next().unwrap_or_default().trim();
        if block {
            if line == ")" {
                block = false;
                continue;
            }
        } else if line.starts_with("require (") || line == "require(" {
            block = true;
            continue;
        }
        let line = if block { line } else if let Some(rest) = line.strip_prefix("require ") { rest.trim() } else { continue };
        if let Some(module) = line.split_whitespace().next()
            && !indirect
        {
            direct.insert(module.to_owned());
        }
    }
    Facts { direct: Some(direct), ..Facts::default() }
}

/// `requirements.txt`: everything listed is direct, unless pip-compile
/// wrote it, whose `# via` notes say which came from the project's own
/// requirements (`-r requirements.in`) and which from another package.
fn requirements(text: &str) -> Facts {
    let compiled = text.contains("# via");
    let mut direct = BTreeSet::new();
    let mut current: Option<String> = None;
    let mut vias: Vec<String> = Vec::new();
    let finish = |current: &mut Option<String>, vias: &mut Vec<String>, direct: &mut BTreeSet<String>| {
        if let Some(name) = current.take()
            && (!compiled || vias.iter().any(|via| via.starts_with("-r ") || via.starts_with("-c ")))
        {
            direct.insert(name);
        }
        vias.clear();
    };
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(via) = trimmed.strip_prefix("# via") {
            let via = via.trim();
            if !via.is_empty() {
                vias.push(via.to_owned());
            }
            continue;
        }
        if trimmed.starts_with('#') && line.starts_with("    ") {
            // pip-compile lists several sources a line each under `# via`.
            vias.push(trimmed.trim_start_matches('#').trim().to_owned());
            continue;
        }
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('-') {
            continue;
        }
        finish(&mut current, &mut vias, &mut direct);
        let name = trimmed.split(['=', '<', '>', '!', '~', '[', ';', ' ']).next().unwrap_or_default();
        if !name.is_empty() {
            current = Some(Ecosystem::PyPI.normalize(name));
        }
    }
    finish(&mut current, &mut vias, &mut direct);
    Facts { direct: Some(direct), ..Facts::default() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(lockfile: Lockfile, text: &str) -> Vec<String> {
        dependencies(lockfile, "x", text)
            .into_iter()
            .map(|dep| {
                format!(
                    "{}@{} {}{}{}",
                    dep.package.name,
                    dep.package.version,
                    dep.relationship.as_str(),
                    if dep.development { " dev" } else { "" },
                    dep.license.map(|license| format!(" {license}")).unwrap_or_default()
                )
            })
            .collect()
    }

    #[test]
    fn package_lock_says_direct_dev_and_license() {
        let v3 = r#"{"lockfileVersion":3,"packages":{
            "":{"name":"app","version":"1.0.0","dependencies":{"lodash":"^4"},"devDependencies":{"@babel/core":"^7"}},
            "node_modules/lodash":{"version":"4.17.20","license":"MIT"},
            "node_modules/@babel/core":{"version":"7.0.0","dev":true,"license":"MIT"},
            "node_modules/@babel/core/node_modules/semver":{"version":"5.7.0","dev":true,"license":"ISC"}
        }}"#;
        assert_eq!(
            summary(Lockfile::PackageLock, v3),
            ["@babel/core@7.0.0 direct dev MIT", "lodash@4.17.20 direct MIT", "semver@5.7.0 transitive dev ISC"]
        );
        // v1 does not say what is direct.
        let v1 = r#"{"lockfileVersion":1,"dependencies":{"minimist":{"version":"0.0.8","dev":true}}}"#;
        assert_eq!(summary(Lockfile::PackageLock, v1), ["minimist@0.0.8 unknown dev"]);
    }

    #[test]
    fn pnpm_importers_and_top_level_lists() {
        let v9 = "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      lodash:\n        specifier: ^4.17.0\n        version: 4.17.20\n    devDependencies:\n      '@types/node':\n        specifier: ^20\n        version: 20.1.0\n\npackages:\n\n  lodash@4.17.20:\n    resolution: {}\n\n  '@types/node@20.1.0':\n    resolution: {}\n\n  undici-types@5.26.5:\n    resolution: {}\n";
        assert_eq!(
            summary(Lockfile::PnpmLock, v9),
            ["@types/node@20.1.0 direct dev", "lodash@4.17.20 direct", "undici-types@5.26.5 transitive"]
        );
        let v5 = "lockfileVersion: 5.4\n\nspecifiers:\n  lodash: ^4\n\ndependencies:\n  lodash: 4.17.20\n\npackages:\n\n  /lodash/4.17.20:\n    resolution: {integrity: x}\n  /ms/2.1.2:\n    resolution: {integrity: y}\n";
        assert_eq!(summary(Lockfile::PnpmLock, v5), ["lodash@4.17.20 direct", "ms@2.1.2 transitive"]);
    }

    #[test]
    fn cargo_lock_direct_is_what_the_projects_crates_use() {
        let lock = "version = 3\n\n[[package]]\nname = \"app\"\nversion = \"0.1.0\"\ndependencies = [\n \"serde\",\n \"time 0.1.43\",\n]\n\n[[package]]\nname = \"serde\"\nversion = \"1.0.0\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\ndependencies = [\n \"serde_derive\",\n]\n\n[[package]]\nname = \"serde_derive\"\nversion = \"1.0.0\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\n\n[[package]]\nname = \"time\"\nversion = \"0.1.43\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\n";
        assert_eq!(
            summary(Lockfile::CargoLock, lock),
            ["serde@1.0.0 direct", "serde_derive@1.0.0 transitive", "time@0.1.43 direct"]
        );
    }

    #[test]
    fn go_mod_indirect_and_requirements_via() {
        let module = "module example.com/app\n\nrequire golang.org/x/text v0.3.0\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.6.0 // indirect\n\tgolang.org/x/net v0.7.0\n)\n";
        assert_eq!(
            summary(Lockfile::GoMod, module),
            ["github.com/gin-gonic/gin@v1.6.0 transitive", "golang.org/x/net@v0.7.0 direct", "golang.org/x/text@v0.3.0 direct"]
        );
        let plain = "Django==3.2.0\nrequests==2.19.1\n";
        assert_eq!(summary(Lockfile::Requirements, plain), ["django@3.2.0 direct", "requests@2.19.1 direct"]);
        let compiled = "certifi==2024.2.2\n    # via requests\nrequests==2.31.0\n    # via -r requirements.in\nurllib3==2.2.1\n    # via\n    #   -r requirements.in\n    #   requests\n";
        assert_eq!(
            summary(Lockfile::Requirements, compiled),
            ["certifi@2024.2.2 transitive", "requests@2.31.0 direct", "urllib3@2.2.1 direct"]
        );
        // yarn.lock does not say.
        let yarn = "lodash@^4.17.0:\n  version \"4.17.20\"\n";
        assert_eq!(summary(Lockfile::YarnLock, yarn), ["lodash@4.17.20 unknown"]);
    }

    #[test]
    fn package_urls() {
        assert_eq!(purl(Ecosystem::Npm, "@babel/core", "7.0.0"), "pkg:npm/%40babel/core@7.0.0");
        assert_eq!(purl(Ecosystem::Cargo, "serde", "1.0.0"), "pkg:cargo/serde@1.0.0");
        assert_eq!(purl(Ecosystem::Go, "golang.org/x/net", "v0.7.0"), "pkg:golang/golang.org/x/net@v0.7.0");
        assert_eq!(purl(Ecosystem::PyPI, "Django_Rest", "3.2.0"), "pkg:pypi/django-rest@3.2.0");
    }
}
