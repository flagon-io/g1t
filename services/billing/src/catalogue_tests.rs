//! The model catalogue: discovery's diff, prices, typical runs, defaults
//! and their fallbacks (`catalogue.rs`).

use super::*;

fn model(id: &str, name: &str, tier: &str, status: &str) -> CatalogueModel {
    let prices = known_prices(id).unwrap_or(ModelPrices { input_micros: 1_000_000, output_micros: 5_000_000, ..ModelPrices::default() });
    let base = GatewayModel {
        model: id.into(),
        name: name.into(),
        provider: "anthropic".into(),
        kind: "chat".into(),
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
    };
    CatalogueModel {
        prices: with_prices(base, &prices),
        aliases: vec![],
        family: String::new(),
        tier_hint: tier.into(),
        context_window: 0,
        max_output: 0,
        capabilities: vec!["effort".into()],
        dimensions: 0,
        status: status.into(),
        priced: true,
        source: "staff".into(),
        first_seen_at: None,
        last_seen_at: None,
        missing_since: None,
        approved_by: None,
        approved_at: None,
        note: String::new(),
        typical_run_micros: 0,
    }
}

fn listed(id: &str) -> ProviderModel {
    ProviderModel { id: id.into(), name: String::new(), kind: "chat".into(), ..ProviderModel::default() }
}

fn catalogue() -> Vec<CatalogueModel> {
    let mut haiku_4_5 = model("claude-haiku-4-5", "Claude Haiku 4.5", "small", "available");
    haiku_4_5.aliases = vec!["claude-haiku-4-5-20251001".into()];
    vec![
        model("claude-haiku-5-5", "Claude Haiku 5.5", "small", "available"),
        haiku_4_5,
        model("claude-haiku-4-5-20251001", "Claude Haiku 4.5", "small", "available"),
        model("claude-sonnet-5-5", "Claude Sonnet 5.5", "large", "available"),
        model("claude-opus-5-5", "Claude Opus 5.5", "frontier", "available"),
    ]
}

#[test]
fn a_model_never_seen_is_added_and_one_no_longer_listed_is_gone() {
    let found = diff(
        "anthropic",
        &catalogue(),
        &[listed("claude-haiku-6"), listed("claude-haiku-5-5"), listed("claude-haiku-4-5-20251001"), listed("claude-sonnet-5-5")],
    );
    assert_eq!(found.added.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["claude-haiku-6"]);
    // Opus 5.5 was not listed: gone. Haiku 4.5 is listed by its dated id, which it has as an alias.
    assert_eq!(found.gone, ["claude-opus-5-5"]);
    let seen: Vec<&str> = found.seen.iter().map(|(m, _)| m.as_str()).collect();
    assert_eq!(seen, ["claude-haiku-5-5", "claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-sonnet-5-5"]);
    assert!(found.restored.is_empty());
}

#[test]
fn a_dated_id_of_a_model_it_has_is_that_model_and_becomes_an_alias() {
    let found = diff("anthropic", &catalogue(), &[listed("claude-sonnet-5-5-20261001")]);
    assert!(found.added.is_empty());
    assert_eq!(found.seen, [("claude-sonnet-5-5".to_owned(), Some("claude-sonnet-5-5-20261001".to_owned()))]);
    assert!(is_dated("claude-sonnet-5-5-20261001", "claude-sonnet-5-5"));
    assert!(!is_dated("claude-sonnet-5-5-preview", "claude-sonnet-5-5"));
    assert!(!is_dated("claude-sonnet-5", "claude-sonnet-5-5"));
}

#[test]
fn an_empty_or_failed_list_finds_nothing_gone() {
    let found = diff("anthropic", &catalogue(), &[]);
    assert_eq!(found, Diff::default());
    // Another provider's models are never its to judge.
    let found = diff("workers-ai", &catalogue(), &[listed("@cf/meta/llama-5")]);
    assert!(found.gone.is_empty());
    assert_eq!(found.added.len(), 1);
}

#[test]
fn a_deprecated_model_listed_again_is_restored_and_a_retired_one_is_left_alone() {
    let mut models = catalogue();
    models[3].status = "deprecated".into();
    models[3].missing_since = Some("2026-10-01T04:17:00Z".into());
    models[4].status = "retired".into();
    let found = diff("anthropic", &models, &[listed("claude-sonnet-5-5"), listed("claude-haiku-5-5")]);
    assert_eq!(found.restored, ["claude-sonnet-5-5"]);
    // Retired Opus is not listed and stays retired; Haiku 4.5 is gone.
    assert_eq!(found.gone, ["claude-haiku-4-5", "claude-haiku-4-5-20251001"]);
}

#[test]
fn only_chat_and_embeddings_models_are_added() {
    let mut speech = listed("@cf/openai/whisper");
    speech.kind = "other".into();
    let mut embed = listed("@cf/baai/bge-large-en-v1.5");
    embed.kind = "embeddings".into();
    let found = diff("workers-ai", &[], &[speech, embed, listed("@cf/meta/llama-5")]);
    assert_eq!(found.added.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["@cf/baai/bge-large-en-v1.5", "@cf/meta/llama-5"]);
}

#[test]
fn a_new_model_is_priced_from_the_table_or_its_listing_or_not_at_all() {
    // A dated Opus 5.5 is in the table.
    let (row, facts) = new_row("anthropic", &listed("claude-opus-5-5-20261101"), 120);
    assert!(facts.priced);
    assert_eq!((row.input_micros, row.output_micros, row.cache_read_micros), (4_000_000, 20_000_000, 200_000));
    assert_eq!((facts.family.as_str(), facts.tier_hint.as_str(), facts.position), ("opus", "frontier", 120));
    // A Haiku g1t has no price for: unpriced, a fast model by its name.
    let (row, facts) = new_row("anthropic", &listed("claude-haiku-6"), 0);
    assert!(!facts.priced);
    assert_eq!((row.input_micros, facts.tier_hint.as_str()), (0, "small"));
    // Workers AI says its own price; cached tokens cost what input does.
    let mut open = listed("@cf/meta/llama-5-70b");
    open.price = Some(g1t_contracts::billing::ListedPrice { input_micros: 290_000, output_micros: 2_250_000 });
    let (row, facts) = new_row("workers-ai", &open, 0);
    assert!(facts.priced);
    assert_eq!((row.input_micros, row.output_micros, row.cache_read_micros, row.name.as_str()), (290_000, 2_250_000, 290_000, "llama-5-70b"));
    assert_eq!((facts.family.as_str(), facts.tier_hint.as_str()), ("meta", ""));
}

#[test]
fn haiku_5_5_is_known_with_its_long_prompt_prices() {
    let prices = known_prices("claude-haiku-5-5").unwrap();
    assert_eq!((prices.input_micros, prices.output_micros, prices.cache_read_micros), (100_000, 500_000, 10_000));
    assert_eq!((prices.threshold, prices.over_input_micros, prices.over_output_micros), (100_000, 500_000, 2_500_000));
    assert!(known_prices("claude-haiku-6").is_none());
    // `claude-opus-5` is not `claude-opus-5-5`.
    assert_eq!(known_prices("claude-opus-5").unwrap().input_micros, 5_000_000);
}

#[test]
fn a_typical_run_is_priced_request_by_request() {
    let models = catalogue();
    let haiku = &models[0].prices;
    let sonnet = &models[3].prices;
    let opus = &models[4].prices;
    // 40 requests of 2k in, 1.5k out, 45k cache reads and 4k cache writes.
    assert_eq!(typical_run(sonnet), 1_340_000);
    assert_eq!(typical_run(opus), 2_680_000);
    // Each prompt is 51k, under Haiku 5.5's 100k threshold: its lower prices.
    assert_eq!(typical_run(haiku), 76_000);
    let mut embeddings = haiku.clone();
    embeddings.kind = "embeddings".into();
    assert_eq!(typical_run(&embeddings), 0);
}

#[test]
fn a_default_that_can_be_used_is_used() {
    let resolved = resolve("tier_small", "claude-haiku-5-5", &catalogue());
    assert_eq!(resolved.model.unwrap().model, "claude-haiku-5-5");
    assert!(resolved.note.is_none());
}

#[test]
fn a_retired_default_falls_back_to_the_next_model_of_its_tier_and_says_so() {
    let mut models = catalogue();
    models[0].status = "retired".into();
    let resolved = resolve("tier_small", "claude-haiku-5-5", &models);
    assert_eq!(resolved.model.unwrap().model, "claude-haiku-4-5");
    assert_eq!(resolved.note.as_deref(), Some("Claude Haiku 5.5 is retired; using Claude Haiku 4.5 instead."));
    // Deprecated and unpriced models are never handed out either.
    models[1].status = "deprecated".into();
    models[2].priced = false;
    let resolved = resolve("background", "claude-haiku-5-5", &models);
    assert!(resolved.model.is_none());
    assert_eq!(resolved.note.as_deref(), Some("Claude Haiku 5.5 is retired, and no other model suits it."));
    // The gateway's first model takes any Claude.
    let resolved = resolve("gateway_first", "claude-haiku-5-5", &models);
    assert_eq!(resolved.model.unwrap().model, "claude-sonnet-5-5");
}

#[test]
fn a_new_model_is_never_a_default_until_approved() {
    let mut models = catalogue();
    models.push(model("claude-haiku-6", "Claude Haiku 6", "small", "new"));
    let resolved = resolve("tier_small", "claude-haiku-6", &models);
    assert_eq!(resolved.model.unwrap().model, "claude-haiku-5-5");
    assert_eq!(resolved.note.as_deref(), Some("Claude Haiku 6 is new; using Claude Haiku 5.5 instead."));
    let set = AdminSetModelDefaultArgs { purpose: "tier_small".into(), model: Some("claude-haiku-6".into()), reason: "cheaper".into(), ..Default::default() };
    assert_eq!(check_default(&set, &models).unwrap_err(), "Claude Haiku 6 is new: approve it first.");
}

#[test]
fn defaults_are_checked_before_they_are_kept() {
    let models = catalogue();
    let mut open = model("@cf/openai/gpt-oss-120b", "gpt-oss-120b", "", "available");
    open.prices.provider = "workers-ai".into();
    let models = [models, vec![open]].concat();
    let args = |purpose: &str, model: Option<&str>, tier: Option<&str>, effort: Option<&str>, reason: &str| AdminSetModelDefaultArgs {
        purpose: purpose.into(),
        model: model.map(Into::into),
        tier: tier.map(Into::into),
        effort: effort.map(Into::into),
        reason: reason.into(),
        by: "staff@g1t.sh".into(),
    };
    assert_eq!(check_default(&args("tier_large", Some("claude-opus-5-5"), None, None, "try it"), &models), Ok((Some("claude-opus-5-5".into()), None, None)));
    assert_eq!(check_default(&args("tier_large", Some("claude-opus-5-5"), None, None, " "), &models).unwrap_err(), "Say why, for whoever looks next.");
    assert!(check_default(&args("tier_large", Some("@cf/openai/gpt-oss-120b"), None, None, "x"), &models).unwrap_err().contains("not a Claude chat model"));
    assert_eq!(check_default(&args("tier_large", Some("claude-nope"), None, None, "x"), &models).unwrap_err(), "claude-nope is not in the catalogue.");
    assert_eq!(
        check_default(&args("job_plan", None, Some("small"), Some("xhigh"), "x"), &models),
        Ok((None, Some("small".into()), Some("xhigh".into())))
    );
    assert_eq!(check_default(&args("job_update", None, Some("small"), Some(""), "x"), &models), Ok((None, Some("small".into()), None)));
    assert!(check_default(&args("job_plan", None, Some("change"), None, "x"), &models).is_err());
    assert!(check_default(&args("job_review", None, Some("change"), None, "x"), &models).is_ok());
    assert!(check_default(&args("job_plan", None, Some("small"), Some("huge"), "x"), &models).is_err());
    assert!(check_default(&args("job_dance", None, Some("small"), None, "x"), &models).is_err());
}

#[test]
fn the_runtime_view_has_each_purpose_and_job() {
    let row = |purpose: &str, model: Option<&str>, tier: Option<&str>, effort: Option<&str>| ModelDefault {
        purpose: purpose.into(),
        model: model.map(Into::into),
        tier: tier.map(Into::into),
        effort: effort.map(Into::into),
        updated_at: "2026-10-08T00:00:00Z".into(),
        updated_by: "migration".into(),
        reason: String::new(),
    };
    let defaults = vec![
        row("tier_small", Some("claude-haiku-5-5"), None, None),
        row("gateway_first", Some("claude-haiku-5-5"), None, None),
        row("job_plan", None, Some("small"), Some("high")),
        row("job_review", None, Some("change"), None),
        row("job_answer", None, Some("nonsense"), None),
    ];
    let view = defaults_view(&defaults, &catalogue());
    assert_eq!(view.models.iter().map(|m| m.purpose.as_str()).collect::<Vec<_>>(), ["tier_small", "gateway_first"]);
    assert_eq!(
        view.jobs,
        [
            JobDefault { kind: "review".into(), tier: "change".into(), effort: None },
            JobDefault { kind: "plan".into(), tier: "small".into(), effort: Some("high".into()) },
        ]
    );
}

#[test]
fn the_gateway_lists_staffs_first_claude_first() {
    let mut models: Vec<GatewayModel> = catalogue().into_iter().map(|m| m.prices).collect();
    put_first(&mut models, Some("claude-sonnet-5-5"));
    assert_eq!(models[0].model, "claude-sonnet-5-5");
    assert_eq!(models[1].model, "claude-haiku-5-5");
    put_first(&mut models, Some("claude-nope"));
    assert_eq!(models[0].model, "claude-sonnet-5-5");
}

#[test]
fn prices_staff_confirm_must_make_sense() {
    let good = known_prices("claude-haiku-5-5").unwrap();
    assert!(check_prices("chat", &good).is_ok());
    assert!(check_prices("chat", &ModelPrices { output_micros: 0, ..good.clone() }).is_err());
    assert!(check_prices("chat", &ModelPrices { input_micros: -1, ..good.clone() }).is_err());
    assert!(check_prices("chat", &ModelPrices { threshold: 0, ..good.clone() }).is_err());
    assert!(check_prices("chat", &ModelPrices { input_micros: 2_000_000_000, ..good.clone() }).is_err());
    assert!(check_prices("embeddings", &ModelPrices { input_micros: 12_000, ..ModelPrices::default() }).is_ok());
}

#[test]
fn staff_are_told_what_a_check_found() {
    let result = DiscoveryResult {
        provider: "anthropic".into(),
        added: vec!["claude-haiku-6".into()],
        deprecated: vec!["claude-haiku-4-5".into()],
        ..DiscoveryResult::default()
    };
    let (subject, lines) = discovery_email(&result);
    assert_eq!(subject, "g1t: new Anthropic models: claude-haiku-6");
    assert!(lines[0].contains("until you approve it with its prices in sudo"));
    assert!(lines[1].contains("no longer lists claude-haiku-4-5"));
    assert_eq!(discovery_detail(&result), "anthropic: new: claude-haiku-6; no longer listed: claude-haiku-4-5");
}

#[test]
fn dollars_read_plainly() {
    assert_eq!(dollars(100_000), "0.10");
    assert_eq!(dollars(2_000_000), "2");
    assert_eq!(dollars(12_500_000), "12.50");
    assert_eq!(dollars(10_000), "0.01");
    assert_eq!(dollars(125_000), "0.125");
}

#[test]
fn the_migration_seeds_every_purpose_as_routing_had_it() {
    let sql = include_str!("../migrations/0048_model_catalogue.sql");
    for purpose in MODEL_PURPOSES {
        assert!(sql.contains(&format!("('{purpose}', 'claude-")), "no seed for {purpose}");
    }
    for kind in JOB_KINDS {
        assert!(sql.contains(&format!("('job_{kind}', NULL, '")), "no seed for job_{kind}");
    }
    // As AGENT_ROUTING (services/runner/wrangler.jsonc) had them.
    let runner = include_str!("../../runner/wrangler.jsonc");
    for (purpose, model) in [("tier_small", "claude-haiku-5-5"), ("tier_large", "claude-sonnet-5-5"), ("tier_frontier", "claude-opus-5-5")] {
        assert!(sql.contains(&format!("('{purpose}', '{model}'")));
        assert!(runner.contains(&format!("\\\"model\\\":\\\"{model}\\\"")), "{model} is not in AGENT_ROUTING");
    }
    assert!(sql.contains("('job_plan', NULL, 'small', 'high'"));
    assert!(sql.contains("('job_review', NULL, 'change', NULL"));
    // Every column the discovery insert names exists.
    let insert = "model, name, provider, kind, input_micros, output_micros, cache_read_micros, cache_write_micros, cache_write_1h_micros, threshold, over_input_micros, over_output_micros, over_cache_read_micros, over_cache_write_micros, over_cache_write_1h_micros, position, updated_at, family, tier_hint, context_window, max_output, capabilities, status, priced, source, first_seen_at, last_seen_at";
    let all = [
        include_str!("../migrations/0045_gateway.sql"),
        include_str!("../migrations/0047_gateway_formats.sql"),
        sql,
    ]
    .concat();
    for column in insert.split(", ") {
        assert!(all.contains(&format!("{column} ")) || all.contains(&format!("{column},")), "gateway_models has no {column}");
    }
}
