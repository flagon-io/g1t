//! Allowances and the usage entry that consumes them commit together.
use crate::{Billing, credits::Eligible};
use worker::Result;

pub(crate) const PLAN: &str = "INSERT INTO allowance_use (kind, scope, month, used)
    SELECT 'plan_credit', workspace, ?2, credit_micros FROM ledger WHERE id=?1 AND credit_micros > 0
    ON CONFLICT(kind, scope, month) DO UPDATE SET used=used+excluded.used";
pub(crate) const TRIAL: &str = "UPDATE trial_grants SET used_micros=used_micros+
    (SELECT trial_micros FROM ledger WHERE id=?1) WHERE workspace=(SELECT workspace FROM ledger WHERE id=?1)";
pub(crate) const GIFT: &str = "INSERT INTO allowance_use (kind, scope, month, used)
    SELECT 'complimentary', workspace, ?2, gift_micros FROM ledger WHERE id=?1 AND gift_micros > 0
    ON CONFLICT(kind, scope, month) DO UPDATE SET used=used+excluded.used";
pub(crate) const OSS_POOL: &str = "INSERT INTO allowance_use (kind, scope, month, used)
    SELECT 'oss_pool', '', ?2, oss_micros FROM ledger WHERE id=?1 AND oss_micros > 0
    ON CONFLICT(kind, scope, month) DO UPDATE SET used=used+excluded.used";
pub(crate) const OSS_REPO: &str = "INSERT INTO allowance_use (kind, scope, month, used)
    SELECT 'oss_repo', ?3, ?2, oss_micros FROM ledger WHERE id=?1 AND oss_micros > 0
    ON CONFLICT(kind, scope, month) DO UPDATE SET used=used+excluded.used";

impl Billing {
    pub(crate) async fn posted_allocation(&self, reference: &str) -> Result<(i64, crate::credits::Drawn)> {
        #[derive(serde::Deserialize)]
        struct Row {
            amount_micros: i64,
            credit_micros: i64,
            gift_micros: i64,
            trial_micros: i64,
            oss_micros: i64,
            given_micros: i64,
        }
        let row = self
            .db
            .prepare(
                "SELECT amount_micros, credit_micros, gift_micros, trial_micros, oss_micros, given_micros FROM ledger WHERE reference = ?",
            )
            .bind(&[reference.into()])?
            .first::<Row>(None)
            .await?
            .ok_or_else(|| worker::Error::RustError("Posted usage is missing".into()))?;
        Ok((
            -row.amount_micros,
            crate::credits::Drawn {
                credit: row.credit_micros,
                gift: row.gift_micros,
                trial: row.trial_micros,
                oss: row.oss_micros,
                given: row.given_micros,
            },
        ))
    }

    pub(crate) async fn allocation_statements(
        &self,
        id: &str,
        workspace: &str,
        month: &str,
        eligible: &Eligible,
        plan: bool,
    ) -> Result<Vec<worker::D1PreparedStatement>> {
        let repo = eligible.repo.as_deref().unwrap_or("").to_lowercase();
        let public = !repo.is_empty() && self.is_public(&repo).await;
        let repo_cap = if public { self.oss_repo_cap(workspace).await? } else { 0 };
        Ok(vec![
            self.db.prepare(include_str!("allocate_usage.sql")).bind(&[
                id.into(),
                workspace.into(),
                month.into(),
                (if plan { self.plans.plan_included_micros } else { 0 } as f64).into(),
                i32::from(eligible.trial).into(),
                repo.as_str().into(),
                (if public { self.plans.oss_pool_micros } else { 0 } as f64).into(),
                (repo_cap as f64).into(),
                i32::from(eligible.cover_rest && !plan).into(),
            ])?,
            self.db.prepare(PLAN).bind(&[id.into(), month.into()])?,
            self.db.prepare(GIFT).bind(&[id.into(), month.into()])?,
            self.db.prepare(TRIAL).bind(&[id.into()])?,
            self.db.prepare(OSS_POOL).bind(&[id.into(), month.into()])?,
            self.db.prepare(OSS_REPO).bind(&[id.into(), month.into(), repo.into()])?,
        ])
    }
}
