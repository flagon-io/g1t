//! Provider cost reports per person, from the providers other than
//! Anthropic (whose Claude Code report is read in `provider_costs`): what
//! each says each person's use cost, by day, kept in
//! `provider_person_costs` and matched to members only when asked, through
//! addresses they have confirmed. Checked against each provider's
//! reference on 2026-10-22.
//!
//! - **OpenAI** (the admin key the cost report uses): the people of the
//!   organization from `GET /v1/organization/users` (`limit` 100, paged
//!   with `after`), for their addresses; then `GET /v1/organization/costs`
//!   grouped by `user_id` and `line_item`, dollars per day per user. Where
//!   the organization can't split its costs by user (a 400), its token
//!   counts instead: `GET /v1/organization/usage/completions` grouped by
//!   `user_id` and `model` (at most 31 days a page), priced at list price
//!   (`model_prices`) and marked so. OpenAI can't tell Codex from any
//!   other use of its API, so the harness is `openai`.
//! - **Cursor** (an Admin API key, Basic auth with the key as the user
//!   name): `POST https://api.cursor.com/teams/filtered-usage-events`, every
//!   request with its `userEmail`, `model`, `chargedCents` and
//!   `conversationId`; `startDate` and `endDate` in epoch milliseconds,
//!   both inclusive; `page` from 1, `pageSize` up to 1000, and 60 requests
//!   a minute. Read a week at a time, newest first. Each conversation's
//!   charge is kept per day (`provider_conversations`), so a session g1t
//!   recorded can be matched to what Cursor charged for it.
//! - **Amp** (an External API application's client ID and secret): a
//!   client-credentials token from `https://auth.ampcode.com/oauth2/token`
//!   with the workspace analytics and members scopes, then
//!   `GET https://ampcode.com/api/v2/workspace/analytics/daily-usage`
//!   (`endDate`, `lookbackDays` up to 365, no paging): each user's usage
//!   per day in US dollars, by model, orbs and tools besides.
//! - **Devin**, with a Devin service user key (`cog_…`):
//!   `GET https://api.devin.ai/v3/enterprise/members/users` for the
//!   addresses, then `GET /v3/enterprise/consumption/daily/users/{id}` for
//!   each, ACUs per day by product (Enterprise only). Its days run from
//!   midnight Pacific (08:00 UTC).
//! - **Devin Desktop** (Windsurf), with a Devin Desktop service key:
//!   `POST https://server.codeium.com/api/v1/UserPageAnalytics`, the key in
//!   the body, one day a call: each person's `promptCreditsUsed`, in
//!   hundredths of a credit (Enterprise only).
//!
//! Credits and ACUs are kept as they are, never turned into dollars.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use g1t_contracts::billing::{CostProvider, CostUnit};
use g1t_contracts::model_prices::ModelUsage;
use serde_json::{Value, json};
use worker::{Fetch, Headers, Method, Request, RequestInit};

use crate::provider_costs::{
    ActorKind, CLAUDE_CODE, DAY_MS, PersonCost, USER_AGENT, cents_to_micros, day_of, day_start, days_back, dollars_to_micros, encode,
    explain, text,
};

const OPENAI_USERS: &str = "https://api.openai.com/v1/organization/users";
const OPENAI_COSTS: &str = "https://api.openai.com/v1/organization/costs";
const OPENAI_COMPLETIONS: &str = "https://api.openai.com/v1/organization/usage/completions";
const CURSOR_EVENTS: &str = "https://api.cursor.com/teams/filtered-usage-events";
const AMP_TOKEN: &str = "https://auth.ampcode.com/oauth2/token";
const AMP_DAILY: &str = "https://ampcode.com/api/v2/workspace/analytics/daily-usage";
/// What g1t asks Amp's token for: the usage, and the addresses it is by.
const AMP_SCOPES: &str = "amp.api:workspace.analytics:view amp.api:workspace.members:view";
const DEVIN_API: &str = "https://api.devin.ai/v3/enterprise";
const WINDSURF_USERS: &str = "https://server.codeium.com/api/v1/UserPageAnalytics";

/// The most pages of one list read at once.
const MAX_PAGES: u32 = 20;
/// The most requests one read sends to Cursor: within its 60 a minute.
const CURSOR_REQUESTS: u32 = 40;
/// Days of Cursor's events asked for in one window.
const CURSOR_WINDOW_DAYS: usize = 7;
/// The most of Devin's people whose consumption one read asks for, a call
/// each.
const DEVIN_PEOPLE: usize = 100;
/// Devin's days start at midnight Pacific, 08:00 UTC.
const DEVIN_DAY_OFFSET_S: u64 = 8 * 60 * 60;
/// Days of Devin Desktop's report asked for at once, a call each.
const WINDSURF_AT_ONCE: usize = 4;

/// The harness of each provider's per-person rows, where the provider can
/// tell.
pub(crate) const OPENAI_HARNESS: &str = "openai";
pub(crate) const CURSOR_HARNESS: &str = "cursor";
pub(crate) const AMP_HARNESS: &str = "amp";
pub(crate) const DEVIN_HARNESS: &str = "devin";
pub(crate) const DEVIN_DESKTOP_HARNESS: &str = "devin_desktop";

/// One day's cost of one actor's use of one model (or product), as kept.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct PersonRow {
    pub day: String,
    pub kind: ActorKind,
    pub actor: String,
    pub harness: String,
    pub model: String,
    /// Millionths of `unit`.
    pub micros: i64,
    /// The actor's sessions (or conversations) that day for the harness,
    /// on its first model only.
    pub sessions: u32,
    pub customer_type: String,
    pub unit: CostUnit,
    pub list_price: bool,
}

impl PersonRow {
    /// A row of Anthropic's Claude Code report.
    pub fn claude_code(cost: PersonCost) -> PersonRow {
        PersonRow {
            day: cost.day,
            kind: cost.kind,
            actor: cost.actor,
            harness: CLAUDE_CODE.to_owned(),
            model: cost.model,
            micros: cost.micros,
            sessions: cost.sessions,
            customer_type: cost.customer_type,
            unit: CostUnit::Usd,
            list_price: false,
        }
    }
}

/// One conversation's charge on one day, as Cursor's events give it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ConversationRow {
    pub day: String,
    pub kind: ActorKind,
    pub actor: String,
    pub conversation: String,
    pub micros: i64,
    pub events: u32,
}

/// One charge as a provider gave it, before summing.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Charge {
    pub day: String,
    pub kind: ActorKind,
    pub actor: String,
    pub harness: String,
    pub model: String,
    pub micros: i64,
}

/// What one read of a per-person report found: the days it read in full,
/// which it replaces, and why it stopped, if it did. A read cut short
/// still keeps the days it read.
#[derive(Debug, Default)]
pub(crate) struct PeopleRead {
    pub days: Vec<String>,
    pub rows: Vec<PersonRow>,
    pub conversations: Vec<ConversationRow>,
    /// Something to say about a read that worked (more than g1t reads at
    /// once, models it can't price).
    pub note: Option<String>,
    /// Why the read failed; the days before it are still kept.
    pub problem: Option<String>,
}

/// The charges summed per day, actor, harness and model, in `unit`. Each
/// actor's day's sessions for a harness (`sessions`) go on its first
/// model by name. Charges of nothing are left out, unless the day has
/// sessions, which then keep one row with no model.
pub(crate) fn person_rows(
    charges: &[Charge],
    sessions: &BTreeMap<(String, ActorKind, String, String), u32>,
    unit: CostUnit,
    list_price: bool,
) -> Vec<PersonRow> {
    let mut sums: BTreeMap<(String, ActorKind, String, String), BTreeMap<String, i64>> = BTreeMap::new();
    for charge in charges {
        *sums
            .entry((charge.day.clone(), charge.kind, charge.actor.clone(), charge.harness.clone()))
            .or_default()
            .entry(charge.model.clone())
            .or_insert(0) += charge.micros;
    }
    for (key, count) in sessions {
        if *count > 0 {
            sums.entry(key.clone()).or_default();
        }
    }
    let mut rows = Vec::new();
    for (key, models) in sums {
        let count = sessions.get(&key).copied().unwrap_or(0);
        let mut models: Vec<(String, i64)> = models.into_iter().filter(|(_, micros)| *micros != 0).collect();
        if models.is_empty() {
            if count == 0 {
                continue;
            }
            models.push((String::new(), 0));
        }
        let (day, kind, actor, harness) = key;
        for (index, (model, micros)) in models.into_iter().enumerate() {
            rows.push(PersonRow {
                day: day.clone(),
                kind,
                actor: actor.clone(),
                harness: harness.clone(),
                model,
                micros,
                sessions: if index == 0 { count } else { 0 },
                customer_type: String::new(),
                unit,
                list_price,
            });
        }
    }
    rows
}

/// An address as kept: trimmed and lowercased, as identity matches them.
fn email(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(|email| email.trim().to_lowercase())
        .filter(|email| !email.is_empty())
}

/// A number of cents (a JSON number or a decimal string) in millionths of
/// a dollar.
fn cents(value: &Value) -> Option<i64> {
    match value {
        Value::Number(n) => cents_to_micros(&n.to_string()).or_else(|| dollars_to_micros(n.as_f64()? / 100.0)),
        Value::String(s) => cents_to_micros(s),
        _ => None,
    }
}

// --- OpenAI ---------------------------------------------------------------------

/// A page of the organization's people, from 0 or after the id `after`.
pub(crate) fn openai_users_url(after: Option<&str>) -> String {
    match after {
        Some(after) => format!("{OPENAI_USERS}?limit=100&after={}", encode(after)),
        None => format!("{OPENAI_USERS}?limit=100"),
    }
}

/// A page of OpenAI's users, as its reference has it: `data` holds
/// `organization.user` objects with `id` and `email` (which may be null);
/// `has_more` and `last_id` page on. Each user id and address, and the id
/// to read after.
pub(crate) fn parse_openai_users(body: &Value) -> Result<(Vec<(String, String)>, Option<String>), String> {
    let users = body["data"].as_array().ok_or("OpenAI's list of users had no data.")?;
    let found: Vec<(String, String)> = users
        .iter()
        .filter_map(|user| Some((user["id"].as_str()?.to_owned(), email(&user["email"])?)))
        .collect();
    let next = (body["has_more"].as_bool() == Some(true))
        .then(|| {
            body["last_id"]
                .as_str()
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
                .or_else(|| users.last().and_then(|user| user["id"].as_str()).map(str::to_owned))
        })
        .flatten();
    Ok((found, next))
}

/// OpenAI's costs from `from` (`YYYY-MM-DD`) to `until`, by day, user and
/// line item.
pub(crate) fn openai_user_costs_url(from: &str, until: u64, page: Option<&str>) -> String {
    let start = day_start(from).unwrap_or(0) / 1000;
    let mut url = format!(
        "{OPENAI_COSTS}?start_time={start}&end_time={}&bucket_width=1d&group_by=user_id&group_by=line_item&limit=180",
        until / 1000
    );
    if let Some(page) = page {
        url.push_str(&format!("&page={}", encode(page)));
    }
    url
}

/// OpenAI's token usage from `from` (`YYYY-MM-DD`) to `until`, by day,
/// user and model: 31 days a page at most.
pub(crate) fn openai_completions_url(from: &str, until: u64, page: Option<&str>) -> String {
    let start = day_start(from).unwrap_or(0) / 1000;
    let mut url = format!(
        "{OPENAI_COMPLETIONS}?start_time={start}&end_time={}&bucket_width=1d&group_by=user_id&group_by=model&limit=31",
        until / 1000
    );
    if let Some(page) = page {
        url.push_str(&format!("&page={}", encode(page)));
    }
    url
}

/// The person an OpenAI user id is: their address when the organization
/// lists one, else the id (which matches nobody).
fn openai_actor(user_id: &str, emails: &HashMap<String, String>) -> String {
    emails.get(user_id).cloned().unwrap_or_else(|| user_id.to_owned())
}

/// The model a line item is about: OpenAI's line items read like
/// `gpt-6-astra, input_tokens`.
pub(crate) fn line_item_model(item: &str) -> String {
    item.split(',').next().unwrap_or_default().trim().to_owned()
}

/// A page of OpenAI's costs grouped by user, as [`parse_openai`] reads the
/// organization's: the days it answered for, each user's charges (costs
/// with no user are the organization's only, and left out here), the
/// currencies other than US dollars left out, and the next page.
///
/// [`parse_openai`]: crate::provider_costs::parse_openai
pub(crate) fn parse_openai_user_costs(
    body: &Value,
    emails: &HashMap<String, String>,
) -> Result<(Vec<String>, Vec<Charge>, BTreeSet<String>, Option<String>), String> {
    let buckets = body["data"].as_array().ok_or("OpenAI's costs had no data.")?;
    let (mut days, mut charges, mut other) = (Vec::new(), Vec::new(), BTreeSet::new());
    for bucket in buckets {
        let start = bucket["start_time"]
            .as_u64()
            .ok_or("A bucket in OpenAI's costs had no start.")?;
        let day = day_of(start * 1000);
        let results = bucket["results"].as_array().or_else(|| bucket["result"].as_array());
        for result in results.into_iter().flatten() {
            let Some(user) = result["user_id"].as_str().filter(|id| !id.is_empty()) else {
                continue;
            };
            let value = result["amount"]["value"]
                .as_f64()
                .ok_or("A cost in OpenAI's report had no amount.")?;
            let currency = result["amount"]["currency"].as_str().unwrap_or("usd");
            if !currency.eq_ignore_ascii_case("usd") {
                other.insert(currency.to_uppercase());
                continue;
            }
            charges.push(Charge {
                day: day.clone(),
                kind: ActorKind::User,
                actor: openai_actor(user, emails),
                harness: OPENAI_HARNESS.to_owned(),
                model: line_item_model(&text(&result["line_item"])),
                micros: dollars_to_micros(value).ok_or("OpenAI reported an amount g1t can't read.")?,
            });
        }
        days.push(day);
    }
    Ok((days, charges, other, next_page(body)))
}

/// A page of OpenAI's completions usage grouped by user and model, as its
/// reference has it: each result's `input_tokens` (cached and cache-write
/// tokens included), `input_cached_tokens`, `input_cache_write_tokens`
/// (absent on older responses) and `output_tokens`, priced at list price.
/// The days, the charges, the models g1t has no price for (their use is
/// left out), and the next page.
pub(crate) fn parse_openai_completions(
    body: &Value,
    emails: &HashMap<String, String>,
) -> Result<(Vec<String>, Vec<Charge>, BTreeSet<String>, Option<String>), String> {
    let buckets = body["data"].as_array().ok_or("OpenAI's usage had no data.")?;
    let (mut days, mut charges, mut unpriced) = (Vec::new(), Vec::new(), BTreeSet::new());
    for bucket in buckets {
        let start = bucket["start_time"]
            .as_u64()
            .ok_or("A bucket in OpenAI's usage had no start.")?;
        let day = day_of(start * 1000);
        let results = bucket["results"].as_array().or_else(|| bucket["result"].as_array());
        for result in results.into_iter().flatten() {
            let Some(user) = result["user_id"].as_str().filter(|id| !id.is_empty()) else {
                continue;
            };
            let model = text(&result["model"]);
            let count = |key: &str| result[key].as_u64().unwrap_or(0);
            let (input, cached, written) = (
                count("input_tokens"),
                count("input_cached_tokens"),
                count("input_cache_write_tokens"),
            );
            let usage = ModelUsage {
                model: model.clone(),
                tier: None,
                input_tokens: input.saturating_sub(cached).saturating_sub(written),
                output_tokens: count("output_tokens"),
                // OpenAI's cache writes are priced as 30-minute ones.
                cache_write_5m_tokens: written,
                cache_write_1h_tokens: 0,
                cache_read_tokens: cached,
            };
            if input == 0 && usage.output_tokens == 0 {
                continue;
            }
            let Some(usd) = usage.cost_usd() else {
                unpriced.insert(if model.is_empty() { "a model OpenAI didn't name".to_owned() } else { model });
                continue;
            };
            charges.push(Charge {
                day: day.clone(),
                kind: ActorKind::User,
                actor: openai_actor(user, emails),
                harness: OPENAI_HARNESS.to_owned(),
                model,
                micros: dollars_to_micros(usd).unwrap_or(0),
            });
        }
        days.push(day);
    }
    Ok((days, charges, unpriced, next_page(body)))
}

fn next_page(body: &Value) -> Option<String> {
    (body["has_more"].as_bool() == Some(true))
        .then(|| body["next_page"].as_str().filter(|s| !s.is_empty()).map(str::to_owned))
        .flatten()
}

// --- Cursor ---------------------------------------------------------------------

/// One request in Cursor's usage events, as kept.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct CursorEvent {
    pub day: String,
    pub kind: ActorKind,
    pub actor: String,
    pub model: String,
    /// What Cursor charged for it, included usage too.
    pub micros: i64,
    pub conversation: Option<String>,
}

/// A request for one page of Cursor's usage events from `start` to `end`
/// (epoch milliseconds, both inclusive).
pub(crate) fn cursor_body(start: u64, end: u64, page: u32, page_size: u32) -> String {
    json!({ "startDate": start, "endDate": end, "page": page, "pageSize": page_size }).to_string()
}

/// A page of Cursor's usage events, as its reference has it: `usageEvents`
/// with `timestamp` (epoch milliseconds, as a string), `userEmail`,
/// `model`, `chargedCents` (what the team is charged for it, included
/// usage too) and `conversationId` (left out for events of no
/// conversation); a service account's events name it instead of a person.
/// The events, and whether there is a next page.
pub(crate) fn parse_cursor(body: &Value) -> Result<(Vec<CursorEvent>, bool), String> {
    let events = body["usageEvents"]
        .as_array()
        .ok_or("Cursor's usage events had no usageEvents.")?;
    let mut found = Vec::new();
    for event in events {
        let at = match &event["timestamp"] {
            Value::String(s) => s.trim().parse::<u64>().ok(),
            Value::Number(n) => n.as_u64(),
            _ => None,
        }
        .ok_or("An event in Cursor's usage had no time.")?;
        let (kind, actor) = match (email(&event["userEmail"]), event["serviceAccountName"].as_str()) {
            (Some(address), _) => (ActorKind::User, address),
            (None, Some(name)) if !name.trim().is_empty() => (ActorKind::ApiKey, name.trim().to_owned()),
            _ => continue,
        };
        let micros = match &event["chargedCents"] {
            Value::Null => 0,
            value => cents(value).ok_or_else(|| format!("Cursor reported a charge g1t can't read: {value}"))?,
        };
        found.push(CursorEvent {
            day: day_of(at),
            kind,
            actor,
            model: text(&event["model"]),
            micros,
            conversation: event["conversationId"]
                .as_str()
                .filter(|id| !id.is_empty())
                .map(str::to_owned),
        });
    }
    Ok((found, body["pagination"]["hasNextPage"].as_bool() == Some(true)))
}

/// The windows a read of Cursor's events asks for, newest first: each a
/// week (or what is left of the span) of whole days, its first and last
/// instants (epoch milliseconds, both inclusive) and its days.
pub(crate) fn cursor_windows(from: &str, until: u64) -> Vec<(u64, u64, Vec<String>)> {
    days_back(from, until)
        .chunks(CURSOR_WINDOW_DAYS)
        .filter_map(|days| {
            let last = day_start(days.first()?)?;
            let first = day_start(days.last()?)?;
            Some((first, last + DAY_MS - 1, days.to_vec()))
        })
        .collect()
}

/// Cursor's events summed per day, actor and model, with each actor's
/// conversations that day as its sessions, and each conversation's charge.
pub(crate) fn cursor_people(events: &[CursorEvent]) -> (Vec<PersonRow>, Vec<ConversationRow>) {
    let mut charges = Vec::new();
    let mut conversations: BTreeMap<(String, ActorKind, String, String), (i64, u32)> = BTreeMap::new();
    for event in events {
        charges.push(Charge {
            day: event.day.clone(),
            kind: event.kind,
            actor: event.actor.clone(),
            harness: CURSOR_HARNESS.to_owned(),
            model: event.model.clone(),
            micros: event.micros,
        });
        if let Some(conversation) = &event.conversation {
            let sums = conversations
                .entry((event.day.clone(), event.kind, event.actor.clone(), conversation.clone()))
                .or_insert((0, 0));
            sums.0 += event.micros;
            sums.1 += 1;
        }
    }
    let mut sessions: BTreeMap<(String, ActorKind, String, String), u32> = BTreeMap::new();
    for (day, kind, actor, _) in conversations.keys() {
        *sessions
            .entry((day.clone(), *kind, actor.clone(), CURSOR_HARNESS.to_owned()))
            .or_insert(0) += 1;
    }
    let rows = person_rows(&charges, &sessions, CostUnit::Usd, false);
    let conversations = conversations
        .into_iter()
        .map(|((day, kind, actor, conversation), (micros, events))| ConversationRow {
            day,
            kind,
            actor,
            conversation,
            micros,
            events,
        })
        .collect();
    (rows, conversations)
}

// --- Amp ------------------------------------------------------------------------

/// The application's client ID and secret, from the credential
/// `id:secret`.
pub(crate) fn amp_client(credential: &str) -> Option<(&str, &str)> {
    let (id, secret) = credential.split_once(':')?;
    (!id.is_empty() && !secret.is_empty()).then_some((id, secret))
}

/// The form that asks Amp for a client-credentials token.
pub(crate) fn amp_token_form(id: &str, secret: &str) -> String {
    format!(
        "grant_type=client_credentials&client_id={}&client_secret={}&scope={}",
        encode(id),
        encode(secret),
        encode(AMP_SCOPES)
    )
}

/// Amp's daily usage for the `days` days to `last` (`YYYY-MM-DD`), last
/// included.
pub(crate) fn amp_daily_url(last: &str, days: usize) -> String {
    format!("{AMP_DAILY}?endDate={last}&lookbackDays={}", days.clamp(1, 365))
}

/// Amp's daily usage, as its reference has it: `data` holds a day each
/// (`date`) with its `users`, each with `user.id`, `user.email` (given
/// with the members scope), `metrics.usage` (US dollars, orbs and tools
/// included) and `models`, each model's `usage`. A charge per model, and
/// what the day's usage holds beyond its models (orbs, tools) with no
/// model. The days answered for come back too.
pub(crate) fn parse_amp(body: &Value) -> Result<(Vec<String>, Vec<Charge>), String> {
    let days = body["data"].as_array().ok_or("Amp's daily usage had no data.")?;
    let (mut answered, mut charges) = (Vec::new(), Vec::new());
    for entry in days {
        let day = entry["date"]
            .as_str()
            .filter(|s| s.len() >= 10)
            .ok_or("A day in Amp's usage had no date.")?[..10]
            .to_owned();
        for user in entry["users"].as_array().into_iter().flatten() {
            let Some(actor) = email(&user["user"]["email"]).or_else(|| {
                user["user"]["id"]
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .map(str::to_owned)
            }) else {
                continue;
            };
            let total = dollars_to_micros(user["metrics"]["usage"].as_f64().unwrap_or(0.0)).unwrap_or(0);
            let mut models = 0i64;
            if let Some(by_model) = user["models"].as_object() {
                for (model, use_) in by_model {
                    let micros = dollars_to_micros(use_["usage"].as_f64().unwrap_or(0.0)).unwrap_or(0);
                    models += micros;
                    charges.push(Charge {
                        day: day.clone(),
                        kind: ActorKind::User,
                        actor: actor.clone(),
                        harness: AMP_HARNESS.to_owned(),
                        model: model.clone(),
                        micros,
                    });
                }
            }
            if total > models {
                charges.push(Charge {
                    day: day.clone(),
                    kind: ActorKind::User,
                    actor,
                    harness: AMP_HARNESS.to_owned(),
                    model: String::new(),
                    micros: total - models,
                });
            }
        }
        answered.push(day);
    }
    Ok((answered, charges))
}

// --- Devin ----------------------------------------------------------------------

/// Whether a Devin credential is a Devin service user key (ACUs), rather
/// than a Devin Desktop service key (credits).
pub(crate) fn devin_cloud(credential: &str) -> bool {
    credential.starts_with("cog_")
}

/// A page of the enterprise's members, after the cursor `after`.
pub(crate) fn devin_members_url(after: Option<&str>, first: u32) -> String {
    match after {
        Some(after) => format!("{DEVIN_API}/members/users?first={first}&after={}", encode(after)),
        None => format!("{DEVIN_API}/members/users?first={first}"),
    }
}

/// A page of Devin's members, as its reference has it: `items` with
/// `user_id` and `email`, paged by `end_cursor` while `has_next_page`.
pub(crate) fn parse_devin_members(body: &Value) -> Result<(Vec<(String, String)>, Option<String>), String> {
    let items = body["items"].as_array().ok_or("Devin's list of members had no items.")?;
    let found = items
        .iter()
        .filter_map(|user| Some((user["user_id"].as_str()?.to_owned(), email(&user["email"])?)))
        .collect();
    let next = (body["has_next_page"].as_bool() == Some(true))
        .then(|| body["end_cursor"].as_str().filter(|s| !s.is_empty()).map(str::to_owned))
        .flatten();
    Ok((found, next))
}

/// One person's consumption from `from` (`YYYY-MM-DD`) to `until`, in
/// Devin's days (from 08:00 UTC), Unix seconds.
pub(crate) fn devin_consumption_url(user_id: &str, from: &str, until: u64) -> String {
    let after = day_start(from).unwrap_or(0) / 1000 + DEVIN_DAY_OFFSET_S;
    let before = until / 1000 + DEVIN_DAY_OFFSET_S;
    format!(
        "{DEVIN_API}/consumption/daily/users/{}?time_after={after}&time_before={before}",
        encode(user_id)
    )
}

/// The harness each of Devin's products is: Devin Desktop's agent
/// (`cascade`) is billed in ACUs too on an ACU account.
fn devin_product_harness(product: &str) -> &'static str {
    match product {
        "cascade" => DEVIN_DESKTOP_HARNESS,
        _ => DEVIN_HARNESS,
    }
}

/// One person's daily consumption, as Devin's reference has it:
/// `consumption_by_date` with each day's `date` (a Unix time at the
/// start of Devin's day; read as milliseconds if it is that large) and
/// `acus_by_product` (`devin`, `cascade`, `terminal`, `automation`,
/// `review`), which add up to the day's `acus`. A charge per product, in
/// millionths of an ACU.
pub(crate) fn parse_devin_consumption(body: &Value, actor: &str) -> Result<Vec<Charge>, String> {
    let days = body["consumption_by_date"]
        .as_array()
        .ok_or("Devin's consumption had no days.")?;
    let mut charges = Vec::new();
    for entry in days {
        let at = entry["date"].as_u64().ok_or("A day in Devin's consumption had no date.")?;
        let day = day_of(if at > 100_000_000_000 { at } else { at * 1000 });
        let products = entry["acus_by_product"].as_object();
        let mut named = 0i64;
        for (product, acus) in products.into_iter().flatten() {
            let micros = dollars_to_micros(acus.as_f64().unwrap_or(0.0)).unwrap_or(0);
            if micros == 0 {
                continue;
            }
            named += micros;
            charges.push(Charge {
                day: day.clone(),
                kind: ActorKind::User,
                actor: actor.to_owned(),
                harness: devin_product_harness(product).to_owned(),
                model: product.clone(),
                micros,
            });
        }
        let total = dollars_to_micros(entry["acus"].as_f64().unwrap_or(0.0)).unwrap_or(0);
        if total > named {
            charges.push(Charge {
                day,
                kind: ActorKind::User,
                actor: actor.to_owned(),
                harness: DEVIN_HARNESS.to_owned(),
                model: String::new(),
                micros: total - named,
            });
        }
    }
    Ok(charges)
}

/// A request for Devin Desktop's people's use over one day (`YYYY-MM-DD`):
/// its hours, each counted when it starts in the range.
pub(crate) fn windsurf_body(credential: &str, day: &str) -> String {
    json!({
        "service_key": credential,
        "start_timestamp": format!("{day}T00:00:00Z"),
        "end_timestamp": format!("{day}T23:59:59Z"),
    })
    .to_string()
}

/// Devin Desktop's people over one day, as its reference has it:
/// `userTableStats` with `email` and `promptCreditsUsed`, in hundredths of
/// a credit, for the range asked for. A charge per person who used any, in
/// millionths of a credit.
pub(crate) fn parse_windsurf(body: &Value, day: &str) -> Result<Vec<Charge>, String> {
    let users = body["userTableStats"]
        .as_array()
        .ok_or("Devin Desktop's analytics had no userTableStats.")?;
    let mut charges = Vec::new();
    for user in users {
        let Some(actor) = email(&user["email"]) else {
            continue;
        };
        let hundredths = match &user["promptCreditsUsed"] {
            Value::Number(n) => n.as_f64().unwrap_or(0.0),
            Value::String(s) => s.trim().parse::<f64>().unwrap_or(0.0),
            _ => 0.0,
        };
        let micros = dollars_to_micros(hundredths / 100.0).unwrap_or(0);
        if micros == 0 {
            continue;
        }
        charges.push(Charge {
            day: day.to_owned(),
            kind: ActorKind::User,
            actor,
            harness: DEVIN_DESKTOP_HARNESS.to_owned(),
            model: String::new(),
            micros,
        });
    }
    Ok(charges)
}

// --- Requests -------------------------------------------------------------------

/// `user:` in Basic auth's base64, as Cursor takes its key.
pub(crate) fn basic(user: &str) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes = format!("{user}:").into_bytes();
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for (index, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            out.push(if index <= chunk.len() {
                ALPHABET[((n >> shift) & 63) as usize] as char
            } else {
                '='
            });
        }
    }
    format!("Basic {out}")
}

/// One request to a provider: the status and the body, or why it could
/// not be sent. Never the error itself: it could carry the request.
pub(crate) async fn fetch_json(
    provider: CostProvider,
    method: Method,
    url: &str,
    authorization: Option<&str>,
    body: Option<(&str, String)>,
) -> Result<(u16, Value), String> {
    let sent = async {
        let headers = Headers::new();
        if let Some(authorization) = authorization {
            headers.set("authorization", authorization)?;
        }
        headers.set("user-agent", USER_AGENT)?;
        headers.set("accept", "application/json")?;
        let mut init = RequestInit::new();
        if let Some((content_type, body)) = body {
            headers.set("content-type", content_type)?;
            init.with_body(Some(body.into()));
        }
        init.with_method(method).with_headers(headers);
        let mut response = Fetch::Request(Request::new_with_init(url, &init)?).send().await?;
        let status = response.status_code();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        Ok::<_, worker::Error>((status, body))
    };
    sent.await.map_err(|_| {
        format!(
            "g1t couldn't reach {}. It tries again at the next daily read.",
            provider.label()
        )
    })
}

/// A request that must answer 200: its body, or why not, key scrubbed.
async fn ask(
    provider: CostProvider,
    credential: &str,
    method: Method,
    url: &str,
    authorization: Option<&str>,
    body: Option<(&str, String)>,
) -> Result<(u16, Value), String> {
    let (status, answer) = fetch_json(provider, method, url, authorization, body).await?;
    if status == 200 {
        Ok((status, answer))
    } else {
        Err(explain(provider, status, &answer, credential))
    }
}

/// An Amp token for the application, or why not.
async fn amp_token(credential: &str) -> Result<String, String> {
    let Some((id, secret)) = amp_client(credential) else {
        return Err("Paste the Amp application's client ID and client secret.".to_owned());
    };
    let (status, body) = fetch_json(
        CostProvider::Amp,
        Method::Post,
        AMP_TOKEN,
        None,
        Some(("application/x-www-form-urlencoded", amp_token_form(id, secret))),
    )
    .await?;
    match body["access_token"].as_str() {
        Some(token) if status == 200 && !token.is_empty() => Ok(token.to_owned()),
        _ => Err(explain(CostProvider::Amp, if status == 200 { 401 } else { status }, &body, credential)),
    }
}

/// The smallest request that proves a key can read the provider's
/// per-person report, for the providers with no cost report of their own.
pub(crate) async fn check(provider: CostProvider, credential: &str, now: u64) -> Result<(), String> {
    let today = now - now % DAY_MS;
    let yesterday = day_of(today - DAY_MS);
    match provider {
        CostProvider::Cursor => {
            ask(
                provider,
                credential,
                Method::Post,
                CURSOR_EVENTS,
                Some(&basic(credential)),
                Some(("application/json", cursor_body(today - DAY_MS, today - 1, 1, 1))),
            )
            .await?;
        }
        CostProvider::Amp => {
            let token = amp_token(credential).await?;
            let (_, body) = ask(
                provider,
                credential,
                Method::Get,
                &amp_daily_url(&yesterday, 1),
                Some(&format!("Bearer {token}")),
                None,
            )
            .await?;
            parse_amp(&body)?;
        }
        CostProvider::Devin if devin_cloud(credential) => {
            let (_, body) = ask(
                provider,
                credential,
                Method::Get,
                &devin_members_url(None, 1),
                Some(&format!("Bearer {credential}")),
                None,
            )
            .await?;
            parse_devin_members(&body)?;
        }
        CostProvider::Devin => {
            let (_, body) = ask(
                provider,
                credential,
                Method::Post,
                WINDSURF_USERS,
                None,
                Some(("application/json", windsurf_body(credential, &yesterday))),
            )
            .await?;
            parse_windsurf(&body, &yesterday)?;
        }
        CostProvider::Anthropic | CostProvider::Openai => {}
    }
    Ok(())
}

/// Reads a provider's per-person report from `from` (`YYYY-MM-DD`) to
/// `until`: every provider but Anthropic, whose report `provider_costs`
/// reads.
pub(crate) async fn read_people(provider: CostProvider, credential: &str, from: &str, until: u64) -> PeopleRead {
    match provider {
        CostProvider::Openai => read_openai(credential, from, until).await,
        CostProvider::Cursor => read_cursor(credential, from, until).await,
        CostProvider::Amp => read_amp(credential, from, until).await,
        CostProvider::Devin if devin_cloud(credential) => read_devin(credential, from, until).await,
        CostProvider::Devin => read_windsurf(credential, from, until).await,
        CostProvider::Anthropic => PeopleRead::default(),
    }
}

fn failed(problem: String) -> PeopleRead {
    PeopleRead { problem: Some(problem), ..PeopleRead::default() }
}

async fn read_openai(credential: &str, from: &str, until: u64) -> PeopleRead {
    let bearer = format!("Bearer {credential}");
    let provider = CostProvider::Openai;
    // Who each user id is.
    let mut emails = HashMap::new();
    let mut after: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let body = match ask(provider, credential, Method::Get, &openai_users_url(after.as_deref()), Some(&bearer), None).await {
            Ok((_, body)) => body,
            Err(problem) => return failed(problem),
        };
        match parse_openai_users(&body) {
            Ok((users, next)) => {
                emails.extend(users);
                match next {
                    Some(next) => after = Some(next),
                    None => break,
                }
            }
            Err(problem) => return failed(problem),
        }
    }
    // Costs by user, where the organization can split them; else tokens.
    let mut days = BTreeSet::new();
    let mut charges = Vec::new();
    let mut page: Option<String> = None;
    let mut list_price = false;
    let mut left_out = BTreeSet::new();
    for index in 0..MAX_PAGES {
        let url = if list_price {
            openai_completions_url(from, until, page.as_deref())
        } else {
            openai_user_costs_url(from, until, page.as_deref())
        };
        let (status, body) = match fetch_json(provider, Method::Get, &url, Some(&bearer), None).await {
            Ok(answer) => answer,
            Err(problem) => return failed(problem),
        };
        if status == 400 && index == 0 && !list_price {
            list_price = true;
            continue;
        }
        if status != 200 {
            return failed(explain(provider, status, &body, credential));
        }
        let parsed = if list_price {
            parse_openai_completions(&body, &emails)
        } else {
            parse_openai_user_costs(&body, &emails)
        };
        let (answered, found, other, next) = match parsed {
            Ok(page) => page,
            Err(problem) => return failed(problem),
        };
        days.extend(answered);
        charges.extend(found);
        left_out.extend(other);
        match next {
            Some(next) => page = Some(next),
            None => {
                page = None;
                break;
            }
        }
    }
    let note = if page.is_some() {
        Some("OpenAI had more pages than g1t reads at once; the earliest days may be missing.".to_owned())
    } else if left_out.is_empty() {
        None
    } else if list_price {
        Some(format!(
            "g1t has no list price for {}, so their use isn't counted.",
            left_out.into_iter().collect::<Vec<_>>().join(", ")
        ))
    } else {
        Some(format!(
            "Some costs were reported in {}, not US dollars, and are left out.",
            left_out.into_iter().collect::<Vec<_>>().join(", ")
        ))
    };
    PeopleRead {
        days: days.into_iter().collect(),
        rows: person_rows(&charges, &BTreeMap::new(), CostUnit::Usd, list_price),
        conversations: Vec::new(),
        note,
        problem: None,
    }
}

async fn read_cursor(credential: &str, from: &str, until: u64) -> PeopleRead {
    let provider = CostProvider::Cursor;
    let authorization = basic(credential);
    let mut sent = 0u32;
    let mut days = Vec::new();
    let mut events = Vec::new();
    let mut note = None;
    'windows: for (start, end, window) in cursor_windows(from, until) {
        let mut found = Vec::new();
        let mut page = 1u32;
        loop {
            if sent == CURSOR_REQUESTS {
                note = Some("Cursor had more usage than g1t reads at once; the earliest days may be missing.".to_owned());
                break 'windows;
            }
            sent += 1;
            let body = Some(("application/json", cursor_body(start, end, page, 1000)));
            let answer = match ask(provider, credential, Method::Post, CURSOR_EVENTS, Some(&authorization), body).await {
                Ok((_, answer)) => answer,
                Err(problem) => {
                    let (rows, conversations) = cursor_people(&events);
                    return PeopleRead { days, rows, conversations, note: None, problem: Some(problem) };
                }
            };
            match parse_cursor(&answer) {
                Ok((page_events, more)) => {
                    found.extend(page_events);
                    if !more {
                        break;
                    }
                    page += 1;
                }
                Err(problem) => {
                    let (rows, conversations) = cursor_people(&events);
                    return PeopleRead { days, rows, conversations, note: None, problem: Some(problem) };
                }
            }
        }
        // Only a window read to its last page replaces its days.
        let window: BTreeSet<&String> = window.iter().collect();
        events.extend(found.into_iter().filter(|event| window.contains(&event.day)));
        days.extend(window.into_iter().cloned());
    }
    let (rows, conversations) = cursor_people(&events);
    PeopleRead { days, rows, conversations, note, problem: None }
}

async fn read_amp(credential: &str, from: &str, until: u64) -> PeopleRead {
    let provider = CostProvider::Amp;
    let wanted = days_back(from, until);
    let Some(last) = wanted.first() else {
        return PeopleRead::default();
    };
    let token = match amp_token(credential).await {
        Ok(token) => token,
        Err(problem) => return failed(problem),
    };
    let url = amp_daily_url(last, wanted.len());
    let body = match ask(provider, credential, Method::Get, &url, Some(&format!("Bearer {token}")), None).await {
        Ok((_, body)) => body,
        Err(problem) => return failed(problem),
    };
    match parse_amp(&body) {
        // Every day asked for is answered, a day with no use as nothing.
        Ok((_, charges)) => PeopleRead {
            days: wanted.clone(),
            rows: person_rows(
                &charges.into_iter().filter(|c| wanted.contains(&c.day)).collect::<Vec<_>>(),
                &BTreeMap::new(),
                CostUnit::Usd,
                false,
            ),
            ..PeopleRead::default()
        },
        Err(problem) => failed(problem),
    }
}

async fn read_devin(credential: &str, from: &str, until: u64) -> PeopleRead {
    let provider = CostProvider::Devin;
    let bearer = format!("Bearer {credential}");
    let mut people = Vec::new();
    let mut after: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let url = devin_members_url(after.as_deref(), 200);
        let body = match ask(provider, credential, Method::Get, &url, Some(&bearer), None).await {
            Ok((_, body)) => body,
            Err(problem) => return failed(problem),
        };
        match parse_devin_members(&body) {
            Ok((found, next)) => {
                people.extend(found);
                match next {
                    Some(next) => after = Some(next),
                    None => break,
                }
            }
            Err(problem) => return failed(problem),
        }
    }
    let note = (people.len() > DEVIN_PEOPLE).then(|| {
        format!("Devin has more people than g1t reads at once: the first {DEVIN_PEOPLE} are read.")
    });
    let wanted = days_back(from, until);
    let mut charges = Vec::new();
    for chunk in people.chunks(4).take(DEVIN_PEOPLE.div_ceil(4)) {
        let answers = futures_util::future::join_all(chunk.iter().map(|(id, address)| {
            let url = devin_consumption_url(id, from, until);
            let bearer = bearer.clone();
            async move {
                let (_, body) = ask(provider, credential, Method::Get, &url, Some(&bearer), None).await?;
                parse_devin_consumption(&body, address)
            }
        }))
        .await;
        for answer in answers {
            match answer {
                Ok(found) => charges.extend(found),
                Err(problem) => return failed(problem),
            }
        }
    }
    PeopleRead {
        rows: person_rows(
            &charges.into_iter().filter(|c| wanted.contains(&c.day)).collect::<Vec<_>>(),
            &BTreeMap::new(),
            CostUnit::Acus,
            false,
        ),
        days: wanted,
        note,
        ..PeopleRead::default()
    }
}

async fn read_windsurf(credential: &str, from: &str, until: u64) -> PeopleRead {
    let provider = CostProvider::Devin;
    let mut days = Vec::new();
    let mut charges = Vec::new();
    let mut problem = None;
    for chunk in days_back(from, until).chunks(WINDSURF_AT_ONCE) {
        let answers = futures_util::future::join_all(chunk.iter().map(|day| async move {
            let body = Some(("application/json", windsurf_body(credential, day)));
            let (_, answer) = ask(provider, credential, Method::Post, WINDSURF_USERS, None, body).await?;
            parse_windsurf(&answer, day)
        }))
        .await;
        for (day, answer) in chunk.iter().zip(answers) {
            match answer {
                Ok(found) => {
                    days.push(day.clone());
                    charges.extend(found);
                }
                Err(message) => {
                    problem.get_or_insert(message);
                }
            }
        }
        if problem.is_some() {
            break;
        }
    }
    PeopleRead {
        days,
        rows: person_rows(&charges, &BTreeMap::new(), CostUnit::Credits, false),
        conversations: Vec::new(),
        note: None,
        problem,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider_costs::{
        ACTOR_TOTALS, DELETE_CONVERSATION_DAY, PERSON_DAYS, UPSERT_CONVERSATION, UPSERT_COST_IN, UPSERT_PERSON_COST,
        organization_days,
    };
    use g1t_contracts::time::{parse_rfc3339, rfc3339};

    /// The response example for GET /v1/organization/users in OpenAI's
    /// OpenAPI description (github.com/openai/openai-openapi).
    const OPENAI_USERS_EXAMPLE: &str = r#"{
        "object": "list",
        "data": [
            {
                "object": "organization.user",
                "id": "user_abc",
                "name": "First Last",
                "email": "user@example.com",
                "role": "owner",
                "added_at": 1711471533
            }
        ],
        "first_id": "user-abc",
        "last_id": "user-xyz",
        "has_more": false
    }"#;

    /// The response example for GET /v1/organization/usage/completions in
    /// OpenAI's OpenAPI description, grouped (`user_id` and `model` set,
    /// as the schema's own example has them).
    const OPENAI_COMPLETIONS_EXAMPLE: &str = r#"{
        "object": "page",
        "data": [
            {
                "object": "bucket",
                "start_time": 1730419200,
                "end_time": 1730505600,
                "results": [
                    {
                        "object": "organization.usage.completions.result",
                        "input_tokens": 1000,
                        "input_cached_tokens": 400,
                        "input_cache_write_tokens": 100,
                        "output_tokens": 500,
                        "input_audio_tokens": 50,
                        "output_audio_tokens": 50,
                        "num_model_requests": 5,
                        "project_id": null,
                        "user_id": "user_abc",
                        "api_key_id": null,
                        "model": "gpt-6-astra",
                        "batch": null,
                        "service_tier": null
                    }
                ]
            }
        ],
        "has_more": true,
        "next_page": "page_AAAAAGdGxdEiJdKOAAAAAGcqsYA="
    }"#;

    /// The response example for POST /teams/filtered-usage-events in
    /// Cursor's Admin API reference (cursor.com/docs/account/teams/admin-api).
    const CURSOR_EXAMPLE: &str = r#"{
      "totalUsageEventsCount": 113,
      "pagination": { "numPages": 5, "currentPage": 1, "pageSize": 25, "hasNextPage": true, "hasPreviousPage": false },
      "usageEvents": [
        {
          "timestamp": "1750979225854",
          "userEmail": "developer@company.com",
          "conversationId": "8f2e4a1b-6c3d-4e5f-9a7b-2d1c8e6f4a3b",
          "model": "claude-4.5-sonnet",
          "kind": "Usage-based",
          "maxMode": true,
          "requestsCosts": 5,
          "isTokenBasedCall": true,
          "isChargeable": true,
          "isHeadless": false,
          "tokenUsage": { "inputTokens": 126, "outputTokens": 450, "cacheWriteTokens": 6112, "cacheReadTokens": 11964, "totalCents": 20.18232 },
          "chargedCents": 21.36232,
          "cursorTokenFee": 1.18
        },
        {
          "timestamp": "1750979173824",
          "userEmail": "developer@company.com",
          "conversationId": "8f2e4a1b-6c3d-4e5f-9a7b-2d1c8e6f4a3b",
          "model": "claude-4.5-sonnet",
          "kind": "Usage-based",
          "maxMode": true,
          "requestsCosts": 10,
          "isTokenBasedCall": true,
          "isChargeable": true,
          "isHeadless": false,
          "tokenUsage": { "inputTokens": 5805, "outputTokens": 311, "cacheWriteTokens": 11964, "cacheReadTokens": 0, "totalCents": 40.167, "discountPercentOff": 10 },
          "chargedCents": 37.33,
          "cursorTokenFee": 1.18
        },
        {
          "timestamp": "1750978339901",
          "userEmail": "admin@company.com",
          "model": "claude-4-sonnet-thinking",
          "kind": "Included in Business",
          "maxMode": true,
          "requestsCosts": 1.4,
          "isTokenBasedCall": false,
          "isChargeable": false,
          "isHeadless": false,
          "chargedCents": 8
        }
      ],
      "period": { "startDate": 1748411762359, "endDate": 1751003762359 }
    }"#;

    /// Amp's daily-usage response, shaped as its External API reference
    /// (ampcode.com/api/external, /api/v2/openapi.json) has it, with
    /// values filled in (the reference's are all 1).
    const AMP_EXAMPLE: &str = r#"{
      "metadata": { "startDate": "2026-10-20", "endDate": "2026-10-21", "activeUsers": 1, "totalUsers": 2,
                    "totalUsage": 4.5, "totalOrbUsage": 0.5, "totalToolUsage": 0.25 },
      "data": [
        { "date": "2026-10-20", "users": [] },
        { "date": "2026-10-21", "users": [
          { "user": { "id": "u_1", "email": "Ada@Example.com" },
            "metrics": { "linesAdded": 10, "linesDeleted": 1, "linesModified": 2, "usage": 4.5, "orbUsage": 0.5,
                         "toolUsage": 0.25, "estimatedProviderCostAtListPriceUSD": 0 },
            "models": { "claude-opus-5-5": { "requests": 3, "inputTokens": 100, "outputTokens": 50, "usage": 3.0 },
                        "gpt-6-sol": { "requests": 1, "usage": 0.75 } },
            "orbs": [], "tools": [] },
          { "user": { "id": "u_2" }, "metrics": { "usage": 0 }, "models": {} }
        ] }
      ]
    }"#;

    /// The response example for UserPageAnalytics in Devin Desktop's API
    /// reference (docs.devin.ai/desktop/accounts/api-reference/user-page-analytics).
    const WINDSURF_EXAMPLE: &str = r#"{
      "userTableStats": [
        { "name": "Alice", "email": "alice@cognition.ai", "lastUpdateTime": "2024-10-10T22:56:10.771591Z",
          "apiKey": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "activeDays": 178, "role": "admin",
          "signupTime": "2024-01-15T08:30:00Z", "lastAutocompleteUsageTime": "2024-10-10T22:56:10Z",
          "lastChatUsageTime": "2024-10-10T20:30:00Z", "promptCreditsUsed": 12500, "teamStatus": "USER_TEAM_STATUS_APPROVED" },
        { "name": "Bob", "email": "bob@cognition.ai", "lastUpdateTime": "2024-10-10T18:11:23.980237Z",
          "apiKey": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "activeDays": 210, "role": "member",
          "signupTime": "2024-02-01T10:00:00Z", "lastAutocompleteUsageTime": "2024-10-10T18:11:23Z",
          "lastChatUsageTime": "2024-10-09T14:22:00Z", "lastCommandUsageTime": "2024-10-08T09:15:00Z",
          "promptCreditsUsed": 8300, "teamStatus": "USER_TEAM_STATUS_APPROVED" }
      ],
      "billingCycleStart": "2024-10-01T00:00:00Z",
      "billingCycleEnd": "2024-11-01T00:00:00Z"
    }"#;

    fn json(text: &str) -> Value {
        serde_json::from_str(text).unwrap()
    }

    #[test]
    fn basic_auth_is_the_key_as_the_user_name() {
        assert_eq!(basic("crsr_abc"), "Basic Y3Jzcl9hYmM6");
        assert_eq!(basic("a"), "Basic YTo=");
        assert_eq!(basic("ab"), "Basic YWI6");
    }

    #[test]
    fn openais_people_are_read_by_user_with_their_addresses() {
        let (users, next) = parse_openai_users(&json(OPENAI_USERS_EXAMPLE)).unwrap();
        assert_eq!(users, [("user_abc".to_owned(), "user@example.com".to_owned())]);
        assert_eq!(next, None);
        let (_, next) = parse_openai_users(&serde_json::json!({
            "object": "list", "data": [{ "object": "organization.user", "id": "user_1", "email": null, "added_at": 1 }],
            "first_id": "user_1", "last_id": "user_1", "has_more": true,
        }))
        .unwrap();
        assert_eq!(next.as_deref(), Some("user_1"));
        assert_eq!(
            openai_users_url(Some("user_1")),
            "https://api.openai.com/v1/organization/users?limit=100&after=user_1"
        );

        let emails: HashMap<String, String> = users.into_iter().collect();
        // Costs by user and line item: dollars, the model out of the line
        // item; a cost with no user is the organization's only.
        let (days, charges, other, next) = parse_openai_user_costs(
            &serde_json::json!({
                "object": "page",
                "data": [{ "object": "bucket", "start_time": 1730419200, "end_time": 1730505600, "results": [
                    { "object": "organization.costs.result", "amount": { "value": 1.5, "currency": "usd" },
                      "line_item": "gpt-6-astra, input_tokens", "user_id": "user_abc", "project_id": null },
                    { "object": "organization.costs.result", "amount": { "value": 0.25, "currency": "usd" },
                      "line_item": "gpt-6-astra, output_tokens", "user_id": "user_gone" },
                    { "object": "organization.costs.result", "amount": { "value": 9.0, "currency": "usd" },
                      "line_item": "Image models", "user_id": null }
                ] }],
                "has_more": true, "next_page": "page_2",
            }),
            &emails,
        )
        .unwrap();
        assert_eq!(days, ["2024-11-01"]);
        assert!(other.is_empty());
        assert_eq!(next.as_deref(), Some("page_2"));
        assert_eq!(charges.len(), 2);
        assert_eq!(
            (charges[0].actor.as_str(), charges[0].model.as_str(), charges[0].micros),
            ("user@example.com", "gpt-6-astra", 1_500_000)
        );
        // A user the organization no longer lists keeps their id, which
        // matches nobody.
        assert_eq!(charges[1].actor, "user_gone");
        assert_eq!(charges[1].harness, "openai");
        assert!(openai_user_costs_url("2024-11-01", 1_730_505_600_000, None).contains("group_by=user_id&group_by=line_item"));
    }

    #[test]
    fn openais_tokens_are_priced_at_list_price_where_its_costs_cant_be_split() {
        let emails: HashMap<String, String> = [("user_abc".to_owned(), "user@example.com".to_owned())].into();
        let (days, charges, unpriced, next) =
            parse_openai_completions(&json(OPENAI_COMPLETIONS_EXAMPLE), &emails).unwrap();
        assert_eq!(days, ["2024-11-01"]);
        assert!(unpriced.is_empty());
        assert_eq!(next.as_deref(), Some("page_AAAAAGdGxdEiJdKOAAAAAGcqsYA="));
        // gpt-6-astra: 500 uncached input at $10, 400 cached at $1, 100
        // written at $12.50 and 500 output at $50, per million.
        assert_eq!(charges.len(), 1);
        assert_eq!(charges[0].micros, 31_650);
        assert_eq!(charges[0].actor, "user@example.com");
        let rows = person_rows(&charges, &BTreeMap::new(), CostUnit::Usd, true);
        assert!(rows[0].list_price);
        // A model g1t has no price for is named, not guessed.
        let (_, charges, unpriced, _) = parse_openai_completions(
            &serde_json::json!({ "data": [{ "start_time": 1730419200, "results": [
                { "input_tokens": 10, "output_tokens": 5, "user_id": "user_abc", "model": "o9-mystery" }] }], "has_more": false }),
            &emails,
        )
        .unwrap();
        assert!(charges.is_empty());
        assert_eq!(unpriced.into_iter().collect::<Vec<_>>(), ["o9-mystery"]);
        assert_eq!(
            openai_completions_url("2024-11-01", 1_730_505_600_000, None),
            "https://api.openai.com/v1/organization/usage/completions?start_time=1730419200&end_time=1730505600&bucket_width=1d&group_by=user_id&group_by=model&limit=31"
        );
    }

    #[test]
    fn cursors_documented_events_read_as_charges_per_person_and_conversation() {
        let (events, more) = parse_cursor(&json(CURSOR_EXAMPLE)).unwrap();
        assert!(more);
        assert_eq!(events.len(), 3);
        // 1750979225854 is 2025-06-26 23:07 UTC.
        assert_eq!(events[0].day, "2025-06-26");
        assert_eq!(events[0].micros, 213_623);
        assert_eq!(events[0].conversation.as_deref(), Some("8f2e4a1b-6c3d-4e5f-9a7b-2d1c8e6f4a3b"));
        // Included usage is charged too, and an event of no conversation
        // has none.
        assert_eq!((events[2].micros, events[2].conversation.as_deref()), (80_000, None));

        let (rows, conversations) = cursor_people(&events);
        let row = |actor: &str, model: &str, micros, sessions| PersonRow {
            day: "2025-06-26".into(),
            kind: ActorKind::User,
            actor: actor.into(),
            harness: "cursor".into(),
            model: model.into(),
            micros,
            sessions,
            customer_type: String::new(),
            unit: CostUnit::Usd,
            list_price: false,
        };
        assert_eq!(
            rows,
            [
                row("admin@company.com", "claude-4-sonnet-thinking", 80_000, 0),
                row("developer@company.com", "claude-4.5-sonnet", 586_923, 1),
            ]
        );
        assert_eq!(
            conversations,
            [ConversationRow {
                day: "2025-06-26".into(),
                kind: ActorKind::User,
                actor: "developer@company.com".into(),
                conversation: "8f2e4a1b-6c3d-4e5f-9a7b-2d1c8e6f4a3b".into(),
                micros: 586_923,
                events: 2,
            }]
        );

        // A service account's events are its own, never a person's.
        let (events, more) = parse_cursor(&serde_json::json!({
            "usageEvents": [{ "timestamp": "1750979225854", "serviceAccountId": "sa_abc123",
                              "serviceAccountName": "Nightly CI Agent", "model": "m", "chargedCents": "1.5", "isHeadless": true }],
            "pagination": { "hasNextPage": false },
        }))
        .unwrap();
        assert!(!more);
        assert_eq!(
            (events[0].kind, events[0].actor.as_str(), events[0].micros),
            (ActorKind::ApiKey, "Nightly CI Agent", 15_000)
        );
        assert!(parse_cursor(&serde_json::json!({ "error": "Unauthorized", "message": "Invalid API key" })).is_err());
    }

    #[test]
    fn cursor_is_read_a_week_at_a_time_newest_first() {
        let now = parse_rfc3339("2026-10-18T09:30:00.000Z").unwrap();
        let until = now - now % DAY_MS + DAY_MS;
        let windows = cursor_windows("2026-10-05", until);
        assert_eq!(windows.len(), 2);
        let (start, end, days) = &windows[0];
        assert_eq!(days.first().map(String::as_str), Some("2026-10-18"));
        assert_eq!(days.last().map(String::as_str), Some("2026-10-12"));
        assert_eq!(rfc3339(*start), "2026-10-12T00:00:00.000Z");
        assert_eq!(rfc3339(*end), "2026-10-18T23:59:59.999Z");
        assert_eq!(windows[1].2.len(), 7);
        // As values: key order depends on whether serde_json keeps insertion order in this build.
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&cursor_body(1, 2, 3, 1000)).unwrap(),
            serde_json::json!({ "startDate": 1, "endDate": 2, "page": 3, "pageSize": 1000 })
        );
    }

    #[test]
    fn amps_daily_usage_reads_per_person_and_model_in_dollars() {
        let (days, charges) = parse_amp(&json(AMP_EXAMPLE)).unwrap();
        assert_eq!(days, ["2026-10-20", "2026-10-21"]);
        let rows = person_rows(&charges, &BTreeMap::new(), CostUnit::Usd, false);
        let models: Vec<(&str, &str, i64)> = rows
            .iter()
            .map(|r| (r.actor.as_str(), r.model.as_str(), r.micros))
            .collect();
        // Orbs and tools are the day's usage beyond its models, with no
        // model; a person who used nothing has no row.
        assert_eq!(
            models,
            [
                ("ada@example.com", "", 750_000),
                ("ada@example.com", "claude-opus-5-5", 3_000_000),
                ("ada@example.com", "gpt-6-sol", 750_000)
            ]
        );
        assert!(rows.iter().all(|r| r.harness == "amp"));
        assert_eq!(
            amp_daily_url("2026-10-21", 90),
            "https://ampcode.com/api/v2/workspace/analytics/daily-usage?endDate=2026-10-21&lookbackDays=90"
        );
        assert_eq!(amp_client("id_1:secret:with:colons"), Some(("id_1", "secret:with:colons")));
        assert_eq!(amp_client("only-a-secret"), None);
        assert_eq!(amp_client(":secret"), None);
        assert_eq!(
            amp_token_form("id 1", "s/ec+ret"),
            "grant_type=client_credentials&client_id=id%201&client_secret=s%2Fec%2Bret&scope=amp.api%3Aworkspace.analytics%3Aview%20amp.api%3Aworkspace.members%3Aview"
        );
        assert!(parse_amp(&serde_json::json!({ "error": "Unauthorized" })).is_err());
    }

    #[test]
    fn devins_acus_and_devin_desktops_credits_stay_in_their_own_units() {
        let (members, next) = parse_devin_members(&serde_json::json!({
            "items": [{ "user_id": "user_1", "email": "Ada@Example.com", "name": "Ada", "role_assignments": [] },
                      { "user_id": "user_2", "email": null, "name": "Bo", "role_assignments": [] }],
            "end_cursor": "c2", "has_next_page": true,
        }))
        .unwrap();
        assert_eq!(members, [("user_1".to_owned(), "ada@example.com".to_owned())]);
        assert_eq!(next.as_deref(), Some("c2"));
        // Devin's day starts at midnight Pacific, 08:00 UTC.
        let until = parse_rfc3339("2026-10-19T00:00:00.000Z").unwrap();
        assert_eq!(
            devin_consumption_url("user_1", "2026-10-12", until),
            "https://api.devin.ai/v3/enterprise/consumption/daily/users/user_1?time_after=1791792000&time_before=1792396800"
        );
        let charges = parse_devin_consumption(
            &serde_json::json!({ "total_acus": 12.5, "consumption_by_date": [
                { "date": 1792396800, "acus": 12.5,
                  "acus_by_product": { "devin": 10.0, "cascade": 2.0, "terminal": 0.5, "automation": null, "review": null } }] }),
            "ada@example.com",
        )
        .unwrap();
        let rows = person_rows(&charges, &BTreeMap::new(), CostUnit::Acus, false);
        let found: Vec<(&str, &str, &str, i64)> = rows
            .iter()
            .map(|r| (r.day.as_str(), r.harness.as_str(), r.model.as_str(), r.micros))
            .collect();
        assert_eq!(
            found,
            [
                ("2026-10-19", "devin", "devin", 10_000_000),
                ("2026-10-19", "devin", "terminal", 500_000),
                ("2026-10-19", "devin_desktop", "cascade", 2_000_000),
            ]
        );
        assert!(rows.iter().all(|r| r.unit == CostUnit::Acus));
        assert!(devin_cloud("cog_abc") && !devin_cloud("a1b2c3"));

        // Devin Desktop: hundredths of a credit, per person, for the day
        // asked for.
        let charges = parse_windsurf(&json(WINDSURF_EXAMPLE), "2026-10-18").unwrap();
        let rows = person_rows(&charges, &BTreeMap::new(), CostUnit::Credits, false);
        let found: Vec<(&str, i64)> = rows.iter().map(|r| (r.actor.as_str(), r.micros)).collect();
        assert_eq!(found, [("alice@cognition.ai", 125_000_000), ("bob@cognition.ai", 83_000_000)]);
        assert!(rows.iter().all(|r| r.harness == "devin_desktop" && r.unit == CostUnit::Credits));
        let body = json(&windsurf_body("key", "2026-10-18"));
        assert_eq!(body["start_timestamp"], "2026-10-18T00:00:00Z");
        assert_eq!(body["end_timestamp"], "2026-10-18T23:59:59Z");
        assert!(parse_windsurf(&serde_json::json!({ "error": "invalid service key" }), "2026-10-18").is_err());
    }

    #[test]
    fn a_days_sessions_sit_on_its_first_model_and_nothing_is_left_out() {
        let charge = |actor: &str, model: &str, micros| Charge {
            day: "2026-10-18".into(),
            kind: ActorKind::User,
            actor: actor.into(),
            harness: "cursor".into(),
            model: model.into(),
            micros,
        };
        let key = |actor: &str| ("2026-10-18".to_owned(), ActorKind::User, actor.to_owned(), "cursor".to_owned());
        let sessions: BTreeMap<_, _> = [(key("ada@example.com"), 3), (key("idle@example.com"), 1)].into();
        let rows = person_rows(
            &[
                charge("ada@example.com", "b", 5),
                charge("ada@example.com", "a", 1),
                charge("ada@example.com", "a", 1),
                charge("zero@example.com", "a", 0),
            ],
            &sessions,
            CostUnit::Usd,
            false,
        );
        let found: Vec<(&str, &str, i64, u32)> = rows
            .iter()
            .map(|r| (r.actor.as_str(), r.model.as_str(), r.micros, r.sessions))
            .collect();
        assert_eq!(
            found,
            [
                ("ada@example.com", "a", 2, 3),
                ("ada@example.com", "b", 5, 0),
                ("idle@example.com", "", 0, 1)
            ]
        );
    }

    #[test]
    fn every_providers_rows_keep_their_unit_and_read_together_per_person() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        for sql in [
            include_str!("../migrations/0067_provider_costs.sql"),
            include_str!("../migrations/0068_provider_person_costs.sql"),
            include_str!("../migrations/0069_provider_people.sql"),
        ] {
            db.execute_batch(sql).unwrap();
        }
        let write = |provider: &str, row: &PersonRow| {
            db.execute(
                UPSERT_PERSON_COST,
                rusqlite::params![
                    "acme",
                    provider,
                    row.day,
                    row.kind.name(),
                    row.actor,
                    row.harness,
                    row.model,
                    row.micros,
                    row.sessions,
                    row.customer_type,
                    "t1",
                    row.unit.name(),
                    u8::from(row.list_price)
                ],
            )
            .unwrap();
        };
        let (cursor, conversations) = cursor_people(&parse_cursor(&json(CURSOR_EXAMPLE)).unwrap().0);
        for row in &cursor {
            write("cursor", row);
        }
        for c in &conversations {
            db.execute(
                UPSERT_CONVERSATION,
                rusqlite::params!["acme", "cursor", c.day, c.kind.name(), c.actor, c.conversation, c.micros, c.events, "t1"],
            )
            .unwrap();
        }
        let emails: HashMap<String, String> = [("user_abc".to_owned(), "developer@company.com".to_owned())].into();
        let (_, charges, _, _) = parse_openai_completions(&json(OPENAI_COMPLETIONS_EXAMPLE), &emails).unwrap();
        // The OpenAI example's day, moved to Cursor's, for one span.
        for mut row in person_rows(&charges, &BTreeMap::new(), CostUnit::Usd, true) {
            row.day = "2025-06-26".into();
            write("openai", &row);
        }
        let credits = person_rows(
            &parse_windsurf(&json(WINDSURF_EXAMPLE), "2025-06-26").unwrap(),
            &BTreeMap::new(),
            CostUnit::Credits,
            false,
        );
        for row in &credits {
            write("devin", row);
        }
        let theirs = serde_json::to_string(&["developer@company.com"]).unwrap();
        let mut statement = db.prepare(PERSON_DAYS).unwrap();
        let days: Vec<(String, String, String, String, i64, i64, i64)> = statement
            .query_map(rusqlite::params!["acme", "2025-06-26", "2025-06-26", theirs, 1000], |r| {
                Ok((r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?))
            })
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(
            days,
            [
                ("cursor".into(), "cursor".into(), "claude-4.5-sonnet".into(), "usd".into(), 0, 586_923, 1),
                ("openai".into(), "openai".into(), "gpt-6-astra".into(), "usd".into(), 1, 31_650, 0),
            ]
        );
        // Each actor's totals keep their unit, for what matches nobody.
        let mut statement = db.prepare(&format!("{ACTOR_TOTALS} ORDER BY provider, actor")).unwrap();
        let totals: Vec<(String, String, String, i64)> = statement
            .query_map(rusqlite::params!["acme", "2025-06-26", "2025-06-26"], |r| {
                Ok((r.get(0)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(totals.len(), 5);
        assert_eq!(totals[2], ("devin".into(), "alice@cognition.ai".into(), "credits".into(), 125_000_000));

        // Cursor's organization days are its people's, per model.
        let refs: Vec<&PersonRow> = cursor.iter().collect();
        let org = organization_days(&refs);
        assert_eq!(org[&("2025-06-26".to_owned(), "claude-4.5-sonnet".to_owned(), CostUnit::Usd)], 586_923);
        for ((day, model, unit), micros) in &org {
            db.execute(
                UPSERT_COST_IN,
                rusqlite::params!["acme", "cursor", day, model, micros, unit.name().to_uppercase(), "t1"],
            )
            .unwrap();
        }
        let currency: String = db
            .query_row("SELECT DISTINCT currency FROM provider_costs WHERE provider = 'cursor'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(CostUnit::parse(&currency), Some(CostUnit::Usd));

        // A conversation can be found by Cursor's id; a day read again
        // replaces its conversations.
        let found: i64 = db
            .query_row(
                "SELECT micros FROM provider_conversations WHERE workspace = 'acme' AND conversation = ?1",
                ["8f2e4a1b-6c3d-4e5f-9a7b-2d1c8e6f4a3b"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(found, 586_923);
        db.execute(DELETE_CONVERSATION_DAY, rusqlite::params!["acme", "cursor", "2025-06-26"])
            .unwrap();
        let left: i64 = db
            .query_row("SELECT COUNT(*) FROM provider_conversations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }
}
