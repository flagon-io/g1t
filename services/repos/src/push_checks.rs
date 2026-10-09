//! A push, checked before the store sees it: the workflow-file gate
//! (workflow_gate.rs), the rules of the branches and tags it changes
//! (rules.rs) and push protection (secret_scan.rs).
//!
//! The pack is read once, the bases of a thin pack are fetched once, and one
//! handle to the store serves every check. What the checks ask of other
//! services (the rulesets, the custom secret patterns, the pusher's email
//! guard) is asked while the pack is read, and the rules and the scan then
//! run side by side. Their answers are taken in the order they always were:
//! the workflow gate, then the rules, then push protection (after the size
//! limits, which git_http.rs checks between them), so a push refused for
//! several reasons hears the same one. What a check records (the rules'
//! judgements, the secrets found) is recorded only when no earlier check
//! refused the push, as before.

use futures_util::future::{join, join3};
use g1t_contracts::User;
use g1t_contracts::repos::Repo;
use g1t_scan::pack::{Pack, pack_start};
use g1t_scan::protection;
use worker::{Response, Result};

use crate::Repos;
use crate::registry::store_key;
use crate::rules::PushRules;
use crate::secret_scan::{self, MAX_SCANNED_PUSH};
use crate::store::GitStore;

/// What the checks said about a push.
pub enum Verdict {
    /// Nothing refuses it.
    Clear,
    /// The workflow gate or the rules refuse it.
    Refused(Response),
    /// Push protection refuses it: a secret, or the pusher's private address.
    Blocked(Response),
}

/// The checks' verdict, and how long each part took (for `Server-Timing`):
/// the parts overlap, so they are told apart from the steps.
pub struct Checks {
    pub verdict: Verdict,
    pub spans: Vec<(&'static str, u64)>,
}

impl Checks {
    pub fn clear() -> Checks {
        Checks { verdict: Verdict::Clear, spans: Vec::new() }
    }
}

/// The pack a whole push carries: empty for one that only deletes refs or
/// moves them to commits the repository has, or why it could not be read.
pub(crate) fn read_pack(body: &[u8]) -> std::result::Result<Pack, String> {
    match pack_start(body) {
        Some(start) => Pack::parse(&body[start..]),
        None => Ok(Pack::default()),
    }
}

/// `work`, with how long it took.
async fn timed<T>(work: impl std::future::Future<Output = T>) -> (T, u64) {
    let started = g1t_kit::now_ms();
    let output = work.await;
    (output, g1t_kit::now_ms().saturating_sub(started))
}

impl<S: GitStore> Repos<S> {
    /// Checks a push to `repo` by `pusher`. `body` is as much of it as was
    /// read, `whole` whether that is all of it. Push protection runs only
    /// when `scan` says to: a push the size limits decline is not scanned.
    pub(crate) async fn check_receive(&self, repo: &Repo, pusher: Option<&User>, body: &[u8], whole: bool, scan: bool) -> Result<Checks> {
        let git = self.store.open(&store_key(repo)).await?;
        let token = crate::workflow_gate::gated(pusher);

        // First, at once: what the rules and push protection need from
        // other services, and the pack with its bases. The questions go
        // out before the pack is read, so they are answered while it is.
        let rules = timed(self.push_rules(repo, pusher, body));
        let protection = timed(async {
            if !scan {
                return Ok(None);
            }
            // A pull request's findings belong to the repository it was made from.
            let owner = match &repo.fork_of {
                Some(id) => self.registry.by_id(id).await?.unwrap_or(repo.clone()),
                None => repo.clone(),
            };
            let (patterns, guard) = join(self.patterns_for(&owner), self.push_email_guard(pusher)).await;
            Ok::<_, worker::Error>(Some((owner, secret_scan::compiled(&patterns), guard)))
        });
        let read = timed(async {
            if !whole {
                return Ok(None);
            }
            let mut pack = read_pack(body);
            if let Ok(pack) = &mut pack {
                secret_scan::supply_bases(pack, &git).await?;
            }
            Ok::<_, worker::Error>(Some(pack))
        });
        let ((rules, rules_ms), (protection, protection_ms), (read, read_ms)) = join3(rules, protection, read).await;
        let read = read?;
        let pack = read.as_ref().and_then(|read| match read {
            Ok(pack) => Some(pack),
            Err(problem) => {
                worker::console_error!("a push's pack could not be read: {problem}");
                None
            }
        });

        // Then the checks themselves, side by side.
        let gate = timed(async {
            match token {
                Some(token) => crate::workflow_gate::judge_pack(token, body, read.as_ref(), &git).await,
                None => Ok(None),
            }
        });
        let judged = timed(async {
            match rules {
                PushRules::Judge { rules, updates } => {
                    let judged = self.judge_push(repo, pusher, body, &rules, updates, pack, &git).await?;
                    Ok::<_, worker::Error>(PushRules::Judged(judged))
                }
                other => Ok(other),
            }
        });
        let scanned = timed(async {
            match (&protection, &read) {
                (Ok(Some((_, patterns, _))), Some(read)) => Some(secret_scan::scan_pack(&git, body.len(), read, patterns).await),
                _ => None,
            }
        });
        let ((gate, gate_ms), (judged, judge_ms), (scanned, scan_ms)) = join3(gate, judged, scanned).await;
        let mut spans = vec![("read", read_ms), ("rules", rules_ms + judge_ms), ("scan", protection_ms + scan_ms)];
        if token.is_some() {
            spans.push(("gate", gate_ms));
        }
        let checks = |verdict| Ok(Checks { verdict, spans: spans.clone() });

        // The answers, in order. Workflow files first.
        if let Some((reason, lines)) = gate? {
            return checks(Verdict::Refused(crate::git_http::declined(body, reason, &lines)?));
        }
        // The rules: what they refuse is refused whatever else is wrong with it.
        match judged? {
            PushRules::Nothing => {}
            PushRules::Answered(answered) => {
                if let Some(response) = answered? {
                    return checks(Verdict::Refused(response));
                }
            }
            PushRules::Judged(mut judged) => {
                self.record_push_judged(repo, &judged).await;
                if let Some(response) = judged.refusal.take() {
                    return checks(Verdict::Refused(response));
                }
            }
            // Judged above.
            PushRules::Judge { .. } => {}
        }
        // Push protection.
        let Some((owner, _, guard)) = protection? else {
            return checks(Verdict::Clear);
        };
        if let Some(guard) = guard
            && body.len() <= MAX_SCANNED_PUSH
            && let Some((commit, email)) = pack.and_then(|pack| secret_scan::exposed_in(pack, &guard))
        {
            return checks(Verdict::Blocked(crate::git_http::declined(
                body,
                "push would publish a private email",
                &secret_scan::exposed_message(&commit, &email, &guard.noreply),
            )?));
        }
        let found = match scanned {
            Some(Err(error)) if secret_scan::unscannable(&error) => {
                let (reason, messages) = crate::git_http::size_refusal(&crate::git_http::SizeViolation::Unscannable {
                    size: body.len() as u64,
                    cap: MAX_SCANNED_PUSH,
                });
                return checks(Verdict::Blocked(crate::git_http::declined(body, &reason, &messages)?));
            }
            Some(found) => found?,
            None => Vec::new(),
        };
        if found.is_empty() {
            return checks(Verdict::Clear);
        }
        let blocked = self.blocked(&owner, pusher, found).await;
        if blocked.is_empty() {
            return checks(Verdict::Clear);
        }
        checks(Verdict::Blocked(crate::git_http::declined(
            body,
            &protection::reason(&blocked),
            &protection::explain(&blocked),
        )?))
    }
}

#[cfg(test)]
mod tests {
    use super::read_pack;
    use g1t_scan::pack::{ObjectKind, write_pack};

    #[test]
    fn a_push_is_read_once_for_every_check() {
        let blob = b"hello
".to_vec();
        let command = b"0000000000000000000000000000000000000000 4807077b296e6edbf410d55e72749d3e1170c291 refs/heads/main report-status
";
        let mut body = format!("{:04x}", command.len() + 4).into_bytes();
        body.extend_from_slice(command);
        body.extend_from_slice(b"0000");
        body.extend(write_pack(&[(ObjectKind::Blob, blob.clone())]));
        let pack = read_pack(&body).unwrap();
        assert!(pack.blob(&g1t_scan::pack::object_id(ObjectKind::Blob, &blob)).is_some());
        // Only deletions, or refs moved to commits the store has: no pack,
        // read as an empty one, which adds nothing.
        let pack = read_pack(b"0000").unwrap();
        assert!(pack.commits().is_empty() && pack.missing_bases().is_empty());
        // A pack that cannot be read says why, for each check to decide.
        assert!(read_pack(b"0000PACK      ").is_err());
    }
}
