//! What a model's tokens cost at list price, for estimating what a
//! harness session cost from the token usage it reports.
//!
//! The prices are list prices in US dollars per million tokens:
//! Anthropic's first-party prices, from the pricing page of Anthropic's API
//! documentation, checked on 2026-10-06, OpenAI's Standard tier, from
//! OpenAI's API pricing page, checked on 2026-10-22, and Google's Gemini
//! API paid Standard tier, from its pricing page, checked on 2026-10-22
//! (Gemini's implicit caching has no write price). Writing to the prompt
//! cache costs 1.25 times the input price for Anthropic's 5-minute lifetime
//! and OpenAI's 30-minute one, and twice it for Anthropic's 1-hour one. An
//! OpenAI prompt over 272,000 input tokens costs more on its larger models;
//! it is priced as any other here, so such a session's estimate is low.
//! Any other model is priced as unknown: its cost is not estimated.
//!
//! A session reports its usage as a list of [`ModelUsage`], one per model
//! (and tier) it used, cumulative for the session. [`parse_usage`] reads
//! and checks one as given; [`estimate`] prices it.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A model's list prices, in US dollars per million tokens.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ModelPrice {
    pub input: f64,
    pub output: f64,
    /// Reading from the prompt cache.
    pub cache_read: f64,
}

impl ModelPrice {
    /// Writing to the prompt cache for 5 minutes: 1.25 times input.
    pub fn cache_write_5m(&self) -> f64 {
        self.input * 1.25
    }

    /// Writing to the prompt cache for 1 hour: twice input.
    pub fn cache_write_1h(&self) -> f64 {
        self.input * 2.0
    }
}

const fn price(input: f64, output: f64, cache_read: f64) -> ModelPrice {
    ModelPrice { input, output, cache_read }
}

/// The tier of claude-haiku-5-5 for a request whose prompt (input, cache
/// read and cache write tokens) is over [`LONG_PROMPT_TOKENS`], and of
/// gemini-2.5-pro and gemini-3.1-pro-preview for one over 200,000 tokens.
pub const LONG_TIER: &str = "long";

/// The prompt size above which claude-haiku-5-5 is priced as [`LONG_TIER`].
pub const LONG_PROMPT_TOKENS: u64 = 100_000;

/// Every model priced, by its id: from Anthropic's pricing documentation,
/// checked on 2026-10-06, and OpenAI's and Google's, checked on 2026-10-22.
/// claude-haiku-5-5, gemini-2.5-pro and gemini-3.1-pro-preview have a
/// second row for their [`LONG_TIER`].
pub const MODEL_PRICES: &[(&str, Option<&str>, ModelPrice)] = &[
    ("claude-fable-5-1", None, price(10.0, 50.0, 0.25)),
    ("claude-mythos-5-1", None, price(10.0, 50.0, 0.25)),
    ("claude-fable-5", None, price(10.0, 50.0, 1.00)),
    ("claude-mythos-5", None, price(10.0, 50.0, 1.00)),
    ("claude-opus-5-5", None, price(4.0, 20.0, 0.20)),
    ("claude-opus-5", None, price(5.0, 25.0, 0.50)),
    ("claude-opus-4-8", None, price(5.0, 25.0, 0.50)),
    ("claude-opus-4-7", None, price(5.0, 25.0, 0.50)),
    ("claude-opus-4-6", None, price(5.0, 25.0, 0.50)),
    ("claude-sonnet-5-5", None, price(2.0, 10.0, 0.20)),
    ("claude-sonnet-5", None, price(2.0, 10.0, 0.20)),
    ("claude-sonnet-4-6", None, price(3.0, 15.0, 0.30)),
    ("claude-haiku-5-5", None, price(0.10, 0.50, 0.01)),
    ("claude-haiku-5-5", Some(LONG_TIER), price(0.50, 2.50, 0.05)),
    ("claude-haiku-4-5", None, price(1.0, 5.0, 0.10)),
    // OpenAI's, as Codex uses them. Reasoning tokens are billed as output.
    ("gpt-6.1-sol", None, price(2.0, 10.0, 0.10)),
    ("gpt-6-astra", None, price(10.0, 50.0, 1.00)),
    ("gpt-6-sol", None, price(2.0, 10.0, 0.20)),
    ("gpt-6-luna", None, price(0.10, 0.50, 0.01)),
    ("gpt-5.6-sol", None, price(4.0, 20.0, 0.40)),
    ("gpt-5.6-terra", None, price(2.0, 12.0, 0.20)),
    ("gpt-5.6-luna", None, price(0.20, 1.20, 0.02)),
    ("gpt-5.5", None, price(5.0, 30.0, 0.50)),
    ("gpt-5.4", None, price(2.50, 15.0, 0.25)),
    ("gpt-5.3-codex", None, price(1.75, 14.0, 0.175)),
    // Google's Gemini API, Paid tier, Standard, for text, as Gemini CLI uses
    // them. Thinking tokens are billed as output; caching is implicit, with
    // no write price. The Pro models cost more for a prompt over 200,000
    // tokens: their LONG_TIER. gemini-3.6-flash and gemini-3.8-flash double
    // on 2027-01-01. gemini-3-pro-preview and gemini-3.5-flash, which Gemini
    // CLI also names, have no list price there.
    ("gemini-3.1-pro-preview", None, price(2.0, 12.0, 0.20)),
    ("gemini-3.1-pro-preview", Some(LONG_TIER), price(4.0, 18.0, 0.40)),
    ("gemini-2.5-pro", None, price(1.25, 10.0, 0.125)),
    ("gemini-2.5-pro", Some(LONG_TIER), price(2.50, 15.0, 0.25)),
    ("gemini-3.8-flash", None, price(0.75, 3.75, 0.075)),
    ("gemini-3.6-flash", None, price(0.75, 3.75, 0.075)),
    ("gemini-3-flash-preview", None, price(0.50, 3.0, 0.05)),
    ("gemini-2.5-flash", None, price(0.30, 2.50, 0.03)),
    ("gemini-3.5-flash-lite", None, price(0.30, 2.50, 0.03)),
    ("gemini-3.1-flash-lite", None, price(0.25, 1.50, 0.025)),
    ("gemini-2.5-flash-lite", None, price(0.10, 0.40, 0.01)),
];

/// A model id as the price table names it: lowercase, without a provider
/// prefix (`anthropic.`, `us.anthropic.`), a context suffix (`[1m]`), a
/// version suffix (`-v1:0`) or a date (`-20251001`).
pub fn model_key(model: &str) -> String {
    let mut key = model.trim().to_ascii_lowercase();
    if let Some(at) = key.find("anthropic.") {
        key = key[at + "anthropic.".len()..].to_owned();
    }
    if let Some(at) = key.find('[') {
        key.truncate(at);
    }
    if let Some(at) = key.find(':') {
        key.truncate(at);
    }
    loop {
        let Some((head, tail)) = key.rsplit_once('-') else { break };
        let date = tail.len() == 8 && tail.bytes().all(|b| b.is_ascii_digit());
        let version = tail.len() >= 2 && tail.starts_with('v') && tail[1..].bytes().all(|b| b.is_ascii_digit());
        if !(date || version) {
            break;
        }
        key = head.to_owned();
    }
    key
}

/// A model's list prices for `tier`, or none for a model not in the table.
/// A tier the model has no row for is priced as its base row.
pub fn model_price(model: &str, tier: Option<&str>) -> Option<ModelPrice> {
    let key = model_key(model);
    let rows = || MODEL_PRICES.iter().filter(|(id, _, _)| *id == key);
    rows()
        .find(|(_, row_tier, _)| tier.is_some() && *row_tier == tier)
        .or_else(|| rows().find(|(_, row_tier, _)| row_tier.is_none()))
        .map(|(_, _, price)| *price)
}

/// What one model (and tier) of a session used, in tokens, as its harness
/// reported it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelUsage {
    pub model: String,
    /// `long` for a claude-haiku-5-5 prompt over 100,000 tokens; none otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tier: Option<String>,
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_write_5m_tokens: u64,
    #[serde(default)]
    pub cache_write_1h_tokens: u64,
    #[serde(default)]
    pub cache_read_tokens: u64,
}

impl ModelUsage {
    /// What it cost at list price in US dollars, or none for a model not
    /// in the table.
    pub fn cost_usd(&self) -> Option<f64> {
        let price = model_price(&self.model, self.tier.as_deref())?;
        let tokens = |count: u64, per_million: f64| count as f64 * per_million;
        Some(
            (tokens(self.input_tokens, price.input)
                + tokens(self.output_tokens, price.output)
                + tokens(self.cache_write_5m_tokens, price.cache_write_5m())
                + tokens(self.cache_write_1h_tokens, price.cache_write_1h())
                + tokens(self.cache_read_tokens, price.cache_read))
                / 1_000_000.0,
        )
    }

    fn tokens(&self) -> u64 {
        self.input_tokens
            .saturating_add(self.output_tokens)
            .saturating_add(self.cache_write_5m_tokens)
            .saturating_add(self.cache_write_1h_tokens)
            .saturating_add(self.cache_read_tokens)
    }
}

/// A session's usage priced: the sum over the models priced (none when no
/// model is), and whether some of it was for models priced as unknown.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CostEstimate {
    pub cost_usd: Option<f64>,
    pub partial: bool,
}

/// Prices a session's usage. A model with no tokens counts for nothing.
pub fn estimate(usage: &[ModelUsage]) -> CostEstimate {
    let mut out = CostEstimate::default();
    for one in usage.iter().filter(|one| one.tokens() > 0) {
        match one.cost_usd() {
            Some(cost) => out.cost_usd = Some(out.cost_usd.unwrap_or(0.0) + cost),
            None => out.partial = true,
        }
    }
    out
}

/// The most models one session's usage names.
pub const MAX_USAGE_MODELS: usize = 50;
/// The longest model id and tier kept.
pub const MAX_USAGE_MODEL_CHARS: usize = 100;
pub const MAX_USAGE_TIER_CHARS: usize = 20;
/// The most tokens one count may be: far beyond any session.
pub const MAX_USAGE_TOKENS: u64 = 1_000_000_000_000;

const COUNTS: [&str; 5] = ["input_tokens", "output_tokens", "cache_write_5m_tokens", "cache_write_1h_tokens", "cache_read_tokens"];

/// A session's usage as given (a list of `{ model, tier?, input_tokens,
/// output_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
/// cache_read_tokens }`), checked: at most [`MAX_USAGE_MODELS`] models,
/// each named, every count a whole number from 0 to [`MAX_USAGE_TOKENS`].
/// The same model and tier given twice are added together.
pub fn parse_usage(value: &Value) -> Result<Vec<ModelUsage>, String> {
    let Value::Array(rows) = value else {
        return Err("usage is a list of { model, tier, input_tokens, output_tokens, cache_write_5m_tokens, cache_write_1h_tokens, cache_read_tokens }.".to_owned());
    };
    if rows.len() > MAX_USAGE_MODELS {
        return Err(format!("usage names at most {MAX_USAGE_MODELS} models."));
    }
    let mut out: Vec<ModelUsage> = Vec::new();
    for row in rows {
        let Value::Object(fields) = row else {
            return Err("Each usage is an object with model and its token counts.".to_owned());
        };
        let model = fields.get("model").and_then(Value::as_str).map(str::trim).unwrap_or_default();
        if model.is_empty() || model.chars().count() > MAX_USAGE_MODEL_CHARS {
            return Err(format!("Each usage names its model, in up to {MAX_USAGE_MODEL_CHARS} characters."));
        }
        let tier = match fields.get("tier") {
            None | Some(Value::Null) => None,
            Some(Value::String(tier)) if tier.trim().is_empty() => None,
            Some(Value::String(tier)) if tier.trim().chars().count() <= MAX_USAGE_TIER_CHARS => Some(tier.trim().to_owned()),
            Some(_) => return Err(format!("A usage's tier is text, up to {MAX_USAGE_TIER_CHARS} characters.")),
        };
        let mut counts = [0u64; 5];
        for (count, name) in counts.iter_mut().zip(COUNTS) {
            *count = match fields.get(name) {
                None | Some(Value::Null) => 0,
                Some(value) => match value.as_u64() {
                    Some(n) if n <= MAX_USAGE_TOKENS => n,
                    _ => return Err(format!("{name} is a whole number of tokens from 0 to {MAX_USAGE_TOKENS}, not {value}.")),
                },
            };
        }
        let [input_tokens, output_tokens, cache_write_5m_tokens, cache_write_1h_tokens, cache_read_tokens] = counts;
        let one = ModelUsage {
            model: model.to_owned(),
            tier,
            input_tokens,
            output_tokens,
            cache_write_5m_tokens,
            cache_write_1h_tokens,
            cache_read_tokens,
        };
        match out.iter_mut().find(|known| known.model == one.model && known.tier == one.tier) {
            Some(known) => {
                known.input_tokens = known.input_tokens.saturating_add(one.input_tokens);
                known.output_tokens = known.output_tokens.saturating_add(one.output_tokens);
                known.cache_write_5m_tokens = known.cache_write_5m_tokens.saturating_add(one.cache_write_5m_tokens);
                known.cache_write_1h_tokens = known.cache_write_1h_tokens.saturating_add(one.cache_write_1h_tokens);
                known.cache_read_tokens = known.cache_read_tokens.saturating_add(one.cache_read_tokens);
            }
            None => out.push(one),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn the_table_pins_list_prices() {
        assert_eq!(model_price("claude-opus-5-5", None), Some(price(4.0, 20.0, 0.20)));
        assert_eq!(model_price("claude-fable-5-1", None), Some(price(10.0, 50.0, 0.25)));
        assert_eq!(model_price("claude-fable-5", None), Some(price(10.0, 50.0, 1.00)));
        assert_eq!(model_price("claude-sonnet-4-6", None), Some(price(3.0, 15.0, 0.30)));
        assert_eq!(model_price("claude-haiku-5-5", None), Some(price(0.10, 0.50, 0.01)));
        assert_eq!(model_price("claude-haiku-5-5", Some("long")), Some(price(0.50, 2.50, 0.05)));
        assert_eq!(model_price("claude-haiku-4-5", None), Some(price(1.0, 5.0, 0.10)));
        let opus = model_price("claude-opus-4-7", None).unwrap();
        assert!(close(opus.cache_write_5m(), 6.25) && close(opus.cache_write_1h(), 10.0));
        // OpenAI's, as Codex uses them: a cache write is 1.25 times input there too.
        assert_eq!(model_price("gpt-6.1-sol", None), Some(price(2.0, 10.0, 0.10)));
        assert_eq!(model_price("gpt-6-astra", None), Some(price(10.0, 50.0, 1.00)));
        assert_eq!(model_price("gpt-5.6-sol", None), Some(price(4.0, 20.0, 0.40)));
        assert_eq!(model_price("gpt-5.3-codex", None), Some(price(1.75, 14.0, 0.175)));
        assert!(close(model_price("gpt-6-sol", None).unwrap().cache_write_5m(), 2.50));
        // Google's, as Gemini CLI uses them, with the Pro models' long prompts dearer.
        assert_eq!(model_price("gemini-2.5-pro", None), Some(price(1.25, 10.0, 0.125)));
        assert_eq!(model_price("gemini-2.5-pro", Some("long")), Some(price(2.50, 15.0, 0.25)));
        assert_eq!(model_price("gemini-3.1-pro-preview", Some("long")), Some(price(4.0, 18.0, 0.40)));
        assert_eq!(model_price("gemini-3-flash-preview", None), Some(price(0.50, 3.0, 0.05)));
        assert_eq!(model_price("gemini-3.8-flash", Some("long")), Some(price(0.75, 3.75, 0.075)));
    }

    #[test]
    fn a_model_is_found_without_its_date_context_or_provider() {
        assert_eq!(model_key("claude-haiku-4-5-20251001"), "claude-haiku-4-5");
        assert_eq!(model_key("claude-opus-5-5[1m]"), "claude-opus-5-5");
        assert_eq!(model_key("us.anthropic.claude-sonnet-4-6-20260101-v1:0"), "claude-sonnet-4-6");
        assert_eq!(model_key("anthropic.claude-opus-4-8"), "claude-opus-4-8");
        assert!(model_price("Claude-Opus-5-5[1M]", None).is_some());
        // A tier a model has no row for is its base price.
        assert_eq!(model_price("claude-opus-5-5", Some("long")), model_price("claude-opus-5-5", None));
    }

    #[test]
    fn other_models_are_priced_as_unknown() {
        // Codex's own review model has no list price.
        // Gemini CLI's gemini-3-pro-preview and gemini-3.5-flash have no list price.
        for model in [
            "gpt-5.1-codex",
            "codex-auto-review",
            "claude-opus-3",
            "o3",
            "<synthetic>",
            "claude-opus-5-5x",
            "gemini-3-pro-preview",
            "gemini-3.5-flash",
        ] {
            assert_eq!(model_price(model, None), None, "{model}");
        }
    }

    #[test]
    fn a_sessions_cost_is_the_sum_of_the_models_priced() {
        let usage = vec![
            ModelUsage {
                model: "claude-opus-5-5".into(),
                input_tokens: 1_000_000,
                output_tokens: 100_000,
                cache_write_5m_tokens: 200_000,
                cache_write_1h_tokens: 100_000,
                cache_read_tokens: 10_000_000,
                ..Default::default()
            },
            ModelUsage { model: "claude-haiku-5-5".into(), tier: Some("long".into()), input_tokens: 2_000_000, ..Default::default() },
        ];
        // Opus 5.5: 4 + 2 + 1 (5m: 0.2M × 5) + 0.8 (1h: 0.1M × 8) + 2 = 9.8; Haiku 5.5 long: 2M × 0.5 = 1.
        let priced = estimate(&usage);
        assert!(close(priced.cost_usd.unwrap(), 10.8), "{priced:?}");
        assert!(!priced.partial);
        let mixed = [usage.clone(), vec![ModelUsage { model: "gpt-5".into(), input_tokens: 5, ..Default::default() }]].concat();
        let priced = estimate(&mixed);
        assert!(close(priced.cost_usd.unwrap(), 10.8) && priced.partial);
        let unknown = estimate(&[ModelUsage { model: "gpt-5".into(), output_tokens: 1, ..Default::default() }]);
        assert_eq!(unknown, CostEstimate { cost_usd: None, partial: true });
        assert_eq!(estimate(&[ModelUsage { model: "gpt-5".into(), ..Default::default() }]), CostEstimate::default());
    }

    #[test]
    fn usage_is_checked_as_given() {
        let usage = parse_usage(&json!([
            { "model": "claude-opus-5-5", "input_tokens": 3, "output_tokens": 4 },
            { "model": "claude-opus-5-5", "input_tokens": 1, "tier": null },
            { "model": "claude-haiku-5-5", "tier": "long", "cache_read_tokens": 9 },
        ]))
        .unwrap();
        assert_eq!(usage.len(), 2);
        assert_eq!(usage[0].input_tokens, 4);
        assert_eq!(usage[1].tier.as_deref(), Some("long"));
        assert!(parse_usage(&json!({})).is_err());
        assert!(parse_usage(&json!([{ "input_tokens": 1 }])).is_err());
        assert!(parse_usage(&json!([{ "model": "m", "input_tokens": -1 }])).is_err());
        assert!(parse_usage(&json!([{ "model": "m", "input_tokens": 1.5 }])).is_err());
        assert!(parse_usage(&json!([{ "model": "m", "input_tokens": "7" }])).is_err());
        assert!(parse_usage(&json!([{ "model": "m", "output_tokens": MAX_USAGE_TOKENS + 1 }])).is_err());
        assert!(parse_usage(&json!([{ "model": "x".repeat(101) }])).is_err());
        let many: Vec<Value> = (0..51).map(|i| json!({ "model": format!("m{i}") })).collect();
        assert!(parse_usage(&Value::Array(many)).is_err());
        assert_eq!(parse_usage(&json!([])).unwrap(), vec![]);
    }
}
