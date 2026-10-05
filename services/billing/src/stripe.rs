//! The card processor, behind the calls billing needs: start a payment
//! page, ask whether a payment was made, and read or end a monthly plan. Stripe speaks form-encoded
//! requests and JSON answers.

use serde::Deserialize;
use worker::{Error, Fetch, Headers, Method, Request, RequestInit, Result};

const API: &str = "https://api.stripe.com/v1";

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

/// A saved card's details.
#[derive(Debug, Deserialize)]
pub struct SavedCard {
    pub brand: String,
    pub last4: String,
    pub exp_month: u32,
    pub exp_year: u32,
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

    pub(crate) async fn delete<T: for<'a> Deserialize<'a>>(&self, path: &str) -> Result<T> {
        self.call(Method::Delete, path, None).await
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

    /// The customer's card, if one is saved.
    pub async fn card(&self, customer: &str) -> Result<Option<SavedCard>> {
        #[derive(Deserialize)]
        struct Methods {
            data: Vec<Method_>,
        }
        #[derive(Deserialize)]
        struct Method_ {
            card: Option<SavedCard>,
        }
        let methods: Methods = self
            .call(Method::Get, &format!("/payment_methods?customer={}&type=card&limit=1", encode(customer)), None)
            .await?;
        Ok(methods.data.into_iter().next().and_then(|m| m.card))
    }

    /// Starts a page on which `amount_cents` of credit is paid for by card.
    /// The card is kept for the workspace, so that topping up again, by
    /// hand or automatically, needs no retyping.
    pub async fn start_checkout(
        &self,
        workspace: &str,
        amount_cents: u32,
        customer: Option<&str>,
        return_url: &str,
    ) -> Result<Session> {
        let separator = if return_url.contains('?') { '&' } else { '?' };
        let mut fields = vec![
            ("mode", "payment".to_owned()),
            // Cards only: credit is bought on the spot, and the card is kept
            // for topping up again.
            ("payment_method_types[0]", "card".to_owned()),
            (
                "success_url",
                // Stripe fills in the payment's id.
                format!("{return_url}{separator}session={{CHECKOUT_SESSION_ID}}"),
            ),
            ("cancel_url", return_url.to_owned()),
            ("client_reference_id", workspace.to_owned()),
            ("metadata[workspace]", workspace.to_owned()),
            ("line_items[0][quantity]", "1".to_owned()),
            ("line_items[0][price_data][currency]", "usd".to_owned()),
            (
                "line_items[0][price_data][unit_amount]",
                amount_cents.to_string(),
            ),
            (
                "line_items[0][price_data][product_data][name]",
                format!("g1t agent credit for {workspace}"),
            ),
            (
                "payment_intent_data[setup_future_usage]",
                "off_session".to_owned(),
            ),
        ];
        match customer {
            Some(customer) => fields.push(("customer", customer.to_owned())),
            None => fields.push(("customer_creation", "always".to_owned())),
        }
        self.call(Method::Post, "/checkout/sessions", Some(form(&fields)))
            .await
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
        let separator = if return_url.contains('?') { '&' } else { '?' };
        let mut fields = vec![
            ("mode", "subscription".to_owned()),
            ("payment_method_types[0]", "card".to_owned()),
            (
                "success_url",
                format!("{return_url}{separator}session={{CHECKOUT_SESSION_ID}}"),
            ),
            ("cancel_url", return_url.to_owned()),
            ("client_reference_id", workspace.to_owned()),
            ("metadata[workspace]", workspace.to_owned()),
            ("metadata[feature]", feature.to_owned()),
            ("subscription_data[metadata][workspace]", workspace.to_owned()),
            ("subscription_data[metadata][feature]", feature.to_owned()),
            ("line_items[0][quantity]", "1".to_owned()),
            ("line_items[0][price_data][currency]", "usd".to_owned()),
            (
                "line_items[0][price_data][unit_amount]",
                monthly_cents.to_string(),
            ),
            (
                "line_items[0][price_data][recurring][interval]",
                "month".to_owned(),
            ),
            (
                "line_items[0][price_data][product_data][name]",
                format!("g1t {title} for {workspace}"),
            ),
        ];
        if let Some(customer) = customer {
            fields.push(("customer", customer.to_owned()));
        }
        self.call(Method::Post, "/checkout/sessions", Some(form(&fields)))
            .await
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
}
