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
//!
//! Once a day (`keeper::DAILY`) every connection is read again: the last
//! [`REVISE_DAYS`] days, since providers revise recent days (further back
//! when reads have failed since), and [`BACKFILL_DAYS`] on its first read.
//! A read replaces the days it covers, so reading twice changes nothing.
//! A provider that fails records why on its connection and the others are
//! still read.

use std::collections::{BTreeMap, BTreeSet};

use g1t_contracts::billing::{
    ConnectProviderArgs, CostProvider, DisconnectProviderArgs, ProviderConnection, ProviderConnectionsArgs,
    ProviderCostDay, ProviderCosts, ProviderCostsArgs,
};
use g1t_contracts::time::{parse_rfc3339, rfc3339};
use g1t_contracts::{FailureCode, Outcome, PrincipalKind, Role, User, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use serde_json::Value;
use worker::{Fetch, Headers, Method, Request, RequestInit, Result};

use crate::Billing;

const DAY_MS: u64 = 24 * 60 * 60 * 1000;
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
const OPENAI_COSTS: &str = "https://api.openai.com/v1/organization/costs";
/// As Anthropic asks of integrations.
const USER_AGENT: &str = "g1t/1.0 (https://g1t.sh)";

const NO_SEALER: &str = "Provider cost reports are not set up on this g1t: it has no key to keep secrets with.";
const MEMBERS_ONLY: &str = "Only members can see a workspace's provider costs.";

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

/// A read that worked: the first day asked for moves back, never forward.
pub(crate) const NOTE_SYNCED: &str = "UPDATE provider_connections SET last_synced_at = ?1, last_error = ?2,
       synced_from = CASE WHEN synced_from IS NULL OR synced_from > ?3 THEN ?3 ELSE synced_from END
     WHERE id = ?4";

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
fn encode(value: &str) -> String {
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

/// The smallest request that proves a key can read the report: yesterday,
/// one bucket, ungrouped.
fn check_url(provider: CostProvider, now: u64) -> String {
    let today = now - now % DAY_MS;
    let yesterday = today - DAY_MS;
    match provider {
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
    }
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

fn text(value: &Value) -> String {
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
        _ => Ok(()),
    }
}

/// Why a provider refused a report request, in a sentence that says what
/// to do. The provider's own words are added where they help, with the key
/// scrubbed out of them.
pub(crate) fn explain(provider: CostProvider, status: u16, body: &Value, credential: &str) -> String {
    let label = provider.label();
    let said = body["error"]["message"]
        .as_str()
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
        (_, 429) => format!("{label} is limiting requests just now. g1t tries again at the next daily read."),
        (_, 500..=599) => format!("{label} didn't answer ({status}). g1t tries again at the next daily read."),
        _ => format!("{label} refused the request ({status})."),
    };
    match said {
        Some(said) if !said.is_empty() && status != 429 && status < 500 => format!("{base} {label} said: {said}"),
        _ => base,
    }
}

/// Whether what the providers said covers every day from `since`.
pub(crate) fn complete(connections: &[ProviderConnection], since: &str) -> bool {
    !connections.is_empty()
        && connections.iter().all(|c| {
            c.last_error.is_none()
                && c.last_synced_at.is_some()
                && c.synced_from.as_deref().is_some_and(|from| from <= since)
        })
}

/// Asks a provider for one page of its report: the answer, or why not.
async fn get(provider: CostProvider, credential: &str, url: &str) -> std::result::Result<Value, String> {
    let sent = async {
        let headers = Headers::new();
        match provider {
            CostProvider::Anthropic => {
                headers.set("x-api-key", credential)?;
                headers.set("anthropic-version", ANTHROPIC_VERSION)?;
            }
            CostProvider::Openai => headers.set("authorization", &format!("Bearer {credential}"))?,
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
        Ok((200, body)) => Ok(body),
        Ok((status, body)) => Err(explain(provider, status, &body, credential)),
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
        };
        let body = get(provider, credential, &url).await?;
        let page = match provider {
            CostProvider::Anthropic => parse_anthropic(&body)?,
            CostProvider::Openai => parse_openai(&body)?,
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
        if let Err(problem) = get(provider, credential, &check_url(provider, now)).await {
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
                    .prepare(
                        "INSERT INTO provider_connections (id, workspace, provider, credential, hint, connected_by, connected_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                         ON CONFLICT (workspace, provider) DO UPDATE SET
                           id = excluded.id, credential = excluded.credential, hint = excluded.hint,
                           connected_by = excluded.connected_by, connected_at = excluded.connected_at,
                           last_synced_at = NULL, last_error = NULL, synced_from = NULL",
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
            ])
            .await?;
        Ok(Outcome::Ok(was))
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
            micros: Option<f64>,
        }
        let connections = self.listed(&workspace).await?;
        let rows = self
            .db
            .prepare(
                "SELECT day, provider, item, SUM(micros) AS micros FROM provider_costs
                 WHERE workspace = ?1 AND day >= ?2
                 GROUP BY day, provider, item ORDER BY day, provider, item LIMIT ?3",
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
    /// kept on the connection; only a failure to write is an error.
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
        Ok(match note {
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
                "SELECT id, workspace, provider, credential, last_synced_at FROM provider_connections
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
                .contains("starting_at=2026-10-17T00%3A00%3A00Z&ending_at=2026-10-18T00%3A00%3A00Z")
        );
        assert!(check_url(CostProvider::Openai, now).ends_with("&limit=1"));
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
}
