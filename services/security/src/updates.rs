//! Version updates: reading `.g1t/dependencies.yml`, which says which
//! dependencies to keep current, how often, grouped how, and which to
//! leave alone. The file is read and checked on every dependency scan and
//! what it says is shown on the Security page; opening pull requests for
//! new versions is not built yet, and the page says so.

use g1t_contracts::security::{UpdateGroup, UpdateIgnore, VersionUpdateEntry};
use serde_yaml::{Mapping, Value};

/// Where the file lives on the default branch.
pub const PATH: &str = ".g1t/dependencies.yml";
/// What each entry's `ecosystem` may be.
pub const ECOSYSTEMS: [&str; 4] = ["npm", "cargo", "go", "pip"];
pub const INTERVALS: [&str; 3] = ["daily", "weekly", "monthly"];
const DEFAULT_LIMIT: u32 = 5;
const MAX_LIMIT: u64 = 20;
const MAX_ENTRIES: usize = 50;

const ENTRY_KEYS: [&str; 6] = ["ecosystem", "directory", "schedule", "open-pull-requests-limit", "groups", "ignore"];

fn key<'a>(map: &'a Mapping, name: &str) -> Option<&'a Value> {
    map.get(Value::String(name.to_owned()))
}

fn text(value: &Value, what: &str) -> Result<String, String> {
    match value {
        Value::String(text) => Ok(text.trim().to_owned()),
        Value::Number(number) => Ok(number.to_string()),
        _ => Err(format!("{what} must be text.")),
    }
}

fn texts(value: &Value, what: &str) -> Result<Vec<String>, String> {
    match value {
        Value::Sequence(items) => items.iter().map(|item| text(item, what)).collect(),
        Value::String(_) => Ok(vec![text(value, what)?]),
        _ => Err(format!("{what} must be a list.")),
    }
}

/// The directory as the file means it: from the repository's root, with a
/// leading `/` and no trailing one.
fn directory(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.split('/').any(|part| part == "..") {
        return Err(format!("directory {raw} must stay inside the repository."));
    }
    Ok(if trimmed.is_empty() { "/".to_owned() } else if trimmed.starts_with('/') { trimmed.to_owned() } else { format!("/{trimmed}") })
}

fn entry(index: usize, value: &Value) -> Result<VersionUpdateEntry, String> {
    let at = |message: String| format!("updates[{index}]: {message}");
    let Value::Mapping(map) = value else {
        return Err(at("each entry must be a mapping with an ecosystem.".to_owned()));
    };
    for name in map.keys() {
        let name = name.as_str().unwrap_or_default();
        if !ENTRY_KEYS.contains(&name) {
            return Err(at(format!("unknown key {name}. Allowed: {}.", ENTRY_KEYS.join(", "))));
        }
    }
    let ecosystem = text(key(map, "ecosystem").ok_or_else(|| at("ecosystem is required.".to_owned()))?, "ecosystem").map_err(at)?;
    if !ECOSYSTEMS.contains(&ecosystem.as_str()) {
        return Err(at(format!("ecosystem {ecosystem} is not one of {}.", ECOSYSTEMS.join(", "))));
    }
    let directory = match key(map, "directory") {
        Some(value) => directory(&text(value, "directory").map_err(at)?).map_err(at)?,
        None => "/".to_owned(),
    };
    let interval = match key(map, "schedule") {
        None => "weekly".to_owned(),
        Some(Value::Mapping(schedule)) => {
            for name in schedule.keys() {
                if name.as_str() != Some("interval") {
                    return Err(at(format!("schedule takes only interval, not {}.", name.as_str().unwrap_or("that"))));
                }
            }
            match key(schedule, "interval") {
                Some(value) => text(value, "schedule.interval").map_err(at)?,
                None => "weekly".to_owned(),
            }
        }
        Some(_) => return Err(at("schedule must be a mapping, such as schedule: { interval: weekly }.".to_owned())),
    };
    if !INTERVALS.contains(&interval.as_str()) {
        return Err(at(format!("schedule.interval {interval} is not one of {}.", INTERVALS.join(", "))));
    }
    let open_pull_requests_limit = match key(map, "open-pull-requests-limit") {
        None => DEFAULT_LIMIT,
        Some(Value::Number(number)) => match number.as_u64() {
            Some(limit) if limit <= MAX_LIMIT => limit as u32,
            _ => return Err(at(format!("open-pull-requests-limit must be a whole number from 0 to {MAX_LIMIT}."))),
        },
        Some(_) => return Err(at(format!("open-pull-requests-limit must be a whole number from 0 to {MAX_LIMIT}."))),
    };
    let mut groups = Vec::new();
    match key(map, "groups") {
        None => {}
        Some(Value::Mapping(found)) => {
            for (name, group) in found {
                let name = text(name, "a group's name").map_err(at)?;
                let Value::Mapping(group) = group else {
                    return Err(at(format!("group {name} must be a mapping with patterns.")));
                };
                let patterns = texts(
                    key(group, "patterns").ok_or_else(|| at(format!("group {name} needs patterns.")))?,
                    "patterns",
                )
                .map_err(at)?;
                if patterns.is_empty() || patterns.iter().any(String::is_empty) {
                    return Err(at(format!("group {name} needs at least one pattern.")));
                }
                groups.push(UpdateGroup { name, patterns });
            }
        }
        Some(_) => return Err(at("groups must be a mapping of group names to patterns.".to_owned())),
    }
    let mut ignore = Vec::new();
    match key(map, "ignore") {
        None => {}
        Some(Value::Sequence(items)) => {
            for item in items {
                let Value::Mapping(item) = item else {
                    return Err(at("each ignore entry must be a mapping with a dependency.".to_owned()));
                };
                let dependency = text(
                    key(item, "dependency").ok_or_else(|| at("each ignore entry needs a dependency.".to_owned()))?,
                    "dependency",
                )
                .map_err(at)?;
                let versions = match key(item, "versions") {
                    Some(value) => texts(value, "versions").map_err(at)?,
                    None => Vec::new(),
                };
                ignore.push(UpdateIgnore { dependency, versions });
            }
        }
        Some(_) => return Err(at("ignore must be a list.".to_owned())),
    }
    Ok(VersionUpdateEntry { ecosystem, directory, interval, groups, ignore, open_pull_requests_limit })
}

/// The entries of a `.g1t/dependencies.yml`, or what is wrong with it, in a
/// sentence a person can act on.
pub fn parse(source: &str) -> Result<Vec<VersionUpdateEntry>, String> {
    let root: Value = serde_yaml::from_str(source).map_err(|error| format!("{PATH} is not valid YAML: {error}"))?;
    let Value::Mapping(root) = root else {
        return Err(format!("{PATH} must be a mapping with version and updates."));
    };
    for name in root.keys() {
        let name = name.as_str().unwrap_or_default();
        if name != "version" && name != "updates" {
            return Err(format!("unknown key {name}. Allowed: version, updates."));
        }
    }
    match key(&root, "version") {
        None => {}
        Some(Value::Number(number)) if number.as_u64() == Some(1) => {}
        Some(_) => return Err("version must be 1.".to_owned()),
    }
    let Some(Value::Sequence(items)) = key(&root, "updates") else {
        return Err("updates must be a list of entries.".to_owned());
    };
    if items.len() > MAX_ENTRIES {
        return Err(format!("updates has {} entries; at most {MAX_ENTRIES}.", items.len()));
    }
    let mut entries: Vec<VersionUpdateEntry> = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let found = entry(index, item)?;
        if entries.iter().any(|other| other.ecosystem == found.ecosystem && other.directory == found.directory) {
            return Err(format!(
                "updates[{index}]: {} in {} is listed twice.",
                found.ecosystem, found.directory
            ));
        }
        entries.push(found);
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_full_file_is_read() {
        let source = r#"
version: 1
updates:
  - ecosystem: npm
    directory: web/
    schedule:
      interval: daily
    open-pull-requests-limit: 3
    groups:
      lint:
        patterns: ["eslint*", "@typescript-eslint/*"]
    ignore:
      - dependency: react
        versions: [">=19"]
      - dependency: left-pad
  - ecosystem: cargo
"#;
        let entries = parse(source).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].directory, "/web");
        assert_eq!(entries[0].interval, "daily");
        assert_eq!(entries[0].open_pull_requests_limit, 3);
        assert_eq!(entries[0].groups, vec![UpdateGroup { name: "lint".into(), patterns: vec!["eslint*".into(), "@typescript-eslint/*".into()] }]);
        assert_eq!(entries[0].ignore[0], UpdateIgnore { dependency: "react".into(), versions: vec![">=19".into()] });
        assert!(entries[0].ignore[1].versions.is_empty());
        // Defaults.
        assert_eq!((entries[1].directory.as_str(), entries[1].interval.as_str(), entries[1].open_pull_requests_limit), ("/", "weekly", 5));
    }

    #[test]
    fn mistakes_are_named() {
        for (source, said) in [
            ("updates: []\nextra: 1", "unknown key extra"),
            ("version: 2\nupdates: []", "version must be 1"),
            ("version: 1", "updates must be a list"),
            ("updates:\n  - ecosystem: maven", "ecosystem maven is not one of"),
            ("updates:\n  - directory: /", "ecosystem is required"),
            ("updates:\n  - ecosystem: npm\n    schedule:\n      interval: hourly", "interval hourly"),
            ("updates:\n  - ecosystem: npm\n    open-pull-requests-limit: 99", "0 to 20"),
            ("updates:\n  - ecosystem: npm\n  - ecosystem: npm\n    directory: /", "listed twice"),
            ("updates:\n  - ecosystem: npm\n    directory: ../x", "inside the repository"),
            ("updates:\n  - ecosystem: npm\n    labels: [deps]", "unknown key labels"),
            ("updates:\n  - ecosystem: npm\n    groups:\n      a: {}", "needs patterns"),
            ("updates: [", "not valid YAML"),
        ] {
            let error = parse(source).unwrap_err();
            assert!(error.contains(said), "{source:?}: {error}");
        }
    }
}
