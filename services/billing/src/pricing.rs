//! The price book as versions, and how it changes.
//!
//! A price is its cost plus the markup, and costs move: Cloudflare's
//! rates, how much CPU sandboxes use, what Artifacts turns out to count as
//! an operation. So prices must move too, without surprising anyone and
//! without g1t selling at a loss.
//!
//! - **Versions.** Every price is a row in `price_versions`, never changed
//!   once written. `prices` holds the version in force; a version waiting
//!   for its date is applied by the daily run, and recorded in
//!   `price_changes` (the public record on the pricing page). A charge
//!   records the version it was made at (`ledger.price_version`), so what a
//!   past statement says is always explained by the prices of then.
//! - **Proposals.** The keeper and the reconciler measure costs; what they
//!   find is proposed (`price_proposals`). A move under 2% is noise. One
//!   within the guardrail (`auto_apply_percent`, 25%) is applied on its own
//!   when `auto_apply` is on. Anything larger, or more than four times off
//!   (suspect), waits for staff to approve or reject in sudo.
//! - **Notice.** A fall applies at once: customers only gain. A rise
//!   applies `notice_days` (14) after it is decided, and a monthly meter's
//!   at the start of the month after that, so no month is charged at two
//!   prices. Owners of workspaces on the plan are emailed once per rise.
//!   Cost-plus means the rise does come: margin protection is for new usage
//!   after the notice, never retroactive.

use g1t_contracts::billing::*;
use g1t_contracts::time::{parse_rfc3339, rfc3339};
use g1t_contracts::{FailureCode, Outcome, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use serde_json::Value;
use worker::Result;

use crate::Billing;

/// Smaller moves are noise.
pub(crate) const MIN_CHANGE: f64 = 0.02;
/// A measurement outside this factor of the current cost is suspect: it
/// is proposed for a person to look at, never applied on its own.
pub(crate) const MAX_FACTOR: f64 = 4.0;

/// Meters charged once a month from the month's total (`storage`). A rise
/// in one takes effect at the start of a month.
pub(crate) const MONTHLY: [&str; 7] = ["git_operations", "private_storage", "actions_cache", "custom_domain_month", "embedding_tokens", "scan_cpu", "scan_rows"];

/// The price meters a month-end source is charged at, for the ledger's
/// `price_version`.
pub(crate) fn meters_of(source: &str) -> &'static [&'static str] {
    match source {
        "git" => &["git_operations"],
        "storage" => &["private_storage"],
        "context" => &["embedding_tokens"],
        "security" => &["scan_cpu", "scan_rows"],
        "domains" => &["custom_domain_month"],
        "cache" => &["actions_cache"],
        _ => &[],
    }
}

/// Rises smaller than this, in percent, are listed on the pricing page
/// with their date but not emailed: the keeper moves sandbox seconds by a
/// percent or two at a time, and an email for each would be noise.
const EMAIL_RISE_PERCENT: f64 = 5.0;

/// Owners told of rises per run, at most; the rest on the next run.
const NOTICES_PER_RUN: usize = 40;

/// What may change prices without a person.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Guard {
    pub auto_apply: bool,
    /// The largest move applied on its own, in percent either way.
    pub auto_percent: f64,
    /// Days between deciding a rise and charging it.
    pub notice_days: u32,
}

impl From<&CostSettings> for Guard {
    fn from(s: &CostSettings) -> Self {
        Guard { auto_apply: s.auto_apply, auto_percent: s.auto_apply_percent, notice_days: s.notice_days }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Decision {
    /// Too small to matter.
    Nothing,
    /// Applied without a person, from `effective_ms`.
    Auto { effective_ms: u64 },
    /// Waits for staff. `suspect` when the measurement is wildly off.
    Approve { suspect: bool },
}

/// When a new cost takes effect: a fall at once; a rise after the notice
/// period, and for a monthly meter at the start of the first month after
/// it.
pub(crate) fn effective_ms(current: f64, new: f64, now_ms: u64, notice_days: u32, monthly: bool) -> u64 {
    if new <= current {
        return now_ms;
    }
    let after = now_ms + u64::from(notice_days) * crate::costs::DAY_MS;
    if !monthly {
        return after;
    }
    let stamp = rfc3339(after);
    if &stamp[8..] == "01T00:00:00.000Z" {
        return after;
    }
    parse_rfc3339(&crate::credits::next_month_start(&stamp[..7])).unwrap_or(after)
}

/// What to do with a measured cost against the one in force (or the one
/// already scheduled).
pub(crate) fn decide(current: f64, measured: f64, guard: Guard, now_ms: u64, monthly: bool) -> Decision {
    if !measured.is_finite() || measured <= 0.0 || !current.is_finite() || current <= 0.0 {
        return Decision::Nothing;
    }
    let ratio = measured / current;
    if (ratio - 1.0).abs() < MIN_CHANGE {
        return Decision::Nothing;
    }
    if !(1.0 / MAX_FACTOR..=MAX_FACTOR).contains(&ratio) {
        return Decision::Approve { suspect: true };
    }
    if guard.auto_apply && (ratio - 1.0).abs() * 100.0 <= guard.auto_percent {
        return Decision::Auto { effective_ms: effective_ms(current, measured, now_ms, guard.notice_days, monthly) };
    }
    Decision::Approve { suspect: false }
}

/// A version of one meter's price.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub(crate) struct Version {
    pub id: String,
    pub meter: String,
    pub version: u32,
    pub cost_micros: f64,
    pub markup_percent: u32,
    pub effective_at: String,
    pub reason: String,
    pub created_by: String,
    pub applied_at: Option<String>,
}

/// The version in force for `meter` at `at`: the newest whose date has
/// come. Old versions never change, so a past month's charges are always
/// explained by the version of then.
pub(crate) fn in_force<'a>(versions: &'a [Version], meter: &str, at: &str) -> Option<&'a Version> {
    versions
        .iter()
        .filter(|v| v.meter == meter && v.effective_at.as_str() <= at)
        .max_by(|a, b| a.effective_at.cmp(&b.effective_at).then(a.version.cmp(&b.version)))
}

/// Settings from `cost_settings` rows, defaults for anything missing or
/// unreadable.
pub(crate) fn settings_from(rows: &[(String, String)]) -> CostSettings {
    let mut s = CostSettings::default();
    for (key, value) in rows {
        let value = value.trim();
        match key.as_str() {
            "auto_apply" => s.auto_apply = value == "true",
            "auto_apply_percent" => s.auto_apply_percent = value.parse().unwrap_or(s.auto_apply_percent),
            "notice_days" => s.notice_days = value.parse().unwrap_or(s.notice_days),
            "margin_floor_percent" => s.margin_floor_percent = value.parse().unwrap_or(s.margin_floor_percent),
            "alert_days" => s.alert_days = value.parse().unwrap_or(s.alert_days),
            "min_daily_cost_micros" => s.min_daily_cost_micros = value.parse().unwrap_or(s.min_daily_cost_micros),
            "anomaly_factor" => s.anomaly_factor = value.parse().unwrap_or(s.anomaly_factor),
            "anomaly_floor_micros" => s.anomaly_floor_micros = value.parse().unwrap_or(s.anomaly_floor_micros),
            _ => {}
        }
    }
    s
}

/// Why settings cannot be saved, if they cannot.
pub(crate) fn check_settings(s: &CostSettings) -> std::result::Result<(), String> {
    if !(0.0..=100.0).contains(&s.auto_apply_percent) {
        return Err("The guardrail is a percentage from 0 to 100.".into());
    }
    if s.notice_days > 90 {
        return Err("Notice is at most 90 days.".into());
    }
    if !(-100.0..=100.0).contains(&s.margin_floor_percent) {
        return Err("The margin floor is a percentage.".into());
    }
    if s.alert_days == 0 || s.alert_days > 30 {
        return Err("Alert after 1 to 30 days.".into());
    }
    if s.min_daily_cost_micros < 0 || s.anomaly_floor_micros < 0 || !(s.anomaly_factor > 0.0 && s.anomaly_factor.is_finite()) {
        return Err("Amounts and the factor must be positive.".into());
    }
    Ok(())
}

#[derive(Deserialize)]
struct ProposalRow {
    id: String,
    meter: String,
    current_cost_micros: f64,
    proposed_cost_micros: f64,
    reason: String,
    source: String,
    suspect: i64,
    status: String,
    created_at: String,
    decided_at: Option<String>,
    decided_by: Option<String>,
    note: Option<String>,
    version_id: Option<String>,
    title: Option<String>,
    unit: Option<String>,
    markup_percent: Option<u32>,
    effective_at: Option<String>,
}

impl From<ProposalRow> for PriceProposal {
    fn from(r: ProposalRow) -> Self {
        let change = if r.current_cost_micros > 0.0 { (r.proposed_cost_micros / r.current_cost_micros - 1.0) * 100.0 } else { 0.0 };
        PriceProposal {
            title: r.title.unwrap_or_else(|| r.meter.clone()),
            unit: r.unit.unwrap_or_default(),
            markup_percent: r.markup_percent.unwrap_or(20),
            id: r.id,
            meter: r.meter,
            current_cost_micros: r.current_cost_micros,
            proposed_cost_micros: r.proposed_cost_micros,
            change_percent: change,
            reason: r.reason,
            source: r.source,
            suspect: r.suspect != 0,
            status: r.status,
            created_at: r.created_at,
            decided_at: r.decided_at,
            decided_by: r.decided_by,
            note: r.note,
            effective_at: r.version_id.and(r.effective_at),
        }
    }
}

const PROPOSAL_SQL: &str = "SELECT p.*, pr.title, pr.unit, pr.markup_percent, v.effective_at
     FROM price_proposals p
     LEFT JOIN prices pr ON pr.meter = p.meter
     LEFT JOIN price_versions v ON v.id = p.version_id";

impl Billing {
    pub(crate) async fn cost_settings(&self) -> Result<CostSettings> {
        #[derive(Deserialize)]
        struct Row {
            key: String,
            value: String,
        }
        let rows = self.db.prepare("SELECT key, value FROM cost_settings").all().await?.results::<Row>()?;
        Ok(settings_from(&rows.into_iter().map(|r| (r.key, r.value)).collect::<Vec<_>>()))
    }

    pub(crate) async fn admin_set_cost_settings(&self, a: AdminSetCostSettingsArgs) -> Result<Outcome<CostSettings>> {
        if let Err(why) = check_settings(&a.settings) {
            return Ok(Outcome::fail(FailureCode::Invalid, why));
        }
        let s = &a.settings;
        let now = rfc3339(now_ms());
        let pairs = [
            ("auto_apply", s.auto_apply.to_string()),
            ("auto_apply_percent", s.auto_apply_percent.to_string()),
            ("notice_days", s.notice_days.to_string()),
            ("margin_floor_percent", s.margin_floor_percent.to_string()),
            ("alert_days", s.alert_days.to_string()),
            ("min_daily_cost_micros", s.min_daily_cost_micros.to_string()),
            ("anomaly_factor", s.anomaly_factor.to_string()),
            ("anomaly_floor_micros", s.anomaly_floor_micros.to_string()),
        ];
        let mut statements = Vec::new();
        for (key, value) in &pairs {
            statements.push(
                self.db
                    .prepare(
                        "INSERT INTO cost_settings (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
                         ON CONFLICT (key) DO UPDATE SET value = ?2, updated_at = ?3, updated_by = ?4",
                    )
                    .bind(&[(*key).into(), value.as_str().into(), now.as_str().into(), a.by.as_str().into()])?,
            );
        }
        self.db.batch(statements).await?;
        let detail = pairs.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(", ");
        self.audit("costs", "cost_settings", &detail, &a.by).await?;
        Ok(Outcome::Ok(self.cost_settings().await?))
    }

    /// The cost a new measurement is judged against: the newest version
    /// scheduled, else the one in force.
    async fn latest_cost(&self, meter: &str) -> Result<Option<(f64, u32)>> {
        #[derive(Deserialize)]
        struct Row {
            cost_micros: f64,
            markup_percent: u32,
        }
        let scheduled = self
            .db
            .prepare("SELECT cost_micros, markup_percent FROM price_versions WHERE meter = ? AND applied_at IS NULL ORDER BY version DESC LIMIT 1")
            .bind(&[meter.into()])?
            .first::<Row>(None)
            .await?;
        if let Some(row) = scheduled {
            return Ok(Some((row.cost_micros, row.markup_percent)));
        }
        Ok(self
            .db
            .prepare("SELECT cost_micros, markup_percent FROM prices WHERE meter = ?")
            .bind(&[meter.into()])?
            .first::<Row>(None)
            .await?
            .map(|r| (r.cost_micros, r.markup_percent)))
    }

    /// Proposes a measured cost for a meter. Returns what happened, in
    /// words, or None when there was nothing to do.
    pub(crate) async fn propose(&self, meter: &str, measured: f64, reason: &str, source: &str) -> Result<Option<String>> {
        let Some((current, markup)) = self.latest_cost(meter).await? else {
            return Ok(None);
        };
        // Ten-thousandths of a micro are plenty; floating-point tails are not.
        let measured = (measured * 10_000.0).round() / 10_000.0;
        let settings = self.cost_settings().await?;
        let now = now_ms();
        let decision = decide(current, measured, Guard::from(&settings), now, MONTHLY.contains(&meter));
        if decision == Decision::Nothing {
            return Ok(None);
        }
        let stamp = rfc3339(now);
        let id = new_id("ppr", now);
        // A newer measurement replaces an open one.
        self.db
            .prepare("UPDATE price_proposals SET status = 'superseded', decided_at = ? WHERE meter = ? AND status = 'open'")
            .bind(&[stamp.as_str().into(), meter.into()])?
            .run()
            .await?;
        let (status, suspect) = match decision {
            Decision::Auto { .. } => ("applied", false),
            Decision::Approve { suspect } => ("open", suspect),
            Decision::Nothing => unreachable!(),
        };
        self.db
            .prepare(
                "INSERT INTO price_proposals (id, meter, current_cost_micros, proposed_cost_micros, reason, source, suspect, status, created_at, decided_at, decided_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                id.as_str().into(),
                meter.into(),
                current.into(),
                measured.into(),
                reason.into(),
                source.into(),
                i32::from(suspect).into(),
                status.into(),
                stamp.as_str().into(),
                crate::optional((status == "applied").then_some(stamp.as_str())),
                crate::optional((status == "applied").then_some("guardrail")),
            ])?
            .run()
            .await?;
        if status == "open" {
            return Ok(Some(format!(
                "proposed {measured:.4} against {current:.4}{}, waiting for staff",
                if suspect { " (far off: look before approving)" } else { "" }
            )));
        }
        let Decision::Auto { effective_ms } = decision else { unreachable!() };
        let version = self.schedule_version(meter, measured, markup, effective_ms, reason, source, Some(&id)).await?;
        self.apply_due_versions().await?;
        Ok(Some(format!("applied {measured:.4} (was {current:.4}) from {} as {version}", rfc3339(effective_ms))))
    }

    /// Writes the next version of a meter's price, to take effect at
    /// `effective_ms`. Returns its id.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn schedule_version(
        &self,
        meter: &str,
        cost: f64,
        markup: u32,
        effective_ms: u64,
        reason: &str,
        by: &str,
        proposal: Option<&str>,
    ) -> Result<String> {
        #[derive(Deserialize)]
        struct Top {
            version: Option<u32>,
        }
        let next = self
            .db
            .prepare("SELECT MAX(version) AS version FROM price_versions WHERE meter = ?")
            .bind(&[meter.into()])?
            .first::<Top>(None)
            .await?
            .and_then(|t| t.version)
            .unwrap_or(0)
            + 1;
        let id = format!("pv_{meter}_{next}");
        let now = rfc3339(now_ms());
        // A newer decision replaces a rise still waiting for its date.
        self.db
            .prepare("DELETE FROM price_versions WHERE meter = ? AND applied_at IS NULL")
            .bind(&[meter.into()])?
            .run()
            .await?;
        self.db
            .prepare(
                "INSERT INTO price_versions (id, meter, version, cost_micros, markup_percent, effective_at, reason, created_by, proposal_id, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                id.as_str().into(),
                meter.into(),
                next.into(),
                cost.into(),
                markup.into(),
                rfc3339(effective_ms).into(),
                reason.into(),
                by.into(),
                crate::optional(proposal),
                now.as_str().into(),
            ])?
            .run()
            .await?;
        if let Some(proposal) = proposal {
            self.db
                .prepare("UPDATE price_proposals SET version_id = ? WHERE id = ?")
                .bind(&[id.as_str().into(), proposal.into()])?
                .run()
                .await?;
        }
        Ok(id)
    }

    /// Puts every version whose date has come into the price book, oldest
    /// first, each once, with a public record of the change.
    pub(crate) async fn apply_due_versions(&self) -> Result<u32> {
        let now = rfc3339(now_ms());
        let due = self
            .db
            .prepare("SELECT * FROM price_versions WHERE applied_at IS NULL AND effective_at <= ? ORDER BY effective_at, version")
            .bind(&[now.as_str().into()])?
            .all()
            .await?
            .results::<Version>()?;
        let mut applied = 0;
        for v in due {
            let claimed = self
                .db
                .prepare("UPDATE price_versions SET applied_at = ? WHERE id = ? AND applied_at IS NULL RETURNING id")
                .bind(&[now.as_str().into(), v.id.as_str().into()])?
                .first::<Value>(None)
                .await?;
            if claimed.is_none() {
                continue;
            }
            let reason = if v.created_by.contains('@') { format!("{} (approved by g1t staff)", v.reason) } else { v.reason.clone() };
            self.db
                .batch(vec![
                    self.db
                        .prepare(
                            "INSERT INTO price_changes (id, meter, old_cost_micros, new_cost_micros, markup_percent, old_markup_percent, reason, created_at)
                             SELECT ?, meter, cost_micros, ?, ?, CASE WHEN markup_percent <> ? THEN markup_percent END, ?, ? FROM prices WHERE meter = ?",
                        )
                        .bind(&[
                            new_id("prc", now_ms()).into(),
                            v.cost_micros.into(),
                            v.markup_percent.into(),
                            v.markup_percent.into(),
                            reason.as_str().into(),
                            now.as_str().into(),
                            v.meter.as_str().into(),
                        ])?,
                    self.db
                        .prepare("UPDATE prices SET cost_micros = ?, markup_percent = ?, source = 'cloudflare', updated_at = ? WHERE meter = ?")
                        .bind(&[v.cost_micros.into(), v.markup_percent.into(), now.as_str().into(), v.meter.as_str().into()])?,
                ])
                .await?;
            applied += 1;
        }
        Ok(applied)
    }

    /// The id of the price version in force for `meter` now, for the
    /// ledger.
    pub(crate) async fn version_now(&self, meter: &str) -> Result<Option<String>> {
        let versions = self
            .db
            .prepare("SELECT * FROM price_versions WHERE meter = ? AND applied_at IS NOT NULL")
            .bind(&[meter.into()])?
            .all()
            .await?
            .results::<Version>()?;
        Ok(in_force(&versions, meter, &rfc3339(now_ms())).map(|v| v.id.clone()))
    }

    pub(crate) async fn proposals(&self) -> Result<Vec<PriceProposal>> {
        Ok(self
            .db
            .prepare(format!(
                "{PROPOSAL_SQL} ORDER BY CASE WHEN p.status = 'open' THEN 0 ELSE 1 END, p.created_at DESC LIMIT 40"
            ))
            .all()
            .await?
            .results::<ProposalRow>()?
            .into_iter()
            .map(PriceProposal::from)
            .collect())
    }

    pub(crate) async fn versions(&self) -> Result<Vec<PriceVersion>> {
        Ok(self
            .db
            .prepare("SELECT * FROM price_versions ORDER BY CASE WHEN applied_at IS NULL THEN 0 ELSE 1 END, effective_at DESC, version DESC LIMIT 60")
            .all()
            .await?
            .results::<Version>()?
            .into_iter()
            .map(|v| PriceVersion {
                price_micros: Price::price_for(v.cost_micros, v.markup_percent),
                id: v.id,
                meter: v.meter,
                version: v.version,
                cost_micros: v.cost_micros,
                markup_percent: v.markup_percent,
                effective_at: v.effective_at,
                reason: v.reason,
                created_by: v.created_by,
                applied_at: v.applied_at,
            })
            .collect())
    }

    /// Prices not in force yet, for the pricing page's "coming" changes.
    pub(crate) async fn coming_changes(&self) -> Result<Vec<PriceChange>> {
        #[derive(Deserialize)]
        struct Row {
            meter: String,
            old_cost_micros: Option<f64>,
            cost_micros: f64,
            markup_percent: u32,
            reason: String,
            created_at: String,
            effective_at: String,
        }
        Ok(self
            .db
            .prepare(
                "SELECT v.meter, p.cost_micros AS old_cost_micros, v.cost_micros, v.markup_percent, v.reason, v.created_at, v.effective_at
                 FROM price_versions v LEFT JOIN prices p ON p.meter = v.meter
                 WHERE v.applied_at IS NULL ORDER BY v.effective_at",
            )
            .all()
            .await?
            .results::<Row>()?
            .into_iter()
            .map(|r| PriceChange {
                old_cost_micros: r.old_cost_micros.unwrap_or(r.cost_micros),
                meter: r.meter,
                new_cost_micros: r.cost_micros,
                markup_percent: r.markup_percent,
                old_markup_percent: None,
                reason: r.reason,
                created_at: r.created_at,
                effective_at: Some(r.effective_at),
            })
            .collect())
    }

    /// `admin_decide_proposal`: an approved fall applies now; an approved
    /// rise after the notice period.
    pub(crate) async fn admin_decide_proposal(&self, a: AdminDecideProposalArgs) -> Result<Outcome<PriceProposal>> {
        let found = self
            .db
            .prepare(format!("{PROPOSAL_SQL} WHERE p.id = ?"))
            .bind(&[a.id.as_str().into()])?
            .first::<ProposalRow>(None)
            .await?;
        let Some(found) = found else {
            return Ok(Outcome::fail(FailureCode::NotFound, "No such proposal."));
        };
        if found.status != "open" {
            return Ok(Outcome::fail(FailureCode::Conflict, format!("This proposal is already {}.", found.status)));
        }
        let approve = match a.decision.as_str() {
            "approve" => true,
            "reject" => false,
            _ => return Ok(Outcome::fail(FailureCode::Invalid, "Approve or reject.")),
        };
        if !approve && a.note.trim().is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Say why it is rejected, for whoever measures it next."));
        }
        let now = now_ms();
        let stamp = rfc3339(now);
        self.db
            .prepare("UPDATE price_proposals SET status = ?, decided_at = ?, decided_by = ?, note = ? WHERE id = ? AND status = 'open'")
            .bind(&[
                if approve { "approved" } else { "rejected" }.into(),
                stamp.as_str().into(),
                a.by.as_str().into(),
                a.note.trim().into(),
                a.id.as_str().into(),
            ])?
            .run()
            .await?;
        if approve {
            let settings = self.cost_settings().await?;
            let (current, markup) = self.latest_cost(&found.meter).await?.unwrap_or((found.current_cost_micros, 20));
            let effective = effective_ms(current, found.proposed_cost_micros, now, settings.notice_days, MONTHLY.contains(&found.meter.as_str()));
            self.schedule_version(&found.meter, found.proposed_cost_micros, markup, effective, &found.reason, &a.by, Some(&found.id))
                .await?;
            self.apply_due_versions().await?;
        }
        self.audit(
            "costs",
            if approve { "price_approved" } else { "price_rejected" },
            &format!("{}: {:.4} to {:.4}. {}", found.meter, found.current_cost_micros, found.proposed_cost_micros, a.note.trim()),
            &a.by,
        )
        .await?;
        let row = self
            .db
            .prepare(format!("{PROPOSAL_SQL} WHERE p.id = ?"))
            .bind(&[a.id.as_str().into()])?
            .first::<ProposalRow>(None)
            .await?;
        Ok(match row {
            Some(row) => Outcome::Ok(row.into()),
            None => Outcome::fail(FailureCode::NotFound, "No such proposal."),
        })
    }

    /// Emails owners of workspaces on the plan about each rise still to
    /// come, once per rise per workspace.
    pub(crate) async fn tell_owners_of_rises(&self, identity: &worker::Fetcher) -> Result<()> {
        #[derive(Deserialize)]
        struct Rise {
            id: String,
            title: Option<String>,
            old_cost: f64,
            cost_micros: f64,
            markup_percent: u32,
            unit: Option<String>,
            effective_at: String,
            reason: String,
        }
        let rises = self
            .db
            .prepare(
                "SELECT v.id, p.title, p.cost_micros AS old_cost, v.cost_micros, v.markup_percent, p.unit, v.effective_at, v.reason
                 FROM price_versions v JOIN prices p ON p.meter = v.meter
                 WHERE v.applied_at IS NULL AND v.cost_micros > p.cost_micros * ?",
            )
            .bind(&[(1.0 + EMAIL_RISE_PERCENT / 100.0).into()])?
            .all()
            .await?
            .results::<Rise>()?;
        let mut sent = 0;
        for rise in rises {
            #[derive(Deserialize)]
            struct Workspace {
                workspace: String,
            }
            let workspaces = self
                .db
                .prepare(
                    "SELECT DISTINCT workspace FROM subscriptions WHERE feature = 'plan' AND status IN ('active', 'canceling')
                     AND workspace NOT IN (SELECT workspace FROM price_notices WHERE version_id = ?) LIMIT ?",
                )
                .bind(&[rise.id.as_str().into(), ((NOTICES_PER_RUN - sent) as u32).into()])?
                .all()
                .await?
                .results::<Workspace>()?;
            let title = rise.title.clone().unwrap_or_default();
            let unit = rise.unit.clone().unwrap_or_default();
            let price = |cost: f64| crate::features::dollars(Price::price_for(cost, rise.markup_percent).round() as i64);
            let intro = format!(
                "From {}, {title} on g1t goes from {} to {} per {unit}. It is what g1t pays Cloudflare plus 20%, and the cost moved: {} Nothing already charged changes.",
                &rise.effective_at[..10],
                price(rise.old_cost),
                price(rise.cost_micros),
                rise.reason
            );
            for Workspace { workspace } in workspaces {
                let args = g1t_contracts::identity::NotifyOwnersArgs {
                    workspace: workspace.clone(),
                    subject: format!("g1t: {title} costs more from {}", &rise.effective_at[..10]),
                    intro: intro.clone(),
                    action: "See prices".to_owned(),
                    link: "https://g1t.sh/pricing".to_owned(),
                    footer: "You get this because you own a workspace on the g1t plan. How prices follow costs: https://docs.g1t.sh/guides/usage-and-billing/#how-prices-are-set".to_owned(),
                };
                // Recorded whether or not anyone was there to tell.
                if let Err(error) = g1t_kit::call::<_, u32>(identity, "notify_owners", &args).await {
                    worker::console_error!("could not tell {workspace} of a price rise: {error}");
                    continue;
                }
                self.db
                    .prepare("INSERT OR IGNORE INTO price_notices (version_id, workspace, sent_at) VALUES (?, ?, ?)")
                    .bind(&[rise.id.as_str().into(), workspace.as_str().into(), rfc3339(now_ms()).into()])?
                    .run()
                    .await?;
                sent += 1;
                if sent >= NOTICES_PER_RUN {
                    return Ok(());
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: &str = "2026-10-06T04:17:00.000Z";

    fn now() -> u64 {
        parse_rfc3339(NOW).unwrap()
    }

    fn guard() -> Guard {
        Guard { auto_apply: true, auto_percent: 25.0, notice_days: 14 }
    }

    #[test]
    fn small_moves_are_noise_and_wild_ones_wait_for_a_person() {
        assert_eq!(decide(21.0, 21.2, guard(), now(), false), Decision::Nothing);
        assert_eq!(decide(21.0, 0.0, guard(), now(), false), Decision::Nothing);
        assert_eq!(decide(21.0, 200.0, guard(), now(), false), Decision::Approve { suspect: true });
        assert_eq!(decide(21.0, 2.0, guard(), now(), false), Decision::Approve { suspect: true });
    }

    #[test]
    fn moves_inside_the_guardrail_apply_themselves_falls_at_once_rises_after_notice() {
        // Down 19%: at once.
        assert_eq!(decide(21.0, 17.0, guard(), now(), false), Decision::Auto { effective_ms: now() });
        // Up 19%: after 14 days.
        let Decision::Auto { effective_ms } = decide(21.0, 25.0, guard(), now(), false) else { panic!() };
        assert_eq!(rfc3339(effective_ms), "2026-10-20T04:17:00.000Z");
        // A monthly meter's rise waits for the month after the notice.
        let Decision::Auto { effective_ms } = decide(150_000.0, 180_000.0, guard(), now(), true) else { panic!() };
        assert_eq!(rfc3339(effective_ms), "2026-11-01T00:00:00.000Z");
        let late = parse_rfc3339("2026-10-25T00:00:00Z").unwrap();
        assert_eq!(rfc3339(effective_ms_for(late)), "2026-12-01T00:00:00.000Z");
    }

    fn effective_ms_for(now: u64) -> u64 {
        effective_ms(1.0, 2.0, now, 14, true)
    }

    #[test]
    fn past_the_guardrail_or_with_auto_off_staff_decide() {
        // Up 50%: staff.
        assert_eq!(decide(150_000.0, 225_000.0, guard(), now(), true), Decision::Approve { suspect: false });
        // Down 30%: staff too; the guardrail is either way.
        assert_eq!(decide(100.0, 70.0, guard(), now(), false), Decision::Approve { suspect: false });
        let off = Guard { auto_apply: false, ..guard() };
        assert_eq!(decide(21.0, 22.0, off, now(), false), Decision::Approve { suspect: false });
    }

    #[test]
    fn a_past_statement_keeps_the_price_of_its_time() {
        let v = |version: u32, cost: f64, at: &str| Version {
            id: format!("pv_git_operations_{version}"),
            meter: "git_operations".into(),
            version,
            cost_micros: cost,
            markup_percent: 20,
            effective_at: at.into(),
            reason: String::new(),
            created_by: "keeper".into(),
            applied_at: None,
        };
        let versions = vec![v(1, 150_000.0, "2026-10-05T00:00:00Z"), v(2, 450_000.0, "2026-11-01T00:00:00.000Z"), v(3, 400_000.0, "2026-12-01T00:00:00.000Z")];
        // October's charges were at version 1, whatever came later.
        assert_eq!(in_force(&versions, "git_operations", "2026-10-31T23:59:59Z").unwrap().version, 1);
        assert_eq!(in_force(&versions, "git_operations", "2026-11-15T00:00:00Z").unwrap().version, 2);
        assert_eq!(in_force(&versions, "git_operations", "2027-01-01T00:00:00Z").unwrap().cost_micros, 400_000.0);
        assert!(in_force(&versions, "git_operations", "2026-01-01T00:00:00Z").is_none());
        assert!(in_force(&versions, "sandbox_second", "2027-01-01T00:00:00Z").is_none());
    }

    #[test]
    fn settings_read_with_defaults_and_are_checked() {
        let s = settings_from(&[("auto_apply".into(), "false".into()), ("notice_days".into(), "30".into()), ("anomaly_factor".into(), "x".into())]);
        assert!(!s.auto_apply);
        assert_eq!(s.notice_days, 30);
        assert_eq!(s.anomaly_factor, 1.0);
        assert_eq!(s.auto_apply_percent, 25.0);
        assert!(check_settings(&s).is_ok());
        assert!(check_settings(&CostSettings { notice_days: 120, ..s.clone() }).is_err());
        assert!(check_settings(&CostSettings { alert_days: 0, ..s.clone() }).is_err());
        assert!(check_settings(&CostSettings { auto_apply_percent: 150.0, ..s }).is_err());
    }
}
