//! Decision records: why the work is the way it is, and how sure that is.
//!
//! g1t keeps the ones it saw proved itself: what the merge queue found when
//! it combined pull requests (`tested`), a person's approval (`approved`)
//! and merges. `record_decision` keeps an agent's or a person's own
//! reasons, as `claimed`. Each is published as `decision.recorded`.

use g1t_contracts::access::Capability;
use g1t_contracts::decisions::{Decision, DecisionConfidence, DecisionKind, DecisionRecorded, ListDecisionsArgs, RecordDecisionArgs};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, User, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use serde_json::{Value, json};
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::{Work, items};

/// The longest summary kept.
pub(crate) const MAX_SUMMARY_CHARS: usize = 2000;
/// The most evidence kept, as JSON.
pub(crate) const MAX_EVIDENCE_BYTES: usize = 8 * 1024;
/// The most decisions one list returns.
const LIST_LIMIT: u32 = 200;

/// A decision about to be kept.
pub(crate) struct NewDecision<'a> {
    /// The work item it is about, by id.
    pub(crate) item: Option<String>,
    pub(crate) pull: Option<u32>,
    pub(crate) session_id: Option<String>,
    /// Who recorded it; `None` for g1t itself.
    pub(crate) actor: Option<&'a User>,
    pub(crate) kind: DecisionKind,
    pub(crate) confidence: DecisionConfidence,
    pub(crate) summary: String,
    pub(crate) evidence: Value,
}

/// A decision's columns, with its work item's number.
const DECISION_COLUMNS: &str = concat!("decisions.*, ", items::sql::item_number!("decisions.item_id"), " AS item");

#[derive(Deserialize)]
struct DecisionRow {
    id: String,
    #[serde(default)]
    repo_id: String,
    #[serde(default)]
    item: Option<u32>,
    pull: Option<u32>,
    session_id: Option<String>,
    actor_name: Option<String>,
    kind: String,
    confidence: String,
    summary: String,
    evidence: String,
    created_at: String,
}

impl DecisionRow {
    fn decision(self) -> Option<Decision> {
        Some(Decision {
            kind: DecisionKind::parse(&self.kind)?,
            confidence: serde_json::from_value(Value::String(self.confidence)).ok()?,
            evidence: serde_json::from_str(&self.evidence).unwrap_or_else(|_| json!({})),
            id: self.id,
            item: self.item,
            pull: self.pull,
            session_id: self.session_id,
            actor: self.actor_name,
            summary: self.summary,
            created_at: self.created_at,
        })
    }
}

/// What `record_decision` keeps of what it was given: the summary, trimmed,
/// and the evidence as an object. Says what is wrong otherwise.
pub(crate) fn checked(
    kind: DecisionKind,
    summary: &str,
    evidence: Option<&Value>,
    session_id: Option<&str>,
) -> std::result::Result<(String, Value), &'static str> {
    if !DecisionKind::RECORDABLE.contains(&kind) {
        return Err("kind must be proposal, claim, fix or note. g1t records integration results, approvals and merges itself.");
    }
    let summary = summary.trim();
    if summary.is_empty() {
        return Err("Give a summary: the decision, in a sentence or two.");
    }
    if summary.chars().count() > MAX_SUMMARY_CHARS {
        return Err("The summary is too long: 2,000 characters at most.");
    }
    let evidence = match evidence {
        None | Some(Value::Null) => json!({}),
        Some(object @ Value::Object(_)) => object.clone(),
        Some(_) => return Err("evidence must be an object, such as {\"commit\": \"…\"}."),
    };
    if evidence.to_string().len() > MAX_EVIDENCE_BYTES {
        return Err("The evidence is too large: 8 KB of JSON at most.");
    }
    if session_id.is_some_and(|id| id.len() > 100) {
        return Err("session_id is not a session's id.");
    }
    Ok((summary.to_owned(), evidence))
}

/// Whether g1t itself acted: as itself, or by a repository's settings
/// (an older id it kept for those).
pub(crate) fn is_g1t(actor: &User) -> bool {
    actor.is_system() || g1t_contracts::system::is_system_id(&actor.id)
}

/// How sure a merge is: tested when the queue or the repository's own
/// rules landed it once its checks passed, approved when a person merged
/// it, claimed when an agent's token did.
pub(crate) fn merge_confidence(through_queue: bool, actor: &User) -> DecisionConfidence {
    if through_queue || is_g1t(actor) {
        DecisionConfidence::Tested
    } else if g1t_contracts::rules::is_agent(actor) {
        DecisionConfidence::Claimed
    } else {
        DecisionConfidence::Approved
    }
}

/// How sure an approval is: a person's is approved, an agent's only
/// claimed.
pub(crate) fn approval_confidence(actor: &User) -> DecisionConfidence {
    if g1t_contracts::rules::is_agent(actor) { DecisionConfidence::Claimed } else { DecisionConfidence::Approved }
}

impl Work {
    /// Keeps a decision and publishes `decision.recorded`.
    pub(crate) async fn keep_decision(&self, repo_id: &str, new: NewDecision<'_>) -> Result<Decision> {
        let now = now_ms();
        let item = match &new.item {
            Some(id) => items::by_id(self, id).await?.map(|held| held.item.number),
            None => None,
        };
        let decision = Decision {
            id: new_id("dec", now),
            item,
            pull: new.pull,
            session_id: new.session_id,
            actor: new.actor.map(|actor| actor.username.clone()),
            kind: new.kind,
            confidence: new.confidence,
            summary: new.summary,
            evidence: new.evidence,
            created_at: rfc3339(now),
        };
        let number = |value: Option<u32>| value.map_or(JsValue::NULL, JsValue::from);
        let event = serde_json::to_value(DecisionRecorded {
            repo_id: repo_id.to_owned(),
            number: decision.pull.or(decision.item).unwrap_or_default(),
            item: decision.item,
            decision: decision.clone(),
        })?;
        let mut statements = vec![
            self.db
                .prepare(
                    "INSERT INTO decisions
                   (id, repo_id, item_id, pull, session_id, actor, actor_name, kind, confidence,
                    summary, evidence, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                )
                .bind(&[
                    decision.id.as_str().into(),
                    repo_id.into(),
                    crate::optional(&new.item),
                    number(decision.pull),
                    decision.session_id.as_deref().map_or(JsValue::NULL, JsValue::from),
                    new.actor.map_or(JsValue::NULL, |actor| actor.id.as_str().into()),
                    decision.actor.as_deref().map_or(JsValue::NULL, JsValue::from),
                    decision.kind.as_str().into(),
                    decision.confidence.as_str().into(),
                    decision.summary.as_str().into(),
                    decision.evidence.to_string().into(),
                    decision.created_at.as_str().into(),
                ])?,
        ];
        // Kept and delivered to the sessions it concerns in one change.
        let sent = crate::coordination::updates::push_delivery(
            &mut statements,
            self.delivery("decision.recorded", repo_id, event.clone(), &decision.id, "1", Vec::new())?,
        );
        self.db.batch(statements).await?;
        self.delivered(sent, "decision.recorded", repo_id, new.actor.map(|actor| actor.id.clone()), event).await?;
        Ok(decision)
    }

    /// Keeps a decision without failing what it records: a decision that
    /// could not be kept only logs.
    pub(crate) async fn keep_decision_quietly(&self, repo_id: &str, new: NewDecision<'_>) {
        if let Err(error) = self.keep_decision(repo_id, new).await {
            worker::console_warn!("decision not kept: {error}");
        }
    }

    /// `record_decision`: an agent's or a person's reason on a pull
    /// request, kept as claimed.
    pub(crate) async fn record_decision(&self, a: RecordDecisionArgs) -> Result<Outcome<Decision>> {
        let (summary, evidence) = match checked(a.kind, &a.summary, a.evidence.as_ref(), a.session_id.as_deref()) {
            Ok(checked) => checked,
            Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
        };
        let viewer = Some(a.actor.clone());
        let (repo, pull) = match self.pull_at(&a.repo, a.number, &viewer).await? {
            Outcome::Ok(found) => found,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if let Outcome::Fail(failure) = crate::retired::writable(&repo) {
            return Ok(Outcome::Fail(failure));
        }
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, crate::UNVERIFIED));
        }
        if !pull.is_owned_by(&a.actor.id)
            && let Outcome::Fail(failure) = crate::allowed(Some(&a.actor), &repo, Capability::Participate)
        {
            return Ok(Outcome::Fail(failure));
        }
        let decision = self
            .keep_decision(
                &repo.id,
                NewDecision {
                    item: self.pull_item_id(&pull.id).await?,
                    pull: Some(pull.number),
                    session_id: a.session_id,
                    actor: Some(&a.actor),
                    kind: a.kind,
                    confidence: DecisionConfidence::Claimed,
                    summary,
                    evidence,
                },
            )
            .await?;
        Ok(Outcome::Ok(decision))
    }

    /// `list_decisions`: a work item's, with those on its pull requests in
    /// the repositories the viewer may read, or a pull request's, oldest
    /// first.
    pub(crate) async fn list_decisions(&self, a: ListDecisionsArgs) -> Result<Outcome<Vec<Decision>>> {
        let rows = match &a.repo {
            Some(path) => {
                let (repo, pull) = match self.pull_at(path, a.number, &a.viewer).await? {
                    Outcome::Ok(found) => found,
                    Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
                };
                self.db
                    .prepare(format!(
                        "SELECT {DECISION_COLUMNS} FROM decisions WHERE repo_id = ?1 AND pull = ?2
                         ORDER BY created_at, id LIMIT ?3"
                    ))
                    .bind(&[repo.id.as_str().into(), pull.number.into(), LIST_LIMIT.into()])?
                    .all()
                    .await?
                    .results::<DecisionRow>()?
            }
            None => {
                let held = match items::for_viewer(self, &a.viewer, &a.workspace, a.number, Capability::Read).await? {
                    Outcome::Ok(held) => held,
                    Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
                };
                let rows = self
                    .db
                    .prepare(format!(
                        "SELECT {DECISION_COLUMNS} FROM decisions
                         WHERE item_id = ?1 OR EXISTS (SELECT 1 FROM pulls p
                           WHERE p.item_id = ?1 AND p.repo_id = decisions.repo_id AND p.number = decisions.pull)
                         ORDER BY created_at, id LIMIT ?2"
                    ))
                    .bind(&[held.item.id.as_str().into(), LIST_LIMIT.into()])?
                    .all()
                    .await?
                    .results::<DecisionRow>()?;
                // Those kept in a repository the viewer cannot read stay there.
                let mut ids: Vec<String> = rows.iter().map(|row| row.repo_id.clone()).collect();
                ids.sort();
                ids.dedup();
                let readable: Vec<g1t_contracts::repos::Repo> =
                    g1t_kit::call(&self.repos, "readable", &g1t_contracts::repos::ReadableArgs { ids, viewer: a.viewer.clone() }).await?;
                rows.into_iter().filter(|row| readable.iter().any(|repo| repo.id == row.repo_id)).collect()
            }
        };
        Ok(Outcome::Ok(rows.into_iter().filter_map(DecisionRow::decision).collect()))
    }

    /// Whether a pull request landed through the merge queue.
    pub(crate) async fn landed_through_queue(&self, pull_id: &str) -> Result<bool> {
        Ok(self
            .db
            .prepare("SELECT 1 AS value FROM queue_entries WHERE pull_id = ? AND state = 'landed' LIMIT 1")
            .bind(&[pull_id.into()])?
            .first::<u32>(Some("value"))
            .await?
            .is_some())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_claims_are_recorded_by_hand() {
        assert!(checked(DecisionKind::Proposal, "Use a trie.", None, None).is_ok());
        assert!(checked(DecisionKind::Fix, "Rebased on #12.", None, None).is_ok());
        for kind in [DecisionKind::IntegrationFailure, DecisionKind::IntegrationPassed, DecisionKind::Approval, DecisionKind::Merge] {
            assert!(checked(kind, "x", None, None).is_err(), "{kind:?}");
        }
    }

    #[test]
    fn a_summary_and_object_evidence_are_required() {
        assert!(checked(DecisionKind::Note, "   ", None, None).is_err());
        let long = "x".repeat(MAX_SUMMARY_CHARS + 1);
        assert!(checked(DecisionKind::Note, &long, None, None).is_err());
        assert!(checked(DecisionKind::Note, "ok", Some(&json!([1])), None).is_err());
        let big = json!({ "log": "x".repeat(MAX_EVIDENCE_BYTES) });
        assert!(checked(DecisionKind::Note, "ok", Some(&big), None).is_err());
        let (summary, evidence) =
            checked(DecisionKind::Claim, "  Fixes the race. ", Some(&json!({ "commit": "abc" })), Some("ses_1")).unwrap();
        assert_eq!(summary, "Fixes the race.");
        assert_eq!(evidence["commit"], "abc");
        assert_eq!(checked(DecisionKind::Claim, "x", Some(&Value::Null), None).unwrap().1, json!({}));
    }

    #[test]
    fn merges_and_approvals_are_as_sure_as_who_made_them() {
        let person = User { id: "usr_1".into(), username: "ana".into(), ..User::default() };
        assert_eq!(merge_confidence(false, &person), DecisionConfidence::Approved);
        assert_eq!(merge_confidence(true, &person), DecisionConfidence::Tested);
        assert_eq!(merge_confidence(false, &User::system("acme")), DecisionConfidence::Tested);
        // A merge a repository's auto-merge made, under the id kept for it.
        let policy = User { id: "g1t_policy".into(), username: "g1t".into(), ..User::default() };
        assert_eq!(merge_confidence(false, &policy), DecisionConfidence::Tested);
        assert_eq!(approval_confidence(&person), DecisionConfidence::Approved);
        let agent = User { kind: g1t_contracts::PrincipalKind::Agent, ..person.clone() };
        if g1t_contracts::rules::is_agent(&agent) {
            assert_eq!(approval_confidence(&agent), DecisionConfidence::Claimed);
            assert_eq!(merge_confidence(false, &agent), DecisionConfidence::Claimed);
        }
    }
}
