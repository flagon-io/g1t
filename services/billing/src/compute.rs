//! Whether a workspace may start compute, and holding what it may cost.
//!
//! Every service that starts something that costs g1t real money asks
//! here first (see `g1t_contracts::billing::ReserveArgs`):
//!
//! - **`entitlements`**: the workspace's plan, whether it may start compute
//!   at all, its caps (agents at once, a run's time and spend, an issue's
//!   spend), its ceiling and exposure, and whether compute is paused.
//! - **`reserve`**: holds the work's estimated cost against what may pay
//!   for it (the plan's included usage, the trial, the open-source pool,
//!   then on-demand room under the ceiling and the spend limit), so starts
//!   at the same moment cannot overshoot together. Answers who pays first,
//!   or refuses with a stable code and a message for the owner.
//! - **`settle`**: releases the hold. The charge itself goes on the ledger
//!   the usual way; a hold never settled lapses after three hours.
//!
//! **No card, no compute.** A free workspace's forge is free, but compute
//! needs the plan, or a card check: it unlocks the one-time trial and g1t's
//! open-source pool (checks, workflows and the merge queue on public
//! repositories). The card check is what keeps g1t's free compute from
//! being mined: one trial per card, and a real person behind each.
//!
//! **Spikes.** An hour's spend above `SPIKE_FACTOR` (5) times the
//! workspace's usual hour over the last week, and at least
//! `SPIKE_FLOOR_MICROS` ($5), pauses new compute until an owner answers:
//! keep going (for 24 hours, or until the hour's spend doubles again) or
//! stop. Runs already under way finish. g1t's own workspaces are watched
//! but never paused.

use g1t_contracts::billing::{
    ComputeKind, ConfirmSpikeArgs, SetCapsArgs, Entitlements, EntitlementsArgs, LimitState, PaidBy, PlanKind, Reservation,
    ReserveArgs, SettleArgs, Spike, UNLIMITED_MICROS, UsageAlert, RESERVATION_HOURS,
};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, Role, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Billing;
use crate::credits::{self, left};
use crate::features::dollars;
use crate::limits::alert_level;

/// Agents at once in the first month or on the trial, and after.
pub(crate) const FIRST_MONTH_AGENTS: u32 = 2;
pub(crate) const AGENTS: u32 = 10;
/// The longest run in the first month or on the trial, in minutes.
pub(crate) const FIRST_MONTH_MINUTES: u32 = 60;
/// How long "keep going" lifts a spike's pause.
const KEEP_GOING_MS: u64 = 24 * 60 * 60 * 1000;
/// The week a usual hour is measured over.
const WEEK_HOURS: i64 = 7 * 24;

/// What may pay for reserved work, at price, in the order it pays.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Room {
    pub credit: i64,
    pub trial: i64,
    pub oss: i64,
    /// Under the ceiling and the spend limit; None: no bound (g1t's own).
    pub on_demand: Option<i64>,
}

/// Why `place` could not hold an estimate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Short {
    /// Nothing left that pays for it.
    Empty,
    /// Some room, but less than a paid workspace's whole estimate.
    TooSmall,
}

/// Where a new hold of `estimate` goes, given what open holds take
/// (`held`): the source that pays first, and what to hold. Holds fill the
/// sources in order, so the first source with room after them pays first.
/// A paid workspace's whole estimate must fit, so the ceiling cannot be
/// overshot; a free workspace may use its last bit of trial, and what the
/// run costs past it is g1t's.
pub(crate) fn place(room: &Room, held: i64, estimate: i64, whole: bool) -> std::result::Result<(PaidBy, i64), Short> {
    let sources = [
        (PaidBy::Credit, room.credit.max(0)),
        (PaidBy::Trial, room.trial.max(0)),
        (PaidBy::Oss, room.oss.max(0)),
    ];
    let pools: i64 = sources.iter().map(|(_, room)| room).sum();
    let remaining = match room.on_demand {
        None => i64::MAX,
        Some(on_demand) => pools + on_demand.max(0) - held.max(0),
    };
    if remaining <= 0 {
        return Err(Short::Empty);
    }
    let estimate = estimate.max(0);
    if whole && estimate > remaining {
        return Err(Short::TooSmall);
    }
    let hold = estimate.min(remaining);
    let mut end = 0;
    for (source, size) in sources {
        end += size;
        if held.max(0) < end {
            return Ok((source, hold));
        }
    }
    Ok((PaidBy::OnDemand, hold))
}

/// Whether the last hour is a spike: above `factor` times the usual hour,
/// and at least `floor`.
pub(crate) fn is_spike(last_hour: i64, usual_hour: i64, factor: i64, floor: i64) -> bool {
    last_hour >= floor.max(1) && last_hour > usual_hour.max(0) * factor
}

/// Whether a spike an owner said to keep going on still lets work start:
/// within its 24 hours, and the hour's spend not doubled again.
pub(crate) fn still_continued(until: Option<&str>, now: &str, hour_at_spike: i64, last_hour: i64) -> bool {
    until.is_some_and(|until| now < until) && last_hour < hour_at_spike.max(1) * 2
}

/// A workspace's caps, from its plan.
pub(crate) fn caps(plan: PlanKind, first_month: bool, on_trial: bool, agents: Option<u32>) -> (u32, u32) {
    let tight = first_month || (plan == PlanKind::Free && on_trial) || plan == PlanKind::Free;
    let default_agents = if tight { FIRST_MONTH_AGENTS } else { AGENTS };
    let minutes = if tight { FIRST_MONTH_MINUTES } else { g1t_contracts::guardrails::MAX_MINUTES };
    (agents.unwrap_or(default_agents), minutes)
}

/// The refusal for a start that cannot be held, with what to do.
pub(crate) fn refusal(code: FailureCode, workspace: &str, kind: ComputeKind, detail: &str) -> Outcome<Reservation> {
    let link = format!("/{workspace}/-/billing");
    let what = match kind {
        ComputeKind::Agent => "Agents",
        ComputeKind::Check => "Checks",
        ComputeKind::Workflow => "Workflows",
        ComputeKind::Queue => "The merge queue",
        ComputeKind::Deploy => "Deployments",
        ComputeKind::Embedding => "Semantic search",
    };
    let message = match code {
        FailureCode::NotPaid if kind.open_source_pool() => format!(
            "{what} run in g1t's sandboxes, which cost real money, so they need the g1t plan ($20 a month) or a card check. A card check gives public repositories g1t's open-source pool and starts the $5 trial; it is never charged. Both are at {link}."
        ),
        FailureCode::NotPaid => format!(
            "{what} cost real money to run, so they need the g1t plan ($20 a month, with $10 of usage included) or the one-time $5 trial, which starts with a card check that is never charged. Both are at {link}."
        ),
        FailureCode::TrialUsed => format!(
            "This workspace has used its $5 trial. Start the g1t plan ($20 a month, with $10 of usage included) to keep going: {link}."
        ),
        FailureCode::OssPoolEmpty => format!(
            "g1t's open-source pool for this month is used up{detail}, so checks and workflows on public repositories wait until the 1st. The g1t plan runs them now: {link}."
        ),
        FailureCode::Limit => format!("{detail} An owner can raise the limit, prepay, or ask g1t for more at {link}."),
        FailureCode::Paused => format!("New compute is paused: {detail} An owner can see why and answer at {link}."),
        _ => detail.to_owned(),
    };
    Outcome::fail(code, message)
}

#[derive(Deserialize)]
struct SpikeRow {
    id: String,
    status: String,
    hour_micros: i64,
    average_micros: i64,
    detected_at: String,
    decided_by: Option<String>,
    decided_at: Option<String>,
    until: Option<String>,
}

impl From<SpikeRow> for Spike {
    fn from(row: SpikeRow) -> Self {
        Spike {
            id: row.id,
            status: row.status,
            hour_micros: row.hour_micros,
            average_micros: row.average_micros,
            detected_at: row.detected_at,
            decided_by: row.decided_by,
            decided_at: row.decided_at,
            until: row.until,
        }
    }
}

/// A workspace's pace: the last hour, the usual hour over the last week,
/// the last day, at price (what was charged plus what paid for it first).
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Pace {
    pub last_hour: i64,
    pub usual_hour: i64,
    pub last_day: i64,
}

impl Billing {
    /// Spend at price over the last hour, day and week.
    pub(crate) async fn pace(&self, workspace: &str) -> Result<Pace> {
        #[derive(Deserialize)]
        struct Row {
            hour: Option<i64>,
            day: Option<i64>,
            week: Option<i64>,
        }
        let now = now_ms();
        let hour_ago = rfc3339(now - 60 * 60 * 1000);
        let day_ago = rfc3339(now - 24 * 60 * 60 * 1000);
        let week_ago = rfc3339(now - 7 * 24 * 60 * 60 * 1000);
        let gross = "(-amount_micros + credit_micros + trial_micros + oss_micros + given_micros)";
        let row = self
            .db
            .prepare(format!(
                "SELECT SUM(CASE WHEN created_at >= ?2 THEN {gross} END) AS hour,
                        SUM(CASE WHEN created_at >= ?3 THEN {gross} END) AS day,
                        SUM(CASE WHEN created_at < ?2 THEN {gross} END) AS week
                 FROM ledger WHERE workspace = ?1 AND kind = 'usage' AND created_at >= ?4"
            ))
            .bind(&[workspace.into(), hour_ago.into(), day_ago.into(), week_ago.into()])?
            .first::<Row>(None)
            .await?;
        Ok(row.map_or_else(Pace::default, |r| Pace {
            last_hour: r.hour.unwrap_or(0).max(0),
            usual_hour: r.week.unwrap_or(0).max(0) / (WEEK_HOURS - 1),
            last_day: r.day.unwrap_or(0).max(0),
        }))
    }

    /// The workspace's latest spike, if any.
    pub(crate) async fn latest_spike(&self, workspace: &str) -> Result<Option<Spike>> {
        Ok(self
            .db
            .prepare(
                "SELECT id, status, hour_micros, average_micros, detected_at, decided_by, decided_at, until
                 FROM spikes WHERE workspace = ? ORDER BY detected_at DESC LIMIT 1",
            )
            .bind(&[workspace.into()])?
            .first::<SpikeRow>(None)
            .await?
            .map(Spike::from))
    }

    /// The spike pausing the workspace now, found or new. Never for g1t's
    /// own workspaces, which are watched in sudo but never paused.
    async fn spike_pause(&self, workspace: &str, plan: PlanKind) -> Result<Option<Spike>> {
        let latest = self.latest_spike(workspace).await?;
        if let Some(spike) = &latest {
            if spike.status == "open" || spike.status == "stopped" {
                return Ok(latest);
            }
        }
        if plan == PlanKind::Internal || self.stripe.is_none() {
            return Ok(None);
        }
        let pace = self.pace(workspace).await?;
        let now = rfc3339(now_ms());
        if let Some(spike) = &latest {
            if spike.status == "continued" && still_continued(spike.until.as_deref(), &now, spike.hour_micros, pace.last_hour) {
                return Ok(None);
            }
        }
        if !is_spike(pace.last_hour, pace.usual_hour, self.plans.spike_factor, self.plans.spike_floor_micros) {
            return Ok(None);
        }
        let id = new_id("spk", now_ms());
        self.db
            .prepare(
                "INSERT INTO spikes (id, workspace, status, hour_micros, average_micros, detected_at)
                 SELECT ?1, ?2, 'open', ?3, ?4, ?5
                 WHERE NOT EXISTS (SELECT 1 FROM spikes WHERE workspace = ?2 AND status = 'open')",
            )
            .bind(&[id.as_str().into(), workspace.into(), (pace.last_hour as f64).into(), (pace.usual_hour as f64).into(), now.as_str().into()])?
            .run()
            .await?;
        self.latest_spike(workspace).await
    }

    /// The alerts a workspace has reached this month: its plan's included
    /// usage, its spend limit and g1t's ceiling, from 50%.
    pub(crate) async fn alerts_for(&self, workspace: &str) -> Result<Vec<UsageAlert>> {
        let limit = self.limit_of(workspace).await?;
        self.alerts_from(workspace, &limit).await
    }

    /// The same, from a limit already worked out.
    async fn alerts_from(&self, workspace: &str, limit: &g1t_contracts::billing::Limit) -> Result<Vec<UsageAlert>> {
        let month = credits::month_of(&rfc3339(now_ms()));
        let mut alerts = vec![];
        if self.has_plan(workspace).await? && limit.trust != g1t_contracts::billing::Trust::Internal {
            let used = self.allowance_used("plan_credit", workspace, &month).await?;
            let included = self.plans.plan_included_micros;
            let level = alert_level(used, included);
            if level > 0 {
                alerts.push(UsageAlert {
                    meter: "included".into(),
                    level,
                    used_micros: used,
                    limit_micros: included,
                    message: if level >= 100 {
                        format!("{workspace} has used all {} of this month's included usage. Usage from here is charged at cost plus 20%, up to your spend limit.", dollars(included))
                    } else {
                        format!("{workspace} has used {} of this month's {} included usage ({level}%). Past it, usage is charged at cost plus 20%, up to your spend limit.", dollars(used), dollars(included))
                    },
                });
            }
        }
        if let Some(spend_limit) = limit.spend_limit_micros {
            let level = alert_level(limit.spent_micros, spend_limit);
            if level > 0 {
                alerts.push(UsageAlert {
                    meter: "spend_limit".into(),
                    level,
                    used_micros: limit.spent_micros,
                    limit_micros: spend_limit,
                    message: format!(
                        "{workspace} has spent {} of its {} monthly spend limit ({level}%). At the limit, new sandboxes, builds and agents stop until the month turns or an owner raises it.",
                        dollars(limit.spent_micros),
                        dollars(spend_limit)
                    ),
                });
            }
        }
        if let Some(ceiling) = limit.ceiling_micros.filter(|_| limit.trust != g1t_contracts::billing::Trust::New) {
            let level = alert_level(limit.exposure_micros, ceiling);
            if level > 0 {
                alerts.push(UsageAlert {
                    meter: "ceiling".into(),
                    level,
                    used_micros: limit.exposure_micros,
                    limit_micros: ceiling,
                    message: format!(
                        "{workspace} has {} of usage not yet paid for, of the {} g1t allows ({level}%). With a card on file g1t charges it as the limit nears; prepaying raises it at once.",
                        dollars(limit.exposure_micros),
                        dollars(ceiling)
                    ),
                });
            }
        }
        Ok(alerts)
    }

    /// Whether a card check was done for the workspace.
    pub(crate) async fn card_checked(&self, workspace: &str) -> Result<bool> {
        Ok(self
            .db
            .prepare("SELECT workspace FROM card_checks WHERE workspace = ?")
            .bind(&[workspace.into()])?
            .first::<serde_json::Value>(None)
            .await?
            .is_some())
    }

    /// What open reservations hold across `members`, at price.
    async fn held(&self, members: &[String]) -> Result<i64> {
        #[derive(Deserialize)]
        struct Row {
            held: Option<i64>,
        }
        let marks = vec!["?"; members.len().max(1)].join(", ");
        let mut values: Vec<JsValue> = members.iter().map(|m| JsValue::from(m.as_str())).collect();
        if values.is_empty() {
            values.push("".into());
        }
        values.push(rfc3339(now_ms()).into());
        Ok(self
            .db
            .prepare(format!(
                "SELECT SUM(hold_micros) AS held FROM reservations
                 WHERE workspace IN ({marks}) AND settled_at IS NULL AND expires_at > ?"
            ))
            .bind(&values)?
            .first::<Row>(None)
            .await?
            .and_then(|r| r.held)
            .unwrap_or(0))
    }

    /// Why new compute is paused, if it is: a staff hold, a spike waiting
    /// for an owner (or stopped by one), or the limit reached.
    async fn pause_reason(
        &self,
        workspace: &str,
        plan: PlanKind,
        limit: Option<&g1t_contracts::billing::Limit>,
    ) -> Result<(Option<String>, Option<Spike>, Option<FailureCode>)> {
        let account = self.account_of(workspace).await?;
        if let Some(hold) = account.allowances.hold.as_deref().filter(|h| !h.trim().is_empty()) {
            return Ok((Some(format!("g1t staff put a hold on new compute ({}).", hold.trim())), None, Some(FailureCode::Paused)));
        }
        let spike = self.spike_pause(workspace, plan).await?;
        if let Some(spike) = &spike {
            let why = if spike.status == "stopped" {
                format!(
                    "an owner stopped new compute after a spend spike ({} in an hour). An owner can choose Keep going.",
                    dollars(spike.hour_micros)
                )
            } else {
                format!(
                    "{} was spent in an hour, more than {} times the usual {} an hour, so new compute waits for an owner to confirm.",
                    dollars(spike.hour_micros),
                    self.plans.spike_factor,
                    dollars(spike.average_micros)
                )
            };
            return Ok((Some(why), Some(spike.clone()), Some(FailureCode::Paused)));
        }
        let latest = self.latest_spike(workspace).await?;
        if plan != PlanKind::Internal && self.stripe.is_some() {
            let worked_out;
            let limit = match limit {
                Some(limit) => limit,
                None => {
                    worked_out = self.limit_of(workspace).await?;
                    &worked_out
                }
            };
            if limit.state == LimitState::Stopped {
                return Ok((limit.message.clone(), latest, Some(FailureCode::Limit)));
            }
        }
        Ok((None, latest, None))
    }

    /// `entitlements`: what the workspace may do now.
    pub(crate) async fn entitlements(&self, a: EntitlementsArgs) -> Result<Entitlements> {
        let workspace = a.workspace.to_lowercase();
        let plan = self.plan_kind(&workspace).await?;
        let account = self.account_of(&workspace).await?;
        let limit = self.limit_of(&workspace).await?;
        let now = rfc3339(now_ms());
        let month = credits::month_of(&now);
        let verified = matches!(plan, PlanKind::Internal | PlanKind::Enterprise) || self.card_checked(&workspace).await?;
        // A card checked while the month's pool was empty: granted once it
        // has room.
        let grant = match self.grant_of(&workspace).await? {
            Some(grant) => Some(grant),
            None if verified && plan == PlanKind::Free && self.trial_allowed(&workspace).await? => self.ensure_grant(&workspace).await?,
            None => None,
        };
        let trial_left = grant.as_ref().map_or(0, |g| left(g.granted_micros, g.used_micros));
        let first_month = limit.first_month;
        let (max_agents, max_minutes) = caps(plan, first_month, trial_left > 0, account.allowances.max_concurrent_agents);
        let (paused, spike, _) = self.pause_reason(&workspace, plan, Some(&limit)).await?;
        let ceiling = match plan {
            PlanKind::Free => 0,
            PlanKind::Internal => UNLIMITED_MICROS,
            _ => limit.ceiling_micros.unwrap_or(UNLIMITED_MICROS),
        };
        let has_plan = plan != PlanKind::Free;
        let owners = self.owner_caps(&workspace).await?;
        let stored = self.private_storage(&workspace).await?;
        let oss = self.oss_paid(&workspace, &month).await?;
        Ok(Entitlements {
            plan,
            compute: has_plan || trial_left > 0,
            trial_micros_left: trial_left,
            trial_verified: verified,
            first_month,
            max_concurrent_agents: max_agents,
            max_run_minutes: max_minutes,
            run_cap_micros: account.allowances.run_cap_micros.or(owners.0).unwrap_or(self.plans.run_cap_micros),
            issue_cap_micros: account.allowances.issue_cap_micros.or(owners.1).unwrap_or(self.plans.issue_cap_micros),
            ceiling_micros: ceiling,
            exposure_micros: limit.exposure_micros,
            paused,
            held_micros: self.held(&account.workspaces).await?,
            prepaid_micros: limit.prepaid_micros,
            included_micros: if has_plan { self.plans.plan_included_micros } else { 0 },
            included_used_micros: if has_plan { self.allowance_used("plan_credit", &workspace, &month).await? } else { 0 },
            audit_retention_days: self.plans.audit_days,
            free_private_storage_bytes: self.plans.free_storage_bytes,
            private_storage_bytes: stored,
            oss_paid_micros: oss,
            build_seconds_used: self.allowance_used("build_seconds", &workspace, &month).await?.max(0) as u32,
            git_operations: self.git_operations_this_month(&workspace).await?,
            git_operations_included: self.plans.git_included,
            min_charge_micros: self.plans.min_charge_micros,
            spike,
            alerts: self.alerts_from(&workspace, &limit).await?,
            workspace,
        })
    }

    /// `reserve`: holds a start's estimated cost, or says why not.
    pub(crate) async fn reserve(&self, a: ReserveArgs) -> Result<Outcome<Reservation>> {
        let workspace = a.workspace.to_lowercase();
        let now = now_ms();
        let expires_at = rfc3339(now + RESERVATION_HOURS * 60 * 60 * 1000);
        let repo = format!("{}/{}", a.repo.namespace, a.repo.name).to_lowercase();
        // A g1t that does not charge holds nothing.
        if self.stripe.is_none() {
            return Ok(Outcome::Ok(Reservation { id: new_id("rsv", now), paid_by: PaidBy::OnDemand, held_micros: 0, expires_at }));
        }
        let plan = self.plan_kind(&workspace).await?;
        let limit = if plan == PlanKind::Internal { None } else { Some(self.limit_of(&workspace).await?) };
        let (paused, _, code) = self.pause_reason(&workspace, plan, limit.as_ref()).await?;
        if let (Some(why), Some(code)) = (paused, code) {
            return Ok(refusal(code, &workspace, a.kind, &why));
        }
        let account = self.account_of(&workspace).await?;
        let month = credits::month_of(&rfc3339(now));
        let estimate = credits::with_margin(a.estimate_micros, self.margin_percent);
        let verified = matches!(plan, PlanKind::Internal | PlanKind::Enterprise | PlanKind::Paid) || self.card_checked(&workspace).await?;
        let has_plan = plan != PlanKind::Free;
        let credit = if has_plan {
            left(self.plans.plan_included_micros, self.allowance_used("plan_credit", &workspace, &month).await?)
        } else {
            0
        };
        let trial = if a.kind == ComputeKind::Deploy || !verified {
            0
        } else {
            self.grant_of(&workspace).await?.map_or(0, |g| left(g.granted_micros, g.used_micros))
        };
        let oss_eligible = a.public && a.kind.open_source_pool() && verified;
        let oss = if oss_eligible { self.oss_left(&workspace, &repo, &month).await? } else { 0 };
        let on_demand = match plan {
            PlanKind::Free => Some(0),
            PlanKind::Internal => None,
            _ => {
                let Some(limit) = &limit else { unreachable!("only g1t's own workspaces skip the limit") };
                let under_ceiling = limit.ceiling_micros.map(|c| (c - limit.exposure_micros).max(0));
                let under_spend = limit.spend_limit_micros.map(|s| (s - limit.spent_micros).max(0));
                match (under_ceiling, under_spend) {
                    (Some(c), Some(s)) => Some(c.min(s)),
                    (c, s) => c.or(s),
                }
            }
        };
        let room = Room { credit, trial, oss, on_demand };
        // Optimistic: what was held is read, and the hold is written only if
        // nothing was held meanwhile; otherwise read again.
        for _ in 0..4 {
            let held = self.held(&account.workspaces).await?;
            let (paid_by, hold) = match place(&room, held, estimate, has_plan) {
                Ok(placed) => placed,
                Err(short) => return Ok(self.short(&workspace, plan, &a, verified, &room, short).await?),
            };
            let id = new_id("rsv", now);
            let mut values: Vec<JsValue> = vec![
                id.as_str().into(),
                workspace.as_str().into(),
                repo.as_str().into(),
                a.kind.as_str().into(),
                u8::from(a.public).into(),
                (a.estimate_micros.max(0) as f64).into(),
                (hold as f64).into(),
                paid_by_text(paid_by).into(),
                rfc3339(now).into(),
                expires_at.as_str().into(),
                (held as f64).into(),
            ];
            values.extend(account.workspaces.iter().map(|w| JsValue::from(w.as_str())));
            if account.workspaces.is_empty() {
                values.push("".into());
            }
            let placed = self
                .db
                .prepare(format!(
                    "INSERT INTO reservations (id, workspace, repo, kind, public, estimate_micros, hold_micros, paid_by, created_at, expires_at)
                     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
                     WHERE (SELECT COALESCE(SUM(hold_micros), 0) FROM reservations
                             WHERE workspace IN ({marks}) AND settled_at IS NULL AND expires_at > ?9) = ?11
                     RETURNING id",
                    marks = (12..12 + account.workspaces.len().max(1)).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ")
                ))
                .bind(&values)?
                .first::<serde_json::Value>(None)
                .await?;
            if placed.is_some() {
                // What is held, at cost, as it was asked.
                let held_cost = if hold >= estimate { a.estimate_micros.max(0) } else { hold * 100 / i64::from(100 + self.margin_percent) };
                return Ok(Outcome::Ok(Reservation { id, paid_by, held_micros: held_cost, expires_at }));
            }
        }
        Ok(refusal(FailureCode::Limit, &workspace, a.kind, "Too many starts at once to hold this one; try again in a moment."))
    }

    /// The refusal for a start nothing pays for.
    async fn short(
        &self,
        workspace: &str,
        plan: PlanKind,
        a: &ReserveArgs,
        verified: bool,
        room: &Room,
        short: Short,
    ) -> Result<Outcome<Reservation>> {
        if plan != PlanKind::Free {
            let limit = self.limit_of(workspace).await?;
            let detail = match short {
                Short::TooSmall => format!(
                    "This would take the workspace past its limit: about {} more could start now ({} spent of a {} spend limit, {} not yet paid of the {} g1t allows).",
                    dollars(room.credit + room.trial + room.oss + room.on_demand.unwrap_or(0)),
                    dollars(limit.spent_micros),
                    dollars(limit.spend_limit_micros.unwrap_or_default()),
                    dollars(limit.exposure_micros),
                    dollars(limit.ceiling_micros.unwrap_or_default()),
                ),
                Short::Empty => limit.message.unwrap_or_else(|| "The workspace reached its limit for this month.".to_owned()),
            };
            return Ok(refusal(FailureCode::Limit, workspace, a.kind, &detail));
        }
        if !verified {
            return Ok(refusal(FailureCode::NotPaid, workspace, a.kind, ""));
        }
        let oss_eligible = a.public && a.kind.open_source_pool();
        let trial = self.grant_of(workspace).await?;
        if oss_eligible && room.oss == 0 {
            let month = credits::month_of(&rfc3339(now_ms()));
            let repo = format!("{}/{}", a.repo.namespace, a.repo.name).to_lowercase();
            let pool = left(self.plans.oss_pool_micros, self.allowance_used("oss_pool", "", &month).await?);
            let detail = if pool > 0 { format!(" for {repo} (its share is {})", dollars(self.oss_repo_cap(workspace).await?)) } else { String::new() };
            if trial.as_ref().is_none_or(|g| g.used_micros >= g.granted_micros) {
                return Ok(refusal(FailureCode::OssPoolEmpty, workspace, a.kind, &detail));
            }
        }
        match trial {
            Some(grant) if grant.used_micros >= grant.granted_micros => Ok(refusal(FailureCode::TrialUsed, workspace, a.kind, "")),
            _ => Ok(refusal(FailureCode::NotPaid, workspace, a.kind, "")),
        }
    }

    /// `settle`: releases a hold.
    pub(crate) async fn settle_reservation(&self, a: SettleArgs) -> Result<Outcome<bool>> {
        let now = rfc3339(now_ms());
        let settled = self
            .db
            .prepare(
                "UPDATE reservations SET settled_at = ?1, actual_micros = ?2
                 WHERE id = ?3 AND settled_at IS NULL AND expires_at > ?1 RETURNING id",
            )
            .bind(&[now.as_str().into(), (a.actual_micros.max(0) as f64).into(), a.reservation_id.as_str().into()])?
            .first::<serde_json::Value>(None)
            .await?;
        Ok(Outcome::Ok(settled.is_some()))
    }

    /// Clears reservations long settled or lapsed.
    pub(crate) async fn sweep_reservations(&self) -> Result<()> {
        let week_ago = rfc3339(now_ms() - 7 * 24 * 60 * 60 * 1000);
        self.db
            .prepare("DELETE FROM reservations WHERE expires_at < ?1")
            .bind(&[week_ago.into()])?
            .run()
            .await?;
        Ok(())
    }

    /// `confirm_spike`: an owner keeps going, or stops.
    pub(crate) async fn confirm_spike(&self, a: ConfirmSpikeArgs) -> Result<Outcome<Entitlements>> {
        let workspace = a.workspace.to_lowercase();
        if a.actor.role_in(&workspace) != Some(Role::Owner) {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only an owner can answer a spend spike."));
        }
        let Some(spike) = self.latest_spike(&workspace).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "There is no spend spike to answer."));
        };
        let now = now_ms();
        let (status, until) = if a.keep_going { ("continued", Some(rfc3339(now + KEEP_GOING_MS))) } else { ("stopped", None) };
        self.db
            .prepare("UPDATE spikes SET status = ?1, decided_by = ?2, decided_at = ?3, until = ?4 WHERE id = ?5")
            .bind(&[
                status.into(),
                a.actor.username.as_str().into(),
                rfc3339(now).into(),
                crate::optional(until.as_deref()),
                spike.id.as_str().into(),
            ])?
            .run()
            .await?;
        let account = self.account_of(&workspace).await?;
        self.audit(
            &account.id,
            "spike",
            &format!("{workspace}: {} after {} in an hour", if a.keep_going { "kept going" } else { "stopped" }, dollars(spike.hour_micros)),
            &a.actor.username,
        )
        .await?;
        Ok(Outcome::Ok(self.entitlements(EntitlementsArgs { workspace }).await?))
    }

    /// The owners' own run and issue caps, if they set them.
    async fn owner_caps(&self, workspace: &str) -> Result<(Option<i64>, Option<i64>)> {
        #[derive(Deserialize)]
        struct Row {
            run_cap_micros: Option<i64>,
            issue_cap_micros: Option<i64>,
        }
        Ok(self
            .db
            .prepare("SELECT run_cap_micros, issue_cap_micros FROM limits WHERE workspace = ?")
            .bind(&[workspace.into()])?
            .first::<Row>(None)
            .await?
            .map_or((None, None), |r| (r.run_cap_micros, r.issue_cap_micros)))
    }

    /// `set_caps`: the owners' own run and issue caps.
    pub(crate) async fn set_caps(&self, a: SetCapsArgs) -> Result<Outcome<Entitlements>> {
        let workspace = a.workspace.to_lowercase();
        if a.actor.role_in(&workspace) != Some(Role::Owner) {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only an owner can set the workspace's caps."));
        }
        if let Err(why) = cap_bounds(a.run_cap_micros, a.issue_cap_micros) {
            return Ok(Outcome::fail(FailureCode::Invalid, why));
        }
        let opt = |m: Option<i64>| m.map_or(JsValue::NULL, |m| (m as f64).into());
        let now = rfc3339(now_ms());
        self.db
            .prepare(
                "INSERT INTO limits (workspace, run_cap_micros, issue_cap_micros, updated_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (workspace) DO UPDATE SET run_cap_micros = ?2, issue_cap_micros = ?3, updated_at = ?4",
            )
            .bind(&[workspace.as_str().into(), opt(a.run_cap_micros), opt(a.issue_cap_micros), now.into()])?
            .run()
            .await?;
        let account = self.account_of(&workspace).await?;
        let shown = |m: Option<i64>| m.map_or_else(|| "the default".to_owned(), dollars);
        self.audit(
            &account.id,
            "caps",
            &format!("{workspace}: run cap {}, issue cap {}", shown(a.run_cap_micros), shown(a.issue_cap_micros)),
            &a.actor.username,
        )
        .await?;
        Ok(Outcome::Ok(self.entitlements(EntitlementsArgs { workspace }).await?))
    }

    /// Emails owners about spikes that paused their workspace, once each.
    pub(crate) async fn tell_spikes(&self, identity: &worker::Fetcher) -> Result<()> {
        #[derive(Deserialize)]
        struct Open {
            id: String,
            workspace: String,
            hour_micros: i64,
            average_micros: i64,
        }
        let open = self
            .db
            .prepare("SELECT id, workspace, hour_micros, average_micros FROM spikes WHERE status = 'open' AND told_at IS NULL LIMIT 20")
            .all()
            .await?
            .results::<Open>()?;
        for spike in open {
            let workspace = &spike.workspace;
            let intro = format!(
                "{workspace} spent {} in the last hour, more than {} times its usual {} an hour, so g1t paused new sandboxes, agents and builds until an owner confirms. Runs already going finish. If this was meant, choose Keep going and nothing pauses for 24 hours unless the hour's spend doubles again. If not, choose Stop; and if it was a mistake, tell g1t from the billing page.",
                dollars(spike.hour_micros),
                self.plans.spike_factor,
                dollars(spike.average_micros)
            );
            let link = format!("https://g1t.sh/{workspace}/-/billing");
            if crate::limits::notify(identity, workspace, &format!("g1t: spending on {workspace} spiked, so new work is paused"), &intro, "Keep going or stop", &link).await {
                self.db
                    .prepare("UPDATE spikes SET told_at = ? WHERE id = ?")
                    .bind(&[rfc3339(now_ms()).into(), spike.id.as_str().into()])?
                    .run()
                    .await?;
            }
        }
        Ok(())
    }

    /// What the workspace's private repositories held at the last measure.
    pub(crate) async fn private_storage(&self, workspace: &str) -> Result<i64> {
        #[derive(Deserialize)]
        struct Stored {
            private_bytes: Option<i64>,
        }
        Ok(self
            .db
            .prepare("SELECT private_bytes FROM storage_days WHERE workspace = ? ORDER BY day DESC LIMIT 1")
            .bind(&[workspace.into()])?
            .first::<Stored>(None)
            .await?
            .and_then(|s| s.private_bytes)
            .unwrap_or(0))
    }

    /// What g1t's open-source pool paid for the workspace in `month`.
    async fn oss_paid(&self, workspace: &str, month: &str) -> Result<i64> {
        #[derive(Deserialize)]
        struct Sum {
            micros: Option<i64>,
        }
        Ok(self
            .db
            .prepare("SELECT SUM(oss_micros) AS micros FROM ledger WHERE workspace = ? AND created_at >= ?")
            .bind(&[workspace.into(), format!("{month}-01").into()])?
            .first::<Sum>(None)
            .await?
            .and_then(|s| s.micros)
            .unwrap_or(0))
    }
}

/// Whether owners' caps are in bounds: a run $0.10 to $100 (the
/// guardrails' most), an issue $1 to $1,000.
pub(crate) fn cap_bounds(run: Option<i64>, issue: Option<i64>) -> std::result::Result<(), String> {
    if run.is_some_and(|m| !(100_000..=100_000_000).contains(&m)) {
        return Err("A run's cap is between $0.10 and $100.".to_owned());
    }
    if issue.is_some_and(|m| !(1_000_000..=1_000_000_000).contains(&m)) {
        return Err("An issue's cap is between $1 and $1,000.".to_owned());
    }
    Ok(())
}

pub(crate) fn paid_by_text(paid_by: PaidBy) -> &'static str {
    match paid_by {
        PaidBy::Credit => "credit",
        PaidBy::Trial => "trial",
        PaidBy::Oss => "oss",
        PaidBy::OnDemand => "on_demand",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paid(credit: i64, on_demand: i64) -> Room {
        Room { credit, trial: 0, oss: 0, on_demand: Some(on_demand) }
    }

    #[test]
    fn included_usage_pays_first_then_on_demand() {
        // $10 included, $100 under the ceiling, nothing held: included pays first.
        assert_eq!(place(&paid(10_000_000, 100_000_000), 0, 2_400_000, true), Ok((PaidBy::Credit, 2_400_000)));
        // Holds already cover the included usage: on demand.
        assert_eq!(place(&paid(10_000_000, 100_000_000), 10_000_000, 2_400_000, true), Ok((PaidBy::OnDemand, 2_400_000)));
        // A free workspace on its trial.
        let trial = Room { trial: 5_000_000, on_demand: Some(0), ..Room::default() };
        assert_eq!(place(&trial, 0, 2_400_000, false), Ok((PaidBy::Trial, 2_400_000)));
        // A public repository's checks, from the pool.
        let pool = Room { oss: 2_000_000, on_demand: Some(0), ..Room::default() };
        assert_eq!(place(&pool, 0, 600_000, false), Ok((PaidBy::Oss, 600_000)));
    }

    #[test]
    fn a_paid_workspace_is_stopped_only_by_its_limit_never_by_a_count() {
        // The included $10 is gone and the workspace has already built,
        // served and stored far past what used to be quotas: the next start
        // still goes on demand, as long as its spend limit has room.
        let room = paid(0, 250_000_000);
        let held = 0;
        for start in 0..1_000 {
            let placed = place(&room, held + start * 100_000, 100_000, true);
            assert_eq!(placed, Ok((PaidBy::OnDemand, 100_000)));
        }
        // Only at its limit does it stop, with the limit's refusal.
        assert_eq!(place(&room, 250_000_000, 100_000, true), Err(Short::Empty));
        // A free workspace has no on-demand room at all: with no trial or
        // pool left, nothing starts (`short` says NotPaid or TrialUsed).
        let free = Room { on_demand: Some(0), ..Room::default() };
        assert_eq!(place(&free, 0, 100_000, false), Err(Short::Empty));
        // g1t's own workspaces: no limit.
        let internal = Room { on_demand: None, ..Room::default() };
        assert_eq!(place(&internal, i64::MAX / 2, 100_000, true), Ok((PaidBy::OnDemand, 100_000)));
    }

    #[test]
    fn concurrent_starts_cannot_overshoot_the_ceiling() {
        // $5 of room in all, and each start may cost up to $2.40.
        let room = paid(0, 5_000_000);
        let mut held = 0;
        let mut started = 0;
        for _ in 0..5 {
            match place(&room, held, 2_400_000, true) {
                Ok((_, hold)) => {
                    held += hold;
                    started += 1;
                }
                Err(short) => assert_eq!(short, Short::TooSmall),
            }
        }
        assert_eq!(started, 2);
        assert!(held <= 5_000_000);
        // Once the first settles, a third fits.
        assert!(place(&room, held - 2_400_000, 2_400_000, true).is_ok());
        // Nothing left at all.
        assert_eq!(place(&room, 5_000_000, 1, true), Err(Short::Empty));
    }

    #[test]
    fn a_free_workspace_may_use_its_last_bit_of_trial() {
        let room = Room { trial: 300_000, on_demand: Some(0), ..Room::default() };
        // The whole estimate does not fit, but what is left is held.
        assert_eq!(place(&room, 0, 2_400_000, false), Ok((PaidBy::Trial, 300_000)));
        // Once it is held, nothing more starts.
        assert_eq!(place(&room, 300_000, 2_400_000, false), Err(Short::Empty));
        // Nothing at all: no plan, no trial, no pool.
        assert_eq!(place(&Room { on_demand: Some(0), ..Room::default() }, 0, 1, false), Err(Short::Empty));
    }

    #[test]
    fn g1ts_own_workspaces_are_never_short() {
        let room = Room { credit: 10_000_000, on_demand: None, ..Room::default() };
        assert_eq!(place(&room, 50_000_000_000, 2_400_000, true), Ok((PaidBy::OnDemand, 2_400_000)));
        assert_eq!(place(&room, 0, 2_400_000, true), Ok((PaidBy::Credit, 2_400_000)));
    }

    #[test]
    fn a_spike_is_five_times_the_usual_hour_and_at_least_five_dollars() {
        let (factor, floor) = (5, 5_000_000);
        // A new workspace with no history: $5 in an hour is a spike, $4 is not.
        assert!(is_spike(5_000_000, 0, factor, floor));
        assert!(!is_spike(4_000_000, 0, factor, floor));
        // Usually $2 an hour: $10 is not above five times, $10.01 is.
        assert!(!is_spike(10_000_000, 2_000_000, factor, floor));
        assert!(is_spike(10_010_000, 2_000_000, factor, floor));
        // A busy workspace at its usual pace is never a spike.
        assert!(!is_spike(40_000_000, 30_000_000, factor, floor));
    }

    #[test]
    fn keep_going_lasts_a_day_or_until_spend_doubles() {
        let until = "2026-10-06T12:00:00Z";
        assert!(still_continued(Some(until), "2026-10-06T11:00:00Z", 6_000_000, 8_000_000));
        // Doubled again: paused again.
        assert!(!still_continued(Some(until), "2026-10-06T11:00:00Z", 6_000_000, 12_000_000));
        // A day later: watched afresh.
        assert!(!still_continued(Some(until), "2026-10-06T12:00:01Z", 6_000_000, 1_000_000));
        assert!(!still_continued(None, "2026-10-06T11:00:00Z", 6_000_000, 1));
    }

    #[test]
    fn owners_caps_stay_in_bounds() {
        assert!(cap_bounds(None, None).is_ok());
        assert!(cap_bounds(Some(5_000_000), Some(50_000_000)).is_ok());
        assert!(cap_bounds(Some(50_000), None).is_err());
        assert!(cap_bounds(Some(101_000_000), None).is_err());
        assert!(cap_bounds(None, Some(500_000)).is_err());
        assert!(cap_bounds(None, Some(2_000_000_000)).is_err());
    }

    #[test]
    fn caps_are_tight_in_the_first_month_and_on_the_trial() {
        assert_eq!(caps(PlanKind::Paid, true, false, None), (2, 60));
        assert_eq!(caps(PlanKind::Free, false, true, None), (2, 60));
        assert_eq!(caps(PlanKind::Paid, false, false, None), (10, g1t_contracts::guardrails::MAX_MINUTES));
        assert_eq!(caps(PlanKind::Internal, false, false, None).0, 10);
        // Staff can set agents at once.
        assert_eq!(caps(PlanKind::Paid, true, false, Some(6)).0, 6);
    }

    #[test]
    fn every_refusal_says_what_to_do_and_where() {
        for code in [FailureCode::NotPaid, FailureCode::TrialUsed, FailureCode::OssPoolEmpty, FailureCode::Limit, FailureCode::Paused] {
            let Outcome::Fail(failure) = refusal(code, "acme", ComputeKind::Check, "Detail.") else { panic!() };
            assert_eq!(failure.code, code);
            assert!(failure.message.contains("/acme/-/billing"), "{}", failure.message);
        }
        let Outcome::Fail(failure) = refusal(FailureCode::NotPaid, "acme", ComputeKind::Agent, "") else { panic!() };
        assert!(failure.message.contains("$5 trial") && failure.message.contains("never charged"));
    }
}
