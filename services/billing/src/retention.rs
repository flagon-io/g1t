//! How long each workspace's audit log is kept.
//!
//! A free workspace keeps `FREE_AUDIT_RETENTION_DAYS` (7); the g1t plan,
//! g1t's own workspaces and an enterprise's keep `AUDIT_RETENTION_DAYS`
//! (90). Staff can set an account's own number in sudo, such as for an
//! organization that pays for longer, up to `AUDIT_MAX_DAYS` (400). What
//! staff set wins over the plan's either way. The events service asks for
//! these once a day (`audit_retention`) and deletes what is older.

use futures_util::future::try_join_all;
use g1t_contracts::billing::{AuditRetention, AuditRetentionArgs, PlanKind};
use worker::Result;

use crate::Billing;
use crate::credits::Config;

/// Days of audit log a workspace keeps: what staff set for its account,
/// or else its plan's.
pub(crate) fn effective_days(plans: &Config, plan: PlanKind, custom: Option<u32>) -> u32 {
    custom.unwrap_or(match plan {
        PlanKind::Free => plans.free_audit_days,
        PlanKind::Paid | PlanKind::Internal | PlanKind::Enterprise => plans.audit_days,
    })
}

/// Why a number staff typed cannot be an account's retention, or None
/// when it can.
pub(crate) fn invalid_days(plans: &Config, days: Option<u32>) -> Option<String> {
    days.filter(|d| !(1..=plans.audit_max_days).contains(d))
        .map(|_| format!("Audit log days is between 1 and {}, or empty for the plan's.", plans.audit_max_days))
}

impl Billing {
    /// `audit_retention`: each workspace's days, its account and plan read
    /// once and all of them at the same time.
    pub(crate) async fn audit_retention(&self, a: AuditRetentionArgs) -> Result<Vec<AuditRetention>> {
        try_join_all(a.workspaces.iter().map(|workspace| async move {
            let workspace = workspace.to_lowercase();
            let account = self.account_of(&workspace).await?;
            let plan = self.plan_kind_for(&workspace, &account).await?;
            let days = effective_days(&self.plans, plan, account.allowances.audit_retention_days);
            Ok::<_, worker::Error>(AuditRetention { workspace, days })
        }))
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn free_keeps_a_week_and_the_plan_ninety_days() {
        let plans = Config::default();
        assert_eq!(effective_days(&plans, PlanKind::Free, None), 7);
        assert_eq!(effective_days(&plans, PlanKind::Paid, None), 90);
        assert_eq!(effective_days(&plans, PlanKind::Internal, None), 90);
        assert_eq!(effective_days(&plans, PlanKind::Enterprise, None), 90);
    }

    #[test]
    fn what_staff_set_wins_either_way() {
        let plans = Config::default();
        assert_eq!(effective_days(&plans, PlanKind::Free, Some(30)), 30);
        assert_eq!(effective_days(&plans, PlanKind::Paid, Some(365)), 365);
        assert_eq!(effective_days(&plans, PlanKind::Enterprise, Some(14)), 14);
    }

    #[test]
    fn staff_set_between_one_day_and_the_most() {
        let plans = Config::default();
        assert_eq!(invalid_days(&plans, None), None);
        assert_eq!(invalid_days(&plans, Some(1)), None);
        assert_eq!(invalid_days(&plans, Some(400)), None);
        assert_eq!(
            invalid_days(&plans, Some(0)).as_deref(),
            Some("Audit log days is between 1 and 400, or empty for the plan's.")
        );
        assert!(invalid_days(&plans, Some(401)).is_some());
    }
}
