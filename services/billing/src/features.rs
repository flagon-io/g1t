//! The g1t plan: one monthly price per workspace, never per person, that
//! includes usage, private storage and deployments; usage past what it
//! includes is charged at cost plus the margin. None of it is free,
//! whatever `FREE_WHILE_BUILDING` says.
//!
//! Deployments were once a plan of their own. They come with the g1t plan
//! now: `has_feature(deployments)` answers whether the workspace has the
//! plan, and a Deployments subscription from before keeps working until
//! its period ends. Billing sets each one to end then, once
//! (`retire_deployments_plans`), so no one pays for both.

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
    /// What the g1t plan costs and includes, as it is sold now.
    pub(crate) fn plan(&self, _feature: Feature) -> Plan {
        let p = &self.plans;
        let price = |cost: i64| dollars(crate::charge_micros(cost as f64 / MICROS_PER_DOLLAR as f64, self.margin_percent));
        Plan {
            feature: Feature::Plan,
            title: Feature::Plan.title().to_owned(),
            monthly_cents: p.plan_monthly_cents,
            includes: vec![
                format!(
                    "{} of usage each month at cost plus {}%, used first. Unused usage does not roll over.",
                    dollars(p.plan_included_micros),
                    self.margin_percent
                ),
                "Everyone in the workspace, at one price: never per person".to_owned(),
                "Agents, checks, workflows, the merge queue and semantic search, on demand past the included usage, up to your spend limit".to_owned(),
                format!(
                    "Deployments: {} apps, {} build minutes, {} million requests, {} million CPU milliseconds and {} custom domains a month",
                    allowance::APPS,
                    p.build_seconds / 60,
                    allowance::REQUESTS / 1_000_000,
                    allowance::CPU_MS / 1_000_000,
                    allowance::CUSTOM_DOMAINS,
                ),
                format!("{} of private repository storage, rather than {}", bytes(p.plan_storage_bytes), bytes(p.free_storage_bytes)),
                format!(
                    "The other {} of the price pays for running g1t, the free forge for everyone, and the people building it",
                    dollars(i64::from(p.plan_monthly_cents) * 10_000 - p.plan_included_micros)
                ),
            ],
            overage: format!(
                "Usage past what is included is charged at cost plus {}%: sandbox time by the second, models at what the provider charged, and for deployments {} per build minute, {} per extra app a month, {} per million requests, {} per million CPU milliseconds and {} per extra custom domain a month.",
                self.margin_percent,
                price(allowance::MICROS_PER_BUILD_SECOND * 60),
                price(allowance::MICROS_PER_APP_MONTH),
                price(allowance::MICROS_PER_MILLION_REQUESTS),
                price(allowance::MICROS_PER_MILLION_CPU_MS),
                price(allowance::MICROS_PER_DOMAIN_MONTH),
            ),
        }
    }

    /// When the workspace's plan started, and when the period paid for
    /// ends: its first billing cycle is the first month.
    pub(crate) async fn plan_cycle(&self, workspace: &str) -> Result<Option<(String, Option<String>)>> {
        let row = match self.current(workspace, Feature::Plan).await? {
            Some(row) => Some(row),
            None => self.current(workspace, Feature::Deployments).await?,
        };
        Ok(row
            .filter(|row| status_from(&row.status).on())
            .map(|row| (row.started_at, row.period_end)))
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

    /// The plan as a workspace sees it. A Deployments subscription from
    /// before the plan shows as the plan until its period ends.
    async fn state(&self, workspace: &str, _feature: Feature) -> Result<FeatureState> {
        let subscription = match self.current(workspace, Feature::Plan).await?.and_then(|row| row.subscription()) {
            Some(plan) if plan.status.on() => Some(plan),
            plan => self
                .current(workspace, Feature::Deployments)
                .await?
                .and_then(|row| row.subscription())
                .filter(|legacy| legacy.status.on())
                .or(plan),
        };
        let included = self.included(workspace).await?;
        Ok(FeatureState {
            plan: self.plan(Feature::Plan),
            on: included || self.stripe.is_none() || subscription.as_ref().is_some_and(|s| s.status.on()),
            subscription,
            included,
        })
    }

    /// Whether the plan is on without its price: comped terms, an
    /// enterprise's workspaces, or given by g1t staff.
    async fn included(&self, workspace: &str) -> Result<bool> {
        let account = self.account_of(workspace).await?;
        Ok(account.terms.kind == g1t_contracts::billing::TermsKind::Comped
            || account.kind == g1t_contracts::billing::AccountKind::Enterprise
            || account.allowances.plan)
    }

    /// Sets every Deployments subscription from before the plan to end
    /// with its period, once, so no one pays for it and the plan both.
    /// Until then it counts as the plan.
    pub(crate) async fn retire_deployments_plans(&self) -> Result<()> {
        let Some(stripe) = &self.stripe else { return Ok(()) };
        #[derive(Deserialize)]
        struct Legacy {
            workspace: String,
            subscription_id: String,
            started_by: String,
            period_end: Option<String>,
        }
        let legacy = self
            .db
            .prepare(
                "SELECT workspace, subscription_id, started_by, period_end FROM subscriptions
                 WHERE feature = 'deployments' AND status = 'active' LIMIT 20",
            )
            .all()
            .await?
            .results::<Legacy>()?;
        for plan in legacy {
            match stripe.cancel_at_period_end(&plan.subscription_id, true).await {
                Ok(subscription) => {
                    self.record(&plan.workspace, Feature::Deployments, &subscription, &plan.started_by).await?;
                    let account = self.account_of(&plan.workspace).await?;
                    self.audit(
                        &account.id,
                        "migration",
                        &format!(
                            "{}: the Deployments plan ends {} and is not renewed; deployments come with the g1t plan now",
                            plan.workspace,
                            plan.period_end.as_deref().map_or("at the end of its period", |end| &end[..10])
                        ),
                        "billing",
                    )
                    .await?;
                }
                Err(error) if is_missing(&error) => {
                    self.db
                        .prepare("UPDATE subscriptions SET status = 'canceled', updated_at = ? WHERE workspace = ? AND feature = 'deployments'")
                        .bind(&[rfc3339(now_ms()).into(), plan.workspace.as_str().into()])?
                        .run()
                        .await?;
                }
                Err(error) => worker::console_error!("could not end {}'s Deployments plan: {error}", plan.workspace),
            }
        }
        Ok(())
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
        Ok(Outcome::Ok(vec![self.state(&workspace, Feature::Plan).await?]))
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
                "Payments are not set up on this g1t, so the plan is already on.",
            ));
        };
        // Deployments come with the plan: asking for them starts the plan.
        let feature = Feature::Plan;
        let state = self.state(&workspace, feature).await?;
        if state.included {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                format!("The g1t plan is included for {workspace} already, at no charge."),
            ));
        }
        if self.plan_on(&workspace, Feature::Plan).await? {
            return Ok(Outcome::fail(FailureCode::Conflict, format!("The g1t plan is already on for {workspace}.")));
        }
        let plan = self.plan(feature);
        let customer = self.row(&workspace).await?.and_then(|row| row.customer_id);
        // The card from the card check: the plan starts on it at once, with
        // no second page. A card that needs the bank's approval again goes
        // through Stripe's page instead.
        if let (Some(customer), Some(method)) = (customer.as_deref(), self.checked_card(&workspace).await?) {
            match stripe
                .subscribe_with_card(&workspace, feature.as_str(), &plan.title, plan.monthly_cents, customer, &method)
                .await
            {
                Ok(subscription) if matches!(subscription.status.as_str(), "active" | "trialing") => {
                    self.record(&workspace, feature, &subscription, &a.actor.username).await?;
                    let account = self.account_of(&workspace).await?;
                    self.audit(&account.id, "plan", &format!("{workspace}: the g1t plan started on the checked card"), &a.actor.username)
                        .await?;
                    let separator = if a.return_url.contains('?') { '&' } else { '?' };
                    return Ok(Outcome::Ok(Checkout { url: format!("{}{separator}plan=started", a.return_url) }));
                }
                Ok(subscription) => {
                    // Incomplete: let it lapse, and use the page.
                    let _ = stripe.cancel_now(&subscription.id).await;
                }
                Err(error) => worker::console_log!("{workspace}: the plan could not start on the checked card: {error}"),
            }
        }
        let start = |customer: Option<String>| {
            let plan = &plan;
            let workspace = &workspace;
            let return_url = &a.return_url;
            async move {
                stripe
                    .start_subscription(
                        workspace,
                        feature.as_str(),
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
                feature.as_str().into(),
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
            return Ok(Outcome::Ok(self.state(&workspace, Feature::Plan).await?));
        };
        let Some(feature) = Feature::parse(&checkout.feature) else {
            return Ok(Outcome::fail(FailureCode::NotFound, "No such plan."));
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
                "Only an owner can change the workspace's plan.",
            ));
        }
        // The plan, or a Deployments subscription from before it.
        let row = match self.current(&workspace, Feature::Plan).await? {
            Some(row) if status_from(&row.status) != SubscriptionStatus::Canceled => Some((Feature::Plan, row)),
            _ => self.current(&workspace, Feature::Deployments).await?.map(|row| (Feature::Deployments, row)),
        };
        let (Some(stripe), Some((feature, row))) = (&self.stripe, row) else {
            return Ok(Outcome::fail(FailureCode::NotFound, format!("The g1t plan is not on for {workspace}.")));
        };
        let subscription = stripe
            .cancel_at_period_end(&row.subscription_id, !a.resume)
            .await?;
        self.record(&workspace, feature, &subscription, &row.started_by)
            .await?;
        Ok(Outcome::Ok(self.state(&workspace, Feature::Plan).await?))
    }

    /// Whether the workspace has the plan, which deployments come with.
    pub(crate) async fn has_feature(&self, a: HasFeatureArgs) -> Result<Outcome<bool>> {
        let workspace = a.workspace.to_lowercase();
        if self.has_plan(&workspace).await? {
            return Ok(Outcome::Ok(true));
        }
        let what = match a.feature {
            Feature::Deployments => "Deployments come with the g1t plan",
            Feature::Plan => "This needs the g1t plan",
        };
        Ok(Outcome::fail(
            FailureCode::PaymentRequired,
            format!(
                "{what} ($20 a month for the workspace, with $10 of usage included), and {workspace} does not have it. An owner can start it at /{workspace}/-/billing."
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
        // A build: the plan's build time this month pays for what it can,
        // and the rest is priced at the price book's build second, which the
        // keeper keeps at what Cloudflare bills, rather than at what the
        // caller worked out.
        let cost_micros = match a.build_seconds.filter(|s| *s > 0 && a.feature == Feature::Deployments) {
            Some(seconds) => {
                let measured = self.price("build_second").await?.map(|(cost, _)| (f64::from(seconds) * cost).ceil() as i64);
                let cost_micros = measured.unwrap_or(a.cost_micros);
                let included = self
                    .draw_allowance("build_seconds", &workspace, &month, seconds.into(), self.plans.build_seconds.into())
                    .await?;
                if included > 0 {
                    description.push_str(&format!(
                        ", {} of it included in the plan",
                        if included == i64::from(seconds) { "all".to_owned() } else { format!("{included} s") }
                    ));
                }
                billable_build_cost(cost_micros, seconds, included)
            }
            None => a.cost_micros,
        };
        let cost = cost_micros as f64 / MICROS_PER_DOLLAR as f64;
        // Never free: the margin applies whatever FREE_WHILE_BUILDING says,
        // and only the account's terms change it. The plan's included usage
        // pays what it can; the trial and the open-source pool never pay for
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
        // A 5-minute build at 15 millionths a second costs 4,500.
        assert_eq!(billable_build_cost(4_500, 300, 300), 0);
        assert_eq!(billable_build_cost(4_500, 300, 0), 4_500);
        // The allowance ran out a minute into it: four minutes are charged.
        assert_eq!(billable_build_cost(4_500, 300, 60), 3_600);
        // Then at cost plus 20%.
        assert_eq!(crate::credits::with_margin(3_600, 20), 4_320);
        // 200 minutes a month cost g1t about $0.18.
        let month = crate::credits::Config::default().build_seconds;
        assert_eq!(month, 12_000);
        assert_eq!(i64::from(month) * allowance::MICROS_PER_BUILD_SECOND, 180_000);
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
