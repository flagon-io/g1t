//! Judging a pull request's merge into a branch: approvals, checks,
//! deployments, the commits it lands, and the agent-first rules (how sure
//! g1t is of an agent's change, what it cost, who must look at sensitive
//! paths, and when merging is allowed at all).
//!
//! The merge button, the API, MCP, auto-merge, g1t's lifecycle and the
//! merge queue all ask this one question, so a pull request merges the
//! same way whoever merges it.

use std::collections::HashMap;

use g1t_contracts::rules::{
    Applicable, ConfidenceLevel, Enforcement, InspectedCommits, Integration, MergeMethod, MergeQueueRule, Rule,
    StatusChecksRule,
};
use g1t_contracts::work::{CommitStatus, RequiredState, Verdict, check_name, required_checks};

use crate::content::{self, Problem};
use crate::glob;
use crate::outcome::Judged;
use crate::select::applies_to_ref;
use crate::window;

/// One reviewer's latest verdict.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Review {
    pub reviewer_id: String,
    pub username: String,
    pub verdict: Verdict,
    /// RFC 3339.
    pub at: String,
    /// g1t's reviewer agent.
    pub agent: bool,
}

/// Everything a merge is judged on.
#[derive(Clone, Debug, Default)]
pub struct MergeFacts<'a> {
    /// The branch it merges into, as a full ref.
    pub git_ref: String,
    /// Whether an agent made the change.
    pub agent_change: bool,
    /// Who answers for it (whoever asked g1t for it, or its author).
    pub owner_id: &'a str,
    /// Each reviewer's latest verdict.
    pub reviews: &'a [Review],
    /// When its head last moved, and by whom (a user id), if known.
    pub head_pushed_at: Option<&'a str>,
    pub head_pushed_by: Option<&'a str>,
    /// What its code owners have still to approve, when that was asked.
    pub code_owners_missing: Option<&'a str>,
    /// The statuses on its head.
    pub statuses: &'a [CommitStatus],
    /// Whether the branch it merges into has moved without it.
    pub behind: bool,
    /// The files it changes.
    pub files: &'a [String],
    /// Its commits, read, when a rule about commits holds.
    pub commits: Option<&'a InspectedCommits>,
    /// How sure g1t is of an agent's change, once rated.
    pub confidence: Option<ConfidenceLevel>,
    /// What agents have spent on it, in US dollars.
    pub spent_usd: f64,
    /// Milliseconds since the epoch.
    pub now_ms: u64,
    pub method: Option<MergeMethod>,
    /// The people of each team a rule names, by `workspace/slug`,
    /// usernames lowercase.
    pub team_members: Option<&'a HashMap<String, Vec<String>>>,
    /// The merger asked to merge past required checks.
    pub ignore_checks: bool,
}

/// Where a status came from: as recorded, or from its name.
pub fn integration_of(status: &CommitStatus) -> Integration {
    if let Some(found) = status.source.as_deref().and_then(Integration::parse) {
        return found;
    }
    let context = status.context.as_str();
    if context.starts_with("g1t / deploy") {
        Integration::Deployments
    } else if matches!(context, "Code scanning" | "Dependency review") {
        Integration::Security
    } else if context.starts_with("g1t / ") || context == "Code owners" {
        Integration::G1t
    } else {
        Integration::Actions
    }
}

/// The statuses that may meet `rule`'s checks: a check pinned to an
/// integration is met only by statuses that integration reported.
pub fn statuses_for(rule: &StatusChecksRule, statuses: &[CommitStatus]) -> Vec<CommitStatus> {
    statuses
        .iter()
        .filter(|status| {
            let name = check_name(&status.context).0;
            rule.checks.iter().all(|check| {
                !check.context.trim().eq_ignore_ascii_case(name)
                    || check.integration.is_none_or(|wanted| integration_of(status) == wanted)
            })
        })
        .cloned()
        .collect()
}

/// Whether a status checks rule holds for a pull request changing `files`.
pub fn checks_hold(rule: &StatusChecksRule, files: &[String]) -> bool {
    rule.paths.is_empty() || files.iter().any(|file| rule.paths.iter().any(|pattern| glob::path_matches(pattern, file)))
}

fn plural(count: u32, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

/// The people (not g1t, not its owner) who approve it now; with `fresh`,
/// only approvals given since its head last moved.
fn people_approving<'a>(facts: &'a MergeFacts<'_>, fresh: bool) -> impl Iterator<Item = &'a Review> {
    facts.reviews.iter().filter(move |review| {
        review.verdict == Verdict::Approve
            && !review.agent
            && review.reviewer_id != facts.owner_id
            && (!fresh || facts.head_pushed_at.is_none_or(|pushed| review.at.as_str() >= pushed))
    })
}

fn pull_request_problems(rule: &g1t_contracts::rules::PullRequestRule, facts: &MergeFacts<'_>) -> Vec<Problem> {
    let mut problems = Vec::new();
    if rule.required_approvals > 0 {
        let others = || facts.reviews.iter().filter(|review| review.reviewer_id != facts.owner_id);
        if others().any(|review| review.verdict == Verdict::RequestChanges) {
            problems.push(Problem::new(
                "A reviewer has asked for changes.",
                "Address the review and ask them to review again.",
            ));
        } else {
            let counted = others()
                .filter(|review| review.verdict == Verdict::Approve)
                .filter(|review| rule.count_agent_approvals || !review.agent)
                .filter(|review| {
                    !rule.dismiss_stale_reviews_on_push || facts.head_pushed_at.is_none_or(|pushed| review.at.as_str() >= pushed)
                })
                .count() as u32;
            if counted < rule.required_approvals {
                let from = if rule.count_agent_approvals { "" } else { " from people" };
                let since = if rule.dismiss_stale_reviews_on_push { " since its latest push" } else { "" };
                problems.push(Problem::new(
                    format!(
                        "It needs {}{from}{since}; it has {counted}.",
                        plural(rule.required_approvals, "approving review", "approving reviews")
                    ),
                    "Ask for a review.",
                ));
            }
        }
    }
    if rule.require_code_owner_review
        && let Some(missing) = facts.code_owners_missing
    {
        problems.push(Problem::new(missing.to_owned(), "Ask its code owners to review it."));
    }
    if rule.require_last_push_approval {
        let pusher = facts.head_pushed_by.unwrap_or(facts.owner_id);
        let approved = facts.reviews.iter().any(|review| {
            review.verdict == Verdict::Approve
                && review.reviewer_id != pusher
                && (rule.count_agent_approvals || !review.agent)
                && facts.head_pushed_at.is_none_or(|pushed| review.at.as_str() >= pushed)
        });
        if !approved {
            problems.push(Problem::new(
                "Its latest push has not been approved by someone other than whoever pushed it.",
                "Ask someone else to review the latest changes.",
            ));
        }
    }
    if let Some(method) = facts.method
        && !rule.allowed_merge_methods.is_empty()
        && !rule.allowed_merge_methods.contains(&method)
    {
        let allowed: Vec<&str> = rule.allowed_merge_methods.iter().map(|method| method.as_str()).collect();
        problems.push(Problem::new(
            format!("This branch allows only {} merges, and this one would be a {} merge.", allowed.join(" or "), method.as_str()),
            "Merge it another way allowed here.",
        ));
    }
    problems
}

fn checks_problems(rule: &StatusChecksRule, facts: &MergeFacts<'_>) -> Vec<Problem> {
    if !checks_hold(rule, facts.files) {
        return Vec::new();
    }
    let mut problems = Vec::new();
    if !(facts.ignore_checks && rule.allow_bypass_on_merge) {
        let names: Vec<String> = rule.checks.iter().map(|check| check.context.trim().to_owned()).collect();
        let statuses = statuses_for(rule, facts.statuses);
        for check in required_checks(&names, &statuses) {
            let pinned = rule
                .checks
                .iter()
                .find(|wanted| wanted.context.trim().eq_ignore_ascii_case(&check.name))
                .and_then(|wanted| wanted.integration)
                .map(|integration| format!(" from {}", integration.as_str()))
                .unwrap_or_default();
            let message = match check.state {
                RequiredState::Success => continue,
                RequiredState::Failure => format!("The required check {}{pinned} failed.", check.name),
                RequiredState::Pending => format!("The required check {}{pinned} has not finished.", check.name),
                RequiredState::Expected => format!("The required check {}{pinned} has not reported on its latest commit.", check.name),
            };
            let remedy = if rule.allow_bypass_on_merge {
                "Wait or fix it, or bypass the required checks as you merge."
            } else {
                "Wait for it to pass, or push a fix."
            };
            problems.push(Problem::new(message, remedy));
        }
    }
    if rule.strict && facts.behind {
        problems.push(Problem::new(
            "It is behind the branch it merges into, which requires pull requests to be up to date.",
            "Catch up with the branch first; its required checks then run again.",
        ));
    }
    problems
}

/// The status a deployment to `environment` reports.
pub fn deployment_context(environment: &str) -> String {
    let environment = environment.trim();
    if environment.is_empty() || environment.eq_ignore_ascii_case("preview") {
        "g1t / deploy".to_owned()
    } else {
        format!("g1t / deploy ({environment})")
    }
}

/// The check a deployment reported to `environment` sets on its commit,
/// through the API or by a g1t Actions job (services/deployments).
pub fn reported_deployment_context(environment: &str) -> String {
    format!("deploy / {}", environment.trim())
}

fn level_rank(level: ConfidenceLevel) -> u8 {
    match level {
        ConfidenceLevel::Low => 0,
        ConfidenceLevel::Medium => 1,
        ConfidenceLevel::High => 2,
    }
}

/// The problems one rule finds in a merge.
fn rule_problems(rule: &Rule, facts: &MergeFacts<'_>) -> Vec<Problem> {
    match rule {
        // Restricting updates restricts merges too: a merge moves the branch.
        Rule::Update(_) => {
            let branch = facts.git_ref.strip_prefix("refs/heads/").unwrap_or(&facts.git_ref);
            vec![Problem::new(
                format!("Only people this ruleset lets bypass it may change {branch}, merges included."),
                "Ask someone who may bypass this ruleset to merge it.",
            )]
        }
        Rule::PullRequest(rule) => pull_request_problems(rule, facts),
        Rule::RequiredStatusChecks(rule) => checks_problems(rule, facts),
        Rule::RequiredDeployments(rule) => rule
            .environments
            .iter()
            .filter(|environment| !environment.trim().is_empty())
            .filter_map(|environment| {
                // A g1t.page build's check, or a deployment reported to the
                // environment from anywhere (`deploy / <environment>`): one
                // that succeeded meets the rule.
                let contexts = [deployment_context(environment), reported_deployment_context(environment)];
                let matching: Vec<&str> = facts
                    .statuses
                    .iter()
                    .filter(|status| contexts.iter().any(|context| status.context.eq_ignore_ascii_case(context)))
                    .map(|status| status.state.as_str())
                    .collect();
                let state = matching
                    .iter()
                    .find(|state| **state == "success")
                    .or_else(|| matching.iter().find(|state| **state == "pending"))
                    .or_else(|| matching.first())
                    .copied();
                (state != Some("success")).then(|| {
                    Problem::new(
                        format!(
                            "It has not deployed to {} successfully{}.",
                            environment.trim(),
                            match state {
                                Some("pending") => " yet: the deployment is running",
                                Some(_) => ": the deployment failed",
                                None => "",
                            }
                        ),
                        "Wait for its deployment, or fix what made it fail and push.",
                    )
                })
            })
            .collect(),
        rule if content::about_content(rule) => match facts.commits {
            Some(inspected) => content::problems(rule, &inspected.commits, inspected.complete),
            None => Vec::new(),
        },
        Rule::ConfidenceThreshold(rule) if facts.agent_change => {
            let below = facts.confidence.is_none_or(|level| level_rank(level) < level_rank(rule.minimum));
            let approvals = people_approving(facts, false).count() as u32;
            if below && approvals < rule.required_approvals.max(1) {
                let rated = match facts.confidence {
                    Some(level) => format!("g1t rates this agent's change {} confidence", level.as_str()),
                    None => "g1t has not rated this agent's change yet".to_owned(),
                };
                vec![Problem::new(
                    format!(
                        "{rated}; below {} it needs {}.",
                        rule.minimum.as_str(),
                        plural(rule.required_approvals.max(1), "approval from a person", "approvals from people")
                    ),
                    "Review the change and approve it if it is right.",
                )]
            } else {
                Vec::new()
            }
        }
        Rule::CostCap(rule) if facts.spent_usd > rule.max_usd => {
            if people_approving(facts, false).next().is_some() {
                Vec::new()
            } else {
                vec![Problem::new(
                    format!(
                        "Agents have spent ${:.2} on this pull request, over its ${:.2} cap.",
                        facts.spent_usd, rule.max_usd
                    ),
                    "A person must approve it before it merges or its agent continues.",
                )]
            }
        }
        Rule::PathReview(rule) => {
            let touched: Vec<&String> = facts
                .files
                .iter()
                .filter(|file| rule.paths.iter().any(|pattern| glob::path_matches(pattern, file)))
                .collect();
            if touched.is_empty() || rule.required_approvals == 0 {
                return Vec::new();
            }
            let members = rule.team.as_ref().map(|team| {
                facts
                    .team_members
                    .and_then(|teams| teams.get(&team.trim().trim_start_matches('@').to_lowercase()).cloned())
                    .unwrap_or_default()
            });
            let approvals = people_approving(facts, true)
                .filter(|review| members.as_ref().is_none_or(|members| members.contains(&review.username.to_lowercase())))
                .count() as u32;
            if approvals >= rule.required_approvals {
                return Vec::new();
            }
            let from = rule.team.as_ref().map(|team| format!(" from @{}", team.trim().trim_start_matches('@'))).unwrap_or_default();
            let shown: Vec<&str> = touched.iter().take(3).map(|file| file.as_str()).collect();
            let more = if touched.len() > 3 { format!(" and {} more", touched.len() - 3) } else { String::new() };
            vec![Problem::new(
                format!(
                    "It changes sensitive paths ({}{more}), which need {}{from} since its latest push; it has {approvals}.",
                    shown.join(", "),
                    plural(rule.required_approvals, "approval", "approvals")
                ),
                format!("Ask{} for a review.", if from.is_empty() { String::new() } else { from.replacen(" from", "", 1) }),
            )]
        }
        Rule::MergeWindow(rule) => match window::closed(rule, facts.now_ms) {
            Some(closed) => vec![Problem::new(window::explain(&closed), "Merge when the window opens, or ask someone who may bypass this ruleset.")],
            None => Vec::new(),
        },
        _ => Vec::new(),
    }
}

/// How every applicable ruleset judges merging a pull request.
pub fn judge(rulesets: &[Applicable], default_branch: &str, facts: &MergeFacts<'_>) -> Vec<Judged> {
    rulesets
        .iter()
        .filter(|ruleset| applies_to_ref(ruleset, &facts.git_ref, default_branch))
        .map(|ruleset| {
            let mut judged = Judged::of(ruleset, &facts.git_ref, true);
            for entry in &ruleset.rules {
                if !entry.applies_to.covers(facts.agent_change) {
                    continue;
                }
                let kind = entry.rule.kind();
                for problem in rule_problems(&entry.rule, facts) {
                    judged.add(kind, problem);
                }
            }
            judged
        })
        .collect()
}

/// Whether merging needs the pull request's commits read: a rule about
/// commits holds, for whoever made the change.
pub fn needs_commits(rulesets: &[Applicable], agent_change: bool) -> bool {
    rulesets.iter().any(|ruleset| {
        ruleset
            .rules
            .iter()
            .any(|entry| entry.applies_to.covers(agent_change) && content::about_content(&entry.rule) && !matches!(entry.rule, Rule::SecretScanning(_)))
    })
}

/// The teams rules name, for their people to be looked up.
pub fn named_teams(rulesets: &[Applicable]) -> Vec<String> {
    let mut teams: Vec<String> = rulesets
        .iter()
        .flat_map(|ruleset| ruleset.rules.iter())
        .filter_map(|entry| match &entry.rule {
            Rule::PathReview(rule) => rule.team.clone(),
            _ => None,
        })
        .collect();
    teams.sort();
    teams.dedup();
    teams
}

/// What the active rules ask of a branch, in the terms g1t's lifecycle,
/// pull request page and merge queue use. Evaluate-mode rulesets add
/// nothing here: they never hold a pull request up.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Requirements {
    /// Whether changes reach the branch only through pull requests.
    pub pull_request: bool,
    /// Every required check, by name, that holds for the files changed.
    pub required_checks: Vec<String>,
    pub strict: bool,
    /// Whether every status checks rule lets a merger bypass its checks.
    pub allow_bypass_on_merge: bool,
    pub required_approvals: u32,
    /// Whether every pull request rule counts agents' approvals.
    pub count_agent_approvals: bool,
    pub require_code_owner_review: bool,
    /// The merge queue, if a rule requires it.
    pub merge_queue: Option<MergeQueueRule>,
    /// Whether g1t may land an agent's change here by itself, and the
    /// confidence it needs to.
    pub agent_auto_merge: bool,
    pub auto_merge_confidence: Option<ConfidenceLevel>,
    /// The highest cost cap below which an agent continues on its own.
    pub cost_cap: Option<f64>,
}

/// What the active rules hold for, stacked: the most restrictive wins.
pub fn requirements(rulesets: &[Applicable], git_ref: &str, default_branch: &str, agent_change: bool, files: &[String]) -> Requirements {
    let mut found = Requirements {
        count_agent_approvals: true,
        allow_bypass_on_merge: true,
        agent_auto_merge: true,
        ..Requirements::default()
    };
    let mut any_checks = false;
    for ruleset in rulesets
        .iter()
        .filter(|ruleset| ruleset.enforcement == Enforcement::Active)
        .filter(|ruleset| applies_to_ref(ruleset, git_ref, default_branch))
    {
        for entry in ruleset.rules.iter().filter(|entry| entry.applies_to.covers(agent_change)) {
            match &entry.rule {
                Rule::PullRequest(rule) => {
                    found.pull_request = true;
                    found.required_approvals = found.required_approvals.max(rule.required_approvals);
                    found.count_agent_approvals &= rule.count_agent_approvals;
                    found.require_code_owner_review |= rule.require_code_owner_review;
                }
                Rule::RequiredStatusChecks(rule) if checks_hold(rule, files) => {
                    any_checks = true;
                    found.strict |= rule.strict;
                    found.allow_bypass_on_merge &= rule.allow_bypass_on_merge;
                    for check in &rule.checks {
                        let name = check.context.trim().to_owned();
                        if !name.is_empty() && !found.required_checks.iter().any(|have| have.eq_ignore_ascii_case(&name)) {
                            found.required_checks.push(name);
                        }
                    }
                }
                Rule::MergeQueue(rule) => {
                    found.pull_request = true;
                    found.merge_queue = Some(match found.merge_queue.take() {
                        // Two queue rules: the smaller batches and the
                        // longer waits of either.
                        Some(have) => MergeQueueRule {
                            merge_method: have.merge_method,
                            max_entries_to_build: have.max_entries_to_build.min(rule.max_entries_to_build),
                            min_entries_to_merge: have.min_entries_to_merge.max(rule.min_entries_to_merge),
                            min_entries_wait_minutes: have.min_entries_wait_minutes.max(rule.min_entries_wait_minutes),
                            check_response_timeout_minutes: have.check_response_timeout_minutes.min(rule.check_response_timeout_minutes),
                        },
                        None => rule.clone(),
                    });
                }
                Rule::AgentAutoMerge(rule) => {
                    found.agent_auto_merge &= rule.allowed;
                    if let Some(minimum) = rule.minimum_confidence {
                        found.auto_merge_confidence = Some(match found.auto_merge_confidence {
                            Some(have) if level_rank(have) >= level_rank(minimum) => have,
                            _ => minimum,
                        });
                    }
                }
                Rule::CostCap(rule) => {
                    found.cost_cap = Some(found.cost_cap.map_or(rule.max_usd, |have| have.min(rule.max_usd)));
                }
                _ => {}
            }
        }
    }
    if !any_checks {
        // Nothing to bypass: the setting means nothing without checks.
        found.allow_bypass_on_merge = true;
    }
    found
}

/// Whether g1t may land an agent's change into the branch by itself, given
/// how sure of it g1t is; why not, if it may not.
pub fn auto_merge_refusal(requirements: &Requirements, confidence: Option<ConfidenceLevel>) -> Option<String> {
    if !requirements.agent_auto_merge {
        return Some("Rules for this branch do not let agents' changes merge by themselves.".to_owned());
    }
    let minimum = requirements.auto_merge_confidence?;
    if confidence.is_some_and(|level| level_rank(level) >= level_rank(minimum)) {
        return None;
    }
    Some(format!("Rules for this branch let an agent's change merge by itself only at {} confidence or higher.", minimum.as_str()))
}

/// Whether a violation is about checks or being up to date, which g1t's
/// lifecycle waits for on its own, rather than something people must do.
pub fn about_checks(rule: &str) -> bool {
    matches!(rule, "required_status_checks" | "required_deployments")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content::tests_support::commit;
    use crate::outcome::{blocking, refused};
    use g1t_contracts::rules::{
        AppliesTo, BypassMode, ConfidenceRule, CostCapRule, DeploymentsRule, Level, MergeWindowRule, NoParameters,
        PathReviewRule, Period, PullRequestRule, RefCondition, RequiredCheck, RuleEntry, Verdict as Outcome,
    };

    fn ruleset(rules: Vec<RuleEntry>) -> Applicable {
        Applicable {
            id: "rs_1".into(),
            name: "Protect main".into(),
            level: Level::Repository,
            enforcement: Enforcement::Active,
            target: g1t_contracts::rules::Target::Branch,
            conditions: RefCondition { include: vec!["~DEFAULT_BRANCH".into()], exclude: Vec::new() },
            rules,
            bypass: None,
        }
    }

    fn all(rule: Rule) -> RuleEntry {
        RuleEntry::everyone(rule)
    }

    fn review(id: &str, verdict: Verdict, at: &str) -> Review {
        Review { reviewer_id: id.into(), username: id.into(), verdict, at: at.into(), agent: id == "g1t" }
    }

    fn status(context: &str, state: &str) -> CommitStatus {
        CommitStatus { context: context.into(), state: state.into(), description: None, target_url: None, updated_at: String::new(), source: None }
    }

    fn facts<'a>(reviews: &'a [Review], statuses: &'a [CommitStatus], files: &'a [String]) -> MergeFacts<'a> {
        MergeFacts {
            git_ref: "refs/heads/main".into(),
            owner_id: "ada",
            reviews,
            statuses,
            files,
            now_ms: 1_000,
            method: Some(MergeMethod::Merge),
            ..MergeFacts::default()
        }
    }

    fn messages(judged: &[Judged]) -> Vec<String> {
        blocking(judged).iter().map(|violation| violation.message.clone()).collect()
    }

    #[test]
    fn approvals_are_counted_as_the_rule_says() {
        let rules = [ruleset(vec![all(Rule::PullRequest(PullRequestRule { required_approvals: 2, ..PullRequestRule::default() }))])];
        let one = [review("bob", Verdict::Approve, "2026-10-07T10:00:00Z"), review("ada", Verdict::Approve, "2026-10-07T10:00:00Z")];
        assert_eq!(messages(&judge(&rules, "main", &facts(&one, &[], &[]))), vec!["It needs 2 approving reviews; it has 1."]);
        let two = [review("bob", Verdict::Approve, "x"), review("g1t", Verdict::Approve, "x")];
        assert!(!refused(&judge(&rules, "main", &facts(&two, &[], &[]))));
        let people_only = [ruleset(vec![all(Rule::PullRequest(PullRequestRule {
            required_approvals: 2,
            count_agent_approvals: false,
            ..PullRequestRule::default()
        }))])];
        assert_eq!(
            messages(&judge(&people_only, "main", &facts(&two, &[], &[]))),
            vec!["It needs 2 approving reviews from people; it has 1."]
        );
        let blocked = [review("bob", Verdict::Approve, "x"), review("cy", Verdict::RequestChanges, "x")];
        assert_eq!(messages(&judge(&rules, "main", &facts(&blocked, &[], &[]))), vec!["A reviewer has asked for changes."]);
    }

    #[test]
    fn stale_approvals_and_the_last_push() {
        let rules = [ruleset(vec![all(Rule::PullRequest(PullRequestRule {
            required_approvals: 1,
            dismiss_stale_reviews_on_push: true,
            require_last_push_approval: true,
            ..PullRequestRule::default()
        }))])];
        let before = [review("bob", Verdict::Approve, "2026-10-07T09:00:00Z")];
        let mut pushed = facts(&before, &[], &[]);
        pushed.head_pushed_at = Some("2026-10-07T10:00:00Z");
        pushed.head_pushed_by = Some("bob");
        let found = messages(&judge(&rules, "main", &pushed));
        assert_eq!(found.len(), 2);
        assert_eq!(found[0], "It needs 1 approving review since its latest push; it has 0.");
        // Bob approves again, but he pushed last: someone else must.
        let after = [review("bob", Verdict::Approve, "2026-10-07T11:00:00Z")];
        let mut again = facts(&after, &[], &[]);
        again.head_pushed_at = Some("2026-10-07T10:00:00Z");
        again.head_pushed_by = Some("bob");
        assert_eq!(
            messages(&judge(&rules, "main", &again)),
            vec!["Its latest push has not been approved by someone other than whoever pushed it."]
        );
        let other = [review("cy", Verdict::Approve, "2026-10-07T11:00:00Z")];
        let mut fine = facts(&other, &[], &[]);
        fine.head_pushed_at = Some("2026-10-07T10:00:00Z");
        fine.head_pushed_by = Some("bob");
        assert!(!refused(&judge(&rules, "main", &fine)));
    }

    #[test]
    fn code_owners_and_merge_methods() {
        let rules = [ruleset(vec![all(Rule::PullRequest(PullRequestRule {
            require_code_owner_review: true,
            allowed_merge_methods: vec![MergeMethod::Squash],
            ..PullRequestRule::default()
        }))])];
        let mut waiting = facts(&[], &[], &[]);
        waiting.code_owners_missing = Some("@acme/docs must approve changes to docs/.");
        let found = messages(&judge(&rules, "main", &waiting));
        assert_eq!(found[0], "@acme/docs must approve changes to docs/.");
        assert_eq!(found[1], "This branch allows only squash merges, and this one would be a merge merge.");
    }

    #[test]
    fn required_checks_pass_fail_wait_and_can_be_bypassed() {
        let checks = |allow: bool| {
            [ruleset(vec![all(Rule::RequiredStatusChecks(StatusChecksRule {
                checks: vec![RequiredCheck { context: "CI".into(), integration: None }, RequiredCheck { context: "Lint".into(), integration: None }],
                allow_bypass_on_merge: allow,
                ..StatusChecksRule::default()
            }))])]
        };
        let statuses = [status("CI / pull_request", "failure")];
        let found = messages(&judge(&checks(false), "main", &facts(&[], &statuses, &[])));
        assert_eq!(found, vec!["The required check CI failed.", "The required check Lint has not reported on its latest commit."]);
        let mut ignoring = facts(&[], &statuses, &[]);
        ignoring.ignore_checks = true;
        assert!(refused(&judge(&checks(false), "main", &ignoring)), "not where the rule forbids it");
        assert!(!refused(&judge(&checks(true), "main", &ignoring)));
        let green = [status("CI / pull_request", "success"), status("Lint / pull_request", "success")];
        assert!(!refused(&judge(&checks(false), "main", &facts(&[], &green, &[]))));
    }

    #[test]
    fn a_check_pinned_to_an_integration_counts_only_its_statuses() {
        let rules = [ruleset(vec![all(Rule::RequiredStatusChecks(StatusChecksRule {
            checks: vec![RequiredCheck { context: "g1t / deploy".into(), integration: Some(Integration::Deployments) }],
            ..StatusChecksRule::default()
        }))])];
        // A workflow named "g1t" on a "deploy" event is not the deployment.
        let mut forged = status("g1t / deploy", "success");
        forged.source = Some("actions".into());
        assert_eq!(
            messages(&judge(&rules, "main", &facts(&[], &[forged], &[]))),
            vec!["The required check g1t / deploy from deployments has not reported on its latest commit."]
        );
        let real = status("g1t / deploy", "success");
        assert!(!refused(&judge(&rules, "main", &facts(&[], &[real], &[]))));
    }

    #[test]
    fn checks_required_only_for_some_paths() {
        let rules = [ruleset(vec![all(Rule::RequiredStatusChecks(StatusChecksRule {
            checks: vec![RequiredCheck { context: "Terraform".into(), integration: None }],
            paths: vec!["infra/**".into()],
            ..StatusChecksRule::default()
        }))])];
        let docs = vec!["docs/a.md".to_owned()];
        assert!(!refused(&judge(&rules, "main", &facts(&[], &[], &docs))));
        let infra = vec!["infra/main.tf".to_owned()];
        assert!(refused(&judge(&rules, "main", &facts(&[], &[], &infra))));
        assert!(requirements(&rules, "refs/heads/main", "main", false, &docs).required_checks.is_empty());
        assert_eq!(requirements(&rules, "refs/heads/main", "main", false, &infra).required_checks, vec!["Terraform"]);
    }

    #[test]
    fn being_up_to_date_and_deployments() {
        let rules = [ruleset(vec![
            all(Rule::RequiredStatusChecks(StatusChecksRule { strict: true, ..StatusChecksRule::default() })),
            all(Rule::RequiredDeployments(DeploymentsRule { environments: vec!["preview".into(), "docs".into()] })),
        ])];
        let statuses = [status("g1t / deploy", "success"), status("g1t / deploy (docs)", "pending")];
        let mut behind = facts(&[], &statuses, &[]);
        behind.behind = true;
        assert_eq!(
            messages(&judge(&rules, "main", &behind)),
            vec![
                "It is behind the branch it merges into, which requires pull requests to be up to date.",
                "It has not deployed to docs successfully yet: the deployment is running."
            ]
        );
    }

    #[test]
    fn a_deployment_reported_from_anywhere_meets_the_rule() {
        let rules = [ruleset(vec![all(Rule::RequiredDeployments(DeploymentsRule { environments: vec!["staging".into()] }))])];
        let reported = [status("deploy / staging", "success")];
        assert!(messages(&judge(&rules, "main", &facts(&[], &reported, &[]))).is_empty());
        let failed = [status("deploy / Staging", "failure")];
        assert_eq!(
            messages(&judge(&rules, "main", &facts(&[], &failed, &[]))),
            vec!["It has not deployed to staging successfully: the deployment failed."]
        );
        let none: [g1t_contracts::work::CommitStatus; 0] = [];
        assert_eq!(messages(&judge(&rules, "main", &facts(&[], &none, &[]))), vec!["It has not deployed to staging successfully."]);
    }

    #[test]
    fn commits_it_lands_are_checked_when_read() {
        let rules = [ruleset(vec![all(Rule::RequiredLinearHistory(NoParameters {}))])];
        assert!(needs_commits(&rules, false));
        let mut merge = commit("abcdef12", "Merge main", &[]);
        merge.parents = 2;
        let inspected = InspectedCommits { commits: vec![merge], complete: true };
        let mut read = facts(&[], &[], &[]);
        read.commits = Some(&inspected);
        assert_eq!(blocking(&judge(&rules, "main", &read))[0].rule, "required_linear_history");
        let unread = InspectedCommits { commits: Vec::new(), complete: false };
        read.commits = Some(&unread);
        assert!(refused(&judge(&rules, "main", &read)));
    }

    #[test]
    fn agent_changes_below_the_confidence_threshold_need_a_person() {
        let rules = [ruleset(vec![all(Rule::ConfidenceThreshold(ConfidenceRule { minimum: ConfidenceLevel::High, required_approvals: 1 }))])];
        let mut agent = facts(&[], &[], &[]);
        agent.agent_change = true;
        agent.confidence = Some(ConfidenceLevel::Medium);
        assert_eq!(
            messages(&judge(&rules, "main", &agent)),
            vec!["g1t rates this agent's change medium confidence; below high it needs 1 approval from a person."]
        );
        agent.confidence = Some(ConfidenceLevel::High);
        assert!(!refused(&judge(&rules, "main", &agent)));
        agent.confidence = None;
        assert!(refused(&judge(&rules, "main", &agent)));
        let approved = [review("bob", Verdict::Approve, "x")];
        let mut seen = facts(&approved, &[], &[]);
        seen.agent_change = true;
        assert!(!refused(&judge(&rules, "main", &seen)));
        // A g1t approval is not a person's.
        let robot = [review("g1t", Verdict::Approve, "x")];
        let mut unseen = facts(&robot, &[], &[]);
        unseen.agent_change = true;
        assert!(refused(&judge(&rules, "main", &unseen)));
        // A person's change is not rated.
        assert!(!refused(&judge(&rules, "main", &facts(&[], &[], &[]))));
    }

    #[test]
    fn rules_for_agents_and_for_people() {
        let agents_need_a_human = RuleEntry {
            rule: Rule::PullRequest(PullRequestRule { required_approvals: 1, count_agent_approvals: false, ..PullRequestRule::default() }),
            applies_to: AppliesTo::Agents,
        };
        let rules = [ruleset(vec![agents_need_a_human])];
        let robot = [review("g1t", Verdict::Approve, "x")];
        let mut agent = facts(&robot, &[], &[]);
        agent.agent_change = true;
        assert_eq!(messages(&judge(&rules, "main", &agent)), vec!["It needs 1 approving review from people; it has 0."]);
        assert!(!refused(&judge(&rules, "main", &facts(&robot, &[], &[]))), "people's changes are not held");
    }

    #[test]
    fn a_cost_cap_holds_until_a_person_approves() {
        let rules = [ruleset(vec![all(Rule::CostCap(CostCapRule { max_usd: 5.0 }))])];
        let mut costly = facts(&[], &[], &[]);
        costly.spent_usd = 7.5;
        assert_eq!(
            messages(&judge(&rules, "main", &costly)),
            vec!["Agents have spent $7.50 on this pull request, over its $5.00 cap."]
        );
        costly.spent_usd = 4.0;
        assert!(!refused(&judge(&rules, "main", &costly)));
        let approved = [review("bob", Verdict::Approve, "x")];
        let mut seen = facts(&approved, &[], &[]);
        seen.spent_usd = 7.5;
        assert!(!refused(&judge(&rules, "main", &seen)));
        assert_eq!(requirements(&rules, "refs/heads/main", "main", false, &[]).cost_cap, Some(5.0));
    }

    #[test]
    fn sensitive_paths_need_their_teams_approval() {
        let rules = [ruleset(vec![all(Rule::PathReview(PathReviewRule {
            paths: vec!["infra/**".into(), "*.tf".into()],
            required_approvals: 2,
            team: Some("acme/platform".into()),
        }))])];
        let files = vec!["infra/main.tf".to_owned(), "src/lib.rs".to_owned()];
        let mut teams = HashMap::new();
        teams.insert("acme/platform".to_owned(), vec!["bob".to_owned(), "cy".to_owned()]);
        let reviews = [review("bob", Verdict::Approve, "x"), review("dee", Verdict::Approve, "x")];
        let mut one = facts(&reviews, &[], &files);
        one.team_members = Some(&teams);
        assert_eq!(
            messages(&judge(&rules, "main", &one)),
            vec!["It changes sensitive paths (infra/main.tf), which need 2 approvals from @acme/platform since its latest push; it has 1."]
        );
        let both = [review("bob", Verdict::Approve, "x"), review("cy", Verdict::Approve, "x")];
        let mut two = facts(&both, &[], &files);
        two.team_members = Some(&teams);
        assert!(!refused(&judge(&rules, "main", &two)));
        let docs = vec!["docs/a.md".to_owned()];
        assert!(!refused(&judge(&rules, "main", &facts(&[], &[], &docs))));
        assert_eq!(named_teams(&rules), vec!["acme/platform"]);
    }

    #[test]
    fn restricting_updates_restricts_merges() {
        let rules = [ruleset(vec![all(Rule::Update(NoParameters {}))])];
        assert_eq!(
            messages(&judge(&rules, "main", &facts(&[], &[], &[]))),
            vec!["Only people this ruleset lets bypass it may change main, merges included."]
        );
        let mut bypassed = rules[0].clone();
        bypassed.bypass = Some(BypassMode::Always);
        assert!(!refused(&judge(&[bypassed], "main", &facts(&[], &[], &[]))));
    }

    #[test]
    fn a_merge_freeze_holds_merges() {
        let rules = [ruleset(vec![all(Rule::MergeWindow(MergeWindowRule {
            freezes: vec![Period { start: "1970-01-01T00:00:00Z".into(), end: None, reason: "Incident".into() }],
            ..MergeWindowRule::default()
        }))])];
        assert_eq!(messages(&judge(&rules, "main", &facts(&[], &[], &[]))), vec!["Merging is frozen (Incident) until the freeze is lifted."]);
    }

    #[test]
    fn bypassing_for_pull_requests_covers_merges() {
        let mut rules = ruleset(vec![all(Rule::PullRequest(PullRequestRule { required_approvals: 1, ..PullRequestRule::default() }))]);
        rules.bypass = Some(BypassMode::PullRequests);
        let judged = judge(&[rules], "main", &facts(&[], &[], &[]));
        assert!(!refused(&judged));
        assert_eq!(judged[0].verdict(), Outcome::Bypass);
    }

    #[test]
    fn requirements_stack_to_the_most_restrictive() {
        let a = ruleset(vec![
            all(Rule::PullRequest(PullRequestRule { required_approvals: 1, ..PullRequestRule::default() })),
            all(Rule::RequiredStatusChecks(StatusChecksRule {
                checks: vec![RequiredCheck { context: "CI".into(), integration: None }],
                allow_bypass_on_merge: true,
                ..StatusChecksRule::default()
            })),
            all(Rule::MergeQueue(MergeQueueRule { max_entries_to_build: 8, ..MergeQueueRule::default() })),
        ]);
        let mut b = ruleset(vec![
            all(Rule::PullRequest(PullRequestRule { required_approvals: 3, count_agent_approvals: false, require_code_owner_review: true, ..PullRequestRule::default() })),
            all(Rule::RequiredStatusChecks(StatusChecksRule {
                checks: vec![RequiredCheck { context: "ci".into(), integration: None }, RequiredCheck { context: "Lint".into(), integration: None }],
                strict: true,
                ..StatusChecksRule::default()
            })),
            all(Rule::MergeQueue(MergeQueueRule { max_entries_to_build: 2, ..MergeQueueRule::default() })),
        ]);
        b.id = "rs_2".into();
        let mut dry = ruleset(vec![all(Rule::PullRequest(PullRequestRule { required_approvals: 6, ..PullRequestRule::default() }))]);
        dry.enforcement = Enforcement::Evaluate;
        let found = requirements(&[a, b, dry], "refs/heads/main", "main", false, &[]);
        assert!(found.pull_request);
        assert_eq!(found.required_approvals, 3, "evaluate mode adds nothing");
        assert!(!found.count_agent_approvals && found.require_code_owner_review && found.strict);
        assert!(!found.allow_bypass_on_merge);
        assert_eq!(found.required_checks, vec!["CI", "Lint"]);
        assert_eq!(found.merge_queue.unwrap().max_entries_to_build, 2);
        assert!(requirements(&[], "refs/heads/main", "main", false, &[]).allow_bypass_on_merge);
    }

    #[test]
    fn agent_auto_merge_by_branch_and_confidence() {
        let rules = [ruleset(vec![all(Rule::AgentAutoMerge(g1t_contracts::rules::AgentAutoMergeRule {
            allowed: true,
            minimum_confidence: Some(ConfidenceLevel::High),
        }))])];
        let found = requirements(&rules, "refs/heads/main", "main", true, &[]);
        assert!(auto_merge_refusal(&found, Some(ConfidenceLevel::Medium)).is_some());
        assert_eq!(auto_merge_refusal(&found, Some(ConfidenceLevel::High)), None);
        let off = [ruleset(vec![all(Rule::AgentAutoMerge(g1t_contracts::rules::AgentAutoMergeRule { allowed: false, minimum_confidence: None }))])];
        assert!(auto_merge_refusal(&requirements(&off, "refs/heads/main", "main", true, &[]), Some(ConfidenceLevel::High)).is_some());
        assert_eq!(auto_merge_refusal(&requirements(&[], "refs/heads/main", "main", true, &[]), None), None);
    }

    #[test]
    fn statuses_come_from_their_integration() {
        assert_eq!(integration_of(&status("CI / pull_request", "success")), Integration::Actions);
        assert_eq!(integration_of(&status("g1t / deploy (docs)", "success")), Integration::Deployments);
        assert_eq!(integration_of(&status("Code scanning", "success")), Integration::Security);
        let mut recorded = status("CI / push", "success");
        recorded.source = Some("security".into());
        assert_eq!(integration_of(&recorded), Integration::Security);
        assert_eq!(deployment_context("preview"), "g1t / deploy");
        assert_eq!(deployment_context("docs"), "g1t / deploy (docs)");
    }
}
