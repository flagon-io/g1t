//! How sure the agent is of its own change, asked for at the end of every
//! run that makes or revises one and reported to g1t.
//!
//! Like `learned`, the question rides on the prompt: the agent ends its
//! closing summary with a `<g1t-confidence>` block of JSON, which is taken
//! out of the summary and sent with the run's own token. g1t combines it
//! with what it observes of the change (its checks, revisions, review,
//! tests, size, guardrails); what it observes can only lower what the agent
//! says, never raise it.

use std::time::Duration;

use serde_json::{Value, json};

const OPEN: &str = "<g1t-confidence>";
const CLOSE: &str = "</g1t-confidence>";
const MAX_ITEMS: usize = 5;
const MAX_ITEM_CHARS: usize = 160;

/// What the agent is asked, after its task.
pub const ASK: &str = "Also end your final message with how sure you are that your change is right and complete, as JSON inside <g1t-confidence></g1t-confidence> tags: {\"confidence\": \"high\" | \"medium\" | \"low\", \"uncertain_about\": [\"a few words for each thing you could not verify or had to guess\"]}. Say high only if you ran the checks and tests and they passed and nothing was guessed. The block is taken out of your summary.";

/// The prompt with the question added.
pub fn ask(prompt: &str) -> String {
    format!("{prompt}\n\n{ASK}")
}

/// What the agent said: its level and what it was unsure about.
#[derive(Debug, PartialEq)]
pub struct SelfReport {
    pub confidence: &'static str,
    pub uncertain_about: Vec<String>,
}

fn clip(text: &str) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    text.chars().take(MAX_ITEM_CHARS).collect()
}

/// The summary without its `<g1t-confidence>` block, and what the block
/// said. A missing or unreadable block reports nothing.
pub fn split(summary: &str) -> (String, Option<SelfReport>) {
    let Some(start) = summary.rfind(OPEN) else {
        return (summary.trim().to_owned(), None);
    };
    let body_start = start + OPEN.len();
    let end = summary[body_start..].find(CLOSE).map(|at| body_start + at);
    let body = &summary[body_start..end.unwrap_or(summary.len())];
    let rest = end.map_or("", |end| &summary[end + CLOSE.len()..]);
    let clean = format!("{}{}", summary[..start].trim_end(), rest.trim_end()).trim().to_owned();
    let body = body.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return (clean, None);
    };
    let confidence = match value["confidence"].as_str().map(|level| level.trim().to_ascii_lowercase()) {
        Some(level) if level == "high" => "high",
        Some(level) if level == "medium" => "medium",
        Some(level) if level == "low" => "low",
        _ => return (clean, None),
    };
    let uncertain_about = value["uncertain_about"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(clip)
                .filter(|item| !item.is_empty())
                .take(MAX_ITEMS)
                .collect()
        })
        .unwrap_or_default();
    (clean, Some(SelfReport { confidence, uncertain_about }))
}

/// Sends what the agent said with the run's token. Never fails the run.
pub fn report(said: &SelfReport) {
    let (Ok(run), Ok(token)) = (std::env::var("AGENT_RUN"), std::env::var("AGENT_RUN_TOKEN")) else {
        return;
    };
    let api = std::env::var("G1T_API").unwrap_or_else(|_| "https://api.g1t.sh".to_owned());
    let sent = ureq::post(&format!("{}/agent-runs/{run}/confidence", api.trim_end_matches('/')))
        .timeout(Duration::from_secs(10))
        .send_json(json!({
            "token": token,
            "confidence": said.confidence,
            "uncertain_about": said.uncertain_about,
        }));
    if let Err(error) = sent {
        eprintln!("g1t-runner: could not report how sure the agent is: {error}");
    }
}

/// The summary with its block taken out, after reporting what it said.
pub fn finish(summary: String) -> String {
    let (clean, said) = split(&summary);
    if let Some(said) = &said {
        report(said);
    }
    clean
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_block_is_taken_out_and_read() {
        let summary = "Added retries with backoff.\n\n<g1t-confidence>{\"confidence\": \"Medium\", \"uncertain_about\": [\"  the retry   limit \", \"\", 3]}</g1t-confidence>";
        let (clean, said) = split(summary);
        assert_eq!(clean, "Added retries with backoff.");
        assert_eq!(
            said,
            Some(SelfReport { confidence: "medium", uncertain_about: vec!["the retry limit".to_owned()] })
        );
    }

    #[test]
    fn a_missing_or_unknown_level_reports_nothing() {
        assert_eq!(split("Done."), ("Done.".to_owned(), None));
        assert_eq!(split("Done.\n<g1t-confidence>not json</g1t-confidence>").1, None);
        assert_eq!(split("Done.\n<g1t-confidence>{\"confidence\": \"very\"}</g1t-confidence>").1, None);
        let (clean, said) = split("Done.\n<g1t-confidence>\n```json\n{\"confidence\": \"high\"}\n```\n</g1t-confidence>");
        assert_eq!(clean, "Done.");
        assert_eq!(said.map(|said| said.confidence), Some("high"));
    }

    #[test]
    fn it_leaves_the_learned_block_alone() {
        let summary = "Fixed it.\n<g1t-learned>[]</g1t-learned>\n<g1t-confidence>{\"confidence\": \"low\"}</g1t-confidence>";
        let (clean, said) = split(summary);
        assert_eq!(clean, "Fixed it.\n<g1t-learned>[]</g1t-learned>");
        assert_eq!(said.map(|said| said.confidence), Some("low"));
        assert!(ask("Fix it.").starts_with("Fix it.\n\n"));
    }
}
