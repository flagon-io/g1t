//! Which dependencies a project names itself, from its manifests: what
//! version updates keep current by default (`allow`'s `direct`), and
//! whether each is for production or development.

use serde_json::Value;

/// How a project depends on a package.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum DependencyType {
    /// Named in a manifest, needed to run.
    Production,
    /// Named in a manifest, needed only to build or test.
    Development,
    /// Not named: something else depends on it.
    Indirect,
}

impl DependencyType {
    /// As update pull requests' commit messages put it.
    pub fn label(self) -> &'static str {
        match self {
            DependencyType::Production => "direct:production",
            DependencyType::Development => "direct:development",
            DependencyType::Indirect => "indirect",
        }
    }

    pub fn direct(self) -> bool {
        self != DependencyType::Indirect
    }

    /// Whether `allow`'s or a group's `dependency-type` covers it.
    pub fn is(self, kind: &str) -> bool {
        match kind {
            "all" => true,
            "direct" => self.direct(),
            "indirect" => self == DependencyType::Indirect,
            "production" => self == DependencyType::Production,
            "development" => self == DependencyType::Development,
            _ => false,
        }
    }
}

/// A dependency a manifest names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Declared {
    pub name: String,
    /// The requirement as written: `^1.2.0`, `1.2`, `>=2,<3`; none when it
    /// names no version.
    pub requirement: Option<String>,
    pub kind: DependencyType,
}

/// The manifest files each supported ecosystem keeps in a directory.
pub fn manifest_names(ecosystem: &str) -> &'static [&'static str] {
    match ecosystem {
        "npm" => &["package.json"],
        "cargo" => &["Cargo.toml"],
        "gomod" => &["go.mod"],
        "pip" => &["requirements.txt", "pyproject.toml"],
        _ => &[],
    }
}

fn push(found: &mut Vec<Declared>, name: &str, requirement: Option<String>, kind: DependencyType) {
    if name.is_empty() {
        return;
    }
    match found.iter_mut().find(|known| known.name == name) {
        // Production wins over development when a package is both.
        Some(known) if kind < known.kind => {
            known.kind = kind;
            known.requirement = requirement.or(known.requirement.take());
        }
        Some(_) => {}
        None => found.push(Declared { name: name.to_owned(), requirement, kind }),
    }
}

/// `package.json`: `dependencies` and `optionalDependencies` are for
/// production, `devDependencies` for development. Packages from anywhere
/// but the registry (a path, a workspace, git, an alias) are left out.
pub fn package_json(text: &str) -> Vec<Declared> {
    let Ok(manifest) = serde_json::from_str::<Value>(text) else { return Vec::new() };
    let mut found = Vec::new();
    for (section, kind) in [
        ("dependencies", DependencyType::Production),
        ("optionalDependencies", DependencyType::Production),
        ("devDependencies", DependencyType::Development),
    ] {
        let Some(entries) = manifest.get(section).and_then(Value::as_object) else { continue };
        for (name, range) in entries {
            let Some(range) = range.as_str() else { continue };
            if range.contains(':') || range.contains('/') {
                continue;
            }
            push(&mut found, name, Some(range.to_owned()), kind);
        }
    }
    found
}

/// `Cargo.toml`: `[dependencies]` and `[build-dependencies]` are for
/// production, `[dev-dependencies]` for development, in a workspace's
/// `[workspace.dependencies]` and per target too. A crate renamed with
/// `package = "…"` is listed by its real name; one from a path or git with
/// no version is left out.
pub fn cargo_toml(text: &str) -> Vec<Declared> {
    let Ok(manifest) = toml::from_str::<toml::Value>(text) else { return Vec::new() };
    let mut found = Vec::new();
    let mut read = |table: Option<&toml::Value>, kind: DependencyType| {
        let Some(table) = table.and_then(toml::Value::as_table) else { return };
        for (key, spec) in table {
            let (name, requirement) = match spec {
                toml::Value::String(requirement) => (key.clone(), Some(requirement.clone())),
                toml::Value::Table(fields) => {
                    if fields.get("workspace").and_then(toml::Value::as_bool) == Some(true) {
                        continue;
                    }
                    let Some(version) = fields.get("version").and_then(toml::Value::as_str) else { continue };
                    let name = fields.get("package").and_then(toml::Value::as_str).unwrap_or(key);
                    (name.to_owned(), Some(version.to_owned()))
                }
                _ => continue,
            };
            push(&mut found, &name, requirement, kind);
        }
    };
    let sections = [
        ("dependencies", DependencyType::Production),
        ("build-dependencies", DependencyType::Production),
        ("dev-dependencies", DependencyType::Development),
    ];
    for (section, kind) in sections {
        read(manifest.get(section), kind);
        read(manifest.get("workspace").and_then(|workspace| workspace.get(section)), kind);
    }
    if let Some(targets) = manifest.get("target").and_then(toml::Value::as_table) {
        for target in targets.values() {
            for (section, kind) in sections {
                read(target.get(section), kind);
            }
        }
    }
    found
}

/// `go.mod`'s `require`s: those marked `// indirect` are indirect, the
/// rest the module's own.
pub fn go_mod(text: &str) -> Vec<Declared> {
    let mut found = Vec::new();
    let mut block = false;
    for raw in text.lines() {
        let (code, comment) = raw.split_once("//").unwrap_or((raw, ""));
        let line = code.trim();
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
            let kind = if comment.trim() == "indirect" { DependencyType::Indirect } else { DependencyType::Production };
            found.push(Declared { name: module.to_owned(), requirement: Some(version.to_owned()), kind });
        }
    }
    found
}

/// A Python package name as PyPI compares it.
pub fn python_name(name: &str) -> String {
    name.trim().to_lowercase().replace(['_', '.'], "-")
}

/// One requirement line: `requests[security]>=2,<3 ; python_version > "3"`.
fn python_requirement(line: &str) -> Option<(String, Option<String>)> {
    let line = line.split(';').next()?.trim();
    let end = line.find(|c: char| !(c.is_ascii_alphanumeric() || "-_.".contains(c))).unwrap_or(line.len());
    let name = &line[..end];
    if name.is_empty() {
        return None;
    }
    let rest = line[end..].trim();
    let rest = match rest.strip_prefix('[') {
        Some(extras) => extras.split_once(']').map_or("", |(_, after)| after).trim(),
        None => rest,
    };
    Some((python_name(name), (!rest.is_empty()).then(|| rest.replace(' ', ""))))
}

/// `requirements.txt`: every package it names is the project's own.
pub fn requirements_txt(text: &str) -> Vec<Declared> {
    let mut found = Vec::new();
    for line in text.lines() {
        let line = line.split(" #").next().unwrap_or_default().trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with('-') || line.contains("://") {
            continue;
        }
        if let Some((name, requirement)) = python_requirement(line) {
            push(&mut found, &name, requirement, DependencyType::Production);
        }
    }
    found
}

/// `pyproject.toml`: `[project]`'s dependencies and Poetry's main group are
/// for production; Poetry's other groups and `dev-dependencies` for
/// development. `python` itself is left out.
pub fn pyproject_toml(text: &str) -> Vec<Declared> {
    let Ok(manifest) = toml::from_str::<toml::Value>(text) else { return Vec::new() };
    let mut found = Vec::new();
    let project = manifest.get("project");
    for requirement in project.and_then(|p| p.get("dependencies")).and_then(toml::Value::as_array).into_iter().flatten() {
        if let Some((name, spec)) = requirement.as_str().and_then(python_requirement) {
            push(&mut found, &name, spec, DependencyType::Production);
        }
    }
    let poetry = manifest.get("tool").and_then(|tool| tool.get("poetry"));
    let mut table = |table: Option<&toml::Value>, kind: DependencyType| {
        for (name, spec) in table.and_then(toml::Value::as_table).into_iter().flatten() {
            if name == "python" {
                continue;
            }
            let requirement = match spec {
                toml::Value::String(text) => Some(text.clone()),
                toml::Value::Table(fields) => match fields.get("version").and_then(toml::Value::as_str) {
                    Some(version) => Some(version.to_owned()),
                    None => continue,
                },
                _ => continue,
            };
            push(&mut found, &python_name(name), requirement, kind);
        }
    };
    table(poetry.and_then(|p| p.get("dependencies")), DependencyType::Production);
    table(poetry.and_then(|p| p.get("dev-dependencies")), DependencyType::Development);
    if let Some(groups) = poetry.and_then(|p| p.get("group")).and_then(toml::Value::as_table) {
        for group in groups.values() {
            table(group.get("dependencies"), DependencyType::Development);
        }
    }
    found
}

/// The dependencies one manifest file names, by its file name.
pub fn declared(file_name: &str, text: &str) -> Vec<Declared> {
    match file_name {
        "package.json" => package_json(text),
        "Cargo.toml" => cargo_toml(text),
        "go.mod" => go_mod(text),
        "requirements.txt" => requirements_txt(text),
        "pyproject.toml" => pyproject_toml(text),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(found: &[Declared]) -> Vec<String> {
        found
            .iter()
            .map(|d| format!("{}@{}:{}", d.name, d.requirement.as_deref().unwrap_or("-"), d.kind.label()))
            .collect()
    }

    #[test]
    fn package_json_by_section() {
        let text = r#"{"dependencies":{"react":"^18.2.0","local":"file:../x","alias":"npm:react@18","ws":"workspace:*"},
            "devDependencies":{"vitest":"~1.0.0","react":"^18.2.0"},"optionalDependencies":{"fsevents":"2.3.3"},
            "peerDependencies":{"react-dom":"*"}}"#;
        assert_eq!(
            names(&package_json(text)),
            ["react@^18.2.0:direct:production", "fsevents@2.3.3:direct:production", "vitest@~1.0.0:direct:development"]
        );
    }

    #[test]
    fn cargo_toml_sections_targets_and_workspaces() {
        let text = r#"
[workspace]
members = ["crates/*", "app"]

[workspace.dependencies]
serde = { version = "1", features = ["derive"] }

[dependencies]
anyhow = "1.0"
local = { path = "../local" }
shared = { workspace = true }
renamed = { package = "real-name", version = "0.3" }

[dev-dependencies]
proptest = "1"

[target.'cfg(unix)'.dependencies]
libc = "0.2"
"#;
        assert_eq!(
            names(&cargo_toml(text)),
            [
                "anyhow@1.0:direct:production",
                "real-name@0.3:direct:production",
                "serde@1:direct:production",
                "proptest@1:direct:development",
                "libc@0.2:direct:production"
            ]
        );
    }

    #[test]
    fn go_mod_marks_indirect() {
        let text = "module x\n\nrequire golang.org/x/text v0.3.0\n\nrequire (\n\tgithub.com/a/b v1.6.0 // indirect\n\tgolang.org/x/net v0.7.0\n)\n";
        assert_eq!(
            names(&go_mod(text)),
            ["golang.org/x/text@v0.3.0:direct:production", "github.com/a/b@v1.6.0:indirect", "golang.org/x/net@v0.7.0:direct:production"]
        );
    }

    #[test]
    fn python_manifests() {
        let requirements = "# web\nDjango==3.2.0\nrequests[security] >= 2.19, < 3 ; python_version >= '3'\nflask\n-r base.txt\nhttps://x/y.whl\n";
        assert_eq!(
            names(&requirements_txt(requirements)),
            ["django@==3.2.0:direct:production", "requests@>=2.19,<3:direct:production", "flask@-:direct:production"]
        );
        let pyproject = r#"
[project]
dependencies = ["Jinja2>=3.0", "Flask_Cors"]

[tool.poetry.dependencies]
python = "^3.11"
requests = "^2.0"
pinned = { version = "1.2.3", optional = true }
fromgit = { git = "https://x" }

[tool.poetry.group.test.dependencies]
pytest = "^7"
"#;
        assert_eq!(
            names(&pyproject_toml(pyproject)),
            [
                "jinja2@>=3.0:direct:production",
                "flask-cors@-:direct:production",
                "pinned@1.2.3:direct:production",
                "requests@^2.0:direct:production",
                "pytest@^7:direct:development"
            ]
        );
    }

    #[test]
    fn dependency_types_as_rules_name_them() {
        assert!(DependencyType::Production.is("direct") && DependencyType::Production.is("production") && DependencyType::Production.is("all"));
        assert!(!DependencyType::Development.is("production") && DependencyType::Development.is("development"));
        assert!(DependencyType::Indirect.is("indirect") && !DependencyType::Indirect.is("direct"));
        assert_eq!(manifest_names("pip"), ["requirements.txt", "pyproject.toml"]);
    }
}
