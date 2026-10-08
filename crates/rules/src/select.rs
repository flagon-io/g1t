//! Which rulesets hold where, who may bypass them, and what holds for one
//! branch once they are stacked.

use g1t_contracts::access::{self, RepoRole};
use g1t_contracts::repos::Repo;
use g1t_contracts::rules::{
    ALL, ActorKind, Applicable, BypassActor, BypassMode, DEFAULT_BRANCH, EffectiveRule, EffectiveRules, Enforcement,
    Level, RefCondition, RepositoryCondition, Ruleset, RulesetSummary, Target, VisibilityCondition,
};
use g1t_contracts::{PrincipalKind, Role, User};

use crate::glob;

/// What a ruleset needs to know about a repository to say whether it holds.
#[derive(Clone, Copy, Debug)]
pub struct RepoFacts<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub private: bool,
    pub topics: &'a [String],
    pub default_branch: &'a str,
}

impl<'a> From<&'a Repo> for RepoFacts<'a> {
    fn from(repo: &'a Repo) -> Self {
        RepoFacts {
            id: &repo.id,
            name: &repo.name,
            private: repo.is_private,
            topics: &repo.topics,
            default_branch: &repo.default_branch,
        }
    }
}

/// A name written as a full ref, shortened: `refs/heads/main` is `main`.
fn short(pattern: &str, target: Target) -> &str {
    let prefix = match target {
        Target::Branch => "refs/heads/",
        Target::Tag => "refs/tags/",
    };
    pattern.strip_prefix(prefix).unwrap_or(pattern)
}

fn ref_pattern_matches(pattern: &str, target: Target, name: &str, default_branch: &str) -> bool {
    let pattern = pattern.trim();
    match pattern {
        ALL => true,
        DEFAULT_BRANCH => target == Target::Branch && name == default_branch,
        _ => glob::matches(short(pattern, target), name),
    }
}

/// Whether a branch or tag named `name` is one `condition` selects.
pub fn ref_matches(condition: &RefCondition, target: Target, name: &str, default_branch: &str) -> bool {
    condition.include.iter().any(|pattern| ref_pattern_matches(pattern, target, name, default_branch))
        && !condition.exclude.iter().any(|pattern| ref_pattern_matches(pattern, target, name, default_branch))
}

/// Whether a workspace ruleset's repository condition selects `repo`.
pub fn repo_matches(condition: &RepositoryCondition, repo: RepoFacts<'_>) -> bool {
    let name = repo.name.to_lowercase();
    let named = |pattern: &String| {
        let pattern = pattern.trim();
        pattern == ALL || glob::matches(&pattern.to_lowercase(), &name)
    };
    let visible = match condition.visibility {
        VisibilityCondition::Any => true,
        VisibilityCondition::Public => !repo.private,
        VisibilityCondition::Private => repo.private,
    };
    let topical = condition.topics.is_empty()
        || condition
            .topics
            .iter()
            .any(|topic| repo.topics.iter().any(|has| has.eq_ignore_ascii_case(topic.trim())));
    condition.include.iter().any(named) && !condition.exclude.iter().any(named) && visible && topical
}

/// Whether a ruleset holds in `repo` at all, whatever the branch: a
/// repository's own, or a workspace's that selects it. Disabled ones never.
pub fn holds_in(ruleset: &Ruleset, repo: RepoFacts<'_>) -> bool {
    if ruleset.spec.enforcement == Enforcement::Disabled {
        return false;
    }
    match ruleset.level {
        Level::Repository => ruleset.repo_id.as_deref() == Some(repo.id),
        Level::Workspace => {
            let condition = ruleset.spec.conditions.repository.clone().unwrap_or_default();
            repo_matches(&condition, repo)
        }
    }
}

/// Who is changing something, as bypass lists name people.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ActorFacts {
    pub username: String,
    pub kind: Who,
    /// Their role on the repository.
    pub role: Option<RepoRole>,
    /// Whether they own its workspace.
    pub owner: bool,
    /// The teams they are in, as `workspace/slug`, lowercase.
    pub teams: Vec<String>,
    /// The token they act through, if any.
    pub token_id: Option<String>,
}

/// What kind of actor.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Who {
    #[default]
    Person,
    /// An agent acting through a token, g1t's or another.
    Agent,
    /// g1t acting on its own: the merge queue, security updates.
    G1t,
    /// A workspace's own token.
    Token,
}

impl Who {
    pub fn as_str(self) -> &'static str {
        match self {
            Who::Person => "person",
            Who::Agent => "agent",
            Who::G1t => "g1t",
            Who::Token => "token",
        }
    }

    /// Rules for agents hold for agents and g1t; the rest are people's.
    pub fn is_agent(self) -> bool {
        matches!(self, Who::Agent | Who::G1t)
    }
}

impl ActorFacts {
    /// What `user` is in `repo`. Their teams are the caller's to add.
    pub fn of(user: &User, repo: &Repo) -> ActorFacts {
        let kind = match user.kind {
            PrincipalKind::System => Who::G1t,
            PrincipalKind::Agent => Who::Agent,
            _ if user.acting.is_some() => Who::Agent,
            PrincipalKind::Workspace => Who::Token,
            PrincipalKind::User => Who::Person,
        };
        let token_id = user
            .acting
            .as_ref()
            .map(|acting| acting.credential_id.clone())
            .or_else(|| user.token.as_ref().map(|token| token.token_id.clone()))
            .filter(|id| !id.is_empty());
        ActorFacts {
            username: user.username.clone(),
            kind,
            role: access::permission(Some(user), repo),
            owner: user.role_in(&repo.namespace.to_lowercase()) == Some(Role::Owner),
            teams: Vec::new(),
            token_id,
        }
    }
}

/// A team named in a bypass list or a rule, as `workspace/slug`.
pub fn team_key(name: &str, workspace: &str) -> String {
    let name = name.trim().trim_start_matches('@').to_lowercase();
    if name.contains('/') { name } else { format!("{}/{name}", workspace.to_lowercase()) }
}

/// Whether one bypass entry names the actor. An agent or a token is never
/// named by a role, a team or a person: only by `g1t` or its token, so an
/// agent acting for an admin obeys the rules its admin may bypass.
fn names(entry: &BypassActor, who: &ActorFacts, workspace: &str) -> bool {
    let value = entry.value.trim();
    match entry.kind {
        // g1t's agents act through run tokens (`Agent`), and g1t on its own
        // as `System`.
        ActorKind::G1t => who.kind.is_agent(),
        ActorKind::Token => {
            (value.eq_ignore_ascii_case("workspace") && who.kind == Who::Token)
                || who.token_id.as_deref().is_some_and(|id| !value.is_empty() && id == value)
        }
        _ if who.kind != Who::Person => false,
        ActorKind::User => !value.is_empty() && who.username.eq_ignore_ascii_case(value.trim_start_matches('@')),
        ActorKind::Team => !value.is_empty() && who.teams.contains(&team_key(value, workspace)),
        ActorKind::Role => match value.to_ascii_lowercase().as_str() {
            "owner" => who.owner,
            role => RepoRole::parse(role).is_some_and(|wanted| who.role.is_some_and(|has| has >= wanted)),
        },
    }
}

/// How the actor may bypass a ruleset with these bypass actors, if at all.
/// `always` wins over `pull_requests` when both name them.
pub fn bypass(actors: &[BypassActor], who: &ActorFacts, workspace: &str) -> Option<BypassMode> {
    let modes: Vec<BypassMode> = actors.iter().filter(|entry| names(entry, who, workspace)).map(|entry| entry.mode).collect();
    if modes.contains(&BypassMode::Always) {
        Some(BypassMode::Always)
    } else {
        modes.first().copied()
    }
}

/// Whether any bypass list names a team: only then are the actor's teams
/// worth looking up.
pub fn names_teams(rulesets: &[Ruleset]) -> bool {
    rulesets
        .iter()
        .any(|ruleset| ruleset.spec.bypass_actors.iter().any(|entry| entry.kind == ActorKind::Team))
}

/// The rulesets that hold in `repo` for any of `refs` (full refs), as a
/// service applies them, with how the actor may bypass each.
pub fn applicable(rulesets: &[Ruleset], repo: RepoFacts<'_>, refs: &[String], who: Option<&ActorFacts>, workspace: &str) -> Vec<Applicable> {
    rulesets
        .iter()
        .filter(|ruleset| holds_in(ruleset, repo))
        .filter(|ruleset| {
            refs.iter().any(|git_ref| match Target::of_ref(git_ref) {
                Some((target, name)) => {
                    target == ruleset.spec.target
                        && ref_matches(&ruleset.spec.conditions.ref_name, target, name, repo.default_branch)
                }
                None => false,
            })
        })
        .map(|ruleset| Applicable {
            id: ruleset.id.clone(),
            name: ruleset.spec.name.clone(),
            level: ruleset.level,
            enforcement: ruleset.spec.enforcement,
            target: ruleset.spec.target,
            conditions: ruleset.spec.conditions.ref_name.clone(),
            rules: ruleset.spec.rules.clone(),
            bypass: who.and_then(|who| bypass(&ruleset.spec.bypass_actors, who, workspace)),
        })
        .collect()
}

/// Whether an applicable ruleset holds for a full ref.
pub fn applies_to_ref(ruleset: &Applicable, git_ref: &str, default_branch: &str) -> bool {
    match Target::of_ref(git_ref) {
        Some((target, name)) => target == ruleset.target && ref_matches(&ruleset.conditions, target, name, default_branch),
        None => false,
    }
}

/// Every rule that holds for one branch or tag: active rulesets' first,
/// then those being evaluated, each with where it comes from.
pub fn effective(rulesets: &[Ruleset], repo: RepoFacts<'_>, target: Target, name: &str) -> EffectiveRules {
    let mut holding: Vec<&Ruleset> = rulesets
        .iter()
        .filter(|ruleset| holds_in(ruleset, repo))
        .filter(|ruleset| ruleset.spec.target == target)
        .filter(|ruleset| ref_matches(&ruleset.spec.conditions.ref_name, target, name, repo.default_branch))
        .collect();
    // Active before evaluate; workspace before repository; then by name.
    holding.sort_by_key(|ruleset| {
        (
            ruleset.spec.enforcement != Enforcement::Active,
            ruleset.level != Level::Workspace,
            ruleset.spec.name.to_lowercase(),
        )
    });
    EffectiveRules {
        name: name.to_owned(),
        target,
        default_branch: target == Target::Branch && name == repo.default_branch,
        rules: holding
            .iter()
            .flat_map(|ruleset| {
                ruleset.spec.rules.iter().map(|entry| EffectiveRule {
                    entry: entry.clone(),
                    ruleset_id: ruleset.id.clone(),
                    ruleset_name: ruleset.spec.name.clone(),
                    level: ruleset.level,
                    enforcement: ruleset.spec.enforcement,
                })
            })
            .collect(),
        rulesets: holding
            .iter()
            .map(|ruleset| RulesetSummary {
                id: ruleset.id.clone(),
                name: ruleset.spec.name.clone(),
                level: ruleset.level,
                enforcement: ruleset.spec.enforcement,
                bypass_actors: ruleset.spec.bypass_actors.clone(),
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::rules::{BypassMode, Conditions, NoParameters, Rule, RuleEntry, RulesetSpec};

    pub(crate) fn ruleset(id: &str, level: Level, include: &[&str], exclude: &[&str], rules: Vec<Rule>) -> Ruleset {
        Ruleset {
            id: id.into(),
            level,
            workspace: "acme".into(),
            repo_id: (level == Level::Repository).then(|| "rep_1".to_owned()),
            repository: None,
            spec: RulesetSpec {
                name: id.into(),
                conditions: Conditions {
                    ref_name: RefCondition {
                        include: include.iter().map(|p| (*p).to_owned()).collect(),
                        exclude: exclude.iter().map(|p| (*p).to_owned()).collect(),
                    },
                    repository: None,
                },
                rules: rules.into_iter().map(RuleEntry::everyone).collect(),
                ..RulesetSpec::default()
            },
            source: None,
            created_by: "ada".into(),
            created_at: String::new(),
            updated_by: "ada".into(),
            updated_at: String::new(),
        }
    }

    fn repo<'a>(topics: &'a [String]) -> RepoFacts<'a> {
        RepoFacts { id: "rep_1", name: "web", private: true, topics, default_branch: "main" }
    }

    #[test]
    fn names_match_patterns_the_default_branch_and_all() {
        let condition = |include: &[&str], exclude: &[&str]| RefCondition {
            include: include.iter().map(|p| (*p).to_owned()).collect(),
            exclude: exclude.iter().map(|p| (*p).to_owned()).collect(),
        };
        assert!(ref_matches(&condition(&["~DEFAULT_BRANCH"], &[]), Target::Branch, "main", "main"));
        assert!(!ref_matches(&condition(&["~DEFAULT_BRANCH"], &[]), Target::Branch, "dev", "main"));
        assert!(!ref_matches(&condition(&["~DEFAULT_BRANCH"], &[]), Target::Tag, "main", "main"));
        assert!(ref_matches(&condition(&["~ALL"], &["dependabot/**"]), Target::Branch, "feature/x", "main"));
        assert!(!ref_matches(&condition(&["~ALL"], &["g1t-queue/**"]), Target::Branch, "g1t-queue/a", "main"));
        assert!(ref_matches(&condition(&["refs/heads/release/*"], &[]), Target::Branch, "release/2", "main"));
        assert!(ref_matches(&condition(&["v*"], &[]), Target::Tag, "v1.0.0", "main"));
        assert!(!ref_matches(&condition(&[], &[]), Target::Branch, "main", "main"), "an empty include selects nothing");
    }

    #[test]
    fn workspace_rulesets_select_repositories_by_name_visibility_and_topic() {
        let topics = vec!["payments".to_owned()];
        let mut condition = RepositoryCondition::default();
        assert!(repo_matches(&condition, repo(&topics)));
        condition.include = vec!["api-*".into()];
        assert!(!repo_matches(&condition, repo(&topics)));
        condition.include = vec!["W*".into()];
        assert!(repo_matches(&condition, repo(&topics)), "names ignore case");
        condition.exclude = vec!["web".into()];
        assert!(!repo_matches(&condition, repo(&topics)));
        condition.exclude.clear();
        condition.visibility = VisibilityCondition::Public;
        assert!(!repo_matches(&condition, repo(&topics)));
        condition.visibility = VisibilityCondition::Private;
        condition.topics = vec!["Payments".into()];
        assert!(repo_matches(&condition, repo(&topics)));
        condition.topics = vec!["docs".into()];
        assert!(!repo_matches(&condition, repo(&topics)));
    }

    #[test]
    fn a_repository_ruleset_holds_only_in_its_repository_and_disabled_ones_nowhere() {
        let topics = Vec::new();
        let own = ruleset("a", Level::Repository, &["~ALL"], &[], vec![]);
        assert!(holds_in(&own, repo(&topics)));
        let other = Ruleset { repo_id: Some("rep_2".into()), ..own.clone() };
        assert!(!holds_in(&other, repo(&topics)));
        let mut off = own.clone();
        off.spec.enforcement = Enforcement::Disabled;
        assert!(!holds_in(&off, repo(&topics)));
    }

    fn person(role: RepoRole) -> ActorFacts {
        ActorFacts { username: "ada".into(), kind: Who::Person, role: Some(role), ..ActorFacts::default() }
    }

    fn entry(kind: ActorKind, value: &str, mode: BypassMode) -> BypassActor {
        BypassActor { kind, value: value.into(), mode }
    }

    #[test]
    fn nobody_bypasses_by_default() {
        assert_eq!(bypass(&[], &person(RepoRole::Admin), "acme"), None);
        let g1t = ActorFacts { kind: Who::G1t, username: "g1t".into(), ..ActorFacts::default() };
        assert_eq!(bypass(&[], &g1t, "acme"), None);
    }

    #[test]
    fn roles_people_and_teams_bypass_as_listed() {
        let list = [entry(ActorKind::Role, "maintain", BypassMode::PullRequests)];
        assert_eq!(bypass(&list, &person(RepoRole::Admin), "acme"), Some(BypassMode::PullRequests));
        assert_eq!(bypass(&list, &person(RepoRole::Write), "acme"), None);
        let both = [
            entry(ActorKind::Role, "write", BypassMode::PullRequests),
            entry(ActorKind::User, "@Ada", BypassMode::Always),
        ];
        assert_eq!(bypass(&both, &person(RepoRole::Write), "acme"), Some(BypassMode::Always));
        let team = [entry(ActorKind::Team, "release", BypassMode::Always)];
        let mut ada = person(RepoRole::Read);
        assert_eq!(bypass(&team, &ada, "acme"), None);
        ada.teams.push("acme/release".into());
        assert_eq!(bypass(&team, &ada, "acme"), Some(BypassMode::Always));
        let owners = [entry(ActorKind::Role, "owner", BypassMode::Always)];
        assert_eq!(bypass(&owners, &ada, "acme"), None);
        ada.owner = true;
        assert_eq!(bypass(&owners, &ada, "acme"), Some(BypassMode::Always));
    }

    #[test]
    fn agents_bypass_only_when_g1t_or_their_token_is_listed() {
        let agent = ActorFacts {
            username: "g1t".into(),
            kind: Who::Agent,
            role: Some(RepoRole::Admin),
            owner: true,
            token_id: Some("tok_1".into()),
            ..ActorFacts::default()
        };
        let admins = [entry(ActorKind::Role, "admin", BypassMode::Always), entry(ActorKind::Role, "owner", BypassMode::Always)];
        assert_eq!(bypass(&admins, &agent, "acme"), None, "an agent does not take its person's role");
        assert_eq!(bypass(&[entry(ActorKind::G1t, "", BypassMode::Always)], &agent, "acme"), Some(BypassMode::Always));
        assert_eq!(bypass(&[entry(ActorKind::Token, "tok_1", BypassMode::Always)], &agent, "acme"), Some(BypassMode::Always));
        assert_eq!(bypass(&[entry(ActorKind::Token, "tok_2", BypassMode::Always)], &agent, "acme"), None);
        let system = ActorFacts { kind: Who::G1t, ..ActorFacts::default() };
        assert_eq!(bypass(&[entry(ActorKind::G1t, "", BypassMode::PullRequests)], &system, "acme"), Some(BypassMode::PullRequests));
        let token = ActorFacts { kind: Who::Token, ..ActorFacts::default() };
        assert_eq!(bypass(&[entry(ActorKind::Token, "workspace", BypassMode::Always)], &token, "acme"), Some(BypassMode::Always));
    }

    #[test]
    fn effective_rules_stack_every_ruleset_that_holds() {
        let topics = Vec::new();
        let mut evaluate = ruleset("b-dry", Level::Repository, &["main"], &[], vec![Rule::RequiredLinearHistory(NoParameters {})]);
        evaluate.spec.enforcement = Enforcement::Evaluate;
        let rulesets = vec![
            evaluate,
            ruleset("a-main", Level::Repository, &["~DEFAULT_BRANCH"], &[], vec![Rule::Deletion(NoParameters {}), Rule::NonFastForward(NoParameters {})]),
            ruleset("org", Level::Workspace, &["~ALL"], &[], vec![Rule::Deletion(NoParameters {})]),
            ruleset("release", Level::Repository, &["release/*"], &[], vec![Rule::Creation(NoParameters {})]),
        ];
        let main = effective(&rulesets, repo(&topics), Target::Branch, "main");
        assert!(main.default_branch);
        let from: Vec<(&str, &str)> = main.rules.iter().map(|rule| (rule.ruleset_id.as_str(), rule.entry.rule.kind())).collect();
        assert_eq!(
            from,
            vec![("org", "deletion"), ("a-main", "deletion"), ("a-main", "non_fast_forward"), ("b-dry", "required_linear_history")]
        );
        assert_eq!(main.rulesets.len(), 3);
        let release = effective(&rulesets, repo(&topics), Target::Branch, "release/1");
        assert_eq!(release.rules.iter().map(|rule| rule.entry.rule.kind()).collect::<Vec<_>>(), vec!["deletion", "creation"]);
        assert!(effective(&rulesets, repo(&topics), Target::Tag, "main").rules.is_empty());
    }

    #[test]
    fn applicable_rulesets_carry_the_actors_bypass() {
        let topics = Vec::new();
        let mut guarded = ruleset("a", Level::Repository, &["~DEFAULT_BRANCH"], &[], vec![Rule::Update(NoParameters {})]);
        guarded.spec.bypass_actors = vec![entry(ActorKind::Role, "admin", BypassMode::Always)];
        let rulesets = vec![guarded, ruleset("b", Level::Repository, &["feature/*"], &[], vec![])];
        let found = applicable(&rulesets, repo(&topics), &["refs/heads/main".into()], Some(&person(RepoRole::Admin)), "acme");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].bypass, Some(BypassMode::Always));
        assert!(applies_to_ref(&found[0], "refs/heads/main", "main"));
        assert!(!applies_to_ref(&found[0], "refs/tags/main", "main"));
        let none = applicable(&rulesets, repo(&topics), &["refs/heads/main".into()], Some(&person(RepoRole::Write)), "acme");
        assert_eq!(none[0].bypass, None);
    }
}
