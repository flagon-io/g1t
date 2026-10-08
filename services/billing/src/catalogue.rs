//! The model catalogue: every model g1t can use, where each stands, and
//! which one each purpose uses by default.
//!
//! - **One table.** `gateway_models` (migrations 0045, 0047, 0048) holds
//!   every model: the agents' tiers, the AI Gateway's models and the
//!   embeddings model, with prices per million tokens by kind (long-prompt
//!   and cache prices included), and its aliases, family, tier hint,
//!   context window, capabilities, status and where it came from. Billing
//!   owns it because billing owns prices: the gateway charges from it, and
//!   a second table of models would drift from the first.
//! - **Discovery.** The models service lists each provider daily (and when
//!   staff press "Check for new models" in sudo): Anthropic's
//!   `GET /v1/models` through g1t's AI Gateway, and Workers AI's model
//!   search. Listing is free; nothing here calls a paid model.
//!   `record_discovery` compares the list with the catalogue (`diff`):
//!   an id it has never seen is added as `new` (priced from `known` or the
//!   listing's own price when either knows it, otherwise unpriced); a dated
//!   id of a model it has (`claude-haiku-4-5-20251001`) is that model; a
//!   model the provider stopped listing becomes `deprecated`, and comes
//!   back when it is listed again. Staff are emailed about anything new or
//!   gone, with a link to sudo. A `new` model is never routed to, offered
//!   or charged for until staff approve it with its prices.
//! - **Defaults.** `model_defaults` holds staff's choice per purpose: the
//!   model behind each agent tier, the harness's background model, the AI
//!   Gateway's first Claude, and each job's starting tier and effort. Every
//!   change is audited with the old value, the new one and why.
//!   `resolve` never hands out a model that cannot be used: a chosen model
//!   that is deprecated, retired or unpriced falls back to the next
//!   available model suited to the purpose, with a sentence saying so.

use g1t_contracts::billing::{
    model_status, AdminDecideModelArgs, AdminModels, AdminSetModelDefaultArgs, CatalogueModel, DiscoveryResult, GatewayModel,
    JobDefault, ModelCheck, ModelDefault, ModelDefaults, ModelPrices, ProviderModel, RecordDiscoveryArgs, ResolvedModel,
    TypicalRun,
};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::gateway::{ModelRow, Used, cost_micros};
use crate::Billing;

/// The tokens of a typical agent run, which sudo prices each model at: 40
/// requests, each reading most of its context from the prompt cache, as a
/// Sonnet implement run does (about 90% of its tokens cache reads). An
/// estimate for comparing models, never a charge.
pub(crate) const TYPICAL: TypicalRun = TypicalRun { requests: 40, input: 2_000, output: 1_500, cache_read: 45_000, cache_write: 4_000 };

/// What `TYPICAL` costs on a model, in millionths of a dollar: 0 for an
/// embeddings model. Each request is priced on its own, so a model priced
/// by prompt length is at its lower prices unless one request's prompt is
/// over the threshold.
pub(crate) fn typical_run(model: &GatewayModel) -> i64 {
    if model.kind != "chat" {
        return 0;
    }
    let used = Used { input: TYPICAL.input, output: TYPICAL.output, cache_read: TYPICAL.cache_read, cache_write: TYPICAL.cache_write, cache_write_1h: 0 };
    cost_micros(model, &used).saturating_mul(TYPICAL.requests as i64)
}

/// The purposes a default model is chosen for, in the order sudo shows them.
pub(crate) const MODEL_PURPOSES: [&str; 5] = ["tier_small", "tier_large", "tier_frontier", "background", "gateway_first"];
/// The kinds of agent job, each with a starting tier and effort (`job_<kind>`).
pub(crate) const JOB_KINDS: [&str; 6] = ["implement", "revise", "answer", "review", "update", "plan"];
pub(crate) const TIERS: [&str; 3] = ["small", "large", "frontier"];
pub(crate) const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// What sudo and the audit log call a purpose.
pub(crate) fn purpose_label(purpose: &str) -> String {
    match purpose {
        "tier_small" => "Fast tier".to_owned(),
        "tier_large" => "Standard tier".to_owned(),
        "tier_frontier" => "Most capable tier".to_owned(),
        "background" => "Background model".to_owned(),
        "gateway_first" => "AI Gateway's first Claude".to_owned(),
        other => match other.strip_prefix("job_") {
            Some(kind) => format!("Job: {kind}"),
            None => other.to_owned(),
        },
    }
}

/// The tier a model purpose is for, if it is one of the agent tiers or
/// the background model (which is a fast model's job).
fn tier_of_purpose(purpose: &str) -> Option<&'static str> {
    match purpose {
        "tier_small" | "background" => Some("small"),
        "tier_large" => Some("large"),
        "tier_frontier" => Some("frontier"),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// What g1t knows about models before anyone tells it.
// ---------------------------------------------------------------------------

/// Prices per million tokens in millionths of a dollar: input, output,
/// cache read, five-minute and hour-long cache write.
type Five = [i64; 5];

const fn five(input: i64, output: i64, read: i64, write: i64, write_1h: i64) -> Five {
    [input, output, read, write, write_1h]
}

/// A model id, its prices, and its long-prompt threshold and prices above it.
type Listed = (&'static str, Five, Option<(u64, Five)>);

/// Anthropic's list prices by model, as published (checked 2026-10-08).
/// The maintained price table: when Anthropic lists a model here, it is
/// added priced and only needs staff to confirm it. Add a row when
/// Anthropic publishes a new model's price; until then a new model is
/// added unpriced and staff enter its prices when they approve it.
const ANTHROPIC_PRICES: &[Listed] = &[
    ("claude-fable-5-1", five(10_000_000, 50_000_000, 250_000, 12_500_000, 20_000_000), None),
    ("claude-fable-5", five(10_000_000, 50_000_000, 1_000_000, 12_500_000, 20_000_000), None),
    ("claude-opus-5-5", five(4_000_000, 20_000_000, 200_000, 5_000_000, 8_000_000), None),
    ("claude-opus-5", five(5_000_000, 25_000_000, 500_000, 6_250_000, 10_000_000), None),
    ("claude-opus-4-8", five(5_000_000, 25_000_000, 500_000, 6_250_000, 10_000_000), None),
    ("claude-opus-4-7", five(5_000_000, 25_000_000, 500_000, 6_250_000, 10_000_000), None),
    ("claude-opus-4-6", five(5_000_000, 25_000_000, 500_000, 6_250_000, 10_000_000), None),
    ("claude-sonnet-5-5", five(2_000_000, 10_000_000, 100_000, 2_500_000, 4_000_000), None),
    ("claude-sonnet-5", five(2_000_000, 10_000_000, 200_000, 2_500_000, 4_000_000), None),
    ("claude-sonnet-4-6", five(3_000_000, 15_000_000, 300_000, 3_750_000, 6_000_000), None),
    (
        "claude-haiku-5-5",
        five(100_000, 500_000, 10_000, 125_000, 200_000),
        Some((100_000, five(500_000, 2_500_000, 50_000, 625_000, 1_000_000))),
    ),
    ("claude-haiku-4-5", five(1_000_000, 5_000_000, 100_000, 1_250_000, 2_000_000), None),
];

/// Whether `listed` is `model` with a date after it (`-YYYYMMDD`), as
/// Anthropic lists a model it also names without one.
pub(crate) fn is_dated(listed: &str, model: &str) -> bool {
    listed
        .strip_prefix(model)
        .and_then(|rest| rest.strip_prefix('-'))
        .is_some_and(|date| date.len() == 8 && date.bytes().all(|b| b.is_ascii_digit()))
}

/// The list price of an Anthropic model (by its id, or its dated id), if
/// the table has it.
pub(crate) fn known_prices(id: &str) -> Option<ModelPrices> {
    let (_, base, over) = ANTHROPIC_PRICES.iter().find(|(model, _, _)| id == *model || is_dated(id, model))?;
    let (threshold, above) = over.unwrap_or((0, [0; 5]));
    Some(ModelPrices {
        input_micros: base[0],
        output_micros: base[1],
        cache_read_micros: base[2],
        cache_write_micros: base[3],
        cache_write_1h_micros: base[4],
        threshold,
        over_input_micros: above[0],
        over_output_micros: above[1],
        over_cache_read_micros: above[2],
        over_cache_write_micros: above[3],
        over_cache_write_1h_micros: above[4],
    })
}

/// A model's family, and the agent tier it suits, from its id:
/// `claude-haiku-*` is fast, `claude-sonnet-*` standard, `claude-opus-*`
/// and `claude-fable-*` the most capable. A Workers AI model's family is
/// its author (`@cf/<author>/…`) and it suits no tier.
pub(crate) fn family_of(provider: &str, id: &str) -> (String, String) {
    if provider == "anthropic" {
        for (family, tier) in [("haiku", "small"), ("sonnet", "large"), ("opus", "frontier"), ("fable", "frontier"), ("mythos", "frontier")] {
            if id.starts_with(&format!("claude-{family}")) {
                return (family.to_owned(), tier.to_owned());
            }
        }
        return (String::new(), String::new());
    }
    let author = id.trim_start_matches('@').split('/').nth(1).unwrap_or_default();
    (author.to_owned(), String::new())
}

/// A name for people when the provider gives none: a Workers AI id's last
/// part.
fn name_of(listed: &ProviderModel) -> String {
    let name = listed.name.trim();
    if !name.is_empty() && !name.starts_with('@') {
        return name.chars().take(120).collect();
    }
    listed.id.rsplit('/').next().unwrap_or(&listed.id).chars().take(120).collect()
}

// ---------------------------------------------------------------------------
// Discovery: what a provider lists, against the catalogue.
// ---------------------------------------------------------------------------

/// What a check found, before it is written.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Diff {
    /// Ids never seen, to add as `new` (chat and embeddings models only).
    pub added: Vec<ProviderModel>,
    /// Catalogue models listed, with an id to add to their aliases when the
    /// provider listed them by one they did not have.
    pub seen: Vec<(String, Option<String>)>,
    /// Catalogue models (available or new) the provider no longer lists.
    pub gone: Vec<String>,
    /// Deprecated models listed again.
    pub restored: Vec<String>,
}

/// Whether the provider listing `listed` lists catalogue model `row`, and
/// by an id it did not know (to keep as an alias).
fn lists(row: &CatalogueModel, listed: &str) -> Option<Option<String>> {
    if listed == row.prices.model || row.aliases.iter().any(|alias| alias == listed) {
        return Some(None);
    }
    is_dated(listed, &row.prices.model).then(|| Some(listed.to_owned()))
}

/// Compares what `provider` lists with the catalogue. An empty list says
/// nothing (a failed or empty answer is not every model gone), so nothing
/// is found gone then. Retired models are left as they are.
pub(crate) fn diff(provider: &str, catalogue: &[CatalogueModel], listed: &[ProviderModel]) -> Diff {
    let mine: Vec<&CatalogueModel> = catalogue.iter().filter(|row| row.prices.provider == provider).collect();
    let mut out = Diff::default();
    let mut matched: Vec<&str> = vec![];
    for model in listed {
        let id = model.id.trim();
        if id.is_empty() {
            continue;
        }
        let hits: Vec<(&CatalogueModel, Option<String>)> = mine.iter().filter_map(|row| lists(row, id).map(|alias| (*row, alias))).collect();
        if hits.is_empty() {
            let kind = model.kind.as_str();
            if (kind == "chat" || kind == "embeddings") && !out.added.iter().any(|added| added.id == id) {
                out.added.push(ProviderModel { id: id.to_owned(), ..model.clone() });
            }
            continue;
        }
        for (row, alias) in hits {
            let name = row.prices.model.as_str();
            if matched.contains(&name) {
                continue;
            }
            matched.push(name);
            if row.status == model_status::DEPRECATED && row.missing_since.is_some() {
                out.restored.push(name.to_owned());
            }
            out.seen.push((name.to_owned(), alias));
        }
    }
    if listed.iter().any(|model| !model.id.trim().is_empty()) {
        for row in mine {
            let gone = !matched.contains(&row.prices.model.as_str());
            if gone && (row.status == model_status::AVAILABLE || row.status == model_status::NEW) {
                out.gone.push(row.prices.model.clone());
            }
        }
    }
    out
}

/// The row a newly found model is added as: `new`, from discovery, priced
/// from `known_prices` (Anthropic), else the listing's own price (Workers
/// AI, which has no cache prices: cached tokens cost what input does),
/// else unpriced.
pub(crate) fn new_row(provider: &str, listed: &ProviderModel, position: i64) -> (GatewayModel, CatalogueFacts) {
    let (family, tier) = family_of(provider, &listed.id);
    let kind = if listed.kind == "embeddings" { "embeddings" } else { "chat" };
    let prices = known_prices(&listed.id).or_else(|| {
        listed.price.as_ref().filter(|price| price.input_micros > 0).map(|price| ModelPrices {
            input_micros: price.input_micros,
            output_micros: price.output_micros.max(0),
            cache_read_micros: price.input_micros,
            cache_write_micros: price.input_micros,
            cache_write_1h_micros: price.input_micros,
            ..ModelPrices::default()
        })
    });
    let priced = prices.is_some();
    let prices = prices.unwrap_or_default();
    let mut capabilities = listed.capabilities.clone();
    if kind == "embeddings" && !capabilities.iter().any(|c| c == "embeddings") {
        capabilities.push("embeddings".to_owned());
    }
    (
        with_prices(
            GatewayModel {
                model: listed.id.clone(),
                name: name_of(listed),
                provider: provider.to_owned(),
                kind: kind.to_owned(),
                input_micros: 0,
                output_micros: 0,
                cache_read_micros: 0,
                cache_write_micros: 0,
                cache_write_1h_micros: 0,
                threshold: 0,
                over_input_micros: 0,
                over_output_micros: 0,
                over_cache_read_micros: 0,
                over_cache_write_micros: 0,
                over_cache_write_1h_micros: 0,
            },
            &prices,
        ),
        CatalogueFacts { family, tier_hint: tier, capabilities, priced, position },
    )
}

/// What a new row carries besides its prices.
#[derive(Debug, PartialEq)]
pub(crate) struct CatalogueFacts {
    pub family: String,
    pub tier_hint: String,
    pub capabilities: Vec<String>,
    pub priced: bool,
    pub position: i64,
}

/// `model` with `prices`.
pub(crate) fn with_prices(model: GatewayModel, prices: &ModelPrices) -> GatewayModel {
    GatewayModel {
        input_micros: prices.input_micros,
        output_micros: prices.output_micros,
        cache_read_micros: prices.cache_read_micros,
        cache_write_micros: prices.cache_write_micros,
        cache_write_1h_micros: prices.cache_write_1h_micros,
        threshold: prices.threshold,
        over_input_micros: prices.over_input_micros,
        over_output_micros: prices.over_output_micros,
        over_cache_read_micros: prices.over_cache_read_micros,
        over_cache_write_micros: prices.over_cache_write_micros,
        over_cache_write_1h_micros: prices.over_cache_write_1h_micros,
        ..model
    }
}

/// Whether prices staff confirm make sense: none below nothing, a chat
/// model with input and output prices, an embeddings model with an input
/// price, and long-prompt prices only with a threshold.
pub(crate) fn check_prices(kind: &str, prices: &ModelPrices) -> std::result::Result<(), String> {
    let all = [
        prices.input_micros,
        prices.output_micros,
        prices.cache_read_micros,
        prices.cache_write_micros,
        prices.cache_write_1h_micros,
        prices.over_input_micros,
        prices.over_output_micros,
        prices.over_cache_read_micros,
        prices.over_cache_write_micros,
        prices.over_cache_write_1h_micros,
    ];
    if all.iter().any(|price| *price < 0) {
        return Err("A price cannot be less than nothing.".into());
    }
    // $1,000 per million tokens: no model costs that; a slipped finger does.
    if all.iter().any(|price| *price > 1_000_000_000) {
        return Err("No price is over $1,000 per million tokens; check the decimal point.".into());
    }
    if prices.input_micros == 0 {
        return Err("Give the input price per million tokens.".into());
    }
    if kind == "chat" && prices.output_micros == 0 {
        return Err("Give the output price per million tokens.".into());
    }
    let over = prices.over_input_micros + prices.over_output_micros + prices.over_cache_read_micros + prices.over_cache_write_micros;
    if prices.threshold == 0 && over > 0 {
        return Err("Long-prompt prices need the prompt length they start above.".into());
    }
    if prices.threshold > 0 && (prices.over_input_micros == 0 || (kind == "chat" && prices.over_output_micros == 0)) {
        return Err("With a long-prompt threshold, give the input and output prices above it.".into());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Defaults: what each purpose uses, and what it falls back to.
// ---------------------------------------------------------------------------

/// Why `model` cannot serve `purpose`, or None when it can. The agents'
/// purposes need Claude (the harness speaks Anthropic's API), and so does
/// the AI Gateway's first model.
pub(crate) fn unsuited(purpose: &str, model: &CatalogueModel) -> Option<String> {
    let name = &model.prices.name;
    if !model.priced {
        return Some(format!("{name} has no price yet: approve it with its prices first."));
    }
    match model.status.as_str() {
        model_status::AVAILABLE => {}
        model_status::NEW => return Some(format!("{name} is new: approve it first.")),
        status => return Some(format!("{name} is {status}.")),
    }
    if MODEL_PURPOSES.contains(&purpose) && (model.prices.provider != "anthropic" || model.prices.kind != "chat") {
        return Some(format!("{name} is not a Claude chat model, which {} needs.", purpose_label(purpose).to_lowercase()));
    }
    None
}

/// What one model purpose uses now: the chosen model while it can be used;
/// otherwise the first available Claude suited to the purpose's tier (or,
/// for the gateway, any available Claude), in the catalogue's order, with a
/// sentence saying so. A model is never handed out that cannot be used.
pub(crate) fn resolve(purpose: &str, chosen: &str, catalogue: &[CatalogueModel]) -> ResolvedModel {
    let resolved = |model: &CatalogueModel, note: Option<String>| ResolvedModel {
        purpose: purpose.to_owned(),
        chosen: chosen.to_owned(),
        model: Some(model.prices.clone()),
        capabilities: model.capabilities.clone(),
        note,
    };
    let picked = catalogue.iter().find(|model| model.prices.model == chosen);
    if let Some(model) = picked
        && unsuited(purpose, model).is_none()
    {
        return resolved(model, None);
    }
    let why = match picked {
        Some(model) => match model.status.as_str() {
            model_status::AVAILABLE if !model.priced => format!("{} has no price", model.prices.name),
            model_status::AVAILABLE => format!("{} does not suit it", model.prices.name),
            status => format!("{} is {status}", model.prices.name),
        },
        None => format!("{chosen} is not in the catalogue"),
    };
    let tier = tier_of_purpose(purpose);
    let fallback = catalogue.iter().filter(|model| model.prices.model != chosen && unsuited(purpose, model).is_none()).find(|model| {
        // Same tier first; a purpose with no tier takes any Claude.
        tier.is_none_or(|tier| model.tier_hint == tier)
    });
    match fallback {
        Some(model) => resolved(model, Some(format!("{why}; using {} instead.", model.prices.name))),
        None => ResolvedModel {
            purpose: purpose.to_owned(),
            chosen: chosen.to_owned(),
            model: None,
            capabilities: vec![],
            note: Some(format!("{why}, and no other model suits it.")),
        },
    }
}

/// Every purpose's model as it applies now, and each job's tier and
/// effort; a purpose or job with no row is left out (callers keep theirs).
pub(crate) fn defaults_view(defaults: &[ModelDefault], catalogue: &[CatalogueModel]) -> ModelDefaults {
    let models = MODEL_PURPOSES
        .iter()
        .filter_map(|purpose| {
            let row = defaults.iter().find(|row| row.purpose == *purpose)?;
            Some(resolve(purpose, row.model.as_deref()?, catalogue))
        })
        .collect();
    let jobs = JOB_KINDS
        .iter()
        .filter_map(|kind| {
            let row = defaults.iter().find(|row| row.purpose == format!("job_{kind}"))?;
            let tier = row.tier.as_deref().filter(|tier| TIERS.contains(tier) || *tier == "change")?;
            Some(JobDefault {
                kind: (*kind).to_owned(),
                tier: tier.to_owned(),
                effort: row.effort.clone().filter(|effort| EFFORTS.contains(&effort.as_str())),
            })
        })
        .collect();
    ModelDefaults { models, jobs }
}

/// Puts `first` at the top of the gateway's list, the rest in order.
pub(crate) fn put_first(models: &mut Vec<GatewayModel>, first: Option<&str>) {
    if let Some(at) = first.and_then(|first| models.iter().position(|model| model.model == first)) {
        let model = models.remove(at);
        models.insert(0, model);
    }
}

/// A default as staff set it, checked: the purpose exists, a model purpose
/// names a model that suits it, a job names a tier (and an effort or none).
/// The reason is required.
/// A checked default: its model, or its tier and effort.
pub(crate) type Checked = (Option<String>, Option<String>, Option<String>);

pub(crate) fn check_default(a: &AdminSetModelDefaultArgs, catalogue: &[CatalogueModel]) -> std::result::Result<Checked, String> {
    if a.reason.trim().is_empty() {
        return Err("Say why, for whoever looks next.".into());
    }
    let purpose = a.purpose.as_str();
    if MODEL_PURPOSES.contains(&purpose) {
        let wanted = a.model.as_deref().map(str::trim).filter(|m| !m.is_empty()).ok_or("Choose a model.")?;
        let model = catalogue.iter().find(|model| model.prices.model == wanted).ok_or_else(|| format!("{wanted} is not in the catalogue."))?;
        if let Some(why) = unsuited(purpose, model) {
            return Err(why);
        }
        return Ok((Some(wanted.to_owned()), None, None));
    }
    let Some(kind) = purpose.strip_prefix("job_").filter(|kind| JOB_KINDS.contains(kind)) else {
        return Err(format!("{purpose} is not something a default is chosen for."));
    };
    let tier = a.tier.as_deref().map(str::trim).unwrap_or_default();
    // Only a review is sized by the change it reads.
    if !(TIERS.contains(&tier) || (tier == "change" && kind == "review")) {
        return Err(if kind == "review" { "Choose fast, standard, most capable, or by the change's size." } else { "Choose fast, standard or most capable." }.into());
    }
    let effort = a.effort.as_deref().map(str::trim).filter(|effort| !effort.is_empty());
    if let Some(effort) = effort
        && !EFFORTS.contains(&effort)
    {
        return Err("Effort is low, medium, high, xhigh or max, or the harness's own.".into());
    }
    Ok((None, Some(tier.to_owned()), effort.map(str::to_owned)))
}

/// How a default reads in the audit log: `claude-haiku-5-5`, or
/// `small at high effort`.
fn describe_default(model: Option<&str>, tier: Option<&str>, effort: Option<&str>) -> String {
    match (model, tier) {
        (Some(model), _) => model.to_owned(),
        (None, Some(tier)) => match effort {
            Some(effort) => format!("{tier} at {effort} effort"),
            None => tier.to_owned(),
        },
        (None, None) => "nothing".to_owned(),
    }
}

fn split(list: Option<&str>) -> Vec<String> {
    list.unwrap_or_default().split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned).collect()
}

impl From<ModelRow> for CatalogueModel {
    fn from(row: ModelRow) -> Self {
        let n = |value: Option<f64>| value.unwrap_or(0.0).max(0.0) as u64;
        let aliases = split(row.aliases.as_deref());
        let capabilities = split(row.capabilities.as_deref());
        let (family, tier_hint) = (row.family.clone().unwrap_or_default(), row.tier_hint.clone().unwrap_or_default());
        let status = row.status.clone().unwrap_or_else(|| model_status::AVAILABLE.to_owned());
        let priced = row.priced.is_none_or(|priced| priced != 0.0);
        let source = row.source.clone().unwrap_or_else(|| "staff".to_owned());
        let (context_window, max_output, dimensions) = (n(row.context_window), n(row.max_output), n(row.dimensions) as u32);
        let (first_seen_at, last_seen_at, missing_since) = (row.first_seen_at.clone(), row.last_seen_at.clone(), row.missing_since.clone());
        let (approved_by, approved_at, note) = (row.approved_by.clone(), row.approved_at.clone(), row.note.clone().unwrap_or_default());
        let prices = GatewayModel::from(row);
        let typical_run_micros = if priced { typical_run(&prices) } else { 0 };
        CatalogueModel {
            prices,
            aliases,
            family,
            tier_hint,
            context_window,
            max_output,
            capabilities,
            dimensions,
            status,
            priced,
            source,
            first_seen_at,
            last_seen_at,
            missing_since,
            approved_by,
            approved_at,
            note,
            typical_run_micros,
        }
    }
}

#[derive(Deserialize)]
struct DefaultRow {
    purpose: String,
    model: Option<String>,
    tier: Option<String>,
    effort: Option<String>,
    updated_at: String,
    updated_by: String,
    reason: Option<String>,
}

impl From<DefaultRow> for ModelDefault {
    fn from(row: DefaultRow) -> Self {
        ModelDefault {
            purpose: row.purpose,
            model: row.model,
            tier: row.tier,
            effort: row.effort,
            updated_at: row.updated_at,
            updated_by: row.updated_by,
            reason: row.reason.unwrap_or_default(),
        }
    }
}

#[derive(Deserialize)]
struct CheckRow {
    id: String,
    provider: String,
    checked_at: String,
    by: String,
    listed: f64,
    added: Option<String>,
    deprecated: Option<String>,
    error: Option<String>,
}

impl From<CheckRow> for ModelCheck {
    fn from(row: CheckRow) -> Self {
        ModelCheck {
            id: row.id,
            provider: row.provider,
            checked_at: row.checked_at,
            by: row.by,
            listed: row.listed.max(0.0) as u32,
            added: split(row.added.as_deref()),
            deprecated: split(row.deprecated.as_deref()),
            error: row.error,
        }
    }
}

/// How long checks are kept.
const CHECK_DAYS: u64 = 90;
const DAY_MS: u64 = 86_400_000;

fn number(n: u64) -> JsValue {
    JsValue::from_f64(n as f64)
}

impl Billing {
    /// Every model in the catalogue, whatever its status: `new` ones first,
    /// then by provider and position.
    pub(crate) async fn catalogue(&self) -> Result<Vec<CatalogueModel>> {
        Ok(self
            .db
            .prepare("SELECT * FROM gateway_models ORDER BY CASE status WHEN 'new' THEN 0 ELSE 1 END, provider, position, model")
            .all()
            .await?
            .results::<ModelRow>()?
            .into_iter()
            .map(CatalogueModel::from)
            .collect())
    }

    pub(crate) async fn model_default(&self, purpose: &str) -> Result<Option<ModelDefault>> {
        Ok(self
            .db
            .prepare("SELECT * FROM model_defaults WHERE purpose = ?")
            .bind(&[purpose.into()])?
            .first::<DefaultRow>(None)
            .await?
            .map(ModelDefault::from))
    }

    async fn model_default_rows(&self) -> Result<Vec<ModelDefault>> {
        Ok(self
            .db
            .prepare("SELECT * FROM model_defaults ORDER BY purpose")
            .all()
            .await?
            .results::<DefaultRow>()?
            .into_iter()
            .map(ModelDefault::from)
            .collect())
    }

    /// `model_defaults`: what the runner and the gateway use now.
    pub(crate) async fn model_defaults(&self) -> Result<ModelDefaults> {
        let (defaults, catalogue) = futures_util::future::try_join(self.model_default_rows(), self.catalogue()).await?;
        Ok(defaults_view(&defaults, &catalogue))
    }

    /// `admin_models`.
    pub(crate) async fn admin_models(&self) -> Result<AdminModels> {
        let (defaults, catalogue) = futures_util::future::try_join(self.model_default_rows(), self.catalogue()).await?;
        let checks = self
            .db
            .prepare("SELECT * FROM model_checks ORDER BY checked_at DESC, id DESC LIMIT 20")
            .all()
            .await?
            .results::<CheckRow>()?
            .into_iter()
            .map(ModelCheck::from)
            .collect();
        let resolved = defaults_view(&defaults, &catalogue);
        Ok(AdminModels { catalogue, defaults, resolved, checks, typical: TYPICAL })
    }

    /// `record_discovery`: what one provider lists, against the catalogue.
    pub(crate) async fn record_discovery(&self, a: RecordDiscoveryArgs) -> Result<DiscoveryResult> {
        let provider: String = a.provider.trim().chars().take(40).collect();
        let by: String = a.by.trim().chars().take(200).collect();
        let now = now_ms();
        let checked_at = rfc3339(now);
        let mut result = DiscoveryResult {
            provider: provider.clone(),
            checked_at: checked_at.clone(),
            by: by.clone(),
            listed: a.models.len().min(u32::MAX as usize) as u32,
            error: a.error.as_deref().map(|e| e.chars().take(500).collect()),
            ..DiscoveryResult::default()
        };
        if result.error.is_none() {
            let catalogue = self.catalogue().await?;
            let found = diff(&provider, &catalogue, &a.models);
            let mut writes = vec![];
            let position = catalogue.iter().filter(|row| row.prices.provider == provider).count() as i64 + 100;
            for (at, listed) in found.added.iter().enumerate() {
                let (model, facts) = new_row(&provider, listed, position + at as i64);
                writes.push(
                    self.db
                        .prepare(
                            "INSERT OR IGNORE INTO gateway_models
                               (model, name, provider, kind, input_micros, output_micros, cache_read_micros, cache_write_micros,
                                cache_write_1h_micros, threshold, over_input_micros, over_output_micros, over_cache_read_micros,
                                over_cache_write_micros, over_cache_write_1h_micros, position, updated_at, family, tier_hint,
                                context_window, max_output, capabilities, status, priced, source, first_seen_at, last_seen_at)
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22,
                                     'new', ?23, 'discovered', ?17, ?17)",
                        )
                        .bind(&[
                            model.model.as_str().into(),
                            model.name.as_str().into(),
                            provider.as_str().into(),
                            model.kind.as_str().into(),
                            (model.input_micros as f64).into(),
                            (model.output_micros as f64).into(),
                            (model.cache_read_micros as f64).into(),
                            (model.cache_write_micros as f64).into(),
                            (model.cache_write_1h_micros as f64).into(),
                            number(model.threshold),
                            (model.over_input_micros as f64).into(),
                            (model.over_output_micros as f64).into(),
                            (model.over_cache_read_micros as f64).into(),
                            (model.over_cache_write_micros as f64).into(),
                            (model.over_cache_write_1h_micros as f64).into(),
                            (facts.position as f64).into(),
                            checked_at.as_str().into(),
                            facts.family.as_str().into(),
                            facts.tier_hint.as_str().into(),
                            number(listed.context_window),
                            number(listed.max_output),
                            facts.capabilities.join(",").into(),
                            f64::from(u8::from(facts.priced)).into(),
                        ])?,
                );
                result.added.push(model.model);
            }
            for (model, alias) in &found.seen {
                let listed = a.models.iter().find(|listed| &listed.id == model || alias.as_ref() == Some(&listed.id));
                let (context, output) = listed.map_or((0, 0), |l| (l.context_window, l.max_output));
                let capabilities = listed.map(|l| l.capabilities.join(",")).unwrap_or_default();
                // What the provider says now fills in what g1t did not know;
                // a restored model goes back to where it stood.
                writes.push(
                    self.db
                        .prepare(
                            "UPDATE gateway_models SET last_seen_at = ?2,
                               context_window = CASE WHEN ?3 > 0 THEN ?3 ELSE context_window END,
                               max_output = CASE WHEN ?4 > 0 THEN ?4 ELSE max_output END,
                               capabilities = CASE WHEN ?5 <> '' AND kind = 'chat' THEN ?5 ELSE capabilities END,
                               aliases = CASE WHEN ?6 = '' THEN aliases WHEN aliases = '' THEN ?6 ELSE aliases || ',' || ?6 END,
                               status = CASE WHEN status = 'deprecated' AND missing_since IS NOT NULL
                                             THEN CASE WHEN approved_at IS NOT NULL THEN 'available' ELSE 'new' END
                                             ELSE status END,
                               missing_since = NULL
                             WHERE model = ?1",
                        )
                        .bind(&[
                            model.as_str().into(),
                            checked_at.as_str().into(),
                            number(context),
                            number(output),
                            capabilities.into(),
                            alias.as_deref().unwrap_or_default().into(),
                        ])?,
                );
            }
            for model in &found.gone {
                writes.push(
                    self.db
                        .prepare(
                            "UPDATE gateway_models SET status = 'deprecated', missing_since = ?2
                             WHERE model = ?1 AND status IN ('available', 'new')",
                        )
                        .bind(&[model.as_str().into(), checked_at.as_str().into()])?,
                );
            }
            result.deprecated = found.gone.clone();
            result.restored = found.restored.clone();
            if !writes.is_empty() {
                self.db.batch(writes).await?;
            }
        }
        self.db
            .prepare("INSERT INTO model_checks (id, provider, checked_at, by, listed, added, deprecated, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(&[
                new_id("mck", now).into(),
                provider.as_str().into(),
                checked_at.as_str().into(),
                by.as_str().into(),
                f64::from(result.listed).into(),
                result.added.join(",").into(),
                result.deprecated.join(",").into(),
                crate::optional(result.error.as_deref()),
            ])?
            .run()
            .await?;
        if !result.added.is_empty() || !result.deprecated.is_empty() || !result.restored.is_empty() {
            let detail = discovery_detail(&result);
            self.audit("models", "models_discovered", &detail, &by).await?;
            self.tell_staff(&result).await;
        }
        Ok(result)
    }

    /// Emails staff what a check found; a failure is logged, never raised.
    async fn tell_staff(&self, result: &DiscoveryResult) {
        if self.caps.alert_to.is_empty() {
            return;
        }
        let (subject, lines) = discovery_email(result);
        let sent = crate::margin::email_staff_page(
            &self.env,
            &self.caps.alert_to,
            &subject,
            &lines,
            ("Agents & models", "https://sudo.g1t.sh/agents"),
            "g1t-billing's model catalogue",
        )
        .await;
        if let Err(error) = sent {
            worker::console_error!("emailing staff about models failed: {error}");
        }
    }

    /// `admin_decide_model`.
    pub(crate) async fn admin_decide_model(&self, a: AdminDecideModelArgs) -> Result<Outcome<CatalogueModel>> {
        let reason = a.reason.trim();
        if reason.is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Say why, for whoever looks next."));
        }
        let catalogue = self.catalogue().await?;
        let Some(model) = catalogue.iter().find(|model| model.prices.model == a.model.trim()) else {
            return Ok(Outcome::fail(FailureCode::NotFound, format!("{} is not in the catalogue.", a.model.trim())));
        };
        let now = rfc3339(now_ms());
        let id = model.prices.model.as_str();
        let detail;
        match a.decision.as_str() {
            "approve" => {
                let prices = a.prices.clone().unwrap_or(ModelPrices {
                    input_micros: model.prices.input_micros,
                    output_micros: model.prices.output_micros,
                    cache_read_micros: model.prices.cache_read_micros,
                    cache_write_micros: model.prices.cache_write_micros,
                    cache_write_1h_micros: model.prices.cache_write_1h_micros,
                    threshold: model.prices.threshold,
                    over_input_micros: model.prices.over_input_micros,
                    over_output_micros: model.prices.over_output_micros,
                    over_cache_read_micros: model.prices.over_cache_read_micros,
                    over_cache_write_micros: model.prices.over_cache_write_micros,
                    over_cache_write_1h_micros: model.prices.over_cache_write_1h_micros,
                });
                if let Err(why) = check_prices(&model.prices.kind, &prices) {
                    return Ok(Outcome::fail(FailureCode::Invalid, why));
                }
                let name: String = a.name.as_deref().map(str::trim).filter(|n| !n.is_empty()).unwrap_or(&model.prices.name).chars().take(120).collect();
                let tier = a.tier_hint.as_deref().map(str::trim).unwrap_or(&model.tier_hint).to_owned();
                if !tier.is_empty() && !TIERS.contains(&tier.as_str()) {
                    return Ok(Outcome::fail(FailureCode::Invalid, "A tier hint is small, large, frontier, or none."));
                }
                self.db
                    .prepare(
                        "UPDATE gateway_models SET status = 'available', priced = 1, name = ?2, tier_hint = ?3,
                           input_micros = ?4, output_micros = ?5, cache_read_micros = ?6, cache_write_micros = ?7,
                           cache_write_1h_micros = ?8, threshold = ?9, over_input_micros = ?10, over_output_micros = ?11,
                           over_cache_read_micros = ?12, over_cache_write_micros = ?13, over_cache_write_1h_micros = ?14,
                           approved_by = ?15, approved_at = ?16, updated_at = ?16, missing_since = NULL, note = ?17
                         WHERE model = ?1",
                    )
                    .bind(&[
                        id.into(),
                        name.as_str().into(),
                        tier.as_str().into(),
                        (prices.input_micros as f64).into(),
                        (prices.output_micros as f64).into(),
                        (prices.cache_read_micros as f64).into(),
                        (prices.cache_write_micros as f64).into(),
                        (prices.cache_write_1h_micros as f64).into(),
                        number(prices.threshold),
                        (prices.over_input_micros as f64).into(),
                        (prices.over_output_micros as f64).into(),
                        (prices.over_cache_read_micros as f64).into(),
                        (prices.over_cache_write_micros as f64).into(),
                        (prices.over_cache_write_1h_micros as f64).into(),
                        a.by.as_str().into(),
                        now.as_str().into(),
                        reason.into(),
                    ])?
                    .run()
                    .await?;
                detail = format!(
                    "{id} approved as {name}: ${} in, ${} out per million. {reason}",
                    dollars(prices.input_micros),
                    dollars(prices.output_micros)
                );
                self.audit("models", "model_approved", &detail, &a.by).await?;
            }
            "retire" => {
                // A default that names it falls back on its own (`resolve`);
                // say which, so staff can choose another.
                let using: Vec<String> = self
                    .model_default_rows()
                    .await?
                    .into_iter()
                    .filter(|row| row.model.as_deref() == Some(id))
                    .map(|row| purpose_label(&row.purpose))
                    .collect();
                self.db
                    .prepare("UPDATE gateway_models SET status = 'retired', updated_at = ?2, note = ?3 WHERE model = ?1")
                    .bind(&[id.into(), now.as_str().into(), reason.into()])?
                    .run()
                    .await?;
                let defaults = if using.is_empty() { String::new() } else { format!(" Defaults that fall back now: {}.", using.join(", ")) };
                detail = format!("{id} retired. {reason}{defaults}");
                self.audit("models", "model_retired", &detail, &a.by).await?;
            }
            "restore" => {
                // Back to available if it was ever approved; else waiting again.
                self.db
                    .prepare(
                        "UPDATE gateway_models SET status = CASE WHEN approved_at IS NOT NULL THEN 'available' ELSE 'new' END,
                           missing_since = NULL, updated_at = ?2, note = ?3 WHERE model = ?1",
                    )
                    .bind(&[id.into(), now.as_str().into(), reason.into()])?
                    .run()
                    .await?;
                detail = format!("{id} restored. {reason}");
                self.audit("models", "model_restored", &detail, &a.by).await?;
            }
            _ => return Ok(Outcome::fail(FailureCode::Invalid, "Approve, retire or restore.")),
        }
        let updated = self.catalogue().await?.into_iter().find(|model| model.prices.model == id);
        Ok(match updated {
            Some(model) => Outcome::Ok(model),
            None => Outcome::fail(FailureCode::NotFound, format!("{id} is not in the catalogue.")),
        })
    }

    /// `admin_set_model_default`.
    pub(crate) async fn admin_set_model_default(&self, a: AdminSetModelDefaultArgs) -> Result<Outcome<ModelDefault>> {
        let catalogue = self.catalogue().await?;
        let (model, tier, effort) = match check_default(&a, &catalogue) {
            Ok(value) => value,
            Err(why) => return Ok(Outcome::fail(FailureCode::Invalid, why)),
        };
        let before = self.model_default(&a.purpose).await?;
        let reason: String = a.reason.trim().chars().take(500).collect();
        let now = rfc3339(now_ms());
        self.db
            .prepare(
                "INSERT INTO model_defaults (purpose, model, tier, effort, updated_at, updated_by, reason)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT (purpose) DO UPDATE SET model = ?2, tier = ?3, effort = ?4, updated_at = ?5, updated_by = ?6, reason = ?7",
            )
            .bind(&[
                a.purpose.as_str().into(),
                crate::optional(model.as_deref()),
                crate::optional(tier.as_deref()),
                crate::optional(effort.as_deref()),
                now.as_str().into(),
                a.by.as_str().into(),
                reason.as_str().into(),
            ])?
            .run()
            .await?;
        let old = before
            .as_ref()
            .map_or("nothing".to_owned(), |row| describe_default(row.model.as_deref(), row.tier.as_deref(), row.effort.as_deref()));
        let new = describe_default(model.as_deref(), tier.as_deref(), effort.as_deref());
        self.audit("models", "model_default", &format!("{}: {old} → {new}. {reason}", purpose_label(&a.purpose)), &a.by).await?;
        Ok(Outcome::Ok(ModelDefault { purpose: a.purpose, model, tier, effort, updated_at: now, updated_by: a.by, reason }))
    }

    /// Daily: checks older than `CHECK_DAYS` go.
    pub(crate) async fn forget_model_checks(&self) -> Result<()> {
        let cutoff = rfc3339(now_ms().saturating_sub(CHECK_DAYS * DAY_MS));
        self.db.prepare("DELETE FROM model_checks WHERE checked_at < ?").bind(&[cutoff.into()])?.run().await?;
        Ok(())
    }
}

/// `$0.10`, `$2`, `$12.50`: dollars per million from millionths.
pub(crate) fn dollars(micros: i64) -> String {
    let text = format!("{:.4}", micros as f64 / 1_000_000.0);
    let text = text.trim_end_matches('0').trim_end_matches('.');
    match text.split_once('.') {
        Some((whole, cents)) if cents.len() == 1 => format!("{whole}.{cents}0"),
        _ => text.to_owned(),
    }
}

/// What a check found, for the audit log.
pub(crate) fn discovery_detail(result: &DiscoveryResult) -> String {
    let mut parts = vec![];
    if !result.added.is_empty() {
        parts.push(format!("new: {}", result.added.join(", ")));
    }
    if !result.deprecated.is_empty() {
        parts.push(format!("no longer listed: {}", result.deprecated.join(", ")));
    }
    if !result.restored.is_empty() {
        parts.push(format!("listed again: {}", result.restored.join(", ")));
    }
    format!("{}: {}", result.provider, parts.join("; "))
}

/// The email to staff about a check: its subject and paragraphs.
pub(crate) fn discovery_email(result: &DiscoveryResult) -> (String, Vec<String>) {
    let provider = match result.provider.as_str() {
        "anthropic" => "Anthropic",
        "workers-ai" => "Workers AI",
        other => other,
    };
    let subject = if result.added.is_empty() {
        format!("g1t: {provider} no longer lists {}", result.deprecated.join(", "))
    } else {
        let more = if result.added.len() > 3 { format!(" and {} more", result.added.len() - 3) } else { String::new() };
        format!("g1t: new {provider} models: {}{more}", result.added.iter().take(3).cloned().collect::<Vec<_>>().join(", "))
    };
    let mut lines = vec![];
    if !result.added.is_empty() {
        lines.push(format!(
            "{provider} lists {} model{} g1t has not used before: {}. Each is in the catalogue as new: nothing routes to it, offers it or charges for it until you approve it with its prices in sudo.",
            result.added.len(),
            if result.added.len() == 1 { "" } else { "s" },
            result.added.join(", ")
        ));
    }
    if !result.deprecated.is_empty() {
        lines.push(format!(
            "{provider} no longer lists {}. Each is deprecated now: no default routes to it, and any default that chose it uses the next suitable model. Choose another default, or retire it.",
            result.deprecated.join(", ")
        ));
    }
    if !result.restored.is_empty() {
        lines.push(format!("{provider} lists {} again; each is back where it stood.", result.restored.join(", ")));
    }
    (subject, lines)
}

#[cfg(test)]
#[path = "catalogue_tests.rs"]
mod tests;
