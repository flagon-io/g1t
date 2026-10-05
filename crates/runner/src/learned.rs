//! What the agent learned, asked for at the end of every run that changes
//! code and reported to g1t as memory candidates.
//!
//! The question rides on the prompt rather than costing another model call:
//! the agent ends its closing summary with a `<g1t-learned>` block of JSON,
//! which is taken out of the summary (so the pull request reads as before)
//! and sent with the run's own token. g1t keeps a candidate once a second,
//! independent source says the same, or a person keeps it.

use std::time::Duration;

use serde_json::{Value, json};

const OPEN: &str = "<g1t-learned>";
const CLOSE: &str = "</g1t-learned>";
/// The most items taken from one run.
const MAX_ITEMS: usize = 8;
const MAX_TEXT_CHARS: usize = 300;
const MAX_EVIDENCE_CHARS: usize = 300;

/// What the agent is asked, after its task.
pub const ASK: &str = "When you are done, end your final message with what you learned here that the next agent would need and could not see at a glance: how to build or test, a convention, a decision and why, a trap. At most five short items, only ones you are sure of, never a secret, key or token. Write them as a JSON array inside <g1t-learned></g1t-learned> tags, each {\"kind\": \"fact\" | \"convention\" | \"decision\" | \"gotcha\", \"scope\": \"project\" | \"workspace\", \"text\": \"one sentence\", \"evidence\": \"what showed you, such as a command's output or a file\"}. scope workspace only for what holds in every project of the workspace. Write <g1t-learned>[]</g1t-learned> if there is nothing. The block is taken out of your summary.";

/// The prompt with the question added.
pub fn ask(prompt: &str) -> String {
    format!("{prompt}\n\n{ASK}")
}

fn clip(text: &str, max: usize) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= max {
        text
    } else {
        text.chars().take(max).collect()
    }
}

/// The summary without its `<g1t-learned>` block, and the items in it.
/// A block that is missing or not JSON yields no items and leaves the
/// summary as it was, less the block.
pub fn split(summary: &str) -> (String, Vec<Value>) {
    let Some(start) = summary.rfind(OPEN) else {
        return (summary.trim().to_owned(), Vec::new());
    };
    let body_start = start + OPEN.len();
    let end = summary[body_start..].find(CLOSE).map(|at| body_start + at);
    let body = &summary[body_start..end.unwrap_or(summary.len())];
    let rest = end.map_or("", |end| &summary[end + CLOSE.len()..]);
    let clean = format!("{}{}", summary[..start].trim_end(), rest.trim_end()).trim().to_owned();
    let body = body.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
    let items = serde_json::from_str::<Vec<Value>>(body)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| {
            let text = clip(item["text"].as_str()?, MAX_TEXT_CHARS);
            if text.is_empty() {
                return None;
            }
            let kind = item["kind"].as_str().filter(|kind| ["fact", "convention", "decision", "gotcha"].contains(kind));
            let scope = item["scope"].as_str().filter(|scope| ["project", "workspace"].contains(scope));
            Some(json!({
                "kind": kind.unwrap_or("fact"),
                "scope": scope.unwrap_or("project"),
                "text": text,
                "evidence": item["evidence"].as_str().map(|evidence| clip(evidence, MAX_EVIDENCE_CHARS)),
            }))
        })
        .take(MAX_ITEMS)
        .collect();
    (clean, items)
}

/// Sends what was learned with the run's token. Never fails the run.
pub fn report(items: &[Value]) {
    if items.is_empty() {
        return;
    }
    let (Ok(run), Ok(token)) = (std::env::var("AGENT_RUN"), std::env::var("AGENT_RUN_TOKEN")) else {
        return;
    };
    let api = std::env::var("G1T_API").unwrap_or_else(|_| "https://api.g1t.sh".to_owned());
    let sent = ureq::post(&format!("{}/agent-runs/{run}/learned", api.trim_end_matches('/')))
        .timeout(Duration::from_secs(10))
        .send_json(json!({ "token": token, "items": items }));
    if let Err(error) = sent {
        eprintln!("g1t-runner: could not report what the agent learned: {error}");
    }
}

/// The summary with its block taken out, after reporting what it held.
pub fn finish(summary: String) -> String {
    let (clean, items) = split(&summary);
    report(&items);
    clean
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_block_is_taken_out_and_read() {
        let summary = "Fixed the date tests.\n\n<g1t-learned>\n[{\"kind\": \"gotcha\", \"scope\": \"project\", \"text\": \"The date tests need TZ=UTC.\", \"evidence\": \"npm test failed in CI time zone\"}, {\"kind\": \"nonsense\", \"text\": \"We use pnpm.\", \"scope\": \"workspace\"}, {\"kind\": \"fact\"}]\n</g1t-learned>";
        let (clean, items) = split(summary);
        assert_eq!(clean, "Fixed the date tests.");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["kind"], "gotcha");
        assert_eq!(items[0]["evidence"], "npm test failed in CI time zone");
        assert_eq!(items[1]["kind"], "fact");
        assert_eq!(items[1]["scope"], "workspace");
    }

    #[test]
    fn a_missing_or_broken_block_teaches_nothing() {
        assert_eq!(split("Done."), ("Done.".to_owned(), Vec::new()));
        let (clean, items) = split("Done.\n<g1t-learned>not json</g1t-learned>");
        assert_eq!(clean, "Done.");
        assert!(items.is_empty());
        let (clean, items) = split("Done.\n<g1t-learned>\n```json\n[]\n```");
        assert_eq!(clean, "Done.");
        assert!(items.is_empty());
    }

    #[test]
    fn the_question_follows_the_task() {
        assert!(ask("Fix it.").starts_with("Fix it.\n\n"));
        assert!(ASK.contains("never a secret"));
    }
}
