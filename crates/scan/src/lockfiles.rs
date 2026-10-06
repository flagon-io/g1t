//! What a project depends on, read from the lockfiles its package managers
//! write: the exact versions that get installed, which is what an advisory
//! is about.

use serde_json::Value;
use std::collections::BTreeSet;

/// A package registry, named as OSV names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Ecosystem {
    Npm,
    Cargo,
    Go,
    PyPI,
}

impl Ecosystem {
    pub const ALL: [Ecosystem; 4] = [Ecosystem::Npm, Ecosystem::Cargo, Ecosystem::Go, Ecosystem::PyPI];

    /// OSV's name, which is also what is stored.
    pub fn osv(self) -> &'static str {
        match self {
            Ecosystem::Npm => "npm",
            Ecosystem::Cargo => "crates.io",
            Ecosystem::Go => "Go",
            Ecosystem::PyPI => "PyPI",
        }
    }

    pub fn parse(name: &str) -> Option<Ecosystem> {
        Ecosystem::ALL.into_iter().find(|ecosystem| ecosystem.osv() == name)
    }

    /// Package names compared as the registry compares them.
    pub fn normalize(self, name: &str) -> String {
        match self {
            Ecosystem::PyPI => name.to_lowercase().replace(['_', '.'], "-"),
            _ => name.to_owned(),
        }
    }
}

/// The lockfiles g1t reads, by file name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lockfile {
    PackageLock,
    PnpmLock,
    YarnLock,
    CargoLock,
    GoMod,
    GoSum,
    Requirements,
    PoetryLock,
}

impl Lockfile {
    pub const NAMES: [&'static str; 8] = [
        "package-lock.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "Cargo.lock",
        "go.mod",
        "go.sum",
        "requirements.txt",
        "poetry.lock",
    ];

    pub fn for_path(path: &str) -> Option<Lockfile> {
        Some(match path.rsplit('/').next().unwrap_or(path) {
            "package-lock.json" => Lockfile::PackageLock,
            "pnpm-lock.yaml" => Lockfile::PnpmLock,
            "yarn.lock" => Lockfile::YarnLock,
            "Cargo.lock" => Lockfile::CargoLock,
            "go.mod" => Lockfile::GoMod,
            "go.sum" => Lockfile::GoSum,
            "requirements.txt" => Lockfile::Requirements,
            "poetry.lock" => Lockfile::PoetryLock,
            _ => return None,
        })
    }

    pub fn ecosystem(self) -> Ecosystem {
        match self {
            Lockfile::PackageLock | Lockfile::PnpmLock | Lockfile::YarnLock => Ecosystem::Npm,
            Lockfile::CargoLock => Ecosystem::Cargo,
            Lockfile::GoMod | Lockfile::GoSum => Ecosystem::Go,
            Lockfile::Requirements | Lockfile::PoetryLock => Ecosystem::PyPI,
        }
    }

    pub fn parse(self, text: &str) -> Vec<Package> {
        let found = match self {
            Lockfile::PackageLock => package_lock(text),
            Lockfile::PnpmLock => pnpm_lock(text),
            Lockfile::YarnLock => yarn_lock(text),
            Lockfile::CargoLock => toml_packages(text, true),
            Lockfile::GoMod => go_mod(text),
            Lockfile::GoSum => go_sum(text),
            Lockfile::Requirements => requirements(text),
            Lockfile::PoetryLock => toml_packages(text, false),
        };
        let ecosystem = self.ecosystem();
        let unique: BTreeSet<(String, String)> = found
            .into_iter()
            .filter(|(name, version)| !name.is_empty() && version.starts_with(|c: char| c.is_ascii_digit() || c == 'v'))
            .map(|(name, version)| (ecosystem.normalize(&name), version))
            .collect();
        unique
            .into_iter()
            .map(|(name, version)| Package { ecosystem, name, version })
            .collect()
    }
}

/// One package at one version.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Package {
    pub ecosystem: Ecosystem,
    pub name: String,
    pub version: String,
}

/// `package-lock.json` (and `npm-shrinkwrap.json`): lockfile v2 and v3 list
/// every installed path under `packages`; v1 nests `dependencies`.
fn package_lock(text: &str) -> Vec<(String, String)> {
    let Ok(lock) = serde_json::from_str::<Value>(text) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    if let Some(packages) = lock.get("packages").and_then(Value::as_object) {
        for (path, entry) in packages {
            let Some(at) = path.rfind("node_modules/") else {
                continue; // the project itself, or one of its workspaces
            };
            if entry.get("link").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            let name = entry
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(&path[at + "node_modules/".len()..]);
            if let Some(version) = entry.get("version").and_then(Value::as_str) {
                found.push((name.to_owned(), version.to_owned()));
            }
        }
        return found;
    }
    fn walk(dependencies: &Value, found: &mut Vec<(String, String)>) {
        let Some(dependencies) = dependencies.as_object() else {
            return;
        };
        for (name, entry) in dependencies {
            if let Some(version) = entry.get("version").and_then(Value::as_str) {
                found.push((name.clone(), version.to_owned()));
            }
            if let Some(nested) = entry.get("dependencies") {
                walk(nested, found);
            }
        }
    }
    if let Some(dependencies) = lock.get("dependencies") {
        walk(dependencies, &mut found);
    }
    found
}

/// `name@version` or `name/version`, as pnpm writes a package's key, with
/// the peer-dependency suffix that follows removed.
fn pnpm_key(key: &str) -> Option<(String, String)> {
    let key = key.trim().trim_end_matches(':').trim_matches(['\'', '"']);
    let key = key.strip_prefix('/').unwrap_or(key);
    let key = key.split('(').next().unwrap_or(key);
    // A scoped name has one slash in it, any other none.
    let named = |name: &str| !name.is_empty() && name.matches('/').count() == usize::from(name.starts_with('@'));
    // `@scope/name@1.0.0`: the version follows the last `@` after the first character.
    if let Some(at) = key.get(1..).and_then(|rest| rest.rfind('@')).map(|at| at + 1) {
        let (name, version) = (&key[..at], &key[at + 1..]);
        if named(name) {
            return Some((name.to_owned(), version.split('_').next().unwrap_or_default().to_owned()));
        }
    }
    // Lockfile v5: `/name/1.0.0_peer@2.0.0` or `/@scope/name/1.0.0`.
    let key = key.split('_').next().unwrap_or(key);
    let (name, version) = key.rsplit_once('/')?;
    named(name).then(|| (name.to_owned(), version.to_owned()))
}

/// `pnpm-lock.yaml`: each package is a two-space-indented key under the
/// top-level `packages:`.
fn pnpm_lock(text: &str) -> Vec<(String, String)> {
    let mut found = Vec::new();
    let mut inside = false;
    for line in text.lines() {
        if !line.starts_with(' ') && !line.trim().is_empty() {
            inside = line.trim_end() == "packages:";
            continue;
        }
        if !inside || !line.starts_with("  ") || line.starts_with("   ") || !line.trim_end().ends_with(':') {
            continue;
        }
        if let Some(package) = pnpm_key(line) {
            found.push(package);
        }
    }
    found
}

/// `yarn.lock`, classic and Berry: a header naming the package and the
/// ranges it satisfies, then an indented `version`.
fn yarn_lock(text: &str) -> Vec<(String, String)> {
    let mut found = Vec::new();
    let mut name: Option<String> = None;
    for line in text.lines() {
        if line.starts_with('#') || line.trim().is_empty() {
            continue;
        }
        if !line.starts_with(' ') {
            name = None;
            let first = line.trim_end_matches(':').split(',').next().unwrap_or_default();
            let spec = first.trim().trim_matches('"');
            if spec.contains("@workspace:") || spec.contains("@patch:") || spec.contains("@link:") {
                continue;
            }
            if let Some(at) = spec[1.min(spec.len())..].find('@').map(|at| at + 1) {
                name = Some(spec[..at].to_owned());
            }
            continue;
        }
        let trimmed = line.trim();
        if let (Some(current), Some(rest)) = (&name, trimmed.strip_prefix("version")) {
            let version = rest.trim_start_matches(':').trim().trim_matches('"');
            found.push((current.clone(), version.to_owned()));
            name = None;
        }
    }
    found
}

/// `Cargo.lock` and `poetry.lock`: `[[package]]` tables with `name` and
/// `version`. For Cargo only crates from a registry count; the project's
/// own crates have no `source`.
fn toml_packages(text: &str, registry_only: bool) -> Vec<(String, String)> {
    let mut found = Vec::new();
    let mut current: Option<(Option<String>, Option<String>, bool)> = None;
    let mut finish = |current: &mut Option<(Option<String>, Option<String>, bool)>| {
        if let Some((Some(name), Some(version), from_registry)) = current.take()
            && (!registry_only || from_registry)
        {
            found.push((name, version));
        }
    };
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            finish(&mut current);
            if line == "[[package]]" {
                current = Some((None, None, false));
            }
            continue;
        }
        let Some(entry) = current.as_mut() else {
            continue;
        };
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim().trim_matches('"').to_owned();
        match key.trim() {
            "name" => entry.0 = Some(value),
            "version" => entry.1 = Some(value),
            "source" => entry.2 = value.starts_with("registry+") || value.starts_with("sparse+"),
            _ => {}
        }
    }
    finish(&mut current);
    found
}

/// `go.mod`'s `require` lines, in a block or one at a time: the versions
/// the build actually uses.
fn go_mod(text: &str) -> Vec<(String, String)> {
    let mut found = Vec::new();
    let mut block = false;
    for line in text.lines() {
        let line = line.split("//").next().unwrap_or_default().trim();
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
        let mut words = line.split_whitespace();
        if let (Some(module), Some(version)) = (words.next(), words.next()) {
            found.push((module.to_owned(), version.to_owned()));
        }
    }
    found
}

/// `go.sum` lists every version a build ever considered; the highest of
/// each module is the one in use.
fn go_sum(text: &str) -> Vec<(String, String)> {
    let mut highest: std::collections::BTreeMap<String, String> = Default::default();
    for line in text.lines() {
        let mut words = line.split_whitespace();
        let (Some(module), Some(version)) = (words.next(), words.next()) else {
            continue;
        };
        let version = version.trim_end_matches("/go.mod");
        let keep = highest
            .get(module)
            .is_none_or(|current| crate::version::compare(version, current).is_gt());
        if keep {
            highest.insert(module.to_owned(), version.to_owned());
        }
    }
    highest.into_iter().collect()
}

/// `requirements.txt`: only pinned lines, `name==1.2.3`, say what is
/// installed.
fn requirements(text: &str) -> Vec<(String, String)> {
    let mut found = Vec::new();
    for line in text.lines() {
        let line = line.split('#').next().unwrap_or_default();
        let line = line.split(';').next().unwrap_or_default().trim();
        if line.starts_with('-') || line.contains("://") {
            continue;
        }
        let Some((name, version)) = line.split_once("===").or_else(|| line.split_once("==")) else {
            continue;
        };
        let name = name.split('[').next().unwrap_or_default().trim();
        let version = version.split([',', ' ']).next().unwrap_or_default().trim();
        if !name.is_empty() && !version.contains('*') {
            found.push((name.to_owned(), version.to_owned()));
        }
    }
    found
}

/// A shell command that fails while `lockfile` still resolves `name` at
/// `version`: a check for an upgrade, which passes only once
/// the vulnerable version is gone from the lockfile.
pub fn still_locked_check(lockfile: Lockfile, path: &str, name: &str, version: &str) -> String {
    let quote = |text: &str| format!("'{}'", text.replace('\'', "'\\''"));
    let escape = |text: &str| {
        text.chars()
            .flat_map(|c| if ".[]^$*+?(){}|\\".contains(c) { vec!['\\', c] } else { vec![c] })
            .collect::<String>()
    };
    let file = quote(path);
    match lockfile {
        Lockfile::PackageLock => format!(
            "node -e {} {file}",
            quote(&format!(
                "const l=require(require('path').resolve(process.argv[1]));const hit=Object.entries(l.packages||{{}}).some(([k,p])=>k.endsWith('node_modules/{name}')&&p.version==='{version}');process.exit(hit?1:0)"
            ))
        ),
        Lockfile::PnpmLock => format!(
            "! grep -Eq {} {file}",
            quote(&format!("^ +'?/?{}[@/]{}[:(_']", escape(name), escape(version)))
        ),
        Lockfile::YarnLock => format!(
            "! grep -A3 -E {} {file} | grep -Eq {}",
            quote(&format!("^\"?{}@", escape(name))),
            quote(&format!("^ +version:? \"?{}\"?$", escape(version)))
        ),
        Lockfile::CargoLock | Lockfile::PoetryLock => format!(
            "! grep -A1 -x {} {file} | grep -qx {}",
            quote(&format!("name = \"{name}\"")),
            quote(&format!("version = \"{version}\""))
        ),
        Lockfile::GoMod | Lockfile::GoSum => format!(
            "! grep -Eq {} {file}",
            quote(&format!("(^|[[:space:]]){} {}([[:space:]]|/|$)", escape(name), escape(version)))
        ),
        Lockfile::Requirements => format!(
            "! grep -Eiq {} {file}",
            quote(&format!("^{}(\\[.*\\])? *===? *{}([^0-9.]|$)", escape(name).replace('-', "[-_.]"), escape(version)))
        ),
    }
}

/// The command that runs a project's tests, by what its lockfile says it is.
pub fn test_command(lockfile: Lockfile, directory: &str) -> Option<String> {
    let cd = if directory.is_empty() { String::new() } else { format!("cd '{directory}' && ") };
    Some(match lockfile {
        Lockfile::PackageLock => format!("{cd}npm ci && npm test --if-present"),
        Lockfile::PnpmLock => format!("{cd}pnpm install --frozen-lockfile && pnpm test --if-present"),
        Lockfile::YarnLock => format!("{cd}yarn install --immutable || yarn install --frozen-lockfile; yarn test"),
        Lockfile::CargoLock => format!("{cd}cargo test --locked"),
        Lockfile::GoMod | Lockfile::GoSum => format!("{cd}go test ./..."),
        Lockfile::Requirements | Lockfile::PoetryLock => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(lockfile: Lockfile, text: &str) -> Vec<String> {
        lockfile
            .parse(text)
            .into_iter()
            .map(|package| format!("{}@{}", package.name, package.version))
            .collect()
    }

    #[test]
    fn package_lock_v3_and_v1() {
        let v3 = r#"{"lockfileVersion":3,"packages":{
            "":{"name":"app","version":"1.0.0"},
            "node_modules/lodash":{"version":"4.17.20"},
            "node_modules/@babel/core":{"version":"7.0.0"},
            "node_modules/a/node_modules/lodash":{"version":"4.17.4"},
            "packages/web":{"version":"0.1.0"},
            "node_modules/web":{"resolved":"packages/web","link":true}
        }}"#;
        assert_eq!(names(Lockfile::PackageLock, v3), ["@babel/core@7.0.0", "lodash@4.17.20", "lodash@4.17.4"]);
        let v1 = r#"{"lockfileVersion":1,"dependencies":{"minimist":{"version":"0.0.8","dependencies":{"x":{"version":"1.0.0"}}}}}"#;
        assert_eq!(names(Lockfile::PackageLock, v1), ["minimist@0.0.8", "x@1.0.0"]);
    }

    #[test]
    fn pnpm_lock_v5_v6_and_v9() {
        let v5 = "lockfileVersion: 5.4\npackages:\n  /lodash/4.17.20:\n    resolution: {integrity: x}\n  /@babel/core/7.0.0_react@18.0.0:\n    dev: true\n";
        assert_eq!(names(Lockfile::PnpmLock, v5), ["@babel/core@7.0.0", "lodash@4.17.20"]);
        let v6 = "lockfileVersion: '6.0'\npackages:\n  /lodash@4.17.20:\n    resolution: {}\n  /@types/node@20.1.0(typescript@5.0.0):\n    dev: true\n";
        assert_eq!(names(Lockfile::PnpmLock, v6), ["@types/node@20.1.0", "lodash@4.17.20"]);
        let v9 = "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies: {}\npackages:\n  lodash@4.17.20:\n    resolution: {}\n  '@babel/core@7.24.0':\n    resolution: {}\nsnapshots:\n  lodash@4.17.20: {}\n";
        assert_eq!(names(Lockfile::PnpmLock, v9), ["@babel/core@7.24.0", "lodash@4.17.20"]);
    }

    #[test]
    fn yarn_classic_and_berry() {
        let classic = "# yarn lockfile v1\n\nlodash@^4.17.0, lodash@^4.17.15:\n  version \"4.17.20\"\n  resolved \"x\"\n\n\"@babel/core@^7.0.0\":\n  version \"7.1.0\"\n";
        assert_eq!(names(Lockfile::YarnLock, classic), ["@babel/core@7.1.0", "lodash@4.17.20"]);
        let berry = "__metadata:\n  version: 6\n\n\"lodash@npm:^4.17.0\":\n  version: 4.17.20\n  resolution: \"lodash@npm:4.17.20\"\n\n\"app@workspace:.\":\n  version: 0.0.0-use.local\n";
        assert_eq!(names(Lockfile::YarnLock, berry), ["lodash@4.17.20"]);
    }

    #[test]
    fn cargo_lock_counts_registry_crates_only() {
        let lock = "version = 3\n\n[[package]]\nname = \"app\"\nversion = \"0.1.0\"\n\n[[package]]\nname = \"time\"\nversion = \"0.1.43\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\nchecksum = \"x\"\n\n[[package]]\nname = \"smallvec\"\nversion = \"1.6.0\"\nsource = \"sparse+https://index.crates.io/\"\n";
        assert_eq!(names(Lockfile::CargoLock, lock), ["smallvec@1.6.0", "time@0.1.43"]);
    }

    #[test]
    fn go_mod_and_go_sum() {
        let module = "module example.com/app\n\ngo 1.22\n\nrequire golang.org/x/text v0.3.0\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.6.0 // indirect\n\tgolang.org/x/net v0.7.0\n)\n";
        assert_eq!(
            names(Lockfile::GoMod, module),
            ["github.com/gin-gonic/gin@v1.6.0", "golang.org/x/net@v0.7.0", "golang.org/x/text@v0.3.0"]
        );
        let sum = "golang.org/x/text v0.3.0 h1:x=\ngolang.org/x/text v0.3.0/go.mod h1:y=\ngolang.org/x/text v0.3.8 h1:z=\n";
        assert_eq!(names(Lockfile::GoSum, sum), ["golang.org/x/text@v0.3.8"]);
    }

    #[test]
    fn requirements_and_poetry() {
        let requirements = "# web\nDjango==3.2.0\nrequests[security]==2.19.1 ; python_version >= '3'\nflask>=2.0\n-r other.txt\nPyYAML===5.3\n";
        assert_eq!(names(Lockfile::Requirements, requirements), ["django@3.2.0", "pyyaml@5.3", "requests@2.19.1"]);
        let poetry = "[[package]]\nname = \"Jinja2\"\nversion = \"2.10\"\ndescription = \"x\"\n\n[package.dependencies]\nMarkupSafe = \">=0.23\"\n\n[[package]]\nname = \"urllib3\"\nversion = \"1.24.1\"\n\n[metadata]\nlock-version = \"2.0\"\n";
        assert_eq!(names(Lockfile::PoetryLock, poetry), ["jinja2@2.10", "urllib3@1.24.1"]);
    }

    #[test]
    fn the_check_names_the_file_and_the_version() {
        let check = still_locked_check(Lockfile::CargoLock, "Cargo.lock", "time", "0.1.43");
        assert_eq!(check, "! grep -A1 -x 'name = \"time\"' 'Cargo.lock' | grep -qx 'version = \"0.1.43\"'");
        let npm = still_locked_check(Lockfile::PackageLock, "web/package-lock.json", "lodash", "4.17.20");
        assert!(npm.starts_with("node -e '") && npm.ends_with(" 'web/package-lock.json'"));
        assert!(npm.contains("node_modules/lodash") && npm.contains("4.17.20"));
        let go = still_locked_check(Lockfile::GoMod, "go.mod", "golang.org/x/net", "v0.7.0");
        assert!(go.contains("golang\\.org/x/net v0\\.7\\.0"));
        assert_eq!(test_command(Lockfile::CargoLock, ""), Some("cargo test --locked".to_owned()));
        assert_eq!(test_command(Lockfile::PackageLock, "web").as_deref(), Some("cd 'web' && npm ci && npm test --if-present"));
    }
}
