//! Auto: the model Ask answers a question with when the workspace chose
//! none in particular. Two plain rules, no extra call to the provider:
//!
//! 1. [`need`]: whether the question is a lookup (who has #12, the link to
//!    a repository, how many pull requests are open) or needs more: several
//!    reads and reasoning over them, such as why or how something happened,
//!    what shipped, a summary of a day or a week, a failure to diagnose,
//!    work to plan, a long question or a long conversation.
//! 2. [`choose`]: among the models the provider listed when it was last
//!    checked, a lookup goes to its newest fast model (Haiku, a mini or
//!    flash model) and the rest to its newest standard one (Sonnet, GPT,
//!    Gemini Pro). The largest and most expensive tiers (Opus, a `pro` of
//!    OpenAI's) are used only when the provider offers nothing else: the
//!    workspace pays for every answer on its own key.
//!
//! Models are told apart by the words in their names, which every provider
//! uses the same way, so the rule needs no list of models to keep up to
//! date. A provider that lists none (an endpoint, an Azure deployment)
//! answers with its own model.

use g1t_contracts::ai::{AskMessage, AskRole};

/// What a question needs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Need {
    /// A lookup: one or two reads, a short answer.
    Quick,
    /// Several reads and reasoning over them.
    Deep,
}

/// Words that mean a question needs more than a lookup, as the starts of
/// words (`summar` is summary and summarize).
const DEEP: &[&str] = &[
    "why", "explain", "summar", "recap", "overview", "digest", "report", "ship", "deploy", "releas", "launch", "chang", "happen",
    "compar", "review", "plan", "propos", "investigat", "debug", "diagnos", "fail", "broke", "break", "error", "regress", "incident",
    "cause", "health", "progress", "block", "risk", "analy", "implement", "fix", "refactor", "design", "architect", "migrat",
    "today", "yesterday", "week", "month", "since", "lately", "recent", "history", "timeline",
];

/// A question this long needs more than a lookup, in characters.
const LONG_QUESTION: usize = 280;
/// A conversation this long needs the stronger model to keep track, in
/// characters.
const LONG_CONVERSATION: usize = 12_000;

/// What the conversation's last question needs.
pub fn need(messages: &[AskMessage]) -> Need {
    let Some(question) = messages.iter().rev().find(|message| message.role == AskRole::User) else {
        return Need::Quick;
    };
    let text = question.content.to_lowercase();
    let total: usize = messages.iter().map(|message| message.content.chars().count()).sum();
    if text.chars().count() > LONG_QUESTION || total > LONG_CONVERSATION {
        return Need::Deep;
    }
    // Several questions at once, or a list of asks.
    if text.matches('?').count() > 1 || text.lines().filter(|line| !line.trim().is_empty()).count() > 2 {
        return Need::Deep;
    }
    let words: Vec<&str> = text.split(|c: char| !c.is_alphanumeric()).filter(|word| !word.is_empty()).collect();
    for (at, word) in words.iter().enumerate() {
        // "How many" and "how much" count; "how" otherwise asks how
        // something works or came to be.
        if *word == "how" && !matches!(words.get(at + 1), Some(&("many" | "much" | "old" | "long" | "big"))) {
            return Need::Deep;
        }
        if DEEP.iter().any(|stem| word.starts_with(stem)) {
            return Need::Deep;
        }
    }
    Need::Quick
}

/// How big a model is, by the words in its name.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Tier {
    /// nano, lite: the smallest.
    Tiny,
    /// Haiku, mini, flash, small, instant.
    Fast,
    /// Sonnet, GPT, Gemini Pro, and any name that says nothing.
    Standard,
    /// Opus, ultra, OpenAI's pro: the most expensive.
    Largest,
}

/// The words of a model's name: `gpt-4o-mini` is gpt, 4o, mini.
fn words(id: &str) -> Vec<String> {
    id.to_lowercase().split(['-', '_', '.', '/', ':', ' ', '@']).filter(|word| !word.is_empty()).map(str::to_owned).collect()
}

/// A model's tier, or none for one Ask cannot use: code-only models
/// (OpenAI's Codex answers only its Responses API), ChatGPT's own
/// (which take no tools) and safety classifiers.
fn tier(id: &str) -> Option<Tier> {
    let words = words(id);
    let has = |word: &str| words.iter().any(|w| w == word);
    if words.iter().any(|w| w.contains("codex") || w == "chatgpt" || w.contains("guard")) {
        return None;
    }
    let gemini = words.iter().any(|w| w.starts_with("gemini") || w.starts_with("gemma"));
    Some(if has("nano") || has("lite") || has("tiny") {
        Tier::Tiny
    } else if has("haiku") || has("mini") || has("flash") || has("small") || has("instant") {
        Tier::Fast
    } else if has("opus") || has("ultra") || (has("pro") && !gemini) {
        Tier::Largest
    } else {
        Tier::Standard
    })
}

/// A model's version, from the numbers in its name: claude-sonnet-4-5 is
/// 4.5, gpt-4.1 is 4.1, gpt-4o is 4. Dates (20250929, 2024-08-06, 2411) and
/// sizes (70b) are not versions.
fn version(id: &str) -> Vec<u32> {
    let mut found = Vec::new();
    for word in words(id) {
        let digits: String = word.chars().take_while(char::is_ascii_digit).collect();
        if digits.is_empty() {
            continue;
        }
        let rest = &word[digits.len()..];
        // 70b, 8x7b: a size.
        if rest == "b" || rest.starts_with('x') || rest == "k" || rest == "m" {
            continue;
        }
        match digits.parse::<u32>() {
            Ok(number) if number < 1000 => found.push(number),
            _ => {}
        }
    }
    found
}

/// Whether a name is a dated snapshot rather than the name that follows the
/// newest (claude-sonnet-4-5-20250929, gpt-4o-2024-08-06).
fn dated(id: &str) -> bool {
    words(id).iter().any(|word| word.len() >= 4 && word.chars().all(|c| c.is_ascii_digit()))
}

/// The best of some models in a tier: the newest version, an alias before a
/// dated snapshot, then the shortest name, then by name.
fn best<'a>(models: impl Iterator<Item = &'a String>) -> Option<&'a String> {
    models.min_by(|a, b| {
        version(b)
            .cmp(&version(a))
            .then(dated(a).cmp(&dated(b)))
            .then(a.len().cmp(&b.len()))
            .then(a.cmp(b))
    })
}

/// The model Auto answers with: of `models` (what the provider listed), the
/// best of the tier the question needs, falling back to the nearest other
/// tier; `own` (the connection's own model) when the provider listed none
/// Ask can use. None when there is nothing at all.
pub fn choose(models: &[String], own: Option<&str>, need: Need) -> Option<String> {
    let order: &[Tier] = match need {
        Need::Quick => &[Tier::Fast, Tier::Standard, Tier::Tiny, Tier::Largest],
        Need::Deep => &[Tier::Standard, Tier::Largest, Tier::Fast, Tier::Tiny],
    };
    let usable: Vec<(&String, Tier)> = models.iter().filter_map(|model| tier(model).map(|tier| (model, tier))).collect();
    for wanted in order {
        if let Some(model) = best(usable.iter().filter(|(_, tier)| tier == wanted).map(|(model, _)| *model)) {
            return Some(model.clone());
        }
    }
    own.map(str::trim).filter(|own| !own.is_empty()).map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asked(question: &str) -> Vec<AskMessage> {
        vec![AskMessage { role: AskRole::User, content: question.to_owned() }]
    }

    fn list(models: &[&str]) -> Vec<String> {
        models.iter().map(|model| (*model).to_owned()).collect()
    }

    #[test]
    fn lookups_are_quick_and_questions_that_need_reasoning_are_deep() {
        for quick in [
            "Who is assigned to #12?",
            "Link me the docs repo",
            "How many open pull requests are there?",
            "List open pull requests in flagon-io/g1t",
            "Who owns the billing service?",
        ] {
            assert_eq!(need(&asked(quick)), Need::Quick, "{quick}");
        }
        for deep in [
            "What shipped today?",
            "Why did Deploy #312 fail?",
            "How does the merge queue decide what lands?",
            "Summarize this week in flagon-io",
            "What changed in the runner lately?",
            "Is production healthy?",
            "Plan the work for invoices",
            "What's in #12? And who reviews it?",
        ] {
            assert_eq!(need(&asked(deep)), Need::Deep, "{deep}");
        }
        // A long question, and a long conversation.
        assert_eq!(need(&asked(&"Who has it ".repeat(40))), Need::Deep);
        let mut long = Vec::new();
        for _ in 0..4 {
            long.push(AskMessage { role: AskRole::User, content: "a".into() });
            long.push(AskMessage { role: AskRole::Assistant, content: "x".repeat(4_000) });
        }
        long.push(AskMessage { role: AskRole::User, content: "Who has #3?".into() });
        assert_eq!(need(&long), Need::Deep);
        assert_eq!(need(&[]), Need::Quick);
    }

    #[test]
    fn anthropic_lookups_go_to_haiku_and_the_rest_to_sonnet_never_opus() {
        let models =
            list(&["claude-3-5-haiku-20241022", "claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-4-5-20250929", "claude-sonnet-5-5"]);
        assert_eq!(choose(&models, None, Need::Quick).as_deref(), Some("claude-haiku-5-5"));
        assert_eq!(choose(&models, None, Need::Deep).as_deref(), Some("claude-sonnet-5-5"));
        // Without a Sonnet, Opus; without a Haiku, Sonnet.
        assert_eq!(choose(&list(&["claude-haiku-5-5", "claude-opus-5-5"]), None, Need::Deep).as_deref(), Some("claude-opus-5-5"));
        assert_eq!(choose(&list(&["claude-sonnet-5-5", "claude-opus-5-5"]), None, Need::Quick).as_deref(), Some("claude-sonnet-5-5"));
        // An alias before its dated snapshot.
        assert_eq!(
            choose(&list(&["claude-sonnet-4-5-20250929", "claude-sonnet-4-5"]), None, Need::Deep).as_deref(),
            Some("claude-sonnet-4-5")
        );
    }

    #[test]
    fn other_providers_route_by_the_same_words() {
        // OpenAI: mini for lookups, the standard model otherwise; never pro,
        // Codex or ChatGPT's own.
        let openai = list(&["chatgpt-4o-latest", "gpt-4o", "gpt-4o-mini", "gpt-5", "gpt-5-codex", "gpt-5-mini", "gpt-5-nano", "gpt-5-pro", "o3"]);
        assert_eq!(choose(&openai, None, Need::Quick).as_deref(), Some("gpt-5-mini"));
        assert_eq!(choose(&openai, None, Need::Deep).as_deref(), Some("gpt-5"));
        // Gemini: flash, and pro (Gemini's standard tier).
        let gemini = list(&["gemini-2.0-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro"]);
        assert_eq!(choose(&gemini, None, Need::Quick).as_deref(), Some("gemini-2.5-flash"));
        assert_eq!(choose(&gemini, None, Need::Deep).as_deref(), Some("gemini-2.5-pro"));
        // Groq: an instant model, and a versatile one; sizes are not versions.
        let groq = list(&["llama-3.1-8b-instant", "llama-3.3-70b-versatile", "llama-guard-4-12b"]);
        assert_eq!(choose(&groq, None, Need::Quick).as_deref(), Some("llama-3.1-8b-instant"));
        assert_eq!(choose(&groq, None, Need::Deep).as_deref(), Some("llama-3.3-70b-versatile"));
        // Mistral: small, and large (its standard).
        let mistral = list(&["mistral-large-latest", "mistral-small-latest"]);
        assert_eq!(choose(&mistral, None, Need::Quick).as_deref(), Some("mistral-small-latest"));
        assert_eq!(choose(&mistral, None, Need::Deep).as_deref(), Some("mistral-large-latest"));
        // One model is every answer's.
        assert_eq!(choose(&list(&["qwen3-coder"]), None, Need::Quick).as_deref(), Some("qwen3-coder"));
    }

    #[test]
    fn a_provider_that_lists_nothing_answers_with_its_own_model() {
        assert_eq!(choose(&[], Some("prod-gpt"), Need::Deep).as_deref(), Some("prod-gpt"));
        assert_eq!(choose(&list(&["gpt-5-codex"]), Some("prod-gpt"), Need::Quick).as_deref(), Some("prod-gpt"));
        assert_eq!(choose(&[], Some(" "), Need::Quick), None);
        assert_eq!(choose(&[], None, Need::Quick), None);
    }
}
