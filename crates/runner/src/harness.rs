//! The agent harness. g1t does not implement its own agent loop: it runs
//! Claude Code headless and translates its event stream into session
//! entries.

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};

use anyhow::{Context, Result, bail};
use serde_json::Value;

use crate::report::{Entry, Reporter};

const MAX_TURNS: &str = "80";

/// A compact, readable rendering of a tool's input.
fn describe_input(tool: &str, input: &Value) -> String {
    let field = |name: &str| input.get(name).and_then(Value::as_str);
    match tool {
        "Bash" => field("command").unwrap_or_default().to_owned(),
        "Read" | "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => {
            field("file_path").unwrap_or_default().to_owned()
        }
        "Glob" | "Grep" => field("pattern").unwrap_or_default().to_owned(),
        _ => serde_json::to_string(input).unwrap_or_default(),
    }
}

/// The text of a tool result, which is either a string or content blocks.
fn result_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Records one line of Claude Code's `stream-json` output. Returns the final
/// result when the line is the one that ends the run.
fn handle_event(event: &Value, reporter: &mut Reporter) -> Option<Result<String>> {
    let blocks = || {
        event["message"]["content"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
    };
    match event["type"].as_str()? {
        "assistant" => {
            for block in blocks() {
                match block["type"].as_str() {
                    Some("text") => {
                        let text = block["text"].as_str().unwrap_or_default().trim();
                        if !text.is_empty() {
                            reporter.record(Entry::new("message", text));
                        }
                    }
                    Some("tool_use") => {
                        let tool = block["name"].as_str().unwrap_or("tool");
                        reporter.record(Entry::tool(
                            "tool_call",
                            tool,
                            &describe_input(tool, &block["input"]),
                        ));
                    }
                    _ => {}
                }
            }
            None
        }
        "user" => {
            for block in blocks() {
                if block["type"] == "tool_result" {
                    let text = result_text(&block["content"]);
                    if !text.trim().is_empty() {
                        reporter.record(Entry::tool("tool_result", "result", text.trim()));
                    }
                }
            }
            None
        }
        "result" => {
            let text = event["result"].as_str().unwrap_or_default().to_owned();
            Some(if event["is_error"].as_bool().unwrap_or(false) {
                Err(anyhow::anyhow!("the agent reported an error: {text}"))
            } else {
                Ok(text)
            })
        }
        _ => None,
    }
}

/// Runs Claude Code on `prompt` in `workdir` and returns its closing
/// summary.
pub fn run_claude(workdir: &Path, prompt: &str, reporter: &mut Reporter) -> Result<String> {
    let mut child = Command::new("claude")
        .current_dir(workdir)
        .args([
            "--print",
            prompt,
            "--output-format",
            "stream-json",
            "--verbose",
            "--max-turns",
            MAX_TURNS,
            // The sandbox is the permission boundary: it holds one fork and
            // one short-lived token, and nothing else.
            "--dangerously-skip-permissions",
        ])
        // The agent needs the model key and nothing else of ours.
        .env_remove("G1T_TOKEN")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .context("could not start Claude Code")?;

    let stdout = child.stdout.take().context("no output from Claude Code")?;
    let mut outcome = None;
    for line in BufReader::new(stdout).lines() {
        let line = line?;
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(result) = handle_event(&event, reporter) {
            outcome = Some(result);
        }
    }
    let status = child.wait()?;
    match outcome {
        Some(result) => result,
        None => bail!("Claude Code exited ({status}) without a result"),
    }
}
