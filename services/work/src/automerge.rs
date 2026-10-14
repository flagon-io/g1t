//! Auto-merge for one pull request, as a person asked (`set_auto_merge`):
//! it merges by itself, as that person, once everything it needs is met.
//!
//! The same events that move g1t's own lifecycle along ask again
//! (`Work::advance`): checks finishing, reviews, being marked ready,
//! pushes, and its base moving. When it can merge, it merges as whoever
//! turned auto-merge on, with the method and message they chose, if they
//! may still merge it. When it cannot merge as things are (it conflicts,
//! it failed in the merge queue, the method is no longer allowed, they
//! can no longer merge), auto-merge turns off with a note saying why.
//!
//! It turns off too when the pull request merges or closes, when anyone
//! but whoever turned it on pushes to it, and when the repository stops
//! allowing auto-merge.

use g1t_contracts::access::{self, Capability};
use g1t_contracts::events::PullEvent;
use g1t_contracts::repos::{GetByIdArgs, Repo, RepoPath};
use g1t_contracts::rules::MergeMethod;
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, User};
use g1t_kit::now_ms;
use g1t_rules::merge::method_label;
use serde::{Deserialize, Serialize};
use worker::Result;

use crate::lifecycle::{POLICY_ACTOR_ID, POLICY_ACTOR_NAME};
use crate::merging;
use crate::retired::writable;
use crate::rows::ValueRow;
use crate::{Work, allowed, no_pull};

/// How long a merge auto-merge started is waited for before another may
/// start.
const MERGE_MINUTES: u64 = 2;

/// Unwraps an `Outcome`, returning its failure from the enclosing method.
macro_rules! check {
    ($outcome:expr) => {
        match $outcome {
            Outcome::Ok(value) => value,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        }
    };
}

/// Auto-merge as stored (`pulls.auto_merge`): what the contract shows, and
/// the account to merge as. `Pull::auto_merge` reads the same JSON and
/// leaves the account out.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredAutoMerge {
    #[serde(flatten)]
    pub(crate) merge: AutoMerge,
    pub(crate) actor: User,
}

/// What to do about a pull request waiting to merge on its own.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Step {
    /// Not yet: something it needs is still missing, which may come.
    Wait,
    /// It cannot merge as things are: turn auto-merge off, saying why.
    Disable(String),
    /// Everything is met: merge it.
    Merge,
}

/// Everything the next step depends on.
#[derive(Debug, Default)]
pub(crate) struct Facts {
    pub(crate) status: Option<PullStatus>,
    /// The repository still allows auto-merge.
    pub(crate) allowed_here: bool,
    /// Whoever turned it on may still merge it.
    pub(crate) can_merge: bool,
    /// Why its method can no longer be used, if it cannot.
    pub(crate) method_refusal: Option<String>,
    /// The files it conflicts in, when known to conflict.
    pub(crate) conflicting: Option<Vec<String>>,
    pub(crate) behind: bool,
    pub(crate) require_up_to_date: bool,
    /// What the rules for its base still want, if anything.
    pub(crate) gate_refusal: Option<String>,
}

/// The next step for a pull request waiting to merge on its own. `who` is
/// whoever turned it on; `base` the branch it merges into.
pub(crate) fn step(facts: &Facts, who: &str, base: &str) -> Step {
    match facts.status {
        Some(PullStatus::Open) => {}
        // A draft may wait: it merges once it is marked ready.
        Some(PullStatus::Draft) => return Step::Wait,
        _ => return Step::Disable("It is no longer open.".to_owned()),
    }
    if !facts.allowed_here {
        return Step::Disable("This repository no longer allows auto-merge.".to_owned());
    }
    if !facts.can_merge {
        return Step::Disable(format!("{who} can no longer merge it."));
    }
    if let Some(refusal) = &facts.method_refusal {
        return Step::Disable(refusal.clone());
    }
    if let Some(files) = &facts.conflicting {
        let named = if files.is_empty() { String::new() } else { format!(" in {}", files.join(", ")) };
        return Step::Disable(format!("It conflicts with {base}{named}. Resolve the conflicts and turn auto-merge on again."));
    }
    if facts.behind && facts.require_up_to_date {
        return Step::Wait;
    }
    if facts.gate_refusal.is_some() {
        return Step::Wait;
    }
    Step::Merge
}

/// Why g1t turns auto-merge off when the merge queue takes the pull
/// request: the queue lands it, so `pull.auto_merge_disabled` says
/// `queued` and tells nobody's inbox.
pub(crate) const JOINED_QUEUE: &str = "It joined the merge queue.";

/// Whether a push by `pusher` (a user id) turns auto-merge off: anyone's
/// but whoever turned it on. A push g1t made itself, with no one behind
/// it, does not.
pub(crate) fn cleared_by_push(stored: &StoredAutoMerge, pusher: Option<&str>) -> bool {
    pusher.is_some_and(|pusher| pusher != stored.actor.id)
}

impl Work {
    /// Auto-merge as stored for a pull request, with the account to merge as.
    async fn stored_auto_merge(&self, pull_id: &str) -> Result<Option<StoredAutoMerge>> {
        let row = self
            .db
            .prepare("SELECT auto_merge AS value FROM pulls WHERE id = ? AND auto_merge IS NOT NULL")
            .bind(&[pull_id.into()])?
            .first::<ValueRow>(None)
            .await?;
        Ok(row.and_then(|row| serde_json::from_str(&row.value).ok()))
    }

    /// Turns a pull request's auto-merge off, if it is on, with a note
    /// saying why: `by` turned it off, or g1t did (`by` is none) because of
    /// `reason`. Publishes `pull.auto_merge_disabled`.
    pub(crate) async fn disable_auto_merge(&self, pull: &Pull, by: Option<&User>, reason: Option<&str>) -> Result<bool> {
        let cleared = self
            .db
            .prepare("UPDATE pulls SET auto_merge = NULL WHERE id = ? AND auto_merge IS NOT NULL RETURNING id AS value")
            .bind(&[pull.id.as_str().into()])?
            .first::<ValueRow>(None)
            .await?;
        if cleared.is_none() {
            return Ok(false);
        }
        let text = match reason {
            Some(reason) => format!("turned off auto-merge: {reason}"),
            None => "turned off auto-merge".to_owned(),
        };
        let who = by.map_or((POLICY_ACTOR_ID, POLICY_ACTOR_NAME), |user| (user.id.as_str(), user.username.as_str()));
        self.note(&pull.repo_id, pull.number, who, &text).await?;
        let event = PullEvent {
            detail: reason.map(str::to_owned),
            auto_merge_by: pull.auto_merge.as_ref().map(|auto| auto.enabled_by.clone()),
            queued: by.is_none() && reason == Some(JOINED_QUEUE),
            ..Self::pull_event(pull)
        };
        match by {
            Some(user) => self.publish("pull.auto_merge_disabled", &pull.repo_id, user, event).await?,
            None => self.publish_as("pull.auto_merge_disabled", &pull.repo_id, None, event).await?,
        }
        Ok(true)
    }

    /// `set_auto_merge`: turns a pull request's auto-merge on or off.
    pub(crate) async fn set_auto_merge(&self, a: SetAutoMergeArgs) -> Result<Outcome<Pull>> {
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, crate::UNVERIFIED));
        }
        let (repo, mut pull) = check!(self.pull_at(&a.repo, a.number, &Some(a.actor.clone())).await?);
        check!(writable(&repo));
        // It merges as whoever turns it on, so only someone who may merge
        // can; its author may also turn it off.
        if a.enabled || !pull.is_owned_by(&a.actor.id) {
            check!(allowed(Some(&a.actor), &repo, Capability::Merge));
        }
        if !pull.status.is_active() {
            return Ok(Outcome::fail(FailureCode::Conflict, format!("This pull request is already {}.", pull.status.as_str())));
        }
        if !a.enabled {
            self.disable_auto_merge(&pull, Some(&a.actor), None).await?;
            return Ok(match self.pull(&repo.id, pull.number).await? {
                Some(pull) => Outcome::Ok(pull),
                None => no_pull(),
            });
        }
        crate::fill_base(&mut pull, &repo);
        let base = pull.base_branch(&repo.default_branch).to_owned();
        let (settings, requirements) = self.settings_and_requirements(&repo, &pull).await?;
        if !settings.allow_auto_merge {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                format!("Auto-merge is turned off for {}/{}. Its admins can turn it on in Settings.", repo.namespace, repo.name),
            ));
        }
        let method = match merging::choose_method(a.merge_method, &settings, &requirements, &base) {
            Ok(method) => method,
            Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
        };
        // What they wrote is checked now, not when it merges.
        if let Err(message) = self
            .merge_message_for(&repo, &pull, &settings, method, a.commit_title.as_deref(), a.commit_message.as_deref())
            .await?
        {
            return Ok(Outcome::fail(FailureCode::Invalid, message));
        }
        if let Some(files) = self.conflicting_files(&pull).await? {
            let named = if files.is_empty() { String::new() } else { format!(" in {}", files.join(", ")) };
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                format!("This branch has conflicts with {base}{named} that must be resolved first. Merge {base} into it, fix them and push."),
            ));
        }
        // One that may merge already merges now.
        if pull.status == PullStatus::Open {
            let facts = self.auto_merge_facts(&repo, &pull, &a.actor, method).await?;
            if step(&facts, &a.actor.username, &base) == Step::Merge {
                return self.merge_pull(merge_args(&a.actor, &repo, pull.number, method, a.commit_title, a.commit_message)).await;
            }
        }
        let stored = StoredAutoMerge {
            merge: AutoMerge {
                method,
                commit_title: a.commit_title.map(|title| title.trim().to_owned()),
                commit_message: a.commit_message,
                enabled_by: a.actor.username.clone(),
                enabled_at: rfc3339(now_ms()),
            },
            actor: a.actor.clone(),
        };
        let set = self
            .db
            .prepare("UPDATE pulls SET auto_merge = ? WHERE id = ? AND status IN ('draft', 'open') RETURNING id AS value")
            .bind(&[serde_json::to_string(&stored)?.into(), pull.id.as_str().into()])?
            .first::<ValueRow>(None)
            .await?;
        if set.is_none() {
            return Ok(Outcome::fail(FailureCode::Conflict, "This pull request is no longer open."));
        }
        let changed = pull.auto_merge.as_ref().is_none_or(|before| before.method != method);
        if changed {
            self.note(
                &pull.repo_id,
                pull.number,
                (&a.actor.id, &a.actor.username),
                &format!("turned on auto-merge ({})", method_label(method)),
            )
            .await?;
            self.publish(
                "pull.auto_merge_enabled",
                &pull.repo_id,
                &a.actor,
                PullEvent { detail: Some(method.as_str().to_owned()), ..Self::pull_event(&pull) },
            )
            .await?;
        }
        Ok(match self.pull(&repo.id, pull.number).await? {
            Some(pull) => Outcome::Ok(pull),
            None => no_pull(),
        })
    }

    /// Where a pull request stands for merging on its own by `method`, as
    /// `actor`.
    async fn auto_merge_facts(&self, repo: &Repo, pull: &Pull, actor: &User, method: MergeMethod) -> Result<Facts> {
        let base = pull.base_branch(&repo.default_branch).to_owned();
        let (settings, requirements) = self.settings_and_requirements(repo, pull).await?;
        let method_refusal = merging::choose_method(Some(method), &settings, &requirements, &base).err();
        let gate = self.merge_gate_by(repo, pull, Some(actor), false, false, method).await?;
        let (behind, conflicting) = futures_util::future::try_join(self.is_behind(pull), self.conflicting_files(pull)).await?;
        Ok(Facts {
            status: Some(pull.status),
            allowed_here: settings.allow_auto_merge,
            can_merge: actor.verified && access::can(Some(actor), repo, Capability::Merge),
            method_refusal,
            conflicting,
            behind,
            require_up_to_date: settings.require_up_to_date,
            gate_refusal: gate.refusal(),
        })
    }

    /// Merges a pull request waiting to merge on its own, if everything it
    /// needs is met; turns auto-merge off, saying why, if it cannot merge
    /// as things are.
    pub(crate) async fn try_auto_merge(&self, pull: &Pull) -> Result<()> {
        let Some(stored) = self.stored_auto_merge(&pull.id).await? else {
            return Ok(());
        };
        let who = stored.actor.username.clone();
        // As whoever turned it on: a repository they can no longer read is
        // one they can no longer merge into.
        let repo: Outcome<Repo> = g1t_kit::call(
            &self.repos,
            "get_by_id",
            &GetByIdArgs { id: pull.repo_id.clone(), viewer: Some(stored.actor.clone()) },
        )
        .await?;
        let repo = match crate::retired::unless_archived(repo) {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) if failure.code == FailureCode::NotFound => {
                self.disable_auto_merge(pull, None, Some(&format!("{who} can no longer merge it."))).await?;
                return Ok(());
            }
            // Archived: nothing merges, and nothing changes.
            Outcome::Fail(_) => return Ok(()),
        };
        // Held to what they may do now, as well as to what they could when
        // they asked (a token's narrower scopes): neither may have changed
        // for the worse since.
        let now: g1t_contracts::Viewer =
            g1t_kit::call(&self.identity, "user_by_id", &g1t_contracts::identity::UserIdArgs { id: stored.actor.id.clone() }).await?;
        if !now.as_ref().is_some_and(|now| now.verified && access::can(Some(now), &repo, Capability::Merge)) {
            self.disable_auto_merge(pull, None, Some(&format!("{who} can no longer merge it."))).await?;
            return Ok(());
        }
        let mut pull = pull.clone();
        crate::fill_base(&mut pull, &repo);
        let base = pull.base_branch(&repo.default_branch).to_owned();
        let facts = self.auto_merge_facts(&repo, &pull, &stored.actor, stored.merge.method).await?;
        match step(&facts, &who, &base) {
            Step::Wait => return Ok(()),
            Step::Disable(reason) => {
                self.disable_auto_merge(&pull, None, Some(&reason)).await?;
                return Ok(());
            }
            Step::Merge => {}
        }
        // One merge at a time, however many events ask.
        if !self.claim(&pull.id, "merge", MERGE_MINUTES).await? {
            return Ok(());
        }
        let merged = self
            .merge_pull(merge_args(
                &stored.actor,
                &repo,
                pull.number,
                stored.merge.method,
                stored.merge.commit_title.clone(),
                stored.merge.commit_message.clone(),
            ))
            .await?;
        self.db
            .prepare("UPDATE pulls SET working_on = NULL, working_until = NULL WHERE id = ? AND working_on = 'merge'")
            .bind(&[pull.id.as_str().into()])?
            .run()
            .await?;
        match merged {
            // Merged, queued, or waiting for the push that catches it up to
            // fast-forward (lifecycle.rs `land_if_requested`).
            Outcome::Ok(merged) => {
                if merged.status == PullStatus::Open && self.queued_entry(&pull.id).await?.is_some() {
                    // In the merge queue it lands as the queue decides.
                    self.disable_auto_merge(&pull, None, Some(JOINED_QUEUE)).await?;
                }
            }
            Outcome::Fail(failure) => {
                self.disable_auto_merge(&pull, None, Some(&format!("It could not be merged: {}", failure.message))).await?;
            }
        }
        Ok(())
    }

    /// A push moved a pull request: auto-merge another person turned on
    /// turns off (`cleared_by_push`).
    pub(crate) async fn auto_merge_after_push(&self, pull: &Pull, pusher: Option<&str>) -> Result<()> {
        if pull.auto_merge.is_none() {
            return Ok(());
        }
        let Some(stored) = self.stored_auto_merge(&pull.id).await? else {
            return Ok(());
        };
        if cleared_by_push(&stored, pusher) {
            let reason = format!("someone other than {} pushed to it.", stored.actor.username);
            self.disable_auto_merge(pull, None, Some(&reason)).await?;
        }
        Ok(())
    }

    /// The repository stopped allowing auto-merge: every pull request
    /// waiting to merge on its own stops waiting.
    pub(crate) async fn auto_merge_turned_off(&self, repo: &Repo, actor: &User) -> Result<()> {
        #[derive(Deserialize)]
        struct Waiting {
            id: String,
        }
        let waiting = self
            .db
            .prepare("SELECT id FROM pulls WHERE repo_id = ? AND auto_merge IS NOT NULL AND status IN ('draft', 'open')")
            .bind(&[repo.id.as_str().into()])?
            .all()
            .await?
            .results::<Waiting>()?;
        for row in waiting {
            if let Some(pull) = self.pull_by_id(&row.id).await? {
                self.disable_auto_merge(&pull, Some(actor), Some("this repository no longer allows auto-merge.")).await?;
            }
        }
        Ok(())
    }
}

/// What merging as auto-merge asks: `actor`'s merge by `method`.
fn merge_args(
    actor: &User,
    repo: &Repo,
    number: u32,
    method: MergeMethod,
    commit_title: Option<String>,
    commit_message: Option<String>,
) -> PullActionArgs {
    PullActionArgs {
        actor: actor.clone(),
        repo: RepoPath { namespace: repo.namespace.clone(), name: repo.name.clone() },
        number,
        summary: String::new(),
        keep_issue_open: false,
        ignore_checks: false,
        bypass_rules: false,
        merge_method: Some(method),
        commit_title,
        commit_message,
        expected_head: None,
        delete_branch: None,
        update_method: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready() -> Facts {
        Facts { status: Some(PullStatus::Open), allowed_here: true, can_merge: true, ..Facts::default() }
    }

    #[test]
    fn it_merges_once_everything_is_met() {
        assert_eq!(step(&ready(), "ana", "main"), Step::Merge);
    }

    #[test]
    fn what_may_still_come_is_waited_for() {
        assert_eq!(step(&Facts { status: Some(PullStatus::Draft), ..ready() }, "ana", "main"), Step::Wait);
        assert_eq!(step(&Facts { gate_refusal: Some("The required check CI has not finished.".into()), ..ready() }, "ana", "main"), Step::Wait);
        assert_eq!(step(&Facts { behind: true, require_up_to_date: true, ..ready() }, "ana", "main"), Step::Wait);
        // Behind is no reason to wait where it need not be up to date.
        assert_eq!(step(&Facts { behind: true, ..ready() }, "ana", "main"), Step::Merge);
    }

    #[test]
    fn what_cannot_change_by_itself_turns_it_off() {
        let off = |facts: Facts| match step(&facts, "ana", "main") {
            Step::Disable(reason) => reason,
            other => panic!("{other:?}"),
        };
        assert_eq!(off(Facts { status: Some(PullStatus::Closed), ..ready() }), "It is no longer open.");
        assert_eq!(off(Facts { allowed_here: false, ..ready() }), "This repository no longer allows auto-merge.");
        assert_eq!(off(Facts { can_merge: false, ..ready() }), "ana can no longer merge it.");
        assert_eq!(off(Facts { method_refusal: Some("main requires linear history".into()), ..ready() }), "main requires linear history");
        assert_eq!(
            off(Facts { conflicting: Some(vec!["a.rs".into()]), ..ready() }),
            "It conflicts with main in a.rs. Resolve the conflicts and turn auto-merge on again."
        );
        // A conflict outweighs waiting on checks.
        assert!(matches!(
            step(&Facts { conflicting: Some(Vec::new()), gate_refusal: Some("x".into()), ..ready() }, "ana", "main"),
            Step::Disable(_)
        ));
    }

    fn stored(actor_id: &str) -> StoredAutoMerge {
        StoredAutoMerge {
            merge: AutoMerge {
                method: MergeMethod::Squash,
                commit_title: None,
                commit_message: None,
                enabled_by: "ana".into(),
                enabled_at: String::new(),
            },
            actor: User { id: actor_id.into(), username: "ana".into(), ..User::default() },
        }
    }

    #[test]
    fn a_push_by_anyone_else_turns_it_off() {
        let on = stored("usr_ana");
        assert!(!cleared_by_push(&on, Some("usr_ana")));
        assert!(cleared_by_push(&on, Some("usr_bo")));
        assert!(!cleared_by_push(&on, None), "g1t's own bookkeeping");
    }

    #[test]
    fn what_is_stored_reads_back_as_the_contract_shows_it() {
        let json = serde_json::to_string(&stored("usr_ana")).unwrap();
        let shown: AutoMerge = serde_json::from_str(&json).unwrap();
        assert_eq!((shown.method, shown.enabled_by.as_str()), (MergeMethod::Squash, "ana"));
        let back: StoredAutoMerge = serde_json::from_str(&json).unwrap();
        assert_eq!(back.actor.id, "usr_ana");
    }
}
