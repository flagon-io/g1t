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

/// Stripe Tax's code for what g1t sells, on every product, price and
/// invoice line: software as a service, for business use. A card fee line
/// carries it too, since a fee for paying for a sale is taxed as the sale.
pub(crate) const TAX_CODE: &str = "txcd_10103001";

/// What every payment page (payment or subscription mode) asks of Stripe
/// Tax: tax worked out on top of the price shown, from a billing address
/// it always collects, with the buyer's tax ID if they have one. With a
/// customer already, what was entered is saved on it, so invoices and
/// off-session charges later find the address too. Checkout refuses
/// `automatic_tax` for a customer with no address unless it may save one
/// (`customer_update[address]`), and `tax_id_collection` unless it may save
/// the name (`customer_update[name]`).
pub(crate) fn checkout_tax_fields(customer: Option<&str>) -> Vec<(&'static str, String)> {
    let mut fields = vec![
        ("automatic_tax[enabled]", "true".to_owned()),
        ("billing_address_collection", "required".to_owned()),
        ("tax_id_collection[enabled]", "true".to_owned()),
    ];
    if customer.is_some() {
        fields.extend([("customer_update[address]", "auto".to_owned()), ("customer_update[name]", "auto".to_owned())]);
    }
    fields
}

/// Whether Stripe refused because it could not tell where the customer is
/// for tax: no address, or not enough of one.
pub(crate) fn is_tax_location_error(error: &Error) -> bool {
    let text = error.to_string();
    text.contains("customer_tax_location_invalid") || text.contains("requires_location_inputs")
}

/// Whether an address is enough for Stripe Tax to place the customer: a
/// country, and in the United States a postal code (in Canada a postal
/// code or a province).
pub(crate) fn address_places_customer(address: &serde_json::Value) -> bool {
    let text = |key: &str| address[key].as_str().map(str::trim).unwrap_or_default().to_owned();
    match text("country").to_uppercase().as_str() {
        "" => false,
        "US" => !text("postal_code").is_empty(),
        "CA" => !text("postal_code").is_empty() || !text("state").is_empty(),
        _ => true,
    }
}

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
    /// What was paid, in cents, tax included.
    pub amount_total: Option<u32>,
    /// What the lines came to before tax, in cents.
    #[serde(default)]
    pub amount_subtotal: Option<u32>,
    /// The tax Stripe added (`amount_tax`), among other totals.
    #[serde(default)]
    pub total_details: Option<TotalDetails>,
    /// For a payment page: the payment that took the money.
    #[serde(default)]
    pub payment_intent: Option<String>,
    pub customer: Option<String>,
    /// For a plan's page: the subscription it started.
    #[serde(default)]
    pub subscription: Option<String>,
    /// For a card check's page: the setup that saved and verified the card.
    #[serde(default)]
    pub setup_intent: Option<String>,
}

#[derive(Default, Deserialize)]
pub struct TotalDetails {
    #[serde(default)]
    pub amount_tax: i64,
}

impl Session {
    /// The tax Stripe added on the page, in cents.
    pub fn tax_cents(&self) -> i64 {
        self.total_details.as_ref().map_or(0, |t| t.amount_tax.max(0))
    }

    /// What the page's lines came to before tax, in cents: the total less
    /// the tax when Stripe gives no subtotal.
    pub fn before_tax_cents(&self) -> i64 {
        match self.amount_subtotal {
            Some(subtotal) => i64::from(subtotal),
            None => (i64::from(self.amount_total.unwrap_or(0)) - self.tax_cents()).max(0),
        }
    }
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
    /// The billing address entered with the card, as Stripe keeps it.
    #[serde(default)]
    pub address: Option<serde_json::Value>,
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
/// Requests that carry `automatic_tax`: payment pages, invoices and
/// subscriptions. When Stripe Tax is not active for the key's mode (a test
/// account where it was never turned on), Stripe refuses them outright, so
/// the field is left out and the payment goes through untaxed.
pub(crate) fn taxed_path(path: &str) -> bool {
    path == "/checkout/sessions" || path == "/invoices" || path == "/subscriptions"
}

/// A form body without its `automatic_tax[…]` fields.
pub(crate) fn without_automatic_tax(body: &str) -> String {
    body.split('&').filter(|pair| !pair.starts_with("automatic_tax")).collect::<Vec<_>>().join("&")
}

/// How long whether Stripe Tax is active is believed, in milliseconds.
const TAX_ACTIVE_FOR_MS: u64 = 10 * 60 * 1000;

thread_local! {
    /// Whether Stripe Tax is active for the key, and when that was read.
    static TAX_ACTIVE: std::cell::Cell<Option<(bool, u64)>> = const { std::cell::Cell::new(None) };
}

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
        let body = match body {
            Some(body) if matches!(method, Method::Post) && taxed_path(path) && body.contains("automatic_tax") && !self.tax_active().await => {
                Some(without_automatic_tax(&body))
            }
            body => body,
        };
        self.send_raw(method, path, body, idempotency_key).await
    }

    /// The request itself, as given: `send` without the Stripe Tax check.
    async fn send_raw<T: for<'a> Deserialize<'a>>(
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

    /// Whether Stripe Tax is active for this key's mode (`GET /tax/settings`,
    /// `status` `active`), read at most every ten minutes. When it cannot be
    /// read, it is taken as active: asking for tax and being refused says
    /// why, where leaving it out would undercharge without a word.
    pub async fn tax_active(&self) -> bool {
        let now = crate::now_ms();
        if let Some((active, at)) = TAX_ACTIVE.with(|cell| cell.get())
            && now.saturating_sub(at) < TAX_ACTIVE_FOR_MS
        {
            return active;
        }
        #[derive(Deserialize)]
        struct Settings {
            status: String,
        }
        let active = match self.send_raw::<Settings>(Method::Get, "/tax/settings", None, None).await {
            Ok(settings) => settings.status == "active",
            Err(error) => {
                worker::console_error!("Stripe Tax settings could not be read; asking for tax anyway: {error}");
                true
            }
        };
        TAX_ACTIVE.with(|cell| cell.set(Some((active, now))));
        active
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
        fee_cents: u32,
        customer: Option<&str>,
        return_url: &str,
        bank_transfer: bool,
    ) -> Result<Session> {
        let fields = prepay_fields(workspace, amount_cents, fee_cents, customer, return_url, bank_transfer);
        let key = page_key(
            "prepay",
            workspace,
            &format!("{amount_cents}/{fee_cents}/{bank_transfer}/{}", customer.unwrap_or("new")),
            g1t_kit::now_ms(),
        );
        self.send(Method::Post, "/checkout/sessions", Some(form(&fields)), Some(&key)).await
    }

    /// Starts a page on which a feature's monthly plan is paid for by card,
    /// with the card fee as a monthly line of its own.
    #[allow(clippy::too_many_arguments)]
    pub async fn start_subscription(
        &self,
        workspace: &str,
        feature: &str,
        title: &str,
        monthly_cents: u32,
        fee_cents: u32,
        customer: Option<&str>,
        return_url: &str,
    ) -> Result<Session> {
        let fields = subscription_fields(workspace, feature, title, monthly_cents, fee_cents, customer, return_url);
        let key = page_key(
            "plan",
            workspace,
            &format!("{feature}/{monthly_cents}/{fee_cents}/{}", customer.unwrap_or("new")),
            g1t_kit::now_ms(),
        );
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

    /// Stripe Tax's figure for an off-session charge, which no Checkout
    /// page or invoice works out: the credit and the card fee, each at
    /// g1t's tax code and excluding tax, for the customer's saved address.
    /// A customer Stripe cannot place fails with
    /// `customer_tax_location_invalid` (`is_tax_location_error`).
    pub async fn tax_calculation(&self, charge: &SavedCharge<'_>) -> Result<TaxCalculation> {
        if !self.tax_active().await {
            // No Stripe Tax for this key's mode: no tax, and nothing to record.
            return Ok(TaxCalculation { id: String::new(), tax_amount_exclusive: 0 });
        }
        let key = format!("{}/tax", charge.key);
        self.send(Method::Post, "/tax/calculations", Some(form(&tax_calculation_fields(charge))), Some(&key)).await
    }

    /// Records a calculation as a tax transaction once its payment went
    /// through, so Stripe Tax reports and files it; `reference` is the
    /// PaymentIntent. Its id, for reversing it on a refund.
    pub async fn record_tax(&self, calculation: &str, reference: &str) -> Result<String> {
        #[derive(Deserialize)]
        struct Transaction {
            id: String,
        }
        let fields = [("calculation", calculation.to_owned()), ("reference", reference.to_owned())];
        let made: Transaction = self
            .send(Method::Post, "/tax/transactions/create_from_calculation", Some(form(&fields)), Some(&format!("tax/{reference}")))
            .await?;
        Ok(made.id)
    }

    /// Reverses a tax transaction in part for a refund: `refunded_cents` of
    /// the payment, tax included, taken back across all of it.
    pub async fn reverse_tax(&self, transaction: &str, reference: &str, refunded_cents: i64) -> Result<()> {
        let _: serde_json::Value = self
            .send(
                Method::Post,
                "/tax/transactions/create_reversal",
                Some(form(&reversal_fields(transaction, reference, refunded_cents))),
                Some(&format!("tax-reversal/{reference}")),
            )
            .await?;
        Ok(())
    }

    /// Copies the billing address entered with a card onto the customer
    /// when the customer has none Stripe Tax can use, so later invoices and
    /// charges can be taxed. Never replaces an address an owner gave.
    pub async fn fill_address(&self, customer: &str, address: &serde_json::Value) -> Result<bool> {
        if !address_places_customer(address) {
            return Ok(false);
        }
        let found = self.customer(customer).await?;
        if address_places_customer(&found["address"]) {
            return Ok(false);
        }
        let _: serde_json::Value = self.post(&format!("/customers/{}", encode(customer)), &address_fields(address)).await?;
        Ok(true)
    }

    /// Whether the customer's address is enough for Stripe Tax.
    pub async fn customer_placed(&self, customer: &str) -> Result<bool> {
        let found = self.customer(customer).await?;
        Ok(address_places_customer(&found["address"]) || address_places_customer(&found["shipping"]["address"]))
    }
}

/// Stripe Tax's answer for an off-session charge.
#[derive(Debug, Deserialize)]
pub struct TaxCalculation {
    pub id: String,
    /// The tax on top, in cents.
    #[serde(default)]
    pub tax_amount_exclusive: i64,
}

/// A customer's address from an address Stripe gave.
pub(crate) fn address_fields(address: &serde_json::Value) -> Vec<(&'static str, String)> {
    let text = |key: &str| address[key].as_str().unwrap_or_default().to_owned();
    vec![
        ("address[line1]", text("line1")),
        ("address[line2]", text("line2")),
        ("address[city]", text("city")),
        ("address[state]", text("state")),
        ("address[postal_code]", text("postal_code")),
        ("address[country]", text("country")),
    ]
}

/// A tax calculation's fields: the credit and the card fee as lines at
/// g1t's tax code, prices excluding tax.
pub(crate) fn tax_calculation_fields(c: &SavedCharge<'_>) -> Vec<(&'static str, String)> {
    let mut fields = vec![
        ("currency", "usd".to_owned()),
        ("customer", c.customer.to_owned()),
        ("line_items[0][amount]", c.credit_cents.to_string()),
        ("line_items[0][reference]", "ai_credit".to_owned()),
        ("line_items[0][tax_code]", TAX_CODE.to_owned()),
        ("line_items[0][tax_behavior]", "exclusive".to_owned()),
    ];
    if c.fee_cents > 0 {
        fields.extend([
            ("line_items[1][amount]", c.fee_cents.to_string()),
            ("line_items[1][reference]", "card_fee".to_owned()),
            ("line_items[1][tax_code]", TAX_CODE.to_owned()),
            ("line_items[1][tax_behavior]", "exclusive".to_owned()),
        ]);
    }
    fields
}

/// A refund's tax reversal: a part of the payment, as a negative amount.
pub(crate) fn reversal_fields(transaction: &str, reference: &str, refunded_cents: i64) -> Vec<(&'static str, String)> {
    vec![
        ("mode", "partial".to_owned()),
        ("original_transaction", transaction.to_owned()),
        ("reference", reference.to_owned()),
        ("flat_amount", (-refunded_cents.abs()).to_string()),
    ]
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
    /// Tax on top, from `tax_calculation`.
    pub tax_cents: u32,
    /// The calculation the tax came from, kept on the payment.
    pub tax_calculation: Option<&'a str>,
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

/// The name of the card fee's line everywhere it appears: Checkout pages,
/// subscriptions and invoices. Revenue figures find it by this name.
pub(crate) const CARD_FEE_LINE: &str = "Card processing fee";

/// The form keys of one line on a payment page, for the first two lines
/// (what is bought, and the card fee).
const LINE_KEYS: [[&str; 8]; 2] = [
    [
        "line_items[0][quantity]",
        "line_items[0][price_data][currency]",
        "line_items[0][price_data][unit_amount]",
        "line_items[0][price_data][tax_behavior]",
        "line_items[0][price_data][product_data][name]",
        "line_items[0][price_data][product_data][tax_code]",
        "line_items[0][price_data][product_data][description]",
        "line_items[0][price_data][recurring][interval]",
    ],
    [
        "line_items[1][quantity]",
        "line_items[1][price_data][currency]",
        "line_items[1][price_data][unit_amount]",
        "line_items[1][price_data][tax_behavior]",
        "line_items[1][price_data][product_data][name]",
        "line_items[1][price_data][product_data][tax_code]",
        "line_items[1][price_data][product_data][description]",
        "line_items[1][price_data][recurring][interval]",
    ],
];

/// One line on a payment page at g1t's tax code, its price excluding tax;
/// monthly when `monthly`.
fn page_line(index: usize, cents: u32, name: String, description: Option<String>, monthly: bool) -> Vec<(&'static str, String)> {
    let keys = LINE_KEYS[index.min(1)];
    let mut fields = vec![
        (keys[0], "1".to_owned()),
        (keys[1], "usd".to_owned()),
        (keys[2], cents.to_string()),
        (keys[3], "exclusive".to_owned()),
        (keys[4], name),
        (keys[5], TAX_CODE.to_owned()),
    ];
    if let Some(description) = description {
        fields.push((keys[6], description));
    }
    if monthly {
        fields.push((keys[7], "month".to_owned()));
    }
    fields
}

/// The card fee's line on a payment page, when there is a fee.
fn fee_line(fee_cents: u32, monthly: bool) -> Vec<(&'static str, String)> {
    if fee_cents == 0 {
        return vec![];
    }
    page_line(1, fee_cents, CARD_FEE_LINE.to_owned(), Some("Stripe's fee for taking the payment by card, passed on at cost".to_owned()), monthly)
}

/// A prepayment page's fields. By card, the card fee is its own line; by
/// bank transfer there is none.
pub(crate) fn prepay_fields(
    workspace: &str,
    amount_cents: u32,
    fee_cents: u32,
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
    ]);
    fields.extend(page_line(0, amount_cents, format!("g1t usage paid in advance for {workspace}"), None, false));
    if !bank_transfer {
        fields.extend(fee_line(fee_cents, false));
    }
    fields.extend(checkout_tax_fields(customer));
    match customer {
        Some(customer) => fields.push(("customer", customer.to_owned())),
        None => fields.push(("customer_creation", "always".to_owned())),
    }
    fields
}

/// A plan's page's fields: the plan, and the card fee as a monthly line of
/// its own. In subscription mode Stripe makes the customer itself when
/// there is none; `customer_creation` is for payment mode only. The
/// subscription it starts keeps `automatic_tax`, so every renewal is taxed.
pub(crate) fn subscription_fields(
    workspace: &str,
    feature: &str,
    title: &str,
    monthly_cents: u32,
    fee_cents: u32,
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
    ];
    fields.extend(page_line(0, monthly_cents, format!("g1t {title} for {workspace}"), None, true));
    fields.extend(fee_line(fee_cents, true));
    fields.extend(checkout_tax_fields(customer));
    if let Some(customer) = customer {
        fields.push(("customer", customer.to_owned()));
    }
    fields
}

/// A card check's page's fields: setup mode, nothing charged, so nothing
/// to tax. Setup mode takes no line items and no amount. The billing
/// address is asked for all the same, and copied onto the customer once
/// the card is checked (`fill_address`), so the plan and invoices that
/// follow can be taxed.
pub(crate) fn card_check_fields(workspace: &str, customer: &str, return_url: &str) -> Vec<(&'static str, String)> {
    vec![
        ("mode", "setup".to_owned()),
        ("customer", customer.to_owned()),
        ("payment_method_types[0]", "card".to_owned()),
        ("payment_method_options[card][request_three_d_secure]", "any".to_owned()),
        ("billing_address_collection", "required".to_owned()),
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
    ];
    fields.extend(page_line(
        0,
        p.credit_cents,
        "g1t AI credit".to_owned(),
        Some(format!("Prepaid credit for Agent and AI Gateway usage in {}; expires a year after purchase", p.workspace)),
        false,
    ));
    fields.extend(fee_line(p.fee_cents, false));
    fields.extend(checkout_tax_fields(p.customer));
    match p.customer {
        Some(customer) => fields.push(("customer", customer.to_owned())),
        None => fields.push(("customer_creation", "always".to_owned())),
    }
    fields
}

/// An off-session charge's fields: the credit, the card fee and the tax
/// Stripe Tax worked out for them, in one payment.
pub(crate) fn saved_charge_fields(c: &SavedCharge<'_>) -> Vec<(&'static str, String)> {
    let mut fields = vec![
        ("amount", (c.credit_cents + c.fee_cents + c.tax_cents).to_string()),
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
        ("metadata[tax_cents]", c.tax_cents.to_string()),
    ];
    if let Some(calculation) = c.tax_calculation {
        fields.push(("metadata[tax_calculation]", calculation.to_owned()));
    }
    fields
}

/// A Stripe invoice's tax settings, for every invoice g1t makes: worked out
/// by Stripe Tax.
pub(crate) fn invoice_tax_fields() -> Vec<(&'static str, String)> {
    vec![("automatic_tax[enabled]", "true".to_owned())]
}

/// An invoice item's tax settings: g1t's tax code, the amount excluding tax.
pub(crate) fn item_tax_fields() -> Vec<(&'static str, String)> {
    vec![("tax_behavior", "exclusive".to_owned()), ("tax_code", TAX_CODE.to_owned())]
}

/// What a paid Stripe invoice comes to, as billing counts it: the tax
/// (`tax`, in this API version), the card fee (its lines, by name), and
/// what is left for what was sold, all in cents.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct InvoiceSplit {
    pub tax_cents: i64,
    pub fee_cents: i64,
    pub net_cents: i64,
}

/// A plan started on a saved card, as its subscription needs it.
pub(crate) struct SavedPlan<'a> {
    pub workspace: &'a str,
    pub feature: &'a str,
    pub title: &'a str,
    pub monthly_cents: u32,
    pub fee_cents: u32,
    pub customer: &'a str,
    pub payment_method: &'a str,
}

/// A subscription's fields, started on a saved card: the plan, the card
/// fee as a monthly item when there is one, each excluding tax, and Stripe
/// Tax on.
pub(crate) fn saved_subscription_fields(p: &SavedPlan<'_>, product: &str, fee_product: Option<&str>) -> Vec<(&'static str, String)> {
    let mut fields = vec![
        ("customer", p.customer.to_owned()),
        ("default_payment_method", p.payment_method.to_owned()),
        ("payment_behavior", "error_if_incomplete".to_owned()),
        ("automatic_tax[enabled]", "true".to_owned()),
        ("items[0][price_data][currency]", "usd".to_owned()),
        ("items[0][price_data][product]", product.to_owned()),
        ("items[0][price_data][unit_amount]", p.monthly_cents.to_string()),
        ("items[0][price_data][recurring][interval]", "month".to_owned()),
        ("items[0][price_data][tax_behavior]", "exclusive".to_owned()),
        ("metadata[workspace]", p.workspace.to_owned()),
        ("metadata[feature]", p.feature.to_owned()),
        ("description", format!("{} plan for {}", p.title, p.workspace)),
    ];
    if let (Some(fee_product), true) = (fee_product, p.fee_cents > 0) {
        fields.extend([
            ("items[1][price_data][currency]", "usd".to_owned()),
            ("items[1][price_data][product]", fee_product.to_owned()),
            ("items[1][price_data][unit_amount]", p.fee_cents.to_string()),
            ("items[1][price_data][recurring][interval]", "month".to_owned()),
            ("items[1][price_data][tax_behavior]", "exclusive".to_owned()),
        ]);
    }
    fields
}

pub(crate) fn invoice_split(invoice: &serde_json::Value, amount_paid: i64) -> InvoiceSplit {
    let tax_cents = invoice["tax"].as_i64().unwrap_or(0).max(0);
    let fee_cents: i64 = invoice["lines"]["data"]
        .as_array()
        .map(|lines| {
            lines
                .iter()
                .filter(|line| line["description"].as_str().is_some_and(|d| d.contains(CARD_FEE_LINE)))
                .map(|line| line["amount"].as_i64().unwrap_or(0))
                .sum()
        })
        .unwrap_or(0);
    let fee_cents = fee_cents.max(0);
    InvoiceSplit { tax_cents, fee_cents, net_cents: (amount_paid - tax_cents - fee_cents).max(0) }
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
        struct Billing {
            #[serde(default)]
            address: Option<serde_json::Value>,
        }
        #[derive(Deserialize)]
        struct PaymentMethod {
            card: Option<Card>,
            #[serde(default)]
            billing_details: Option<Billing>,
        }
        let setup: Setup = self.call(Method::Get, &format!("/setup_intents/{}", encode(setup_intent)), None).await?;
        let (true, Some(method)) = (setup.status == "succeeded", setup.payment_method) else { return Ok(None) };
        let found: PaymentMethod = self.call(Method::Get, &format!("/payment_methods/{}", encode(&method)), None).await?;
        let card = found.card;
        let address = found.billing_details.and_then(|b| b.address).filter(|a| a.is_object());
        Ok(Some(CheckedCard {
            address,
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

    /// One of g1t's products at Stripe, tagged `metadata[g1t]` (the plan's
    /// is `plan`, the card fee's `card_fee`), made the first time it is
    /// needed, with g1t's tax code. One made before Stripe Tax was on is
    /// given the code when it is found.
    async fn product(&self, tag: &str, name: &str) -> Result<String> {
        #[derive(Deserialize)]
        struct Product {
            id: String,
            #[serde(default)]
            metadata: Option<std::collections::HashMap<String, String>>,
            #[serde(default)]
            tax_code: Option<serde_json::Value>,
        }
        #[derive(Deserialize)]
        struct List {
            data: Vec<Product>,
        }
        let list: List = self.call(Method::Get, "/products?active=true&limit=100", None).await?;
        let ours = |p: &Product| p.metadata.as_ref().and_then(|m| m.get("g1t")).map(String::as_str) == Some(tag);
        if let Some(found) = list.data.into_iter().find(ours) {
            let coded = found.tax_code.as_ref().is_some_and(|code| code.as_str() == Some(TAX_CODE) || code["id"].as_str() == Some(TAX_CODE));
            if !coded {
                let _: serde_json::Value = self
                    .call(Method::Post, &format!("/products/{}", encode(&found.id)), Some(form(&[("tax_code", TAX_CODE.to_owned())])))
                    .await?;
            }
            return Ok(found.id);
        }
        let created: Product = self
            .call(
                Method::Post,
                "/products",
                Some(form(&[("name", name.to_owned()), ("metadata[g1t]", tag.to_owned()), ("tax_code", TAX_CODE.to_owned())])),
            )
            .await?;
        Ok(created.id)
    }

    /// Starts the monthly plan on a saved card, at once, with tax worked
    /// out by Stripe Tax on every invoice and the card fee as a monthly item
    /// of its own. Fails rather than leaving it half-started when the card's
    /// bank wants the person again, or when Stripe Tax cannot place the
    /// customer (no billing address yet); the caller then sends them to
    /// Stripe's page, which asks for the address.
    #[allow(clippy::too_many_arguments)]
    pub async fn subscribe_with_card(
        &self,
        workspace: &str,
        feature: &str,
        title: &str,
        monthly_cents: u32,
        fee_cents: u32,
        customer: &str,
        payment_method: &str,
    ) -> Result<StripeSubscription> {
        let product = self.product(feature, &format!("{title} plan")).await?;
        let fee_product = if fee_cents > 0 { Some(self.product("card_fee", CARD_FEE_LINE).await?) } else { None };
        let plan = SavedPlan { workspace, feature, title, monthly_cents, fee_cents, customer, payment_method };
        let fields = saved_subscription_fields(&plan, &product, fee_product.as_deref());
        let key = plan_key(workspace, feature, &format!("{payment_method}/{monthly_cents}/{fee_cents}"), g1t_kit::now_ms());
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
mod tax_mode_tests {
    use super::*;

    #[test]
    fn untaxed_requests_lose_only_automatic_tax() {
        let body = form(&[("mode", "payment".to_owned()), ("automatic_tax[enabled]", "true".to_owned()), ("tax_id_collection[enabled]", "true".to_owned())]);
        assert_eq!(without_automatic_tax(&body), form(&[("mode", "payment".to_owned()), ("tax_id_collection[enabled]", "true".to_owned())]));
        assert!(taxed_path("/checkout/sessions") && taxed_path("/invoices") && taxed_path("/subscriptions"));
        assert!(!taxed_path("/invoices/in_1/finalize") && !taxed_path("/payment_intents"));
    }
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
            let fields = subscription_fields("acme", "plan", "g1t", 2_000, 92, customer, url);
            assert_eq!(has(&fields, "mode").as_deref(), Some("subscription"));
            // customer_creation is for payment mode; Stripe refuses it here.
            assert!(has(&fields, "customer_creation").is_none());
            assert!(has(&fields, "payment_intent_data[setup_future_usage]").is_none());
            assert_eq!(has(&fields, "customer").as_deref(), customer);
            assert_eq!(has(&fields, "success_url").unwrap(), "https://g1t.sh/acme/-/billing?plan=plan&session={CHECKOUT_SESSION_ID}");
            assert_eq!(has(&fields, "line_items[0][price_data][recurring][interval]").as_deref(), Some("month"));
            // The card fee is a monthly line of its own.
            assert_eq!(has(&fields, "line_items[1][price_data][unit_amount]").as_deref(), Some("92"));
            assert_eq!(has(&fields, "line_items[1][price_data][recurring][interval]").as_deref(), Some("month"));
            assert_eq!(has(&fields, "line_items[1][price_data][product_data][name]").as_deref(), Some(CARD_FEE_LINE));
        }
        let fields = subscription_fields("acme", "plan", "g1t", 2_000, 0, None, url);
        assert!(has(&fields, "line_items[1][quantity]").is_none());
    }

    /// Every field a page must carry for Stripe Tax: tax on top of the
    /// price, an address always asked for, the buyer's tax ID, and each
    /// line at g1t's tax code, excluding tax. With a customer, what is
    /// entered is saved on it (Checkout refuses `automatic_tax` and
    /// `tax_id_collection` for a customer otherwise).
    fn assert_taxed_page(fields: &[(&str, String)], customer: Option<&str>, lines: usize) {
        assert_eq!(has(fields, "automatic_tax[enabled]").as_deref(), Some("true"));
        assert_eq!(has(fields, "billing_address_collection").as_deref(), Some("required"));
        assert_eq!(has(fields, "tax_id_collection[enabled]").as_deref(), Some("true"));
        let saved = if customer.is_some() { Some("auto") } else { None };
        assert_eq!(has(fields, "customer_update[address]").as_deref(), saved);
        assert_eq!(has(fields, "customer_update[name]").as_deref(), saved);
        for (line, keys) in LINE_KEYS.iter().enumerate().take(lines) {
            assert_eq!(has(fields, keys[3]).as_deref(), Some("exclusive"), "line {line}");
            assert_eq!(has(fields, keys[5]).as_deref(), Some(TAX_CODE), "line {line}");
        }
        // No key twice: Stripe takes the last, silently.
        let mut names: Vec<&str> = fields.iter().map(|(n, _)| *n).collect();
        names.sort_unstable();
        let count = names.len();
        names.dedup();
        assert_eq!(names.len(), count);
    }

    #[test]
    fn every_payment_page_is_taxed_by_stripe_tax() {
        let url = "https://g1t.sh/acme/-/billing";
        for customer in [None, Some("cus_1")] {
            // The plan and Security and quality.
            assert_taxed_page(&subscription_fields("acme", "plan", "g1t", 2_000, 92, customer, url), customer, 2);
            assert_taxed_page(&subscription_fields("acme", "security", "Security and quality", 1_000, 61, customer, url), customer, 2);
            // Prepaying by card, with its fee, and by bank transfer, without.
            assert_taxed_page(&prepay_fields("acme", 5_000, 185, customer, url, false), customer, 2);
            assert_taxed_page(&prepay_fields("acme", 100_000, 0, customer, url, true), customer, 1);
            // AI credit.
            let purchase = CreditPurchase { workspace: "acme", credit_cents: 2_500, fee_cents: 106, customer, return_url: url };
            assert_taxed_page(&credit_fields(&purchase), customer, 2);
        }
        // tax_id_collection and customer_update are for payment and
        // subscription mode; a card check charges nothing, so it is not
        // taxed, but it asks for the address the plan will be taxed at.
        let check = card_check_fields("acme", "cus_1", url);
        assert!(has(&check, "automatic_tax[enabled]").is_none());
        assert_eq!(has(&check, "billing_address_collection").as_deref(), Some("required"));
    }

    #[test]
    fn a_bank_transfer_has_no_card_fee() {
        let fields = prepay_fields("acme", 100_000, 3_100, Some("cus_1"), "https://g1t.sh/acme/-/billing", true);
        assert!(has(&fields, "line_items[1][quantity]").is_none());
        let fields = prepay_fields("acme", 5_000, 185, None, "https://g1t.sh/acme/-/billing", false);
        assert_eq!(has(&fields, "line_items[1][price_data][unit_amount]").as_deref(), Some("185"));
        assert_eq!(has(&fields, "line_items[1][price_data][product_data][name]").as_deref(), Some(CARD_FEE_LINE));
    }

    #[test]
    fn a_plan_on_a_saved_card_is_taxed_with_its_card_fee() {
        let plan = SavedPlan { workspace: "acme", feature: "plan", title: "g1t", monthly_cents: 2_000, fee_cents: 92, customer: "cus_1", payment_method: "pm_1" };
        let fields = saved_subscription_fields(&plan, "prod_plan", Some("prod_fee"));
        assert_eq!(has(&fields, "automatic_tax[enabled]").as_deref(), Some("true"));
        assert_eq!(has(&fields, "items[0][price_data][tax_behavior]").as_deref(), Some("exclusive"));
        assert_eq!(has(&fields, "items[1][price_data][product]").as_deref(), Some("prod_fee"));
        assert_eq!(has(&fields, "items[1][price_data][unit_amount]").as_deref(), Some("92"));
        assert_eq!(has(&fields, "items[1][price_data][tax_behavior]").as_deref(), Some("exclusive"));
        let fields = saved_subscription_fields(&SavedPlan { fee_cents: 0, ..plan }, "prod_plan", None);
        assert!(has(&fields, "items[1][price_data][product]").is_none());
    }

    #[test]
    fn invoices_and_their_lines_are_taxed() {
        assert_eq!(has(&invoice_tax_fields(), "automatic_tax[enabled]").as_deref(), Some("true"));
        let item = item_tax_fields();
        assert_eq!(has(&item, "tax_behavior").as_deref(), Some("exclusive"));
        assert_eq!(has(&item, "tax_code").as_deref(), Some(TAX_CODE));
    }

    #[test]
    fn an_off_session_charge_is_its_credit_fee_and_tax() {
        let charge = SavedCharge {
            workspace: "acme",
            customer: "cus_1",
            payment_method: "pm_1",
            credit_cents: 1_600,
            fee_cents: 78,
            tax_cents: 134,
            tax_calculation: Some("taxcalc_1"),
            key: "reload/acme/2026-10/1",
        };
        let calculation = tax_calculation_fields(&charge);
        assert_eq!(has(&calculation, "customer").as_deref(), Some("cus_1"));
        assert_eq!(has(&calculation, "line_items[0][amount]").as_deref(), Some("1600"));
        assert_eq!(has(&calculation, "line_items[0][tax_behavior]").as_deref(), Some("exclusive"));
        assert_eq!(has(&calculation, "line_items[0][tax_code]").as_deref(), Some(TAX_CODE));
        assert_eq!(has(&calculation, "line_items[1][amount]").as_deref(), Some("78"));
        assert_eq!(has(&calculation, "line_items[1][tax_code]").as_deref(), Some(TAX_CODE));
        let fields = saved_charge_fields(&charge);
        assert_eq!(has(&fields, "amount").as_deref(), Some("1812"));
        assert_eq!(has(&fields, "metadata[tax_calculation]").as_deref(), Some("taxcalc_1"));
        let reversal = reversal_fields("tax_1", "pi_1/re_1", 500);
        assert_eq!(has(&reversal, "flat_amount").as_deref(), Some("-500"));
        assert_eq!(has(&reversal, "mode").as_deref(), Some("partial"));
    }

    #[test]
    fn a_paid_invoice_splits_into_tax_card_fee_and_what_was_sold() {
        let invoice = serde_json::json!({
            "tax": 180,
            "lines": { "data": [
                { "description": "1 × g1t plan (at $20.00 / month)", "amount": 2000 },
                { "description": "1 × Card processing fee (at $0.92 / month)", "amount": 92 },
            ] }
        });
        assert_eq!(invoice_split(&invoice, 2_272), InvoiceSplit { tax_cents: 180, fee_cents: 92, net_cents: 2_000 });
        // Before Stripe Tax: no tax, no fee, all of it sold.
        assert_eq!(invoice_split(&serde_json::json!({ "tax": null }), 2_000).net_cents, 2_000);
        // A page's tax and what came before it.
        let session: Session = serde_json::from_value(serde_json::json!({
            "id": "cs_1", "payment_status": "paid", "amount_total": 5_585, "amount_subtotal": 5_185,
            "total_details": { "amount_tax": 400 }, "customer": "cus_1", "payment_intent": "pi_1"
        }))
        .unwrap();
        assert_eq!((session.tax_cents(), session.before_tax_cents()), (400, 5_185));
    }

    #[test]
    fn an_address_places_a_customer_for_tax() {
        use serde_json::json;
        assert!(address_places_customer(&json!({ "country": "DE" })));
        assert!(address_places_customer(&json!({ "country": "US", "postal_code": "94107" })));
        assert!(!address_places_customer(&json!({ "country": "US", "postal_code": "" })));
        assert!(address_places_customer(&json!({ "country": "CA", "state": "ON" })));
        assert!(!address_places_customer(&json!({ "country": "" })));
        assert!(!address_places_customer(&serde_json::Value::Null));
        let error = Error::RustError(r#"the card processor answered 400: {"error":{"code":"customer_tax_location_invalid","message":"x"}}"#.into());
        assert!(is_tax_location_error(&error));
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
        let charge = SavedCharge {
            workspace: "acme",
            customer: "cus_1",
            payment_method: "pm_1",
            credit_cents: 1_600,
            fee_cents: 78,
            tax_cents: 0,
            tax_calculation: None,
            key: "reload/acme/2026-10/1",
        };
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
