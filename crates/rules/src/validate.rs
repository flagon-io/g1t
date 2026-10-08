//! Whether a ruleset can be saved, and the tidy form it is saved in.

use g1t_contracts::access::RepoRole;
use g1t_contracts::rules::{
    ActorKind, AppliesTo, Level, MAX_APPROVALS, MAX_BYPASS_ACTORS, MAX_PATTERN_CHARS, MAX_PATTERNS, MAX_RULES,
    PatternRule, Rule, RulesetSpec, Target,
};
use g1t_contracts::time::parse_rfc3339;

use crate::{glob, text, window};

/// The longest ruleset name.
pub const MAX_NAME_CHARS: usize = 100;
/// Required checks in one rule.
pub const MAX_CHECKS: usize = 50;
/// The largest cost cap, in US dollars.
pub const MAX_COST_USD: f64 = 10_000.0;

fn tidy_list(list: &[String], what: &str) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for item in list {
        let item = item.trim();
        if item.is_empty() || out.iter().any(|have| have == item) {
            continue;
        }
        if item.chars().count() > MAX_PATTERN_CHARS {
            return Err(format!("{what} may be at most {MAX_PATTERN_CHARS} characters long."));
        }
        if !glob::well_formed(item) {
            return Err(format!("{what} {item} has a [ without a closing ]."));
        }
        out.push(item.to_owned());
    }
    if out.len() > MAX_PATTERNS {
        return Err(format!("A ruleset may list at most {MAX_PATTERNS} {what}s."));
    }
    Ok(out)
}

fn pattern(rule: &PatternRule, what: &str) -> Result<PatternRule, String> {
    let tidy = PatternRule { name: rule.name.trim().to_owned(), pattern: rule.pattern.clone(), ..rule.clone() };
    if tidy.pattern.is_empty() {
        return Err(format!("The {what} rule needs a pattern."));
    }
    if tidy.pattern.chars().count() > MAX_PATTERN_CHARS {
        return Err(format!("The {what} pattern may be at most {MAX_PATTERN_CHARS} characters long."));
    }
    text::compile(&tidy).map_err(|why| format!("The {what} rule: {why}"))?;
    Ok(tidy)
}

fn period(period: &g1t_contracts::rules::Period, what: &str) -> Result<(), String> {
    let start = parse_rfc3339(&period.start).ok_or_else(|| format!("A {what} needs a start time in RFC 3339, such as 2026-12-20T00:00:00Z."))?;
    if let Some(end) = &period.end {
        let end = parse_rfc3339(end).ok_or_else(|| format!("A {what}'s end must be an RFC 3339 time."))?;
        if end <= start {
            return Err(format!("A {what} must end after it starts."));
        }
    }
    Ok(())
}

fn rule(rule: &Rule, target: Target) -> Result<Rule, String> {
    let label = rule.label();
    if target == Target::Tag && rule.for_branches_only() {
        return Err(format!("{label} is a rule for branches, and this ruleset targets tags."));
    }
    if target == Target::Branch && rule.for_tags_only() {
        return Err(format!("{label} is a rule for tags, and this ruleset targets branches."));
    }
    Ok(match rule {
        Rule::PullRequest(params) => {
            if params.required_approvals > MAX_APPROVALS {
                return Err(format!("A pull request rule may require at most {MAX_APPROVALS} approvals."));
            }
            let mut params = params.clone();
            params.allowed_merge_methods.dedup();
            Rule::PullRequest(params)
        }
        Rule::RequiredStatusChecks(params) => {
            let mut params = params.clone();
            let mut checks = Vec::new();
            for check in &params.checks {
                let context = check.context.trim();
                if context.is_empty() || checks.iter().any(|have: &g1t_contracts::rules::RequiredCheck| have.context.eq_ignore_ascii_case(context)) {
                    continue;
                }
                if context.chars().count() > 200 {
                    return Err("A required check's name may be at most 200 characters long.".to_owned());
                }
                checks.push(g1t_contracts::rules::RequiredCheck { context: context.to_owned(), integration: check.integration });
            }
            if checks.len() > MAX_CHECKS {
                return Err(format!("A ruleset may require at most {MAX_CHECKS} checks in one rule."));
            }
            if checks.is_empty() && !params.strict {
                return Err("Require status checks needs a check to require, or to require branches to be up to date.".to_owned());
            }
            params.checks = checks;
            params.paths = tidy_list(&params.paths, "path")?;
            Rule::RequiredStatusChecks(params)
        }
        Rule::MergeQueue(params) => {
            if !(1..=20).contains(&params.max_entries_to_build) {
                return Err("The merge queue builds 1 to 20 pull requests at once.".to_owned());
            }
            if params.min_entries_to_merge < 1 || params.min_entries_to_merge > params.max_entries_to_build {
                return Err("The merge queue's smallest batch is between 1 and how many it builds at once.".to_owned());
            }
            if params.min_entries_wait_minutes > 360 {
                return Err("The merge queue waits at most 360 minutes for a batch to fill.".to_owned());
            }
            if !(5..=360).contains(&params.check_response_timeout_minutes) {
                return Err("The merge queue's check timeout is 5 to 360 minutes.".to_owned());
            }
            Rule::MergeQueue(params.clone())
        }
        Rule::RequiredDeployments(params) => {
            let environments = tidy_list(&params.environments, "environment")?;
            if environments.is_empty() {
                return Err("Require deployments needs an environment, such as preview.".to_owned());
            }
            Rule::RequiredDeployments(g1t_contracts::rules::DeploymentsRule { environments })
        }
        Rule::CommitMessagePattern(params) => Rule::CommitMessagePattern(pattern(params, "commit message")?),
        Rule::CommitAuthorEmailPattern(params) => Rule::CommitAuthorEmailPattern(pattern(params, "commit author email")?),
        Rule::CommitterEmailPattern(params) => Rule::CommitterEmailPattern(pattern(params, "committer email")?),
        Rule::BranchNamePattern(params) => Rule::BranchNamePattern(pattern(params, "branch name")?),
        Rule::TagNamePattern(params) => Rule::TagNamePattern(pattern(params, "tag name")?),
        Rule::FilePathRestriction(params) => {
            let paths = tidy_list(&params.restricted_file_paths, "path")?;
            if paths.is_empty() {
                return Err("Restrict file paths needs a path pattern.".to_owned());
            }
            Rule::FilePathRestriction(g1t_contracts::rules::FilePathRule { restricted_file_paths: paths })
        }
        Rule::FileExtensionRestriction(params) => {
            let extensions: Vec<String> = tidy_list(&params.restricted_file_extensions, "extension")?
                .into_iter()
                .map(|extension| {
                    let extension = extension.to_lowercase();
                    if extension.starts_with('.') { extension } else { format!(".{extension}") }
                })
                .collect();
            if extensions.is_empty() {
                return Err("Restrict file extensions needs an extension, such as .exe.".to_owned());
            }
            Rule::FileExtensionRestriction(g1t_contracts::rules::FileExtensionRule { restricted_file_extensions: extensions })
        }
        Rule::MaxFileSize(params) => {
            if !(1..=100).contains(&params.max_file_size_mb) {
                return Err("The largest file allowed is 1 to 100 MB.".to_owned());
            }
            Rule::MaxFileSize(params.clone())
        }
        Rule::MaxFilePathLength(params) => {
            if !(1..=4096).contains(&params.max_file_path_length) {
                return Err("The longest path allowed is 1 to 4096 characters.".to_owned());
            }
            Rule::MaxFilePathLength(params.clone())
        }
        Rule::MaxFilesChanged(params) => {
            if !(1..=100_000).contains(&params.max_files) {
                return Err("The most files changed is 1 to 100000.".to_owned());
            }
            Rule::MaxFilesChanged(params.clone())
        }
        Rule::ConfidenceThreshold(params) => {
            if !(1..=MAX_APPROVALS).contains(&params.required_approvals) {
                return Err(format!("A confidence threshold asks for 1 to {MAX_APPROVALS} approvals."));
            }
            Rule::ConfidenceThreshold(params.clone())
        }
        Rule::CostCap(params) => {
            if !(params.max_usd.is_finite() && params.max_usd > 0.0 && params.max_usd <= MAX_COST_USD) {
                return Err(format!("A cost cap is more than $0 and at most ${MAX_COST_USD:.0}."));
            }
            Rule::CostCap(g1t_contracts::rules::CostCapRule { max_usd: (params.max_usd * 100.0).round() / 100.0 })
        }
        Rule::PathReview(params) => {
            let paths = tidy_list(&params.paths, "path")?;
            if paths.is_empty() {
                return Err("Review for sensitive paths needs a path pattern.".to_owned());
            }
            if !(1..=MAX_APPROVALS).contains(&params.required_approvals) {
                return Err(format!("Review for sensitive paths asks for 1 to {MAX_APPROVALS} approvals."));
            }
            let team = params
                .team
                .as_deref()
                .map(|team| team.trim().trim_start_matches('@').to_lowercase())
                .filter(|team| !team.is_empty());
            Rule::PathReview(g1t_contracts::rules::PathReviewRule { paths, required_approvals: params.required_approvals, team })
        }
        Rule::MergeWindow(params) => {
            if window::offset_minutes(&params.time_zone).is_none() {
                return Err("A merge window's time zone is an offset from UTC, such as +02:00, or UTC.".to_owned());
            }
            for weekly in &params.windows {
                if weekly.days.is_empty() {
                    return Err("Each merge window needs at least one day.".to_owned());
                }
                let (Some(start), Some(end)) = (window::clock(&weekly.start), window::clock(&weekly.end)) else {
                    return Err("A merge window's hours are HH:MM, such as 09:00 to 17:00.".to_owned());
                };
                if start == end {
                    return Err("A merge window must not start and end at the same time.".to_owned());
                }
            }
            for freeze in &params.freezes {
                period(freeze, "freeze")?;
            }
            for exception in &params.exceptions {
                period(exception, "exception")?;
            }
            if params.windows.is_empty() && params.freezes.is_empty() {
                return Err("A merge window needs weekly hours or a freeze.".to_owned());
            }
            Rule::MergeWindow(params.clone())
        }
        other => other.clone(),
    })
}

/// Rules that may appear more than once in a ruleset, each with its own
/// parameters.
fn repeatable(rule: &Rule) -> bool {
    matches!(
        rule,
        Rule::RequiredStatusChecks(_)
            | Rule::PathReview(_)
            | Rule::CommitMessagePattern(_)
            | Rule::CommitAuthorEmailPattern(_)
            | Rule::CommitterEmailPattern(_)
            | Rule::BranchNamePattern(_)
            | Rule::TagNamePattern(_)
            | Rule::FilePathRestriction(_)
    )
}

/// The ruleset as it is saved, or why it cannot be.
pub fn validate(spec: &RulesetSpec, level: Level) -> Result<RulesetSpec, String> {
    let name = spec.name.trim();
    if name.is_empty() {
        return Err("Give the ruleset a name.".to_owned());
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(format!("A ruleset's name may be at most {MAX_NAME_CHARS} characters long."));
    }
    let mut out = spec.clone();
    out.name = name.to_owned();
    out.conditions.ref_name.include = tidy_list(&spec.conditions.ref_name.include, "branch or tag pattern")?;
    out.conditions.ref_name.exclude = tidy_list(&spec.conditions.ref_name.exclude, "branch or tag pattern")?;
    if out.conditions.ref_name.include.is_empty() {
        return Err(format!(
            "Say which {}es it holds for: a pattern such as release/*, ~DEFAULT_BRANCH or ~ALL.",
            if spec.target == Target::Tag { "tag" } else { "branch" }
        ));
    }
    out.conditions.repository = match level {
        Level::Repository => None,
        Level::Workspace => {
            let mut repository = spec.conditions.repository.clone().unwrap_or_default();
            repository.include = tidy_list(&repository.include, "repository pattern")?;
            repository.exclude = tidy_list(&repository.exclude, "repository pattern")?;
            repository.topics = repository
                .topics
                .iter()
                .map(|topic| topic.trim().to_lowercase())
                .filter(|topic| !topic.is_empty())
                .collect();
            if repository.include.is_empty() {
                return Err("Say which repositories it holds in: a name pattern, or ~ALL.".to_owned());
            }
            Some(repository)
        }
    };
    if spec.bypass_actors.len() > MAX_BYPASS_ACTORS {
        return Err(format!("A ruleset may list at most {MAX_BYPASS_ACTORS} bypass actors."));
    }
    let mut bypass = Vec::new();
    for actor in &spec.bypass_actors {
        let mut actor = actor.clone();
        actor.value = actor.value.trim().trim_start_matches('@').to_owned();
        match actor.kind {
            ActorKind::Role => {
                let role = actor.value.to_ascii_lowercase();
                if role != "owner" && RepoRole::parse(&role).is_none() {
                    return Err(format!("{} is not a role: use read, triage, write, maintain, admin or owner.", actor.value));
                }
                actor.value = role;
            }
            ActorKind::G1t => actor.value.clear(),
            _ if actor.value.is_empty() => return Err("Each bypass actor needs to say who.".to_owned()),
            ActorKind::Team => actor.value = actor.value.to_lowercase(),
            _ => {}
        }
        if !bypass.contains(&actor) {
            bypass.push(actor);
        }
    }
    out.bypass_actors = bypass;
    if spec.rules.len() > MAX_RULES {
        return Err(format!("A ruleset may have at most {MAX_RULES} rules."));
    }
    let mut seen: Vec<(&'static str, AppliesTo)> = Vec::new();
    out.rules = Vec::new();
    for entry in &spec.rules {
        let key = (entry.rule.kind(), entry.applies_to);
        if !repeatable(&entry.rule) {
            if seen.contains(&key) {
                return Err(format!("{} appears twice for the same changes; keep one.", entry.rule.label()));
            }
            seen.push(key);
        }
        out.rules.push(g1t_contracts::rules::RuleEntry { rule: rule(&entry.rule, spec.target)?, applies_to: entry.applies_to });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::rules::{
        BypassActor, BypassMode, Conditions, CostCapRule, MergeQueueRule, MergeWindowRule, NoParameters, PatternOperator,
        Period, RefCondition, RuleEntry, StatusChecksRule, WeeklyWindow, Weekday,
    };

    fn spec(rules: Vec<Rule>) -> RulesetSpec {
        RulesetSpec {
            name: " Protect main ".into(),
            conditions: Conditions {
                ref_name: RefCondition { include: vec!["~DEFAULT_BRANCH".into(), " ".into(), "~DEFAULT_BRANCH".into()], exclude: Vec::new() },
                repository: None,
            },
            rules: rules.into_iter().map(RuleEntry::everyone).collect(),
            ..RulesetSpec::default()
        }
    }

    #[test]
    fn a_good_ruleset_is_tidied() {
        let saved = validate(&spec(vec![Rule::Deletion(NoParameters {})]), Level::Repository).unwrap();
        assert_eq!(saved.name, "Protect main");
        assert_eq!(saved.conditions.ref_name.include, vec!["~DEFAULT_BRANCH"]);
        assert!(saved.conditions.repository.is_none());
        let workspace = validate(&spec(vec![]), Level::Workspace).unwrap();
        assert_eq!(workspace.conditions.repository.unwrap().include, vec!["~ALL"]);
    }

    #[test]
    fn names_and_targets_are_required() {
        let mut nameless = spec(vec![]);
        nameless.name = "  ".into();
        assert_eq!(validate(&nameless, Level::Repository).unwrap_err(), "Give the ruleset a name.");
        let mut nowhere = spec(vec![]);
        nowhere.conditions.ref_name.include.clear();
        assert!(validate(&nowhere, Level::Repository).unwrap_err().starts_with("Say which branches"));
        let mut broken = spec(vec![]);
        broken.conditions.ref_name.include = vec!["release/[0-9".into()];
        assert!(validate(&broken, Level::Repository).unwrap_err().contains("without a closing"));
    }

    #[test]
    fn rules_must_suit_the_target_and_appear_once() {
        let mut tags = spec(vec![Rule::PullRequest(Default::default())]);
        tags.target = Target::Tag;
        assert_eq!(
            validate(&tags, Level::Repository).unwrap_err(),
            "Require a pull request before merging is a rule for branches, and this ruleset targets tags."
        );
        let twice = spec(vec![Rule::Deletion(NoParameters {}), Rule::Deletion(NoParameters {})]);
        assert!(validate(&twice, Level::Repository).unwrap_err().contains("appears twice"));
        let mut for_each = spec(vec![Rule::Deletion(NoParameters {})]);
        for_each.rules.push(RuleEntry { rule: Rule::Deletion(NoParameters {}), applies_to: AppliesTo::Agents });
        assert!(validate(&for_each, Level::Repository).is_ok(), "once for everyone, once for agents");
    }

    #[test]
    fn parameters_are_checked() {
        let bad_regex = spec(vec![Rule::CommitMessagePattern(PatternRule {
            name: String::new(),
            operator: PatternOperator::Regex,
            pattern: "(".into(),
            negate: false,
        })]);
        assert!(validate(&bad_regex, Level::Repository).unwrap_err().starts_with("The commit message rule: The regular expression is not valid"));
        let queue = spec(vec![Rule::MergeQueue(MergeQueueRule { max_entries_to_build: 50, ..MergeQueueRule::default() })]);
        assert!(validate(&queue, Level::Repository).is_err());
        let checks = spec(vec![Rule::RequiredStatusChecks(StatusChecksRule::default())]);
        assert!(validate(&checks, Level::Repository).is_err());
        let cost = spec(vec![Rule::CostCap(CostCapRule { max_usd: -1.0 })]);
        assert!(validate(&cost, Level::Repository).is_err());
        let rounded = validate(&spec(vec![Rule::CostCap(CostCapRule { max_usd: 2.499 })]), Level::Repository).unwrap();
        assert_eq!(rounded.rules[0].rule, Rule::CostCap(CostCapRule { max_usd: 2.5 }));
        let window = spec(vec![Rule::MergeWindow(MergeWindowRule {
            time_zone: "Mars/Olympus".into(),
            windows: vec![WeeklyWindow { days: vec![Weekday::Mon], start: "09:00".into(), end: "17:00".into() }],
            ..MergeWindowRule::default()
        })]);
        assert!(validate(&window, Level::Repository).unwrap_err().contains("time zone"));
        let backwards = spec(vec![Rule::MergeWindow(MergeWindowRule {
            freezes: vec![Period { start: "2026-12-20T00:00:00Z".into(), end: Some("2026-12-19T00:00:00Z".into()), reason: String::new() }],
            ..MergeWindowRule::default()
        })]);
        assert_eq!(validate(&backwards, Level::Repository).unwrap_err(), "A freeze must end after it starts.");
    }

    #[test]
    fn bypass_actors_are_checked_and_tidied() {
        let mut with = spec(vec![]);
        with.bypass_actors = vec![
            BypassActor { kind: ActorKind::Role, value: "Admin".into(), mode: BypassMode::Always },
            BypassActor { kind: ActorKind::Team, value: "@Acme/Release".into(), mode: BypassMode::PullRequests },
            BypassActor { kind: ActorKind::G1t, value: "anything".into(), mode: BypassMode::Always },
        ];
        let saved = validate(&with, Level::Repository).unwrap();
        assert_eq!(saved.bypass_actors[0].value, "admin");
        assert_eq!(saved.bypass_actors[1].value, "acme/release");
        assert_eq!(saved.bypass_actors[2].value, "");
        with.bypass_actors = vec![BypassActor { kind: ActorKind::Role, value: "boss".into(), mode: BypassMode::Always }];
        assert!(validate(&with, Level::Repository).is_err());
        with.bypass_actors = vec![BypassActor { kind: ActorKind::User, value: " ".into(), mode: BypassMode::Always }];
        assert!(validate(&with, Level::Repository).is_err());
    }
}
