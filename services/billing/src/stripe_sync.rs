//! What billing keeps of Stripe, so that reads never wait on it and nothing
//! Stripe says is lost:
//!
//! - The saved card, on the account row: read from there, asked of Stripe
//!   only the first time, and refreshed by card and customer events
//!   (webhooks.rs) and a weekly pass.
//! - Missed events, replayed: every run of the cron reads Stripe's event
//!   list from where the last run got to and handles any event not seen,
//!   through the same once-only claim the webhook uses. A delivery that
//!   failed for good, or an endpoint not registered yet, costs at most one
//!   cron interval.
//! - The destination, kept: once a day it is enabled again if Stripe turned
//!   it off after failures, and given any event billing handles that it
//!   does not send. Its signing secret, `STRIPE_WEBHOOK_SECRET`, is not
//!   touched.

use crate::Billing;
use crate::stripe::form;
use crate::webhooks::{EVENTS, WEBHOOK_URL, missing_events};
use g1t_contracts::billing::Card;
use g1t_contracts::time::rfc3339;
use g1t_kit::now_ms;
use serde::Deserialize;
use serde_json::Value;
use worker::Result;

/// How far back each replay starts before where the last one got to, for
/// events Stripe lists a little late.
const OVERLAP_SECONDS: i64 = 60 * 60;
/// How recent an event may be and still be listed later: the replay's
/// mark stays this far behind the clock.
const SETTLE_SECONDS: i64 = 5 * 60;
/// Where the first replay starts.
const FIRST_LOOK_SECONDS: i64 = 3 * 24 * 60 * 60;
/// Pages of 100 events one replay reads at most.
const MAX_PAGES: usize = 10;
/// A claim this old that never finished: its handler died, so the event
/// may be handled again.
const STALE_CLAIM_MS: u64 = 10 * 60 * 1000;
/// How long a saved card is believed before the weekly pass asks again.
const CARD_FRESH_DAYS: u64 = 7;
/// Accounts or plans the daily pass refreshes at most.
const REFRESH_BATCH: u32 = 25;

#[derive(Deserialize)]
struct CardRow {
    customer_id: Option<String>,
    card_brand: Option<String>,
    card_last4: Option<String>,
    card_exp_month: Option<u32>,
    card_exp_year: Option<u32>,
    card_synced_at: Option<String>,
}

/// Where the replay's mark goes after a run: the first event that failed
/// (so it is listed again), the old mark when the list was not read to its
/// end, else just behind the clock.
pub(crate) fn next_through(previous: i64, now: i64, first_failed: Option<i64>, complete: bool) -> i64 {
    match first_failed {
        Some(created) => created.min(previous.max(created)),
        None if !complete => previous,
        None => previous.max(now - SETTLE_SECONDS),
    }
}

impl Billing {
    /// The workspace's saved card as last synced. Stripe is asked only when
    /// it never was, or g1t changed the card since; a Stripe that does not
    /// answer then shows no card, as before.
    pub(crate) async fn saved_card(&self, workspace: &str) -> Result<Option<Card>> {
        let Some(row) = self
            .db
            .prepare(
                "SELECT customer_id, card_brand, card_last4, card_exp_month, card_exp_year, card_synced_at
                 FROM accounts WHERE workspace = ?",
            )
            .bind(&[workspace.into()])?
            .first::<CardRow>(None)
            .await?
        else {
            return Ok(None);
        };
        if row.card_synced_at.is_some() {
            return Ok(card_of(&row));
        }
        let Some(customer) = row.customer_id.as_deref() else { return Ok(None) };
        if self.stripe.is_none() {
            return Ok(None);
        }
        Ok(match self.fetch_card(customer).await {
            Ok(card) => card,
            Err(error) => {
                worker::console_error!("reading {workspace}'s card from Stripe failed: {error}");
                None
            }
        })
    }

    /// Asks Stripe for the customer's card and keeps it on every account
    /// with that customer.
    async fn fetch_card(&self, customer: &str) -> Result<Option<Card>> {
        let Some(stripe) = &self.stripe else { return Ok(None) };
        let card = stripe.card(customer).await?.map(|card| Card {
            brand: card.brand,
            last4: card.last4,
            exp_month: card.exp_month,
            exp_year: card.exp_year,
        });
        self.db
            .prepare(
                "UPDATE accounts SET card_brand = ?2, card_last4 = ?3, card_exp_month = ?4, card_exp_year = ?5,
                   card_synced_at = ?6 WHERE customer_id = ?1",
            )
            .bind(&[
                customer.into(),
                card.as_ref().map(|c| c.brand.clone()).into(),
                card.as_ref().map(|c| c.last4.clone()).into(),
                card.as_ref().map(|c| c.exp_month as f64).into(),
                card.as_ref().map(|c| c.exp_year as f64).into(),
                rfc3339(now_ms()).into(),
            ])?
            .run()
            .await?;
        Ok(card)
    }

    /// A card or customer event: the saved card read again. The event's
    /// outcome, for `stripe_events`.
    pub(crate) async fn sync_card_of(&self, customer: &str) -> Result<String> {
        if self.workspace_of_customer(customer).await?.is_none() {
            return Ok("ignored: not a workspace's customer".to_owned());
        }
        Ok(match self.fetch_card(customer).await? {
            Some(card) => format!("card saved: {} ending {}", card.brand, card.last4),
            None => "card saved: none".to_owned(),
        })
    }

    /// Forgets the saved card after g1t itself changed it, so the next
    /// read asks Stripe instead of waiting for the event.
    pub(crate) async fn forget_card(&self, workspace: &str) -> Result<()> {
        self.db
            .prepare("UPDATE accounts SET card_synced_at = NULL WHERE workspace = ?")
            .bind(&[workspace.into()])?
            .run()
            .await?;
        Ok(())
    }

    /// Handles events Stripe sent that billing never saw, from its event
    /// list. What happened, for the log.
    pub(crate) async fn replay_events(&self) -> Result<String> {
        let Some(stripe) = &self.stripe else { return Ok("payments are not set up".to_owned()) };
        #[derive(Deserialize)]
        struct Mark {
            through: i64,
        }
        #[derive(Deserialize)]
        struct Page {
            data: Vec<Value>,
            has_more: bool,
        }
        let mode = self.mode();
        let now = (now_ms() / 1000) as i64;
        // A claim whose handler died never finished: let it be handled again.
        self.db
            .prepare("DELETE FROM stripe_events WHERE outcome = 'handling' AND received_at < ?")
            .bind(&[rfc3339(now_ms().saturating_sub(STALE_CLAIM_MS)).into()])?
            .run()
            .await?;
        let previous = self
            .db
            .prepare("SELECT through FROM stripe_sync WHERE mode = ?")
            .bind(&[mode.into()])?
            .first::<Mark>(None)
            .await?
            .map_or(now - FIRST_LOOK_SECONDS, |mark| mark.through);
        let since = previous - OVERLAP_SECONDS;

        // Stripe lists newest first; read back to `since`.
        let mut listed: Vec<Value> = Vec::new();
        let mut complete = false;
        let mut after: Option<String> = None;
        for _ in 0..MAX_PAGES {
            let mut query: Vec<(&str, String)> = vec![("limit", "100".to_owned()), ("created[gte]", since.to_string())];
            query.extend(EVENTS.iter().map(|event| ("types[]", (*event).to_owned())));
            if let Some(after) = &after {
                query.push(("starting_after", after.clone()));
            }
            let page: Page = stripe.get(&format!("/events?{}", form(&query))).await?;
            after = page.data.last().and_then(|event| event["id"].as_str()).map(str::to_owned);
            listed.extend(page.data);
            if !page.has_more || after.is_none() {
                complete = true;
                break;
            }
        }
        if !complete {
            worker::console_error!("Stripe listed more than {} events since {since}; replaying the newest", MAX_PAGES * 100);
        }

        // Oldest first, as they happened.
        listed.sort_by_key(|event| event["created"].as_i64().unwrap_or(0));
        let mut handled = 0;
        let mut first_failed = None;
        for event in &listed {
            match self.process_event(event).await {
                Ok(true) => handled += 1,
                Ok(false) => {}
                Err(error) => {
                    let id = event["id"].as_str().unwrap_or_default();
                    worker::console_error!("replaying Stripe event {id} failed: {error}");
                    first_failed = first_failed.or(event["created"].as_i64());
                }
            }
        }
        let through = next_through(previous, now, first_failed, complete);
        self.db
            .prepare(
                "INSERT INTO stripe_sync (mode, through, checked_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT (mode) DO UPDATE SET through = ?2, checked_at = ?3",
            )
            .bind(&[mode.into(), (through as f64).into(), rfc3339(now_ms()).into()])?
            .run()
            .await?;
        Ok(format!("{} listed, {handled} not seen before and handled", listed.len()))
    }

    /// Keeps the destination at billing's address enabled and sending
    /// every event billing handles. Its signing secret is not touched.
    /// Nothing when Stripe has no destination there.
    pub(crate) async fn keep_endpoint(&self, by: &str) -> Result<String> {
        let (Some(stripe), Some(destination)) = (&self.stripe, self.destination().await?) else {
            return Ok(format!("no destination at {WEBHOOK_URL}"));
        };
        let path = format!("/webhook_endpoints/{}", destination.id);
        let mut fields: Vec<(String, String)> = Vec::new();
        let mut changes = Vec::new();
        if destination.status != "enabled" {
            fields.push(("disabled".to_owned(), "false".to_owned()));
            changes.push("enabled again".to_owned());
        }
        let missing = missing_events(&destination.enabled_events);
        if !missing.is_empty() {
            // Stripe replaces the list: what it sends now, plus what is missing.
            let all = destination.enabled_events.iter().cloned().chain(missing.iter().cloned());
            fields.extend(all.enumerate().map(|(i, event)| (format!("enabled_events[{i}]"), event)));
            changes.push(format!("added {}", missing.join(", ")));
        }
        if changes.is_empty() {
            return Ok("destination as it should be".to_owned());
        }
        let fields: Vec<(&str, String)> = fields.iter().map(|(name, value)| (name.as_str(), value.clone())).collect();
        let _: Value = stripe.post(&path, &fields).await?;
        let done = changes.join("; ");
        self.audit("stripe", "webhook", &format!("Destination {}: {done}", destination.id), by).await?;
        Ok(done)
    }

    /// Reads again the saved cards and plans not read in a while, a few a
    /// day, in case an event never came.
    pub(crate) async fn refresh_from_stripe(&self) -> Result<String> {
        if self.stripe.is_none() {
            return Ok("payments are not set up".to_owned());
        }
        #[derive(Deserialize)]
        struct Customer {
            customer_id: String,
        }
        #[derive(Deserialize)]
        struct Plan {
            subscription_id: String,
        }
        let card_cutoff = rfc3339(now_ms().saturating_sub(CARD_FRESH_DAYS * 24 * 60 * 60 * 1000));
        let customers = self
            .db
            .prepare(
                "SELECT DISTINCT customer_id FROM accounts
                 WHERE customer_id IS NOT NULL AND card_synced_at IS NOT NULL AND card_synced_at < ?1
                 ORDER BY card_synced_at LIMIT ?2",
            )
            .bind(&[card_cutoff.into(), REFRESH_BATCH.into()])?
            .all()
            .await?
            .results::<Customer>()?;
        let plan_cutoff = rfc3339(now_ms().saturating_sub(24 * 60 * 60 * 1000));
        let plans = self
            .db
            .prepare(
                "SELECT subscription_id FROM subscriptions WHERE status <> 'canceled' AND updated_at < ?1
                 ORDER BY updated_at LIMIT ?2",
            )
            .bind(&[plan_cutoff.into(), REFRESH_BATCH.into()])?
            .all()
            .await?
            .results::<Plan>()?;
        let mut failed = 0;
        for customer in &customers {
            if let Err(error) = self.fetch_card(&customer.customer_id).await {
                worker::console_error!("refreshing {}'s card failed: {error}", customer.customer_id);
                failed += 1;
            }
        }
        for plan in &plans {
            if let Err(error) = self.settle_subscription(&plan.subscription_id).await {
                worker::console_error!("refreshing plan {} failed: {error}", plan.subscription_id);
                failed += 1;
            }
        }
        Ok(format!("{} cards and {} plans read again, {failed} failed", customers.len(), plans.len()))
    }
}

fn card_of(row: &CardRow) -> Option<Card> {
    Some(Card {
        brand: row.card_brand.clone()?,
        last4: row.card_last4.clone()?,
        exp_month: row.card_exp_month?,
        exp_year: row.card_exp_year?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_replay_moves_on_only_past_what_it_handled() {
        let now = 1_791_000_000;
        // All handled: just behind the clock.
        assert_eq!(next_through(now - 900, now, None, true), now - SETTLE_SECONDS);
        // Never backwards.
        assert_eq!(next_through(now, now, None, true), now);
        // A failure: back to it, so it is listed again.
        assert_eq!(next_through(now - 900, now, Some(now - 600), true), now - 600);
        assert_eq!(next_through(now - 900, now, Some(now - 1200), true), now - 1200);
        // The list not read to its end: stay.
        assert_eq!(next_through(now - 900, now, None, false), now - 900);
    }

    #[test]
    fn a_card_needs_every_part() {
        let row = |brand: Option<&str>| CardRow {
            customer_id: Some("cus_1".into()),
            card_brand: brand.map(str::to_owned),
            card_last4: Some("4242".into()),
            card_exp_month: Some(12),
            card_exp_year: Some(2030),
            card_synced_at: Some("2026-10-06T00:00:00Z".into()),
        };
        assert_eq!(card_of(&row(Some("visa"))).map(|c| c.last4), Some("4242".into()));
        assert!(card_of(&row(None)).is_none());
    }
}
