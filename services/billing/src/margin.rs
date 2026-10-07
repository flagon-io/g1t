//! What g1t earns on each thing it sells, measured against what
//! Cloudflare actually charged for it.
//!
//! Once a day, after `costs` has read Cloudflare's bill, the reconciler
//! puts three figures side by side for every day and each of g1t's
//! products (a "bucket": sandboxes, deployments, git, repository storage,
//! …):
//!
//! 1. **What Cloudflare charged**: the day's cost lines `cost_map` gives
//!    the bucket.
//! 2. **What g1t's meters recorded**: the cost on the ledger's entries for
//!    it (the price book's cost at the time) and, where a mapping names
//!    one, g1t's own count of the same units (git operations).
//! 3. **What customers were charged**: the entries' value at price, before
//!    the plan's included usage, a trial or a pool paid part of it; and of
//!    that, what workspaces paid. Month-end meters (git, storage, scans,
//!    embeddings, the actions cache) come from daily snapshots of what they
//!    had come to (`pending_days`). The plan's price is the `platform`
//!    bucket's: the plan pays for running g1t.
//!
//! From those: margin per product (value against cost) and for all of g1t
//! (money in against every cost); drift (counts or costs that disagree past
//! a mapping's threshold, and leaks: cost with no revenue, or a Cloudflare
//! meter no one mapped); each workspace's cost, Cloudflare's figure shared
//! out by each workspace's own meters; and price proposals when a unit's
//! real cost has moved (`pricing`). Alerts go to staff by email and as a
//! banner in sudo. See docs/BILLING_OPERATIONS.md.

use std::collections::{BTreeMap, BTreeSet};

use g1t_contracts::billing::*;
use g1t_contracts::{FailureCode, Outcome, new_id};
use g1t_contracts::time::rfc3339;
use g1t_kit::now_ms;
use serde::{Deserialize, Serialize};
use worker::wasm_bindgen::JsValue;
use worker::{Env, Result};

use crate::Billing;
use crate::costs::{self, ARTIFACTS_OPERATIONS, DAY_MS, Rule, SOURCE_ARTIFACTS, SOURCE_BILLABLE, UNMAPPED};

/// Buckets that are the cost of running g1t, paid by the plan rather than
/// sold by the unit: never a leak for having no revenue of their own.
pub(crate) const OVERHEAD: [&str; 1] = ["platform"];
/// Buckets Cloudflare does not bill: their cost is g1t's own figure.
pub(crate) const NOT_CLOUDFLARE: [&str; 1] = ["models"];
/// The days drift is judged over.
const DRIFT_DAYS: u64 = 7;
/// The days a workspace's cost is set against its revenue.
const ANOMALY_DAYS: u64 = 30;
/// The days a unit's cost is measured over.
const MEASURE_DAYS: u64 = 30;
/// Fewer of g1t's units than this say nothing about cost per unit.
const MIN_UNITS: f64 = 1_000.0;
/// An open alert is emailed again after this long.
const REMIND_MS: u64 = 7 * DAY_MS;

// ---------------------------------------------------------------------
// The arithmetic, apart from the database so it can be tested.
// ---------------------------------------------------------------------

/// One of g1t's products on one day.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct ProductDay {
    pub day: String,
    pub bucket: String,
    /// What Cloudflare charged g1t, in millionths of a dollar.
    pub cf_cost_micros: i64,
    /// What g1t's meters recorded it cost (the price book's cost).
    pub own_cost_micros: i64,
    /// What customers were charged for it at price, before what paid.
    pub value_micros: i64,
    /// Of that, what workspaces paid themselves.
    pub cash_micros: i64,
    /// Units Cloudflare counted and units g1t counted, where a mapping
    /// says they are the same units.
    pub cf_quantity: f64,
    pub own_quantity: f64,
    /// Of `cost()`, what went on usage g1t gave away (the workspaces'
    /// `WorkspaceDay::given`, added up).
    pub given: Given,
}

impl ProductDay {
    /// What it cost: Cloudflare's figure where Cloudflare bills it, else
    /// g1t's own (models are billed by their providers, through the gateway).
    pub fn cost(&self) -> i64 {
        if NOT_CLOUDFLARE.contains(&self.bucket.as_str()) { self.own_cost_micros } else { self.cf_cost_micros }
    }
}

/// A line of Cloudflare's bill, as stored.
#[derive(Clone, Debug, Deserialize)]
pub(crate) struct LineRow {
    pub day: String,
    pub source: String,
    pub product: String,
    pub meter: String,
    pub quantity: f64,
    pub cost_usd: f64,
}

/// A count of g1t's own, as stored.
#[derive(Clone, Debug, Deserialize)]
pub(crate) struct OwnRow {
    pub day: String,
    pub meter: String,
    pub workspace: String,
    pub quantity: f64,
}

/// What g1t gave away, by why: its own comped workspaces, free use (a
/// free period, free allowances, overruns g1t covered), the trial, and the
/// open-source pool, and discounts on an account's terms (what they took
/// below cost plus the margin, `ledger.discount_micros`). The Team plan's
/// included usage is paid for by the plan's price, so it is sold, not given.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Given {
    pub comped: i64,
    pub free: i64,
    pub trial: i64,
    pub pool: i64,
    pub discount: i64,
}

impl Given {
    pub fn total(&self) -> i64 {
        self.comped + self.free + self.trial + self.pool + self.discount
    }

    fn add(&mut self, other: &Given) {
        self.comped += other.comped;
        self.free += other.free;
        self.trial += other.trial;
        self.pool += other.pool;
        self.discount += other.discount;
    }

    /// The same shares of `cost` as these are of `value`, at most all of it.
    fn of(&self, cost: i64, value: i64) -> Given {
        let total = self.total();
        if value <= 0 || cost <= 0 || total <= 0 {
            return Given::default();
        }
        let given = cost as i128 * total.min(value) as i128 / value as i128;
        let part = |x: i64| (given * x.max(0) as i128 / total as i128) as i64;
        Given {
            comped: part(self.comped),
            free: part(self.free),
            trial: part(self.trial),
            pool: part(self.pool),
            discount: part(self.discount),
        }
    }
}

/// What a workspace was charged for one key on one day.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct UsageRow {
    pub day: String,
    pub workspace: String,
    /// A ledger task (or `builds`), a month-end source, or `plan`.
    pub key: String,
    pub value: i64,
    pub cash: i64,
    pub cost: i64,
    /// Of `value`, what g1t gave away: all of it for g1t's own (comped)
    /// workspaces and in a free period, else what the trial and the pool
    /// paid and the overruns g1t covered.
    pub given: Given,
}

/// One workspace's share of a product's cost on one day.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct WorkspaceDay {
    pub day: String,
    pub workspace: String,
    pub bucket: String,
    pub cost: i64,
    /// What the workspace paid in cash.
    pub revenue: i64,
    /// What its usage was priced at, whoever paid for it.
    pub value: i64,
    /// Of `cost`, the part g1t gave away: all of it for a comped workspace
    /// or one with nothing priced that day (free use), else the cost times
    /// the shares of its usage that day that g1t paid for.
    pub given: Given,
}

fn micros(dollars: f64) -> i64 {
    (dollars * 1_000_000.0).round() as i64
}

/// Puts the day's bill, g1t's counts and what customers were charged side
/// by side, a row per day and bucket, and shares each bucket's cost out
/// to workspaces.
pub(crate) fn fold(
    rules: &[Rule],
    revenue_map: &BTreeMap<String, String>,
    lines: &[LineRow],
    own: &[OwnRow],
    usage: &[UsageRow],
    internal: &BTreeSet<String>,
) -> (Vec<ProductDay>, Vec<WorkspaceDay>) {
    let mut days: BTreeMap<(String, String), ProductDay> = BTreeMap::new();
    let entry = |day: &str, bucket: &str| -> ProductDay {
        ProductDay { day: day.to_owned(), bucket: bucket.to_owned(), ..ProductDay::default() }
    };
    // Which of g1t's own meters count each bucket's units.
    let mut own_meters: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for rule in rules {
        if let Some(meter) = &rule.own_meter {
            own_meters.entry(rule.bucket.as_str()).or_default().insert(meter.as_str());
        }
    }
    let mut events: BTreeMap<(String, String), f64> = BTreeMap::new();
    for line in lines {
        let rule = costs::classify(rules, &line.product, &line.meter);
        let bucket = rule.map_or(UNMAPPED, |r| r.bucket.as_str());
        let key = (line.day.clone(), bucket.to_owned());
        if line.source == SOURCE_ARTIFACTS {
            // What Artifacts counted: operations only, and only where the
            // bill does not count them itself.
            if ARTIFACTS_OPERATIONS.contains(&line.meter.as_str()) {
                *events.entry(key).or_default() += line.quantity;
            }
            continue;
        }
        let row = days.entry(key.clone()).or_insert_with(|| entry(&key.0, &key.1));
        row.cf_cost_micros += micros(line.cost_usd);
        if line.source == SOURCE_BILLABLE && rule.is_some_and(|r| r.own_meter.is_some()) {
            row.cf_quantity += line.quantity;
        }
    }
    for (key, quantity) in events {
        let row = days.entry(key.clone()).or_insert_with(|| entry(&key.0, &key.1));
        if row.cf_quantity == 0.0 {
            row.cf_quantity = quantity;
        }
    }
    // g1t's own counts of the same units, by bucket and by workspace.
    let mut own_by: BTreeMap<(String, String), Vec<(String, f64)>> = BTreeMap::new();
    // Cloudflare's own count by workspace, where it gives one
    // (`cloudflare_<bucket>`): the best way to share its cost.
    let mut cf_by: BTreeMap<(String, String), Vec<(String, f64)>> = BTreeMap::new();
    for count in own {
        if let Some(bucket) = count.meter.strip_prefix("cloudflare_") {
            cf_by.entry((count.day.clone(), bucket.to_owned())).or_default().push((count.workspace.clone(), count.quantity));
            continue;
        }
        for (bucket, meters) in &own_meters {
            if meters.contains(count.meter.as_str()) {
                let key = (count.day.clone(), (*bucket).to_owned());
                days.entry(key.clone()).or_insert_with(|| entry(&key.0, &key.1)).own_quantity += count.quantity;
                own_by.entry(key).or_default().push((count.workspace.clone(), count.quantity));
            }
        }
    }
    // What customers were charged.
    let bucket_of = |key: &str| revenue_map.get(key).cloned().unwrap_or_else(|| "models".to_owned());
    let mut value_by: BTreeMap<(String, String), Vec<(String, f64)>> = BTreeMap::new();
    let mut cost_by: BTreeMap<(String, String), Vec<(String, f64)>> = BTreeMap::new();
    let mut revenue: BTreeMap<(String, String, String), i64> = BTreeMap::new();
    let mut valued: BTreeMap<(String, String, String), i64> = BTreeMap::new();
    let mut active: BTreeMap<String, Vec<(String, f64)>> = BTreeMap::new();
    let mut gave: BTreeMap<(String, String), (Given, i64)> = BTreeMap::new();
    for u in usage {
        let g = gave.entry((u.day.clone(), u.workspace.clone())).or_default();
        g.0.add(&u.given);
        g.1 += u.value;
        let bucket = bucket_of(&u.key);
        let key = (u.day.clone(), bucket.clone());
        let row = days.entry(key.clone()).or_insert_with(|| entry(&key.0, &key.1));
        row.own_cost_micros += u.cost;
        row.value_micros += u.value;
        row.cash_micros += u.cash;
        value_by.entry(key.clone()).or_default().push((u.workspace.clone(), u.value as f64));
        cost_by.entry(key).or_default().push((u.workspace.clone(), u.cost as f64));
        *revenue.entry((u.day.clone(), u.workspace.clone(), bucket.clone())).or_default() += u.cash;
        *valued.entry((u.day.clone(), u.workspace.clone(), bucket)).or_default() += u.value;
        active.entry(u.day.clone()).or_default().push((u.workspace.clone(), u.value.max(u.cost) as f64));
    }
    // Each bucket's cost shared out: by Cloudflare's own count per
    // workspace, else by g1t's own count of its units, else by what its
    // usage cost (so free use carries its own cost), else by what it was
    // charged; running g1t, and what no one mapped, by each workspace's
    // share of all usage that day.
    let mut shares: BTreeMap<(String, String, String), i64> = BTreeMap::new();
    for ((day, bucket), row) in &days {
        let key = (day.clone(), bucket.clone());
        let weigh = |m: &BTreeMap<(String, String), Vec<(String, f64)>>| m.get(&key).filter(|w| w.iter().any(|(_, v)| *v > 0.0)).cloned();
        let weights = if OVERHEAD.contains(&bucket.as_str()) || bucket == UNMAPPED {
            active.get(day).cloned()
        } else {
            weigh(&cf_by).or_else(|| weigh(&own_by)).or_else(|| weigh(&cost_by)).or_else(|| weigh(&value_by)).or_else(|| active.get(day).cloned())
        };
        for (workspace, micros) in attribute(row.cost(), &weights.unwrap_or_default()) {
            *shares.entry((day.clone(), workspace, bucket.clone())).or_default() += micros;
        }
    }
    let keys: BTreeSet<(String, String, String)> = shares.keys().chain(revenue.keys()).cloned().collect();
    let workspaces: Vec<WorkspaceDay> = keys
        .into_iter()
        .map(|(day, workspace, bucket)| {
            let cost = shares.get(&(day.clone(), workspace.clone(), bucket.clone())).copied().unwrap_or(0);
            // The day's shares given away apply to every bucket, so a
            // comped workspace's part of running g1t is given too. A
            // workspace with nothing priced that day used g1t for free.
            let given = if internal.contains(&workspace) {
                Given { comped: cost, ..Given::default() }
            } else {
                match gave.get(&(day.clone(), workspace.clone())) {
                    Some((given, value)) if *value > 0 => given.of(cost, *value),
                    _ => Given { free: cost.max(0), ..Given::default() },
                }
            };
            WorkspaceDay {
                cost,
                revenue: revenue.get(&(day.clone(), workspace.clone(), bucket.clone())).copied().unwrap_or(0),
                value: valued.get(&(day.clone(), workspace.clone(), bucket.clone())).copied().unwrap_or(0),
                given,
                day,
                workspace,
                bucket,
            }
        })
        .collect();
    for w in &workspaces {
        if let Some(row) = days.get_mut(&(w.day.clone(), w.bucket.clone())) {
            row.given.add(&w.given);
        }
    }
    (days.into_values().collect(), workspaces)
}

/// A month-end source's day, from the snapshots of what it had come to:
/// each day's figure less the day before's in the same month (the first
/// day of a month, or the first snapshot, is its own).
pub(crate) fn pending_deltas(snapshots: &[(String, String, String, i64, i64)]) -> Vec<UsageRow> {
    // (day, workspace, source, cost, charge), any order.
    let mut sorted = snapshots.to_vec();
    sorted.sort_by(|a, b| (&a.1, &a.2, &a.0).cmp(&(&b.1, &b.2, &b.0)));
    let mut out = Vec::new();
    let mut previous: Option<&(String, String, String, i64, i64)> = None;
    for snap in &sorted {
        let (day, workspace, source, cost, charge) = snap;
        let (before_cost, before_charge) = match previous {
            Some(p) if p.1 == *workspace && p.2 == *source && p.0[..7] == day[..7] => (p.3, p.4),
            _ => (0, 0),
        };
        let (cost, charge) = ((cost - before_cost).max(0), (charge - before_charge).max(0));
        if cost > 0 || charge > 0 {
            out.push(UsageRow { day: day.clone(), workspace: workspace.clone(), key: source.clone(), value: charge, cash: charge, cost, given: Given::default() });
        }
        previous = Some(snap);
    }
    out
}

/// Margin as a share of what was charged, in percent; None when nothing was.
pub(crate) fn margin_percent(revenue_micros: i64, cost_micros: i64) -> Option<f64> {
    (revenue_micros > 0).then(|| (revenue_micros - cost_micros) as f64 * 100.0 / revenue_micros as f64)
}

/// How far `ours` is from `theirs`, in percent of theirs; None when theirs
/// is nothing.
pub(crate) fn delta_percent(ours: f64, theirs: f64) -> Option<f64> {
    (theirs > 0.0).then(|| (ours - theirs) * 100.0 / theirs)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DriftKind {
    /// g1t counted a different number of units than Cloudflare did.
    Count,
    /// What Cloudflare charged differs from what the price book says the
    /// same usage cost.
    Cost,
    /// Cloudflare charged for something nothing charges customers for.
    Leak,
    /// Model usage AI Gateway put no price on: its cost is not what the
    /// provider bills, so neither the ledger nor the gateway total has it.
    Unpriced,
}

impl DriftKind {
    pub fn as_str(self) -> &'static str {
        match self {
            DriftKind::Count => "count",
            DriftKind::Cost => "cost",
            DriftKind::Leak => "leak",
            DriftKind::Unpriced => "unpriced",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Drift {
    pub bucket: String,
    pub kind: DriftKind,
    pub ours: f64,
    pub cloudflare: f64,
    pub delta_percent: Option<f64>,
}

/// Drift over a window for one bucket: counts more than `threshold`
/// percent apart, a bill that far from the price book's cost of the same
/// usage, and cost with nothing charged for it. Under `min_cost_micros`
/// in all, cost says nothing.
pub(crate) fn drifts(bucket: &str, days: &[ProductDay], threshold: f64, counted: bool, min_cost_micros: i64) -> Vec<Drift> {
    let overhead = OVERHEAD.contains(&bucket);
    let sum = |f: &dyn Fn(&ProductDay) -> f64| days.iter().map(f).sum::<f64>();
    let cf_cost = sum(&|d| d.cf_cost_micros as f64);
    let own_cost = sum(&|d| d.own_cost_micros as f64);
    let value = sum(&|d| d.value_micros as f64);
    // Counts are compared from the first day g1t counted: before its meter
    // was deployed there is only Cloudflare's side. A meter that never
    // counted anything is compared over every day, so it still shows.
    let first_counted = days.iter().filter(|d| d.own_quantity > 0.0).map(|d| d.day.as_str()).min();
    let compared = |d: &&ProductDay| first_counted.is_none_or(|from| d.day.as_str() >= from);
    let (cf_quantity, own_quantity) = days.iter().filter(compared).fold((0.0, 0.0), |(cf, own), d| (cf + d.cf_quantity, own + d.own_quantity));
    let mut out = Vec::new();
    if counted && cf_quantity > 0.0 {
        let delta = delta_percent(own_quantity, cf_quantity);
        if delta.is_some_and(|d| d.abs() > threshold) {
            out.push(Drift { bucket: bucket.into(), kind: DriftKind::Count, ours: own_quantity, cloudflare: cf_quantity, delta_percent: delta });
        }
    }
    let enough = cf_cost.max(own_cost) >= min_cost_micros as f64;
    // Models: what AI Gateway priced g1t's own provider traffic at (its
    // lines, as "Cloudflare's" side) against the ledger's model cost. Only
    // once the gateway has been read; then the ledger having none of it is
    // drift too (traffic no run was charged for).
    let models = NOT_CLOUDFLARE.contains(&bucket) && cf_cost > 0.0;
    if enough && !overhead && cf_cost > 0.0 && (own_cost > 0.0 || models) {
        let delta = delta_percent(own_cost, cf_cost);
        if delta.is_some_and(|d| d.abs() > threshold) {
            out.push(Drift { bucket: bucket.into(), kind: DriftKind::Cost, ours: own_cost, cloudflare: cf_cost, delta_percent: delta });
        }
    }
    // The ledger has model cost and the gateway priced none of it: a token
    // that cannot see AI Gateway reads as no rows, never an error, so this
    // is not agreement. Said, rather than left as no row at all.
    if NOT_CLOUDFLARE.contains(&bucket) && cf_cost <= 0.0 && own_cost >= min_cost_micros as f64 && own_cost > 0.0 {
        out.push(Drift { bucket: bucket.into(), kind: DriftKind::Cost, ours: own_cost, cloudflare: 0.0, delta_percent: None });
    }
    if !overhead && cf_cost >= min_cost_micros as f64 && value <= 0.0 {
        out.push(Drift { bucket: bucket.into(), kind: DriftKind::Leak, ours: value, cloudflare: cf_cost, delta_percent: None });
    }
    out
}

/// What can make AI Gateway's cost differ from what the providers bill,
/// said for staff: cache tokens (priced by the gateway at its own rates for
/// them, which may lag the provider's), requests Cloudflare billed itself,
/// models it has no price for, and runs settled short.
fn caveat_notes(c: &costs::GatewayCaveats) -> Vec<String> {
    let mut notes = Vec::new();
    if c.cache_read_tokens > 0.0 || c.cache_write_tokens > 0.0 {
        notes.push(format!(
            "{} prompt-cache read and {} cache write tokens went through it: check its cost against the provider's invoice, since cache reads are billed far below input and writes above it",
            crate::features::thousands(c.cache_read_tokens.round() as u64),
            crate::features::thousands(c.cache_write_tokens.round() as u64)
        ));
    }
    if c.wholesale_usd > 0.0 {
        notes.push(format!(
            "{} of it Cloudflare billed itself (unified billing): that part is on Cloudflare's bill, not a provider's",
            dollars(micros(c.wholesale_usd))
        ));
    }
    if !c.unpriced.is_empty() {
        notes.push(format!("it has no price for {} (tokens used, $0)", c.unpriced.join(", ")));
    }
    if c.short_runs > 0 {
        notes.push(format!("{} runs were settled at no less than the sandbox reported because the gateway could not price all of them", c.short_runs));
    }
    notes
}

/// The models drift's detail: the gateway's total against the ledger's.
pub(crate) fn models_detail(drift: &Drift, caveats: &costs::GatewayCaveats) -> String {
    if drift.cloudflare <= 0.0 {
        return format!(
            "Models: the ledger's model cost is {} over the last {DRIFT_DAYS} days and AI Gateway priced nothing, so the two were not compared. Either the gateway's analytics cannot be seen (Cloudflare answers a token without AI Gateway: Read with no rows, not an error; billing reads them with CLOUDFLARE_USAGE_TOKEN, then CLOUDFLARE_BILLING_TOKEN), or model calls went around the gateway.",
            dollars(drift.ours as i64)
        );
    }
    let lower = drift.ours < drift.cloudflare;
    let mut detail = format!(
        "Models: AI Gateway priced g1t's own provider traffic at {} over the last {DRIFT_DAYS} days; the ledger's model cost for the same days is {} ({:+.1}%). {}",
        dollars(drift.cloudflare as i64),
        dollars(drift.ours as i64),
        drift.delta_percent.unwrap_or(0.0),
        if lower {
            "Model calls g1t paid for were not charged: runs not yet settled, runs with no session, or calls with no run (the ledger catches up as runs settle; a gap that stays is a leak)."
        } else {
            "The ledger counts more than the gateway priced: runs that went to a provider without the gateway, or sandbox reports the gateway could not correct."
        }
    );
    let notes = caveat_notes(caveats);
    if !notes.is_empty() {
        detail.push_str(" The gateway's cost may be off: ");
        detail.push_str(&notes.join("; "));
        detail.push('.');
    }
    detail
}

/// The unpriced drift's detail.
pub(crate) fn unpriced_detail(caveats: &costs::GatewayCaveats) -> String {
    format!(
        "Models: AI Gateway's cost is not all of what the providers bill over the last {DRIFT_DAYS} days: {}. Runs on a model with no gateway price are charged no less than the sandbox reported; add the model's price to the gateway (or route away from it) so it is charged at cost.",
        caveat_notes(&costs::GatewayCaveats { cache_read_tokens: 0.0, cache_write_tokens: 0.0, wholesale_usd: 0.0, ..caveats.clone() }).join("; ")
    )
}

/// Model usage AI Gateway could not price over the window, as drift on
/// the models bucket: models with tokens and no cost, or runs settled
/// short. None when there is none.
pub(crate) fn unpriced_drift(caveats: &costs::GatewayCaveats) -> Option<(Drift, String)> {
    if caveats.unpriced.is_empty() && caveats.short_runs == 0 {
        return None;
    }
    let drift = Drift {
        bucket: NOT_CLOUDFLARE[0].into(),
        kind: DriftKind::Unpriced,
        ours: f64::from(caveats.short_runs),
        cloudflare: caveats.unpriced.len() as f64,
        delta_percent: None,
    };
    Some((drift, unpriced_detail(caveats)))
}

/// When the last `days` in a row (each with enough cost to say something)
/// were all under the floor: the first of them and the worst margin.
/// Each item is a day's (day, revenue, cost).
pub(crate) fn breach(series: &[(String, i64, i64)], floor_percent: f64, days: usize, min_cost_micros: i64) -> Option<(String, f64)> {
    if days == 0 || series.len() < days {
        return None;
    }
    let tail = &series[series.len() - days..];
    let mut worst = f64::INFINITY;
    for (_, revenue, cost) in tail {
        if *cost < min_cost_micros {
            return None;
        }
        let margin = margin_percent(*revenue, *cost).unwrap_or(-100.0);
        if margin >= floor_percent {
            return None;
        }
        worst = worst.min(margin);
    }
    Some((tail[0].0.clone(), worst))
}

/// `total` shared out in proportion to `weights`, in whole millionths that
/// add up to it exactly (largest remainder first). Nothing to share, or no
/// weight, shares nothing.
pub(crate) fn attribute(total: i64, weights: &[(String, f64)]) -> Vec<(String, i64)> {
    let mut merged: BTreeMap<String, f64> = BTreeMap::new();
    for (key, w) in weights {
        *merged.entry(key.clone()).or_default() += w.max(0.0);
    }
    let sum: f64 = merged.values().sum();
    if total <= 0 || sum <= 0.0 {
        return Vec::new();
    }
    let mut shares: Vec<(String, i64, f64)> = merged
        .into_iter()
        .map(|(key, w)| {
            let exact = total as f64 * w / sum;
            (key, exact.floor() as i64, exact - exact.floor())
        })
        .collect();
    let mut left = total - shares.iter().map(|s| s.1).sum::<i64>();
    let mut order: Vec<usize> = (0..shares.len()).collect();
    order.sort_by(|a, b| shares[*b].2.total_cmp(&shares[*a].2).then(shares[*a].0.cmp(&shares[*b].0)));
    for index in order {
        if left <= 0 {
            break;
        }
        shares[index].1 += 1;
        left -= 1;
    }
    shares.into_iter().filter(|s| s.1 > 0).map(|(key, micros, _)| (key, micros)).collect()
}

/// Workspaces that cost g1t more than `factor` times what they paid, with
/// at least `floor_micros` of cost: each (workspace, cost, revenue), the
/// biggest gap first.
/// What a day's usage was worth at price. g1t's own workspaces are valued
/// at price. So is usage nothing paid for, neither charged nor drawn from
/// the plan, a trial, a pool or a gift (a free period): it was given away at
/// its price, not sold for nothing. Anything paid keeps what it was paid, so
/// a discount still shows as one.
pub(crate) fn usage_value(internal: bool, cost: i64, paid: i64, margin_percent: u32) -> i64 {
    if internal || (paid == 0 && cost > 0) {
        return crate::credits::with_margin(cost, margin_percent);
    }
    paid
}

/// What the overall alert says: the money as money, and a percentage only
/// while there is enough coming in for one to mean something (a few cents
/// against dollars of cost reads as -8000%).
pub(crate) fn overall_detail(took: i64, spent: i64, days: usize, floor: f64, worst: f64) -> String {
    if took < 1_000_000 * days as i64 {
        return format!(
            "All of g1t, comped workspaces left out: took in {} against {} of Cloudflare's bill over {days} days.",
            dollars(took),
            dollars(spent)
        );
    }
    format!("All of g1t, comped workspaces left out: money in against Cloudflare's bill under {floor:.0}% for {days} days running, as low as {worst:.1}%.")
}

pub(crate) fn anomalies(rows: &[(String, i64, i64)], factor: f64, floor_micros: i64) -> Vec<(String, i64, i64)> {
    let mut out: Vec<(String, i64, i64)> = rows
        .iter()
        .filter(|(_, cost, revenue)| *cost >= floor_micros && *cost as f64 > *revenue as f64 * factor)
        .cloned()
        .collect();
    out.sort_by(|a, b| (b.1 - b.2).cmp(&(a.1 - a.2)).then(a.0.cmp(&b.0)));
    out
}

/// Cloudflare's marginal rate for one of its units: the median over the
/// charged days of cost over quantity, in dollars. None while the included
/// amounts still cover it. Each item is a day's (quantity, cost).
pub(crate) fn billed_rate(days: &[(f64, f64)]) -> Option<f64> {
    let mut rates: Vec<f64> = days.iter().filter(|(q, c)| *q > 0.0 && *c > 0.0).map(|(q, c)| c / q).collect();
    if rates.is_empty() {
        return None;
    }
    rates.sort_by(f64::total_cmp);
    Some(rates[rates.len() / 2])
}

/// What one of g1t's units costs, from Cloudflare's rate per its own unit
/// and how many of Cloudflare's units each of g1t's took: if Cloudflare
/// counts three operations for every git operation g1t counts, a git
/// operation costs three of Cloudflare's. None without enough of g1t's
/// units to say.
pub(crate) fn derived_unit_cost(rate_per_cf_unit: f64, cf_units: f64, own_units: f64) -> Option<f64> {
    (own_units >= MIN_UNITS && cf_units > 0.0 && rate_per_cf_unit > 0.0).then(|| rate_per_cf_unit * cf_units / own_units)
}

/// How many units a price is per: `1,000 operations` → 1,000, `million
/// requests` → 1,000,000, `second` → 1.
pub(crate) fn unit_size(unit: &str) -> f64 {
    let first = unit.split_whitespace().next().unwrap_or_default().replace(',', "");
    match first.as_str() {
        "million" => 1_000_000.0,
        "thousand" => 1_000.0,
        n => n.parse().unwrap_or(1.0),
    }
}

fn day_before(day: &str, days: u64) -> String {
    let ms = g1t_contracts::time::parse_rfc3339(&format!("{day}T00:00:00Z")).unwrap_or(0);
    rfc3339(ms.saturating_sub(days * DAY_MS))[..10].to_owned()
}

/// Dollars to the cent from a dollar up, finer below: `$17.02`, `$0.063`.
fn dollars(micros: i64) -> String {
    if micros.abs() >= 1_000_000 {
        let cents = (micros as f64 / 10_000.0).round() as i64;
        format!("{}${}.{:02}", if cents < 0 { "-" } else { "" }, cents.abs() / 100, cents.abs() % 100)
    } else {
        crate::features::dollars(micros)
    }
}

/// The days a plan payment is spread over.
const PLAN_DAYS: u64 = 30;

/// `micros` paid on `day` spread evenly over `days` days from it, in
/// whole micros that add up to it (the first days take the remainder).
pub(crate) fn spread(day: &str, micros: i64, days: u64) -> Vec<(String, i64)> {
    if micros <= 0 || days == 0 {
        return Vec::new();
    }
    let start = g1t_contracts::time::parse_rfc3339(&format!("{}T00:00:00Z", &day[..10.min(day.len())])).unwrap_or(0);
    let each = micros / days as i64;
    let rest = micros % days as i64;
    (0..days)
        .map(|n| (rfc3339(start + n * DAY_MS)[..10].to_owned(), each + i64::from((n as i64) < rest)))
        .collect()
}

// ---------------------------------------------------------------------
// The daily run, and what sudo reads.
// ---------------------------------------------------------------------

#[derive(Serialize)]
struct Mail<'a> {
    to: &'a str,
    from: &'a str,
    subject: &'a str,
    text: String,
    html: String,
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Emails staff through Cloudflare Email Sending, the `EMAIL` binding.
pub(crate) async fn email_staff(env: &Env, to: &str, subject: &str, lines: &[String]) -> Result<()> {
    let link = "https://sudo.g1t.sh/costs";
    let text = format!("{}\n\nCosts & margin: {link}\n\nSent by g1t-billing's margin guard (COSTS_ALERT_EMAIL).\n", lines.join("\n\n"));
    let mut html = String::from("<div style=\"font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px 16px;color:#16150f\">");
    for line in lines {
        html.push_str(&format!("<p style=\"font-size:15px;line-height:1.6\">{}</p>", escape(line)));
    }
    html.push_str(&format!(
        "<p><a href=\"{link}\">Open Costs &amp; margin in sudo</a></p><p style=\"font-size:13px;color:#6e6a5e\">Sent by g1t-billing's margin guard (COSTS_ALERT_EMAIL).</p></div>"
    ));
    let mail = Mail { to, from: "g1t <noreply@g1t.sh>", subject, text, html };
    let binding = g1t_kit::js::binding(env, "EMAIL")?;
    g1t_kit::js::call(&binding, "send", &[g1t_kit::js::to_js(&mail)?]).await?;
    Ok(())
}

#[derive(Deserialize)]
struct AlertRow {
    id: String,
    kind: String,
    subject: String,
    detail: String,
    since: String,
    opened_at: String,
    emailed_at: Option<String>,
}

impl From<AlertRow> for MarginAlert {
    fn from(r: AlertRow) -> Self {
        MarginAlert { id: r.id, kind: r.kind, subject: r.subject, detail: r.detail, since: r.since, opened_at: r.opened_at, emailed_at: r.emailed_at }
    }
}

#[derive(Deserialize)]
struct MarginRow {
    day: String,
    bucket: String,
    cf_cost_micros: i64,
    own_cost_micros: i64,
    value_micros: i64,
    cash_micros: i64,
    cf_quantity: f64,
    own_quantity: f64,
    #[serde(default)]
    given_comped_micros: Option<i64>,
    #[serde(default)]
    given_free_micros: Option<i64>,
    #[serde(default)]
    given_trial_micros: Option<i64>,
    #[serde(default)]
    given_pool_micros: Option<i64>,
    #[serde(default)]
    given_discount_micros: Option<i64>,
}

impl From<MarginRow> for ProductDay {
    fn from(r: MarginRow) -> Self {
        ProductDay {
            day: r.day,
            bucket: r.bucket,
            cf_cost_micros: r.cf_cost_micros,
            own_cost_micros: r.own_cost_micros,
            value_micros: r.value_micros,
            cash_micros: r.cash_micros,
            cf_quantity: r.cf_quantity,
            own_quantity: r.own_quantity,
            given: Given {
                comped: r.given_comped_micros.unwrap_or(0),
                free: r.given_free_micros.unwrap_or(0),
                trial: r.given_trial_micros.unwrap_or(0),
                pool: r.given_pool_micros.unwrap_or(0),
                discount: r.given_discount_micros.unwrap_or(0),
            },
        }
    }
}

impl Billing {
    /// The day's work: read Cloudflare's bill and g1t's own counts,
    /// reconcile, look for drift, measure unit costs, apply prices whose
    /// day has come, and raise or clear alerts.
    pub(crate) async fn costs_daily(&self, env: &Env, keeper: &crate::keeper::Keeper) -> Result<CostsRun> {
        let mut run = CostsRun::default();
        let (since, until) = match self.read_cloudflare(keeper, &mut run.problems).await? {
            Some((since, until, lines)) => {
                run.lines = lines;
                (since, until)
            }
            // Without the bill, still reconcile what g1t knows itself, over
            // the same days the bill would be read for.
            None => {
                #[derive(Deserialize)]
                struct Last {
                    day: Option<String>,
                }
                let last = self.db.prepare("SELECT MAX(day) AS day FROM margin_days").first::<Last>(None).await?.and_then(|l| l.day);
                costs::window(last.as_deref(), now_ms())
            }
        };
        // Not a problem for the run: the last read, or the estimate, stays.
        if keeper.can_read_bill()
            && let Err(error) = self.read_subscriptions(keeper).await
        {
            worker::console_error!("Cloudflare's subscriptions were not read: {error}");
        }
        if let Err(error) = self.count_own(&since, &until).await {
            run.problems.push(format!("g1t's own counts could not be read: {error}"));
        }
        self.snapshot_pending(&until).await?;
        // Reconciled over the whole window sudo shows, not only the days the
        // bill was read for: it reads only what is already kept, so a change
        // in how a day is valued reaches every day shown at the next run.
        let window = day_before(&until, costs::BACKFILL_DAYS - 1);
        let reconcile_from = if window < since { window } else { since.clone() };
        run.days = self.reconcile_range(&reconcile_from, &until).await?;
        let drift = self.find_drift(&until).await?;
        run.proposals = self.measure_units(&until).await?;
        self.apply_due_versions().await?;
        run.alerts = self.raise_alerts(env, &until, &drift).await?;
        if let Some(identity) = &self.identity
            && let Err(error) = self.tell_owners_of_rises(identity).await
        {
            run.problems.push(format!("owners could not be told of a price rise: {error}"));
        }
        for problem in &run.problems {
            worker::console_warn!("costs: {problem}");
        }
        Ok(run)
    }

    /// What each month-end source had come to by the end of `day`.
    async fn snapshot_pending(&self, day: &str) -> Result<()> {
        self.db
            .prepare(
                "INSERT INTO pending_days (day, workspace, source, cost_micros, charge_micros)
                 SELECT ?1, workspace, source, COALESCE(cost_micros, 0), COALESCE(charge_micros, 0) FROM pending_usage WHERE month = ?2
                 ON CONFLICT (day, workspace, source) DO UPDATE SET cost_micros = excluded.cost_micros, charge_micros = excluded.charge_micros",
            )
            .bind(&[day.into(), day[..7].into()])?
            .run()
            .await?;
        Ok(())
    }

    /// What customers were charged on the days, by workspace and key.
    async fn usage_rows(&self, since: &str, until: &str) -> Result<Vec<UsageRow>> {
        #[derive(Deserialize)]
        struct Row {
            day: String,
            workspace: String,
            key: String,
            internal: i64,
            own_provider: i64,
            cash: Option<i64>,
            drawn: Option<i64>,
            trial: Option<i64>,
            oss: Option<i64>,
            covered: Option<i64>,
            discount: Option<i64>,
            cost: Option<i64>,
        }
        let charged_here = crate::storage::CHARGED_HERE.iter().map(|s| format!("'{s}'")).collect::<Vec<_>>().join(", ");
        let end = format!("{until}T23:59:59.999Z");
        let rows = self
            .db
            .prepare(format!(
                "SELECT substr(created_at, 1, 10) AS day, workspace,
                        CASE WHEN task = 'deployments' AND reference LIKE 'deploy/%' THEN 'builds' ELSE COALESCE(task, 'other') END AS key,
                        CASE WHEN workspace IN ({internal}) THEN 1 ELSE 0 END AS internal,
                        CASE WHEN billed_to = 'workspace' THEN 1 ELSE 0 END AS own_provider,
                        -SUM(amount_micros) AS cash,
                        SUM(COALESCE(credit_micros, 0) + COALESCE(trial_micros, 0) + COALESCE(oss_micros, 0) + COALESCE(given_micros, 0)) AS drawn,
                        SUM(COALESCE(trial_micros, 0)) AS trial,
                        SUM(COALESCE(oss_micros, 0)) AS oss,
                        SUM(COALESCE(given_micros, 0)) AS covered,
                        SUM(COALESCE(discount_micros, 0)) AS discount,
                        SUM(COALESCE(cost_micros, 0)) AS cost
                 FROM ledger
                 WHERE kind = 'usage' AND created_at >= ?1 AND created_at <= ?2 AND COALESCE(task, '') NOT IN ({charged_here})
                 GROUP BY 1, 2, 3, 4, 5",
                internal = crate::sales::INTERNAL_SQL
            ))
            .bind(&[since.into(), end.as_str().into()])?
            .all()
            .await?
            .results::<Row>()?;
        let mut internal = BTreeSet::new();
        let mut out: Vec<UsageRow> = rows
            .into_iter()
            .map(|r| {
                // A workspace's own model provider was paid there: no cost
                // to g1t. g1t's own workspaces are valued at price.
                let cost = if r.own_provider == 1 { 0 } else { r.cost.unwrap_or(0) };
                let cash = r.cash.unwrap_or(0);
                // A discount took its part below cost plus the margin: it is
                // valued at price and that part counted as given, so a
                // discounted sale never reads as margin lost.
                let discount = r.discount.unwrap_or(0).max(0);
                let paid = cash + r.drawn.unwrap_or(0) + discount;
                let value = usage_value(r.internal == 1, cost, paid, self.margin_percent);
                let given = if r.internal == 1 {
                    Given { comped: value, ..Given::default() }
                } else if paid == 0 && cost > 0 {
                    Given { free: value, ..Given::default() }
                } else {
                    Given { free: r.covered.unwrap_or(0), trial: r.trial.unwrap_or(0), pool: r.oss.unwrap_or(0), comped: 0, discount }
                };
                if r.internal == 1 {
                    internal.insert(r.workspace.clone());
                }
                UsageRow { day: r.day, workspace: r.workspace, key: r.key, value, cash, cost, given }
            })
            .collect();
        // Month-end sources, from their daily snapshots.
        #[derive(Deserialize)]
        struct Snap {
            day: String,
            workspace: String,
            source: String,
            cost_micros: i64,
            charge_micros: i64,
        }
        let snaps = self
            .db
            .prepare("SELECT day, workspace, source, cost_micros, charge_micros FROM pending_days WHERE day >= ?1 AND day <= ?2")
            .bind(&[day_before(since, 1).into(), until.into()])?
            .all()
            .await?
            .results::<Snap>()?
            .into_iter()
            .filter(|s| crate::storage::CHARGED_HERE.contains(&s.source.as_str()) || s.source == "domains")
            .map(|s| (s.day, s.workspace, s.source, s.cost_micros, s.charge_micros))
            .collect::<Vec<_>>();
        out.extend(pending_deltas(&snaps).into_iter().filter(|u| u.day.as_str() >= since).map(|mut u| {
            if internal.contains(&u.workspace) {
                u.given = Given { comped: u.value, ..Given::default() };
            }
            u
        }));
        // The plan's price, spread over the 30 days it pays for, so a month's
        // payment does not read as one very good day and 29 bad ones.
        #[derive(Deserialize)]
        struct Plan {
            day: String,
            workspace: String,
            micros: Option<i64>,
        }
        let plans = self
            .db
            .prepare(
                "SELECT substr(paid_at, 1, 10) AS day, workspace, SUM(amount_micros) AS micros FROM plan_payments
                 WHERE paid_at >= ?1 AND paid_at <= ?2 GROUP BY 1, 2",
            )
            .bind(&[day_before(since, PLAN_DAYS - 1).into(), end.as_str().into()])?
            .all()
            .await?
            .results::<Plan>()?;
        for p in plans {
            for (day, micros) in spread(&p.day, p.micros.unwrap_or(0), PLAN_DAYS) {
                if day.as_str() >= since && day.as_str() <= until {
                    out.push(UsageRow { day, workspace: p.workspace.clone(), key: "plan".into(), value: micros, cash: micros, cost: 0, given: Given::default() });
                }
            }
        }
        Ok(out)
    }

    /// Reconciles the days and writes `margin_days` and `workspace_costs`.
    async fn reconcile_range(&self, since: &str, until: &str) -> Result<u32> {
        let rules = self.rules().await?;
        #[derive(Deserialize)]
        struct Map {
            key: String,
            bucket: String,
        }
        let revenue_map: BTreeMap<String, String> = self
            .db
            .prepare("SELECT key, bucket FROM revenue_map")
            .all()
            .await?
            .results::<Map>()?
            .into_iter()
            .map(|m| (m.key, m.bucket))
            .collect();
        let lines = self
            .db
            .prepare("SELECT day, source, product, meter, quantity, cost_usd FROM cost_lines WHERE day >= ?1 AND day <= ?2")
            .bind(&[since.into(), until.into()])?
            .all()
            .await?
            .results::<LineRow>()?;
        let own = self
            .db
            .prepare("SELECT day, meter, workspace, quantity FROM own_counts WHERE day >= ?1 AND day <= ?2")
            .bind(&[since.into(), until.into()])?
            .all()
            .await?
            .results::<OwnRow>()?;
        let usage = self.usage_rows(since, until).await?;
        #[derive(Deserialize)]
        struct Internal {
            workspace: String,
        }
        let internal: BTreeSet<String> = self
            .db
            .prepare(format!("WITH i(workspace) AS ({}) SELECT DISTINCT workspace FROM i", crate::sales::INTERNAL_SQL))
            .all()
            .await?
            .results::<Internal>()?
            .into_iter()
            .map(|i| i.workspace)
            .collect();
        let (days, workspaces) = fold(&rules, &revenue_map, &lines, &own, &usage, &internal);
        let now = rfc3339(now_ms());
        self.db
            .batch(vec![
                self.db.prepare("DELETE FROM margin_days WHERE day >= ?1 AND day <= ?2").bind(&[since.into(), until.into()])?,
                self.db.prepare("DELETE FROM workspace_costs WHERE day >= ?1 AND day <= ?2").bind(&[since.into(), until.into()])?,
            ])
            .await?;
        for chunk in days.chunks(50) {
            let mut statements = Vec::with_capacity(chunk.len());
            for d in chunk {
                statements.push(
                    self.db
                        .prepare(
                            "INSERT OR REPLACE INTO margin_days (day, bucket, cf_cost_micros, own_cost_micros, value_micros, cash_micros, cf_quantity, own_quantity, given_micros, given_comped_micros, given_free_micros, given_trial_micros, given_pool_micros, given_discount_micros, computed_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        )
                        .bind(&[
                            d.day.as_str().into(),
                            d.bucket.as_str().into(),
                            (d.cf_cost_micros as f64).into(),
                            (d.own_cost_micros as f64).into(),
                            (d.value_micros as f64).into(),
                            (d.cash_micros as f64).into(),
                            d.cf_quantity.into(),
                            d.own_quantity.into(),
                            (d.given.total() as f64).into(),
                            (d.given.comped as f64).into(),
                            (d.given.free as f64).into(),
                            (d.given.trial as f64).into(),
                            (d.given.pool as f64).into(),
                            (d.given.discount as f64).into(),
                            now.as_str().into(),
                        ])?,
                );
            }
            self.db.batch(statements).await?;
        }
        for chunk in workspaces.chunks(50) {
            let mut statements = Vec::with_capacity(chunk.len());
            for w in chunk {
                statements.push(
                    self.db
                        .prepare("INSERT OR REPLACE INTO workspace_costs (day, workspace, bucket, cost_micros, revenue_micros, value_micros, given_micros) VALUES (?, ?, ?, ?, ?, ?, ?)")
                        .bind(&[
                            w.day.as_str().into(),
                            w.workspace.as_str().into(),
                            w.bucket.as_str().into(),
                            (w.cost as f64).into(),
                            (w.revenue as f64).into(),
                            (w.value as f64).into(),
                            (w.given.total() as f64).into(),
                        ])?,
                );
            }
            self.db.batch(statements).await?;
        }
        Ok(costs::days_between(since, until).len() as u32)
    }

    async fn margin_days(&self, since: &str, until: &str) -> Result<Vec<ProductDay>> {
        Ok(self
            .db
            .prepare("SELECT * FROM margin_days WHERE day >= ?1 AND day <= ?2 ORDER BY day, bucket")
            .bind(&[since.into(), until.into()])?
            .all()
            .await?
            .results::<MarginRow>()?
            .into_iter()
            .map(ProductDay::from)
            .collect())
    }

    /// What AI Gateway's lines over the days, and the runs settled in them,
    /// say about whether its cost is what the providers bill.
    async fn gateway_caveats(&self, since: &str, until: &str) -> Result<costs::GatewayCaveats> {
        #[derive(Deserialize)]
        struct Line {
            meter: String,
            quantity: f64,
            cost_usd: f64,
        }
        let lines: Vec<(String, f64, f64)> = self
            .db
            .prepare("SELECT meter, quantity, cost_usd FROM cost_lines WHERE source = ?1 AND day >= ?2 AND day <= ?3")
            .bind(&[costs::SOURCE_GATEWAY.into(), since.into(), until.into()])?
            .all()
            .await?
            .results::<Line>()?
            .into_iter()
            .map(|l| (l.meter, l.quantity, l.cost_usd))
            .collect();
        let mut caveats = costs::gateway_caveats(&lines);
        #[derive(Deserialize)]
        struct Short {
            n: Option<f64>,
        }
        caveats.short_runs = self
            .db
            .prepare("SELECT COUNT(*) AS n FROM runs WHERE gateway_note IS NOT NULL AND settled_at >= ?1 AND settled_at <= ?2")
            .bind(&[since.into(), format!("{until}T23:59:59.999Z").into()])?
            .first::<Short>(None)
            .await?
            .and_then(|s| s.n)
            .unwrap_or(0.0) as u32;
        Ok(caveats)
    }

    /// Drift over the last week, written to `cost_drift` (replacing the
    /// last run's), with unmapped Cloudflare meters as leaks.
    async fn find_drift(&self, until: &str) -> Result<Vec<(Drift, String)>> {
        let since = day_before(until, DRIFT_DAYS - 1);
        let settings = self.cost_settings().await?;
        let rules = self.rules().await?;
        let days = self.margin_days(&since, until).await?;
        let mut by: BTreeMap<String, Vec<ProductDay>> = BTreeMap::new();
        for d in days {
            by.entry(d.bucket.clone()).or_default().push(d);
        }
        let caveats = self.gateway_caveats(&since, until).await?;
        let mut found = Vec::new();
        if let Some(drift) = unpriced_drift(&caveats) {
            found.push(drift);
        }
        for (bucket, days) in &by {
            let bucket_rules: Vec<&Rule> = rules.iter().filter(|r| &r.bucket == bucket).collect();
            let threshold = bucket_rules.iter().map(|r| r.drift_percent).fold(f64::INFINITY, f64::min);
            let threshold = if threshold.is_finite() { threshold } else { 10.0 };
            let counted = bucket_rules.iter().any(|r| r.own_meter.is_some());
            for drift in drifts(bucket, days, threshold, counted, settings.min_daily_cost_micros) {
                let title = costs::bucket_title(bucket);
                let detail = match drift.kind {
                    DriftKind::Cost if NOT_CLOUDFLARE.contains(&bucket.as_str()) => models_detail(&drift, &caveats),
                    DriftKind::Count => format!(
                        "{title}: g1t counted {}, Cloudflare {} over the last {DRIFT_DAYS} days ({:+.1}%). Customers are charged for what g1t counts; check what Cloudflare counts as a unit and change the repos service's operation_mapping (set_operation_mapping).",
                        crate::features::thousands(drift.ours.max(0.0).round() as u64),
                        crate::features::thousands(drift.cloudflare.max(0.0).round() as u64),
                        drift.delta_percent.unwrap_or(0.0)
                    ),
                    DriftKind::Cost => format!(
                        "{title}: Cloudflare charged {} over the last {DRIFT_DAYS} days; the price book's cost of the same usage is {} ({:+.1}%). A price may be stale: see the proposals.",
                        dollars(drift.cloudflare as i64),
                        dollars(drift.ours as i64),
                        drift.delta_percent.unwrap_or(0.0)
                    ),
                    DriftKind::Leak if bucket == UNMAPPED => {
                        format!("Cloudflare charged {} for meters no mapping claims. Map them on Costs & margin.", dollars(drift.cloudflare as i64))
                    }
                    DriftKind::Leak if NOT_CLOUDFLARE.contains(&bucket.as_str()) => format!(
                        "{title}: AI Gateway priced g1t's own provider traffic at {} over the last {DRIFT_DAYS} days and the ledger has no model charge for it, not even a comped or free one: model calls with no billing run behind them (a run started without a ticket, or something else using g1t's gateway).",
                        dollars(drift.cloudflare as i64)
                    ),
                    DriftKind::Leak => format!(
                        "{title}: Cloudflare charged {} over the last {DRIFT_DAYS} days and customers were charged nothing for it.",
                        dollars(drift.cloudflare as i64)
                    ),
                    // Raised from the gateway's lines, not per bucket.
                    DriftKind::Unpriced => unpriced_detail(&caveats),
                };
                found.push((drift, detail));
            }
        }
        let now = rfc3339(now_ms());
        let mut statements = vec![self.db.prepare("DELETE FROM cost_drift")];
        for (drift, detail) in &found {
            statements.push(
                self.db
                    .prepare("INSERT OR REPLACE INTO cost_drift (bucket, kind, ours, cloudflare, delta_percent, detail, found_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
                    .bind(&[
                        drift.bucket.as_str().into(),
                        drift.kind.as_str().into(),
                        drift.ours.into(),
                        drift.cloudflare.into(),
                        drift.delta_percent.map_or(JsValue::NULL, JsValue::from),
                        detail.as_str().into(),
                        now.as_str().into(),
                    ])?,
            );
        }
        self.db.batch(statements).await?;
        Ok(found)
    }

    /// Unit costs from the bill for mappings that scale to g1t's own count
    /// (git operations), proposed to the price book.
    async fn measure_units(&self, until: &str) -> Result<u32> {
        #[derive(Deserialize)]
        struct Scaled {
            product: String,
            meter: String,
            price_meter: String,
            own_meter: String,
            unit: Option<String>,
        }
        let scaled = self
            .db
            .prepare(
                "SELECT m.product, m.meter, m.price_meter, m.own_meter, p.unit FROM cost_map m LEFT JOIN prices p ON p.meter = m.price_meter
                 WHERE m.scale_to_own = 1 AND m.price_meter IS NOT NULL AND m.own_meter IS NOT NULL",
            )
            .all()
            .await?
            .results::<Scaled>()?;
        let since = day_before(until, MEASURE_DAYS - 1);
        let rules = self.rules().await?;
        let mut proposed = 0;
        for s in scaled {
            #[derive(Deserialize)]
            struct Day {
                product: String,
                meter: String,
                quantity: f64,
                cost_usd: f64,
            }
            let lines = self
                .db
                .prepare("SELECT product, meter, quantity, cost_usd FROM cost_lines WHERE source = ?1 AND product = ?2 AND day >= ?3 AND day <= ?4")
                .bind(&[SOURCE_BILLABLE.into(), s.product.as_str().into(), since.as_str().into(), until.into()])?
                .all()
                .await?
                .results::<Day>()?;
            // Only the lines this very mapping claims.
            let mine: Vec<(f64, f64)> = lines
                .iter()
                .filter(|l| costs::classify(&rules, &l.product, &l.meter).is_some_and(|r| r.product == s.product && r.meter == s.meter))
                .map(|l| (l.quantity, l.cost_usd))
                .collect();
            let Some(rate) = billed_rate(&mine) else { continue };
            let cf_units: f64 = mine.iter().map(|(q, _)| q).sum();
            #[derive(Deserialize)]
            struct Own {
                total: Option<f64>,
            }
            let own_units = self
                .db
                .prepare("SELECT SUM(quantity) AS total FROM own_counts WHERE meter = ?1 AND day >= ?2 AND day <= ?3")
                .bind(&[s.own_meter.as_str().into(), since.as_str().into(), until.into()])?
                .first::<Own>(None)
                .await?
                .and_then(|o| o.total)
                .unwrap_or(0.0);
            let Some(per_unit) = derived_unit_cost(rate, cf_units, own_units) else { continue };
            let size = unit_size(s.unit.as_deref().unwrap_or("1"));
            let measured = per_unit * size * 1_000_000.0;
            let reason = format!(
                "Cloudflare billed ${:.4} per 1,000 of its units and counted {:.2} of them for each one g1t counted over the last {MEASURE_DAYS} days ({} against {})",
                rate * 1000.0,
                cf_units / own_units,
                crate::features::thousands(cf_units.round() as u64),
                crate::features::thousands(own_units.round() as u64)
            );
            if self.propose(&s.price_meter, measured, &reason, "reconciler").await?.is_some() {
                proposed += 1;
            }
        }
        Ok(proposed)
    }

    /// Opens, updates and closes margin alerts, and emails staff about new
    /// ones (and open ones each week).
    async fn raise_alerts(&self, env: &Env, until: &str, drift: &[(Drift, String)]) -> Result<u32> {
        let settings = self.cost_settings().await?;
        let since = day_before(until, u64::from(settings.alert_days.max(1)) - 1);
        let days = self.margin_days(&since, until).await?;
        let mut conditions: Vec<(String, String, String, String)> = Vec::new();
        // Each product under the floor.
        let mut by: BTreeMap<String, Vec<(String, i64, i64)>> = BTreeMap::new();
        let mut all: BTreeMap<String, (i64, i64)> = BTreeMap::new();
        for d in &days {
            let overall = all.entry(d.day.clone()).or_default();
            // What g1t gave away (comped workspaces, free periods, the
            // trial and the pools) is a budget it chose to spend, watched on
            // its own (budget.rs): not part of whether what is sold pays.
            overall.0 += d.cash_micros;
            overall.1 += (d.cost() - d.given.total()).max(0);
            if !OVERHEAD.contains(&d.bucket.as_str()) && d.bucket != UNMAPPED {
                by.entry(d.bucket.clone()).or_default().push((d.day.clone(), d.value_micros, d.cost()));
            }
        }
        let floor = settings.margin_floor_percent;
        let n = settings.alert_days as usize;
        for (bucket, series) in &by {
            if let Some((from, worst)) = breach(series, floor, n, settings.min_daily_cost_micros) {
                conditions.push((
                    "margin".into(),
                    bucket.clone(),
                    format!("{}: margin under {floor:.0}% for {n} days running, as low as {worst:.1}%.", costs::bucket_title(bucket)),
                    from,
                ));
            }
        }
        let series: Vec<(String, i64, i64)> = all.into_iter().map(|(day, (revenue, cost))| (day, revenue, cost)).collect();
        if let Some((from, worst)) = breach(&series, floor, n, settings.min_daily_cost_micros) {
            let tail = &series[series.len().saturating_sub(n)..];
            let (took, spent) = tail.iter().fold((0i64, 0i64), |(r, c), (_, revenue, cost)| (r + revenue, c + cost));
            conditions.push(("overall".into(), "g1t".into(), overall_detail(took, spent, n, floor, worst), from));
        }
        for (d, detail) in drift {
            let kind = if d.kind == DriftKind::Leak { "leak" } else { "drift" };
            conditions.push((kind.into(), format!("{}:{}", d.bucket, d.kind.as_str()), detail.clone(), until.to_owned()));
        }
        // Workspaces costing more than they pay.
        for (workspace, cost, revenue) in self.workspace_anomalies(until, &settings).await? {
            conditions.push((
                "workspace".into(),
                workspace.clone(),
                format!(
                    "{workspace} cost g1t {} on Cloudflare over {ANOMALY_DAYS} days, and its usage was priced at {}: its prices are below cost.",
                    dollars(cost),
                    dollars(revenue)
                ),
                day_before(until, ANOMALY_DAYS - 1),
            ));
        }

        let open = self
            .db
            .prepare("SELECT * FROM margin_alerts WHERE resolved_at IS NULL")
            .all()
            .await?
            .results::<AlertRow>()?;
        let now = now_ms();
        let stamp = rfc3339(now);
        let mut to_email: Vec<String> = Vec::new();
        let mut kept: BTreeSet<String> = BTreeSet::new();
        for (kind, subject, detail, from) in &conditions {
            match open.iter().find(|a| &a.kind == kind && &a.subject == subject) {
                Some(alert) => {
                    kept.insert(alert.id.clone());
                    self.db
                        .prepare("UPDATE margin_alerts SET detail = ? WHERE id = ?")
                        .bind(&[detail.as_str().into(), alert.id.as_str().into()])?
                        .run()
                        .await?;
                    let stale = alert
                        .emailed_at
                        .as_deref()
                        .and_then(g1t_contracts::time::parse_rfc3339)
                        .is_none_or(|at| now.saturating_sub(at) >= REMIND_MS);
                    if stale && kind != "workspace" {
                        to_email.push(format!("Still open: {detail}"));
                        kept.insert(format!("email:{}", alert.id));
                    }
                }
                None => {
                    let id = new_id("mal", now);
                    self.db
                        .prepare("INSERT INTO margin_alerts (id, kind, subject, detail, since, opened_at) VALUES (?, ?, ?, ?, ?, ?)")
                        .bind(&[id.as_str().into(), kind.as_str().into(), subject.as_str().into(), detail.as_str().into(), from.as_str().into(), stamp.as_str().into()])?
                        .run()
                        .await?;
                    kept.insert(id.clone());
                    // A workspace's is for Reach out, not the inbox.
                    if kind != "workspace" {
                        to_email.push(detail.clone());
                    }
                    kept.insert(format!("email:{id}"));
                }
            }
        }
        for alert in &open {
            if !kept.contains(&alert.id) {
                self.db
                    .prepare("UPDATE margin_alerts SET resolved_at = ? WHERE id = ?")
                    .bind(&[stamp.as_str().into(), alert.id.as_str().into()])?
                    .run()
                    .await?;
            }
        }
        let to = env.var("COSTS_ALERT_EMAIL").map(|v| v.to_string()).unwrap_or_default();
        if !to_email.is_empty() && !to.trim().is_empty() {
            let subject = format!("[g1t costs] {} margin alert{}", to_email.len(), if to_email.len() == 1 { "" } else { "s" });
            match email_staff(env, to.trim(), &subject, &to_email).await {
                Ok(()) => {
                    for marker in kept.iter().filter_map(|k| k.strip_prefix("email:")) {
                        self.db
                            .prepare("UPDATE margin_alerts SET emailed_at = ? WHERE id = ?")
                            .bind(&[stamp.as_str().into(), marker.into()])?
                            .run()
                            .await?;
                    }
                }
                Err(error) => worker::console_error!("could not email the margin alerts: {error}"),
            }
        }
        Ok(conditions.len() as u32)
    }

    /// Workspaces costing g1t more than they pay over 30 days, not g1t's own.
    /// Each day's cost shared out to comped workspaces.
    async fn workspace_anomalies(&self, until: &str, settings: &CostSettings) -> Result<Vec<(String, i64, i64)>> {
        #[derive(Deserialize)]
        struct Row {
            workspace: String,
            cost: Option<i64>,
            revenue: Option<i64>,
        }
        let rows = self
            .db
            .prepare(format!(
                // Against what its usage was priced at, not the cash it
                // paid: a trial or a gift paying for usage is not a price
                // below cost.
                // Days from before value_micros was kept have none: only days
                // since the first one that does are compared.
                "SELECT workspace, SUM(cost_micros) AS cost, SUM(value_micros) AS revenue FROM workspace_costs
                 WHERE day >= ?1 AND day <= ?2 AND workspace NOT IN ({})
                   AND day >= (SELECT MIN(day) FROM workspace_costs WHERE value_micros > 0)
                 GROUP BY workspace",
                crate::sales::INTERNAL_SQL
            ))
            .bind(&[day_before(until, ANOMALY_DAYS - 1).into(), until.into()])?
            .all()
            .await?
            .results::<Row>()?;
        let rows: Vec<(String, i64, i64)> = rows.into_iter().map(|r| (r.workspace, r.cost.unwrap_or(0), r.revenue.unwrap_or(0))).collect();
        Ok(anomalies(&rows, settings.anomaly_factor, settings.anomaly_floor_micros))
    }

    /// For Reach out: workspaces with an open cost-over-revenue alert,
    /// each with its detail and cost.
    pub(crate) async fn costing_more_than_they_pay(&self) -> Result<Vec<(String, String, i64)>> {
        let alerts = self
            .db
            .prepare("SELECT * FROM margin_alerts WHERE resolved_at IS NULL AND kind = 'workspace' ORDER BY opened_at DESC LIMIT 50")
            .all()
            .await?
            .results::<AlertRow>()?;
        let mut out = Vec::new();
        for alert in alerts {
            #[derive(Deserialize)]
            struct Cost {
                cost: Option<i64>,
            }
            let cost = self
                .db
                .prepare("SELECT SUM(cost_micros) AS cost FROM workspace_costs WHERE workspace = ? AND day >= ?")
                .bind(&[alert.subject.as_str().into(), alert.since.as_str().into()])?
                .first::<Cost>(None)
                .await?
                .and_then(|c| c.cost)
                .unwrap_or(0);
            out.push((alert.subject, alert.detail, cost));
        }
        Ok(out)
    }

    /// `admin_cost_alerts`: what sudo's banner says.
    pub(crate) async fn admin_cost_alerts(&self, _: AdminCostAlertsArgs) -> Result<Vec<MarginAlert>> {
        Ok(self
            .db
            .prepare("SELECT * FROM margin_alerts WHERE resolved_at IS NULL ORDER BY opened_at DESC LIMIT 50")
            .all()
            .await?
            .results::<AlertRow>()?
            .into_iter()
            .map(MarginAlert::from)
            .collect())
    }

    /// `admin_run_costs`: the daily run, now.
    pub(crate) async fn admin_run_costs(&self, env: &Env, a: AdminRunCostsArgs) -> Result<Outcome<CostsRun>> {
        let keeper = crate::keeper::Keeper::from_env(env);
        let run = self.costs_daily(env, &keeper).await?;
        if !a.by.is_empty() {
            self.audit(
                "costs",
                "costs_run",
                &format!("{} lines, {} days, {} proposals, {} alerts", run.lines, run.days, run.proposals, run.alerts),
                &a.by,
            )
            .await?;
        }
        Ok(Outcome::Ok(run))
    }

    /// `admin_set_cost_mapping`.
    pub(crate) async fn admin_set_cost_mapping(&self, a: AdminSetCostMappingArgs) -> Result<Outcome<CostMapping>> {
        let product = costs::slug(&a.product);
        let meter = if a.meter.trim() == "*" { "*".to_owned() } else { costs::slug(&a.meter) };
        if product.is_empty() || meter.is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Name Cloudflare's product and a meter (or * for all of it)."));
        }
        let now = rfc3339(now_ms());
        if a.remove {
            self.db
                .prepare("DELETE FROM cost_map WHERE product = ? AND meter = ?")
                .bind(&[product.as_str().into(), meter.as_str().into()])?
                .run()
                .await?;
            self.audit("costs", "cost_mapping_removed", &format!("{product}/{meter}"), &a.by).await?;
            return Ok(Outcome::Ok(CostMapping {
                product,
                meter,
                bucket: String::new(),
                price_meter: None,
                own_meter: None,
                scale_to_own: false,
                drift_percent: 0.0,
                note: String::new(),
                updated_at: now,
                updated_by: a.by,
            }));
        }
        let bucket = costs::slug(&a.bucket);
        if bucket.is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Say which of g1t's products it is a cost of."));
        }
        let clean = |v: Option<String>| v.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
        let (price_meter, own_meter) = (clean(a.price_meter), clean(a.own_meter));
        let drift = a.drift_percent.filter(|d| d.is_finite() && *d > 0.0).unwrap_or(10.0);
        self.db
            .prepare(
                "INSERT INTO cost_map (product, meter, bucket, price_meter, own_meter, scale_to_own, drift_percent, note, updated_at, updated_by)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT (product, meter) DO UPDATE SET bucket = ?3, price_meter = ?4, own_meter = ?5, scale_to_own = ?6,
                   drift_percent = ?7, note = ?8, updated_at = ?9, updated_by = ?10",
            )
            .bind(&[
                product.as_str().into(),
                meter.as_str().into(),
                bucket.as_str().into(),
                crate::optional(price_meter.as_deref()),
                crate::optional(own_meter.as_deref()),
                i32::from(a.scale_to_own).into(),
                drift.into(),
                a.note.trim().into(),
                now.as_str().into(),
                a.by.as_str().into(),
            ])?
            .run()
            .await?;
        self.audit("costs", "cost_mapping", &format!("{product}/{meter} → {bucket}"), &a.by).await?;
        Ok(Outcome::Ok(CostMapping {
            product,
            meter,
            bucket,
            price_meter,
            own_meter,
            scale_to_own: a.scale_to_own,
            drift_percent: drift,
            note: a.note.trim().to_owned(),
            updated_at: now,
            updated_by: a.by,
        }))
    }

    /// `admin_costs`: the Costs & margin page.
    pub(crate) async fn admin_costs(&self, a: AdminCostsArgs, configured: bool) -> Result<CostsReport> {
        let until = rfc3339(now_ms())[..10].to_owned();
        let span = u64::from(a.days.unwrap_or(30).clamp(7, 90));
        let since = day_before(&until, span - 1);
        let days = self.margin_days(&since, &until).await?;
        let rules = self.rules().await?;

        let mut products: BTreeMap<String, ProductMargin> = BTreeMap::new();
        let mut overall = OverallMargin::default();
        for d in &days {
            let p = products.entry(d.bucket.clone()).or_insert_with(|| ProductMargin {
                bucket: d.bucket.clone(),
                title: costs::bucket_title(&d.bucket),
                cost_source: if NOT_CLOUDFLARE.contains(&d.bucket.as_str()) { "ledger" } else { "cloudflare" }.into(),
                overhead: OVERHEAD.contains(&d.bucket.as_str()),
                ..ProductMargin::default()
            });
            p.cf_cost_micros += d.cf_cost_micros;
            p.own_cost_micros += d.own_cost_micros;
            p.value_micros += d.value_micros;
            p.cost_micros += d.cost();
            overall.cost_micros += d.cost();
            overall.given_micros += d.given.total();
            if NOT_CLOUDFLARE.contains(&d.bucket.as_str()) {
                overall.models_cost_micros += d.cost();
            } else {
                overall.cloudflare_cost_micros += d.cost();
            }
            overall.given_comped_micros += d.given.comped;
            overall.given_free_micros += d.given.free;
            overall.given_trial_micros += d.given.trial;
            overall.given_pool_micros += d.given.pool;
            overall.given_discount_micros += d.given.discount;
            let sold = (d.cost() - d.given.total()).max(0);
            if OVERHEAD.contains(&d.bucket.as_str()) {
                overall.plans_micros += d.cash_micros;
                overall.running_cost_micros += sold;
            } else if d.bucket == UNMAPPED {
                overall.usage_micros += d.cash_micros;
                overall.unmapped_cost_micros += sold;
            } else {
                overall.usage_micros += d.cash_micros;
                overall.usage_cost_micros += sold;
            }
        }
        for p in products.values_mut() {
            p.margin_micros = p.value_micros - p.cost_micros;
            p.margin_percent = margin_percent(p.value_micros, p.cost_micros);
        }
        let revenue = overall.usage_micros + overall.plans_micros;
        overall.margin_micros = revenue - overall.cost_micros;
        overall.margin_percent = margin_percent(revenue, overall.cost_micros);
        let sold = (overall.cost_micros - overall.given_micros).max(0);
        overall.sold_margin_micros = revenue - sold;
        overall.sold_margin_percent = margin_percent(revenue, sold);
        // The plan's included usage was paid for by the plan's price: it is
        // money in for the usage it covered, and out of what the plans
        // leave for running g1t.
        #[derive(Deserialize)]
        struct Included {
            micros: Option<i64>,
        }
        overall.included_micros = self
            .db
            .prepare(format!(
                "SELECT SUM(COALESCE(credit_micros, 0)) AS micros FROM ledger
                 WHERE kind = 'usage' AND created_at >= ?1 AND created_at <= ?2 AND workspace NOT IN ({})",
                crate::sales::INTERNAL_SQL
            ))
            .bind(&[since.as_str().into(), format!("{until}T23:59:59.999Z").into()])?
            .first::<Included>(None)
            .await?
            .and_then(|r| r.micros)
            .unwrap_or(0);
        let usage_in = overall.usage_micros + overall.included_micros;
        overall.usage_margin_micros = usage_in - overall.usage_cost_micros;
        overall.usage_margin_percent = margin_percent(usage_in, overall.usage_cost_micros);
        let mut products: Vec<ProductMargin> = products.into_values().collect();
        products.sort_by_key(|p| std::cmp::Reverse(p.cost_micros.max(p.value_micros)));

        #[derive(Deserialize)]
        struct DriftRow {
            bucket: String,
            kind: String,
            ours: f64,
            cloudflare: f64,
            delta_percent: Option<f64>,
            detail: String,
            found_at: String,
        }
        let drift = self
            .db
            .prepare("SELECT * FROM cost_drift ORDER BY kind, bucket")
            .all()
            .await?
            .results::<DriftRow>()?
            .into_iter()
            .map(|r| CostDrift {
                title: costs::bucket_title(&r.bucket),
                bucket: r.bucket,
                kind: r.kind,
                ours: r.ours,
                cloudflare: r.cloudflare,
                delta_percent: r.delta_percent,
                detail: r.detail,
                found_at: r.found_at,
            })
            .collect();

        #[derive(Deserialize)]
        struct Top {
            workspace: String,
            cost: Option<i64>,
            revenue: Option<i64>,
            given: Option<i64>,
            internal: i64,
        }
        let top_workspaces = self
            .db
            .prepare(format!(
                "SELECT workspace, SUM(cost_micros) AS cost, SUM(revenue_micros) AS revenue, SUM(given_micros) AS given,
                        CASE WHEN workspace IN ({}) THEN 1 ELSE 0 END AS internal
                 FROM workspace_costs WHERE day >= ?1 AND day <= ?2 GROUP BY workspace ORDER BY cost DESC LIMIT 15",
                crate::sales::INTERNAL_SQL
            ))
            .bind(&[since.as_str().into(), until.as_str().into()])?
            .all()
            .await?
            .results::<Top>()?
            .into_iter()
            .map(|t| WorkspaceCost { workspace: t.workspace, cost_micros: t.cost.unwrap_or(0), revenue_micros: t.revenue.unwrap_or(0), given_micros: t.given.unwrap_or(0), internal: t.internal == 1 })
            .collect();

        #[derive(Deserialize)]
        struct Summary {
            source: String,
            product: String,
            meter: String,
            raw_name: String,
            unit: String,
            quantity: f64,
            cost_usd: f64,
        }
        let lines = self
            .db
            .prepare(
                "SELECT source, product, meter, MAX(raw_name) AS raw_name, MAX(unit) AS unit, SUM(quantity) AS quantity, SUM(cost_usd) AS cost_usd
                 FROM cost_lines WHERE day >= ?1 AND day <= ?2 GROUP BY source, product, meter ORDER BY cost_usd DESC, product, meter LIMIT 200",
            )
            .bind(&[since.as_str().into(), until.as_str().into()])?
            .all()
            .await?
            .results::<Summary>()?
            .into_iter()
            .map(|l| CostLineSummary {
                bucket: costs::classify(&rules, &l.product, &l.meter).map(|r| r.bucket.clone()),
                product: l.product,
                meter: l.meter,
                raw_name: l.raw_name,
                unit: l.unit,
                source: l.source,
                quantity: l.quantity,
                cost_micros: micros(l.cost_usd),
            })
            .collect();

        #[derive(Deserialize)]
        struct MapRow {
            product: String,
            meter: String,
            bucket: String,
            price_meter: Option<String>,
            own_meter: Option<String>,
            scale_to_own: i64,
            drift_percent: f64,
            note: String,
            updated_at: String,
            updated_by: String,
        }
        let mappings = self
            .db
            .prepare("SELECT * FROM cost_map ORDER BY product, meter")
            .all()
            .await?
            .results::<MapRow>()?
            .into_iter()
            .map(|m| CostMapping {
                product: m.product,
                meter: m.meter,
                bucket: m.bucket,
                price_meter: m.price_meter,
                own_meter: m.own_meter,
                scale_to_own: m.scale_to_own == 1,
                drift_percent: m.drift_percent,
                note: m.note,
                updated_at: m.updated_at,
                updated_by: m.updated_by,
            })
            .collect();

        #[derive(Deserialize)]
        struct Fetched {
            at: Option<String>,
        }
        let fetched_at = self.db.prepare("SELECT MAX(fetched_at) AS at FROM cost_lines").first::<Fetched>(None).await?.and_then(|f| f.at);

        Ok(CostsReport {
            configured,
            fetched_at,
            days: days
                .iter()
                .map(|d| CostDay {
                    day: d.day.clone(),
                    bucket: d.bucket.clone(),
                    cf_cost_micros: d.cf_cost_micros,
                    own_cost_micros: d.own_cost_micros,
                    value_micros: d.value_micros,
                    cash_micros: d.cash_micros,
                })
                .collect(),
            since,
            until,
            products,
            overall,
            drift,
            alerts: self.admin_cost_alerts(AdminCostAlertsArgs {}).await?,
            proposals: self.proposals().await?,
            versions: self.versions().await?,
            top_workspaces,
            lines,
            mappings,
            settings: self.cost_settings().await?,
            caps: self.spend_caps().await?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_nothing_paid_for_is_valued_at_price_and_paid_usage_at_what_was_paid() {
        // A free period: charged nothing, drawn from nothing.
        assert_eq!(usage_value(false, 1_000_000, 0, 20), 1_200_000);
        // Charged, or drawn from a trial: what was paid.
        assert_eq!(usage_value(false, 1_000_000, 1_200_000, 20), 1_200_000);
        assert_eq!(usage_value(false, 1_000_000, 900_000, 20), 900_000);
        // g1t's own: at price.
        assert_eq!(usage_value(true, 1_000_000, 0, 20), 1_200_000);
        // No cost, nothing paid: nothing.
        assert_eq!(usage_value(false, 0, 0, 20), 0);
    }

    #[test]
    fn the_overall_alert_says_dollars_while_little_comes_in() {
        let small = overall_detail(90_000, 7_500_000, 3, 10.0, -8239.7);
        assert!(small.contains("took in $0.09 against $7.50"), "{small}");
        assert!(!small.contains('%'), "{small}");
        let real = overall_detail(30_000_000, 40_000_000, 3, 10.0, -33.3);
        assert!(real.contains("as low as -33.3%"), "{real}");
    }

    fn rule(product: &str, meter: &str, bucket: &str, own: Option<&str>) -> Rule {
        Rule { product: product.into(), meter: meter.into(), bucket: bucket.into(), price_meter: None, own_meter: own.map(Into::into), drift_percent: 10.0 }
    }

    fn rules() -> Vec<Rule> {
        vec![
            rule("containers", "*", "sandboxes", None),
            rule("workers", "*", "platform", None),
            rule("artifacts", "*", "git", Some("git_operations")),
            rule("artifacts", "events_", "git", Some("git_operations")),
        ]
    }

    fn revenue_map() -> BTreeMap<String, String> {
        [("sandbox", "sandboxes"), ("git", "git"), ("plan", "platform")].iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    fn line(day: &str, source: &str, product: &str, meter: &str, quantity: f64, cost: f64) -> LineRow {
        LineRow { day: day.into(), source: source.into(), product: product.into(), meter: meter.into(), quantity, cost_usd: cost }
    }

    fn usage(day: &str, workspace: &str, key: &str, value: i64, cash: i64, cost: i64) -> UsageRow {
        UsageRow { day: day.into(), workspace: workspace.into(), key: key.into(), value, cash, cost, given: Given::default() }
    }

    #[test]
    fn a_day_puts_the_bill_g1ts_counts_and_charges_side_by_side() {
        let lines = vec![
            line("2026-10-15", SOURCE_BILLABLE, "containers", "container_memory", 1000.0, 2.00),
            line("2026-10-15", SOURCE_BILLABLE, "artifacts", "artifacts_operations", 30_000.0, 3.00),
            // Artifacts' own events: not used while the bill has a count.
            line("2026-10-15", SOURCE_ARTIFACTS, "artifacts", "events_pull", 29_000.0, 0.0),
            line("2026-10-15", SOURCE_BILLABLE, "workers", "workers_cpu_ms", 1.0, 0.50),
            line("2026-10-15", SOURCE_BILLABLE, "browser_rendering", "browser_hours", 2.0, 0.25),
        ];
        let own = vec![
            OwnRow { day: "2026-10-15".into(), meter: "git_operations".into(), workspace: "acme".into(), quantity: 7_500.0 },
            OwnRow { day: "2026-10-15".into(), meter: "git_operations".into(), workspace: "beta".into(), quantity: 2_500.0 },
        ];
        let usage = vec![
            usage("2026-10-15", "acme", "sandbox", 2_400_000, 1_000_000, 2_000_000),
            usage("2026-10-15", "beta", "sandbox", 1_200_000, 1_200_000, 1_000_000),
            usage("2026-10-15", "acme", "git", 600_000, 600_000, 500_000),
            usage("2026-10-15", "acme", "implement", 120_000, 120_000, 100_000),
            usage("2026-10-15", "beta", "plan", 20_000_000, 20_000_000, 0),
        ];
        let (days, workspaces) = fold(&rules(), &revenue_map(), &lines, &own, &usage, &BTreeSet::new());
        let get = |bucket: &str| days.iter().find(|d| d.bucket == bucket).unwrap();
        let sandboxes = get("sandboxes");
        assert_eq!((sandboxes.cf_cost_micros, sandboxes.own_cost_micros, sandboxes.value_micros, sandboxes.cash_micros), (2_000_000, 3_000_000, 3_600_000, 2_200_000));
        let git = get("git");
        assert_eq!(git.cf_cost_micros, 3_000_000);
        assert_eq!((git.cf_quantity, git.own_quantity), (30_000.0, 10_000.0));
        assert_eq!(get("platform").value_micros, 20_000_000);
        // Not mapped: a leak until someone maps it.
        assert_eq!(get(UNMAPPED).cf_cost_micros, 250_000);
        // Models: no Cloudflare line, their cost is g1t's own.
        assert_eq!(get("models").cost(), 100_000);
        // Git's cost shared by g1t's own counts (Cloudflare gave none per
        // workspace here): three quarters to acme.
        let share = |ws: &str, bucket: &str| workspaces.iter().find(|w| w.workspace == ws && w.bucket == bucket).map(|w| (w.cost, w.revenue));
        assert_eq!(share("acme", "git"), Some((2_250_000, 600_000)));
        assert_eq!(share("beta", "git"), Some((750_000, 0)));
        // Every bucket's cost is shared out exactly.
        for d in &days {
            let shared: i64 = workspaces.iter().filter(|w| w.bucket == d.bucket).map(|w| w.cost).sum();
            assert_eq!(shared, d.cost(), "{}", d.bucket);
        }
    }

    #[test]
    fn artifacts_events_count_when_the_bill_does_not() {
        let lines = vec![
            line("2026-10-05", SOURCE_ARTIFACTS, "artifacts", "events_pull", 120.0, 0.0),
            line("2026-10-05", SOURCE_ARTIFACTS, "artifacts", "events_push", 30.0, 0.0),
            line("2026-10-05", SOURCE_ARTIFACTS, "artifacts", "events_ratelimited", 9.0, 0.0),
        ];
        let (days, _) = fold(&rules(), &revenue_map(), &lines, &[], &[], &BTreeSet::new());
        assert_eq!(days[0].cf_quantity, 150.0);
        assert_eq!(days[0].cf_cost_micros, 0);
    }

    #[test]
    fn month_end_meters_are_told_by_the_day_from_snapshots() {
        let snap = |day: &str, cost: i64, charge: i64| (day.to_string(), "acme".to_string(), "git".to_string(), cost, charge);
        let rows = pending_deltas(&[snap("2026-10-30", 100, 120), snap("2026-10-31", 250, 300), snap("2026-11-01", 40, 48), snap("2026-11-02", 40, 48)]);
        assert_eq!(
            rows.iter().map(|r| (r.day.as_str(), r.cost, r.value)).collect::<Vec<_>>(),
            vec![("2026-10-30", 100, 120), ("2026-10-31", 150, 180), ("2026-11-01", 40, 48)]
        );
    }

    #[test]
    fn a_plan_payment_is_spread_over_the_month_it_pays_for() {
        let days = spread("2026-10-01T00:00:00.000Z", 20_000_000, 30);
        assert_eq!(days.len(), 30);
        assert_eq!(days[0], ("2026-10-01".to_string(), 666_667));
        assert_eq!(days[29], ("2026-10-30".to_string(), 666_666));
        assert_eq!(days.iter().map(|d| d.1).sum::<i64>(), 20_000_000);
        assert!(spread("2026-10-01", 0, 30).is_empty());
        assert_eq!(dollars(17_024_000), "$17.02");
        assert_eq!(dollars(-27_668_620), "-$27.67");
        assert_eq!(dollars(63_000), "$0.063");
    }

    #[test]
    fn margins_and_deltas() {
        assert_eq!(margin_percent(1_200_000, 1_000_000).map(|m| (m * 100.0).round() / 100.0), Some(16.67));
        assert_eq!(margin_percent(0, 5), None);
        assert_eq!(delta_percent(110.0, 100.0), Some(10.0));
        assert_eq!(delta_percent(1.0, 0.0), None);
    }

    fn day(bucket: &str, cf: i64, own: i64, value: i64, cfq: f64, ownq: f64) -> ProductDay {
        ProductDay { day: "2026-10-15".into(), bucket: bucket.into(), cf_cost_micros: cf, own_cost_micros: own, value_micros: value, cash_micros: value, cf_quantity: cfq, own_quantity: ownq, given: Given::default() }
    }

    #[test]
    fn counts_more_than_the_threshold_apart_are_drift() {
        // Cloudflare counted 30,000 operations where g1t counted 10,000:
        // binding reads, perhaps. -66.7%.
        let drift = drifts("git", &[day("git", 3_000_000, 1_500_000, 1_800_000, 30_000.0, 10_000.0)], 10.0, true, 100_000);
        assert_eq!(drift.iter().map(|d| d.kind).collect::<Vec<_>>(), vec![DriftKind::Count, DriftKind::Cost]);
        assert!((drift[0].delta_percent.unwrap() + 66.666).abs() < 0.01);
        // 9% apart: within 10%.
        assert!(drifts("git", &[day("git", 1_000_000, 1_000_000, 1_200_000, 10_000.0, 10_900.0)], 10.0, true, 100_000).is_empty());
        // Uncounted products have no count drift.
        assert!(drifts("sandboxes", &[day("sandboxes", 1_000_000, 1_050_000, 1_200_000, 5.0, 0.0)], 10.0, false, 100_000).is_empty());
    }

    #[test]
    fn cost_with_no_revenue_is_a_leak_but_not_for_running_g1t() {
        let leak = drifts("actions_cache", &[day("actions_cache", 400_000, 0, 0, 0.0, 0.0)], 10.0, false, 100_000);
        assert_eq!(leak.len(), 1);
        assert_eq!(leak[0].kind, DriftKind::Leak);
        assert!(drifts("platform", &[day("platform", 5_000_000, 0, 0, 0.0, 0.0)], 10.0, false, 100_000).is_empty());
        // Pennies say nothing.
        assert!(drifts("actions_cache", &[day("actions_cache", 50_000, 0, 0, 0.0, 0.0)], 10.0, false, 100_000).is_empty());
        assert!(drifts(UNMAPPED, &[day(UNMAPPED, 250_000, 0, 0, 0.0, 0.0)], 10.0, false, 100_000)[0].kind == DriftKind::Leak);
    }

    #[test]
    fn a_margin_alert_needs_n_days_in_a_row_under_the_floor() {
        let s = |d: &str, revenue: i64, cost: i64| (d.to_string(), revenue, cost);
        // 5%, 0%, -20%: three days under 10%.
        let series = vec![s("10-13", 1_200_000, 1_000_000), s("10-14", 1_050_000, 1_000_000), s("10-15", 1_000_000, 1_000_000), s("10-16", 1_000_000, 1_200_000)];
        let (from, worst) = breach(&series, 10.0, 3, 100_000).unwrap();
        assert_eq!(from, "10-14");
        assert!((worst + 20.0).abs() < 1e-9);
        // A good day in the window clears it.
        let mended = vec![s("10-14", 1_050_000, 1_000_000), s("10-15", 1_300_000, 1_000_000), s("10-16", 1_000_000, 1_200_000)];
        assert!(breach(&mended, 10.0, 3, 100_000).is_none());
        // Cost with no revenue at all is the worst margin there is.
        assert_eq!(breach(&[s("10-16", 0, 500_000)], 10.0, 1, 100_000).unwrap().1, -100.0);
        // Too little cost to judge.
        assert!(breach(&[s("10-16", 0, 5_000)], 10.0, 1, 100_000).is_none());
        assert!(breach(&series, 10.0, 9, 100_000).is_none());
    }

    #[test]
    fn shared_costs_add_up_to_the_bill() {
        let w = |k: &str, v: f64| (k.to_string(), v);
        assert_eq!(attribute(100, &[w("a", 1.0), w("b", 1.0), w("c", 1.0)]), vec![("a".into(), 34), ("b".into(), 33), ("c".into(), 33)]);
        assert_eq!(attribute(10, &[w("a", 3.0), w("b", 1.0), w("a", 0.0)]), vec![("a".into(), 8), ("b".into(), 2)]);
        assert!(attribute(10, &[w("a", 0.0)]).is_empty());
        assert!(attribute(0, &[w("a", 1.0)]).is_empty());
    }

    #[test]
    fn counts_are_compared_from_the_day_g1t_started_counting() {
        let on = |day: &str, cf: f64, own: f64| ProductDay { day: day.into(), bucket: "git".into(), cf_quantity: cf, own_quantity: own, ..ProductDay::default() };
        // Five days of Cloudflare's count before g1t's meter, then two that match.
        let days = vec![on("2026-10-01", 500.0, 0.0), on("2026-10-05", 300.0, 0.0), on("2026-10-06", 210.0, 231.0), on("2026-10-07", 450.0, 458.0)];
        assert!(drifts("git", &days, 10.0, true, 0).iter().all(|d| d.kind != DriftKind::Count));
        // A real gap on the days both counted still shows.
        let days = vec![on("2026-10-01", 500.0, 0.0), on("2026-10-06", 400.0, 231.0), on("2026-10-07", 600.0, 300.0)];
        let found = drifts("git", &days, 10.0, true, 0);
        let count = found.iter().find(|d| d.kind == DriftKind::Count).unwrap();
        assert_eq!((count.ours, count.cloudflare), (531.0, 1000.0));
        // A meter that never counted is compared over every day.
        let days = vec![on("2026-10-06", 400.0, 0.0)];
        assert!(drifts("git", &days, 10.0, true, 0).iter().any(|d| d.kind == DriftKind::Count));
    }

    #[test]
    fn what_g1t_gives_away_is_kept_apart_from_what_it_sells() {
        let map = BTreeMap::new();
        // A comped workspace (all of it given), one in its trial (half paid
        // by the trial) and one paying in cash, all on models.
        let comped = usage("2026-10-15", "flagon", "agent", 1_200_000, 0, 1_000_000);
        let mut trial = usage("2026-10-15", "acme", "agent", 1_200_000, 600_000, 1_000_000);
        trial.given = Given { trial: 600_000, ..Given::default() };
        let paying = usage("2026-10-15", "beta", "agent", 1_200_000, 1_200_000, 1_000_000);
        // Nothing priced that day: free use.
        let free = usage("2026-10-15", "gamma", "agent", 0, 0, 1_000_000);
        let internal = BTreeSet::from(["flagon".to_string()]);
        let (days, workspaces) = fold(&[], &map, &[], &[], &[comped, trial, paying, free], &internal);
        let models = days.iter().find(|d| d.bucket == "models").unwrap();
        assert_eq!(models.cost(), 4_000_000);
        assert_eq!(models.given, Given { comped: 1_000_000, free: 1_000_000, trial: 500_000, pool: 0, discount: 0 });
        let given = |w: &str| workspaces.iter().find(|x| x.workspace == w).unwrap().given.total();
        assert_eq!((given("flagon"), given("acme"), given("beta"), given("gamma")), (1_000_000, 500_000, 0, 1_000_000));
    }

    #[test]
    fn a_discounted_sale_keeps_its_margin_and_counts_the_discount_as_given() {
        // $1 of model cost at 20%, sold to an account with 30% off: charged
        // $0.84, and $0.36 below cost plus the margin given (as usage_rows
        // reads the ledger: value at price, the discount part given).
        let mut sale = usage("2026-10-15", "acme", "agent", 1_200_000, 840_000, 1_000_000);
        sale.given = Given { discount: 360_000, ..Given::default() };
        let (days, _) = fold(&[], &BTreeMap::new(), &[], &[], &[sale], &BTreeSet::new());
        let models = days.iter().find(|d| d.bucket == "models").unwrap();
        assert_eq!(models.value_micros, 1_200_000);
        assert_eq!(models.given, Given { discount: 300_000, ..Given::default() });
        // What was sold (cost less given) still makes the margin.
        let sold = models.cost() - models.given.total();
        assert_eq!(margin_percent(models.cash_micros, sold).map(|m| m.round()), Some(17.0));
    }

    #[test]
    fn the_gateways_total_against_the_ledgers_model_cost_is_drift() {
        // The gateway priced $5 of g1t's own traffic; the ledger has $3.
        let short = drifts("models", &[day("models", 5_000_000, 3_000_000, 3_600_000, 0.0, 0.0)], 10.0, false, 100_000);
        assert_eq!(short.iter().map(|d| d.kind).collect::<Vec<_>>(), vec![DriftKind::Cost]);
        assert!((short[0].delta_percent.unwrap() + 40.0).abs() < 1e-9);
        // Gateway traffic with nothing on the ledger at all: cost drift and a leak.
        let none = drifts("models", &[day("models", 2_000_000, 0, 0, 0.0, 0.0)], 10.0, false, 100_000);
        assert_eq!(none.iter().map(|d| d.kind).collect::<Vec<_>>(), vec![DriftKind::Cost, DriftKind::Leak]);
        // Within the threshold: nothing.
        assert!(drifts("models", &[day("models", 1_050_000, 1_000_000, 1_200_000, 0.0, 0.0)], 10.0, false, 100_000).is_empty());
        // The gateway priced nothing against a ledger that has model cost:
        // not agreement (a token that cannot see AI Gateway reads as no
        // rows), so it is said. Under the minimum, or no model cost: nothing.
        let silent = drifts("models", &[day("models", 0, 1_000_000, 1_200_000, 0.0, 0.0)], 10.0, false, 100_000);
        assert_eq!(silent, vec![Drift { bucket: "models".into(), kind: DriftKind::Cost, ours: 1_000_000.0, cloudflare: 0.0, delta_percent: None }]);
        let said = models_detail(&silent[0], &costs::GatewayCaveats::default());
        assert!(said.contains("$1.00") && said.contains("priced nothing") && said.contains("AI Gateway: Read"), "{said}");
        assert!(drifts("models", &[day("models", 0, 50_000, 60_000, 0.0, 0.0)], 10.0, false, 100_000).is_empty());
        assert!(drifts("models", &[day("models", 0, 0, 0, 0.0, 0.0)], 10.0, false, 100_000).is_empty());
        // The detail says which way and why it may be off.
        let caveats = costs::GatewayCaveats { cache_read_tokens: 3_000_000.0, unpriced: vec!["anthropic_claude_new_1".into()], ..Default::default() };
        let detail = models_detail(&short[0], &caveats);
        assert!(detail.contains("$5.00") && detail.contains("$3.00") && detail.contains("were not charged"), "{detail}");
        assert!(detail.contains("3,000,000 prompt-cache read") && detail.contains("no price for anthropic_claude_new_1"), "{detail}");
    }

    #[test]
    fn model_usage_the_gateway_cannot_price_is_drift_even_when_the_totals_agree() {
        assert!(unpriced_drift(&costs::GatewayCaveats::default()).is_none());
        // Cache tokens alone are a note on the cost drift, not drift.
        assert!(unpriced_drift(&costs::GatewayCaveats { cache_write_tokens: 10.0, ..Default::default() }).is_none());
        let (drift, detail) = unpriced_drift(&costs::GatewayCaveats { unpriced: vec!["anthropic_claude_new_1".into()], short_runs: 2, ..Default::default() }).unwrap();
        assert_eq!((drift.bucket.as_str(), drift.kind.as_str()), ("models", "unpriced"));
        assert!(detail.contains("no price for anthropic_claude_new_1") && detail.contains("2 runs were settled"), "{detail}");
    }

    #[test]
    fn a_workspace_that_costs_more_than_it_pays_is_flagged() {
        let rows = vec![("acme".to_string(), 5_000_000, 1_000_000), ("beta".to_string(), 900_000, 0), ("gamma".to_string(), 2_000_000, 3_000_000)];
        let found = anomalies(&rows, 1.0, 1_000_000);
        assert_eq!(found, vec![("acme".to_string(), 5_000_000, 1_000_000)]);
        // At twice its revenue as the threshold, $5 against $3 is fine.
        assert!(anomalies(&[("acme".to_string(), 5_000_000, 3_000_000)], 2.0, 1_000_000).is_empty());
    }

    #[test]
    fn a_git_operation_costs_what_cloudflare_counts_for_it() {
        // $0.15 per 1,000 of Cloudflare's operations, on the charged days.
        let rate = billed_rate(&[(10_000.0, 0.0), (20_000.0, 3.0), (30_000.0, 4.5), (5_000.0, 0.75)]).unwrap();
        assert!((rate - 0.000_15).abs() < 1e-12);
        // Cloudflare counted 3 for every 1 g1t did: binding reads count.
        let per_op = derived_unit_cost(rate, 300_000.0, 100_000.0).unwrap();
        let per_thousand_micros = per_op * unit_size("1,000 operations") * 1e6;
        assert!((per_thousand_micros - 450_000.0).abs() < 1e-6, "{per_thousand_micros}");
        // Too few of g1t's units to say.
        assert!(derived_unit_cost(rate, 3_000.0, 500.0).is_none());
        assert!(billed_rate(&[(10_000.0, 0.0)]).is_none());
        assert_eq!(unit_size("million requests"), 1e6);
        assert_eq!(unit_size("second"), 1.0);
    }
}
