//! What a version update check decides, given what the registries said:
//! which dependencies it may touch (`allow`), which version each goes to
//! (`ignore`, people's `@g1t ignore` comments, `cooldown`,
//! `versioning-strategy`), and how the updates are gathered into pull
//! requests (`groups`). No I/O, so every rule is tested here.

use std::collections::BTreeMap;

use g1t_contracts::updates::{IgnoreCondition, UpdateGroup};
use g1t_scan::version;

use crate::config::{Entry, matches};
use crate::manifests::DependencyType;
use crate::ranges::{self, Bare};
use crate::registries::Package;

const DAY_MS: u64 = 24 * 60 * 60 * 1000;
/// The cooldown version updates keep without a `cooldown` option.
pub const DEFAULT_COOLDOWN_DAYS: u32 = 3;

/// A dependency the check looked at.
#[derive(Clone, Debug)]
pub struct Candidate {
    pub name: String,
    /// From the repository's root: `/`, `/web`.
    pub directory: String,
    pub kind: DependencyType,
    /// The version the lockfile resolves.
    pub current: String,
    /// What the manifest asks for, when it names it.
    pub requirement: Option<String>,
    pub package: Package,
}

/// One dependency to raise.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Planned {
    pub name: String,
    pub directory: String,
    pub kind: DependencyType,
    pub from: String,
    pub to: String,
    /// `major`, `minor` or `patch`.
    pub level: &'static str,
    pub source: Option<String>,
    pub changelog: Option<String>,
    pub page: Option<String>,
}

/// Why a dependency has no update, for the check's summary.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Skip {
    /// `allow` does not cover it.
    NotAllowed,
    /// An `ignore` rule or a comment covers the dependency itself.
    Ignored,
    /// It is at the newest version the rules let it reach.
    UpToDate,
}

/// Whether `allow` covers a dependency. Without `allow`, every dependency
/// a manifest names is.
pub fn allowed(entry: &Entry, name: &str, kind: DependencyType) -> bool {
    if entry.allow.is_empty() {
        return kind.direct();
    }
    entry.allow.iter().any(|rule| {
        rule.dependency.as_deref().is_none_or(|pattern| matches(pattern, name))
            && rule.dependency_type.as_deref().map_or(kind.direct(), |wanted| kind.is(wanted))
    })
}

/// The levels `allow`'s `update-types` let a dependency rise by; every
/// level when no matching rule limits them.
fn allowed_levels(entry: &Entry, name: &str, kind: DependencyType) -> Option<Vec<String>> {
    let mut levels = Vec::new();
    for rule in &entry.allow {
        let applies = rule.dependency.as_deref().is_none_or(|pattern| matches(pattern, name))
            && rule.dependency_type.as_deref().is_none_or(|wanted| kind.is(wanted));
        if !applies {
            continue;
        }
        if rule.update_types.is_empty() {
            return None;
        }
        levels.extend(rule.update_types.iter().cloned());
    }
    (!levels.is_empty()).then_some(levels)
}

/// How many days a release waits before an update to it, by its level.
fn cooldown_days(entry: &Entry, name: &str, level: &str) -> u32 {
    let Some(cooldown) = &entry.cooldown else { return DEFAULT_COOLDOWN_DAYS };
    if cooldown.exclude.iter().any(|pattern| matches(pattern, name)) {
        return 0;
    }
    if !cooldown.include.is_empty() && !cooldown.include.iter().any(|pattern| matches(pattern, name)) {
        return 0;
    }
    let by_level = match level {
        "major" => cooldown.major_days,
        "minor" => cooldown.minor_days,
        _ => cooldown.patch_days,
    };
    by_level.or(cooldown.default_days).unwrap_or(DEFAULT_COOLDOWN_DAYS)
}

/// How a manifest's bare version reads in `ecosystem`.
fn bare(ecosystem: &str) -> Bare {
    if ecosystem == "cargo" { Bare::Caret } else { Bare::Exact }
}

/// The version `candidate` should reach, or why it has none.
pub fn target(entry: &Entry, comments: &[IgnoreCondition], candidate: &Candidate, now_ms: u64) -> Result<Planned, Skip> {
    let name = candidate.name.as_str();
    if !allowed(entry, name, candidate.kind) {
        return Err(Skip::NotAllowed);
    }
    let rules: Vec<_> = entry.ignore.iter().filter(|rule| matches(&rule.dependency, name)).collect();
    let mine: Vec<&IgnoreCondition> = comments
        .iter()
        .filter(|condition| condition.ecosystem == entry.ecosystem && condition.dependency.eq_ignore_ascii_case(name))
        .collect();
    let whole = |versions_empty: bool, types_empty: bool| versions_empty && types_empty;
    if rules.iter().any(|rule| whole(rule.versions.is_empty(), rule.update_types.is_empty()))
        || mine.iter().any(|condition| whole(condition.versions.is_none(), condition.update_type.is_none()))
    {
        return Err(Skip::Ignored);
    }
    let levels = allowed_levels(entry, name, candidate.kind);
    let lockfile_only = entry.versioning_strategy.as_deref() == Some("lockfile-only") && entry.ecosystem != "gomod";
    let pre = ranges::prerelease(&candidate.current);
    let mut releases: Vec<_> = candidate.package.releases.iter().collect();
    releases.sort_by(|a, b| version::compare(&b.version, &a.version));
    for release in releases {
        let to = release.version.as_str();
        if release.withdrawn || version::compare(to, &candidate.current).is_le() {
            continue;
        }
        if ranges::prerelease(to) && !pre {
            continue;
        }
        let level = ranges::update_level(&candidate.current, to);
        let kind = format!("version-update:semver-{level}");
        if rules.iter().any(|rule| rule.versions.iter().any(|versions| ranges::ignored_by(versions, to)) || rule.update_types.contains(&kind)) {
            continue;
        }
        if mine.iter().any(|condition| {
            condition.versions.as_deref().is_some_and(|versions| ranges::ignored_by(versions, to)) || condition.update_type.as_deref() == Some(&kind)
        }) {
            continue;
        }
        if levels.as_ref().is_some_and(|levels| !levels.contains(&kind)) {
            continue;
        }
        let days = cooldown_days(entry, name, level);
        if days > 0 && release.published_ms.is_some_and(|published| now_ms.saturating_sub(published) < u64::from(days) * DAY_MS) {
            continue;
        }
        if lockfile_only
            && let Some(requirement) = candidate.requirement.as_deref()
            && ranges::satisfies(requirement, to, bare(&entry.ecosystem)) == Some(false)
        {
            continue;
        }
        return Ok(Planned {
            name: candidate.name.clone(),
            directory: candidate.directory.clone(),
            kind: candidate.kind,
            from: candidate.current.clone(),
            to: to.to_owned(),
            level,
            source: candidate.package.source.clone(),
            changelog: candidate.package.changelog.clone(),
            page: candidate.package.page.clone(),
        });
    }
    Err(Skip::UpToDate)
}

/// What one pull request raises.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PullPlan {
    /// The `groups` rule, if any.
    pub group: Option<String>,
    /// `group-by: dependency-name`: one dependency across directories.
    pub by_name: bool,
    pub updates: Vec<Planned>,
}

impl PullPlan {
    /// What the pull request is about, whatever versions it reaches: two
    /// plans with the same subject replace each other.
    pub fn subject(&self) -> String {
        match (&self.group, self.by_name) {
            (Some(group), true) => format!("group:{group}:{}", self.updates[0].name),
            (Some(group), false) => format!("group:{group}"),
            (None, _) => format!("dependency:{}:{}", self.updates[0].directory, self.updates[0].name),
        }
    }

    /// The versions it reaches, to tell a plan from an older one.
    pub fn signature(&self) -> String {
        let mut parts: Vec<String> = self.updates.iter().map(|update| format!("{}{}@{}", update.directory, update.name, update.to)).collect();
        parts.sort();
        parts.join(",")
    }

    pub fn directories(&self) -> Vec<String> {
        let mut directories: Vec<String> = self.updates.iter().map(|update| update.directory.clone()).collect();
        directories.sort();
        directories.dedup();
        directories
    }
}

/// Whether a group gathers this update.
pub fn in_group(group: &UpdateGroup, update: &Planned) -> bool {
    (group.patterns.is_empty() || group.patterns.iter().any(|pattern| matches(pattern, &update.name)))
        && !group.exclude_patterns.iter().any(|pattern| matches(pattern, &update.name))
        && group.dependency_type.as_deref().is_none_or(|kind| update.kind.is(kind))
        && (group.update_types.is_empty() || group.update_types.iter().any(|level| level == update.level))
}

/// Gathers updates into pull requests: each joins the first group of
/// `applies_to` that takes it; the rest go one per dependency and
/// directory. Groups come first, in the file's order.
pub fn gather(groups: &[UpdateGroup], applies_to: &str, updates: Vec<Planned>) -> Vec<PullPlan> {
    let groups: Vec<&UpdateGroup> = groups.iter().filter(|group| group.applies_to == applies_to).collect();
    let mut grouped: BTreeMap<(usize, String), Vec<Planned>> = BTreeMap::new();
    let mut single = Vec::new();
    for update in updates {
        match groups.iter().position(|group| in_group(group, &update)) {
            Some(at) if groups[at].group_by.is_some() => grouped.entry((at, update.name.clone())).or_default().push(update),
            Some(at) => grouped.entry((at, String::new())).or_default().push(update),
            None => single.push(update),
        }
    }
    let mut plans: Vec<PullPlan> = grouped
        .into_iter()
        .map(|((at, _), mut updates)| {
            updates.sort_by(|a, b| (a.name.as_str(), a.directory.as_str()).cmp(&(b.name.as_str(), b.directory.as_str())));
            PullPlan { group: Some(groups[at].name.clone()), by_name: groups[at].group_by.is_some(), updates }
        })
        .collect();
    single.sort_by(|a, b| (a.name.as_str(), a.directory.as_str()).cmp(&(b.name.as_str(), b.directory.as_str())));
    plans.extend(single.into_iter().map(|update| PullPlan { group: None, by_name: false, updates: vec![update] }));
    plans
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::read;
    use crate::registries::Release;

    const NOW: u64 = 1_800_000_000_000;

    fn entry(extra: &str) -> Entry {
        let source = format!("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule: {{interval: daily}}\n{extra}");
        let found = read(&source);
        assert!(found.problems.is_empty(), "{:?}", found.problems);
        found.config.updates.into_iter().next().unwrap()
    }

    fn release(version: &str, days_ago: u64) -> Release {
        Release { version: version.into(), published_ms: Some(NOW - days_ago * DAY_MS), withdrawn: false }
    }

    fn candidate(name: &str, current: &str, releases: Vec<Release>) -> Candidate {
        Candidate {
            name: name.into(),
            directory: "/".into(),
            kind: DependencyType::Production,
            current: current.into(),
            requirement: Some(format!("^{current}")),
            package: Package { releases, ..Package::default() },
        }
    }

    fn to(entry: &Entry, candidate: &Candidate) -> Result<String, Skip> {
        target(entry, &[], candidate, NOW).map(|planned| planned.to)
    }

    #[test]
    fn the_newest_release_past_the_default_cooldown() {
        let found = candidate("lodash", "4.17.20", vec![release("4.17.20", 900), release("4.17.21", 30), release("4.18.0", 1), release("5.0.0-rc.1", 40)]);
        // 4.18.0 is a day old: the default three days hold it back. The release candidate is skipped.
        assert_eq!(to(&entry(""), &found), Ok("4.17.21".into()));
        let mut withdrawn = found.clone();
        withdrawn.package.releases[1].withdrawn = true;
        assert_eq!(to(&entry(""), &withdrawn), Err(Skip::UpToDate));
        // A pre-release is offered to one already on a pre-release.
        let pre = candidate("x", "5.0.0-beta.1", vec![release("5.0.0-rc.1", 40)]);
        assert_eq!(to(&entry(""), &pre), Ok("5.0.0-rc.1".into()));
    }

    #[test]
    fn cooldown_by_level_include_and_exclude() {
        let found = candidate("react", "18.2.0", vec![release("18.2.1", 2), release("18.3.0", 5), release("19.0.0", 10)]);
        let cooled = entry("    cooldown:\n      default-days: 1\n      semver-major-days: 30\n      semver-minor-days: 3\n      semver-patch-days: 0\n");
        assert_eq!(to(&cooled, &found), Ok("18.3.0".into()));
        let excluded = entry("    cooldown:\n      default-days: 30\n      exclude: [\"react\"]\n");
        assert_eq!(to(&excluded, &found), Ok("19.0.0".into()));
        let others = entry("    cooldown:\n      default-days: 30\n      include: [\"vue*\"]\n");
        assert_eq!(to(&others, &found), Ok("19.0.0".into()));
        let unknown_date = Candidate { package: Package { releases: vec![Release { version: "18.4.0".into(), published_ms: None, withdrawn: false }], ..Package::default() }, ..found };
        assert_eq!(to(&entry(""), &unknown_date), Ok("18.4.0".into()));
    }

    #[test]
    fn ignore_rules_and_comments() {
        let found = candidate("react", "18.2.0", vec![release("18.3.1", 10), release("19.0.0", 10)]);
        assert_eq!(to(&entry("    ignore:\n      - dependency-name: react\n"), &found), Err(Skip::Ignored));
        assert_eq!(to(&entry("    ignore:\n      - dependency-name: \"rea*\"\n        versions: [\">=19\"]\n"), &found), Ok("18.3.1".into()));
        assert_eq!(
            to(&entry("    ignore:\n      - dependency-name: \"*\"\n        update-types: [\"version-update:semver-major\"]\n"), &found),
            Ok("18.3.1".into())
        );
        let comment = |versions: Option<&str>, update_type: Option<&str>| IgnoreCondition {
            ecosystem: "npm".into(),
            dependency: "React".into(),
            versions: versions.map(str::to_owned),
            update_type: update_type.map(str::to_owned),
            by: "ana".into(),
            pull: Some(3),
            at: String::new(),
        };
        let plain = entry("");
        assert_eq!(target(&plain, &[comment(Some(">= 19.a, < 20"), None)], &found, NOW).unwrap().to, "18.3.1");
        assert_eq!(target(&plain, &[comment(None, None)], &found, NOW), Err(Skip::Ignored));
        assert_eq!(target(&plain, &[comment(None, Some("version-update:semver-major"))], &found, NOW).unwrap().to, "18.3.1");
        let other = IgnoreCondition { ecosystem: "cargo".into(), ..comment(None, None) };
        assert_eq!(target(&plain, &[other], &found, NOW).unwrap().to, "19.0.0");
    }

    #[test]
    fn allow_rules() {
        let mut dev = candidate("vitest", "1.0.0", vec![release("1.1.0", 10), release("2.0.0", 10)]);
        dev.kind = DependencyType::Development;
        let indirect = Candidate { kind: DependencyType::Indirect, ..candidate("minimist", "1.2.0", vec![release("1.2.8", 10)]) };
        let plain = entry("");
        assert_eq!(to(&plain, &dev), Ok("2.0.0".into()));
        assert_eq!(to(&plain, &indirect), Err(Skip::NotAllowed));
        let production = entry("    allow:\n      - dependency-type: production\n");
        assert_eq!(to(&production, &dev), Err(Skip::NotAllowed));
        let all = entry("    allow:\n      - dependency-type: all\n");
        assert_eq!(to(&all, &indirect), Ok("1.2.8".into()));
        let minor = entry("    allow:\n      - dependency-name: vitest\n        update-types: [\"version-update:semver-minor\"]\n");
        assert_eq!(to(&minor, &dev), Ok("1.1.0".into()));
    }

    #[test]
    fn lockfile_only_stays_inside_the_requirement() {
        let found = candidate("lodash", "4.17.20", vec![release("4.17.21", 30), release("5.0.0", 30)]);
        let strategy = entry("    versioning-strategy: lockfile-only\n");
        assert_eq!(to(&strategy, &found), Ok("4.17.21".into()));
        assert_eq!(to(&entry("    versioning-strategy: increase\n"), &found), Ok("5.0.0".into()));
    }

    fn planned(name: &str, directory: &str, kind: DependencyType, level: &'static str) -> Planned {
        Planned { name: name.into(), directory: directory.into(), kind, from: "1.0.0".into(), to: "1.1.0".into(), level, source: None, changelog: None, page: None }
    }

    #[test]
    fn updates_gather_into_groups() {
        let entry = entry(
            "    groups:\n      lint:\n        patterns: [\"eslint*\"]\n        exclude-patterns: [\"eslint-old\"]\n      dev:\n        dependency-type: development\n        update-types: [minor, patch]\n      shared:\n        patterns: [\"@acme/*\"]\n        group-by: dependency-name\n      fixes:\n        applies-to: security-updates\n        patterns: [\"*\"]\n",
        );
        let updates = vec![
            planned("eslint", "/", DependencyType::Development, "minor"),
            planned("eslint-old", "/", DependencyType::Production, "minor"),
            planned("vitest", "/", DependencyType::Development, "patch"),
            planned("vite", "/", DependencyType::Development, "major"),
            planned("@acme/ui", "/web", DependencyType::Production, "minor"),
            planned("@acme/ui", "/admin", DependencyType::Production, "minor"),
            planned("react", "/web", DependencyType::Production, "patch"),
        ];
        let plans = gather(&entry.groups, "version-updates", updates);
        let shown: Vec<String> = plans
            .iter()
            .map(|plan| format!("{} {}", plan.subject(), plan.updates.iter().map(|u| format!("{}{}", u.directory, u.name)).collect::<Vec<_>>().join(",")))
            .collect();
        assert_eq!(
            shown,
            [
                "group:lint /eslint",
                "group:dev /vitest",
                "group:shared:@acme/ui /admin@acme/ui,/web@acme/ui",
                "dependency:/:eslint-old /eslint-old",
                "dependency:/web:react /webreact",
                "dependency:/:vite /vite",
            ]
        );
        assert_eq!(plans[2].directories(), ["/admin", "/web"]);
        assert_eq!(plans[0].signature(), "/eslint@1.1.0");
        // Security groups are their own.
        let security = gather(&entry.groups, "security-updates", vec![planned("a", "/", DependencyType::Production, "patch"), planned("b", "/", DependencyType::Production, "patch")]);
        assert_eq!(security.len(), 1);
        assert_eq!(security[0].group.as_deref(), Some("fixes"));
    }
}
