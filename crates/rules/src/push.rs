//! Judging a change to a branch or tag that does not come from merging a
//! pull request: a push, a branch created, deleted or renamed through g1t,
//! or a commit made on the site.

use g1t_contracts::rules::{Applicable, CommitFacts, Rule, Target};

use crate::content::{self, Problem};
use crate::outcome::Judged;
use crate::select::{Who, applies_to_ref};
use crate::text;

/// One ref a change moves.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RefChange {
    /// The full ref.
    pub git_ref: String,
    /// Where it pointed; `None` when it is created.
    pub old: Option<String>,
    /// Where it will; `None` when it is deleted.
    pub new: Option<String>,
    /// For an update: whether `new` contains `old`. `None` if unknown.
    pub fast_forward: Option<bool>,
    /// The commits the change adds to the ref, newest first.
    pub commits: Vec<CommitFacts>,
    /// Whether `commits` is every commit it adds, each read in full.
    pub complete: bool,
}

impl RefChange {
    fn created(&self) -> bool {
        self.old.is_none() && self.new.is_some()
    }

    fn deleted(&self) -> bool {
        self.new.is_none()
    }

    fn updated(&self) -> bool {
        self.old.is_some() && self.new.is_some()
    }
}

fn short_name(git_ref: &str) -> &str {
    Target::of_ref(git_ref).map_or(git_ref, |(_, name)| name)
}

/// The problems one rule finds in a change, for an actor of kind `who`.
fn rule_problems(rule: &Rule, change: &RefChange) -> Vec<Problem> {
    let name = short_name(&change.git_ref);
    let tag = change.git_ref.starts_with("refs/tags/");
    let what = if tag { "tag" } else { "branch" };
    match rule {
        Rule::Creation(_) if change.created() => vec![Problem::new(
            format!("Only people this ruleset lets bypass it may create the {what} {name}."),
            format!("Use a {what} name the ruleset does not cover, or ask someone who may bypass it."),
        )],
        Rule::Update(_) if change.updated() => vec![Problem::new(
            format!("Only people this ruleset lets bypass it may push to {name}."),
            "Ask someone who may bypass it, or change it through a pull request.",
        )],
        Rule::Deletion(_) if change.deleted() => vec![Problem::new(
            format!("The {what} {name} cannot be deleted."),
            "Ask someone who may bypass this ruleset.",
        )],
        Rule::NonFastForward(_) if change.updated() && change.fast_forward == Some(false) => vec![Problem::new(
            format!("Force pushes to {name} are blocked: the push would rewrite its history."),
            format!("Pull {name}, put your commits on top of it, and push without --force."),
        )],
        Rule::PullRequest(rule) if change.updated() && !tag && !rule.allow_direct_pushes => vec![Problem::new(
            format!("Changes to {name} must be made through a pull request."),
            format!("Push a branch, open a pull request into {name}, and merge it."),
        )],
        Rule::BranchNamePattern(pattern) | Rule::TagNamePattern(pattern) if change.created() => {
            match text::compile(pattern) {
                Ok(compiled) if !compiled.allows(name) => vec![Problem::new(
                    format!("The {what} name {name} does not {}.", compiled.wants()),
                    format!("Name the {what} so it does {}.", compiled.wants().trim_start_matches("not ")),
                )],
                _ => Vec::new(),
            }
        }
        rule if content::about_content(rule) && !change.deleted() => {
            content::problems(rule, &change.commits, change.complete)
        }
        _ => Vec::new(),
    }
}

/// How every applicable ruleset judges one ref change by an actor of kind
/// `who`. Rulesets that do not hold for its ref are left out.
pub fn judge(rulesets: &[Applicable], default_branch: &str, who: Who, change: &RefChange) -> Vec<Judged> {
    rulesets
        .iter()
        .filter(|ruleset| applies_to_ref(ruleset, &change.git_ref, default_branch))
        .map(|ruleset| {
            let mut judged = Judged::of(ruleset, &change.git_ref, false);
            for entry in &ruleset.rules {
                if !entry.applies_to.covers(who.is_agent()) {
                    continue;
                }
                let kind = entry.rule.kind();
                for problem in rule_problems(&entry.rule, change) {
                    judged.add(kind, problem);
                }
            }
            judged
        })
        .collect()
}

/// Whether any ruleset that is not bypassed has a rule that needs a
/// change's commits read: if none, a push need not be parsed for rules.
pub fn needs_content(rulesets: &[Applicable], who: Who) -> bool {
    rulesets.iter().filter(|ruleset| ruleset.bypass.is_none()).any(|ruleset| {
        ruleset
            .rules
            .iter()
            .any(|entry| entry.applies_to.covers(who.is_agent()) && content::about_content(&entry.rule))
    })
}

/// Whether any ruleset asks for every push to be read whole.
pub fn requires_scanning(rulesets: &[Applicable], who: Who) -> bool {
    rulesets.iter().any(|ruleset| {
        ruleset
            .rules
            .iter()
            .any(|entry| entry.applies_to.covers(who.is_agent()) && matches!(entry.rule, Rule::SecretScanning(_)))
    })
}

/// Whether any rule asks for signatures to be verified.
pub fn needs_signatures(rulesets: &[Applicable]) -> bool {
    rulesets
        .iter()
        .any(|ruleset| ruleset.rules.iter().any(|entry| matches!(entry.rule, Rule::RequiredSignatures(_))))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::outcome::{blocking, refused, would_block};
    use g1t_contracts::rules::{
        AppliesTo, BypassMode, Enforcement, FilePathRule, Level, NoParameters, PatternOperator, PatternRule,
        PullRequestRule, RefCondition, RuleEntry, Verdict,
    };

    fn ruleset(id: &str, include: &[&str], rules: Vec<RuleEntry>) -> Applicable {
        Applicable {
            id: id.into(),
            name: format!("Ruleset {id}"),
            level: Level::Repository,
            enforcement: Enforcement::Active,
            target: if include.iter().any(|p| p.starts_with("v")) { Target::Tag } else { Target::Branch },
            conditions: RefCondition { include: include.iter().map(|p| (*p).to_owned()).collect(), exclude: Vec::new() },
            rules,
            bypass: None,
        }
    }

    fn all(rule: Rule) -> RuleEntry {
        RuleEntry::everyone(rule)
    }

    fn update(git_ref: &str) -> RefChange {
        RefChange {
            git_ref: git_ref.into(),
            old: Some("a".repeat(40)),
            new: Some("b".repeat(40)),
            fast_forward: Some(true),
            commits: Vec::new(),
            complete: true,
        }
    }

    #[test]
    fn a_protected_branch_takes_changes_only_through_pull_requests() {
        let protect = ruleset("main", &["~DEFAULT_BRANCH"], vec![all(Rule::PullRequest(PullRequestRule::default()))]);
        let judged = judge(&[protect.clone()], "main", Who::Person, &update("refs/heads/main"));
        assert!(refused(&judged));
        assert_eq!(blocking(&judged)[0].message, "Changes to main must be made through a pull request.");
        assert_eq!(blocking(&judged)[0].rule, "pull_request");
        // Creating it, as the first push to an empty repository does, is allowed.
        let created = RefChange { old: None, ..update("refs/heads/main") };
        assert!(!refused(&judge(&[protect.clone()], "main", Who::Person, &created)));
        // Another branch is not covered.
        assert!(judge(&[protect], "main", Who::Person, &update("refs/heads/feature")).is_empty());
    }

    #[test]
    fn creations_deletions_and_force_pushes() {
        let guard = ruleset(
            "r",
            &["release/*"],
            vec![all(Rule::Creation(NoParameters {})), all(Rule::Deletion(NoParameters {})), all(Rule::NonFastForward(NoParameters {}))],
        );
        let created = RefChange { old: None, ..update("refs/heads/release/2") };
        assert_eq!(blocking(&judge(&[guard.clone()], "main", Who::Person, &created))[0].rule, "creation");
        let deleted = RefChange { new: None, ..update("refs/heads/release/2") };
        assert_eq!(blocking(&judge(&[guard.clone()], "main", Who::Person, &deleted))[0].rule, "deletion");
        let forced = RefChange { fast_forward: Some(false), ..update("refs/heads/release/2") };
        let judged = judge(&[guard.clone()], "main", Who::Person, &forced);
        assert_eq!(blocking(&judged)[0].message, "Force pushes to release/2 are blocked: the push would rewrite its history.");
        assert!(!refused(&judge(&[guard], "main", Who::Person, &update("refs/heads/release/2"))));
    }

    #[test]
    fn a_bypass_lets_the_push_through_and_is_recorded_as_one() {
        let mut protect = ruleset("main", &["main"], vec![all(Rule::Update(NoParameters {}))]);
        protect.bypass = Some(BypassMode::Always);
        let judged = judge(&[protect.clone()], "main", Who::Person, &update("refs/heads/main"));
        assert!(!refused(&judged));
        assert_eq!(judged[0].verdict(), Verdict::Bypass);
        // A bypass for pull requests only does not cover a push.
        protect.bypass = Some(BypassMode::PullRequests);
        assert!(refused(&judge(&[protect], "main", Who::Person, &update("refs/heads/main"))));
    }

    #[test]
    fn evaluate_mode_records_without_refusing() {
        let mut dry = ruleset("dry", &["~ALL"], vec![all(Rule::NonFastForward(NoParameters {}))]);
        dry.enforcement = Enforcement::Evaluate;
        let forced = RefChange { fast_forward: Some(false), ..update("refs/heads/feature") };
        let judged = judge(&[dry], "main", Who::Person, &forced);
        assert!(!refused(&judged));
        assert_eq!(would_block(&judged).len(), 1);
        assert_eq!(judged[0].verdict(), Verdict::Fail);
    }

    #[test]
    fn rules_for_agents_hold_only_for_agents() {
        let agents_only = RuleEntry {
            rule: Rule::FilePathRestriction(FilePathRule { restricted_file_paths: vec![".g1t/workflows/**".into(), "CODEOWNERS".into()] }),
            applies_to: AppliesTo::Agents,
        };
        let workflows = ruleset("w", &["~ALL"], vec![agents_only]);
        let mut change = update("refs/heads/feature");
        change.commits = vec![crate::content::tests_support::commit("c1", "x", &[".g1t/workflows/deploy.yml"])];
        assert!(refused(&judge(&[workflows.clone()], "main", Who::Agent, &change)));
        assert!(refused(&judge(&[workflows.clone()], "main", Who::G1t, &change)));
        assert!(!refused(&judge(&[workflows], "main", Who::Person, &change)));
    }

    #[test]
    fn names_of_new_branches_and_tags_follow_their_patterns() {
        let branches = ruleset(
            "n",
            &["~ALL"],
            vec![all(Rule::BranchNamePattern(PatternRule {
                name: String::new(),
                operator: PatternOperator::Regex,
                pattern: "^(main|(feature|fix)/.+)$".into(),
                negate: false,
            }))],
        );
        let bad = RefChange { old: None, ..update("refs/heads/stuff") };
        assert_eq!(
            blocking(&judge(&[branches.clone()], "main", Who::Person, &bad))[0].message,
            "The branch name stuff does not match /^(main|(feature|fix)/.+)$/."
        );
        let good = RefChange { old: None, ..update("refs/heads/feature/rules") };
        assert!(!refused(&judge(&[branches.clone()], "main", Who::Person, &good)));
        // Pushing to an existing branch is not naming it.
        assert!(!refused(&judge(&[branches], "main", Who::Person, &update("refs/heads/stuff"))));
        let tags = ruleset(
            "t",
            &["v*", "~ALL"],
            vec![all(Rule::TagNamePattern(PatternRule {
                name: "Semantic versions".into(),
                operator: PatternOperator::Regex,
                pattern: r"^v\d+\.\d+\.\d+$".into(),
                negate: false,
            }))],
        );
        let tag = RefChange { old: None, ..update("refs/tags/v1") };
        assert!(refused(&judge(&[tags], "main", Who::Person, &tag)));
    }

    #[test]
    fn content_rules_need_the_change_read_whole() {
        let signed = ruleset("s", &["~ALL"], vec![all(Rule::RequiredSignatures(NoParameters {}))]);
        assert!(needs_content(&[signed.clone()], Who::Person));
        assert!(needs_signatures(&[signed.clone()]));
        let unread = RefChange { complete: false, ..update("refs/heads/feature") };
        assert_eq!(
            blocking(&judge(&[signed.clone()], "main", Who::Person, &unread))[0].message,
            "The change is too large for g1t to check against this rule."
        );
        let mut bypassed = signed;
        bypassed.bypass = Some(BypassMode::Always);
        assert!(!needs_content(&[bypassed], Who::Person), "a bypass actor's push need not be read");
        let scan = ruleset("x", &["~ALL"], vec![all(Rule::SecretScanning(NoParameters {}))]);
        assert!(requires_scanning(&[scan], Who::Agent));
    }

    #[test]
    fn deleting_a_branch_checks_no_commits() {
        let signed = ruleset("s", &["~ALL"], vec![all(Rule::RequiredSignatures(NoParameters {}))]);
        let deleted = RefChange { new: None, complete: false, ..update("refs/heads/feature") };
        assert!(!refused(&judge(&[signed], "main", Who::Person, &deleted)));
    }

    #[test]
    fn several_rulesets_stack() {
        let a = ruleset("a", &["main"], vec![all(Rule::NonFastForward(NoParameters {}))]);
        let b = ruleset("b", &["~ALL"], vec![all(Rule::PullRequest(PullRequestRule::default()))]);
        let forced = RefChange { fast_forward: Some(false), ..update("refs/heads/main") };
        let judged = judge(&[a, b], "main", Who::Person, &forced);
        let rules: Vec<&str> = blocking(&judged).iter().map(|violation| violation.rule.as_str()).collect();
        assert_eq!(rules, vec!["non_fast_forward", "pull_request"]);
    }
}
