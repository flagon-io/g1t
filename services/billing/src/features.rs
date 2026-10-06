//! The g1t plan: one monthly price per workspace, never per person, that
//! includes $10 of usage. Everything that costs g1t money is metered from
//! the first unit at cost plus the margin and drawn from that $10 first;
//! past it, it is charged, up to the workspace's spend limit. There are no
//! per-feature quotas: no count of apps, build minutes, requests or
//! domains ever stops a workspace on the plan. Only its spend limit does
//! (and g1t's protections against abuse). Projects, previews and
//! repositories cost g1t next to nothing and are not metered. None of it is
//! free, whatever `FREE_WHILE_BUILDING` says.
//!
//! Deployments were once a plan of their own. They come with the g1t plan
//! now: `has_feature(deployments)` answers whether the workspace has the
//! plan, and a Deployments subscription from before keeps working until
//! its period ends. Billing sets each one to end then, once
//! (`retire_deployments_plans`), so no one pays for both.

use g1t_contracts::billing::deployment_costs as costs;
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

/// `units` at `each` micros a unit, as the pricing page writes it: a
/// build second's price times 60 is the build minute both quote.
pub(crate) fn per_units(each: f64, units: f64) -> String {
    dollars((each * units).round() as i64)
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
    /// What the g1t plan costs and includes, as it is sold now, at the
    /// price book's prices (the same figures as the pricing page's table).
    pub(crate) async fn plan(&self, _feature: Feature) -> Result<Plan> {
        let mut book = std::collections::BTreeMap::new();
        for meter in ["build_second", "app_requests", "app_cpu", "custom_domain_month", "private_storage", "git_operations"] {
            if let Some((_, price)) = self.price(meter).await? {
                book.insert(meter, price);
            }
        }
        Ok(self.plan_at(&book))
    }

    /// The plan at the given prices per unit (micros, after the markup);
    /// the published costs plus the margin for any not given.
    pub(crate) fn plan_at(&self, book: &std::collections::BTreeMap<&str, f64>) -> Plan {
        let p = &self.plans;
        let price_of = |meter: &str, cost: i64, units: f64| {
            per_units(book.get(meter).copied().unwrap_or_else(|| Price::price_for(cost as f64, self.margin_percent)), units)
        };
        Plan {
            feature: Feature::Plan,
            title: Feature::Plan.title().to_owned(),
            monthly_cents: p.plan_monthly_cents,
            includes: vec![
                format!(
                    "{} of usage each month at cost plus {}%, used first",
                    dollars(p.plan_included_micros),
                    self.margin_percent
                ),
                "Everyone in the workspace at one price, never per person".to_owned(),
                "Unlimited projects, previews and repositories".to_owned(),
                "Agents, checks, workflows, the merge queue, deployments and semantic search".to_owned(),
                format!(
                    "Usage past {} is charged at cost plus {}%, up to your spend limit",
                    dollars(p.plan_included_micros),
                    self.margin_percent
                ),
            ],
            overage: format!(
                "Everything is metered from the first unit at what it costs g1t plus {}%: sandbox time and deploy builds by the second ({} a build minute), models at what the provider charged, {} per million app requests, {} per million CPU milliseconds, {} a month per custom domain, private storage past the free {} at {} per GB-month, and git operations past the free {} a month at {} per 1,000. Unused included usage does not roll over.",
                self.margin_percent,
                price_of("build_second", costs::MICROS_PER_BUILD_SECOND, 60.0),
                price_of("app_requests", costs::MICROS_PER_MILLION_REQUESTS, 1.0),
                price_of("app_cpu", costs::MICROS_PER_MILLION_CPU_MS, 1.0),
                price_of("custom_domain_month", costs::MICROS_PER_DOMAIN_MONTH, 1.0),
                bytes(p.free_storage_bytes),
                price_of("private_storage", crate::storage::STORAGE_MICROS_PER_GB_MONTH, 1.0),
                thousands(p.git_included),
                price_of("git_operations", crate::storage::GIT_MICROS_PER_THOUSAND, 1.0),
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
            plan: self.plan(Feature::Plan).await?,
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
        let plan = self.plan(feature).await?;
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
        // A build: every second is metered, at the price book's build
        // second, which the keeper keeps at what Cloudflare bills, rather
        // than at what the caller worked out. The month's build time is
        // tallied for the Billing page.
        let cost_micros = match a.build_seconds.filter(|s| *s > 0 && a.feature == Feature::Deployments) {
            Some(seconds) => {
                self.tally("build_seconds", &workspace, &month, seconds.into()).await?;
                let measured = self.price("build_second").await?.map(|(cost, _)| (f64::from(seconds) * cost).ceil() as i64);
                measured.unwrap_or(a.cost_micros)
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
        self.count_spend(&workspace, cost_micros, charge - drawn.total(), &drawn).await;
        Ok(Outcome::Ok(true))
    }
}

/// `50,000`: a count as the plan reads it.
pub(crate) fn thousands(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_plan_text_quotes_a_build_minute_as_the_table_does() {
        // The price book's build second (16.44 millionths at cost, plus
        // 20%) is 19.73 millionths: a minute is 1,184 millionths, $0.0012,
        // as the pricing page's table says. The old fixed cost (15) gave
        // $0.0011.
        let each = Price::price_for(16.439_893_610_418_67, 20);
        assert_eq!(per_units(each, 60.0), "$0.0012");
        assert_eq!(per_units(Price::price_for(15.0, 20), 60.0), "$0.0011");
        assert_eq!(per_units(Price::price_for(150_000.0, 20), 1.0), "$0.18");
    }

    #[test]
    fn every_build_second_is_metered_at_cost_plus_the_margin() {
        // A 5-minute build at 15 millionths a second costs g1t 4,500, and
        // is charged at cost plus 20%, from the first second: there are no
        // included build minutes, only the plan's included usage.
        let cost = 300 * costs::MICROS_PER_BUILD_SECOND;
        assert_eq!(cost, 4_500);
        assert_eq!(crate::credits::with_margin(cost, 20), 5_400);
    }

    #[test]
    fn counts_read_with_thousands_separators() {
        assert_eq!(thousands(0), "0");
        assert_eq!(thousands(999), "999");
        assert_eq!(thousands(50_000), "50,000");
        assert_eq!(thousands(1_234_567), "1,234,567");
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
