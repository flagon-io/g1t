//! Pricing, admission and the log's wording for the AI Gateway (`gateway.rs`).

use super::*;

fn priced(model: &str, name: &str, prices: [i64; 5]) -> GatewayModel {
    GatewayModel {
        model: model.into(),
        name: name.into(),
        provider: "anthropic".into(),
        kind: "chat".into(),
        input_micros: prices[0],
        output_micros: prices[1],
        cache_read_micros: prices[2],
        cache_write_micros: prices[3],
        cache_write_1h_micros: prices[4],
        threshold: 0,
        over_input_micros: 0,
        over_output_micros: 0,
        over_cache_read_micros: 0,
        over_cache_write_micros: 0,
        over_cache_write_1h_micros: 0,
    }
}

fn sonnet() -> GatewayModel {
    priced("claude-sonnet-5-5", "Claude Sonnet 5.5", [2_000_000, 10_000_000, 100_000, 2_500_000, 4_000_000])
}

/// Claude Haiku 5.5, priced by prompt length at 100,000 tokens.
fn haiku() -> GatewayModel {
    GatewayModel {
        threshold: 100_000,
        over_input_micros: 500_000,
        over_output_micros: 2_500_000,
        over_cache_read_micros: 50_000,
        over_cache_write_micros: 625_000,
        over_cache_write_1h_micros: 1_000_000,
        ..priced("claude-haiku-5-5", "Claude Haiku 5.5", [100_000, 500_000, 10_000, 125_000, 200_000])
    }
}

fn used(input: u64, output: u64, cache_read: u64, cache_write: u64, cache_write_1h: u64) -> Used {
    Used { input, output, cache_read, cache_write, cache_write_1h }
}

#[test]
fn a_request_costs_its_tokens_at_the_models_prices() {
    // A million of each, the writes five-minute ones: $2 + $10 + $0.10 + $2.50.
    assert_eq!(cost_micros(&sonnet(), &used(1_000_000, 1_000_000, 1_000_000, 1_000_000, 0)), 14_600_000);
    // 1,000 input and 500 output: $0.002 + $0.005.
    assert_eq!(cost_micros(&sonnet(), &used(1_000, 500, 0, 0, 0)), 7_000);
    // Nothing used costs nothing.
    assert_eq!(cost_micros(&sonnet(), &Used::default()), 0);
}

#[test]
fn hour_long_cache_writes_cost_twice_input() {
    // A million writes, all an hour long: $4, not the five-minute $2.50.
    assert_eq!(cost_micros(&sonnet(), &used(0, 0, 0, 1_000_000, 1_000_000)), 4_000_000);
    // Split: 600k five-minute ($1.50) and 400k hour-long ($1.60).
    assert_eq!(cost_micros(&sonnet(), &used(0, 0, 0, 1_000_000, 400_000)), 3_100_000);
    // More hour-long writes than writes is never more than the writes.
    assert_eq!(cost_micros(&sonnet(), &used(0, 0, 0, 1_000, 5_000)), 4_000);
    // A model with no hour-long price charges them as five-minute ones.
    let flat = GatewayModel { cache_write_1h_micros: 0, ..sonnet() };
    assert_eq!(cost_micros(&flat, &used(0, 0, 0, 1_000_000, 1_000_000)), 2_500_000);
}

#[test]
fn a_short_prompt_on_haiku_5_5_is_charged_the_lower_prices() {
    let short = used(60_000, 2_000, 30_000, 10_000, 0);
    assert!(!over_threshold(&haiku(), &short));
    // 60k at $0.10, 2k at $0.50, 30k at $0.01 and 10k at $0.125 a million.
    assert_eq!(cost_micros(&haiku(), &short), 6_000 + 1_000 + 300 + 1_250);
    // Exactly the threshold is still the lower price.
    assert!(!over_threshold(&haiku(), &used(100_000, 50_000, 0, 0, 0)));
}

#[test]
fn a_long_prompt_on_haiku_5_5_puts_the_whole_request_at_the_higher_prices() {
    // 100,001 prompt tokens, counting cache reads and writes.
    let long = used(40_001, 2_000, 50_000, 10_000, 4_000);
    assert!(over_threshold(&haiku(), &long));
    // 40,001 at $0.50, 2k at $2.50, 50k at $0.05, 6k at $0.625 and 4k at $1 a million, rounded up.
    assert_eq!(cost_micros(&haiku(), &long), 20_001 + 5_000 + 2_500 + 3_750 + 4_000);
    // A model with one price is never over.
    assert!(!over_threshold(&sonnet(), &used(900_000, 0, 0, 0, 0)));
}

#[test]
fn a_fraction_of_a_millionth_rounds_up() {
    // One cache-read token: 0.1 millionths.
    assert_eq!(cost_micros(&sonnet(), &used(0, 0, 1, 0, 0)), 1);
    // A negative price in the table is never a credit: it counts as nothing.
    let odd = GatewayModel { input_micros: -5, ..sonnet() };
    assert_eq!(cost_micros(&odd, &used(10, 0, 0, 0, 0)), 0);
}

#[test]
fn the_markup_is_the_price_books_and_zero_in_beta_charges_the_cost() {
    let cost = cost_micros(&sonnet(), &used(12_000, 800, 40_000, 0, 0));
    assert_eq!(margin_on(cost, 0), cost);
    assert_eq!(margin_on(1_000, 20), 1_200);
}

#[test]
fn the_workspaces_own_provider_is_counted_and_never_charged() {
    let tokens = used(50_000, 2_000, 0, 0, 0);
    assert_eq!(request_cost(false, Some(&sonnet()), &tokens), 120_000);
    assert_eq!(request_cost(true, Some(&sonnet()), &tokens), 0);
    assert_eq!(request_cost(true, Some(&haiku()), &used(500_000, 0, 0, 0, 0)), 0);
    // A model g1t has no price for is never charged a guess.
    assert_eq!(request_cost(false, None, &tokens), 0);
}

#[test]
fn an_open_model_is_priced_like_any_other() {
    let oss = GatewayModel {
        provider: "workers-ai".into(),
        ..priced("@cf/openai/gpt-oss-120b", "gpt-oss-120b", [350_000, 750_000, 350_000, 350_000, 350_000])
    };
    // 200k in, 10k out: $0.07 + $0.0075.
    assert_eq!(request_cost(false, Some(&oss), &used(200_000, 10_000, 0, 0, 0)), 77_500);
    // Embeddings: input only.
    let bge = GatewayModel { kind: "embeddings".into(), ..priced("@cf/baai/bge-m3", "BGE M3", [12_000, 0, 12_000, 12_000, 12_000]) };
    assert_eq!(request_cost(false, Some(&bge), &used(1_000_000, 0, 0, 0, 0)), 12_000);
}

#[test]
fn out_of_credit_on_the_plan_is_refused_and_the_rest_by_plan() {
    assert_eq!(plan_standing(PlanKind::Paid, None), Standing::Admitted);
    assert_eq!(plan_standing(PlanKind::Paid, Some(false)), Standing::OutOfCredit { reload_failed: false });
    assert_eq!(plan_standing(PlanKind::Paid, Some(true)), Standing::OutOfCredit { reload_failed: true });
    assert_eq!(plan_standing(PlanKind::Free, None), Standing::NoPlan);
    // Comped and invoiced workspaces need no credit.
    assert_eq!(plan_standing(PlanKind::Internal, Some(false)), Standing::Admitted);
    assert_eq!(plan_standing(PlanKind::Enterprise, Some(false)), Standing::Admitted);
    assert!(refusal("acme", &plan_standing(PlanKind::Paid, Some(false))).is_some());
}

#[test]
fn only_an_admitted_workspace_is_let_through() {
    assert_eq!(refusal("acme", &Standing::Admitted), None);
    let out = refusal("acme", &Standing::OutOfCredit { reload_failed: false }).unwrap();
    assert!(out.contains("out of AI credit") && out.contains("/acme/-/billing#ai-credit"), "{out}");
    assert!(!out.contains("Auto-reload"));
    let failed = refusal("acme", &Standing::OutOfCredit { reload_failed: true }).unwrap();
    assert!(failed.contains("Auto-reload was turned off"));
    let no_plan = refusal("acme", &Standing::NoPlan).unwrap();
    assert!(no_plan.contains("g1t plan") && no_plan.contains("own model provider"), "{no_plan}");
    assert_eq!(refusal("acme", &Standing::Stopped("Over the limit.".into())).as_deref(), Some("Over the limit."));
}

#[test]
fn a_ledger_line_names_the_model_tokens_and_token() {
    let tokens = used(12_000, 800, 0, 0, 0);
    assert_eq!(describe("Claude Sonnet 5.5", &tokens, false, Some("ci")), "AI Gateway: Claude Sonnet 5.5, 12,800 tokens, token ci");
    assert_eq!(describe("Claude Haiku 4.5", &used(5, 0, 0, 0, 0), false, None), "AI Gateway: Claude Haiku 4.5, 5 tokens");
    assert_eq!(describe("Claude Haiku 4.5", &used(5, 0, 0, 0, 0), false, Some("  ")), "AI Gateway: Claude Haiku 4.5, 5 tokens");
    assert_eq!(
        describe("Claude Haiku 5.5", &used(120_000, 1_000, 0, 0, 0), true, None),
        "AI Gateway: Claude Haiku 5.5, 121,000 tokens, long-prompt price"
    );
}

#[test]
fn a_format_is_one_of_two() {
    assert_eq!(format_of("openai"), "openai");
    assert_eq!(format_of("OpenAI"), "openai");
    assert_eq!(format_of("anthropic"), "anthropic");
    assert_eq!(format_of(""), "anthropic");
    assert_eq!(format_of("gopher"), "anthropic");
}

#[test]
fn request_ids_are_the_proxys() {
    assert!(valid_id("gw_01kkr2m4c8f1t7qh3d6n9w5p0x"));
    assert!(valid_id("gw_a-b_c"));
    assert!(!valid_id("run_1"));
    assert!(!valid_id("gw_x'; DROP TABLE ledger"));
    assert!(!valid_id(&format!("gw_{}", "a".repeat(80))));
}

#[test]
fn the_migrations_price_every_model_they_offer() {
    let first = include_str!("../migrations/0045_gateway.sql");
    for model in ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"] {
        assert!(first.contains(&format!("('{model}', ")), "{model}");
    }
    let second = include_str!("../migrations/0047_gateway_formats.sql");
    // Sonnet 5.5's cache reads are $0.10, 0.05 times input; 0045 had $0.20.
    assert!(second.contains("SET cache_read_micros = 100000, updated_at = '2026-10-07T00:00:00Z' WHERE model = 'claude-sonnet-5-5'"));
    // Hour-long cache writes at twice input.
    assert!(second.contains("cache_write_1h_micros = 8000000 WHERE model = 'claude-opus-5-5'"));
    assert!(second.contains("cache_write_1h_micros = 4000000 WHERE model = 'claude-sonnet-5-5'"));
    assert!(second.contains("cache_write_1h_micros = 2000000 WHERE model IN ('claude-haiku-4-5', 'claude-haiku-4-5-20251001')"));
    // Haiku 5.5: $0.10 / $0.50 to 100,000 prompt tokens, $0.50 / $2.50 over.
    assert!(second.contains(
        "('claude-haiku-5-5', 'Claude Haiku 5.5', 'anthropic', 'chat', 100000, 500000, 10000, 125000, 200000,\n   100000, 500000, 2500000, 50000, 625000, 1000000, 0,"
    ));
    // Open models at Workers AI's prices.
    for (model, input, output) in [
        ("@cf/openai/gpt-oss-120b", 350_000, 750_000),
        ("@cf/openai/gpt-oss-20b", 200_000, 300_000),
        ("@cf/zai-org/glm-5.3-flash", 150_000, 500_000),
        ("@cf/moonshotai/kimi-k2.6", 950_000, 4_000_000),
    ] {
        let row = second.lines().find(|line| line.contains(&format!("('{model}'"))).unwrap_or_else(|| panic!("{model}"));
        assert!(row.contains(&format!("'workers-ai', 'chat', {input}, {output}, ")), "{row}");
    }
    assert!(second.contains("('@cf/baai/bge-m3', 'BGE M3', 'workers-ai', 'embeddings', 12000, 0,"));
}
