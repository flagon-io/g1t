//! How each git store namespace stands: what it holds, how busy and how
//! healthy it has been, and its limits (docs/ARTIFACTS.md, R7).
//!
//! Placing a new repository reads this when there is more than one
//! namespace to choose from (shards.rs `Placement::choose`), kept a minute
//! per isolate; `namespaces` answers it for operators
//! (`scripts/ops/artifacts-namespaces.mjs` reads the same tables itself).

use std::cell::RefCell;
use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use worker::{D1Database, Result};

use crate::shards::{self, Load};

/// How long loads read for placing are kept in an isolate.
const LOADS_TTL_MS: u64 = 60_000;
/// The minutes a namespace's recent health is judged over.
const FAILING_MINUTES: u64 = 5;
/// The minutes its busiest minute is looked for in.
const PEAK_MINUTES: u64 = 60;
/// A namespace is failing when this share of at least `FAILING_CALLS` of
/// its recent calls failed, as the status page judges it.
const FAILING_SHARE: f64 = 0.25;
const FAILING_CALLS: f64 = 5.0;

/// What one namespace holds, from the registry.
#[derive(Debug, Default, Deserialize, Clone, PartialEq)]
pub struct Held {
    /// The namespace, `''` for the default.
    pub ns: String,
    pub repos: f64,
    pub forks: f64,
    pub stored_bytes: f64,
}

/// How one namespace answered lately, from `store_health`.
#[derive(Debug, Default, Deserialize, Clone, PartialEq)]
pub struct Recent {
    pub store: String,
    pub peak: f64,
    pub calls: f64,
    pub errors: f64,
    pub rate_limited: f64,
    pub rejected: f64,
    /// Over the last `FAILING_MINUTES` only.
    pub recent_calls: f64,
    pub recent_errors: f64,
    pub recent_rejected: f64,
}

impl Recent {
    /// Whether its recent calls say it is failing.
    pub fn failing(&self) -> bool {
        self.recent_rejected > 0.0 || (self.recent_calls >= FAILING_CALLS && self.recent_errors / self.recent_calls >= FAILING_SHARE)
    }
}

/// One namespace, as `namespaces` answers.
#[derive(Debug, Default, Serialize, Clone, PartialEq)]
pub struct Standing {
    pub namespace: String,
    /// The namespace bound to `ARTIFACTS`, where keys without one live.
    pub default: bool,
    /// `ARTIFACTS_EU_NAMESPACE`: where EU workspaces' repositories go.
    pub eu: bool,
    /// Named in `ARTIFACTS_NEW_REPOS`.
    pub takes_new_repos: bool,
    /// Served from the fallback store now (fallback.rs).
    pub on_fallback: bool,
    pub writable: bool,
    pub repos: u64,
    pub forks: u64,
    pub stored_bytes: u64,
    pub max_repos: Option<u64>,
    /// Its busiest minute of calls in the last hour, against Cloudflare's
    /// limit for a namespace.
    pub peak_per_minute: u64,
    pub limit_per_minute: u64,
    /// The busiest minute as a share of the limit, 0 to 1 and past it.
    pub peak_share: f64,
    pub calls_last_hour: u64,
    pub errors_last_hour: u64,
    pub rate_limited_last_hour: u64,
    pub failing: bool,
}

impl Standing {
    pub fn load(&self) -> Load {
        Load {
            namespace: self.namespace.clone(),
            bound: true,
            writable: self.writable,
            repos: self.repos,
            peak_per_minute: self.peak_per_minute,
            failing: self.failing,
            max_repos: self.max_repos,
        }
    }
}

/// What a namespace is configured as, beside what it holds.
pub struct Configured<'a> {
    pub bound: &'a [String],
    pub default: &'a str,
    pub placement: &'a shards::Placement,
    pub limits: &'a HashMap<String, u64>,
    pub on_fallback: &'a dyn Fn(&str) -> bool,
    pub writable: &'a dyn Fn(&str) -> bool,
    /// Whether this isolate's breaker for it is open now.
    pub breaker_open: &'a dyn Fn(&str) -> bool,
}

/// Every bound namespace's standing, from what the tables say.
pub fn standings(config: &Configured<'_>, held: &[Held], recent: &[Recent]) -> Vec<Standing> {
    config
        .bound
        .iter()
        .map(|namespace| {
            let holds = held
                .iter()
                .filter(|row| (if row.ns.is_empty() { config.default } else { row.ns.as_str() }) == namespace)
                .fold(Held::default(), |sum, row| Held {
                    ns: String::new(),
                    repos: sum.repos + row.repos,
                    forks: sum.forks + row.forks,
                    stored_bytes: sum.stored_bytes + row.stored_bytes,
                });
            let health = recent.iter().find(|row| row.store == *namespace).cloned().unwrap_or_default();
            let peak = health.peak.max(0.0) as u64;
            Standing {
                namespace: namespace.clone(),
                default: namespace == config.default,
                eu: config.placement.eu.as_deref() == Some(namespace.as_str()),
                takes_new_repos: config.placement.new_repos.contains(namespace),
                on_fallback: (config.on_fallback)(namespace),
                writable: (config.writable)(namespace),
                repos: holds.repos.max(0.0) as u64,
                forks: holds.forks.max(0.0) as u64,
                stored_bytes: holds.stored_bytes.max(0.0) as u64,
                max_repos: config.limits.get(namespace).copied(),
                peak_per_minute: peak,
                limit_per_minute: shards::CONTROL_PLANE_PER_MINUTE,
                peak_share: peak as f64 / shards::CONTROL_PLANE_PER_MINUTE as f64,
                calls_last_hour: health.calls.max(0.0) as u64,
                errors_last_hour: health.errors.max(0.0) as u64,
                rate_limited_last_hour: health.rate_limited.max(0.0) as u64,
                failing: health.failing() || (config.breaker_open)(namespace),
            }
        })
        .collect()
}

/// What the registry holds, by namespace.
pub async fn held(db: &D1Database) -> Result<Vec<Held>> {
    db.prepare(
        "SELECT CASE WHEN instr(coalesce(store, ''), '/') > 0 THEN substr(store, 1, instr(store, '/') - 1) ELSE '' END AS ns,
                count(*) AS repos,
                sum(CASE WHEN fork_of IS NULL THEN 0 ELSE 1 END) AS forks,
                sum(coalesce(stored_bytes, 0)) AS stored_bytes
         FROM repos WHERE deleted_at IS NULL AND retired_at IS NULL
         GROUP BY ns",
    )
    .all()
    .await?
    .results::<Held>()
}

/// How each namespace answered over the last hour, and the last minutes.
pub async fn recent(db: &D1Database, now: u64) -> Result<Vec<Recent>> {
    let minute = |ago: u64| g1t_contracts::time::rfc3339(now.saturating_sub(ago * 60_000))[..16].to_owned();
    db.prepare(
        "SELECT store, max(calls) AS peak, sum(calls) AS calls, sum(errors) AS errors,
                sum(rate_limited) AS rate_limited, sum(rejected) AS rejected,
                sum(CASE WHEN minute >= ?2 THEN calls ELSE 0 END) AS recent_calls,
                sum(CASE WHEN minute >= ?2 THEN errors ELSE 0 END) AS recent_errors,
                sum(CASE WHEN minute >= ?2 THEN rejected ELSE 0 END) AS recent_rejected
         FROM store_health WHERE minute >= ?1 GROUP BY store",
    )
    .bind(&[minute(PEAK_MINUTES).into(), minute(FAILING_MINUTES).into()])?
    .all()
    .await?
    .results::<Recent>()
}

thread_local! {
    static LOADS: RefCell<Option<(u64, Vec<Load>)>> = const { RefCell::new(None) };
}

/// Loads for placing, kept a minute in this isolate.
pub async fn loads(db: &D1Database, config: &Configured<'_>, now: u64) -> Result<Vec<Load>> {
    if let Some(loads) = LOADS.with(|kept| {
        kept.borrow().as_ref().filter(|(at, _)| now.saturating_sub(*at) < LOADS_TTL_MS).map(|(_, loads)| loads.clone())
    }) {
        return Ok(loads);
    }
    let (held, recent) = futures_util::future::join(held(db), recent(db, now)).await;
    let loads: Vec<Load> = standings(config, &held?, &recent?).iter().map(Standing::load).collect();
    LOADS.with(|kept| *kept.borrow_mut() = Some((now, loads.clone())));
    Ok(loads)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standings_add_up_what_each_namespace_holds_and_how_it_answered() {
        let bound = vec!["g1t".to_owned(), "g1t-us-1".to_owned(), "g1t-eu".to_owned()];
        let placement = shards::Placement::from_vars(Some("g1t,g1t-us-1"), Some("g1t-eu"));
        let limits = HashMap::from([("g1t".to_owned(), 10_000u64)]);
        let config = Configured {
            bound: &bound,
            default: "g1t",
            placement: &placement,
            limits: &limits,
            on_fallback: &|name| name == "g1t-us-1",
            writable: &|name| name != "g1t-us-1",
            breaker_open: &|name| name == "g1t-eu",
        };
        let held = vec![
            // Keys with no namespace, and keys naming the default, are both its.
            Held { ns: String::new(), repos: 90.0, forks: 10.0, stored_bytes: 1_000.0 },
            Held { ns: "g1t".into(), repos: 10.0, forks: 0.0, stored_bytes: 24.0 },
            Held { ns: "g1t-us-1".into(), repos: 5.0, forks: 1.0, stored_bytes: 7.0 },
        ];
        let recent = vec![
            Recent { store: "g1t".into(), peak: 6_000.0, calls: 50_000.0, errors: 3.0, recent_calls: 100.0, recent_errors: 1.0, ..Recent::default() },
            Recent { store: "g1t-us-1".into(), peak: 10.0, calls: 20.0, recent_calls: 8.0, recent_errors: 2.0, ..Recent::default() },
            // The fallback's own health is not the namespace's.
            Recent { store: "g1t-us-1@fallback".into(), recent_calls: 50.0, recent_errors: 50.0, ..Recent::default() },
        ];
        let out = standings(&config, &held, &recent);
        assert_eq!(out.len(), 3);
        let g1t = &out[0];
        assert_eq!((g1t.repos, g1t.forks, g1t.stored_bytes), (100, 10, 1_024));
        assert!(g1t.default && g1t.takes_new_repos && !g1t.eu && g1t.writable && !g1t.failing);
        assert_eq!(g1t.max_repos, Some(10_000));
        assert_eq!(g1t.peak_per_minute, 6_000);
        assert!((g1t.peak_share - 0.5).abs() < 1e-9);
        let us1 = &out[1];
        assert!(us1.on_fallback && !us1.writable);
        // 2 of 8 recent calls failed: a quarter, so failing.
        assert!(us1.failing);
        let eu = &out[2];
        assert!(eu.eu && !eu.takes_new_repos);
        assert_eq!(eu.repos, 0);
        // Its breaker is open here.
        assert!(eu.failing);
        let load = g1t.load();
        assert_eq!((load.repos, load.peak_per_minute, load.max_repos), (100, 6_000, Some(10_000)));
    }

    #[test]
    fn a_few_failures_are_not_failing() {
        assert!(!Recent { recent_calls: 4.0, recent_errors: 4.0, ..Recent::default() }.failing());
        assert!(!Recent { recent_calls: 100.0, recent_errors: 24.0, ..Recent::default() }.failing());
        assert!(Recent { recent_calls: 100.0, recent_errors: 25.0, ..Recent::default() }.failing());
        assert!(Recent { recent_rejected: 1.0, ..Recent::default() }.failing());
    }
}
