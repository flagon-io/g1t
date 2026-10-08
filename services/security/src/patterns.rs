//! Custom patterns: secret formats a repository or a workspace defines,
//! found by push protection and history scans alongside the built-in ones.
//! A repository's take Admin to change; a workspace's, an owner. On a
//! private repository they need the Security and quality activation; a
//! workspace's patterns without it cover its public repositories only.

use g1t_contracts::access::Capability;
use g1t_contracts::security_suite::{
    CustomPatternsArgs, DeleteCustomPatternArgs, DryRun, DryRunPatternArgs, DryRunRepo, MatchPatternArgs, PaidFeature, PatternList,
    PatternMatches, PatternSpec, PatternsForArgs, SaveCustomPatternArgs, SavedPattern,
};
use g1t_contracts::{FailureCode, Outcome, User};
use g1t_scan::custom;
use worker::Result;

use crate::Security;
use crate::store::RepoRow;
use crate::suite::payment_required;

/// Repositories a workspace's dry run reads, at most.
const DRY_RUN_REPOS: usize = 10;
/// Matches a dry run shows per repository.
const DRY_RUN_MATCHES: u32 = 50;

fn fail<T>(code: FailureCode, message: impl Into<String>) -> Outcome<T> {
    Outcome::fail(code, message)
}

/// The scanner's form of a pattern.
pub fn scan_spec(spec: &PatternSpec) -> custom::PatternSpec {
    custom::PatternSpec {
        id: spec.id.clone(),
        name: spec.name.clone(),
        pattern: spec.pattern.clone(),
        before: spec.before.clone(),
        after: spec.after.clone(),
    }
}

fn trimmed(text: Option<&str>) -> Option<String> {
    text.map(str::trim).filter(|text| !text.is_empty()).map(str::to_owned)
}

/// Where a pattern call acts: one repository (Admin), or a workspace (an
/// owner to change, any member to read).
enum Scope {
    Repo(RepoRow),
    Workspace(String),
}

impl Security {
    async fn pattern_scope(
        &self,
        workspace: &str,
        repo: Option<&g1t_contracts::repos::RepoPath>,
        actor: &Option<User>,
        change: bool,
    ) -> Result<Outcome<Scope>> {
        let workspace = workspace.to_lowercase();
        match repo {
            Some(path) => {
                let capability = if change { Capability::ManageSecurity } else { crate::SEE_FINDINGS };
                Ok(match self.member_repo(path, actor, capability).await? {
                    Outcome::Ok(repo) => Outcome::Ok(Scope::Repo(repo)),
                    Outcome::Fail(failure) => Outcome::Fail(failure),
                })
            }
            None => {
                let role = actor.as_ref().and_then(|user| user.role_in(&workspace));
                let manages = actor.as_ref().is_some_and(|user| user.manages_security(&workspace));
                Ok(match (role, change) {
                    (None, _) => fail(FailureCode::NotFound, "Workspace not found."),
                    (Some(_), false) => Outcome::Ok(Scope::Workspace(workspace)),
                    (Some(_), true) if manages => Outcome::Ok(Scope::Workspace(workspace)),
                    (Some(_), true) => fail(FailureCode::Forbidden, "Only an owner or a security manager can change the workspace's custom patterns."),
                })
            }
        }
    }

    pub(crate) async fn custom_patterns(&self, a: CustomPatternsArgs) -> Result<Outcome<PatternList>> {
        let scope = match self.pattern_scope(&a.workspace, a.repo.as_ref(), &a.viewer, false).await? {
            Outcome::Ok(scope) => scope,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let (rows, entitled) = match &scope {
            Scope::Repo(repo) => (self.store.patterns(&repo.namespace, Some(&repo.repo_id)).await?, self.entitled(repo).await?),
            Scope::Workspace(namespace) => (self.store.patterns(namespace, None).await?, self.activated(namespace).await),
        };
        Ok(Outcome::Ok(PatternList { patterns: rows.iter().map(|row| row.contract()).collect(), entitled }))
    }

    pub(crate) async fn save_custom_pattern(&self, a: SaveCustomPatternArgs) -> Result<Outcome<SavedPattern>> {
        let actor = Some(a.actor.clone());
        let scope = match self.pattern_scope(&a.workspace, a.repo.as_ref(), &actor, true).await? {
            Outcome::Ok(scope) => scope,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if !a.actor.verified {
            return Ok(fail(FailureCode::Forbidden, "Confirm your email address first."));
        }
        let (namespace, repo_id) = match &scope {
            Scope::Repo(repo) => {
                if let Some(refusal) = self.gate(repo, PaidFeature::CustomPatterns).await? {
                    return Ok(refusal);
                }
                (repo.namespace.clone(), Some(repo.repo_id.clone()))
            }
            Scope::Workspace(namespace) => (namespace.clone(), None),
        };
        // A pattern changed must be one of this scope's.
        if let Some(id) = &a.id {
            match self.store.pattern(id).await? {
                Some(row) if row.namespace == namespace && row.repo_id == repo_id => {}
                _ => return Ok(fail(FailureCode::NotFound, "No such pattern.")),
            }
        } else if self.store.patterns(&namespace, repo_id.as_deref()).await?.len() >= custom::MAX_PATTERNS {
            return Ok(fail(FailureCode::Invalid, format!("A repository is scanned with at most {} custom patterns.", custom::MAX_PATTERNS)));
        }
        let spec = PatternSpec {
            id: a.id.clone().unwrap_or_default(),
            name: a.name.trim().chars().take(100).collect(),
            pattern: a.pattern.clone(),
            before: trimmed(a.before.as_deref()),
            after: trimmed(a.after.as_deref()),
        };
        let compiled = match custom::compile(&scan_spec(&spec)) {
            Ok(compiled) => compiled,
            Err(problem) => return Ok(fail(FailureCode::Invalid, problem)),
        };
        let tests = match custom::clean_test_strings(&a.test_strings) {
            Ok(tests) => tests,
            Err(problem) => return Ok(fail(FailureCode::Invalid, problem)),
        };
        let state = if a.publish { "published" } else { "draft" };
        let was_published = match &a.id {
            Some(id) => self.store.pattern(id).await?.is_some_and(|row| row.state == "published"),
            None => false,
        };
        let id = self
            .store
            .save_pattern(a.id.as_deref(), &namespace, repo_id.as_deref(), &spec, &tests, state, &a.actor.username)
            .await?;
        // Published, or changed while published: the history is read again
        // for it, a page at a time, as the first scan was.
        if a.publish {
            self.store.rescan_for_pattern(&namespace, repo_id.as_deref()).await?;
        }
        let verb = match (a.id.is_some(), a.publish, was_published) {
            (false, true, _) => "published",
            (false, false, _) => "saved as a draft",
            (true, true, false) => "published",
            (true, false, true) => "unpublished",
            (true, _, _) => "changed",
        };
        let repo_row = match &scope {
            Scope::Repo(repo) => Some(repo),
            Scope::Workspace(_) => None,
        };
        self.audit(
            &a.actor,
            "custom_pattern",
            repo_row,
            &namespace,
            None,
            &format!("Custom pattern \"{}\" {verb}: {}", spec.name, spec.pattern),
        )
        .await;
        let Some(row) = self.store.pattern(&id).await? else {
            return Ok(fail(FailureCode::NotFound, "The pattern was not saved."));
        };
        let tests = custom::test(&compiled, &tests)
            .into_iter()
            .map(|found| found.map(|(start, end)| (start as u32, end as u32)))
            .collect();
        Ok(Outcome::Ok(SavedPattern { pattern: row.contract(), tests }))
    }

    pub(crate) async fn delete_custom_pattern(&self, a: DeleteCustomPatternArgs) -> Result<Outcome<bool>> {
        let actor = Some(a.actor.clone());
        let scope = match self.pattern_scope(&a.workspace, a.repo.as_ref(), &actor, true).await? {
            Outcome::Ok(scope) => scope,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let (namespace, repo) = match &scope {
            Scope::Repo(repo) => (repo.namespace.clone(), Some(repo)),
            Scope::Workspace(namespace) => (namespace.clone(), None),
        };
        let Some(row) = self.store.pattern(&a.id).await? else {
            return Ok(fail(FailureCode::NotFound, "No such pattern."));
        };
        if row.namespace != namespace || row.repo_id.as_deref() != repo.map(|repo| repo.repo_id.as_str()) {
            return Ok(fail(FailureCode::NotFound, "No such pattern."));
        }
        self.store.delete_pattern(&a.id).await?;
        self.audit(&a.actor, "custom_pattern", repo, &namespace, None, &format!("Custom pattern \"{}\" deleted", row.name)).await;
        Ok(Outcome::Ok(true))
    }

    pub(crate) async fn dry_run_pattern(&self, a: DryRunPatternArgs) -> Result<Outcome<DryRun>> {
        let actor = Some(a.actor.clone());
        let scope = match self.pattern_scope(&a.workspace, a.repo.as_ref(), &actor, true).await? {
            Outcome::Ok(scope) => scope,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let spec = PatternSpec {
            id: "pat_dry_run".to_owned(),
            name: "Dry run".to_owned(),
            pattern: a.pattern.clone(),
            before: trimmed(a.before.as_deref()),
            after: trimmed(a.after.as_deref()),
        };
        if let Err(problem) = custom::compile(&scan_spec(&spec)) {
            return Ok(fail(FailureCode::Invalid, problem));
        }
        let targets: Vec<RepoRow> = match scope {
            Scope::Repo(repo) => {
                if let Some(refusal) = self.gate(&repo, PaidFeature::CustomPatterns).await? {
                    return Ok(refusal);
                }
                vec![repo]
            }
            Scope::Workspace(namespace) => {
                let all = self.store.in_namespace(&namespace).await?;
                let activated = self.activated(&namespace).await;
                let mut chosen = Vec::new();
                for repo in all {
                    if !a.repos.is_empty() && !a.repos.iter().any(|name| name.eq_ignore_ascii_case(&repo.name)) {
                        continue;
                    }
                    let (_, private) = self.store.repo_settings(&repo.repo_id).await?;
                    if private && !activated {
                        continue;
                    }
                    chosen.push(repo);
                    if chosen.len() == DRY_RUN_REPOS {
                        break;
                    }
                }
                if chosen.is_empty() && !activated {
                    return Ok(payment_required(PaidFeature::CustomPatterns, &namespace));
                }
                chosen
            }
        };
        let mut repos = Vec::new();
        for repo in targets {
            let result: PatternMatches = g1t_kit::call(
                &self.repos,
                "match_pattern",
                &MatchPatternArgs { repo_id: repo.repo_id.clone(), pattern: spec.clone(), limit: DRY_RUN_MATCHES },
            )
            .await
            .unwrap_or_else(|error| {
                worker::console_error!("security: dry run on {}: {error}", repo.repo_id);
                PatternMatches::default()
            });
            repos.push(DryRunRepo { name: repo.name.clone(), result });
        }
        Ok(Outcome::Ok(DryRun { repos }))
    }

    /// The patterns push protection and scans use for a repository: its
    /// published ones and its workspace's, when it is entitled to them.
    pub(crate) async fn patterns_for(&self, a: PatternsForArgs) -> Result<Vec<PatternSpec>> {
        let namespace = a.namespace.to_lowercase();
        let patterns = self.store.published_patterns(&namespace, &a.repo_id).await?;
        if patterns.is_empty() {
            return Ok(patterns);
        }
        let private = match a.private {
            Some(private) => private,
            None => self.store.repo_settings(&a.repo_id).await?.1,
        };
        if private && !self.activated(&namespace).await {
            return Ok(Vec::new());
        }
        Ok(patterns)
    }
}
