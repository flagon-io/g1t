//! Branch protection as it was before rulesets: one set of settings for the
//! default branch. A repository's settings become its "Default branch
//! protection" ruleset, holding exactly what they held, and the settings
//! the API still takes for that branch are read from and written to it.

use g1t_contracts::rules::{
    Conditions, DEFAULT_BRANCH, Enforcement, MergeQueueRule, PullRequestRule, RefCondition, RequiredCheck, Rule,
    RuleEntry, RulesetSpec, StatusChecksRule, Target,
};
use g1t_contracts::work::RepoSettings;

/// The name the ruleset made from branch protection is given.
pub const NAME: &str = "Default branch protection";

/// What branch protection held, as rules. `protected`: pushes to the
/// default branch were refused.
pub fn rules_of(settings: &RepoSettings, protected: bool) -> Vec<RuleEntry> {
    let mut rules = Vec::new();
    if protected || settings.required_approvals > 0 || settings.require_code_owner_review {
        rules.push(RuleEntry::everyone(Rule::PullRequest(PullRequestRule {
            required_approvals: settings.required_approvals,
            count_agent_approvals: settings.count_agent_approvals,
            require_code_owner_review: settings.require_code_owner_review,
            allow_direct_pushes: !protected,
            ..PullRequestRule::default()
        })));
    }
    if !settings.required_checks.is_empty() || settings.require_up_to_date {
        rules.push(RuleEntry::everyone(Rule::RequiredStatusChecks(StatusChecksRule {
            checks: settings
                .required_checks
                .iter()
                .map(|name| RequiredCheck { context: name.clone(), integration: None })
                .collect(),
            strict: settings.require_up_to_date,
            paths: Vec::new(),
            allow_bypass_on_merge: settings.allow_ignoring_checks,
        })));
    }
    if settings.merge_queue {
        rules.push(RuleEntry::everyone(Rule::MergeQueue(MergeQueueRule::default())));
    }
    rules
}

/// The ruleset branch protection becomes, or `None` when it held nothing.
pub fn ruleset_of(settings: &RepoSettings, protected: bool) -> Option<RulesetSpec> {
    let rules = rules_of(settings, protected);
    (!rules.is_empty()).then(|| RulesetSpec {
        name: NAME.to_owned(),
        enforcement: Enforcement::Active,
        target: Target::Branch,
        conditions: Conditions {
            ref_name: RefCondition { include: vec![DEFAULT_BRANCH.to_owned()], exclude: Vec::new() },
            repository: None,
        },
        bypass_actors: Vec::new(),
        rules,
    })
}

/// A ruleset's rules with the branch protection kinds (pull request,
/// status checks, merge queue) replaced by what `settings` say, the others
/// kept as they were.
pub fn replace(existing: &[RuleEntry], settings: &RepoSettings, protected: bool) -> Vec<RuleEntry> {
    let mut rules: Vec<RuleEntry> = existing
        .iter()
        .filter(|entry| {
            !matches!(entry.rule, Rule::PullRequest(_) | Rule::RequiredStatusChecks(_) | Rule::MergeQueue(_))
                || entry.applies_to != g1t_contracts::rules::AppliesTo::Everyone
        })
        .cloned()
        .collect();
    let mut fresh = rules_of(settings, protected);
    // Keep what the old settings did not have a say in.
    for entry in &mut fresh {
        if let (Rule::PullRequest(new), Some(Rule::PullRequest(old))) = (
            &mut entry.rule,
            existing.iter().map(|entry| &entry.rule).find(|rule| matches!(rule, Rule::PullRequest(_))),
        ) {
            new.dismiss_stale_reviews_on_push = old.dismiss_stale_reviews_on_push;
            new.require_last_push_approval = old.require_last_push_approval;
            new.allowed_merge_methods = old.allowed_merge_methods.clone();
        }
        if let (Rule::RequiredStatusChecks(new), Some(Rule::RequiredStatusChecks(old))) = (
            &mut entry.rule,
            existing.iter().map(|entry| &entry.rule).find(|rule| matches!(rule, Rule::RequiredStatusChecks(_))),
        ) {
            for check in &mut new.checks {
                check.integration = old
                    .checks
                    .iter()
                    .find(|was| was.context.eq_ignore_ascii_case(&check.context))
                    .and_then(|was| was.integration);
            }
        }
        if let (Rule::MergeQueue(new), Some(Rule::MergeQueue(old))) = (
            &mut entry.rule,
            existing.iter().map(|entry| &entry.rule).find(|rule| matches!(rule, Rule::MergeQueue(_))),
        ) {
            *new = old.clone();
        }
    }
    let mut out = fresh;
    out.append(&mut rules);
    out
}

/// Whether the ruleset's pull request rule refuses pushes: what the
/// repository's old `protected` flag said.
pub fn requires_pull_requests(rules: &[RuleEntry]) -> bool {
    rules.iter().any(|entry| {
        entry.applies_to == g1t_contracts::rules::AppliesTo::Everyone
            && matches!(&entry.rule, Rule::PullRequest(rule) if !rule.allow_direct_pushes)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::merge::requirements;
    use crate::push::{RefChange, judge};
    use crate::select::Who;
    use g1t_contracts::rules::{Applicable, Level, NoParameters};

    fn applicable(spec: &RulesetSpec) -> Applicable {
        Applicable {
            id: "rs_bp".into(),
            name: spec.name.clone(),
            level: Level::Repository,
            enforcement: spec.enforcement,
            target: spec.target,
            conditions: spec.conditions.ref_name.clone(),
            rules: spec.rules.clone(),
            bypass: None,
        }
    }

    fn push_to(branch: &str) -> RefChange {
        RefChange {
            git_ref: format!("refs/heads/{branch}"),
            old: Some("a".repeat(40)),
            new: Some("b".repeat(40)),
            fast_forward: Some(true),
            commits: Vec::new(),
            complete: true,
        }
    }

    #[test]
    fn nothing_protected_makes_no_ruleset() {
        assert_eq!(ruleset_of(&RepoSettings::default(), false), None);
    }

    #[test]
    fn protection_becomes_a_ruleset_that_behaves_as_it_did() {
        let settings = RepoSettings {
            required_checks: vec!["CI".into()],
            require_up_to_date: true,
            required_approvals: 2,
            count_agent_approvals: false,
            allow_ignoring_checks: false,
            merge_queue: true,
            require_code_owner_review: true,
            ..RepoSettings::default()
        };
        let spec = ruleset_of(&settings, true).unwrap();
        assert_eq!(spec.name, "Default branch protection");
        assert_eq!(spec.conditions.ref_name.include, vec!["~DEFAULT_BRANCH"]);
        let rules = [applicable(&spec)];
        // The same requirements on the default branch...
        let found = requirements(&rules, "refs/heads/main", "main", false, &[]);
        assert_eq!(found.required_checks, vec!["CI"]);
        assert!(found.strict && !found.allow_bypass_on_merge && found.require_code_owner_review && !found.count_agent_approvals);
        assert_eq!(found.required_approvals, 2);
        assert!(found.merge_queue.is_some());
        // ...none on another branch...
        assert_eq!(requirements(&rules, "refs/heads/release", "main", false, &[]).required_approvals, 0);
        // ...and pushes to it refused, as protection refused them.
        assert!(crate::outcome::refused(&judge(&rules, "main", Who::Person, &push_to("main"))));
        assert!(judge(&rules, "main", Who::Person, &push_to("release")).is_empty());
        assert!(requires_pull_requests(&spec.rules));
    }

    #[test]
    fn approvals_without_protection_still_let_pushes_through() {
        let settings = RepoSettings { required_approvals: 1, ..RepoSettings::default() };
        let spec = ruleset_of(&settings, false).unwrap();
        let rules = [applicable(&spec)];
        assert!(!crate::outcome::refused(&judge(&rules, "main", Who::Person, &push_to("main"))));
        assert_eq!(requirements(&rules, "refs/heads/main", "main", false, &[]).required_approvals, 1);
        assert!(!requires_pull_requests(&spec.rules));
        // Protection alone is a pull request rule with nothing else asked.
        let only = ruleset_of(&RepoSettings::default(), true).unwrap();
        assert_eq!(only.rules.len(), 1);
        assert!(requires_pull_requests(&only.rules));
    }

    /// What services/work/migrations/0028_rulesets.sql writes for a
    /// repository with every setting on (run against SQLite), read back:
    /// the same ruleset this module makes.
    #[test]
    fn the_migration_writes_what_this_module_makes() {
        let migrated: RulesetSpec = serde_json::from_str(r#"{"bypass_actors": [], "conditions": {"ref_name": {"exclude": [], "include": ["~DEFAULT_BRANCH"]}}, "enforcement": "active", "name": "Default branch protection", "rules": [{"applies_to": "everyone", "parameters": {"allow_direct_pushes": true, "allowed_merge_methods": [], "count_agent_approvals": false, "dismiss_stale_reviews_on_push": false, "require_code_owner_review": true, "require_last_push_approval": false, "required_approvals": 2}, "type": "pull_request"}, {"applies_to": "everyone", "parameters": {"allow_bypass_on_merge": false, "checks": [{"context": "CI"}, {"context": "Lint"}], "paths": [], "strict": true}, "type": "required_status_checks"}, {"applies_to": "everyone", "parameters": {"check_response_timeout_minutes": 45, "max_entries_to_build": 4, "merge_method": "merge", "min_entries_to_merge": 1, "min_entries_wait_minutes": 0}, "type": "merge_queue"}], "target": "branch"}"#).unwrap();
        let settings = RepoSettings {
            required_approvals: 2,
            count_agent_approvals: false,
            require_code_owner_review: true,
            required_checks: vec!["CI".into(), "Lint".into()],
            require_up_to_date: true,
            allow_ignoring_checks: false,
            merge_queue: true,
            ..RepoSettings::default()
        };
        assert_eq!(Some(migrated), ruleset_of(&settings, false));
    }

    #[test]
    fn settings_written_later_replace_only_their_own_rules() {
        let spec = ruleset_of(&RepoSettings { required_approvals: 1, ..RepoSettings::default() }, true).unwrap();
        let mut rules = spec.rules.clone();
        rules.push(RuleEntry::everyone(Rule::NonFastForward(NoParameters {})));
        if let Rule::PullRequest(rule) = &mut rules[0].rule {
            rule.dismiss_stale_reviews_on_push = true;
        }
        let changed = replace(&rules, &RepoSettings { required_approvals: 3, required_checks: vec!["CI".into()], ..RepoSettings::default() }, true);
        let kinds: Vec<&str> = changed.iter().map(|entry| entry.rule.kind()).collect();
        assert_eq!(kinds, vec!["pull_request", "required_status_checks", "non_fast_forward"]);
        let Rule::PullRequest(pull) = &changed[0].rule else { panic!() };
        assert_eq!(pull.required_approvals, 3);
        assert!(pull.dismiss_stale_reviews_on_push, "what the settings never had stays");
    }
}
