//! What g1t keeps and allows for a workspace, from wrangler vars, so an
//! installation of its own can change them:
//!
//! - `LOG_RETENTION_DAYS` (90): a finished job's log is deleted this many
//!   days after it finished (retention.rs). `0` keeps logs for good.
//! - `FREE_ACTIONS_STORAGE_BYTES` (2 GB): what a workspace without the
//!   plan may keep in artifacts and the cache together; past it, new
//!   uploads are refused (run_artifacts.rs, cache.rs). `0` is no cap.
//! - `FREE_SELF_HOSTED_JOBS` (4): jobs a workspace without the plan may
//!   have running on its self-hosted runners at once (plan.rs). `0` is no
//!   cap.

use worker::Env;

pub const DEFAULT_LOG_RETENTION_DAYS: u64 = 90;
pub const DEFAULT_FREE_ACTIONS_STORAGE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const DEFAULT_FREE_SELF_HOSTED_JOBS: u64 = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub log_retention_days: u64,
    pub free_actions_storage_bytes: u64,
    pub free_self_hosted_jobs: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            log_retention_days: DEFAULT_LOG_RETENTION_DAYS,
            free_actions_storage_bytes: DEFAULT_FREE_ACTIONS_STORAGE_BYTES,
            free_self_hosted_jobs: DEFAULT_FREE_SELF_HOSTED_JOBS,
        }
    }
}

/// A var as a whole number, or `default` when it is unset or not one.
pub fn number(raw: Option<String>, default: u64) -> u64 {
    raw.and_then(|raw| raw.trim().parse().ok()).unwrap_or(default)
}

impl Limits {
    pub fn from_env(env: &Env) -> Limits {
        let var = |name: &str| env.var(name).ok().map(|value| value.to_string());
        Limits {
            log_retention_days: number(var("LOG_RETENTION_DAYS"), DEFAULT_LOG_RETENTION_DAYS),
            free_actions_storage_bytes: number(var("FREE_ACTIONS_STORAGE_BYTES"), DEFAULT_FREE_ACTIONS_STORAGE_BYTES),
            free_self_hosted_jobs: number(var("FREE_SELF_HOSTED_JOBS"), DEFAULT_FREE_SELF_HOSTED_JOBS),
        }
    }
}

/// `2 GB`, `1.5 GB`, `500 MB`: a cap as people read it.
pub fn shown_bytes(bytes: u64) -> String {
    const GB: u64 = 1024 * 1024 * 1024;
    const MB: u64 = 1024 * 1024;
    if bytes >= GB {
        let tenths = (bytes * 10).div_ceil(GB);
        if tenths % 10 == 0 { format!("{} GB", tenths / 10) } else { format!("{}.{} GB", tenths / 10, tenths % 10) }
    } else {
        format!("{} MB", bytes.div_ceil(MB))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vars_fall_back_to_their_defaults() {
        assert_eq!(number(None, 90), 90);
        assert_eq!(number(Some(" 30 ".into()), 90), 30);
        assert_eq!(number(Some("0".into()), 90), 0);
        assert_eq!(number(Some("ninety".into()), 90), 90);
        assert_eq!(Limits::default().free_actions_storage_bytes, 2 * 1024 * 1024 * 1024);
    }

    #[test]
    fn caps_read_in_gigabytes_or_megabytes() {
        assert_eq!(shown_bytes(2 * 1024 * 1024 * 1024), "2 GB");
        assert_eq!(shown_bytes(1536 * 1024 * 1024), "1.5 GB");
        assert_eq!(shown_bytes(500 * 1024 * 1024), "500 MB");
    }
}

/// Whether a workspace without the plan may start one more job on its
/// self-hosted runners, with `running` going already. `cap` 0 is no cap.
pub fn self_hosted_room(running: u64, cap: u64) -> bool {
    cap == 0 || running < cap
}

impl crate::Actions {
    /// The workspace's standing with billing: its plan, and any hold staff
    /// put on it. None when billing does not answer: callers let things
    /// through rather than stop everyone's work on billing's account.
    pub(crate) async fn standing(&self, workspace: &str) -> Option<g1t_contracts::billing::Entitlements> {
        let args = g1t_contracts::billing::EntitlementsArgs { workspace: workspace.to_lowercase() };
        match g1t_kit::call(&self.billing, "entitlements", &args).await {
            Ok(entitlements) => Some(entitlements),
            Err(error) => {
                worker::console_error!("actions: billing's entitlements for {workspace} failed: {error}");
                None
            }
        }
    }
}

/// What a free workspace is told when an upload would take its artifacts
/// and cache past `cap`, holding `held` and adding `adding`. None while it
/// fits, or with no cap.
pub fn storage_refusal(held: u64, adding: u64, cap: u64) -> Option<String> {
    (cap > 0 && held.saturating_add(adding) > cap).then(|| {
        format!(
            "This workspace's artifacts and cache hold {} of the {} a workspace on the free plan keeps, so this upload is not kept. Delete artifacts you no longer need, let old cache entries expire, or start the g1t plan, which has no such cap.",
            shown_bytes(held),
            shown_bytes(cap)
        )
    })
}

impl crate::Actions {
    /// Why an upload of `adding` bytes to the workspace's artifacts or
    /// cache is refused: only past FREE_ACTIONS_STORAGE_BYTES, and only
    /// without the plan. Billing is asked only once the workspace is past
    /// the cap, and when it does not answer the upload goes ahead.
    pub(crate) async fn storage_refused(&self, namespace: &str, adding: u64) -> worker::Result<Option<String>> {
        let cap = self.limits.free_actions_storage_bytes;
        if cap == 0 {
            return Ok(None);
        }
        #[derive(serde::Deserialize)]
        struct Held {
            bytes: Option<f64>,
        }
        let held = self
            .db
            .prepare(
                "SELECT SUM(size) AS bytes FROM (
                   SELECT size FROM cache_entries WHERE namespace = ?1 AND status IN ('ready', 'pending')
                   UNION ALL SELECT size FROM artifacts WHERE namespace = ?1 AND status IN ('ready', 'pending')
                 )",
            )
            .bind(&[namespace.into()])?
            .first::<Held>(None)
            .await?
            .and_then(|held| held.bytes)
            .unwrap_or(0.0) as u64;
        let Some(why) = storage_refusal(held, adding, cap) else {
            return Ok(None);
        };
        Ok(match self.standing(namespace).await {
            Some(standing) if !standing.has_plan => Some(why),
            _ => None,
        })
    }
}

#[cfg(test)]
mod storage_tests {
    use super::storage_refusal;

    const GB: u64 = 1024 * 1024 * 1024;

    #[test]
    fn a_free_workspace_keeps_two_gigabytes_of_artifacts_and_cache() {
        assert_eq!(storage_refusal(GB, GB, 2 * GB), None);
        let refused = storage_refusal(2 * GB - 10, 100, 2 * GB).unwrap();
        assert!(refused.contains("of the 2 GB"), "{refused}");
        assert!(refused.contains("start the g1t plan"), "{refused}");
        assert_eq!(storage_refusal(100 * GB, GB, 0), None);
    }
}

#[cfg(test)]
mod room_tests {
    use super::self_hosted_room;

    #[test]
    fn free_workspaces_run_a_few_self_hosted_jobs_at_once() {
        assert!(self_hosted_room(0, 4));
        assert!(self_hosted_room(3, 4));
        assert!(!self_hosted_room(4, 4));
        assert!(self_hosted_room(400, 0));
    }
}
