//! The card processor, behind the calls billing needs: start a payment
//! page, save and verify a card, ask whether a payment was made, and start,
//! read or end the monthly plan. Stripe speaks form-encoded requests and
//! JSON answers.
//!
//! Every Stripe object billing needs beyond customers and their payments
//! (the plan's product, the billing page's settings) is made the first time
//! it is needed, and found again by its `metadata[g1t]` after that.
//!
//! Every request names the API version it is written for
//! (`STRIPE_VERSION`). Without it Stripe answers at the account's default,
//! which for an account made today is a newer version than this code reads:
//! invoices no longer carry `subscription`, charges no longer carry
//! `invoice`, and parameters this code sends can be refused. A failure is
//! never shown raw: `friendly` turns it into a sentence for the page.

use serde::Deserialize;
use worker::{Error, Fetch, Headers, Method, Request, RequestInit, Result};

const API: &str = "https://api.stripe.com/v1";

/// The Stripe API version billing is written against. Changing it is a
/// code change: read Stripe's upgrade notes for every field billing reads.
pub(crate) const STRIPE_VERSION: &str = "2025-02-24.acacia";

/// What a Stripe failure says, for the person on the page: Stripe's own
/// message when it gave one (never the request or any key), else that it
/// could not be reached.
pub(crate) fn friendly(error: &Error) -> String {
    let text = error.to_string();
    let message = text
        .split_once(": ")
        .and_then(|(_, body)| serde_json::from_str::<serde_json::Value>(body).ok())
        .and_then(|body| body["error"]["message"].as_str().map(str::to_owned));
    match message {
        Some(message) => format!("Stripe refused it: {}", message.trim_end_matches('.').to_owned() + "."),
        None if text.contains("the card processor answered") => "Stripe refused it. Try again in a minute; if it keeps happening, write to support@g1t.sh.".to_owned(),
        None => "Stripe could not be reached. Try again in a minute.".to_owned(),
    }
}

/// Whether Stripe declined a card (as opposed to refusing the request).
pub(crate) fn is_card_error(error: &Error) -> bool {
    let text = error.to_string();
    text.contains("\"card_error\"") || text.contains("authentication_required")
}

pub struct Stripe {
    key: String,
}

/// A payment page, and the payment made through it.
#[derive(Deserialize)]
pub struct Session {
    pub id: String,
    /// Where to send the person. Absent once the page has been used.
    pub url: Option<String>,
    /// `paid` once the money has been taken.
    pub payment_status: String,
    /// What was paid, in cents.
    pub amount_total: Option<u32>,
    pub customer: Option<String>,
    /// For a plan's page: the subscription it started.
    #[serde(default)]
    pub subscription: Option<String>,
    /// For a card check's page: the setup that saved and verified the card.
    #[serde(default)]
    pub setup_intent: Option<String>,
}

/// A card saved and verified: what a card check found.
#[derive(Debug, Deserialize)]
pub struct CheckedCard {
    pub payment_method: String,
    pub fingerprint: Option<String>,
    pub brand: Option<String>,
    pub last4: Option<String>,
    /// `credit`, `debit`, `prepaid` or `unknown`.
    pub funding: Option<String>,
    pub country: Option<String>,
}

/// g1t's settings for Stripe's hosted billing page.
#[derive(Debug, Deserialize)]
pub struct PortalConfiguration {
    pub id: String,
    #[serde(default)]
    pub login_page: Option<LoginPage>,
    #[serde(default)]
    pub metadata: Option<std::collections::HashMap<String, String>>,
}

#[derive(Debug, Deserialize)]
pub struct LoginPage {
    pub url: Option<String>,
}

/// A monthly plan.
#[derive(Deserialize)]
pub struct StripeSubscription {
    pub id: String,
    /// `active`, `trialing`, `past_due`, `unpaid`, `canceled`, `incomplete`…
    pub status: String,
    #[serde(default)]
    pub cancel_at_period_end: bool,
    /// Unix seconds. Older API versions carry it here…
    #[serde(default)]
    pub current_period_end: Option<i64>,
    /// …newer ones on each item.
    #[serde(default)]
    pub items: Option<Items>,
}

#[derive(Deserialize)]
pub struct Items {
    pub data: Vec<Item>,
}

#[derive(Deserialize)]
pub struct Item {
    #[serde(default)]
    pub current_period_end: Option<i64>,
}

impl StripeSubscription {
    /// When the period paid for ends, in Unix seconds.
    pub fn period_end(&self) -> Option<i64> {
        self.current_period_end.or_else(|| {
            self.items
                .as_ref()
                .and_then(|items| items.data.iter().filter_map(|item| item.current_period_end).max())
        })
    }
}

/// Percent-encodes a form value.
fn encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

/// `name=value` pairs as a form body.
pub(crate) fn form(fields: &[(&str, String)]) -> String {
    fields
        .iter()
        .map(|(name, value)| format!("{}={}", encode(name), encode(value)))
        .collect::<Vec<_>>()
        .join("&")
}

/// The idempotency key for starting a plan on a saved card: the same
/// workspace, plan and card within the same ten minutes is one subscription,
/// however many times it is asked for (a double click, two tabs), so a
/// workspace is never billed twice for one plan. A different card is a new
/// attempt, as Stripe refuses a key reused with other fields.
pub(crate) fn plan_key(workspace: &str, feature: &str, payment_method: &str, now_ms: u64) -> String {
    format!("plan/{workspace}/{feature}/{payment_method}/{}", now_ms / 600_000)
}

impl Stripe {
    pub fn new(key: String) -> Self {
        Stripe { key }
    }

    /// Whether the key is for real cards, not Stripe's test mode.
    pub fn live(&self) -> bool {
        is_live(&self.key)
    }

    /// A GET of any Stripe resource, for the webhook handlers.
    pub(crate) async fn get<T: for<'a> Deserialize<'a>>(&self, path: &str) -> Result<T> {
        self.call(Method::Get, path, None).await
    }

    /// A DELETE of any Stripe resource.
    pub(crate) async fn delete<T: for<'a> Deserialize<'a>>(&self, path: &str) -> Result<T> {
        self.call(Method::Delete, path, None).await
    }

    /// A form POST to any Stripe resource.
    pub(crate) async fn post<T: for<'a> Deserialize<'a>>(&self, path: &str, fields: &[(&str, String)]) -> Result<T> {
        self.call(Method::Post, path, Some(form(fields))).await
    }

    /// A form POST that Stripe does at most once for `key`, however often
    /// it is sent.
    pub(crate) async fn post_idempotent<T: for<'a> Deserialize<'a>>(
        &self,
        path: &str,
        fields: &[(&str, String)],
        key: &str,
    ) -> Result<T> {
        self.send(Method::Post, path, Some(form(fields)), Some(key)).await
    }

    async fn call<T: for<'a> Deserialize<'a>>(
        &self,
        method: Method,
        path: &str,
        body: Option<String>,
    ) -> Result<T> {
        self.send(method, path, body, None).await
    }

    async fn send<T: for<'a> Deserialize<'a>>(
        &self,
        method: Method,
        path: &str,
        body: Option<String>,
        idempotency_key: Option<&str>,
    ) -> Result<T> {
        let headers = Headers::new();
        headers.set("authorization", &format!("Bearer {}", self.key))?;
        headers.set("stripe-version", STRIPE_VERSION)?;
        if let Some(key) = idempotency_key {
            headers.set("idempotency-key", key)?;
        }
        if body.is_some() {
            headers.set("content-type", "application/x-www-form-urlencoded")?;
        }
        let mut init = RequestInit::new();
        init.with_method(method).with_headers(headers);
        if let Some(body) = body {
            init.with_body(Some(body.into()));
        }
        let request = Request::new_with_init(&format!("{API}{path}"), &init)?;
        let mut response = Fetch::Request(request).send().await?;
        if response.status_code() != 200 {
            return Err(Error::RustError(format!(
                "the card processor answered {}: {}",
                response.status_code(),
                response.text().await.unwrap_or_default()
            )));
        }
        response.json().await
    }

    /// A customer for a workspace that has none yet.
    pub async fn create_customer(&self, workspace: &str) -> Result<String> {
        #[derive(Deserialize)]
        struct Customer {
            id: String,
        }
        let fields = [
            ("name", workspace.to_owned()),
            ("metadata[workspace]", workspace.to_owned()),
        ];
        let customer: Customer = self.call(Method::Post, "/customers", Some(form(&fields))).await?;
        Ok(customer.id)
    }

    /// A session on Stripe's hosted billing page (the customer portal) for
    /// the customer, coming back to `return_url`.
    pub async fn portal_session(&self, customer: &str, return_url: &str) -> Result<String> {
        #[derive(Deserialize)]
        struct Portal {
            url: String,
        }
        let configuration = self.portal_configuration().await?;
        let fields = [
            ("customer", customer.to_owned()),
            ("return_url", return_url.to_owned()),
            ("configuration", configuration.id),
        ];
        let portal: Portal = self.call(Method::Post, "/billing_portal/sessions", Some(form(&fields))).await?;
        Ok(portal.url)
    }

    /// g1t's billing page settings at Stripe, made the first time they are
    /// needed: cards, invoices, billing details, and a sign-in page.
    pub async fn portal_configuration(&self) -> Result<PortalConfiguration> {
        #[derive(Deserialize)]
        struct List {
            data: Vec<PortalConfiguration>,
        }
        let list: List = self
            .call(Method::Get, "/billing_portal/configurations?active=true&limit=20", None)
            .await?;
        if let Some(existing) = list
            .data
            .into_iter()
            .find(|c| c.metadata.as_ref().and_then(|m| m.get("g1t")).is_some())
        {
            return Ok(existing);
        }
        let fields = [
            ("business_profile[headline]", "g1t billing: your card, invoices and billing details".to_owned()),
            ("features[payment_method_update][enabled]", "true".to_owned()),
            ("features[invoice_history][enabled]", "true".to_owned()),
            ("features[customer_update][enabled]", "true".to_owned()),
            ("features[customer_update][allowed_updates][0]", "email".to_owned()),
            ("features[customer_update][allowed_updates][1]", "address".to_owned()),
            ("features[customer_update][allowed_updates][2]", "name".to_owned()),
            ("features[customer_update][allowed_updates][3]", "tax_id".to_owned()),
            ("login_page[enabled]", "true".to_owned()),
            ("metadata[g1t]", "billing".to_owned()),
        ];
        self.call(Method::Post, "/billing_portal/configurations", Some(form(&fields))).await
    }

    /// The customer's email at Stripe, if they gave one.
    pub async fn customer_email(&self, customer: &str) -> Result<Option<String>> {
        #[derive(Deserialize)]
        struct Customer {
            email: Option<String>,
        }
        let found: Customer = self.call(Method::Get, &format!("/customers/{}", encode(customer)), None).await?;
        Ok(found.email)
    }

    /// Starts a page on which `amount_cents` is paid in advance: by card,
    /// with 3-D Secure asked for wherever the card supports it, the card
    /// kept for later charges; or, with `bank_transfer` and a customer, by
    /// bank transfer to the account details Stripe gives, counted when the
    /// money arrives.
    pub async fn start_checkout(
        &self,
        workspace: &str,
        amount_cents: u32,
        customer: Option<&str>,
        return_url: &str,
        bank_transfer: bool,
    ) -> Result<Session> {
        let fields = prepay_fields(workspace, amount_cents, customer, return_url, bank_transfer);
        let key = page_key("prepay", workspace, &format!("{amount_cents}/{bank_transfer}"), g1t_kit::now_ms());
        self.send(Method::Post, "/checkout/sessions", Some(form(&fields)), Some(&key)).await
    }

    /// Starts a page on which a feature's monthly plan is paid for by card.
    pub async fn start_subscription(
        &self,
        workspace: &str,
        feature: &str,
        title: &str,
        monthly_cents: u32,
        customer: Option<&str>,
        return_url: &str,
    ) -> Result<Session> {
        let fields = subscription_fields(workspace, feature, title, monthly_cents, customer, return_url);
        let key = page_key("plan", workspace, &format!("{feature}/{monthly_cents}/{}", customer.unwrap_or("new")), g1t_kit::now_ms());
        self.send(Method::Post, "/checkout/sessions", Some(form(&fields)), Some(&key)).await
    }

    /// Starts a page that saves and verifies a card, with 3-D Secure asked
    /// for wherever the card supports it. Nothing is charged: the card's
    /// bank sees at most a $0 or $1 authorization that is never captured.
    pub async fn start_card_check(&self, workspace: &str, customer: &str, return_url: &str) -> Result<Session> {
        let fields = card_check_fields(workspace, customer, return_url);
        let key = page_key("card_check", workspace, customer, g1t_kit::now_ms());
        self.send(Method::Post, "/checkout/sessions", Some(form(&fields)), Some(&key)).await
    }

    /// Starts a page on which AI credit is bought: one payment by card, the
    /// card fee as its own line, the card kept for auto-reload.
    pub async fn start_credit_checkout(&self, purchase: &CreditPurchase<'_>) -> Result<Session> {
        let fields = credit_fields(purchase);
        let key = page_key(
            "ai_credit",
            purchase.workspace,
            &format!("{}/{}/{}", purchase.credit_cents, purchase.fee_cents, purchase.customer.unwrap_or("new")),
            g1t_kit::now_ms(),
        );
        self.send(Method::Post, "/checkout/sessions", Some(form(&fields)), Some(&key)).await
    }

    /// The customer's default payment method: the one its invoices are
    /// charged to, else its newest card. None when it has none.
    pub async fn default_payment_method(&self, customer: &str) -> Result<Option<SavedMethod>> {
        let found: serde_json::Value = self
            .call(
                Method::Get,
                &format!("/customers/{}?expand[]=invoice_settings.default_payment_method", encode(customer)),
                None,
            )
            .await?;
        if let Some(method) = SavedMethod::from_json(&found["invoice_settings"]["default_payment_method"]) {
            return Ok(Some(method));
        }
        let list: serde_json::Value = self
            .call(Method::Get, &format!("/payment_methods?customer={}&type=card&limit=1", encode(customer)), None)
            .await?;
        Ok(list["data"].as_array().and_then(|data| data.first()).and_then(SavedMethod::from_json))
    }

    /// The customer as Stripe keeps it, with its tax ids.
    pub async fn customer(&self, customer: &str) -> Result<serde_json::Value> {
        self.call(Method::Get, &format!("/customers/{}?expand[]=tax_ids", encode(customer)), None).await
    }

    /// The customer's invoices, newest first.
    pub async fn invoices(&self, customer: &str) -> Result<Vec<serde_json::Value>> {
        let list: serde_json::Value = self.call(Method::Get, &format!("/invoices?customer={}&limit=24", encode(customer)), None).await?;
        Ok(list["data"].as_array().cloned().unwrap_or_default())
    }

    /// Charges a saved payment method now, with nobody there: auto-reload.
    /// Done at most once for `key`, however often it is sent.
    pub async fn charge_saved(&self, charge: &SavedCharge<'_>) -> Result<serde_json::Value> {
        self.send(Method::Post, "/payment_intents", Some(form(&saved_charge_fields(charge))), Some(charge.key)).await
    }
}

/// An AI credit purchase, as its payment page needs it.
pub struct CreditPurchase<'a> {
    pub workspace: &'a str,
    pub credit_cents: u32,
    pub fee_cents: u32,
    pub customer: Option<&'a str>,
    pub return_url: &'a str,
}

/// A charge to a saved card with nobody there.
pub struct SavedCharge<'a> {
    pub workspace: &'a str,
    pub customer: &'a str,
    pub payment_method: &'a str,
    pub credit_cents: u32,
    pub fee_cents: u32,
    pub key: &'a str,
}

/// A saved way to pay, as far as it is safe to show.
#[derive(Clone, Debug, PartialEq)]
pub struct SavedMethod {
    pub id: String,
    pub kind: String,
    pub brand: Option<String>,
    pub last4: Option<String>,
    pub exp_month: Option<u32>,
    pub exp_year: Option<u32>,
}

impl SavedMethod {
    fn from_json(method: &serde_json::Value) -> Option<SavedMethod> {
        let id = method["id"].as_str()?.to_owned();
        let kind = method["type"].as_str().unwrap_or("card").to_owned();
        let details = &method[kind.as_str()];
        Some(SavedMethod {
            id,
            brand: details["brand"].as_str().or_else(|| details["bank_name"].as_str()).map(str::to_owned),
            last4: details["last4"].as_str().map(str::to_owned),
            exp_month: details["exp_month"].as_u64().map(|m| m as u32),
            exp_year: details["exp_year"].as_u64().map(|y| y as u32),
            kind,
        })
    }
}

/// The idempotency key for a payment page: the same workspace, purpose and
/// details within ten minutes is one page, however often it is asked for (a
/// double click, two tabs).
pub(crate) fn page_key(purpose: &str, workspace: &str, details: &str, now_ms: u64) -> String {
    format!("page/{purpose}/{workspace}/{details}/{}", now_ms / 600_000)
}

/// Where Stripe sends the person back, with the page's id under `name`.
fn back_to(return_url: &str, name: &str) -> String {
    let separator = if return_url.contains('?') { '&' } else { '?' };
    // Stripe fills in the page's id.
    format!("{return_url}{separator}{name}={{CHECKOUT_SESSION_ID}}")
}

/// A prepayment page's fields.
pub(crate) fn prepay_fields(
    workspace: &str,
    amount_cents: u32,
    customer: Option<&str>,
    return_url: &str,
    bank_transfer: bool,
) -> Vec<(&'static str, String)> {
    let mut fields = vec![("mode", "payment".to_owned())];
    if bank_transfer {
        fields.extend([
            ("payment_method_types[0]", "customer_balance".to_owned()),
            ("payment_method_options[customer_balance][funding_type]", "bank_transfer".to_owned()),
            ("payment_method_options[customer_balance][bank_transfer][type]", "us_bank_transfer".to_owned()),
        ]);
    } else {
        fields.extend([
            ("payment_method_types[0]", "card".to_owned()),
            ("payment_method_options[card][request_three_d_secure]", "any".to_owned()),
            ("payment_intent_data[setup_future_usage]", "off_session".to_owned()),
        ]);
    }
    fields.extend([
        ("success_url", back_to(return_url, "session")),
        ("cancel_url", return_url.to_owned()),
        ("client_reference_id", workspace.to_owned()),
        ("metadata[workspace]", workspace.to_owned()),
        ("line_items[0][quantity]", "1".to_owned()),
        ("line_items[0][price_data][currency]", "usd".to_owned()),
        ("line_items[0][price_data][unit_amount]", amount_cents.to_string()),
        ("line_items[0][price_data][product_data][name]", format!("g1t usage paid in advance for {workspace}")),
    ]);
    match customer {
        Some(customer) => fields.push(("customer", customer.to_owned())),
        None => fields.push(("customer_creation", "always".to_owned())),
    }
    fields
}

/// A plan's page's fields. In subscription mode Stripe makes the customer
/// itself when there is none; `customer_creation` is for payment mode only.
pub(crate) fn subscription_fields(
    workspace: &str,
    feature: &str,
    title: &str,
    monthly_cents: u32,
    customer: Option<&str>,
    return_url: &str,
) -> Vec<(&'static str, String)> {
    let mut fields = vec![
        ("mode", "subscription".to_owned()),
        ("payment_method_types[0]", "card".to_owned()),
        ("success_url", back_to(return_url, "session")),
        ("cancel_url", return_url.to_owned()),
        ("client_reference_id", workspace.to_owned()),
        ("metadata[workspace]", workspace.to_owned()),
        ("metadata[feature]", feature.to_owned()),
        ("subscription_data[metadata][workspace]", workspace.to_owned()),
        ("subscription_data[metadata][feature]", feature.to_owned()),
        ("line_items[0][quantity]", "1".to_owned()),
        ("line_items[0][price_data][currency]", "usd".to_owned()),
        ("line_items[0][price_data][unit_amount]", monthly_cents.to_string()),
        ("line_items[0][price_data][recurring][interval]", "month".to_owned()),
        ("line_items[0][price_data][product_data][name]", format!("g1t {title} for {workspace}")),
    ];
    if let Some(customer) = customer {
        fields.push(("customer", customer.to_owned()));
    }
    fields
}

/// A card check's page's fields: setup mode, nothing charged. Setup mode
/// takes no line items and no amount.
pub(crate) fn card_check_fields(workspace: &str, customer: &str, return_url: &str) -> Vec<(&'static str, String)> {
    vec![
        ("mode", "setup".to_owned()),
        ("customer", customer.to_owned()),
        ("payment_method_types[0]", "card".to_owned()),
        ("payment_method_options[card][request_three_d_secure]", "any".to_owned()),
        ("success_url", back_to(return_url, "card_check")),
        ("cancel_url", return_url.to_owned()),
        ("client_reference_id", workspace.to_owned()),
        ("metadata[workspace]", workspace.to_owned()),
        ("metadata[purpose]", "card_check".to_owned()),
        ("setup_intent_data[metadata][workspace]", workspace.to_owned()),
        ("setup_intent_data[description]", format!("Card check for g1t workspace {workspace}; never charged")),
    ]
}

/// An AI credit page's fields: the credit, and the card fee as its own
/// line when there is one.
pub(crate) fn credit_fields(p: &CreditPurchase<'_>) -> Vec<(&'static str, String)> {
    let mut fields = vec![
        ("mode", "payment".to_owned()),
        ("payment_method_types[0]", "card".to_owned()),
        ("payment_method_options[card][request_three_d_secure]", "any".to_owned()),
        // Kept for auto-reload, which charges it with nobody there.
        ("payment_intent_data[setup_future_usage]", "off_session".to_owned()),
        ("payment_intent_data[description]", format!("g1t AI credit for {}", p.workspace)),
        ("payment_intent_data[metadata][workspace]", p.workspace.to_owned()),
        ("payment_intent_data[metadata][purpose]", "ai_credit".to_owned()),
        ("success_url", back_to(p.return_url, "ai_credit")),
        ("cancel_url", p.return_url.to_owned()),
        ("client_reference_id", p.workspace.to_owned()),
        ("metadata[workspace]", p.workspace.to_owned()),
        ("metadata[purpose]", "ai_credit".to_owned()),
        ("line_items[0][quantity]", "1".to_owned()),
        ("line_items[0][price_data][currency]", "usd".to_owned()),
        ("line_items[0][price_data][unit_amount]", p.credit_cents.to_string()),
        ("line_items[0][price_data][product_data][name]", "g1t AI credit".to_owned()),
        (
            "line_items[0][price_data][product_data][description]",
            format!("Prepaid credit for Agent and AI Gateway usage in {}; expires a year after purchase", p.workspace),
        ),
    ];
    if p.fee_cents > 0 {
        fields.extend([
            ("line_items[1][quantity]", "1".to_owned()),
            ("line_items[1][price_data][currency]", "usd".to_owned()),
            ("line_items[1][price_data][unit_amount]", p.fee_cents.to_string()),
            ("line_items[1][price_data][product_data][name]", "Card processing fee".to_owned()),
        ]);
    }
    match p.customer {
        Some(customer) => fields.push(("customer", customer.to_owned())),
        None => fields.push(("customer_creation", "always".to_owned())),
    }
    fields
}

/// An off-session charge's fields.
pub(crate) fn saved_charge_fields(c: &SavedCharge<'_>) -> Vec<(&'static str, String)> {
    vec![
        ("amount", (c.credit_cents + c.fee_cents).to_string()),
        ("currency", "usd".to_owned()),
        ("customer", c.customer.to_owned()),
        ("payment_method", c.payment_method.to_owned()),
        ("off_session", "true".to_owned()),
        ("confirm", "true".to_owned()),
        ("description", format!("g1t AI credit auto-reload for {}", c.workspace)),
        ("metadata[workspace]", c.workspace.to_owned()),
        ("metadata[purpose]", "ai_reload".to_owned()),
        ("metadata[credit_cents]", c.credit_cents.to_string()),
        ("metadata[fee_cents]", c.fee_cents.to_string()),
    ]
}

impl Stripe {
    /// What a card check's setup found, once it succeeded.
    pub async fn checked_card(&self, setup_intent: &str) -> Result<Option<CheckedCard>> {
        #[derive(Deserialize)]
        struct Setup {
            status: String,
            payment_method: Option<String>,
        }
        #[derive(Deserialize)]
        struct Card {
            fingerprint: Option<String>,
            brand: Option<String>,
            last4: Option<String>,
            funding: Option<String>,
            country: Option<String>,
        }
        #[derive(Deserialize)]
        struct PaymentMethod {
            card: Option<Card>,
        }
        let setup: Setup = self.call(Method::Get, &format!("/setup_intents/{}", encode(setup_intent)), None).await?;
        let (true, Some(method)) = (setup.status == "succeeded", setup.payment_method) else { return Ok(None) };
        let found: PaymentMethod = self.call(Method::Get, &format!("/payment_methods/{}", encode(&method)), None).await?;
        let card = found.card;
        Ok(Some(CheckedCard {
            payment_method: method,
            fingerprint: card.as_ref().and_then(|c| c.fingerprint.clone()),
            brand: card.as_ref().and_then(|c| c.brand.clone()),
            last4: card.as_ref().and_then(|c| c.last4.clone()),
            funding: card.as_ref().and_then(|c| c.funding.clone()),
            country: card.as_ref().and_then(|c| c.country.clone()),
        }))
    }

    /// Makes `payment_method` the card the customer's invoices are charged to.
    pub async fn set_default_card(&self, customer: &str, payment_method: &str) -> Result<()> {
        let _: serde_json::Value = self
            .call(
                Method::Post,
                &format!("/customers/{}", encode(customer)),
                Some(form(&[("invoice_settings[default_payment_method]", payment_method.to_owned())])),
            )
            .await?;
        Ok(())
    }

    /// A feature's product at Stripe (the plan's is tagged `plan`), made
    /// the first time it is needed.
    async fn plan_product(&self, feature: &str, title: &str) -> Result<String> {
        #[derive(Deserialize)]
        struct Product {
            id: String,
            #[serde(default)]
            metadata: Option<std::collections::HashMap<String, String>>,
        }
        #[derive(Deserialize)]
        struct List {
            data: Vec<Product>,
        }
        let list: List = self.call(Method::Get, "/products?active=true&limit=100", None).await?;
        let ours = |p: &Product| p.metadata.as_ref().and_then(|m| m.get("g1t")).map(String::as_str) == Some(feature);
        if let Some(found) = list.data.into_iter().find(ours) {
            return Ok(found.id);
        }
        let created: Product = self
            .call(
                Method::Post,
                "/products",
                Some(form(&[("name", format!("{title} plan")), ("metadata[g1t]", feature.to_owned())])),
            )
            .await?;
        Ok(created.id)
    }

    /// Starts the monthly plan on a saved card, at once. Fails rather than
    /// leaving it half-started when the card's bank wants the person again;
    /// the caller then sends them to Stripe's page.
    pub async fn subscribe_with_card(
        &self,
        workspace: &str,
        feature: &str,
        title: &str,
        monthly_cents: u32,
        customer: &str,
        payment_method: &str,
    ) -> Result<StripeSubscription> {
        let product = self.plan_product(feature, title).await?;
        let fields = [
            ("customer", customer.to_owned()),
            ("default_payment_method", payment_method.to_owned()),
            ("payment_behavior", "error_if_incomplete".to_owned()),
            ("items[0][price_data][currency]", "usd".to_owned()),
            ("items[0][price_data][product]", product),
            ("items[0][price_data][unit_amount]", monthly_cents.to_string()),
            ("items[0][price_data][recurring][interval]", "month".to_owned()),
            ("metadata[workspace]", workspace.to_owned()),
            ("metadata[feature]", feature.to_owned()),
            ("description", format!("{title} plan for {workspace}")),
        ];
        let key = plan_key(workspace, feature, payment_method, g1t_kit::now_ms());
        self.send(Method::Post, "/subscriptions", Some(form(&fields)), Some(&key)).await
    }

    /// Ends a subscription now: one that never started properly.
    pub async fn cancel_now(&self, id: &str) -> Result<StripeSubscription> {
        self.call(Method::Delete, &format!("/subscriptions/{}", encode(id)), None).await
    }

    pub async fn subscription(&self, id: &str) -> Result<StripeSubscription> {
        self.call(Method::Get, &format!("/subscriptions/{}", encode(id)), None)
            .await
    }

    /// Ends a plan when its period does (`cancel` true), or takes that back.
    pub async fn cancel_at_period_end(&self, id: &str, cancel: bool) -> Result<StripeSubscription> {
        self.call(
            Method::Post,
            &format!("/subscriptions/{}", encode(id)),
            Some(form(&[("cancel_at_period_end", cancel.to_string())])),
        )
        .await
    }

    pub async fn session(&self, id: &str) -> Result<Session> {
        self.call(
            Method::Get,
            &format!("/checkout/sessions/{}", encode(id)),
            None,
        )
        .await
    }
}

/// Whether the processor said an id it was given does not exist, as when
/// g1t moves to another Stripe account and ids saved from the old one stay
/// behind.
pub(crate) fn is_missing(error: &Error) -> bool {
    error.to_string().contains("resource_missing")
}

pub(crate) fn is_live(key: &str) -> bool {
    key.starts_with("sk_live_") || key.starts_with("rk_live_")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asking_twice_for_a_plan_starts_one() {
        let at = 1_791_000_000_000;
        assert_eq!(plan_key("acme", "plan", "pm_1", at), plan_key("acme", "plan", "pm_1", at + 1_000));
        assert_ne!(plan_key("acme", "plan", "pm_1", at), plan_key("acme", "plan", "pm_2", at));
        assert_ne!(plan_key("acme", "plan", "pm_1", at), plan_key("other", "plan", "pm_1", at));
    }

    #[test]
    fn form_values_are_percent_encoded() {
        assert_eq!(
            form(&[
                (
                    "success_url",
                    "https://g1t.sh/a/-/billing?session={ID}".to_owned()
                ),
                ("line_items[0][quantity]", "1".to_owned()),
            ]),
            "success_url=https%3A%2F%2Fg1t.sh%2Fa%2F-%2Fbilling%3Fsession%3D%7BID%7D&line_items%5B0%5D%5Bquantity%5D=1"
        );
    }

    #[test]
    fn test_keys_are_not_live() {
        assert!(is_live("sk_live_abc"));
        assert!(!is_live("sk_test_abc"));
        assert!(!is_live(""));
    }

    fn has(fields: &[(&str, String)], name: &str) -> Option<String> {
        fields.iter().find(|(n, _)| *n == name).map(|(_, v)| v.clone())
    }

    #[test]
    fn every_request_names_the_api_version_it_is_written_for() {
        // Without it a new Stripe account answers at its newest version, and
        // invoices, charges and pages read differently from what billing
        // expects.
        assert!(STRIPE_VERSION.starts_with("2025-02-24"));
        let source = include_str!("stripe.rs");
        assert!(source.contains(concat!("headers.set(\"stripe-", "version\", STRIPE_VERSION)")));
    }

    #[test]
    fn the_plans_page_is_a_subscription_without_payment_mode_fields() {
        let url = "https://g1t.sh/acme/-/billing?plan=plan";
        for customer in [None, Some("cus_1")] {
            let fields = subscription_fields("acme", "plan", "g1t", 2_000, customer, url);
            assert_eq!(has(&fields, "mode").as_deref(), Some("subscription"));
            // customer_creation is for payment mode; Stripe refuses it here.
            assert!(has(&fields, "customer_creation").is_none());
            assert!(has(&fields, "payment_intent_data[setup_future_usage]").is_none());
            assert_eq!(has(&fields, "customer").as_deref(), customer);
            assert_eq!(has(&fields, "success_url").unwrap(), "https://g1t.sh/acme/-/billing?plan=plan&session={CHECKOUT_SESSION_ID}");
            assert_eq!(has(&fields, "line_items[0][price_data][recurring][interval]").as_deref(), Some("month"));
            assert!(has(&fields, "automatic_tax[enabled]").is_none());
        }
    }

    #[test]
    fn a_card_check_is_a_setup_page_with_no_amount() {
        let fields = card_check_fields("acme", "cus_1", "https://g1t.sh/acme/-/billing");
        assert_eq!(has(&fields, "mode").as_deref(), Some("setup"));
        assert!(fields.iter().all(|(n, _)| !n.starts_with("line_items")));
        assert_eq!(has(&fields, "success_url").unwrap(), "https://g1t.sh/acme/-/billing?card_check={CHECKOUT_SESSION_ID}");
        assert_eq!(has(&fields, "customer").as_deref(), Some("cus_1"));
    }

    #[test]
    fn an_ai_credit_page_has_the_card_fee_as_its_own_line() {
        let purchase = CreditPurchase { workspace: "acme", credit_cents: 2_500, fee_cents: 106, customer: None, return_url: "https://g1t.sh/acme/-/billing" };
        let fields = credit_fields(&purchase);
        assert_eq!(has(&fields, "mode").as_deref(), Some("payment"));
        assert_eq!(has(&fields, "line_items[0][price_data][unit_amount]").as_deref(), Some("2500"));
        assert_eq!(has(&fields, "line_items[1][price_data][unit_amount]").as_deref(), Some("106"));
        assert_eq!(has(&fields, "line_items[1][price_data][product_data][name]").as_deref(), Some("Card processing fee"));
        assert_eq!(has(&fields, "customer_creation").as_deref(), Some("always"));
        assert_eq!(has(&fields, "payment_intent_data[setup_future_usage]").as_deref(), Some("off_session"));
        assert_eq!(has(&fields, "success_url").unwrap(), "https://g1t.sh/acme/-/billing?ai_credit={CHECKOUT_SESSION_ID}");
        // No fee: no second line.
        let fields = credit_fields(&CreditPurchase { fee_cents: 0, customer: Some("cus_1"), ..purchase });
        assert!(has(&fields, "line_items[1][quantity]").is_none());
        assert!(has(&fields, "customer_creation").is_none());
    }

    #[test]
    fn an_auto_reload_is_one_off_session_charge() {
        let charge = SavedCharge { workspace: "acme", customer: "cus_1", payment_method: "pm_1", credit_cents: 1_600, fee_cents: 78, key: "reload/acme/2026-10/1" };
        let fields = saved_charge_fields(&charge);
        assert_eq!(has(&fields, "amount").as_deref(), Some("1678"));
        assert_eq!(has(&fields, "off_session").as_deref(), Some("true"));
        assert_eq!(has(&fields, "confirm").as_deref(), Some("true"));
    }

    #[test]
    fn a_page_asked_for_twice_is_one_page() {
        let at = 1_791_000_000_000;
        assert_eq!(page_key("plan", "acme", "plan/2000", at), page_key("plan", "acme", "plan/2000", at + 60_000));
        assert_ne!(page_key("plan", "acme", "plan/2000", at), page_key("ai_credit", "acme", "plan/2000", at));
    }

    #[test]
    fn a_stripe_failure_reads_as_a_sentence_never_raw() {
        let refused = Error::RustError(
            r#"the card processor answered 400: {"error":{"message":"You may only specify one of these parameters: customer, customer_creation.","type":"invalid_request_error"}}"#.into(),
        );
        assert_eq!(friendly(&refused), "Stripe refused it: You may only specify one of these parameters: customer, customer_creation.");
        assert!(!friendly(&refused).contains("invalid_request_error"));
        let odd = Error::RustError("the card processor answered 502: <html>".into());
        assert!(friendly(&odd).starts_with("Stripe refused it. Try again"));
        let down = Error::RustError("network connection lost".into());
        assert_eq!(friendly(&down), "Stripe could not be reached. Try again in a minute.");
        let declined = Error::RustError(r#"the card processor answered 402: {"error":{"type":"card_error","code":"card_declined","message":"Your card was declined."}}"#.into());
        assert!(is_card_error(&declined) && !is_card_error(&refused));
    }
}
