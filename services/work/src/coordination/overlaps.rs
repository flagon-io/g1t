//! Announcing pull requests that start changing the same files.
//!
//! Each push works out what a pull request changes (reviews.rs) and so
//! which other open or draft pull requests it overlaps. A pair is announced
//! as `overlap.detected` the first time it overlaps, once for each side so
//! that whoever follows either hears of it, and remembered in
//! `overlap_pairs`; it is announced again only after a push shows it
//! stopped overlapping and it was forgotten.

use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::Work;

#[derive(Deserialize)]
struct PairRow {
    low: u32,
    high: u32,
}

/// A pair, lower number first.
fn pair(a: u32, b: u32) -> (u32, u32) {
    (a.min(b), a.max(b))
}

impl Work {
    /// Announces the overlaps `pull` (with its files just worked out) has
    /// that were not announced before, and forgets the ones it no longer
    /// has. Never fails the push it follows: a problem is logged.
    pub(crate) async fn announce_overlaps(&self, pull: &Pull, actor: Option<String>) {
        if let Err(error) = self.announce_overlaps_or_fail(pull, actor).await {
            worker::console_error!("#{} overlaps were not announced: {error}", pull.number);
        }
    }

    async fn announce_overlaps_or_fail(&self, pull: &Pull, actor: Option<String>) -> Result<()> {
        if !pull.status.is_active() {
            return Ok(());
        }
        let overlaps = self.overlaps(pull).await?;
        let announced: Vec<u32> = self
            .db
            .prepare("SELECT low, high FROM overlap_pairs WHERE repo_id = ?1 AND (low = ?2 OR high = ?2)")
            .bind(&[pull.repo_id.as_str().into(), pull.number.into()])?
            .all()
            .await?
            .results::<PairRow>()?
            .into_iter()
            .map(|row| if row.low == pull.number { row.high } else { row.low })
            .collect();
        let current: Vec<u32> = overlaps.iter().map(|overlap| overlap.number).collect();
        let (new, cleared) = overlap_changes(&current, &announced);
        if new.is_empty() && cleared.is_empty() {
            return Ok(());
        }
        let at = rfc3339(now_ms());
        let mut statements = Vec::new();
        for other in &cleared {
            let (low, high) = pair(pull.number, *other);
            statements.push(
                self.db
                    .prepare("DELETE FROM overlap_pairs WHERE repo_id = ? AND low = ? AND high = ?")
                    .bind(&[pull.repo_id.as_str().into(), low.into(), high.into()])?,
            );
        }
        let first_new = statements.len();
        for other in &new {
            let (low, high) = pair(pull.number, *other);
            let files = overlaps.iter().find(|overlap| overlap.number == *other).map(|overlap| overlap.paths.clone()).unwrap_or_default();
            statements.push(
                self.db
                    .prepare(
                        "INSERT INTO overlap_pairs (repo_id, low, high, files, noticed_at) VALUES (?, ?, ?, ?, ?)
                         ON CONFLICT (repo_id, low, high) DO NOTHING RETURNING low",
                    )
                    .bind(&[
                        pull.repo_id.as_str().into(),
                        low.into(),
                        high.into(),
                        serde_json::to_string(&files)?.into(),
                        at.as_str().into(),
                    ])?,
            );
        }
        let results = self.db.batch(statements).await?;
        for (result, other) in results.into_iter().skip(first_new).zip(&new) {
            // Announced by the other side's push at the same moment.
            if result.results::<PairRow>()?.is_empty() {
                continue;
            }
            let Some(overlap) = overlaps.iter().find(|overlap| overlap.number == *other) else {
                continue;
            };
            let ours = OverlapDetected {
                repo_id: pull.repo_id.clone(),
                number: pull.number,
                pull: pull.number,
                other_pull: overlap.number,
                files: overlap.paths.clone(),
                issue: pull.issue,
                other_issue: overlap.issue,
            };
            let theirs = OverlapDetected {
                number: overlap.number,
                pull: overlap.number,
                other_pull: pull.number,
                issue: overlap.issue,
                other_issue: pull.issue,
                ..ours.clone()
            };
            self.publish_as("overlap.detected", &pull.repo_id, actor.clone(), ours).await?;
            self.publish_as("overlap.detected", &pull.repo_id, actor.clone(), theirs).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pair_is_the_same_from_either_side() {
        assert_eq!(pair(9, 4), (4, 9));
        assert_eq!(pair(4, 9), (4, 9));
    }
}
