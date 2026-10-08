//! Billing details: who a workspace's invoices are for, kept on its Stripe
//! customer and edited from the Billing page (never a card form of g1t's
//! own: cards are added on Stripe's billing page), with the default
//! payment method, the invoices Stripe holds, and the next invoice as
//! g1t's ledger has it.

use futures_util::future::try_join3;
use g1t_contracts::billing::{
    AccountArgs, BillingDetails, Feature, PaymentMethod, PostalAddress, SetBillingDetailsArgs, StripeInvoice, UpcomingInvoice,
};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, Role};
use g1t_kit::now_ms;
use serde_json::Value;
use sha2::{Digest, Sha256};
use worker::Result;

use crate::{Billing, members_only};

/// The languages Stripe writes invoices in, as `preferred_locales` takes
/// them.
pub(crate) const LANGUAGES: [&str; 44] = [
    "bg", "cs", "da", "de", "el", "en", "en-GB", "es", "es-419", "et", "fi", "fil", "fr", "fr-CA", "hr", "hu", "id", "it", "ja",
    "ko", "lt", "lv", "ms", "mt", "nb", "nl", "pl", "pt", "pt-BR", "ro", "ru", "sk", "sl", "sv", "th", "tr", "vi", "zh",
    "zh-HK", "zh-TW", "is", "hi", "he", "ar",
];

/// What is wrong with details as given, if anything.
pub(crate) fn details_invalid(a: &SetBillingDetailsArgs) -> Option<&'static str> {
    if let Some(email) = a.email.as_deref().map(str::trim).filter(|e| !e.is_empty())
        && (email.len() > 254 || !email.contains('@') || email.contains(char::is_whitespace) || email.starts_with('@') || email.ends_with('@'))
    {
        return Some("That is not an email address.");
    }
    if a.name.as_deref().is_some_and(|n| n.trim().chars().count() > 200) {
        return Some("Keep the company name under 200 characters.");
    }
    if let Some(address) = &a.address {
        if !address.country.trim().is_empty() && (address.country.trim().len() != 2 || !address.country.trim().chars().all(|c| c.is_ascii_alphabetic())) {
            return Some("The country is two letters, such as US or DE.");
        }
        let parts = [&address.line1, &address.line2, &address.city, &address.state, &address.postal_code];
        if parts.iter().any(|p| p.chars().count() > 200) {
            return Some("Keep each line of the address under 200 characters.");
        }
    }
    if a.po_number.as_deref().is_some_and(|p| p.trim().chars().count() > 140) {
        return Some("Keep the purchase order under 140 characters.");
    }
    if let Some(language) = a.language.as_deref().map(str::trim).filter(|l| !l.is_empty())
        && !LANGUAGES.contains(&language)
    {
        return Some("Stripe does not write invoices in that language.");
    }
    match (a.tax_id_type.as_deref().map(str::trim), a.tax_id.as_deref().map(str::trim)) {
        (Some(kind), Some(value)) if !kind.is_empty() && !value.is_empty() => {
            if kind.len() > 20 || !kind.chars().all(|c| c.is_ascii_lowercase() || c == '_') {
                return Some("Choose the kind of tax ID from the list.");
            }
            if value.chars().count() > 60 {
                return Some("That tax ID is too long.");
            }
        }
        (Some(kind), Some(value)) if kind.is_empty() != value.is_empty() => return Some("Give the tax ID's kind and its number together."),
        _ => {}
    }
    None
}

/// The customer's fields to send for the details given: absent ones left
/// as they are, empty ones cleared.
pub(crate) fn customer_fields(a: &SetBillingDetailsArgs) -> Vec<(&'static str, String)> {
    let mut fields = vec![];
    if let Some(email) = &a.email {
        fields.push(("email", email.trim().to_owned()));
    }
    if let Some(name) = &a.name {
        fields.push(("name", name.trim().to_owned()));
    }
    if let Some(address) = &a.address {
        fields.extend([
            ("address[line1]", address.line1.trim().to_owned()),
            ("address[line2]", address.line2.trim().to_owned()),
            ("address[city]", address.city.trim().to_owned()),
            ("address[state]", address.state.trim().to_owned()),
            ("address[postal_code]", address.postal_code.trim().to_owned()),
            ("address[country]", address.country.trim().to_uppercase()),
        ]);
    }
    if let Some(po) = &a.po_number {
        let po = po.trim();
        fields.push(("metadata[po_number]", po.to_owned()));
        // Printed on every invoice; empty clears it.
        if po.is_empty() {
            fields.push(("invoice_settings[custom_fields]", String::new()));
        } else {
            fields.push(("invoice_settings[custom_fields][0][name]", "Purchase order".to_owned()));
            fields.push(("invoice_settings[custom_fields][0][value]", po.to_owned()));
        }
    }
    if let Some(language) = &a.language {
        let language = language.trim();
        if language.is_empty() {
            fields.push(("preferred_locales", String::new()));
        } else {
            fields.push(("preferred_locales[0]", language.to_owned()));
        }
    }
    fields
}

/// An invoice as Stripe answers it.
pub(crate) fn invoice_from(v: &Value) -> Option<StripeInvoice> {
    Some(StripeInvoice {
        id: v["id"].as_str()?.to_owned(),
        number: v["number"].as_str().map(str::to_owned),
        status: v["status"].as_str().unwrap_or("draft").to_owned(),
        total_cents: v["total"].as_i64().unwrap_or(0),
        currency: v["currency"].as_str().unwrap_or("usd").to_owned(),
        created_at: rfc3339(v["created"].as_u64().unwrap_or(0) * 1000),
        description: v["description"].as_str().map(str::to_owned).or_else(|| {
            v["lines"]["data"].as_array().and_then(|lines| lines.first()).and_then(|line| line["description"].as_str()).map(str::to_owned)
        }),
        hosted_url: v["hosted_invoice_url"].as_str().map(str::to_owned),
        pdf_url: v["invoice_pdf"].as_str().map(str::to_owned),
    })
}

/// The details Stripe keeps on a customer.
pub(crate) fn details_from(customer: &Value) -> BillingDetails {
    let text = |v: &Value| v.as_str().map(str::to_owned).filter(|s| !s.is_empty());
    let address = &customer["address"];
    let tax = customer["tax_ids"]["data"].as_array().and_then(|ids| ids.first());
    BillingDetails {
        customer: true,
        email: text(&customer["email"]),
        name: text(&customer["name"]),
        address: address.is_object().then(|| PostalAddress {
            line1: address["line1"].as_str().unwrap_or_default().to_owned(),
            line2: address["line2"].as_str().unwrap_or_default().to_owned(),
            city: address["city"].as_str().unwrap_or_default().to_owned(),
            state: address["state"].as_str().unwrap_or_default().to_owned(),
            postal_code: address["postal_code"].as_str().unwrap_or_default().to_owned(),
            country: address["country"].as_str().unwrap_or_default().to_owned(),
        }),
        tax_id_type: tax.and_then(|t| text(&t["type"])),
        tax_id: tax.and_then(|t| text(&t["value"])),
        po_number: text(&customer["metadata"]["po_number"]),
        language: customer["preferred_locales"].as_array().and_then(|l| l.first()).and_then(text),
        ..BillingDetails::default()
    }
}

impl Billing {
    /// `billing_details`: members only.
    pub(crate) async fn billing_details(&self, a: AccountArgs) -> Result<Outcome<BillingDetails>> {
        let workspace = a.workspace.to_lowercase();
        if !a.viewer.is_some_and(|viewer| viewer.is_member(&workspace)) {
            return Ok(members_only());
        }
        Ok(Outcome::Ok(self.details_of(&workspace).await?))
    }

    async fn details_of(&self, workspace: &str) -> Result<BillingDetails> {
        let row = self.row(workspace).await?;
        let upcoming = self.upcoming(workspace, row.as_ref().map_or(0, |r| r.balance_micros)).await?;
        let (Some(stripe), Some(customer)) = (&self.stripe, row.and_then(|r| r.customer_id)) else {
            return Ok(BillingDetails { upcoming, ..BillingDetails::default() });
        };
        match try_join3(stripe.customer(&customer), stripe.default_payment_method(&customer), stripe.invoices(&customer)).await {
            Ok((found, method, invoices)) => {
                let mut details = details_from(&found);
                details.payment_method = method.map(|m| PaymentMethod {
                    kind: m.kind,
                    brand: m.brand,
                    last4: m.last4,
                    exp_month: m.exp_month,
                    exp_year: m.exp_year,
                });
                details.invoices = invoices.iter().filter_map(invoice_from).collect();
                details.upcoming = upcoming;
                Ok(details)
            }
            Err(error) => {
                worker::console_error!("{workspace}: Stripe's customer could not be read: {error}");
                // The card as last synced, at least.
                let card = self.saved_card(workspace).await?;
                Ok(BillingDetails {
                    customer: true,
                    payment_method: card.map(|c| PaymentMethod {
                        kind: "card".into(),
                        brand: Some(c.brand),
                        last4: Some(c.last4),
                        exp_month: Some(c.exp_month),
                        exp_year: Some(c.exp_year),
                    }),
                    upcoming,
                    unavailable: Some(crate::stripe::friendly(&error)),
                    ..BillingDetails::default()
                })
            }
        }
    }

    /// The next invoice, from the ledger: the plan and activations at their
    /// monthly price, and usage still owed.
    async fn upcoming(&self, workspace: &str, balance: i64) -> Result<UpcomingInvoice> {
        let month = rfc3339(now_ms())[..7].to_owned();
        let mut subscriptions = 0i64;
        for feature in [Feature::Plan, Feature::Security] {
            if self.plan_on(workspace, feature).await? {
                subscriptions += i64::from(self.plan(feature).await?.monthly_cents) * 10_000;
            }
        }
        let terms = self.terms_of(workspace).await?;
        if terms.full_discount() {
            subscriptions = 0;
        }
        #[derive(serde::Deserialize)]
        struct Pending {
            cost: Option<f64>,
        }
        let pending = self
            .db
            .prepare("SELECT SUM(cost_micros) AS cost FROM pending_usage WHERE workspace = ? AND month = ? AND charged_at IS NULL")
            .bind(&[workspace.into(), month.as_str().into()])?
            .first::<Pending>(None)
            .await?
            .and_then(|p| p.cost)
            .unwrap_or(0.0) as i64;
        let pending = terms.apply(crate::credits::with_margin(pending, self.margin_percent));
        let usage = self.owed_with(workspace, balance).await? + pending.max(0);
        Ok(UpcomingInvoice {
            closes_at: crate::credits::next_month_start(&month),
            subscriptions_micros: subscriptions,
            usage_micros: usage,
            total_micros: subscriptions + usage,
        })
    }

    /// `set_billing_details`: owners only, saved on the Stripe customer.
    pub(crate) async fn set_billing_details(&self, a: SetBillingDetailsArgs) -> Result<Outcome<BillingDetails>> {
        let workspace = a.workspace.to_lowercase();
        if a.actor.role_in(&workspace) != Some(Role::Owner) {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only an owner can change the workspace's billing details."));
        }
        let Some(stripe) = &self.stripe else {
            return Ok(Outcome::fail(FailureCode::Conflict, "Payments are not set up on this g1t."));
        };
        if let Some(why) = details_invalid(&a) {
            return Ok(Outcome::fail(FailureCode::Invalid, why));
        }
        let customer = match self.customer_for(&workspace).await {
            Ok(customer) => customer,
            Err(error) => return Ok(Outcome::fail(FailureCode::Conflict, crate::stripe::friendly(&error))),
        };
        let fields = customer_fields(&a);
        if !fields.is_empty() {
            let key = format!("details/{workspace}/{}", hex::encode(Sha256::digest(crate::stripe::form(&fields).as_bytes())));
            let saved: Result<Value> = stripe.post_idempotent(&format!("/customers/{customer}"), &fields, &key).await;
            if let Err(error) = saved {
                return Ok(Outcome::fail(FailureCode::Conflict, crate::stripe::friendly(&error)));
            }
        }
        // A tax ID replaces the one there was.
        if let (Some(kind), Some(value)) = (a.tax_id_type.as_deref().map(str::trim), a.tax_id.as_deref().map(str::trim)) {
            let existing: Result<Value> = stripe.get(&format!("/customers/{customer}/tax_ids?limit=10")).await;
            let existing = existing.ok().and_then(|list| list["data"].as_array().cloned()).unwrap_or_default();
            let same = existing.iter().any(|t| t["type"].as_str() == Some(kind) && t["value"].as_str() == Some(value));
            if !same {
                if !value.is_empty() {
                    let key = format!("tax_id/{workspace}/{kind}/{value}");
                    let added: Result<Value> =
                        stripe.post_idempotent(&format!("/customers/{customer}/tax_ids"), &[("type", kind.to_owned()), ("value", value.to_owned())], &key).await;
                    if let Err(error) = added {
                        return Ok(Outcome::fail(FailureCode::Invalid, crate::stripe::friendly(&error)));
                    }
                }
                for old in existing {
                    if let Some(id) = old["id"].as_str() {
                        let _: Result<Value> = stripe.delete(&format!("/customers/{customer}/tax_ids/{id}")).await;
                    }
                }
            }
        }
        let account = self.account_of(&workspace).await?;
        self.audit(&account.id, "billing_details", &format!("{workspace}: invoice details changed"), &a.actor.username).await?;
        Ok(Outcome::Ok(self.details_of(&workspace).await?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn args() -> SetBillingDetailsArgs {
        SetBillingDetailsArgs {
            actor: serde_json::from_value(json!({ "id": "usr_1", "username": "ada" })).unwrap(),
            workspace: "acme".into(),
            email: None,
            name: None,
            address: None,
            tax_id_type: None,
            tax_id: None,
            po_number: None,
            language: None,
        }
    }

    #[test]
    fn details_are_checked_before_stripe_sees_them() {
        assert_eq!(details_invalid(&args()), None);
        assert!(details_invalid(&SetBillingDetailsArgs { email: Some("not an email".into()), ..args() }).is_some());
        assert!(details_invalid(&SetBillingDetailsArgs { language: Some("klingon".into()), ..args() }).is_some());
        assert!(details_invalid(&SetBillingDetailsArgs { tax_id_type: Some("eu_vat".into()), tax_id: Some(String::new()), ..args() }).is_some());
        assert_eq!(details_invalid(&SetBillingDetailsArgs { tax_id_type: Some("eu_vat".into()), tax_id: Some("DE123456789".into()), ..args() }), None);
        let address = PostalAddress { country: "Germany".into(), ..PostalAddress::default() };
        assert!(details_invalid(&SetBillingDetailsArgs { address: Some(address), ..args() }).is_some());
    }

    #[test]
    fn only_what_was_given_is_sent_and_empty_clears() {
        assert!(customer_fields(&args()).is_empty());
        let fields = customer_fields(&SetBillingDetailsArgs { po_number: Some("PO-7".into()), language: Some("fr".into()), ..args() });
        assert!(fields.contains(&("invoice_settings[custom_fields][0][value]", "PO-7".to_owned())));
        assert!(fields.contains(&("preferred_locales[0]", "fr".to_owned())));
        let cleared = customer_fields(&SetBillingDetailsArgs { po_number: Some(" ".into()), ..args() });
        assert!(cleared.contains(&("invoice_settings[custom_fields]", String::new())));
    }

    #[test]
    fn stripe_answers_read_as_details_and_invoices() {
        let customer = json!({
            "email": "billing@acme.test", "name": "Acme, Inc.",
            "address": { "line1": "1 Main St", "city": "Springfield", "country": "US", "postal_code": "12345" },
            "tax_ids": { "data": [{ "type": "us_ein", "value": "12-3456789" }] },
            "metadata": { "po_number": "PO-7" }, "preferred_locales": ["en"],
        });
        let details = details_from(&customer);
        assert_eq!(details.name.as_deref(), Some("Acme, Inc."));
        assert_eq!(details.address.unwrap().city, "Springfield");
        assert_eq!(details.tax_id_type.as_deref(), Some("us_ein"));
        assert_eq!(details.po_number.as_deref(), Some("PO-7"));
        let invoice = invoice_from(&json!({ "id": "in_1", "status": "paid", "total": 2000, "currency": "usd", "created": 1791000000, "invoice_pdf": "https://pay.stripe.com/x.pdf" })).unwrap();
        assert_eq!((invoice.total_cents, invoice.pdf_url.as_deref()), (2000, Some("https://pay.stripe.com/x.pdf")));
        assert!(invoice_from(&json!({})).is_none());
    }
}
