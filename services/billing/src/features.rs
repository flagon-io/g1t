//! Paid features a workspace turns on with a monthly plan, the way
//! Cloudflare's Workers for Platforms is bought: a price that includes an
//! allowance, and usage past it charged from credit at cost plus the
//! margin. None of it is free, whatever `FREE_WHILE_BUILDING` says.

use g1t_contracts::billing::deployments_allowance as allowance;
use g1t_contracts::billing::*;
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, Role};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::stripe::{StripeSubscription, is_missing};
use crate::{Billing, Touched, members_only, optional};

#[derive(Deserialize)]
struct SubscriptionRow {
    feature: String,
    subscription_id: String,
    status: String,
    period_end: Option<String>,
    started_by: String,
    started_at: String,
}

#[derive(Deserialize)]
struct PlanCheckoutRow {
    workspace: String,
    created_by: String,
    feature: String,
}

fn status_from(text: &str) -> SubscriptionStatus {
    match text {
        "active" => SubscriptionStatus::Active,
        "canceling" => SubscriptionStatus::Canceling,
        "past_due" => SubscriptionStatus::PastDue,
        _ => SubscriptionStatus::Canceled,
    }
}

fn status_text(status: SubscriptionStatus) -> &'static str {
    match status {
        SubscriptionStatus::Active => "active",
        SubscriptionStatus::Canceling => "canceling",
        SubscriptionStatus::PastDue => "past_due",
        SubscriptionStatus::Canceled => "canceled",
    }
}

/// What the processor's state for a plan means here.
fn status_of(subscription: &StripeSubscription) -> SubscriptionStatus {
    match subscription.status.as_str() {
        "active" | "trialing" if subscription.cancel_at_period_end => SubscriptionStatus::Canceling,
        "active" | "trialing" => SubscriptionStatus::Active,
        "past_due" | "unpaid" | "incomplete" | "paused" => SubscriptionStatus::PastDue,
        _ => SubscriptionStatus::Canceled,
    }
}

/// `1 GB`, `50 GB`, or `500 MB`, as storage is priced (powers of ten).
pub(crate) fn bytes(bytes: i64) -> String {
    if bytes >= 1_000_000_000 && bytes % 1_000_000_000 == 0 {
        format!("{} GB", bytes / 1_000_000_000)
    } else if bytes >= 1_000_000_000 {
        format!("{:.1} GB", bytes as f64 / 1e9)
    } else {
        format!("{} MB", bytes / 1_000_000)
    }
}

/// Dollars to the cent, or finer for prices under a cent, so that a
/// build minute's $0.0015 does not read as nothing.
pub(crate) fn dollars(micros: i64) -> String {
    let text = format!("{:.4}", micros as f64 / MICROS_PER_DOLLAR as f64);
    let (whole, fraction) = text.split_once('.').unwrap_or((&text, ""));
    let fraction = fraction.trim_end_matches('0');
    format!("${whole}.{fraction:0<2}")
}

impl SubscriptionRow {
    fn subscription(&self) -> Option<Subscription> {
        Some(Subscription {
            feature: Feature::parse(&self.feature)?,
            status: status_from(&self.status),
            period_end: self.period_end.clone(),
            started_by: self.started_by.clone(),
            started_at: self.started_at.clone(),
        })
    }
}

impl Billing {
    pub(crate) fn plan(&self, feature: Feature) -> Plan {
        match feature {
            Feature::Team => Plan {
                feature,
                title: feature.title().to_owned(),
                monthly_cents: self.plans.team_monthly_cents,
                includes: vec![
                    format!(
                        "{} of usage credit each month, drawn first by the month's usage at cost plus {}%. Unused credit does not roll over.",
                        dollars(self.plans.team_included_micros),
                        self.margin_percent
                    ),
                    format!(
                        "{} of private repository storage, rather than {}",
                        bytes(self.plans.team_storage_bytes),
                        bytes(self.plans.free_storage_bytes)
                    ),
                    format!(
                        "The audit log kept {}, rather than {} days",
                        if self.plans.team_audit_days % 365 == 0 {
                            match self.plans.team_audit_days / 365 {
                                1 => "for 1 year".to_owned(),
                                years => format!("for {years} years"),
                            }
                        } else {
                            format!("for {} days", self.plans.team_audit_days)
                        },
                        self.plans.audit_days
                    ),
                    "Everyone in the workspace, at one price: never per person".to_owned(),
                ],
                overage: format!(
                    "Usage past the credit is charged as it is without the plan: at cost plus {}%.",
                    self.margin_percent
                ),
            },
            Feature::Deployments => Plan {
                feature,
                title: feature.title().to_owned(),
                monthly_cents: self.deployments_monthly_cents,
                includes: vec![
                    format!(
                        "{} apps deployed at once, production and previews together",
                        allowance::APPS
                    ),
                    format!("{} build minutes", self.plans.build_seconds / 60),
                    format!("{} million requests", allowance::REQUESTS / 1_000_000),
                    format!("{} million CPU milliseconds", allowance::CPU_MS / 1_000_000),
                    format!(
                        "{} custom domains, with certificates, then {} each a month",
                        allowance::CUSTOM_DOMAINS,
                        dollars(crate::charge_micros(
                            allowance::MICROS_PER_DOMAIN_MONTH as f64 / MICROS_PER_DOLLAR as f64,
                            self.margin_percent
                        )),
                    ),
                    "Previews that cost nothing while no one visits them".to_owned(),
                ],
                overage: format!(
                    "Usage past that is charged at Cloudflare's price plus {3}%: {4} per build minute, by the second, {0} per extra app a month, {1} per million requests and {2} per million CPU milliseconds.",
                    dollars(crate::charge_micros(
                        allowance::MICROS_PER_APP_MONTH as f64 / MICROS_PER_DOLLAR as f64,
                        self.margin_percent
                    )),
                    dollars(crate::charge_micros(
                        allowance::MICROS_PER_MILLION_REQUESTS as f64 / MICROS_PER_DOLLAR as f64,
                        self.margin_percent
                    )),
                    dollars(crate::charge_micros(
                        allowance::MICROS_PER_MILLION_CPU_MS as f64 / MICROS_PER_DOLLAR as f64,
                        self.margin_percent
                    )),
                    self.margin_percent,
                    dollars(crate::charge_micros(
                        (allowance::MICROS_PER_BUILD_SECOND * 60) as f64 / MICROS_PER_DOLLAR as f64,
                        self.margin_percent
                    )),
                ),
            },
        }
    }

    async fn subscription_row(&self, workspace: &str, feature: Feature) -> Result<Option<SubscriptionRow>> {
        self.db
            .prepare(
                "SELECT feature, subscription_id, status, period_end, started_by, started_at
                 FROM subscriptions WHERE workspace = ? AND feature = ?",
            )
            .bind(&[workspace.into(), feature.as_str().into()])?
            .first::<SubscriptionRow>(None)
            .await
    }

    /// Writes down what the processor says about a plan.
    pub(crate) async fn record(
        &self,
        workspace: &str,
        feature: Feature,
        subscription: &StripeSubscription,
        started_by: &str,
    ) -> Result<()> {
        let now = rfc3339(now_ms());
        let period_end = subscription.period_end().map(|seconds| rfc3339(seconds.max(0) as u64 * 1000));
        self.db
            .prepare(
                "INSERT INTO subscriptions
                   (workspace, feature, subscription_id, status, period_end, started_by, started_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
                 ON CONFLICT (workspace, feature) DO UPDATE SET
                   subscription_id = ?3, status = ?4, period_end = ?5, updated_at = ?7,
                   started_by = CASE WHEN subscription_id = ?3 THEN started_by ELSE ?6 END,
                   started_at = CASE WHEN subscription_id = ?3 THEN started_at ELSE ?7 END",
            )
            .bind(&[
                workspace.into(),
                feature.as_str().into(),
                subscription.id.as_str().into(),
                status_text(status_of(subscription)).into(),
                optional(period_end.as_deref()),
                started_by.into(),
                now.as_str().into(),
            ])?
            .run()
            .await?;
        Ok(())
    }

    /// A workspace's plan for a feature, asking the processor again once
    /// the period it last knew of is over.
    async fn current(&self, workspace: &str, feature: Feature) -> Result<Option<SubscriptionRow>> {
        let Some(row) = self.subscription_row(workspace, feature).await? else {
            return Ok(None);
        };
        let stale = row.period_end.as_deref().is_none_or(|end| end <= rfc3339(now_ms()).as_str())
            && row.status != "canceled";
        if let (true, Some(stripe)) = (stale, &self.stripe) {
            match stripe.subscription(&row.subscription_id).await {
                Ok(subscription) => self.record(workspace, feature, &subscription, &row.started_by).await?,
                // A plan from another Stripe account: it has ended here.
                Err(error) if is_missing(&error) => {
                    self.db
                        .prepare("UPDATE subscriptions SET status = 'canceled', updated_at = ? WHERE workspace = ? AND feature = ?")
                        .bind(&[rfc3339(now_ms()).into(), workspace.into(), feature.as_str().into()])?
                        .run()
                        .await?;
                }
                Err(error) => return Err(error),
            }
            return self.subscription_row(workspace, feature).await;
        }
        Ok(Some(row))
    }

    async fn state(&self, workspace: &str, feature: Feature) -> Result<FeatureState> {
        let subscription = self
            .current(workspace, feature)
            .await?
            .and_then(|row| row.subscription());
        let included = self.included(workspace, feature).await?;
        Ok(FeatureState {
            plan: self.plan(feature),
            on: included || self.stripe.is_none() || subscription.as_ref().is_some_and(|s| s.status.on()),
            subscription,
            included,
        })
    }

    /// Whether the feature is on without a plan: comped terms have every
    /// feature, and g1t staff can give an account Team.
    async fn included(&self, workspace: &str, feature: Feature) -> Result<bool> {
        let account = self.account_of(workspace).await?;
        Ok(account.terms.kind == g1t_contracts::billing::TermsKind::Comped
            || (feature == Feature::Team && account.allowances.team))
    }

    /// Whether the workspace's plan for the feature is paid up.
    pub(crate) async fn plan_on(&self, workspace: &str, feature: Feature) -> Result<bool> {
        Ok(self
            .current(workspace, feature)
            .await?
            .and_then(|row| row.subscription())
            .is_some_and(|s| s.status.on()))
    }

    pub(crate) async fn features(&self, a: FeaturesArgs) -> Result<Outcome<Vec<FeatureState>>> {
        let workspace = a.workspace.to_lowercase();
        if !a.viewer.is_some_and(|viewer| viewer.is_member(&workspace)) {
            return Ok(members_only());
        }
        let mut states = Vec::new();
        for feature in Feature::ALL {
            states.push(self.state(&workspace, feature).await?);
        }
        Ok(Outcome::Ok(states))
    }

    pub(crate) async fn subscribe(&self, a: SubscribeArgs) -> Result<Outcome<Checkout>> {
        let workspace = a.workspace.to_lowercase();
        if a.actor.role_in(&workspace) != Some(Role::Owner) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Only an owner can turn on a paid feature.",
            ));
        }
        let Some(stripe) = &self.stripe else {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "Payments are not set up on this g1t, so every feature is already on.",
            ));
        };
        let state = self.state(&workspace, a.feature).await?;
        if state.included {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                format!("{} is included for {workspace} already, at no charge.", a.feature.title()),
            ));
        }
        if state.subscription.is_some_and(|s| s.status.on()) {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                format!("{} is already on for {workspace}.", a.feature.title()),
            ));
        }
        let plan = self.plan(a.feature);
        let customer = self.row(&workspace).await?.and_then(|row| row.customer_id);
        let start = |customer: Option<String>| {
            let plan = &plan;
            let workspace = &workspace;
            let return_url = &a.return_url;
            async move {
                stripe
                    .start_subscription(
                        workspace,
                        a.feature.as_str(),
                        &plan.title,
                        plan.monthly_cents,
                        customer.as_deref(),
                        return_url,
                    )
                    .await
            }
        };
        let session = match start(customer.clone()).await {
            Ok(session) => session,
            // A customer saved under another Stripe account: start afresh.
            Err(error) if customer.is_some() && is_missing(&error) => {
                self.forget_customer(&workspace).await?;
                start(None).await?
            }
            Err(error) => return Err(error),
        };
        let Some(url) = session.url else {
            return Err(worker::Error::RustError(
                "the card processor returned no payment page".into(),
            ));
        };
        self.db
            .prepare(
                "INSERT INTO checkouts (id, workspace, amount_cents, created_by, created_at, feature)
                 VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                session.id.into(),
                workspace.into(),
                plan.monthly_cents.into(),
                a.actor.username.into(),
                rfc3339(now_ms()).into(),
                a.feature.as_str().into(),
            ])?
            .run()
            .await?;
        Ok(Outcome::Ok(Checkout { url }))
    }

    pub(crate) async fn confirm_subscription(
        &self,
        a: ConfirmSubscriptionArgs,
    ) -> Result<Outcome<FeatureState>> {
        let workspace = a.workspace.to_lowercase();
        if !a.viewer.is_some_and(|viewer| viewer.is_member(&workspace)) {
            return Ok(members_only());
        }
        let checkout = self
            .db
            .prepare(
                "SELECT workspace, created_by, feature FROM checkouts
                 WHERE id = ? AND workspace = ? AND status = 'open' AND feature IS NOT NULL",
            )
            .bind(&[a.session.as_str().into(), workspace.as_str().into()])?
            .first::<PlanCheckoutRow>(None)
            .await?;
        let (Some(stripe), Some(checkout)) = (&self.stripe, checkout) else {
            // Unknown, someone else's, or already done: show where it stands.
            return Ok(Outcome::Ok(self.state(&workspace, Feature::Deployments).await?));
        };
        let Some(feature) = Feature::parse(&checkout.feature) else {
            return Ok(Outcome::fail(FailureCode::NotFound, "No such feature."));
        };
        let session = stripe.session(&a.session).await?;
        if let (Some(subscription_id), true) = (&session.subscription, session.payment_status == "paid") {
            let claimed = self
                .db
                .prepare("UPDATE checkouts SET status = 'paid' WHERE id = ? AND status = 'open' RETURNING id")
                .bind(&[a.session.as_str().into()])?
                .first::<Touched>(None)
                .await?;
            if claimed.is_some() {
                let subscription = stripe.subscription(subscription_id).await?;
                self.record(&checkout.workspace, feature, &subscription, &checkout.created_by)
                    .await?;
                // Keep the card's customer, so later payments need no retyping.
                self.db
                    .prepare(
                        "INSERT INTO accounts (workspace, balance_micros, customer_id, created_at)
                         VALUES (?1, 0, ?2, ?3)
                         ON CONFLICT (workspace) DO UPDATE SET customer_id = COALESCE(customer_id, ?2)",
                    )
                    .bind(&[
                        checkout.workspace.as_str().into(),
                        optional(session.customer.as_deref()),
                        rfc3339(now_ms()).into(),
                    ])?
                    .run()
                    .await?;
            }
        }
        Ok(Outcome::Ok(self.state(&workspace, feature).await?))
    }

    pub(crate) async fn cancel_subscription(
        &self,
        a: CancelSubscriptionArgs,
    ) -> Result<Outcome<FeatureState>> {
        let workspace = a.workspace.to_lowercase();
        if a.actor.role_in(&workspace) != Some(Role::Owner) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Only an owner can change a workspace's plans.",
            ));
        }
        let (Some(stripe), Some(row)) = (&self.stripe, self.current(&workspace, a.feature).await?) else {
            return Ok(Outcome::fail(
                FailureCode::NotFound,
                format!("{} is not on for {workspace}.", a.feature.title()),
            ));
        };
        let subscription = stripe
            .cancel_at_period_end(&row.subscription_id, !a.resume)
            .await?;
        self.record(&workspace, a.feature, &subscription, &row.started_by)
            .await?;
        Ok(Outcome::Ok(self.state(&workspace, a.feature).await?))
    }

    pub(crate) async fn has_feature(&self, a: HasFeatureArgs) -> Result<Outcome<bool>> {
        let workspace = a.workspace.to_lowercase();
        // Comped accounts have every feature without a plan, and staff can
        // give an account Team.
        if self.included(&workspace, a.feature).await? {
            return Ok(Outcome::Ok(true));
        }
        if self.state(&workspace, a.feature).await?.on {
            return Ok(Outcome::Ok(true));
        }
        Ok(Outcome::fail(
            FailureCode::PaymentRequired,
            format!(
                "{} is a paid feature, and it is not on for {workspace}. An owner can turn it on under Billing on the workspace's page.",
                a.feature.title()
            ),
        ))
    }

    pub(crate) async fn charge_feature(&self, a: ChargeFeatureArgs) -> Result<Outcome<bool>> {
        if self.stripe.is_none() || a.cost_micros <= 0 {
            return Ok(Outcome::Ok(false));
        }
        let workspace = a.workspace.to_lowercase();
        let seen = self
            .db
            .prepare("SELECT id FROM ledger WHERE reference = ?")
            .bind(&[a.reference.as_str().into()])?
            .first::<Touched>(None)
            .await?;
        if seen.is_some() {
            return Ok(Outcome::Ok(false));
        }
        let timestamp = rfc3339(now_ms());
        let month = crate::credits::month_of(&timestamp);
        let mut description = a.description.clone();
        // A build: the plan's build time this month pays for what it can.
        let cost_micros = match a.build_seconds.filter(|s| *s > 0 && a.feature == Feature::Deployments) {
            Some(seconds) => {
                let included = self
                    .draw_allowance("build_seconds", &workspace, &month, seconds.into(), self.plans.build_seconds.into())
                    .await?;
                if included > 0 {
                    description.push_str(&format!(
                        ", {} of it included in the plan",
                        if included == i64::from(seconds) { "all".to_owned() } else { format!("{included} s") }
                    ));
                }
                billable_build_cost(a.cost_micros, seconds, included)
            }
            None => a.cost_micros,
        };
        let cost = cost_micros as f64 / MICROS_PER_DOLLAR as f64;
        // Never free: the margin applies whatever FREE_WHILE_BUILDING says,
        // and only the account's terms change it. The Team credit pays what
        // it can; the trial and the open-source pool never pay for
        // deployments.
        let charge = self.terms_of(&workspace).await?.apply(crate::charge_micros(cost, self.margin_percent));
        let drawn = self.draw(&workspace, charge, &month, &crate::credits::Eligible::default()).await?;
        description.push_str(&drawn.note());
        self.post_usage(crate::storage::UsageLine {
            workspace: &workspace,
            charged: charge - drawn.total(),
            description: &description,
            repo: a.repo.as_deref(),
            task: a.feature.as_str(),
            cost: cost_micros,
            reference: &a.reference,
            created_at: &timestamp,
            drawn,
        })
        .await?;
        Ok(Outcome::Ok(true))
    }
}

/// What of a build's cost is charged when `included` of its `seconds` were
/// paid for by the plan: the rest, in proportion, rounded up.
pub(crate) fn billable_build_cost(cost_micros: i64, seconds: u32, included: i64) -> i64 {
    if seconds == 0 {
        return cost_micros;
    }
    let billable = (i64::from(seconds) - included.max(0)).max(0);
    (cost_micros as f64 * billable as f64 / f64::from(seconds)).ceil() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_plan_pays_for_its_build_minutes_and_the_rest_is_charged() {
        // A 5-minute build at 21 millionths a second costs 6,300.
        assert_eq!(billable_build_cost(6_300, 300, 300), 0);
        assert_eq!(billable_build_cost(6_300, 300, 0), 6_300);
        // The allowance ran out a minute into it: four minutes are charged.
        assert_eq!(billable_build_cost(6_300, 300, 60), 5_040);
        // Then at cost plus 20%.
        assert_eq!(crate::credits::with_margin(5_040, 20), 6_048);
        // 200 minutes a month cost g1t about $0.25 of the plan's $5.
        let month = crate::credits::Config::default().build_seconds;
        assert_eq!(month, 12_000);
        assert_eq!(i64::from(month) * allowance::MICROS_PER_BUILD_SECOND, 252_000);
    }

    #[test]
    fn storage_reads_in_gigabytes() {
        assert_eq!(bytes(1_000_000_000), "1 GB");
        assert_eq!(bytes(50_000_000_000), "50 GB");
        assert_eq!(bytes(1_500_000_000), "1.5 GB");
        assert_eq!(bytes(500_000_000), "500 MB");
    }

    #[test]
    fn prices_under_a_cent_keep_their_digits() {
        assert_eq!(dollars(1512), "$0.0015");
        assert_eq!(dollars(24_000), "$0.024");
        assert_eq!(dollars(360_000), "$0.36");
        assert_eq!(dollars(5_000_000), "$5.00");
    }
}
