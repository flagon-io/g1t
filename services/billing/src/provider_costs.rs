//! Provider cost reports: what an AI provider says the workspace's
//! organization spent, day by day, read from the provider itself.
//!
//! g1t meters only what runs through it. A team's other agents (CI
//! scripts, other tools) are on the provider's bill too, and the provider's
//! own report is the ground truth for all of it. A workspace owner connects
//! the organization's admin key; billing checks it with one small report
//! request, seals it with `BILLING_KEY` bound to the connection's id, and
//! never returns or logs it (only its last four characters are kept in
//! the clear, as its hint).
//!
//! - **Anthropic**: the Usage and Cost Admin API's
//!   `GET /v1/organizations/cost_report`, with an Admin API key
//!   (`x-api-key`, `anthropic-version: 2023-06-01`): daily buckets
//!   (`bucket_width=1d`, at most 31 a page), grouped by `workspace_id` and
//!   `description`, amounts as decimal strings of cents in USD, paged with
//!   `page` = `next_page` while `has_more`.
//! - **OpenAI**: `GET /v1/organization/costs`, with an admin key as a
//!   bearer token: daily buckets from `start_time` (Unix seconds, at most
//!   180 a page), grouped by `line_item` and `project_id`, amounts as
//!   `amount.value` in dollars, paged the same way.
//! - **Anthropic, per person**: alongside its cost report, the Claude Code
//!   Analytics Admin API's `GET /v1/organizations/usage_report/claude_code`,
//!   with the same key: one day a call (`starting_at=YYYY-MM-DD`, up to
//!   1000 rows a page, paged the same way), a row per actor (a person by
//!   email address, or an API key by name), terminal, customer type and
//!   remote or local use, each with its session count and its models'
//!   `estimated_cost.amount` (a number of cents in USD). Kept per day,
//!   actor and model in `provider_person_costs`, and matched to members
//!   only when asked, through addresses they have confirmed (identity's
//!   `members_by_email`). It is kept apart from the cost report: an
//!   organization without Claude Code data, or a key that can't read it,
//!   leaves the cost report working, and says so in `people_error`.
//! - **Everyone else, per person** (`provider_people`): OpenAI's costs per
//!   user, with the same key, and Cursor, Amp and Devin, which have no
//!   cost report apart from their people's: their per-person read is the
//!   whole read, and each day's total per model is kept as their cost
//!   report too, in the provider's unit (Devin's ACUs and credits are
//!   never dollars).
//!
//! Once a day (`keeper::DAILY`) every connection is read again: the last
//! [`REVISE_DAYS`] days, since providers revise recent days (further back
//! when reads have failed since), and [`BACKFILL_DAYS`] on its first read.
//! A read replaces the days it covers, so reading twice changes nothing.
//! A provider that fails records why on its connection and the others are
//! still read.
//!
//! The per-person report costs a request for every day read: 7 on most
//! days, 90 on a connection's first read ([`DAYS_AT_ONCE`] at a time),
//! plus any further pages. The daily cron reads every connection in one
//! invocation, well within a Worker's subrequests while workspaces with
//! an Anthropic connection are few; with many more, the reads should be
//! spread over invocations.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use g1t_contracts::billing::{
    ConnectProviderArgs, CostProvider, CostUnit, DisconnectProviderArgs, ProviderConnection, ProviderConnectionsArgs,
    ProviderCostDay, ProviderCosts, ProviderCostsArgs, ProviderPersonCosts, ProviderPersonCostsArgs, ProviderPersonDay,
};
use g1t_contracts::identity::{MemberEmail, MembersByEmailArgs};
use g1t_contracts::time::{parse_rfc3339, rfc3339};
use g1t_contracts::{FailureCode, Outcome, PrincipalKind, Role, User, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use serde_json::Value;
use worker::{Fetch, Headers, Method, Request, RequestInit, Result};

use crate::Billing;
use crate::provider_people::{PeopleRead, PersonRow};

pub(crate) const DAY_MS: u64 = 24 * 60 * 60 * 1000;
/// How far back the first read goes, today included.
pub(crate) const BACKFILL_DAYS: u64 = 90;
/// How many recent days every read asks for again, today included.
pub(crate) const REVISE_DAYS: u64 = 7;
/// The most pages read from one provider at once: 90 days are 3 of
/// Anthropic's and 1 of OpenAI's.
const MAX_PAGES: u32 = 12;
/// The most rows `provider_costs` returns; past it the answer is not complete.
const MAX_ROWS: usize = 20_000;
/// The longest key accepted.
const MAX_KEY: usize = 512;
/// Statements per D1 batch when writing a read.
const BATCH: usize = 50;

const ANTHROPIC_COSTS: &str = "https://api.anthropic.com/v1/organizations/cost_report";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const ANTHROPIC_CLAUDE_CODE: &str = "https://api.anthropic.com/v1/organizations/usage_report/claude_code";
/// The harness the per-person report is about: the only one a provider
/// reports per person.
pub(crate) const CLAUDE_CODE: &str = "claude_code";
/// The most pages of one day's Claude Code report read: 5,000 rows.
const MAX_DAY_PAGES: u32 = 5;
/// Days of the Claude Code report asked for at once.
const DAYS_AT_ONCE: usize = 4;
/// The most addresses one `members_by_email` call takes.
const MAX_EMAILS: usize = 500;
const OPENAI_COSTS: &str = "https://api.openai.com/v1/organization/costs";
/// As Anthropic asks of integrations.
pub(crate) const USER_AGENT: &str = "g1t/1.0 (https://g1t.sh)";

const NO_SEALER: &str = "Provider cost reports are not set up on this g1t: it has no key to keep secrets with.";
const MEMBERS_ONLY: &str = "Only members can see a workspace's provider costs.";
const OWN_ONLY: &str = "Only an owner or a billing manager can see what a provider reported for someone else.";

/// What the list and every answer read: never the key.
const LIST_SQL: &str = "SELECT provider, hint, connected_by, connected_at, last_synced_at, last_error, synced_from
     FROM provider_connections WHERE workspace = ? ORDER BY provider";

/// One read's days replaced: those the provider answered for, `?3` to `?4`.
pub(crate) const DELETE_DAYS: &str =
    "DELETE FROM provider_costs WHERE workspace = ?1 AND provider = ?2 AND day >= ?3 AND day <= ?4";

/// One day's line item, written again if it is there already.
pub(crate) const UPSERT_COST: &str =
    "INSERT INTO provider_costs (workspace, provider, day, item, scope, micros, currency, synced_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'USD', ?7)
     ON CONFLICT (workspace, provider, day, item, scope) DO UPDATE SET
       micros = excluded.micros, currency = excluded.currency, synced_at = excluded.synced_at";

/// One day's use of one model, for a provider whose days are its
/// people's: in `?8`, US dollars (`USD`) or the provider's own unit.
pub(crate) const UPSERT_COST_IN: &str =
    "INSERT INTO provider_costs (workspace, provider, day, item, scope, micros, currency, synced_at)
     VALUES (?1, ?2, ?3, ?4, '', ?5, ?6, ?7)
     ON CONFLICT (workspace, provider, day, item, scope) DO UPDATE SET
       micros = excluded.micros, currency = excluded.currency, synced_at = excluded.synced_at";

/// A read that worked: the first day asked for moves back, never forward.
pub(crate) const NOTE_SYNCED: &str = "UPDATE provider_connections SET last_synced_at = ?1, last_error = ?2,
       synced_from = CASE WHEN synced_from IS NULL OR synced_from > ?3 THEN ?3 ELSE synced_from END
     WHERE id = ?4";

/// One read's day of the per-person report, replaced.
pub(crate) const DELETE_PERSON_DAY: &str =
    "DELETE FROM provider_person_costs WHERE workspace = ?1 AND provider = ?2 AND day = ?3";

/// One read's day of the conversations, replaced with the per-person rows.
pub(crate) const DELETE_CONVERSATION_DAY: &str =
    "DELETE FROM provider_conversations WHERE workspace = ?1 AND provider = ?2 AND day = ?3";

/// One day's charge of one conversation, written again if it is there
/// already.
pub(crate) const UPSERT_CONVERSATION: &str =
    "INSERT INTO provider_conversations (workspace, provider, day, actor_kind, actor, conversation, micros, events, synced_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT (workspace, provider, day, actor_kind, actor, conversation) DO UPDATE SET
       micros = excluded.micros, events = excluded.events, synced_at = excluded.synced_at";

/// One day's cost of one actor's use of one model, written again if it is
/// there already.
pub(crate) const UPSERT_PERSON_COST: &str =
    "INSERT INTO provider_person_costs (workspace, provider, day, actor_kind, actor, harness, model, micros, sessions, customer_type, synced_at, unit, list_price)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
     ON CONFLICT (workspace, provider, day, actor_kind, actor, harness, model) DO UPDATE SET
       micros = excluded.micros, sessions = excluded.sessions, customer_type = excluded.customer_type,
       synced_at = excluded.synced_at, unit = excluded.unit, list_price = excluded.list_price";

/// A per-person read that worked, as [`NOTE_SYNCED`].
pub(crate) const NOTE_PEOPLE_SYNCED: &str = "UPDATE provider_connections SET people_synced_at = ?1, people_error = ?2,
       people_synced_from = CASE WHEN people_synced_from IS NULL OR people_synced_from > ?3 THEN ?3 ELSE people_synced_from END
     WHERE id = ?4";

/// Each actor's total in a span, at every provider, in each unit: to
/// match the addresses, and to count what matched nobody.
pub(crate) const ACTOR_TOTALS: &str = "SELECT provider, actor_kind, actor, unit, SUM(micros) AS micros FROM provider_person_costs
     WHERE workspace = ?1 AND day >= ?2 AND day <= ?3
     GROUP BY provider, actor_kind, actor, unit";

/// One person's days at every provider, by harness and model, over the
/// addresses that are theirs (`?4`, a JSON array). Sessions add up
/// without counting a day twice: each actor's day keeps them on one row.
pub(crate) const PERSON_DAYS: &str = "SELECT day, provider, harness, model, unit, MAX(list_price) AS list_price,
       SUM(micros) AS micros, SUM(sessions) AS sessions
     FROM provider_person_costs
     WHERE workspace = ?1 AND day >= ?2 AND day <= ?3
       AND actor_kind = 'user' AND actor IN (SELECT value FROM json_each(?4))
     GROUP BY day, provider, harness, model, unit ORDER BY day, provider, harness, model LIMIT ?5";

/// A connection as the list reads it.
#[derive(Deserialize)]
struct ListedRow {
    provider: String,
    hint: String,
    connected_by: String,
    connected_at: String,
    last_synced_at: Option<String>,
    last_error: Option<String>,
    synced_from: Option<String>,
}

fn to_connection(row: ListedRow) -> Option<ProviderConnection> {
    Some(ProviderConnection {
        provider: CostProvider::parse(&row.provider)?,
        hint: row.hint,
        connected_by: row.connected_by,
        connected_at: row.connected_at,
        last_synced_at: row.last_synced_at,
        last_error: row.last_error,
        synced_from: row.synced_from,
    })
}

/// A connection as a read needs it, sealed key and all. Never answered.
#[derive(Deserialize)]
struct SealedRow {
    id: String,
    workspace: String,
    provider: String,
    credential: String,
    last_synced_at: Option<String>,
    /// When the per-person report was last read without an error.
    #[serde(default)]
    people_synced_at: Option<String>,
}

/// Only an owner, as a person, connects or disconnects a provider: the
/// key reads the whole organization's spend.
pub(crate) fn owner_only<T>(actor: &User, workspace: &str) -> Option<Outcome<T>> {
    (actor.role_in(workspace) != Some(Role::Owner) || actor.kind != PrincipalKind::User).then(|| {
        Outcome::fail(
            FailureCode::Forbidden,
            "Only an owner of the workspace can connect or disconnect a provider.",
        )
    })
}

/// `YYYY-MM-DD` of an instant, UTC.
pub(crate) fn day_of(ms: u64) -> String {
    rfc3339(ms)[..10].to_owned()
}

/// The first instant of a `YYYY-MM-DD` day, UTC.
pub(crate) fn day_start(day: &str) -> Option<u64> {
    (day.len() == 10).then_some(())?;
    parse_rfc3339(&format!("{day}T00:00:00Z"))
}

/// What a read asks for: from the first day (`YYYY-MM-DD`) to the start
/// of tomorrow (exclusive, in ms). The last [`REVISE_DAYS`] days; back to
/// the day before the last good read when reads have failed since; all
/// [`BACKFILL_DAYS`] when there has been none.
pub(crate) fn window(now: u64, last_synced_at: Option<&str>) -> (String, u64) {
    let today = now - now % DAY_MS;
    let until = today + DAY_MS;
    let earliest = today - (BACKFILL_DAYS - 1) * DAY_MS;
    let from = match last_synced_at.and_then(parse_rfc3339) {
        None => earliest,
        Some(last) => {
            let revise = today - (REVISE_DAYS - 1) * DAY_MS;
            let missed = (last - last % DAY_MS).saturating_sub(DAY_MS);
            revise.min(missed).max(earliest)
        }
    };
    (day_of(from), until)
}

/// Percent-encodes a query value: a page token may hold `=`, `+` or `/`.
pub(crate) fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Anthropic's cost report from `from` (`YYYY-MM-DD`) to `until`, by day,
/// grouped by its workspace and description.
pub(crate) fn anthropic_url(from: &str, until: u64, page: Option<&str>) -> String {
    let mut url = format!(
        "{ANTHROPIC_COSTS}?starting_at={from}T00:00:00Z&ending_at={}&bucket_width=1d&group_by%5B%5D=workspace_id&group_by%5B%5D=description&limit=31",
        encode(&format!("{}Z", &rfc3339(until)[..19]))
    );
    if let Some(page) = page {
        url.push_str(&format!("&page={}", encode(page)));
    }
    url
}

/// OpenAI's costs from `from` (`YYYY-MM-DD`) to `until`, by day, grouped by
/// line item and project.
pub(crate) fn openai_url(from: &str, until: u64, page: Option<&str>) -> String {
    let start = day_start(from).unwrap_or(0) / 1000;
    let mut url = format!(
        "{OPENAI_COSTS}?start_time={start}&end_time={}&bucket_width=1d&group_by=line_item&group_by=project_id&limit=180",
        until / 1000
    );
    if let Some(page) = page {
        url.push_str(&format!("&page={}", encode(page)));
    }
    url
}

/// One day (`YYYY-MM-DD`) of Anthropic's Claude Code usage report: it
/// takes a day, not a range.
pub(crate) fn claude_code_url(day: &str, page: Option<&str>) -> String {
    let mut url = format!("{ANTHROPIC_CLAUDE_CODE}?starting_at={day}&limit=1000");
    if let Some(page) = page {
        url.push_str(&format!("&page={}", encode(page)));
    }
    url
}

/// Every day from `from` (`YYYY-MM-DD`) to `until` (exclusive, in ms),
/// newest first: what a read of the per-person report asks for, a call
/// each, so that a read cut short still has the latest days.
pub(crate) fn days_back(from: &str, until: u64) -> Vec<String> {
    let Some(first) = day_start(from) else {
        return Vec::new();
    };
    let mut days = Vec::new();
    let mut day = until.saturating_sub(DAY_MS);
    while until > first && day >= first {
        days.push(day_of(day));
        match day.checked_sub(DAY_MS) {
            Some(before) => day = before,
            None => break,
        }
    }
    days
}

/// The smallest request that proves a key can read the report: yesterday,
/// one bucket, ungrouped. None for a provider with no cost report of its
/// own (`provider_people::check` asks those).
fn check_url(provider: CostProvider, now: u64) -> Option<String> {
    let today = now - now % DAY_MS;
    let yesterday = today - DAY_MS;
    Some(match provider {
        CostProvider::Anthropic => format!(
            "{ANTHROPIC_COSTS}?starting_at={}&ending_at={}&bucket_width=1d&limit=1",
            encode(&format!("{}Z", &rfc3339(yesterday)[..19])),
            encode(&format!("{}Z", &rfc3339(today)[..19]))
        ),
        CostProvider::Openai => format!(
            "{OPENAI_COSTS}?start_time={}&end_time={}&bucket_width=1d&limit=1",
            yesterday / 1000,
            today / 1000
        ),
        CostProvider::Cursor | CostProvider::Amp | CostProvider::Devin => return None,
    })
}

/// One cost as the provider reported it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct CostRow {
    pub day: String,
    /// Anthropic's description, OpenAI's line item; empty for none.
    pub item: String,
    /// The provider's own workspace or project; empty for its default.
    pub scope: String,
    pub micros: i64,
    pub currency: String,
}

/// One page of a report: the days it answered for (every bucket, costs or
/// not), its costs, and the next page's token.
#[derive(Debug, Default)]
pub(crate) struct Page {
    pub days: Vec<String>,
    pub rows: Vec<CostRow>,
    pub next: Option<String>,
}

/// A decimal string of cents (`"123.78912"`) in millionths of a dollar,
/// exactly, rounded half away from zero at the last place.
pub(crate) fn cents_to_micros(cents: &str) -> Option<i64> {
    let text = cents.trim();
    let (negative, digits) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text),
    };
    let (whole, fraction) = digits.split_once('.').unwrap_or((digits, ""));
    if whole.is_empty() && fraction.is_empty() {
        return None;
    }
    if !whole.bytes().all(|b| b.is_ascii_digit()) || !fraction.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    // A cent is 10,000 millionths: four places of the fraction, and the
    // fifth to round on.
    let whole: i64 = if whole.is_empty() { 0 } else { whole.parse().ok()? };
    let mut places: Vec<u8> = fraction.bytes().map(|b| b - b'0').collect();
    places.resize(5, 0);
    let kept = places[..4].iter().fold(0i64, |n, d| n * 10 + i64::from(*d));
    let up = i64::from(places[4] >= 5);
    let micros = whole.checked_mul(10_000)?.checked_add(kept + up)?;
    Some(if negative { -micros } else { micros })
}

/// Dollars (`0.06`) in millionths of a dollar, rounded.
pub(crate) fn dollars_to_micros(dollars: f64) -> Option<i64> {
    dollars.is_finite().then(|| (dollars * 1_000_000.0).round() as i64)
}

pub(crate) fn text(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_owned()
}

/// A page of Anthropic's cost report, as documented: `data` holds buckets
/// with `starting_at` and `results`; each result has `amount` (a decimal
/// string in the currency's lowest unit), `currency`, and, when grouped,
/// `description` and `workspace_id` (null for the default workspace).
pub(crate) fn parse_anthropic(body: &Value) -> std::result::Result<Page, String> {
    let buckets = body["data"].as_array().ok_or("Anthropic's cost report had no data.")?;
    let mut page = Page::default();
    for bucket in buckets {
        let start = bucket["starting_at"]
            .as_str()
            .filter(|s| s.len() >= 10)
            .ok_or("A bucket in Anthropic's cost report had no start.")?;
        let day = start[..10].to_owned();
        for result in bucket["results"].as_array().into_iter().flatten() {
            let amount = result["amount"]
                .as_str()
                .ok_or("A cost in Anthropic's report had no amount.")?;
            let micros = cents_to_micros(amount)
                .ok_or_else(|| format!("Anthropic reported an amount g1t can't read: {amount}"))?;
            let item = [&result["description"], &result["model"], &result["cost_type"]]
                .into_iter()
                .find_map(|v| v.as_str().filter(|s| !s.is_empty()))
                .unwrap_or_default()
                .to_owned();
            page.rows.push(CostRow {
                day: day.clone(),
                item,
                scope: text(&result["workspace_id"]),
                micros,
                currency: result["currency"].as_str().unwrap_or("USD").to_owned(),
            });
        }
        page.days.push(day);
    }
    if body["has_more"].as_bool() == Some(true) {
        page.next = body["next_page"].as_str().filter(|s| !s.is_empty()).map(str::to_owned);
    }
    Ok(page)
}

/// A page of OpenAI's costs, as its reference has it: `data` holds buckets
/// with `start_time` (Unix seconds) and their costs (`results` in the
/// reference's example, `result` in its schema); each has
/// `amount.value` (dollars) and `amount.currency` (`usd`), and, when
/// grouped, `line_item` and `project_id`.
pub(crate) fn parse_openai(body: &Value) -> std::result::Result<Page, String> {
    let buckets = body["data"].as_array().ok_or("OpenAI's costs had no data.")?;
    let mut page = Page::default();
    for bucket in buckets {
        let start = bucket["start_time"]
            .as_u64()
            .ok_or("A bucket in OpenAI's costs had no start.")?;
        let day = day_of(start * 1000);
        let results = bucket["results"].as_array().or_else(|| bucket["result"].as_array());
        for result in results.into_iter().flatten() {
            let value = result["amount"]["value"]
                .as_f64()
                .ok_or("A cost in OpenAI's report had no amount.")?;
            let micros = dollars_to_micros(value).ok_or("OpenAI reported an amount g1t can't read.")?;
            page.rows.push(CostRow {
                day: day.clone(),
                item: text(&result["line_item"]),
                scope: text(&result["project_id"]),
                micros,
                currency: result["amount"]["currency"].as_str().unwrap_or("usd").to_owned(),
            });
        }
        page.days.push(day);
    }
    if body["has_more"].as_bool() == Some(true) {
        page.next = body["next_page"].as_str().filter(|s| !s.is_empty()).map(str::to_owned);
    }
    Ok(page)
}

/// Who a row of the Claude Code report is about.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum ActorKind {
    /// A person, by the address they use Claude Code with.
    User,
    /// An API key, by its name.
    ApiKey,
}

impl ActorKind {
    pub fn name(self) -> &'static str {
        match self {
            ActorKind::User => "user",
            ActorKind::ApiKey => "api_key",
        }
    }
}

/// One row of the Claude Code report: an actor's day on one terminal,
/// customer type and remote or local, with each model's estimated cost.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct PersonUse {
    pub day: String,
    pub kind: ActorKind,
    /// The address, lowercased, or the key's name.
    pub actor: String,
    pub customer_type: String,
    pub sessions: u32,
    /// Each model, its cost in millionths, and that cost's currency.
    pub models: Vec<(String, i64, String)>,
}

/// A page of the Claude Code report, and the next page's token.
#[derive(Debug, Default)]
pub(crate) struct PersonPage {
    pub uses: Vec<PersonUse>,
    pub next: Option<String>,
}

/// A page of Anthropic's Claude Code usage report, as documented: `data`
/// holds a row per actor, terminal, customer type and remote or local use
/// on `date`; `actor` is a `user_actor` with `email_address` or an
/// `api_actor` with `api_key_name`; `core_metrics.num_sessions` counts the
/// sessions; `model_breakdown` gives each model's `estimated_cost`, its
/// `amount` a number of cents. An actor of a kind g1t doesn't know is
/// left out.
pub(crate) fn parse_claude_code(body: &Value) -> std::result::Result<PersonPage, String> {
    let rows = body["data"]
        .as_array()
        .ok_or("Anthropic's Claude Code report had no data.")?;
    let mut page = PersonPage::default();
    for row in rows {
        let day = row["date"]
            .as_str()
            .filter(|s| s.len() >= 10)
            .ok_or("A row in Anthropic's Claude Code report had no date.")?[..10]
            .to_owned();
        let actor = &row["actor"];
        let (kind, name) = match actor["type"].as_str() {
            Some("user_actor") => (
                ActorKind::User,
                actor["email_address"].as_str().map(|email| email.trim().to_lowercase()),
            ),
            Some("api_actor") => (
                ActorKind::ApiKey,
                actor["api_key_name"].as_str().map(|name| name.trim().to_owned()),
            ),
            _ => continue,
        };
        let Some(name) = name.filter(|name| !name.is_empty()) else {
            continue;
        };
        let mut models = Vec::new();
        for model in row["model_breakdown"].as_array().into_iter().flatten() {
            let cost = &model["estimated_cost"];
            // A number of cents, as documented; a decimal string reads too.
            let amount = match &cost["amount"] {
                Value::Number(n) => n.to_string(),
                Value::String(s) => s.clone(),
                Value::Null => continue,
                other => return Err(format!("Anthropic reported a cost g1t can't read: {other}")),
            };
            let micros = cents_to_micros(&amount)
                .ok_or_else(|| format!("Anthropic reported a cost g1t can't read: {amount}"))?;
            models.push((
                text(&model["model"]),
                micros,
                cost["currency"].as_str().unwrap_or("USD").to_owned(),
            ));
        }
        page.uses.push(PersonUse {
            day,
            kind,
            actor: name,
            customer_type: text(&row["customer_type"]),
            sessions: row["core_metrics"]["num_sessions"]
                .as_u64()
                .map_or(0, |n| u32::try_from(n).unwrap_or(u32::MAX)),
            models,
        });
    }
    if body["has_more"].as_bool() == Some(true) {
        page.next = body["next_page"].as_str().filter(|s| !s.is_empty()).map(str::to_owned);
    }
    Ok(page)
}

/// One day's cost of one actor's use of one model, as kept.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct PersonCost {
    pub day: String,
    pub kind: ActorKind,
    pub actor: String,
    pub model: String,
    pub micros: i64,
    /// The actor's sessions that day, on its first model only.
    pub sessions: u32,
    pub customer_type: String,
}

/// The report's rows summed per day, actor and model (remote and local
/// use, terminals and customer types come as rows of their own), and the
/// currencies other than US dollars that were left out. The day's
/// sessions, which the report does not split by model, go on the first
/// model by name and 0 on the rest; a day with sessions and no cost is one
/// row with no model.
pub(crate) fn aggregate_people(uses: &[PersonUse]) -> (Vec<PersonCost>, BTreeSet<String>) {
    #[derive(Default)]
    struct Day {
        sessions: u32,
        types: BTreeSet<String>,
        models: BTreeMap<String, i64>,
    }
    let mut days: BTreeMap<(String, ActorKind, String), Day> = BTreeMap::new();
    let mut other = BTreeSet::new();
    for item in uses {
        let day = days
            .entry((item.day.clone(), item.kind, item.actor.clone()))
            .or_default();
        day.sessions = day.sessions.saturating_add(item.sessions);
        if !item.customer_type.is_empty() {
            day.types.insert(item.customer_type.clone());
        }
        for (model, micros, currency) in &item.models {
            if !currency.eq_ignore_ascii_case("usd") {
                other.insert(currency.to_uppercase());
                continue;
            }
            *day.models.entry(model.clone()).or_insert(0) += micros;
        }
    }
    let mut costs = Vec::new();
    for ((day, kind, actor), sums) in days {
        let customer_type = sums.types.into_iter().collect::<Vec<_>>().join(",");
        let models: Vec<(String, i64)> = if sums.models.is_empty() {
            if sums.sessions == 0 {
                continue;
            }
            vec![(String::new(), 0)]
        } else {
            sums.models.into_iter().collect()
        };
        for (index, (model, micros)) in models.into_iter().enumerate() {
            costs.push(PersonCost {
                day: day.clone(),
                kind,
                actor: actor.clone(),
                model,
                micros,
                sessions: if index == 0 { sums.sessions } else { 0 },
                customer_type: customer_type.clone(),
            });
        }
    }
    (costs, other)
}

/// Whose provider costs a viewer may see: their own (no one named, or
/// themselves), or, for an owner or billing manager, anyone's. The user
/// id, or why not.
pub(crate) fn whose<'a>(
    viewer: Option<&'a User>,
    workspace: &str,
    user_id: Option<&'a str>,
) -> std::result::Result<&'a str, &'static str> {
    let viewer = viewer
        .filter(|viewer| viewer.is_member(workspace))
        .ok_or(MEMBERS_ONLY)?;
    match user_id.map(str::trim).filter(|id| !id.is_empty()) {
        None => Ok(viewer.id.as_str()),
        Some(id) if id == viewer.id => Ok(viewer.id.as_str()),
        Some(id) if viewer.manages_billing(workspace) => Ok(id),
        Some(_) => Err(OWN_ONLY),
    }
}

/// An actor's total in a span, at one provider, in one unit.
#[derive(Clone, Debug, Deserialize)]
pub(crate) struct ActorTotal {
    pub actor_kind: String,
    pub actor: String,
    #[serde(default)]
    pub unit: String,
    pub micros: Option<f64>,
}

/// What matched nobody, in US dollars: the cost of every actor with any
/// that is not one of `linked` (members' confirmed addresses), API keys
/// included, and how many such actors there were (one seen at two
/// providers counts once). An actor that cost nothing isn't counted;
/// credits and ACUs aren't dollars, and are left out.
pub(crate) fn unlinked(actors: &[ActorTotal], linked: &HashSet<String>) -> (i64, u32) {
    let mut micros = 0i64;
    let mut seen = HashSet::new();
    for actor in actors {
        let cost = actor.micros.unwrap_or(0.0) as i64;
        let dollars = actor.unit.is_empty() || actor.unit == CostUnit::Usd.name();
        if cost == 0 || !dollars || (actor.actor_kind == ActorKind::User.name() && linked.contains(&actor.actor)) {
            continue;
        }
        micros += cost;
        seen.insert((actor.actor_kind.as_str(), actor.actor.as_str()));
    }
    (micros, u32::try_from(seen.len()).unwrap_or(u32::MAX))
}

/// A provider whose days are its people's: each day's total per model and
/// unit, over everyone, as its cost report.
pub(crate) fn organization_days(rows: &[&PersonRow]) -> BTreeMap<(String, String, CostUnit), i64> {
    let mut days = BTreeMap::new();
    for row in rows {
        *days
            .entry((row.day.clone(), row.model.clone(), row.unit))
            .or_insert(0i64) += row.micros;
    }
    days
}

/// The rows summed by day, item and scope (a description can repeat across
/// service tiers), and the currencies other than US dollars that were left
/// out.
pub(crate) fn aggregate(rows: &[CostRow]) -> (BTreeMap<(String, String, String), i64>, BTreeSet<String>) {
    let mut sums = BTreeMap::new();
    let mut other = BTreeSet::new();
    for row in rows {
        if !row.currency.eq_ignore_ascii_case("usd") {
            other.insert(row.currency.to_uppercase());
            continue;
        }
        *sums
            .entry((row.day.clone(), row.item.clone(), row.scope.clone()))
            .or_insert(0i64) += row.micros;
    }
    (sums, other)
}

/// Replaces every occurrence of the key with its hint.
pub(crate) fn scrub(text: &str, credential: &str) -> String {
    if credential.len() < 8 {
        return text.to_owned();
    }
    text.replace(credential, &g1t_secrets::hint(credential))
}

/// A key that is plainly the wrong kind, before anything is sent: what to
/// use instead.
pub(crate) fn precheck(provider: CostProvider, credential: &str) -> std::result::Result<(), String> {
    if credential.is_empty() {
        return Err(format!("Paste {}'s admin key.", provider.label()));
    }
    if credential.len() > MAX_KEY || !credential.bytes().all(|b| b.is_ascii_graphic()) {
        return Err("That isn't a key: a key is one line of letters, digits and dashes, with no spaces.".to_owned());
    }
    let foreign = credential.starts_with("sk-");
    match provider {
        CostProvider::Anthropic if credential.starts_with("sk-ant-api") => Err(
            "This is an Anthropic API key. The cost report needs an Admin API key (it starts sk-ant-admin), made in the Claude Console under Settings, Admin keys."
                .to_owned(),
        ),
        CostProvider::Anthropic if credential.starts_with("sk-admin-") || credential.starts_with("sk-proj-") => {
            Err("This looks like an OpenAI key. Connect it as OpenAI, or paste an Anthropic Admin API key (sk-ant-admin…).".to_owned())
        }
        CostProvider::Openai if credential.starts_with("sk-proj-") || credential.starts_with("sk-svcacct-") => Err(
            "This is a project API key. OpenAI's Costs API needs an admin key (it starts sk-admin-), made in the OpenAI platform under Organization settings, Admin keys."
                .to_owned(),
        ),
        CostProvider::Openai if credential.starts_with("sk-ant-") => {
            Err("This looks like an Anthropic key. Connect it as Anthropic, or paste an OpenAI admin key (sk-admin-…).".to_owned())
        }
        CostProvider::Cursor if foreign => Err(
            "This looks like an Anthropic or OpenAI key. Cursor's Admin API needs an API key a team admin makes in the Cursor dashboard, under API Keys (it starts crsr_)."
                .to_owned(),
        ),
        CostProvider::Amp if crate::provider_people::amp_client(credential).is_none() => Err(
            "Paste the Amp application's client ID and client secret, both: make an External API application in your Amp workspace's settings.".to_owned(),
        ),
        CostProvider::Devin if foreign => Err(
            "This looks like an Anthropic or OpenAI key. Use a Devin service user key (cog_…) or a Devin Desktop service key.".to_owned(),
        ),
        _ => Ok(()),
    }
}

/// Why a provider refused a report request, in a sentence that says what
/// to do. The provider's own words are added where they help, with the key
/// scrubbed out of them.
pub(crate) fn explain(provider: CostProvider, status: u16, body: &Value, credential: &str) -> String {
    let label = provider.label();
    // Each provider words its errors its own way: `error.message`,
    // `message`, `error` or `detail`.
    let said = [&body["error"]["message"], &body["message"], &body["error"], &body["detail"]]
        .into_iter()
        .find_map(|said| said.as_str().filter(|s| !s.is_empty()))
        .map(|m| scrub(m, credential))
        .map(|m| m.chars().take(200).collect::<String>());
    let base = match (provider, status) {
        (CostProvider::Anthropic, 401) => {
            "Anthropic didn't accept this key. Use an Admin API key (sk-ant-admin…) from the Claude Console, under Settings, Admin keys.".to_owned()
        }
        (CostProvider::Anthropic, 403) => {
            "This key can't read the organization's cost report. Only an Admin API key works: workspace API keys don't.".to_owned()
        }
        (CostProvider::Anthropic, 404) => {
            "Anthropic has no cost report for this key. The Admin API needs an organization: individual accounts don't have one.".to_owned()
        }
        (CostProvider::Openai, 401) => {
            "OpenAI didn't accept this key. Use an admin key from the OpenAI platform, under Organization settings, Admin keys.".to_owned()
        }
        (CostProvider::Openai, 403) => {
            "This key can't read the organization's costs. Use an organization admin key, not a project or user API key.".to_owned()
        }
        (CostProvider::Openai, 404) => "OpenAI has no costs for this key. Use an organization admin key.".to_owned(),
        (CostProvider::Cursor, 401) => {
            "Cursor didn't accept this key. Use an API key a team admin makes in the Cursor dashboard, under API Keys (crsr_…).".to_owned()
        }
        (CostProvider::Cursor, 403) => {
            "This key can't read the team's usage. Cursor's Admin API is for Enterprise teams, with a team admin's API key.".to_owned()
        }
        (CostProvider::Cursor, 404) => "Cursor has no team usage for this key.".to_owned(),
        (CostProvider::Amp, 400 | 401) => {
            "Amp didn't accept this application's client ID and secret. Make an External API application in your Amp workspace's settings, under Applications.".to_owned()
        }
        (CostProvider::Amp, 403) => {
            "This application can't read the workspace's analytics. Give it the workspace analytics and members view scopes.".to_owned()
        }
        (CostProvider::Amp, 404) => "Amp has no workspace analytics for this application.".to_owned(),
        (CostProvider::Devin, 401) => {
            "Devin didn't accept this key. Use a Devin service user key (cog_…) that may view consumption and members, or a Devin Desktop service key with Teams Read-only.".to_owned()
        }
        (CostProvider::Devin, 403) => {
            "This key can't read usage. Devin's usage APIs are for Enterprise plans, with a key that may view the enterprise's consumption and members.".to_owned()
        }
        (CostProvider::Devin, 404) => "Devin has no usage for this key.".to_owned(),
        (_, 429) => format!("{label} is limiting requests just now. g1t tries again at the next daily read."),
        (_, 500..=599) => format!("{label} didn't answer ({status}). g1t tries again at the next daily read."),
        _ => format!("{label} refused the request ({status})."),
    };
    match said {
        Some(said) if !said.is_empty() && status != 429 && status < 500 => format!("{base} {label} said: {said}"),
        _ => base,
    }
}

/// Why Anthropic refused a request for the Claude Code report. A 403 or a
/// 404 is an organization with no Claude Code report for this key; the
/// cost report is read as before.
pub(crate) fn explain_people(status: u16, body: &Value, credential: &str) -> String {
    match status {
        403 | 404 => "Anthropic has no Claude Code usage report for this key: the organization may not use Claude Code, or the key can't read its analytics. The cost report is read as before.".to_owned(),
        _ => explain(CostProvider::Anthropic, status, body, credential),
    }
}

/// Whether a report was last read without an error, back to `since`.
fn read_back(last_synced_at: Option<&str>, last_error: Option<&str>, synced_from: Option<&str>, since: &str) -> bool {
    last_error.is_none() && last_synced_at.is_some() && synced_from.is_some_and(|from| from <= since)
}

/// Whether what the providers said covers every day from `since`.
pub(crate) fn complete(connections: &[ProviderConnection], since: &str) -> bool {
    !connections.is_empty()
        && connections.iter().all(|c| {
            read_back(
                c.last_synced_at.as_deref(),
                c.last_error.as_deref(),
                c.synced_from.as_deref(),
                since,
            )
        })
}

/// Asks a provider for one page of its report: the answer, or why not.
async fn get(provider: CostProvider, credential: &str, url: &str) -> std::result::Result<Value, String> {
    match send(provider, credential, url).await? {
        (200, body) => Ok(body),
        (status, body) => Err(explain(provider, status, &body, credential)),
    }
}

/// Sends one report request: the status and the body, or why it could not
/// be sent.
async fn send(provider: CostProvider, credential: &str, url: &str) -> std::result::Result<(u16, Value), String> {
    let sent = async {
        let headers = Headers::new();
        match provider {
            CostProvider::Anthropic => {
                headers.set("x-api-key", credential)?;
                headers.set("anthropic-version", ANTHROPIC_VERSION)?;
            }
            _ => headers.set("authorization", &format!("Bearer {credential}"))?,
        }
        headers.set("user-agent", USER_AGENT)?;
        headers.set("accept", "application/json")?;
        let mut init = RequestInit::new();
        init.with_method(Method::Get).with_headers(headers);
        let mut response = Fetch::Request(Request::new_with_init(url, &init)?).send().await?;
        let status = response.status_code();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        Ok::<_, worker::Error>((status, body))
    };
    match sent.await {
        Ok(answer) => Ok(answer),
        // Never the error itself: it could carry the request.
        Err(_) => Err(format!(
            "g1t couldn't reach {}. It tries again at the next daily read.",
            provider.label()
        )),
    }
}

/// Every page of a provider's report from `from` to `until`.
async fn read_report(
    provider: CostProvider,
    credential: &str,
    from: &str,
    until: u64,
) -> std::result::Result<Page, String> {
    let mut all = Page::default();
    let mut token: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let url = match provider {
            CostProvider::Anthropic => anthropic_url(from, until, token.as_deref()),
            CostProvider::Openai => openai_url(from, until, token.as_deref()),
            CostProvider::Cursor | CostProvider::Amp | CostProvider::Devin => return Ok(all),
        };
        let body = get(provider, credential, &url).await?;
        let page = match provider {
            CostProvider::Anthropic => parse_anthropic(&body)?,
            _ => parse_openai(&body)?,
        };
        all.days.extend(page.days);
        all.rows.extend(page.rows);
        match page.next {
            Some(next) => token = Some(next),
            None => return Ok(all),
        }
    }
    all.next = token;
    Ok(all)
}

/// One day of the Claude Code report, every page up to [`MAX_DAY_PAGES`],
/// and whether there were more.
async fn read_claude_code_day(credential: &str, day: &str) -> std::result::Result<(Vec<PersonUse>, bool), String> {
    let mut uses = Vec::new();
    let mut token: Option<String> = None;
    for _ in 0..MAX_DAY_PAGES {
        let url = claude_code_url(day, token.as_deref());
        let page = match send(CostProvider::Anthropic, credential, &url).await? {
            (200, body) => parse_claude_code(&body)?,
            (status, body) => return Err(explain_people(status, &body, credential)),
        };
        uses.extend(page.uses);
        match page.next {
            Some(next) => token = Some(next),
            None => return Ok((uses, false)),
        }
    }
    Ok((uses, true))
}

/// Anthropic's Claude Code report, one day a call from `from` to `until`,
/// [`DAYS_AT_ONCE`] at a time, newest first: a refusal stops the read and
/// keeps the days before it.
async fn read_claude_code(credential: &str, from: &str, until: u64) -> PeopleRead {
    let wanted = days_back(from, until);
    let mut read: Vec<String> = Vec::new();
    let mut uses: Vec<PersonUse> = Vec::new();
    let mut cut = false;
    let mut problem: Option<String> = None;
    for days in wanted.chunks(DAYS_AT_ONCE) {
        let answers =
            futures_util::future::join_all(days.iter().map(|day| read_claude_code_day(credential, day))).await;
        for (day, answer) in days.iter().zip(answers) {
            match answer {
                Ok((day_uses, more)) => {
                    read.push(day.clone());
                    uses.extend(day_uses);
                    cut |= more;
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
    let (costs, other) = aggregate_people(&uses);
    let note = if cut {
        Some("Anthropic's Claude Code report had more people on some days than g1t reads at once; some may be missing.".to_owned())
    } else if !other.is_empty() {
        let currencies: Vec<String> = other.into_iter().collect();
        Some(format!(
            "Some Claude Code costs were reported in {}, not US dollars, and are left out.",
            currencies.join(", ")
        ))
    } else {
        None
    };
    PeopleRead {
        days: read,
        rows: costs.into_iter().map(PersonRow::claude_code).collect(),
        conversations: Vec::new(),
        note,
        problem,
    }
}

impl Billing {
    async fn listed(&self, workspace: &str) -> Result<Vec<ProviderConnection>> {
        let rows = self
            .db
            .prepare(LIST_SQL)
            .bind(&[workspace.into()])?
            .all()
            .await?
            .results::<ListedRow>()?;
        Ok(rows.into_iter().filter_map(to_connection).collect())
    }

    pub(crate) async fn provider_connections(
        &self,
        a: ProviderConnectionsArgs,
    ) -> Result<Outcome<Vec<ProviderConnection>>> {
        let workspace = a.workspace.to_lowercase();
        if !a.viewer.is_some_and(|viewer| viewer.is_member(&workspace)) {
            return Ok(Outcome::fail(FailureCode::Forbidden, MEMBERS_ONLY));
        }
        Ok(Outcome::Ok(self.listed(&workspace).await?))
    }

    pub(crate) async fn connect_provider(&self, a: ConnectProviderArgs) -> Result<Outcome<ProviderConnection>> {
        let workspace = a.workspace.to_lowercase();
        if let Some(refused) = owner_only(&a.actor, &workspace) {
            return Ok(refused);
        }
        let Some(sealer) = &self.sealer else {
            return Ok(Outcome::fail(FailureCode::Conflict, NO_SEALER));
        };
        let provider = a.provider;
        let credential = a.credential.trim();
        if let Err(problem) = precheck(provider, credential) {
            return Ok(Outcome::fail(FailureCode::Invalid, problem));
        }
        let now = now_ms();
        let checked = match check_url(provider, now) {
            Some(url) => get(provider, credential, &url).await.map(|_| ()),
            None => crate::provider_people::check(provider, credential, now).await,
        };
        if let Err(problem) = checked {
            return Ok(Outcome::fail(FailureCode::Invalid, problem));
        }
        // A new id every time, and the key sealed to it: connecting again
        // replaces the row's id with the key. The costs read with the old
        // key may be another organization's, so they go.
        let id = new_id("pcn", now);
        let sealed = sealer.seal(credential, &id);
        self.db
            .batch(vec![
                self.db
                    .prepare("DELETE FROM provider_costs WHERE workspace = ?1 AND provider = ?2")
                    .bind(&[workspace.as_str().into(), provider.name().into()])?,
                self.db
                    .prepare("DELETE FROM provider_person_costs WHERE workspace = ?1 AND provider = ?2")
                    .bind(&[workspace.as_str().into(), provider.name().into()])?,
                self.db
                    .prepare("DELETE FROM provider_conversations WHERE workspace = ?1 AND provider = ?2")
                    .bind(&[workspace.as_str().into(), provider.name().into()])?,
                self.db
                    .prepare(
                        "INSERT INTO provider_connections (id, workspace, provider, credential, hint, connected_by, connected_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                         ON CONFLICT (workspace, provider) DO UPDATE SET
                           id = excluded.id, credential = excluded.credential, hint = excluded.hint,
                           connected_by = excluded.connected_by, connected_at = excluded.connected_at,
                           last_synced_at = NULL, last_error = NULL, synced_from = NULL,
                           people_synced_at = NULL, people_error = NULL, people_synced_from = NULL",
                    )
                    .bind(&[
                        id.as_str().into(),
                        workspace.as_str().into(),
                        provider.name().into(),
                        sealed.as_str().into(),
                        g1t_secrets::hint(credential).into(),
                        a.actor.username.as_str().into(),
                        rfc3339(now).into(),
                    ])?,
            ])
            .await?;
        // The first 90 days at once, so the page has something to show;
        // a failure is kept on the connection, which stays.
        let row = SealedRow {
            id,
            workspace: workspace.clone(),
            provider: provider.name().to_owned(),
            credential: sealed,
            last_synced_at: None,
            people_synced_at: None,
        };
        if let Err(error) = self.sync_connection(&row, now).await {
            worker::console_error!(
                "provider costs: {workspace} {}: writing the first read failed: {error}",
                provider.name()
            );
        }
        let listed = self.listed(&workspace).await?;
        Ok(match listed.into_iter().find(|c| c.provider == provider) {
            Some(connection) => Outcome::Ok(connection),
            None => Outcome::fail(FailureCode::NotFound, "The connection was not saved."),
        })
    }

    pub(crate) async fn disconnect_provider(&self, a: DisconnectProviderArgs) -> Result<Outcome<bool>> {
        let workspace = a.workspace.to_lowercase();
        if let Some(refused) = owner_only(&a.actor, &workspace) {
            return Ok(refused);
        }
        let was = self.listed(&workspace).await?.iter().any(|c| c.provider == a.provider);
        let bind =
            || -> Vec<worker::wasm_bindgen::JsValue> { vec![workspace.as_str().into(), a.provider.name().into()] };
        self.db
            .batch(vec![
                self.db
                    .prepare("DELETE FROM provider_connections WHERE workspace = ?1 AND provider = ?2")
                    .bind(&bind())?,
                self.db
                    .prepare("DELETE FROM provider_costs WHERE workspace = ?1 AND provider = ?2")
                    .bind(&bind())?,
                self.db
                    .prepare("DELETE FROM provider_person_costs WHERE workspace = ?1 AND provider = ?2")
                    .bind(&bind())?,
                self.db
                    .prepare("DELETE FROM provider_conversations WHERE workspace = ?1 AND provider = ?2")
                    .bind(&bind())?,
            ])
            .await?;
        Ok(Outcome::Ok(was))
    }

    pub(crate) async fn provider_person_costs(
        &self,
        a: ProviderPersonCostsArgs,
    ) -> Result<Outcome<ProviderPersonCosts>> {
        let workspace = a.workspace.to_lowercase();
        let person = match whose(a.viewer.as_ref(), &workspace, a.user_id.as_deref()) {
            Ok(person) => person.to_owned(),
            Err(refused) => return Ok(Outcome::fail(FailureCode::Forbidden, refused)),
        };
        let manages = a.viewer.as_ref().is_some_and(|viewer| viewer.manages_billing(&workspace));
        let since = a.since.get(..10).unwrap_or_default().to_owned();
        let until = a.until.get(..10).unwrap_or_default().to_owned();
        if day_start(&since).is_none() || day_start(&until).is_none() || since > until {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                "Give since and until as days, YYYY-MM-DD, since first.",
            ));
        }
        #[derive(Deserialize)]
        struct ReadRow {
            provider: String,
            people_synced_at: Option<String>,
            people_error: Option<String>,
            people_synced_from: Option<String>,
        }
        let reads = self
            .db
            .prepare(
                "SELECT provider, people_synced_at, people_error, people_synced_from FROM provider_connections
                 WHERE workspace = ?1 ORDER BY provider",
            )
            .bind(&[workspace.as_str().into()])?
            .all()
            .await?
            .results::<ReadRow>()?;
        // Every provider reports per person; each read's state, to say
        // whether the span is complete.
        let reads: Vec<(CostProvider, bool)> = reads
            .into_iter()
            .filter_map(|read| {
                Some((
                    CostProvider::parse(&read.provider)?,
                    read_back(
                        read.people_synced_at.as_deref(),
                        read.people_error.as_deref(),
                        read.people_synced_from.as_deref(),
                        &since,
                    ),
                ))
            })
            .collect();
        if reads.is_empty() {
            return Ok(Outcome::Ok(ProviderPersonCosts::default()));
        }
        let span = || -> Vec<worker::wasm_bindgen::JsValue> {
            vec![workspace.as_str().into(), since.as_str().into(), until.as_str().into()]
        };
        let actors = self
            .db
            .prepare(ACTOR_TOTALS)
            .bind(&span())?
            .all()
            .await?
            .results::<ActorTotal>()?;
        // The addresses in the span that members have confirmed: identity
        // decides, and nothing else links a row to a person.
        let emails: Vec<String> = actors
            .iter()
            .filter(|actor| actor.actor_kind == ActorKind::User.name())
            .map(|actor| actor.actor.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let mut members: Vec<MemberEmail> = Vec::new();
        if !emails.is_empty() {
            let Some(identity) = &self.identity else {
                return Ok(Outcome::fail(
                    FailureCode::Conflict,
                    "g1t can't match the report's addresses to members here.",
                ));
            };
            for chunk in emails.chunks(MAX_EMAILS) {
                let args = MembersByEmailArgs { workspace: workspace.clone(), emails: chunk.to_vec() };
                members.extend(g1t_kit::call::<_, Vec<MemberEmail>>(identity, "members_by_email", &args).await?);
            }
        }
        let theirs: Vec<&str> = members
            .iter()
            .filter(|member| member.user_id == person)
            .map(|member| member.email.as_str())
            .collect();
        #[derive(Deserialize)]
        struct DayRow {
            day: String,
            provider: String,
            harness: String,
            model: String,
            unit: String,
            list_price: Option<f64>,
            micros: Option<f64>,
            sessions: Option<f64>,
        }
        let rows = if theirs.is_empty() {
            Vec::new()
        } else {
            let mut bind = span();
            bind.push(serde_json::to_string(&theirs)?.into());
            bind.push(((MAX_ROWS + 1) as f64).into());
            self.db
                .prepare(PERSON_DAYS)
                .bind(&bind)?
                .all()
                .await?
                .results::<DayRow>()?
        };
        let cut = rows.len() > MAX_ROWS;
        let days = rows
            .into_iter()
            .take(MAX_ROWS)
            .filter_map(|row| {
                Some(ProviderPersonDay {
                    day: row.day,
                    provider: CostProvider::parse(&row.provider)?,
                    harness: row.harness,
                    model: row.model,
                    micros: row.micros.unwrap_or(0.0) as i64,
                    sessions: row.sessions.unwrap_or(0.0) as u32,
                    unit: CostUnit::parse(&row.unit).unwrap_or_default(),
                    list_price: row.list_price.unwrap_or(0.0) > 0.0,
                })
            })
            .collect();
        let (unlinked_micros, unlinked_actors) = if manages {
            let linked: HashSet<String> = members.into_iter().map(|member| member.email).collect();
            let (micros, count) = unlinked(&actors, &linked);
            (Some(micros), count)
        } else {
            (None, 0)
        };
        let complete = !cut && reads.iter().all(|(_, read)| *read);
        Ok(Outcome::Ok(ProviderPersonCosts {
            connected: true,
            providers: reads.into_iter().map(|(provider, _)| provider).collect(),
            days,
            unlinked_micros,
            unlinked_actors,
            complete,
        }))
    }

    pub(crate) async fn provider_costs(&self, a: ProviderCostsArgs) -> Result<Outcome<ProviderCosts>> {
        let workspace = a.workspace.to_lowercase();
        if !a.viewer.is_some_and(|viewer| viewer.is_member(&workspace)) {
            return Ok(Outcome::fail(FailureCode::Forbidden, MEMBERS_ONLY));
        }
        let since = a.since.get(..10).unwrap_or_default().to_owned();
        if day_start(&since).is_none() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Give since as a day, YYYY-MM-DD."));
        }
        #[derive(Deserialize)]
        struct DayRow {
            day: String,
            provider: String,
            item: String,
            currency: String,
            micros: Option<f64>,
        }
        let connections = self.listed(&workspace).await?;
        let rows = self
            .db
            .prepare(
                "SELECT day, provider, item, currency, SUM(micros) AS micros FROM provider_costs
                 WHERE workspace = ?1 AND day >= ?2
                 GROUP BY day, provider, item, currency ORDER BY day, provider, item LIMIT ?3",
            )
            .bind(&[
                workspace.as_str().into(),
                since.as_str().into(),
                ((MAX_ROWS + 1) as f64).into(),
            ])?
            .all()
            .await?
            .results::<DayRow>()?;
        let cut = rows.len() > MAX_ROWS;
        let days = rows
            .into_iter()
            .take(MAX_ROWS)
            .filter_map(|row| {
                Some(ProviderCostDay {
                    day: row.day,
                    provider: CostProvider::parse(&row.provider)?,
                    item: row.item,
                    micros: row.micros.unwrap_or(0.0) as i64,
                    // Stored as the cost report gave it (`USD`), or a
                    // provider's own unit.
                    unit: CostUnit::parse(&row.currency)?,
                })
            })
            .collect();
        let complete = !cut && complete(&connections, &since);
        Ok(Outcome::Ok(ProviderCosts {
            connections,
            days,
            complete,
        }))
    }

    /// Reads one connection's report and keeps it. A provider's refusal is
    /// kept on the connection; only a failure to write is an error. A
    /// provider with no cost report of its own is read per person only.
    async fn sync_connection(&self, row: &SealedRow, now: u64) -> Result<std::result::Result<usize, String>> {
        let Some(provider) = CostProvider::parse(&row.provider) else {
            return Ok(Err("Unknown provider.".to_owned()));
        };
        let problem = |message: String| async move {
            self.db
                .prepare("UPDATE provider_connections SET last_error = ?1 WHERE id = ?2")
                .bind(&[message.as_str().into(), row.id.as_str().into()])?
                .run()
                .await?;
            Ok::<_, worker::Error>(Err(message))
        };
        let Some(sealer) = &self.sealer else {
            return problem(NO_SEALER.to_owned()).await;
        };
        let Some(credential) = sealer.open(&row.credential, &row.id) else {
            return problem("g1t can't open the saved key. Connect the provider again.".to_owned()).await;
        };
        if !provider.has_cost_report() {
            return self.sync_people(row, provider, &credential, now).await;
        }
        let (from, until) = window(now, row.last_synced_at.as_deref());
        let page = match read_report(provider, &credential, &from, until).await {
            Ok(page) => page,
            Err(message) => return problem(message).await,
        };
        let (sums, other) = aggregate(&page.rows);
        let at = rfc3339(now);
        let days: BTreeSet<&String> = page.days.iter().collect();
        let mut statements = vec![];
        if let (Some(first), Some(last)) = (days.first(), days.last()) {
            statements.push(self.db.prepare(DELETE_DAYS).bind(&[
                row.workspace.as_str().into(),
                provider.name().into(),
                first.as_str().into(),
                last.as_str().into(),
            ])?);
        }
        for ((day, item, scope), micros) in &sums {
            statements.push(self.db.prepare(UPSERT_COST).bind(&[
                row.workspace.as_str().into(),
                provider.name().into(),
                day.as_str().into(),
                item.as_str().into(),
                scope.as_str().into(),
                (*micros as f64).into(),
                at.as_str().into(),
            ])?);
        }
        let written = sums.len();
        let mut statements = statements.into_iter().peekable();
        while statements.peek().is_some() {
            self.db.batch(statements.by_ref().take(BATCH).collect()).await?;
        }
        let note = if page.next.is_some() {
            Some(format!(
                "{} had more pages than g1t reads at once; the earliest days may be missing.",
                provider.label()
            ))
        } else if !other.is_empty() {
            let currencies: Vec<String> = other.into_iter().collect();
            Some(format!(
                "Some costs were reported in {}, not US dollars, and are left out.",
                currencies.join(", ")
            ))
        } else {
            None
        };
        // Reaching back further than before only once the provider said so.
        let from = days
            .first()
            .map_or(from.clone(), |first| (*first).clone().min(from.clone()));
        self.db
            .prepare(NOTE_SYNCED)
            .bind(&[
                at.as_str().into(),
                crate::optional(note.as_deref()),
                from.as_str().into(),
                row.id.as_str().into(),
            ])?
            .run()
            .await?;
        // The per-person report, with the same key. Its failing is kept on
        // the connection apart and never fails the cost report.
        match self.sync_people(row, provider, &credential, now).await {
            Ok(Ok(_)) => {}
            Ok(Err(message)) => {
                worker::console_error!("provider costs: {} {} people: {message}", row.workspace, row.provider)
            }
            Err(error) => {
                worker::console_error!(
                    "provider costs: {} {} people: writing failed: {error}",
                    row.workspace,
                    row.provider
                )
            }
        }
        Ok(match note {
            Some(note) => Err(note),
            None => Ok(written),
        })
    }

    /// Reads a provider's per-person report over the same window as the
    /// cost report (counted from the last good read of this report), and
    /// keeps it: each day read replaces that day, its conversations too.
    /// A provider with no cost report of its own also keeps each day's
    /// total per model as its cost report, and its read's state as the
    /// connection's. A refusal is kept in `people_error` and the days read
    /// before it are kept, but the read doesn't count as done, so the next
    /// one reaches back again.
    async fn sync_people(
        &self,
        row: &SealedRow,
        provider: CostProvider,
        credential: &str,
        now: u64,
    ) -> Result<std::result::Result<usize, String>> {
        let (from, until) = window(now, row.people_synced_at.as_deref());
        let read = match provider {
            CostProvider::Anthropic => read_claude_code(credential, &from, until).await,
            _ => crate::provider_people::read_people(provider, credential, &from, until).await,
        };
        let own_report = !provider.has_cost_report();
        let at = rfc3339(now);
        let name = provider.name();
        let workspace = row.workspace.as_str();
        let mut statements = vec![];
        for day in &read.days {
            let bind = || -> Vec<worker::wasm_bindgen::JsValue> { vec![workspace.into(), name.into(), day.as_str().into()] };
            statements.push(self.db.prepare(DELETE_PERSON_DAY).bind(&bind())?);
            statements.push(self.db.prepare(DELETE_CONVERSATION_DAY).bind(&bind())?);
            if own_report {
                statements.push(self.db.prepare(DELETE_DAYS).bind(&[
                    workspace.into(),
                    name.into(),
                    day.as_str().into(),
                    day.as_str().into(),
                ])?);
            }
        }
        let days: HashSet<&String> = read.days.iter().collect();
        let rows: Vec<&PersonRow> = read.rows.iter().filter(|cost| days.contains(&cost.day)).collect();
        for cost in &rows {
            statements.push(self.db.prepare(UPSERT_PERSON_COST).bind(&[
                workspace.into(),
                name.into(),
                cost.day.as_str().into(),
                cost.kind.name().into(),
                cost.actor.as_str().into(),
                cost.harness.as_str().into(),
                cost.model.as_str().into(),
                (cost.micros as f64).into(),
                f64::from(cost.sessions).into(),
                cost.customer_type.as_str().into(),
                at.as_str().into(),
                cost.unit.name().into(),
                f64::from(u8::from(cost.list_price)).into(),
            ])?);
        }
        for conversation in read.conversations.iter().filter(|c| days.contains(&c.day)) {
            statements.push(self.db.prepare(UPSERT_CONVERSATION).bind(&[
                workspace.into(),
                name.into(),
                conversation.day.as_str().into(),
                conversation.kind.name().into(),
                conversation.actor.as_str().into(),
                conversation.conversation.as_str().into(),
                (conversation.micros as f64).into(),
                f64::from(conversation.events).into(),
                at.as_str().into(),
            ])?);
        }
        if own_report {
            for ((day, model, unit), micros) in organization_days(&rows) {
                statements.push(self.db.prepare(UPSERT_COST_IN).bind(&[
                    workspace.into(),
                    name.into(),
                    day.as_str().into(),
                    model.as_str().into(),
                    (micros as f64).into(),
                    unit.name().to_uppercase().into(),
                    at.as_str().into(),
                ])?);
            }
        }
        let written = rows.len();
        let mut statements = statements.into_iter().peekable();
        while statements.peek().is_some() {
            self.db.batch(statements.by_ref().take(BATCH).collect()).await?;
        }
        if let Some(problem) = read.problem {
            let sql = if own_report {
                "UPDATE provider_connections SET people_error = ?1, last_error = ?1 WHERE id = ?2"
            } else {
                "UPDATE provider_connections SET people_error = ?1 WHERE id = ?2"
            };
            self.db
                .prepare(sql)
                .bind(&[problem.as_str().into(), row.id.as_str().into()])?
                .run()
                .await?;
            return Ok(Err(problem));
        }
        // The first day read: where a read cut short stopped.
        let first = read.days.iter().min().cloned().unwrap_or(from);
        let mut notes = vec![NOTE_PEOPLE_SYNCED];
        if own_report {
            notes.push(NOTE_SYNCED);
        }
        for sql in notes {
            self.db
                .prepare(sql)
                .bind(&[
                    at.as_str().into(),
                    crate::optional(read.note.as_deref()),
                    first.as_str().into(),
                    row.id.as_str().into(),
                ])?
                .run()
                .await?;
        }
        Ok(match read.note {
            Some(note) => Err(note),
            None => Ok(written),
        })
    }

    /// Every connection's report, read again: once a day. Each provider on
    /// its own, one at a time; one failing never stops the rest. Returns
    /// how many were read and how many failed.
    pub(crate) async fn sync_provider_costs(&self) -> Result<(u32, u32)> {
        let rows = self
            .db
            .prepare(
                "SELECT id, workspace, provider, credential, last_synced_at, people_synced_at FROM provider_connections
                 ORDER BY last_synced_at",
            )
            .all()
            .await?
            .results::<SealedRow>()?;
        let (mut read, mut failed) = (0, 0);
        let now = now_ms();
        for row in &rows {
            match self.sync_connection(row, now).await {
                Ok(Ok(_)) => read += 1,
                Ok(Err(message)) => {
                    failed += 1;
                    worker::console_error!("provider costs: {} {}: {message}", row.workspace, row.provider);
                }
                Err(error) => {
                    failed += 1;
                    worker::console_error!(
                        "provider costs: {} {}: writing failed: {error}",
                        row.workspace,
                        row.provider
                    );
                }
            }
        }
        Ok((read, failed))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The response example in Anthropic's Get Cost Report reference
    /// (platform.claude.com/docs/en/api/beta/organization/cost_report/retrieve).
    const ANTHROPIC_EXAMPLE: &str = r#"{
      "data": [
        {
          "ending_at": "2025-08-02T00:00:00Z",
          "results": [
            {
              "amount": "123.78912",
              "context_window": "0-200k",
              "cost_type": "tokens",
              "currency": "USD",
              "description": "Claude Opus 5.5 Usage - Input Tokens",
              "inference_geo": "global",
              "model": "claude-opus-5-5",
              "service_tier": "standard",
              "speed": "standard",
              "token_type": "cache_creation.ephemeral_1h_input_tokens",
              "workspace_id": "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ"
            }
          ],
          "starting_at": "2025-08-01T00:00:00Z"
        }
      ],
      "has_more": true,
      "next_page": "page_MjAyNS0wNS0xNFQwMDowMDowMFo="
    }"#;

    /// The response example for GET /v1/organization/costs in OpenAI's
    /// OpenAPI description (github.com/openai/openai-openapi).
    const OPENAI_EXAMPLE: &str = r#"{
        "object": "page",
        "data": [
            {
                "object": "bucket",
                "start_time": 1730419200,
                "end_time": 1730505600,
                "results": [
                    {
                        "object": "organization.costs.result",
                        "amount": {
                            "value": 0.06,
                            "currency": "usd"
                        },
                        "line_item": null,
                        "project_id": null
                    }
                ]
            }
        ],
        "has_more": false,
        "next_page": null
    }"#;

    fn user(role: &str, kind: &str) -> User {
        serde_json::from_value(json!({
            "id": "usr_1", "username": "ada", "kind": kind, "verified": true,
            "workspaces": [{ "slug": "acme", "role": role }],
        }))
        .unwrap()
    }

    #[test]
    fn anthropics_documented_report_reads_as_cents_by_day() {
        let page = parse_anthropic(&serde_json::from_str(ANTHROPIC_EXAMPLE).unwrap()).unwrap();
        assert_eq!(page.days, ["2025-08-01"]);
        assert_eq!(
            page.rows,
            [CostRow {
                day: "2025-08-01".into(),
                item: "Claude Opus 5.5 Usage - Input Tokens".into(),
                scope: "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ".into(),
                // 123.78912 cents is $1.2378912.
                micros: 1_237_891,
                currency: "USD".into(),
            }]
        );
        assert_eq!(page.next.as_deref(), Some("page_MjAyNS0wNS0xNFQwMDowMDowMFo="));
        // The default workspace is null, and the last page has no token.
        let last = parse_anthropic(&json!({
            "data": [{ "starting_at": "2025-08-02T00:00:00Z", "ending_at": "2025-08-03T00:00:00Z", "results": [] },
                     { "starting_at": "2025-08-03T00:00:00Z", "ending_at": "2025-08-04T00:00:00Z",
                       "results": [{ "amount": "50", "currency": "USD", "description": null, "workspace_id": null, "cost_type": "web_search" }] }],
            "has_more": false, "next_page": null,
        }))
        .unwrap();
        assert_eq!(last.days, ["2025-08-02", "2025-08-03"]);
        assert_eq!(last.rows[0].scope, "");
        assert_eq!(last.rows[0].item, "web_search");
        assert_eq!(last.rows[0].micros, 500_000);
        assert_eq!(last.next, None);
        assert!(parse_anthropic(&json!({ "error": { "type": "authentication_error" } })).is_err());
    }

    #[test]
    fn openais_documented_costs_read_as_dollars_by_day() {
        let page = parse_openai(&serde_json::from_str(OPENAI_EXAMPLE).unwrap()).unwrap();
        // 1730419200 is 2024-11-01 00:00 UTC.
        assert_eq!(page.days, ["2024-11-01"]);
        assert_eq!(
            page.rows,
            [CostRow {
                day: "2024-11-01".into(),
                item: "".into(),
                scope: "".into(),
                micros: 60_000,
                currency: "usd".into()
            }]
        );
        assert_eq!(page.next, None);
        // The schema names the list `result`; grouped, a line item and a project.
        let grouped = parse_openai(&json!({
            "object": "page",
            "data": [{ "object": "bucket", "start_time": 1730419200, "end_time": 1730505600,
                       "result": [{ "object": "organization.costs.result", "amount": { "value": 1.5, "currency": "usd" },
                                    "line_item": "Image models", "project_id": "proj_abc" }] }],
            "has_more": true, "next_page": "page_2",
        }))
        .unwrap();
        assert_eq!(grouped.rows[0].item, "Image models");
        assert_eq!(grouped.rows[0].scope, "proj_abc");
        assert_eq!(grouped.rows[0].micros, 1_500_000);
        assert_eq!(grouped.next.as_deref(), Some("page_2"));
    }

    #[test]
    fn cents_become_millionths_exactly() {
        assert_eq!(cents_to_micros("123.45"), Some(1_234_500));
        assert_eq!(cents_to_micros("0.00005"), Some(1));
        assert_eq!(cents_to_micros("0.00004"), Some(0));
        assert_eq!(cents_to_micros("7"), Some(70_000));
        assert_eq!(cents_to_micros(".5"), Some(5_000));
        assert_eq!(cents_to_micros("-12.5"), Some(-125_000));
        assert_eq!(cents_to_micros("1e3"), None);
        assert_eq!(cents_to_micros(""), None);
        assert_eq!(dollars_to_micros(0.06), Some(60_000));
        assert_eq!(dollars_to_micros(f64::NAN), None);
    }

    #[test]
    fn costs_are_summed_by_day_item_and_scope_in_dollars_only() {
        let row = |item: &str, micros: i64, currency: &str| CostRow {
            day: "2026-10-01".into(),
            item: item.into(),
            scope: "".into(),
            micros,
            currency: currency.into(),
        };
        let (sums, other) = aggregate(&[
            row("Opus input", 10, "USD"),
            row("Opus input", 5, "USD"),
            row("Opus output", 7, "usd"),
            row("x", 9, "eur"),
        ]);
        assert_eq!(sums.len(), 2);
        assert_eq!(sums[&("2026-10-01".into(), "Opus input".into(), "".into())], 15);
        assert_eq!(other.into_iter().collect::<Vec<_>>(), ["EUR"]);
    }

    #[test]
    fn a_read_asks_for_recent_days_again_and_ninety_the_first_time() {
        let now = parse_rfc3339("2026-10-18T09:30:00.000Z").unwrap();
        let (from, until) = window(now, None);
        assert_eq!(from, "2026-07-21");
        assert_eq!(rfc3339(until), "2026-10-19T00:00:00.000Z");
        assert_eq!(window(now, Some("2026-10-17T04:17:00.000Z")).0, "2026-10-12");
        // Reads failing since the 1st: from the day before it.
        assert_eq!(window(now, Some("2026-10-01T04:17:00.000Z")).0, "2026-09-30");
        // Never more than 90 days.
        assert_eq!(window(now, Some("2025-01-01T00:00:00.000Z")).0, "2026-07-21");
    }

    #[test]
    fn report_requests_follow_the_documented_parameters() {
        let until = parse_rfc3339("2026-10-19T00:00:00.000Z").unwrap();
        assert_eq!(
            anthropic_url("2026-10-12", until, None),
            "https://api.anthropic.com/v1/organizations/cost_report?starting_at=2026-10-12T00:00:00Z&ending_at=2026-10-19T00%3A00%3A00Z&bucket_width=1d&group_by%5B%5D=workspace_id&group_by%5B%5D=description&limit=31"
        );
        assert!(anthropic_url("2026-10-12", until, Some("page_a=")).ends_with("&page=page_a%3D"));
        assert_eq!(
            openai_url("2024-11-01", until, None),
            "https://api.openai.com/v1/organization/costs?start_time=1730419200&end_time=1792368000&bucket_width=1d&group_by=line_item&group_by=project_id&limit=180"
        );
        let now = parse_rfc3339("2026-10-18T09:30:00.000Z").unwrap();
        assert!(
            check_url(CostProvider::Anthropic, now)
                .unwrap()
                .contains("starting_at=2026-10-17T00%3A00%3A00Z&ending_at=2026-10-18T00%3A00%3A00Z")
        );
        assert!(check_url(CostProvider::Openai, now).unwrap().ends_with("&limit=1"));
        // Cursor, Amp and Devin have no cost report: they are checked per person.
        assert!(check_url(CostProvider::Cursor, now).is_none());
    }

    #[test]
    fn the_wrong_kind_of_key_is_named_before_anything_is_sent() {
        assert!(
            precheck(CostProvider::Anthropic, "sk-ant-api03-abcd")
                .unwrap_err()
                .contains("Admin API key")
        );
        assert!(precheck(CostProvider::Anthropic, "sk-ant-admin01-abcd").is_ok());
        assert!(
            precheck(CostProvider::Openai, "sk-proj-abcd")
                .unwrap_err()
                .contains("admin key")
        );
        assert!(
            precheck(CostProvider::Openai, "sk-ant-admin01-abcd")
                .unwrap_err()
                .contains("Anthropic")
        );
        assert!(precheck(CostProvider::Openai, "sk-admin-abcd").is_ok());
        assert!(precheck(CostProvider::Openai, "").is_err());
        assert!(precheck(CostProvider::Openai, "sk-admin abcd").is_err());
        assert!(precheck(CostProvider::Cursor, "crsr_abcd").is_ok());
        assert!(precheck(CostProvider::Cursor, "sk-admin-abcd").unwrap_err().contains("crsr_"));
        // Amp takes the application's client ID and secret, both.
        assert!(precheck(CostProvider::Amp, "client_1:secret").is_ok());
        assert!(precheck(CostProvider::Amp, "secret").unwrap_err().contains("client ID and client secret"));
        assert!(precheck(CostProvider::Devin, "cog_abcd").is_ok());
        assert!(precheck(CostProvider::Devin, "sk-ant-admin01-abcd").is_err());
    }

    #[test]
    fn a_refusal_says_why_and_never_repeats_the_key() {
        let key = "sk-ant-admin01-SECRETSECRETwxyz";
        let body =
            json!({ "error": { "type": "authentication_error", "message": format!("invalid x-api-key {key}") } });
        let said = explain(CostProvider::Anthropic, 401, &body, key);
        assert!(
            said.starts_with("Anthropic didn't accept this key. Use an Admin API key"),
            "{said}"
        );
        assert!(!said.contains("SECRET"), "{said}");
        assert!(said.contains("…wxyz"), "{said}");
        assert!(explain(CostProvider::Openai, 403, &Value::Null, key).contains("not a project or user API key"));
        assert!(explain(CostProvider::Openai, 429, &body, key).contains("tries again"));
        assert!(!explain(CostProvider::Openai, 503, &body, key).contains("SECRET"));
        // Each provider's own wording of an error is read, key scrubbed.
        let cursor = json!({ "error": "Forbidden", "message": format!("Enterprise access required for {key}") });
        let said = explain(CostProvider::Cursor, 403, &cursor, key);
        assert!(said.contains("Enterprise") && said.contains("Cursor said: Enterprise access required"), "{said}");
        assert!(!said.contains("SECRET"), "{said}");
        let amp = json!({ "error": "Forbidden: missing client scope(s)" });
        assert!(explain(CostProvider::Amp, 403, &amp, key).ends_with("Amp said: Forbidden: missing client scope(s)"));
        assert!(explain(CostProvider::Devin, 401, &json!({ "detail": "bad key" }), key).contains("cog_"));
    }

    #[test]
    fn only_an_owner_as_a_person_connects_a_provider() {
        assert!(owner_only::<()>(&user("owner", "user"), "acme").is_none());
        assert!(
            matches!(owner_only::<()>(&user("member", "user"), "acme"), Some(Outcome::Fail(failure)) if failure.code == FailureCode::Forbidden)
        );
        assert!(owner_only::<()>(&user("owner", "workspace"), "acme").is_some());
        assert!(owner_only::<()>(&user("owner", "user"), "other").is_some());
    }

    #[test]
    fn no_answer_carries_the_key() {
        let key = "sk-admin-SECRETSECRETwxyz";
        // The list never selects it.
        assert!(!LIST_SQL.contains("credential"));
        // What is stored is sealed.
        let sealer = g1t_secrets::Sealer::new(&"ab".repeat(32)).unwrap();
        let sealed = sealer.seal(key, "pcn_1");
        assert!(!sealed.contains("SECRET"));
        // A connection, a list and the costs, as sent.
        let connection = to_connection(ListedRow {
            provider: "openai".into(),
            hint: g1t_secrets::hint(key),
            connected_by: "ada".into(),
            connected_at: "2026-10-18T00:00:00.000Z".into(),
            last_synced_at: None,
            last_error: Some(explain(
                CostProvider::Openai,
                401,
                &json!({ "error": { "message": key } }),
                key,
            )),
            synced_from: None,
        })
        .unwrap();
        let costs = ProviderCosts {
            connections: vec![connection.clone()],
            days: vec![],
            complete: false,
        };
        for json in [
            serde_json::to_string(&connection).unwrap(),
            serde_json::to_string(&costs).unwrap(),
        ] {
            assert!(!json.contains("SECRET"), "{json}");
            assert!(!json.contains("credential"), "{json}");
        }
        assert_eq!(connection.hint, "…wxyz");
        // And the arguments, logged, name it only as redacted.
        let args = ConnectProviderArgs {
            actor: user("owner", "user"),
            workspace: "acme".into(),
            provider: CostProvider::Openai,
            credential: key.into(),
        };
        assert!(!format!("{args:?}").contains("SECRET"));
    }

    #[test]
    fn costs_are_complete_only_when_every_provider_has_read_back_far_enough() {
        let connection = |from: Option<&str>, error: Option<&str>| ProviderConnection {
            provider: CostProvider::Anthropic,
            hint: "…abcd".into(),
            connected_by: "ada".into(),
            connected_at: "2026-10-01T00:00:00.000Z".into(),
            last_synced_at: Some("2026-10-18T04:17:00.000Z".into()),
            last_error: error.map(str::to_owned),
            synced_from: from.map(str::to_owned),
        };
        assert!(!complete(&[], "2026-10-01"));
        assert!(complete(&[connection(Some("2026-07-21"), None)], "2026-10-01"));
        assert!(!complete(&[connection(Some("2026-10-05"), None)], "2026-10-01"));
        assert!(!complete(
            &[connection(Some("2026-07-21"), Some("Anthropic didn't answer"))],
            "2026-10-01"
        ));
    }

    #[test]
    fn a_read_replaces_its_days_and_reading_twice_changes_nothing() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch(include_str!("../migrations/0067_provider_costs.sql"))
            .unwrap();
        let write = |day: &str, item: &str, micros: i64, at: &str| {
            db.execute(
                UPSERT_COST,
                rusqlite::params!["acme", "anthropic", day, item, "", micros, at],
            )
            .unwrap();
        };
        let read = || -> Vec<(String, String, i64)> {
            let mut statement = db
                .prepare("SELECT day, item, micros FROM provider_costs ORDER BY day, item")
                .unwrap();
            statement
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap()
                .map(Result::unwrap)
                .collect()
        };
        write("2026-10-16", "Opus input", 100, "t1");
        write("2026-10-17", "Opus input", 200, "t1");
        write("2026-10-17", "Opus output", 50, "t1");
        // The same read again: the same rows.
        write("2026-10-17", "Opus input", 200, "t1");
        assert_eq!(read().len(), 3);
        // The provider revised the 17th: the output line went away and the
        // input grew. The 16th is outside this read and stays.
        db.execute(
            DELETE_DAYS,
            rusqlite::params!["acme", "anthropic", "2026-10-17", "2026-10-18"],
        )
        .unwrap();
        write("2026-10-17", "Opus input", 250, "t2");
        assert_eq!(
            read(),
            [
                ("2026-10-16".into(), "Opus input".into(), 100),
                ("2026-10-17".into(), "Opus input".into(), 250)
            ]
        );
        // A successful read moves the first day back, never forward.
        db.execute(
            "INSERT INTO provider_connections (id, workspace, provider, credential, hint, connected_by, connected_at) VALUES ('pcn_1', 'acme', 'anthropic', 'v1:x', '…abcd', 'ada', 't0')",
            [],
        )
        .unwrap();
        let note = |from: &str| {
            db.execute(
                NOTE_SYNCED,
                rusqlite::params!["t3", Option::<String>::None, from, "pcn_1"],
            )
            .unwrap();
            db.query_row("SELECT synced_from FROM provider_connections", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap()
        };
        assert_eq!(note("2026-07-21"), "2026-07-21");
        assert_eq!(note("2026-10-12"), "2026-07-21");
        // One connection per workspace and provider.
        assert!(db
            .execute(
                "INSERT INTO provider_connections (id, workspace, provider, credential, hint, connected_by, connected_at) VALUES ('pcn_2', 'acme', 'anthropic', 'v1:y', '…efgh', 'ada', 't4')",
                [],
            )
            .is_err());
    }

    /// A page shaped as the response in Anthropic's Claude Code Analytics
    /// API reference (platform.claude.com/docs/en/manage-claude/claude-code-analytics-api),
    /// with one person's remote and local use as the two rows they come
    /// back as, two models between them, and an API key.
    const CLAUDE_CODE_EXAMPLE: &str = r#"{
      "data": [
        {
          "date": "2025-09-01T00:00:00Z",
          "actor": { "type": "user_actor", "email_address": "Developer@Company.com" },
          "organization_id": "dc9f6c26-b22c-4831-8d01-0446bada88f1",
          "customer_type": "api",
          "subscription_type": null,
          "is_remote": false,
          "terminal_type": "vscode",
          "core_metrics": {
            "num_sessions": 5,
            "lines_of_code": { "added": 1543, "removed": 892 },
            "commits_by_claude_code": 12,
            "pull_requests_by_claude_code": 2
          },
          "tool_actions": {
            "edit_tool": { "accepted": 45, "rejected": 5 },
            "multi_edit_tool": { "accepted": 12, "rejected": 2 },
            "write_tool": { "accepted": 8, "rejected": 1 },
            "notebook_edit_tool": { "accepted": 3, "rejected": 0 }
          },
          "model_breakdown": [
            {
              "model": "claude-sonnet-4-5",
              "tokens": { "input": 100000, "output": 35000, "cache_read": 10000, "cache_creation": 5000 },
              "estimated_cost": { "currency": "USD", "amount": 186 }
            },
            {
              "model": "claude-opus-5-5",
              "tokens": { "input": 20000, "output": 5000, "cache_read": 0, "cache_creation": 0 },
              "estimated_cost": { "currency": "USD", "amount": 50.5 }
            }
          ]
        },
        {
          "date": "2025-09-01T00:00:00Z",
          "actor": { "type": "user_actor", "email_address": "developer@company.com" },
          "organization_id": "dc9f6c26-b22c-4831-8d01-0446bada88f1",
          "customer_type": "subscription",
          "subscription_type": "team",
          "is_remote": true,
          "terminal_type": "web",
          "core_metrics": {
            "num_sessions": 2,
            "lines_of_code": { "added": 10, "removed": 0 },
            "commits_by_claude_code": 1,
            "pull_requests_by_claude_code": 0
          },
          "tool_actions": {},
          "model_breakdown": [
            {
              "model": "claude-sonnet-4-5",
              "tokens": { "input": 1000, "output": 500, "cache_read": 0, "cache_creation": 0 },
              "estimated_cost": { "currency": "USD", "amount": 14 }
            }
          ]
        },
        {
          "date": "2025-09-01T00:00:00Z",
          "actor": { "type": "api_actor", "api_key_name": "ci-bot" },
          "organization_id": "dc9f6c26-b22c-4831-8d01-0446bada88f1",
          "customer_type": "api",
          "subscription_type": null,
          "is_remote": false,
          "terminal_type": "non-interactive",
          "core_metrics": { "num_sessions": 3, "lines_of_code": { "added": 0, "removed": 0 }, "commits_by_claude_code": 0, "pull_requests_by_claude_code": 0 },
          "tool_actions": {},
          "model_breakdown": [
            {
              "model": "claude-haiku-4-5",
              "tokens": { "input": 500, "output": 100, "cache_read": 0, "cache_creation": 0 },
              "estimated_cost": { "currency": "USD", "amount": 3 }
            }
          ]
        }
      ],
      "has_more": true,
      "next_page": "page_MjAyNS0wNS0xNFQwMDowMDowMFo="
    }"#;

    fn manager(role: &str, billing: bool) -> User {
        let roles: Vec<&str> = if billing { vec!["billing_manager"] } else { vec![] };
        serde_json::from_value(json!({
            "id": "usr_1", "username": "ada", "kind": "user", "verified": true,
            "workspaces": [{ "slug": "acme", "role": role, "org_roles": roles }],
        }))
        .unwrap()
    }

    #[test]
    fn claude_codes_documented_report_reads_per_actor_and_model() {
        let page = parse_claude_code(&serde_json::from_str(CLAUDE_CODE_EXAMPLE).unwrap()).unwrap();
        assert_eq!(page.uses.len(), 3);
        assert_eq!(page.uses[0].day, "2025-09-01");
        assert_eq!(page.uses[0].kind, ActorKind::User);
        // Addresses are kept lowercased, as identity matches them.
        assert_eq!(page.uses[0].actor, "developer@company.com");
        assert_eq!(page.uses[0].sessions, 5);
        // 186 cents is $1.86; half a cent reads exactly.
        assert_eq!(
            page.uses[0].models,
            [
                ("claude-sonnet-4-5".to_owned(), 1_860_000, "USD".to_owned()),
                ("claude-opus-5-5".to_owned(), 505_000, "USD".to_owned())
            ]
        );
        assert_eq!((page.uses[2].kind, page.uses[2].actor.as_str()), (ActorKind::ApiKey, "ci-bot"));
        assert_eq!(page.next.as_deref(), Some("page_MjAyNS0wNS0xNFQwMDowMDowMFo="));

        // Remote and local use add up, per model; the day's 7 sessions sit
        // on its first model only.
        let (costs, other) = aggregate_people(&page.uses);
        assert!(other.is_empty());
        let row = |kind, actor: &str, model: &str, micros, sessions, customer_type: &str| PersonCost {
            day: "2025-09-01".into(),
            kind,
            actor: actor.into(),
            model: model.into(),
            micros,
            sessions,
            customer_type: customer_type.into(),
        };
        assert_eq!(
            costs,
            [
                row(ActorKind::User, "developer@company.com", "claude-opus-5-5", 505_000, 7, "api,subscription"),
                row(ActorKind::User, "developer@company.com", "claude-sonnet-4-5", 2_000_000, 0, "api,subscription"),
                row(ActorKind::ApiKey, "ci-bot", "claude-haiku-4-5", 30_000, 3, "api"),
            ]
        );
        assert_eq!(costs.iter().map(|c| c.sessions).sum::<u32>(), 10);

        // Sessions without a cost are kept on a row of their own; an actor
        // g1t doesn't know, or a cost in another currency, is left out.
        let odd = parse_claude_code(&json!({
            "data": [
                { "date": "2025-09-02T00:00:00Z", "actor": { "type": "user_actor", "email_address": "bo@example.com" },
                  "customer_type": "subscription", "core_metrics": { "num_sessions": 1 }, "model_breakdown": [] },
                { "date": "2025-09-02T00:00:00Z", "actor": { "type": "robot_actor", "name": "x" },
                  "core_metrics": { "num_sessions": 9 }, "model_breakdown": [] },
                { "date": "2025-09-02T00:00:00Z", "actor": { "type": "api_actor", "api_key_name": "eu" },
                  "core_metrics": { "num_sessions": 0 },
                  "model_breakdown": [{ "model": "m", "estimated_cost": { "currency": "EUR", "amount": 5 } }] }
            ],
            "has_more": false, "next_page": null,
        }))
        .unwrap();
        assert_eq!(odd.uses.len(), 2);
        assert_eq!(odd.next, None);
        let (costs, other) = aggregate_people(&odd.uses);
        assert_eq!(costs, [PersonCost {
            day: "2025-09-02".into(),
            kind: ActorKind::User,
            actor: "bo@example.com".into(),
            model: "".into(),
            micros: 0,
            sessions: 1,
            customer_type: "subscription".into(),
        }]);
        assert_eq!(other.into_iter().collect::<Vec<_>>(), ["EUR"]);
        assert!(parse_claude_code(&json!({ "error": { "type": "not_found_error" } })).is_err());
    }

    #[test]
    fn the_claude_code_report_is_asked_for_a_day_at_a_time_newest_first() {
        assert_eq!(
            claude_code_url("2026-10-12", None),
            "https://api.anthropic.com/v1/organizations/usage_report/claude_code?starting_at=2026-10-12&limit=1000"
        );
        assert!(claude_code_url("2026-10-12", Some("page_a=")).ends_with("&limit=1000&page=page_a%3D"));
        // The cost report's window: 7 days most days, 90 the first time.
        let now = parse_rfc3339("2026-10-18T09:30:00.000Z").unwrap();
        let (from, until) = window(now, Some("2026-10-17T04:17:00.000Z"));
        assert_eq!(
            days_back(&from, until),
            ["2026-10-18", "2026-10-17", "2026-10-16", "2026-10-15", "2026-10-14", "2026-10-13", "2026-10-12"]
        );
        let (from, until) = window(now, None);
        let first = days_back(&from, until);
        assert_eq!(first.len(), 90);
        assert_eq!(first.last().map(String::as_str), Some("2026-07-21"));
        assert!(days_back("nonsense", until).is_empty());
    }

    #[test]
    fn no_claude_code_report_says_so_without_touching_the_cost_report() {
        let key = "sk-ant-admin01-SECRETSECRETwxyz";
        let body = json!({ "error": { "type": "permission_error", "message": format!("no access for {key}") } });
        for status in [403, 404] {
            let said = explain_people(status, &body, key);
            assert!(said.contains("no Claude Code usage report"), "{said}");
            assert!(said.contains("cost report is read as before"), "{said}");
            assert!(!said.contains("SECRET"), "{said}");
        }
        // Anything else as the cost report's refusals, key scrubbed.
        assert!(explain_people(401, &body, key).starts_with("Anthropic didn't accept this key"));
        assert!(!explain_people(401, &body, key).contains("SECRET"));
        assert!(explain_people(429, &body, key).contains("tries again"));
    }

    #[test]
    fn a_person_sees_their_own_and_a_billing_manager_anyones() {
        let member = manager("member", false);
        let billing = manager("member", true);
        let owner = manager("owner", false);
        // Their own: nobody named, or themselves.
        assert_eq!(whose(Some(&member), "acme", None), Ok("usr_1"));
        assert_eq!(whose(Some(&member), "acme", Some("  ")), Ok("usr_1"));
        assert_eq!(whose(Some(&member), "acme", Some("usr_1")), Ok("usr_1"));
        // Someone else's: an owner or a billing manager only.
        assert_eq!(whose(Some(&member), "acme", Some("usr_2")), Err(OWN_ONLY));
        assert_eq!(whose(Some(&billing), "acme", Some("usr_2")), Ok("usr_2"));
        assert_eq!(whose(Some(&owner), "acme", Some("usr_2")), Ok("usr_2"));
        // Not a member, or nobody: nothing at all.
        assert_eq!(whose(Some(&owner), "other", None), Err(MEMBERS_ONLY));
        assert_eq!(whose(None, "acme", None), Err(MEMBERS_ONLY));
    }

    #[test]
    fn what_matches_nobody_counts_keys_and_unconfirmed_addresses() {
        let actor = |kind: &str, actor: &str, micros: f64| ActorTotal {
            actor_kind: kind.into(),
            actor: actor.into(),
            unit: "usd".into(),
            micros: Some(micros),
        };
        let actors = [
            actor("user", "ada@example.com", 2_000_000.0),
            actor("user", "stranger@example.com", 500_000.0),
            actor("api_key", "ci-bot", 30_000.0),
            // An API key named like a member's address is still a key.
            actor("api_key", "ada@example.com", 1.0),
            // Sessions without a cost aren't counted.
            actor("user", "idle@example.com", 0.0),
        ];
        let linked: HashSet<String> = ["ada@example.com".to_owned()].into();
        assert_eq!(unlinked(&actors, &linked), (530_001, 3));
        // The same address at a second provider counts once; credits are
        // not dollars, and are left out.
        let mut more = actors.to_vec();
        more.push(actor("user", "stranger@example.com", 100.0));
        more.push(ActorTotal { unit: "credits".into(), ..actor("user", "credits@example.com", 9_000_000.0) });
        assert_eq!(unlinked(&more, &linked), (530_101, 3));
        assert_eq!(unlinked(&actors, &HashSet::new()), (2_530_001, 4));
        assert_eq!(unlinked(&[], &linked), (0, 0));
    }

    #[test]
    fn a_persons_days_add_their_addresses_and_count_sessions_once() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch(include_str!("../migrations/0067_provider_costs.sql"))
            .unwrap();
        db.execute_batch(include_str!("../migrations/0068_provider_person_costs.sql"))
            .unwrap();
        db.execute_batch(include_str!("../migrations/0069_provider_people.sql"))
            .unwrap();
        let write = |cost: &PersonCost, at: &str| {
            db.execute(
                UPSERT_PERSON_COST,
                rusqlite::params![
                    "acme",
                    "anthropic",
                    cost.day,
                    cost.kind.name(),
                    cost.actor,
                    CLAUDE_CODE,
                    cost.model,
                    cost.micros,
                    cost.sessions,
                    cost.customer_type,
                    at,
                    "usd",
                    0
                ],
            )
            .unwrap();
        };
        let page = parse_claude_code(&serde_json::from_str(CLAUDE_CODE_EXAMPLE).unwrap()).unwrap();
        let (costs, _) = aggregate_people(&page.uses);
        for cost in &costs {
            write(cost, "t1");
        }
        // The same person under a second address, the next day, and someone
        // else.
        let more = |day: &str, actor: &str, model: &str, micros: i64, sessions: u32| PersonCost {
            day: day.into(),
            kind: ActorKind::User,
            actor: actor.into(),
            model: model.into(),
            micros,
            sessions,
            customer_type: "subscription".into(),
        };
        write(&more("2025-09-01", "dev@home.example", "claude-opus-5-5", 100_000, 4), "t1");
        write(&more("2025-09-02", "developer@company.com", "claude-opus-5-5", 70_000, 1), "t1");
        write(&more("2025-09-02", "other@company.com", "claude-opus-5-5", 9_000_000, 2), "t1");
        // Writing the same read again changes nothing.
        for cost in &costs {
            write(cost, "t1");
        }
        let days = |since: &str, until: &str, emails: &[&str]| -> Vec<(String, String, String, i64, i64)> {
            let mut statement = db.prepare(PERSON_DAYS).unwrap();
            statement
                .query_map(
                    rusqlite::params!["acme", since, until, serde_json::to_string(emails).unwrap(), 1000],
                    |r| Ok((r.get(0)?, r.get(2)?, r.get(3)?, r.get(6)?, r.get(7)?)),
                )
                .unwrap()
                .map(Result::unwrap)
                .collect()
        };
        let theirs = ["developer@company.com", "dev@home.example"];
        assert_eq!(
            days("2025-09-01", "2025-09-02", &theirs),
            [
                ("2025-09-01".into(), "claude_code".into(), "claude-opus-5-5".into(), 605_000, 11),
                ("2025-09-01".into(), "claude_code".into(), "claude-sonnet-4-5".into(), 2_000_000, 0),
                ("2025-09-02".into(), "claude_code".into(), "claude-opus-5-5".into(), 70_000, 1),
            ]
        );
        // The span holds: the 2nd only. An API key never counts as a person.
        assert_eq!(days("2025-09-02", "2025-09-02", &theirs).len(), 1);
        assert!(days("2025-09-01", "2025-09-02", &["ci-bot"]).is_empty());

        // Each actor's total, for matching and for what matched nobody.
        let totals: Vec<ActorTotal> = {
            let mut statement = db.prepare(&format!("{ACTOR_TOTALS} ORDER BY actor_kind, actor")).unwrap();
            statement
                .query_map(rusqlite::params!["acme", "2025-09-01", "2025-09-02"], |r| {
                    Ok(ActorTotal {
                        actor_kind: r.get(1)?,
                        actor: r.get(2)?,
                        unit: r.get(3)?,
                        micros: Some(r.get::<_, i64>(4)? as f64),
                    })
                })
                .unwrap()
                .map(Result::unwrap)
                .collect()
        };
        assert_eq!(totals.len(), 4);
        let linked: HashSet<String> = theirs.iter().map(|e| e.to_string()).collect();
        assert_eq!(unlinked(&totals, &linked), (9_030_000, 2));

        // The provider revised the 1st: one day's rows replaced, the 2nd kept.
        db.execute(DELETE_PERSON_DAY, rusqlite::params!["acme", "anthropic", "2025-09-01"])
            .unwrap();
        write(&more("2025-09-01", "developer@company.com", "claude-opus-5-5", 1, 1), "t2");
        assert_eq!(
            days("2025-09-01", "2025-09-02", &theirs),
            [
                ("2025-09-01".into(), "claude_code".into(), "claude-opus-5-5".into(), 1, 1),
                ("2025-09-02".into(), "claude_code".into(), "claude-opus-5-5".into(), 70_000, 1),
            ]
        );

        // A good per-person read moves its first day back, never forward,
        // and leaves the cost report's own columns alone.
        db.execute(
            "INSERT INTO provider_connections (id, workspace, provider, credential, hint, connected_by, connected_at) VALUES ('pcn_1', 'acme', 'anthropic', 'v1:x', '…abcd', 'ada', 't0')",
            [],
        )
        .unwrap();
        let note = |from: &str| {
            db.execute(
                NOTE_PEOPLE_SYNCED,
                rusqlite::params!["t3", Option::<String>::None, from, "pcn_1"],
            )
            .unwrap();
            db.query_row(
                "SELECT people_synced_from, synced_from FROM provider_connections",
                [],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
            )
            .unwrap()
        };
        assert_eq!(note("2026-07-21"), ("2026-07-21".into(), None));
        assert_eq!(note("2026-10-12"), ("2026-07-21".into(), None));
        assert!(read_back(Some("t3"), None, Some("2026-07-21"), "2026-10-01"));
        assert!(!read_back(Some("t3"), Some("no report"), Some("2026-07-21"), "2026-10-01"));
        assert!(!read_back(None, None, None, "2026-10-01"));

        // A rename moves them like the cost report's.
        for statement in crate::rename::STATEMENTS.iter().filter(|s| s.contains("provider_")) {
            db.execute(statement, rusqlite::params!["acme-co", "acme"]).unwrap();
        }
        let moved: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM provider_person_costs WHERE workspace = 'acme-co'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(moved, 3);
    }
}
