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
