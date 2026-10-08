//! Rulesets, enforced here: on every push, and on every other change to a
//! branch or tag made through g1t (renaming a branch, a commit made on the
//! site, a pull request brought up to date). The work service keeps the
//! rulesets and says which hold (`ref_rules`); `g1t_rules` judges; every
//! judgement is sent back to be recorded (`record_evaluations`). Merging a
//! pull request is judged by the work service before it asks `land`.
//!
//! A pull request's working copy (a fork) has no rules of its own: what it
//! brings is judged when it merges.

use std::collections::HashMap;

use g1t_contracts::accounts::{EmailOwner, EmailOwnersArgs};
use g1t_contracts::repos::Repo;
use g1t_contracts::rules::{
    Action, Applicable, CommitFacts, Enforcement, FileChange, InspectCommitsArgs, InspectedCommits,
    RecordEvaluationsArgs, RefRules, RefRulesArgs, Rule, Target,
};
use g1t_contracts::{FailureCode, Outcome, User};
use g1t_rules::push::{RefChange, judge};
use g1t_rules::{ActorFacts, Judged, Who, content, outcome, report};
use g1t_scan::pack::{Pack, pack_start};
use worker::{Response, Result};

use crate::registry::store_key;
use crate::rule_facts::{self, MAX_COMMITS};
use crate::store::{GitRepo, GitStore};
use crate::{MAX_ANCESTRY, Repos};

/// Where people read the rules of a branch.
const SITE: &str = "https://g1t.sh";

/// What the rules said about a change.
pub(crate) enum Ruled {
    /// No ruleset holds, or none refuses it.
    Allowed,
    /// Refused: why, in a sentence.
    Refused { message: String },
}

/// `ssh_key_owners` on identity: the account that registered each key.
#[derive(serde::Serialize)]
struct KeyOwnersArgs<'a> {
    fingerprints: &'a [String],
}

fn who(actor: Option<&User>, repo: &Repo) -> ActorFacts {
    match actor {
        Some(actor) => ActorFacts::of(actor, repo),
        None => ActorFacts { username: "anonymous".to_owned(), ..ActorFacts::default() },
    }
}

/// Whether any ruleset that is evaluated (active, or evaluate) has a rule
/// about commits that holds for this actor.
fn needs_commits(rulesets: &[Applicable], kind: Who) -> bool {
    rulesets.iter().filter(|ruleset| ruleset.enforcement != Enforcement::Disabled).any(|ruleset| {
        ruleset
            .rules
            .iter()
            .any(|entry| entry.applies_to.covers(kind.is_agent()) && content::about_content(&entry.rule))
    })
}

fn needs_ancestry(rulesets: &[Applicable]) -> bool {
    rulesets
        .iter()
        .any(|ruleset| ruleset.rules.iter().any(|entry| matches!(entry.rule, Rule::NonFastForward(_))))
}

/// Where the rules of a ref are shown.
pub(crate) fn rules_url(repo: &Repo, git_ref: &str) -> String {
    let (target, name) = Target::of_ref(git_ref).unwrap_or((Target::Branch, git_ref));
    let key = if target == Target::Tag { "tag" } else { "branch" };
    format!("{SITE}/{}/{}/settings/rules?{key}={name}", repo.namespace, repo.name)
}

impl<S: GitStore> Repos<S> {
    /// The rulesets that hold for `refs`, from the work service. `None`
    /// when this installation runs without it.
    async fn ref_rules(&self, repo: &Repo, actor: Option<&User>, refs: Vec<String>) -> Result<Option<RefRules>> {
        let Some(work) = &self.work else { return Ok(None) };
        let found: Outcome<RefRules> =
            g1t_kit::call(work, "ref_rules", &RefRulesArgs { repo: repo.clone(), actor: actor.cloned(), refs }).await?;
        match found {
            Outcome::Ok(rules) => Ok(Some(rules)),
            Outcome::Fail(failure) => Err(worker::Error::RustError(failure.message)),
        }
    }

    /// Sends judgements to be recorded; a failure is logged.
    async fn record_judged(&self, repo: &Repo, judged: &[Judged], action: Action, actor: &ActorFacts, sha: Option<&str>) {
        let Some(work) = &self.work else { return };
        if judged.is_empty() {
            return;
        }
        let evaluations = g1t_rules::evaluations(judged, &repo.id, &repo.namespace, action, actor, None, sha);
        let recorded: Result<u32> = g1t_kit::call(work, "record_evaluations", &RecordEvaluationsArgs { evaluations }).await;
        if let Err(error) = recorded {
            worker::console_error!("rule evaluations not recorded: {error}");
        }
    }

    /// Who owns the keys commits were signed with, and the addresses
    /// they were committed as.
    async fn signing_owners(
        &self,
        fingerprints: &[String],
        emails: &[String],
    ) -> (HashMap<String, String>, HashMap<String, (String, String)>) {
        let Some(identity) = &self.identity else { return (HashMap::new(), HashMap::new()) };
        if fingerprints.is_empty() {
            return (HashMap::new(), HashMap::new());
        }
        let (keys, owners) = futures_util::future::join(
            g1t_kit::call::<_, HashMap<String, String>>(identity, "ssh_key_owners", &KeyOwnersArgs { fingerprints }),
            g1t_kit::call::<_, HashMap<String, EmailOwner>>(identity, "email_owners", &EmailOwnersArgs { emails: emails.to_vec() }),
        )
        .await;
        let keys = keys.unwrap_or_else(|error| {
            worker::console_error!("ssh_key_owners failed: {error}");
            HashMap::new()
        });
        let owners = owners
            .unwrap_or_default()
            .into_iter()
            .map(|(email, owner)| (email.to_lowercase(), (owner.id, owner.username)))
            .collect();
        (keys, owners)
    }

    /// Judges changes made through g1t (not a push), records how each
    /// ruleset judged them, and says whether they may go ahead.
    pub(crate) async fn check_changes(&self, repo: &Repo, actor: &User, action: Action, changes: Vec<RefChange>) -> Result<Ruled> {
        if repo.fork_of.is_some() || changes.is_empty() {
            return Ok(Ruled::Allowed);
        }
        let refs: Vec<String> = changes.iter().map(|change| change.git_ref.clone()).collect();
        let rules = match self.ref_rules(repo, Some(actor), refs).await {
            Ok(Some(rules)) => rules,
            Ok(None) => return Ok(Ruled::Allowed),
            Err(error) => {
                worker::console_error!("ref_rules failed: {error}");
                return Ok(Ruled::Refused {
                    message: "The rules for this branch could not be checked just now. Try again in a moment.".to_owned(),
                });
            }
        };
        if rules.rulesets.is_empty() {
            return Ok(Ruled::Allowed);
        }
        let facts = who(Some(actor), repo);
        let judged: Vec<Judged> = changes
            .iter()
            .flat_map(|change| judge(&rules.rulesets, &rules.default_branch, facts.kind, change))
            .collect();
        let sha = changes.iter().find_map(|change| change.new.clone());
        self.record_judged(repo, &judged, action, &facts, sha.as_deref()).await;
        if !outcome::refused(&judged) {
            return Ok(Ruled::Allowed);
        }
        let message = report::summary(&outcome::blocking(&judged)).unwrap_or_else(|| "Rules for this branch refuse it.".to_owned());
        Ok(Ruled::Refused { message })
    }

    /// Rules for a push: the response declining it, or `None` to let it
    /// on. `body` is as much of the push as was read; `whole` says whether
    /// that is all of it, so that its commits can be read.
    pub(crate) async fn check_push(&self, repo: &Repo, pusher: Option<&User>, body: &[u8], whole: bool) -> Result<Option<Response>> {
        if repo.fork_of.is_some() {
            return Ok(None);
        }
        let updates = crate::git_http::ref_updates(body);
        if updates.is_empty() {
            return Ok(None);
        }
        let refs: Vec<String> = updates.iter().map(|(name, _, _)| name.clone()).collect();
        let rules = match self.ref_rules(repo, pusher, refs).await {
            Ok(Some(rules)) => rules,
            // Without the work service, the old protection holds.
            Ok(None) => {
                let protected = repo.protected.then(|| repo.default_branch.clone());
                return protected
                    .and_then(|branch| crate::git_http::refusal(body, &branch))
                    .map(crate::git_http::report_response)
                    .transpose();
            }
            Err(error) => {
                worker::console_error!("ref_rules failed during a push: {error}");
                return Ok(Some(crate::git_http::declined(
                    body,
                    "rules could not be checked",
                    &["The rules for this repository could not be checked just now. Push again in a moment.".to_owned()],
                )?));
            }
        };
        if rules.rulesets.is_empty() {
            return Ok(None);
        }
        let facts = who(pusher, repo);
        let content = needs_commits(&rules.rulesets, facts.kind);
        let ancestry = needs_ancestry(&rules.rulesets);
        let git = self.store.open(&store_key(repo)).await?;
        // The pack, read when a rule needs what it holds.
        let pack = if whole && (content || ancestry) {
            match pack_start(body).map(|start| Pack::parse(&body[start..])) {
                Some(Ok(mut pack)) => {
                    crate::secret_scan::supply_bases(&mut pack, &git).await?;
                    Some(pack)
                }
                Some(Err(problem)) => {
                    worker::console_error!("a push's pack could not be read for rules: {problem}");
                    None
                }
                // Nothing but deletions, or pointing refs at commits the
                // repository has: an empty pack.
                None => Pack::parse(crate::land::EMPTY_PACK).ok(),
            }
        } else {
            None
        };
        let signatures = rules
            .rulesets
            .iter()
            .any(|ruleset| ruleset.rules.iter().any(|entry| matches!(entry.rule, Rule::RequiredSignatures(_))));
        let mut changes = Vec::new();
        for (git_ref, old, new) in updates {
            let mut change = RefChange { git_ref, old: old.clone(), new: new.clone(), fast_forward: None, commits: Vec::new(), complete: false };
            if let (Some(pack), Some(new)) = (&pack, &new) {
                if let Some(old) = &old
                    && ancestry
                {
                    change.fast_forward = Some(rule_facts::contains(pack, &git, new, old, MAX_ANCESTRY).await?);
                }
                if content {
                    match rule_facts::added(pack, new, MAX_COMMITS) {
                        Some(ids) => {
                            let owners = if signatures {
                                let (fingerprints, emails) = rule_facts::signing_facts(pack, &ids);
                                Some(self.signing_owners(&fingerprints, &emails).await)
                            } else {
                                None
                            };
                            change.commits = rule_facts::read_all(pack, &git, &ids, owners.as_ref()).await?;
                            change.complete = change.commits.iter().all(|commit| commit.files_complete);
                        }
                        None => change.complete = false,
                    }
                } else {
                    change.complete = true;
                }
            } else if new.is_none() || !content {
                change.complete = true;
            }
            changes.push(change);
        }
        let judged: Vec<Judged> = changes
            .iter()
            .flat_map(|change| judge(&rules.rulesets, &rules.default_branch, facts.kind, change))
            .collect();
        let sha = changes.iter().find_map(|change| change.new.clone());
        self.record_judged(repo, &judged, Action::Push, &facts, sha.as_deref()).await;
        if !outcome::refused(&judged) {
            return Ok(None);
        }
        let refused_ref = judged.iter().find(|one| one.blocks()).map(|one| one.git_ref.clone()).unwrap_or_default();
        let lines = report::remote_lines(&refused_ref, &judged, &rules_url(repo, &refused_ref));
        Ok(Some(crate::git_http::declined(body, &report::ng_reason(&judged), &lines)?))
    }

    /// Services only: the commits a pull request would land, read as rules
    /// look at them, fetched from its source as a pack.
    pub(crate) async fn inspect_commits(&self, a: InspectCommitsArgs) -> Result<Outcome<InspectedCommits>> {
        let (Some(source), Some(target)) = (self.registry.by_id(&a.source_id).await?, self.registry.by_id(&a.target_id).await?) else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Repository not found."));
        };
        self.live(&source).await?;
        let (source_git, target_git) = (self.store.open(&store_key(&source)).await?, self.store.open(&store_key(&target)).await?);
        let (history, base_history) =
            futures_util::future::try_join(source_git.log(&a.head, MAX_ANCESTRY), target_git.log(&a.base_branch, MAX_ANCESTRY)).await?;
        let shared: std::collections::HashSet<String> = base_history.into_iter().map(|commit| commit.hash).collect();
        let merge_base = crate::nearest_ancestor_in(&source_git, &history, &shared).await?;
        let Some(head) = history.first() else {
            return Ok(Outcome::Ok(InspectedCommits { commits: Vec::new(), complete: true }));
        };
        let access = source_git.access(crate::store::Scope::Read).await?;
        let fetched = crate::land::fetch_pack(&access, &head.hash, merge_base.as_deref()).await?;
        if fetched.len() > crate::secret_scan::MAX_SCANNED_PUSH {
            return Ok(Outcome::Ok(InspectedCommits { commits: Vec::new(), complete: false }));
        }
        let pack = match Pack::parse(&fetched) {
            Ok(pack) => pack,
            Err(problem) => {
                worker::console_error!("a pull request's commits could not be read for rules: {problem}");
                return Ok(Outcome::Ok(InspectedCommits { commits: Vec::new(), complete: false }));
            }
        };
        let limit = a.limit.map_or(MAX_COMMITS, |limit| (limit as usize).min(MAX_COMMITS));
        let Some(ids) = rule_facts::added(&pack, &head.hash, limit) else {
            return Ok(Outcome::Ok(InspectedCommits { commits: Vec::new(), complete: false }));
        };
        let (fingerprints, emails) = rule_facts::signing_facts(&pack, &ids);
        let owners = self.signing_owners(&fingerprints, &emails).await;
        let commits = rule_facts::read_all(&pack, &source_git, &ids, Some(&owners)).await?;
        let complete = commits.iter().all(|commit| commit.files_complete);
        Ok(Outcome::Ok(InspectedCommits { commits, complete }))
    }
}

/// The facts of one commit g1t makes itself (a web edit, a catch-up
/// merge): it is not signed, and it changes `files`.
pub(crate) fn made_commit(sha: &str, message: &str, email: &str, parents: u32, files: Vec<FileChange>) -> CommitFacts {
    CommitFacts {
        sha: sha.to_owned(),
        message: message.to_owned(),
        author_email: Some(email.to_owned()),
        committer_email: Some(email.to_owned()),
        parents,
        signature: g1t_contracts::rules::Signature::Unsigned,
        files,
        files_complete: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::rules::{AppliesTo, Level, NoParameters, RefCondition, RuleEntry};

    fn repo() -> Repo {
        serde_json::from_value(serde_json::json!({
            "id": "rep_1", "namespace": "acme", "name": "web", "description": null, "isPrivate": false,
            "ownerId": "usr_1", "defaultBranch": "main", "forkOf": null, "createdAt": ""
        }))
        .unwrap()
    }

    fn ruleset(enforcement: Enforcement, rule: Rule, applies_to: AppliesTo) -> Applicable {
        Applicable {
            id: "rs_1".into(),
            name: "R".into(),
            level: Level::Repository,
            enforcement,
            target: Target::Branch,
            conditions: RefCondition { include: vec!["~ALL".into()], exclude: Vec::new() },
            rules: vec![RuleEntry { rule, applies_to }],
            bypass: None,
        }
    }

    #[test]
    fn rules_are_linked_by_branch_or_tag() {
        assert_eq!(rules_url(&repo(), "refs/heads/release/1"), "https://g1t.sh/acme/web/settings/rules?branch=release/1");
        assert_eq!(rules_url(&repo(), "refs/tags/v1"), "https://g1t.sh/acme/web/settings/rules?tag=v1");
    }

    #[test]
    fn commits_are_read_only_when_a_rule_for_this_actor_needs_them() {
        let signed = ruleset(Enforcement::Evaluate, Rule::RequiredSignatures(NoParameters {}), AppliesTo::Everyone);
        assert!(needs_commits(&[signed], Who::Person), "evaluate-mode rulesets are recorded too");
        let agents = ruleset(Enforcement::Active, Rule::RequiredSignatures(NoParameters {}), AppliesTo::Agents);
        assert!(!needs_commits(std::slice::from_ref(&agents), Who::Person));
        assert!(needs_commits(&[agents], Who::Agent));
        let off = ruleset(Enforcement::Disabled, Rule::RequiredSignatures(NoParameters {}), AppliesTo::Everyone);
        assert!(!needs_commits(&[off], Who::Person));
        assert!(needs_ancestry(&[ruleset(Enforcement::Active, Rule::NonFastForward(NoParameters {}), AppliesTo::Everyone)]));
    }

    #[test]
    fn a_commit_g1t_makes_is_unsigned_and_lists_its_files() {
        let made = made_commit("abc", "Add CI", "ada@acme.com", 1, vec![FileChange { path: ".g1t/workflows/ci.yml".into(), size: Some(12), deleted: false }]);
        assert_eq!(made.signature, g1t_contracts::rules::Signature::Unsigned);
        assert!(made.files_complete);
    }
}
