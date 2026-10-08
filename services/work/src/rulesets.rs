//! Rulesets: kept here, with every evaluation of them, and enforced here on
//! merge. The repos service enforces them on push and on every other
//! change to a branch or tag, asking `ref_rules` which hold and recording
//! what it decided with `record_evaluations`. The rules engine itself is
//! `g1t_rules`.
//!
//! A repository's branch protection, from before rulesets, is its
//! "Default branch protection" ruleset (migration 0028). The repos
//! service's `protected` flag is folded into it the first time its rulesets
//! are read ([`Work::rulesets_for`]), once, and `get_settings` and
//! `update_settings` read and write it, so callers of the old settings see
//! no change.

use std::collections::HashMap;

use g1t_contracts::access::Capability;
use g1t_contracts::audit::{AuditActor, AuditOutcome, AuditTarget, NewAuditEntry, RecordAuditArgs, Surface};
use g1t_contracts::events::{NewEvent, Publish};
use g1t_contracts::repos::{Repo, RepoPath};
use g1t_contracts::rules::*;
use g1t_contracts::teams::{ResolveTeamsArgs, ResolvedTeam};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::{Pull, RepoSettings, Verdict as ReviewVerdict};
use g1t_contracts::{FailureCode, Outcome, Role, User, Viewer, new_id};
use g1t_kit::now_ms;
use g1t_rules::merge::{MergeFacts, Requirements, Review};
use g1t_rules::{ActorFacts, Judged, RepoFacts, legacy, select, validate};
use serde::{Deserialize, Serialize};
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Work;
use crate::reviews::AGENT_ID;

/// Unwraps an `Outcome`, returning its failure from the enclosing method.
macro_rules! check {
    ($outcome:expr) => {
        match $outcome {
            Outcome::Ok(value) => value,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        }
    };
}

/// Evaluations a page lists at most.
const MAX_PAGE: u32 = 100;
/// The window insights cover.
const INSIGHT_DAYS: u32 = 30;
/// How long evaluations are kept.
const KEEP_DAYS: u64 = 90;
const DAY_MS: u64 = 24 * 60 * 60 * 1000;

/// A workspace renamed: its rulesets and their evaluations move with it.
pub(crate) const RENAMED: &[&str] = &[
    "UPDATE rulesets SET workspace = ?1 WHERE workspace = ?2",
    "UPDATE rule_evaluations SET workspace = ?1 WHERE workspace = ?2",
];

#[derive(Deserialize)]
pub(crate) struct RulesetRow {
    id: String,
    level: String,
    workspace: String,
    repo_id: Option<String>,
    spec: String,
    source: Option<String>,
    created_by: String,
    created_at: String,
    updated_by: String,
    updated_at: String,
}

impl RulesetRow {
    fn into_ruleset(self, repo: Option<&Repo>) -> Option<Ruleset> {
        let spec: RulesetSpec = match serde_json::from_str(&self.spec) {
            Ok(spec) => spec,
            Err(error) => {
                worker::console_error!("ruleset {} does not read: {error}", self.id);
                return None;
            }
        };
        let level = if self.level == "workspace" { Level::Workspace } else { Level::Repository };
        let repository = match (level, repo) {
            (Level::Repository, Some(repo)) if Some(&repo.id) == self.repo_id.as_ref() => {
                Some(format!("{}/{}", repo.namespace, repo.name))
            }
            _ => None,
        };
        Some(Ruleset {
            id: self.id,
            level,
            workspace: match (level, repo) {
                (Level::Repository, Some(repo)) => repo.namespace.to_lowercase(),
                _ => self.workspace,
            },
            repo_id: self.repo_id,
            repository,
            spec,
            source: self.source,
            created_by: self.created_by,
            created_at: self.created_at,
            updated_by: self.updated_by,
            updated_at: self.updated_at,
        })
    }
}

#[derive(Deserialize)]
struct EvaluationRow {
    id: String,
    repo_id: String,
    workspace: String,
    ruleset_id: String,
    ruleset_name: String,
    enforcement: Enforcement,
    action: Action,
    git_ref: String,
    actor: String,
    actor_kind: String,
    verdict: Verdict,
    violations: String,
    number: Option<u32>,
    sha: Option<String>,
    created_at: String,
}

impl From<EvaluationRow> for Evaluation {
    fn from(row: EvaluationRow) -> Self {
        Evaluation {
            id: row.id,
            evaluation: NewEvaluation {
                repo_id: row.repo_id,
                workspace: row.workspace,
                ruleset_id: row.ruleset_id,
                ruleset_name: row.ruleset_name,
                enforcement: row.enforcement,
                action: row.action,
                git_ref: row.git_ref,
                actor: row.actor,
                actor_kind: row.actor_kind,
                verdict: row.verdict,
                violations: serde_json::from_str(&row.violations).unwrap_or_default(),
                number: row.number,
                sha: row.sha,
            },
            repository: String::new(),
            created_at: row.created_at,
        }
    }
}

/// Whose rulesets a call is about, once checked.
struct Scope {
    level: Level,
    workspace: String,
    repo: Option<Repo>,
}

/// What a webhook and the event log are sent when a ruleset changes.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RulesetEvent<'a> {
    workspace: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    repository: Option<String>,
    ruleset: &'a Ruleset,
}

fn optional(value: Option<&str>) -> JsValue {
    value.map_or(JsValue::NULL, Into::into)
}

/// Whether a pull request is an agent's change: g1t made it, an agent
/// opened it, or it was opened naming an agent rather than by its author
/// on the site.
pub(crate) fn agent_change(pull: &Pull) -> bool {
    crate::lifecycle::made_by_g1t(pull)
        || pull.author.id == AGENT_ID
        || g1t_contracts::rules::is_agent(&pull.author)
        || (!pull.agent.trim().is_empty() && !pull.agent.eq_ignore_ascii_case(&pull.author.username))
}

/// The latest verdict of each reviewer, from verdict rows oldest first.
pub(crate) fn latest_reviews(rows: Vec<(String, String, ReviewVerdict, String)>) -> Vec<Review> {
    let mut latest: HashMap<String, Review> = HashMap::new();
    for (reviewer_id, username, verdict, at) in rows {
        let agent = reviewer_id == AGENT_ID;
        latest.insert(reviewer_id.clone(), Review { reviewer_id, username, verdict, at, agent });
    }
    let mut reviews: Vec<Review> = latest.into_values().collect();
    reviews.sort_by(|a, b| a.at.cmp(&b.at));
    reviews
}

/// The settings that hold for a branch: the repository's own (how g1t's
/// agents work), with branch protection as the active rules stack it.
pub(crate) fn overlay(stored: RepoSettings, requirements: &Requirements, default_branch: bool) -> RepoSettings {
    RepoSettings {
        required_checks: requirements.required_checks.clone(),
        require_up_to_date: requirements.strict,
        required_approvals: requirements.required_approvals,
        count_agent_approvals: requirements.count_agent_approvals,
        allow_ignoring_checks: requirements.allow_bypass_on_merge,
        // The queue lands on the default branch only.
        merge_queue: requirements.merge_queue.is_some() && default_branch,
        require_code_owner_review: requirements.require_code_owner_review,
        ..stored
    }
}

/// What the merge box shows: each rule not met, and how to meet it.
pub(crate) fn merge_rules(judged: &[Judged], requirements: &Requirements) -> MergeRules {
    let mut out = MergeRules { merge_queue: requirements.merge_queue.is_some(), ..MergeRules::default() };
    for one in judged {
        match (one.enforcement, one.verdict()) {
            (Enforcement::Active, Verdict::Fail) => out.unmet.extend(one.violations.iter().cloned()),
            (Enforcement::Active, Verdict::Bypass) => out.bypassable.extend(one.violations.iter().cloned()),
            (Enforcement::Evaluate, Verdict::Fail | Verdict::Bypass) => out.evaluate.extend(one.violations.iter().cloned()),
            _ => {}
        }
        out.rulesets.push(RulesetSummary {
            id: one.id.clone(),
            name: one.name.clone(),
            level: one.level,
            enforcement: one.enforcement,
            bypass_actors: Vec::new(),
        });
    }
    out
}

impl Work {
    fn rules_statement(&self, sql: &str, binds: &[JsValue]) -> Result<worker::D1PreparedStatement> {
        self.db.prepare(sql).bind(binds)
    }

    /// The rulesets that may hold in `repo`: its own and its workspace's,
    /// disabled ones included. A pull request's working copy has none.
    /// Folds the repository's old `protected` flag in, once.
    pub(crate) async fn rulesets_for(&self, repo: &Repo) -> Result<Vec<Ruleset>> {
        if repo.fork_of.is_some() {
            return Ok(Vec::new());
        }
        let prefetched = self.prefetched_repo(&repo.id).filter(|found| found.namespace == repo.namespace.to_lowercase());
        let (rows, adopted) = match prefetched {
            Some(found) => (
                found.rows::<RulesetRow>(crate::prefetch::Slot::Rulesets)?,
                found.first::<crate::rows::NumberRow>(crate::prefetch::Slot::Adopted)?.is_some(),
            ),
            None => {
                let results = self
                    .db
                    .batch(vec![
                        self.rules_statement(RULESETS_SQL, &[repo.id.as_str().into(), repo.namespace.to_lowercase().into()])?,
                        self.rules_statement(ADOPTED_SQL, &[repo.id.as_str().into()])?,
                    ])
                    .await?;
                let rows = results.first().map(|result| result.results::<RulesetRow>()).transpose()?.unwrap_or_default();
                let adopted = results
                    .get(1)
                    .map(|result| result.results::<crate::rows::NumberRow>())
                    .transpose()?
                    .is_some_and(|rows| !rows.is_empty());
                (rows, adopted)
            }
        };
        let mut rulesets: Vec<Ruleset> = rows.into_iter().filter_map(|row| row.into_ruleset(Some(repo))).collect();
        if !adopted {
            self.adopt(repo, &mut rulesets).await?;
        }
        Ok(rulesets)
    }

    /// Folds the repos service's `protected` flag into the repository's
    /// branch protection ruleset, once: pushes to the default branch stay
    /// refused where they were. One batch, so two requests cannot both.
    async fn adopt(&self, repo: &Repo, rulesets: &mut Vec<Ruleset>) -> Result<()> {
        let now = rfc3339(now_ms());
        let not_yet = "NOT EXISTS (SELECT 1 FROM ruleset_adoptions WHERE repo_id = ?)";
        let mut statements = vec![self.rules_statement(
            "UPDATE rulesets SET workspace = ? WHERE repo_id = ? AND workspace = ''",
            &[repo.namespace.to_lowercase().into(), repo.id.as_str().into()],
        )?];
        if repo.protected {
            let existing = rulesets
                .iter_mut()
                .find(|ruleset| ruleset.repo_id.as_deref() == Some(&repo.id) && ruleset.source.as_deref() == Some(BRANCH_PROTECTION));
            match existing {
                Some(ruleset) => {
                    let mut found = false;
                    for entry in &mut ruleset.spec.rules {
                        if let (Rule::PullRequest(rule), AppliesTo::Everyone) = (&mut entry.rule, entry.applies_to) {
                            rule.allow_direct_pushes = false;
                            found = true;
                        }
                    }
                    if !found {
                        ruleset.spec.rules.insert(0, RuleEntry::everyone(Rule::PullRequest(PullRequestRule::default())));
                    }
                    statements.push(self.rules_statement(
                        &format!("UPDATE rulesets SET spec = ? WHERE id = ? AND {not_yet}"),
                        &[serde_json::to_string(&ruleset.spec)?.into(), ruleset.id.as_str().into(), repo.id.as_str().into()],
                    )?);
                }
                None => {
                    if let Some(spec) = legacy::ruleset_of(&RepoSettings::default(), true) {
                        let ruleset = Ruleset {
                            id: new_id("rs", now_ms()),
                            level: Level::Repository,
                            workspace: repo.namespace.to_lowercase(),
                            repo_id: Some(repo.id.clone()),
                            repository: Some(format!("{}/{}", repo.namespace, repo.name)),
                            spec,
                            source: Some(BRANCH_PROTECTION.to_owned()),
                            created_by: "g1t".to_owned(),
                            created_at: now.clone(),
                            updated_by: "g1t".to_owned(),
                            updated_at: now.clone(),
                        };
                        statements.push(self.rules_statement(
                            &format!(
                                "INSERT INTO rulesets (id, level, workspace, repo_id, name, enforcement, target, spec, source, created_by, created_at, updated_by, updated_at)
                                 SELECT ?, 'repository', ?, ?, ?, 'active', 'branch', ?, ?, 'g1t', ?, 'g1t', ? WHERE {not_yet}"
                            ),
                            &[
                                ruleset.id.as_str().into(),
                                ruleset.workspace.as_str().into(),
                                repo.id.as_str().into(),
                                ruleset.spec.name.as_str().into(),
                                serde_json::to_string(&ruleset.spec)?.into(),
                                BRANCH_PROTECTION.into(),
                                now.as_str().into(),
                                now.as_str().into(),
                                repo.id.as_str().into(),
                            ],
                        )?);
                        rulesets.push(ruleset);
                    }
                }
            }
        }
        statements.push(self.rules_statement(
            "INSERT OR IGNORE INTO ruleset_adoptions (repo_id, adopted_at) VALUES (?, ?)",
            &[repo.id.as_str().into(), now.into()],
        )?);
        self.db.batch(statements).await?;
        Ok(())
    }

    /// A workspace's own rulesets.
    async fn workspace_rulesets(&self, workspace: &str) -> Result<Vec<Ruleset>> {
        Ok(self
            .db
            .prepare("SELECT * FROM rulesets WHERE level = 'workspace' AND workspace = ? ORDER BY created_at")
            .bind(&[workspace.to_lowercase().into()])?
            .all()
            .await?
            .results::<RulesetRow>()?
            .into_iter()
            .filter_map(|row| row.into_ruleset(None))
            .collect())
    }

    /// The people of each team named, by `workspace/slug`, usernames
    /// lowercase, child teams' people included.
    pub(crate) async fn team_people(&self, names: &[String], workspace: &str, repo_id: &str) -> Result<HashMap<String, Vec<String>>> {
        let keys: Vec<String> = names.iter().map(|name| select::team_key(name, workspace)).collect();
        if keys.is_empty() {
            return Ok(HashMap::new());
        }
        let teams: Vec<ResolvedTeam> = g1t_kit::call(
            &self.identity,
            "resolve_teams",
            &ResolveTeamsArgs { teams: keys, repo_id: Some(repo_id.to_owned()), asker: None },
        )
        .await
        .unwrap_or_default();
        Ok(teams
            .into_iter()
            .map(|team| {
                let people = team
                    .members
                    .iter()
                    .chain(team.child_members.iter())
                    .map(|person| person.username.to_lowercase())
                    .collect();
                (format!("{}/{}", team.workspace.to_lowercase(), team.slug.to_lowercase()), people)
            })
            .collect())
    }

    /// The actor as bypass lists name people, their teams looked up only
    /// when a bypass list names a team.
    pub(crate) async fn actor_facts(&self, actor: &User, repo: &Repo, rulesets: &[Ruleset]) -> Result<ActorFacts> {
        let mut facts = ActorFacts::of(actor, repo);
        if facts.kind == select::Who::Person && select::names_teams(rulesets) {
            let named: Vec<String> = rulesets
                .iter()
                .flat_map(|ruleset| ruleset.spec.bypass_actors.iter())
                .filter(|entry| entry.kind == ActorKind::Team)
                .map(|entry| entry.value.clone())
                .collect();
            let people = self.team_people(&named, &repo.namespace, &repo.id).await?;
            let me = actor.username.to_lowercase();
            facts.teams = people.into_iter().filter(|(_, people)| people.contains(&me)).map(|(team, _)| team).collect();
        }
        Ok(facts)
    }

    /// Who may see or change rulesets of `owner`, checked.
    async fn scope(&self, owner: &Owner, viewer: &Viewer, manage: bool) -> Result<Outcome<Scope>> {
        match (&owner.repo, &owner.workspace) {
            (Some(path), _) => {
                let repo = check!(self.repo(path, viewer).await?);
                if manage {
                    let Some(actor) = viewer else {
                        return Ok(Outcome::fail(FailureCode::Unauthenticated, "Sign in first."));
                    };
                    check!(crate::retired::writable(&repo));
                    if !actor.verified {
                        return Ok(Outcome::fail(FailureCode::Forbidden, crate::UNVERIFIED));
                    }
                    check!(crate::allowed(Some(actor), &repo, Capability::ManageProtection));
                }
                Ok(Outcome::Ok(Scope { level: Level::Repository, workspace: repo.namespace.to_lowercase(), repo: Some(repo) }))
            }
            (None, Some(workspace)) => {
                let workspace = workspace.trim().to_lowercase();
                let Some(actor) = viewer else {
                    return Ok(Outcome::fail(FailureCode::Unauthenticated, "Sign in first."));
                };
                let role = actor.role_in(&workspace);
                if role.is_none() {
                    return Ok(Outcome::fail(FailureCode::NotFound, "Workspace not found."));
                }
                if manage {
                    if !actor.verified {
                        return Ok(Outcome::fail(FailureCode::Forbidden, crate::UNVERIFIED));
                    }
                    if role != Some(Role::Owner) {
                        return Ok(Outcome::fail(FailureCode::Forbidden, "Only owners of the workspace can change its rulesets."));
                    }
                }
                Ok(Outcome::Ok(Scope { level: Level::Workspace, workspace, repo: None }))
            }
            (None, None) => Ok(Outcome::fail(FailureCode::Invalid, "Say whose rulesets: a repository or a workspace.")),
        }
    }

    /// The rulesets of a scope: a repository's own (with its workspace's
    /// that hold in it, when asked), or a workspace's.
    async fn scoped_rulesets(&self, scope: &Scope, include_parents: bool) -> Result<Vec<Ruleset>> {
        match &scope.repo {
            Some(repo) => {
                let all = self.rulesets_for(repo).await?;
                Ok(all
                    .into_iter()
                    .filter(|ruleset| match ruleset.level {
                        Level::Repository => true,
                        Level::Workspace => {
                            include_parents
                                && repo_matches_spec(ruleset, RepoFacts::from(repo))
                        }
                    })
                    .collect())
            }
            None => self.workspace_rulesets(&scope.workspace).await,
        }
    }

    pub(crate) async fn list_rulesets(&self, a: ListRulesetsArgs) -> Result<Outcome<Vec<Ruleset>>> {
        let scope = check!(self.scope(&a.owner, &a.viewer, false).await?);
        Ok(Outcome::Ok(self.scoped_rulesets(&scope, a.include_parents).await?))
    }

    pub(crate) async fn get_ruleset(&self, a: GetRulesetArgs) -> Result<Outcome<Ruleset>> {
        let scope = check!(self.scope(&a.owner, &a.viewer, false).await?);
        match self.scoped_rulesets(&scope, true).await?.into_iter().find(|ruleset| ruleset.id == a.id) {
            Some(ruleset) => Ok(Outcome::Ok(ruleset)),
            None => Ok(Outcome::fail(FailureCode::NotFound, "Ruleset not found.")),
        }
    }

    pub(crate) async fn save_ruleset(&self, a: SaveRulesetArgs) -> Result<Outcome<Ruleset>> {
        let scope = check!(self.scope(&a.owner, &Some(a.actor.clone()), true).await?);
        let spec = match validate::validate(&a.ruleset, scope.level) {
            Ok(spec) => spec,
            Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
        };
        let existing = self.scoped_rulesets(&scope, false).await?;
        let before = match &a.id {
            Some(id) => match existing.iter().find(|ruleset| &ruleset.id == id) {
                Some(found) => Some(found.clone()),
                None => return Ok(Outcome::fail(FailureCode::NotFound, "Ruleset not found.")),
            },
            None => {
                if existing.len() >= MAX_RULESETS {
                    return Ok(Outcome::fail(FailureCode::Invalid, format!("There can be at most {MAX_RULESETS} rulesets here.")));
                }
                None
            }
        };
        let now = rfc3339(now_ms());
        let ruleset = Ruleset {
            id: before.as_ref().map_or_else(|| new_id("rs", now_ms()), |found| found.id.clone()),
            level: scope.level,
            workspace: scope.workspace.clone(),
            repo_id: scope.repo.as_ref().map(|repo| repo.id.clone()),
            repository: scope.repo.as_ref().map(|repo| format!("{}/{}", repo.namespace, repo.name)),
            spec,
            source: before.as_ref().and_then(|found| found.source.clone()),
            created_by: before.as_ref().map_or_else(|| a.actor.username.clone(), |found| found.created_by.clone()),
            created_at: before.as_ref().map_or_else(|| now.clone(), |found| found.created_at.clone()),
            updated_by: a.actor.username.clone(),
            updated_at: now,
        };
        self.store_ruleset(&ruleset).await?;
        let kind = if before.is_some() { "ruleset.updated" } else { "ruleset.created" };
        self.announce(kind, &ruleset, &a.actor).await;
        if !a.from_api {
            self.audit_ruleset(&a.actor, &ruleset, if before.is_some() { "update_ruleset" } else { "create_ruleset" }).await;
        }
        Ok(Outcome::Ok(ruleset))
    }

    async fn store_ruleset(&self, ruleset: &Ruleset) -> Result<()> {
        self.db
            .prepare(
                "INSERT INTO rulesets (id, level, workspace, repo_id, name, enforcement, target, spec, source, created_by, created_at, updated_by, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (id) DO UPDATE SET
                   name = excluded.name, enforcement = excluded.enforcement, target = excluded.target,
                   spec = excluded.spec, workspace = excluded.workspace,
                   updated_by = excluded.updated_by, updated_at = excluded.updated_at",
            )
            .bind(&[
                ruleset.id.as_str().into(),
                ruleset.level.as_str().into(),
                ruleset.workspace.as_str().into(),
                optional(ruleset.repo_id.as_deref()),
                ruleset.spec.name.as_str().into(),
                ruleset.spec.enforcement.as_str().into(),
                ruleset.spec.target.as_str().into(),
                serde_json::to_string(&ruleset.spec)?.into(),
                optional(ruleset.source.as_deref()),
                ruleset.created_by.as_str().into(),
                ruleset.created_at.as_str().into(),
                ruleset.updated_by.as_str().into(),
                ruleset.updated_at.as_str().into(),
            ])?
            .run()
            .await?;
        Ok(())
    }

    pub(crate) async fn delete_ruleset(&self, a: DeleteRulesetArgs) -> Result<Outcome<bool>> {
        let scope = check!(self.scope(&a.owner, &Some(a.actor.clone()), true).await?);
        let Some(ruleset) = self.scoped_rulesets(&scope, false).await?.into_iter().find(|ruleset| ruleset.id == a.id) else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Ruleset not found."));
        };
        self.db.prepare("DELETE FROM rulesets WHERE id = ?").bind(&[ruleset.id.as_str().into()])?.run().await?;
        self.announce("ruleset.deleted", &ruleset, &a.actor).await;
        if !a.from_api {
            self.audit_ruleset(&a.actor, &ruleset, "delete_ruleset").await;
        }
        Ok(Outcome::Ok(true))
    }

    /// Publishes a ruleset's change: a repository's on its repository, a
    /// workspace's to the workspace (webhooks route it there).
    async fn announce(&self, kind: &'static str, ruleset: &Ruleset, actor: &User) {
        let event = NewEvent {
            kind,
            source: crate::SOURCE,
            repo_id: ruleset.repo_id.clone(),
            actor: Some(actor.id.clone()),
            data: RulesetEvent { workspace: &ruleset.workspace, repository: ruleset.repository.clone(), ruleset },
        };
        let published: Result<()> = g1t_kit::call(&self.events, "publish", &Publish { events: vec![event] }).await;
        if let Err(error) = published {
            worker::console_error!("{kind} not published: {error}");
        }
    }

    /// Records a change to a ruleset made on the site in the workspace's
    /// audit log. Changes through the API are recorded by the API.
    async fn audit_ruleset(&self, actor: &User, ruleset: &Ruleset, action: &str) {
        let entry = NewAuditEntry {
            actor: AuditActor::of(actor),
            action: action.to_owned(),
            surface: Surface::Web,
            target: AuditTarget {
                workspace: ruleset.workspace.clone(),
                repo: ruleset.repository.clone(),
                ..AuditTarget::default()
            },
            outcome: AuditOutcome::Allowed,
            rule: "rulesets".to_owned(),
            result: Some("ok".to_owned()),
            message: Some(format!(
                "{} ruleset \"{}\" ({}, {} rules)",
                match action {
                    "create_ruleset" => "Created",
                    "delete_ruleset" => "Deleted",
                    _ => "Changed",
                },
                ruleset.spec.name,
                ruleset.spec.enforcement.as_str(),
                ruleset.spec.rules.len()
            )),
            request_id: new_id("req", now_ms()),
        };
        let recorded: Result<u32> = g1t_kit::call(&self.events, "audit_record", &RecordAuditArgs { entries: vec![entry] }).await;
        if let Err(error) = recorded {
            worker::console_error!("ruleset change not recorded: {error}");
        }
    }

    pub(crate) async fn effective_rules(&self, a: EffectiveRulesArgs) -> Result<Outcome<EffectiveRules>> {
        let repo = check!(self.repo(&a.repo, &a.viewer).await?);
        let name = a.name.trim();
        let name = name
            .strip_prefix("refs/heads/")
            .or_else(|| name.strip_prefix("refs/tags/"))
            .unwrap_or(name);
        if name.is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Name a branch or tag."));
        }
        let rulesets = self.rulesets_for(&repo).await?;
        Ok(Outcome::Ok(select::effective(&rulesets, RepoFacts::from(&repo), a.target, name)))
    }

    /// Services only: the rulesets that hold for refs a service is about to
    /// change, with whether the actor may bypass each.
    pub(crate) async fn ref_rules(&self, a: RefRulesArgs) -> Result<Outcome<RefRules>> {
        let rulesets = self.rulesets_for(&a.repo).await?;
        let who = match &a.actor {
            Some(actor) => Some(self.actor_facts(actor, &a.repo, &rulesets).await?),
            None => None,
        };
        Ok(Outcome::Ok(RefRules {
            default_branch: a.repo.default_branch.clone(),
            workspace: a.repo.namespace.to_lowercase(),
            rulesets: select::applicable(&rulesets, RepoFacts::from(&a.repo), &a.refs, who.as_ref(), &a.repo.namespace),
        }))
    }

    /// Services only: keeps evaluations, and lets old ones go.
    pub(crate) async fn record_evaluations(&self, a: RecordEvaluationsArgs) -> Result<u32> {
        if a.evaluations.is_empty() {
            return Ok(0);
        }
        let now = now_ms();
        let at = rfc3339(now);
        let mut statements = Vec::new();
        for evaluation in a.evaluations.iter().take(200) {
            statements.push(self.rules_statement(
                "INSERT INTO rule_evaluations (id, repo_id, workspace, ruleset_id, ruleset_name, enforcement, action, git_ref, actor, actor_kind, verdict, violations, number, sha, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                &[
                    new_id("rev", now).into(),
                    evaluation.repo_id.as_str().into(),
                    evaluation.workspace.to_lowercase().into(),
                    evaluation.ruleset_id.as_str().into(),
                    evaluation.ruleset_name.as_str().into(),
                    evaluation.enforcement.as_str().into(),
                    evaluation.action.as_str().into(),
                    evaluation.git_ref.as_str().into(),
                    evaluation.actor.as_str().into(),
                    evaluation.actor_kind.as_str().into(),
                    evaluation.verdict.as_str().into(),
                    serde_json::to_string(&evaluation.violations)?.into(),
                    evaluation.number.map_or(JsValue::NULL, Into::into),
                    optional(evaluation.sha.as_deref()),
                    at.as_str().into(),
                ],
            )?);
        }
        if let Some(first) = a.evaluations.first() {
            statements.push(self.rules_statement(
                "DELETE FROM rule_evaluations WHERE id IN
                   (SELECT id FROM rule_evaluations WHERE repo_id = ? AND created_at < ? ORDER BY id LIMIT 200)",
                &[first.repo_id.as_str().into(), rfc3339(now.saturating_sub(KEEP_DAYS * DAY_MS)).into()],
            )?);
        }
        let count = a.evaluations.len().min(200) as u32;
        self.db.batch(statements).await?;
        Ok(count)
    }

    pub(crate) async fn rule_evaluations(&self, a: EvaluationsArgs) -> Result<Outcome<EvaluationPage>> {
        let scope = check!(self.scope(&a.owner, &a.viewer, false).await?);
        if let Some(repo) = &scope.repo {
            check!(crate::allowed(a.viewer.as_ref(), repo, Capability::Push));
        }
        let (column, key) = match &scope.repo {
            Some(repo) => ("repo_id", repo.id.clone()),
            None => ("workspace", scope.workspace.clone()),
        };
        let limit = a.limit.unwrap_or(30).clamp(1, MAX_PAGE);
        let mut sql = format!("SELECT * FROM rule_evaluations WHERE {column} = ?");
        let mut binds: Vec<JsValue> = vec![key.as_str().into()];
        if let Some(id) = &a.ruleset_id {
            sql.push_str(" AND ruleset_id = ?");
            binds.push(id.as_str().into());
        }
        if let Some(verdict) = a.verdict {
            sql.push_str(" AND verdict = ?");
            binds.push(verdict.as_str().into());
        }
        if a.problems_only {
            sql.push_str(" AND verdict != 'pass'");
        }
        if let Some(before) = &a.before {
            sql.push_str(" AND id < ?");
            binds.push(before.as_str().into());
        }
        sql.push_str(" ORDER BY id DESC LIMIT ?");
        binds.push((limit + 1).into());
        let since = rfc3339(now_ms().saturating_sub(u64::from(INSIGHT_DAYS) * DAY_MS));
        let ruleset_filter = if a.ruleset_id.is_some() { " AND ruleset_id = ?3" } else { "" };
        let mut insight_binds: Vec<JsValue> = vec![key.as_str().into(), since.as_str().into()];
        if let Some(id) = &a.ruleset_id {
            insight_binds.push(id.as_str().into());
        }
        let results = self
            .db
            .batch(vec![
                self.rules_statement(&sql, &binds)?,
                self.rules_statement(
                    &format!(
                        "SELECT ruleset_id, ruleset_name, enforcement, verdict, count(*) AS n FROM rule_evaluations
                         WHERE {column} = ?1 AND created_at >= ?2{ruleset_filter}
                         GROUP BY ruleset_id, enforcement, verdict"
                    ),
                    &insight_binds,
                )?,
                self.rules_statement(
                    &format!(
                        "SELECT json_extract(v.value, '$.rule') AS rule, count(*) AS n
                         FROM rule_evaluations e, json_each(e.violations) v
                         WHERE e.{column} = ?1 AND e.created_at >= ?2 AND e.verdict != 'pass'{}
                         GROUP BY rule ORDER BY n DESC LIMIT 20",
                        ruleset_filter.replace("ruleset_id", "e.ruleset_id")
                    ),
                    &insight_binds,
                )?,
            ])
            .await?;
        let mut evaluations: Vec<Evaluation> = results[0].results::<EvaluationRow>()?.into_iter().map(Evaluation::from).collect();
        let next = (evaluations.len() > limit as usize).then(|| {
            evaluations.truncate(limit as usize);
            evaluations.last().map(|last| last.id.clone())
        });
        let repository = scope.repo.as_ref().map(|repo| format!("{}/{}", repo.namespace, repo.name)).unwrap_or_default();
        for evaluation in &mut evaluations {
            evaluation.repository = repository.clone();
        }
        Ok(Outcome::Ok(EvaluationPage {
            evaluations,
            next: next.flatten(),
            insights: insights(
                results[1].results::<CountRow>()?,
                results[2].results::<RuleCountRow>()?,
            ),
        }))
    }

    /// Everything a merge of `pull` is judged on, and the judgement, for
    /// `actor`, or for nobody in particular. A bypass counts only with
    /// `honor_bypass`: a person merging asks for it (`bypass_rules`).
    pub(crate) async fn merge_gate(
        &self,
        repo: &Repo,
        pull: &Pull,
        actor: Option<&User>,
        ignore_checks: bool,
        honor_bypass: bool,
    ) -> Result<Gate> {
        let rulesets = self.rulesets_for(repo).await?;
        let base = pull.base_branch(&repo.default_branch).to_owned();
        let git_ref = Target::Branch.full_ref(&base);
        let who = match actor {
            Some(actor) => Some(self.actor_facts(actor, repo, &rulesets).await?),
            None => None,
        };
        let mut applicable = select::applicable(&rulesets, RepoFacts::from(repo), std::slice::from_ref(&git_ref), who.as_ref(), &repo.namespace);
        if !honor_bypass {
            for ruleset in &mut applicable {
                ruleset.bypass = None;
            }
        }
        let agent = agent_change(pull);
        let files: Vec<String> = pull.files.iter().map(|file| file.path.clone()).collect();
        let requirements = g1t_rules::merge::requirements(&applicable, &git_ref, &repo.default_branch, agent, &files);
        if applicable.is_empty() {
            return Ok(Gate { judged: Vec::new(), requirements, applicable, who });
        }
        let needs_owners = applicable.iter().any(|ruleset| {
            ruleset.rules.iter().any(|entry| matches!(&entry.rule, Rule::PullRequest(rule) if rule.require_code_owner_review))
        });
        let owners_settings = RepoSettings { require_code_owner_review: true, ..RepoSettings::default() };
        let teams = g1t_rules::merge::named_teams(&applicable);
        let (verdicts, statuses, behind, code_owners, spent, team_members, commits) = futures_util::try_join!(
            self.verdict_rows(pull),
            self.statuses(&pull.repo_id, pull.head_commit.as_deref()),
            self.is_behind(&repo.id, pull),
            async {
                if needs_owners { self.code_owners_gap(&owners_settings, pull).await } else { Ok(None) }
            },
            self.pull_spend(pull),
            async {
                if teams.is_empty() { Ok(HashMap::new()) } else { self.team_people(&teams, &repo.namespace, &repo.id).await }
            },
            async {
                if g1t_rules::merge::needs_commits(&applicable, agent) {
                    self.pull_commits(repo, pull, &base).await.map(Some)
                } else {
                    Ok(None)
                }
            },
        )?;
        let reviews = latest_reviews(verdicts);
        let facts = MergeFacts {
            git_ref: git_ref.clone(),
            agent_change: agent,
            owner_id: &pull.owner().id,
            reviews: &reviews,
            head_pushed_at: pull.head_pushed_at.as_deref(),
            head_pushed_by: pull.head_pushed_by.as_deref(),
            code_owners_missing: code_owners.as_deref(),
            statuses: &statuses,
            behind,
            files: &files,
            commits: commits.as_ref(),
            confidence: pull.confidence.as_ref().map(|confidence| confidence.level),
            spent_usd: spent,
            now_ms: now_ms(),
            method: Some(MergeMethod::Merge),
            team_members: Some(&team_members),
            ignore_checks,
        };
        let judged = g1t_rules::merge::judge(&applicable, &repo.default_branch, &facts);
        Ok(Gate { judged, requirements, applicable, who })
    }

    /// Every verdict on a pull request, oldest first: who, and when.
    async fn verdict_rows(&self, pull: &Pull) -> Result<Vec<(String, String, ReviewVerdict, String)>> {
        #[derive(Deserialize)]
        struct Row {
            author_id: String,
            author_name: String,
            verdict: ReviewVerdict,
            created_at: String,
        }
        let rows = match self.prefetched_pull(&pull.id) {
            Some(found) => found.rows::<Row>(crate::prefetch::Slot::Verdicts)?,
            None => self
                .db
                .prepare(
                    "SELECT author_id, author_name, verdict, created_at FROM comments
                     WHERE repo_id = ? AND number = ? AND verdict IS NOT NULL ORDER BY id",
                )
                .bind(&[pull.repo_id.as_str().into(), pull.number.into()])?
                .all()
                .await?
                .results::<Row>()?,
        };
        Ok(rows.into_iter().map(|row| (row.author_id, row.author_name, row.verdict, row.created_at)).collect())
    }

    /// What agents have spent on a pull request, in US dollars.
    pub(crate) async fn pull_spend(&self, pull: &Pull) -> Result<f64> {
        #[derive(Deserialize)]
        struct Row {
            spent: Option<f64>,
        }
        Ok(self
            .db
            .prepare("SELECT sum(cost_usd) AS spent FROM agent_runs WHERE pull_id = ?")
            .bind(&[pull.id.as_str().into()])?
            .first::<Row>(None)
            .await?
            .and_then(|row| row.spent)
            .unwrap_or(0.0))
    }

    /// The commits a pull request would land, read as rules look at them.
    async fn pull_commits(&self, repo: &Repo, pull: &Pull, base: &str) -> Result<InspectedCommits> {
        let Some(head) = pull.head_commit.clone() else {
            return Ok(InspectedCommits::default());
        };
        let found: Outcome<InspectedCommits> = g1t_kit::call(
            &self.repos,
            "inspect_commits",
            &InspectCommitsArgs {
                source_id: pull.fork_repo_id.clone().unwrap_or_else(|| repo.id.clone()),
                head,
                target_id: repo.id.clone(),
                base_branch: base.to_owned(),
                limit: None,
            },
        )
        .await?;
        Ok(match found {
            Outcome::Ok(commits) => commits,
            Outcome::Fail(failure) => {
                worker::console_error!("inspect_commits for {}: {}", pull.id, failure.message);
                InspectedCommits::default()
            }
        })
    }

    /// Records how each ruleset judged a merge.
    pub(crate) async fn record_merge_evaluations(&self, repo: &Repo, pull: &Pull, gate: &Gate) {
        let Some(who) = &gate.who else { return };
        if gate.judged.is_empty() {
            return;
        }
        let evaluations = g1t_rules::evaluations(
            &gate.judged,
            &repo.id,
            &repo.namespace,
            Action::Merge,
            who,
            Some(pull.number),
            pull.head_commit.as_deref(),
        );
        if let Err(error) = self.record_evaluations(RecordEvaluationsArgs { evaluations }).await {
            worker::console_error!("merge evaluations not recorded: {error}");
        }
    }

    /// The settings that hold for a pull request: the repository's, with
    /// branch protection as the rules for the branch it merges into stack.
    pub(crate) async fn settings_on(&self, repo: &Repo, pull: &Pull) -> Result<RepoSettings> {
        let (stored, rulesets) = futures_util::future::try_join(self.settings(&repo.id), self.rulesets_for(repo)).await?;
        let base = pull.base_branch(&repo.default_branch);
        let git_ref = Target::Branch.full_ref(base);
        let applicable = select::applicable(&rulesets, RepoFacts::from(repo), std::slice::from_ref(&git_ref), None, &repo.namespace);
        let files: Vec<String> = pull.files.iter().map(|file| file.path.clone()).collect();
        let requirements = g1t_rules::merge::requirements(&applicable, &git_ref, &repo.default_branch, agent_change(pull), &files);
        Ok(overlay(stored, &requirements, base == repo.default_branch))
    }

    /// The repository a pull request merges into: as read earlier in this
    /// request, or now.
    pub(crate) async fn repo_for(&self, pull: &Pull) -> Result<Option<Repo>> {
        if let Some(repo) = self.known_repos.borrow().get(&pull.repo_id) {
            return Ok(Some(repo.clone()));
        }
        let found = self.target_of(pull).await?;
        if let Some(repo) = &found {
            self.known_repos.borrow_mut().insert(repo.id.clone(), repo.clone());
        }
        Ok(found)
    }

    /// The settings that hold for a pull request, when only it is at hand.
    pub(crate) async fn settings_for(&self, pull: &Pull) -> Result<RepoSettings> {
        match self.repo_for(pull).await? {
            Some(repo) => self.settings_on(&repo, pull).await,
            None => self.settings(&pull.repo_id).await,
        }
    }

    /// The settings that hold for the default branch.
    pub(crate) async fn default_branch_settings(&self, repo: &Repo) -> Result<RepoSettings> {
        let (stored, requirements) = futures_util::future::try_join(self.settings(&repo.id), self.default_requirements(repo)).await?;
        Ok(overlay(stored, &requirements, true))
    }

    /// What the active rules ask of the default branch, for anyone.
    pub(crate) async fn default_requirements(&self, repo: &Repo) -> Result<Requirements> {
        let rulesets = self.rulesets_for(repo).await?;
        let git_ref = Target::Branch.full_ref(&repo.default_branch);
        let applicable = select::applicable(&rulesets, RepoFacts::from(repo), std::slice::from_ref(&git_ref), None, &repo.namespace);
        Ok(g1t_rules::merge::requirements(&applicable, &git_ref, &repo.default_branch, false, &[]))
    }

    /// How the default branch's merge queue batches: its rule's
    /// parameters, or the defaults.
    pub(crate) async fn queue_rule(&self, repo_id: &str) -> Result<MergeQueueRule> {
        let path: Option<RepoPath> =
            g1t_kit::call(&self.repos, "path_by_id", &g1t_contracts::repos::PathByIdArgs { id: repo_id.to_owned() }).await?;
        let repo = match path {
            Some(path) => self.repo_by_id(repo_id, &path.namespace).await?,
            None => None,
        };
        Ok(match repo {
            Some(repo) => self.default_requirements(&repo).await?.merge_queue.unwrap_or_default(),
            None => MergeQueueRule::default(),
        })
    }

    /// The default branch's settings by repository id, for callers that do
    /// not have the repository at hand (the merge queue, statuses).
    pub(crate) async fn settings_by_id(&self, repo_id: &str) -> Result<RepoSettings> {
        let path: Option<RepoPath> =
            g1t_kit::call(&self.repos, "path_by_id", &g1t_contracts::repos::PathByIdArgs { id: repo_id.to_owned() }).await?;
        let repo = match path {
            Some(path) => self.repo_by_id(repo_id, &path.namespace).await?,
            None => None,
        };
        match repo {
            Some(repo) => self.default_branch_settings(&repo).await,
            None => self.settings(repo_id).await,
        }
    }

    /// The branch protection ruleset's rules rewritten from the old
    /// settings (`update_settings`), creating it when needed.
    pub(crate) async fn write_branch_protection(&self, repo: &Repo, settings: &RepoSettings, actor: &User) -> Result<()> {
        let rulesets = self.rulesets_for(repo).await?;
        let existing = rulesets
            .iter()
            .find(|ruleset| ruleset.repo_id.as_deref() == Some(&repo.id) && ruleset.source.as_deref() == Some(BRANCH_PROTECTION));
        let now = rfc3339(now_ms());
        match existing {
            Some(found) => {
                let protected = legacy::requires_pull_requests(&found.spec.rules);
                let mut ruleset = found.clone();
                ruleset.spec.rules = legacy::replace(&found.spec.rules, settings, protected);
                ruleset.updated_by = actor.username.clone();
                ruleset.updated_at = now;
                self.store_ruleset(&ruleset).await?;
                self.announce("ruleset.updated", &ruleset, actor).await;
            }
            None => {
                let Some(spec) = legacy::ruleset_of(settings, false) else { return Ok(()) };
                let ruleset = Ruleset {
                    id: new_id("rs", now_ms()),
                    level: Level::Repository,
                    workspace: repo.namespace.to_lowercase(),
                    repo_id: Some(repo.id.clone()),
                    repository: Some(format!("{}/{}", repo.namespace, repo.name)),
                    spec,
                    source: Some(BRANCH_PROTECTION.to_owned()),
                    created_by: actor.username.clone(),
                    created_at: now.clone(),
                    updated_by: actor.username.clone(),
                    updated_at: now,
                };
                self.store_ruleset(&ruleset).await?;
                self.announce("ruleset.created", &ruleset, actor).await;
            }
        }
        Ok(())
    }

    /// Services only (repos `update` with `protected`): whether the branch
    /// protection ruleset refuses pushes to the default branch.
    pub(crate) async fn set_requires_pull_request(&self, a: RequirePullRequestArgs) -> Result<Outcome<bool>> {
        let rulesets = self.rulesets_for(&a.repo).await?;
        let existing = rulesets
            .iter()
            .find(|ruleset| ruleset.repo_id.as_deref() == Some(&a.repo.id) && ruleset.source.as_deref() == Some(BRANCH_PROTECTION))
            .cloned();
        let now = rfc3339(now_ms());
        let mut ruleset = match existing {
            Some(found) => found,
            None if !a.protected => return Ok(Outcome::Ok(false)),
            None => Ruleset {
                id: new_id("rs", now_ms()),
                level: Level::Repository,
                workspace: a.repo.namespace.to_lowercase(),
                repo_id: Some(a.repo.id.clone()),
                repository: Some(format!("{}/{}", a.repo.namespace, a.repo.name)),
                spec: legacy::ruleset_of(&RepoSettings::default(), true).unwrap_or_default(),
                source: Some(BRANCH_PROTECTION.to_owned()),
                created_by: a.actor.username.clone(),
                created_at: now.clone(),
                updated_by: a.actor.username.clone(),
                updated_at: now.clone(),
            },
        };
        let mut found = false;
        for entry in &mut ruleset.spec.rules {
            if let (Rule::PullRequest(rule), AppliesTo::Everyone) = (&mut entry.rule, entry.applies_to) {
                rule.allow_direct_pushes = !a.protected;
                found = true;
            }
        }
        if !found && a.protected {
            ruleset.spec.rules.insert(0, RuleEntry::everyone(Rule::PullRequest(PullRequestRule::default())));
        }
        ruleset.updated_by = a.actor.username.clone();
        ruleset.updated_at = now;
        self.store_ruleset(&ruleset).await?;
        self.announce("ruleset.updated", &ruleset, &a.actor).await;
        Ok(Outcome::Ok(true))
    }
}

/// `set_requires_pull_request`: services only.
#[derive(Deserialize)]
pub(crate) struct RequirePullRequestArgs {
    repo: Repo,
    protected: bool,
    actor: User,
}

/// A merge, judged.
pub(crate) struct Gate {
    pub(crate) judged: Vec<Judged>,
    pub(crate) requirements: Requirements,
    #[allow(dead_code)]
    pub(crate) applicable: Vec<Applicable>,
    pub(crate) who: Option<ActorFacts>,
}

impl Gate {
    /// What refuses the merge now, if anything, in one sentence.
    pub(crate) fn refusal(&self) -> Option<String> {
        g1t_rules::report::summary(&g1t_rules::outcome::blocking(&self.judged))
    }

    /// What people (not checks, which g1t's lifecycle waits for itself)
    /// must still do before it can merge.
    pub(crate) fn people_gap(&self) -> Option<String> {
        let waiting: Vec<&Violation> = g1t_rules::outcome::blocking(&self.judged)
            .into_iter()
            .filter(|violation| !g1t_rules::merge::about_checks(&violation.rule))
            .collect();
        g1t_rules::report::summary(&waiting)
    }

    /// Whether any rule not met could be bypassed by the actor.
    pub(crate) fn bypassable(&self) -> bool {
        self.judged.iter().any(|one| one.enforcement == Enforcement::Active && one.verdict() == Verdict::Bypass)
    }

    /// The same judgement for an actor who did not ask to bypass anything.
    pub(crate) fn without_bypass(mut self) -> Gate {
        for one in &mut self.judged {
            one.bypass = None;
        }
        self
    }
}

/// A workspace ruleset's repository condition, against one repository.
fn repo_matches_spec(ruleset: &Ruleset, repo: RepoFacts<'_>) -> bool {
    select::repo_matches(&ruleset.spec.conditions.repository.clone().unwrap_or_default(), repo)
}

const RULESETS_SQL: &str =
    "SELECT * FROM rulesets WHERE repo_id = ?1 OR (level = 'workspace' AND workspace = ?2) ORDER BY created_at";
const ADOPTED_SQL: &str = "SELECT 1 AS n FROM ruleset_adoptions WHERE repo_id = ?1";

/// The statements prefetch.rs batches for a pull request's page.
pub(crate) fn prefetch_sql() -> (&'static str, &'static str) {
    (RULESETS_SQL, ADOPTED_SQL)
}

#[derive(Deserialize)]
struct CountRow {
    ruleset_id: String,
    ruleset_name: String,
    enforcement: Enforcement,
    verdict: Verdict,
    n: u32,
}

#[derive(Deserialize)]
struct RuleCountRow {
    rule: Option<String>,
    n: u32,
}

/// Counts by ruleset and verdict, and violations by rule, as insights.
fn insights(counts: Vec<CountRow>, rules: Vec<RuleCountRow>) -> Insights {
    let mut out = Insights { days: INSIGHT_DAYS, ..Insights::default() };
    let mut by_ruleset: Vec<RulesetInsight> = Vec::new();
    for row in counts {
        out.total += row.n;
        let index = match by_ruleset.iter().position(|have| have.ruleset_id == row.ruleset_id) {
            Some(index) => index,
            None => {
                by_ruleset.push(RulesetInsight {
                    ruleset_id: row.ruleset_id.clone(),
                    ruleset_name: row.ruleset_name.clone(),
                    enforcement: row.enforcement,
                    ..RulesetInsight::default()
                });
                by_ruleset.len() - 1
            }
        };
        let one = &mut by_ruleset[index];
        one.total += row.n;
        match (row.verdict, row.enforcement) {
            (Verdict::Pass, _) => out.passed += row.n,
            (Verdict::Bypass, _) => {
                out.bypassed += row.n;
                one.bypassed += row.n;
            }
            (Verdict::Fail, Enforcement::Evaluate) => {
                out.would_block += row.n;
                one.would_block += row.n;
            }
            (Verdict::Fail, _) => {
                out.blocked += row.n;
                one.blocked += row.n;
            }
        }
    }
    by_ruleset.sort_by_key(|one| std::cmp::Reverse(one.blocked + one.would_block + one.bypassed));
    out.by_ruleset = by_ruleset;
    out.by_rule = rules
        .into_iter()
        .filter_map(|row| row.rule.map(|rule| RuleInsight { rule, count: row.n }))
        .collect();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::rules::Level;

    fn count(ruleset: &str, enforcement: Enforcement, verdict: Verdict, n: u32) -> CountRow {
        CountRow { ruleset_id: ruleset.into(), ruleset_name: ruleset.into(), enforcement, verdict, n }
    }

    #[test]
    fn insights_add_up_by_ruleset_and_verdict() {
        let found = insights(
            vec![
                count("a", Enforcement::Active, Verdict::Pass, 10),
                count("a", Enforcement::Active, Verdict::Fail, 2),
                count("b", Enforcement::Evaluate, Verdict::Fail, 5),
                count("b", Enforcement::Evaluate, Verdict::Pass, 1),
                count("c", Enforcement::Active, Verdict::Bypass, 1),
            ],
            vec![RuleCountRow { rule: Some("pull_request".into()), n: 4 }, RuleCountRow { rule: None, n: 1 }],
        );
        assert_eq!((found.total, found.passed, found.blocked, found.would_block, found.bypassed), (19, 11, 2, 5, 1));
        assert_eq!(found.by_ruleset[0].ruleset_id, "b", "most problems first");
        assert_eq!(found.by_ruleset[0].would_block, 5);
        assert_eq!(found.by_rule, vec![RuleInsight { rule: "pull_request".into(), count: 4 }]);
        assert_eq!(found.days, 30);
    }

    #[test]
    fn a_stored_ruleset_reads_back_with_its_repository() {
        let row = RulesetRow {
            id: "rs_1".into(),
            level: "repository".into(),
            workspace: String::new(),
            repo_id: Some("rep_1".into()),
            spec: r#"{"name":"Default branch protection","conditions":{"ref_name":{"include":["~DEFAULT_BRANCH"]}},"rules":[{"type":"deletion"}]}"#.into(),
            source: Some(BRANCH_PROTECTION.into()),
            created_by: "g1t".into(),
            created_at: "2026-10-07T00:00:00.000Z".into(),
            updated_by: "g1t".into(),
            updated_at: "2026-10-07T00:00:00.000Z".into(),
        };
        let repo: Repo = serde_json::from_value(serde_json::json!({
            "id": "rep_1", "namespace": "Acme", "name": "web", "description": null, "isPrivate": true, "ownerId": "usr_1",
            "defaultBranch": "main", "forkOf": null, "createdAt": ""
        }))
        .unwrap();
        let ruleset = row.into_ruleset(Some(&repo)).unwrap();
        assert_eq!(ruleset.level, Level::Repository);
        assert_eq!(ruleset.workspace, "acme");
        assert_eq!(ruleset.repository.as_deref(), Some("Acme/web"));
        assert_eq!(ruleset.spec.rules[0].rule.kind(), "deletion");
    }

    #[test]
    fn agents_changes_are_told_from_peoples() {
        use crate::rows::stored::{ASKER, G1T, pull};
        assert!(agent_change(&pull(G1T, Some(ASKER))));
        let mut person: Pull = pull(ASKER, None);
        person.agent = person.author.username.clone();
        person.runtime = g1t_contracts::work::Runtime::External;
        person.fork = None;
        assert!(!agent_change(&person));
        person.agent = "claude-code".into();
        assert!(agent_change(&person));
    }

    #[test]
    fn latest_reviews_keep_each_reviewers_last_verdict() {
        let reviews = latest_reviews(vec![
            ("usr_b".into(), "bob".into(), ReviewVerdict::RequestChanges, "1".into()),
            (AGENT_ID.into(), "g1t".into(), ReviewVerdict::Approve, "2".into()),
            ("usr_b".into(), "bob".into(), ReviewVerdict::Approve, "3".into()),
        ]);
        assert_eq!(reviews.len(), 2);
        assert!(reviews[0].agent);
        assert_eq!(reviews[1].verdict, ReviewVerdict::Approve);
    }

    #[test]
    fn protection_overlays_the_stored_settings() {
        let requirements = Requirements {
            required_checks: vec!["CI".into()],
            strict: true,
            required_approvals: 2,
            count_agent_approvals: false,
            allow_bypass_on_merge: false,
            require_code_owner_review: true,
            merge_queue: Some(MergeQueueRule::default()),
            ..Requirements::default()
        };
        let stored = RepoSettings { auto_merge: true, required_approvals: 5, ..RepoSettings::default() };
        let main = overlay(stored.clone(), &requirements, true);
        assert_eq!((main.required_approvals, main.merge_queue, main.auto_merge), (2, true, true));
        assert!(main.require_up_to_date && !main.allow_ignoring_checks && main.require_code_owner_review);
        assert!(!overlay(stored, &requirements, false).merge_queue, "the queue lands on the default branch only");
    }
}
