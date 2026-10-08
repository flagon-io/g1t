//! The rules engine: which rulesets hold for a branch or tag, and whether a
//! change to it meets them.
//!
//! Everything here is pure: the work service (merges, and where rulesets
//! are kept) and the repos service (pushes, and every other change to a
//! branch or tag) gather the facts and ask. The types are in
//! `g1t_contracts::rules`.
//!
//! - [`select`]: which rulesets hold in a repository and for a name, who
//!   may bypass them, and the effective rules of one branch.
//! - [`push`]: judging a push, or a branch created, deleted or renamed.
//! - [`merge`]: judging a pull request's merge, and what the active rules
//!   ask of g1t's lifecycle and merge queue ([`merge::requirements`]).
//! - [`content`]: rules about what commits bring, for both.
//! - [`validate`]: whether a ruleset can be saved.
//! - [`legacy`]: branch protection as it was, as a ruleset.
//! - [`report`]: what git and people are told.

pub mod content;
pub mod glob;
pub mod legacy;
pub mod merge;
pub mod outcome;
pub mod push;
pub mod report;
pub mod select;
pub mod text;
pub mod validate;
pub mod window;

pub use outcome::Judged;
pub use select::{ActorFacts, RepoFacts, Who};

use g1t_contracts::rules::{Action, NewEvaluation};

/// The evaluations to record for a change: one per ruleset that holds.
pub fn evaluations(
    judged: &[Judged],
    repo_id: &str,
    workspace: &str,
    action: Action,
    actor: &ActorFacts,
    number: Option<u32>,
    sha: Option<&str>,
) -> Vec<NewEvaluation> {
    judged
        .iter()
        .map(|one| NewEvaluation {
            repo_id: repo_id.to_owned(),
            workspace: workspace.to_lowercase(),
            ruleset_id: one.id.clone(),
            ruleset_name: one.name.clone(),
            enforcement: one.enforcement,
            action,
            git_ref: one.git_ref.clone(),
            actor: actor.username.clone(),
            actor_kind: actor.kind.as_str().to_owned(),
            verdict: one.verdict(),
            violations: one.violations.clone(),
            number,
            sha: sha.map(str::to_owned),
        })
        .collect()
}
