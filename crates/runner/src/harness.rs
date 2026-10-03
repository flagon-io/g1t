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

/// Tells g1t what the run cost, so that the workspace it was for can be
/// charged. The run's own token, given to this sandbox and to nothing
/// else, is the credential. Does nothing where runs are not billed.
fn report_cost(cost_usd: f64, turns: u64) {
    let (Ok(api), Ok(run), Ok(token)) = (
        std::env::var("G1T_API"),
        std::env::var("BILLING_RUN"),
        std::env::var("BILLING_TOKEN"),
    ) else {
        return;
    };
    let sent = ureq::post(&format!("{api}/runs/{run}/usage")).send_json(serde_json::json!({
        "token": token,
        "cost_usd": cost_usd,
        "turns": turns,
    }));
    if let Err(error) = sent {
        eprintln!("g1t-runner: could not report what the run cost: {error}");
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
            // What the run cost, as the harness worked it out, kept with
            // the session so that spend can be read per pull request.
            if let Some(cost) = event["total_cost_usd"].as_f64() {
                let turns = event["num_turns"].as_u64().unwrap_or_default();
                report_cost(cost, turns);
                reporter.record(Entry::new(
                    "note",
                    &format!("This run cost ${cost:.4} over {turns} turns."),
                ));
            }
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
    // g1t's own tools, through a token that can do a few things in this one
    // repository: read its issues, pull requests and merge queue, open an
    // issue, and comment.
    let mut tools = Vec::new();
    if let Ok(token) = std::env::var("G1T_AGENT_TOKEN") {
        let config = serde_json::json!({
            "mcpServers": {
                "g1t": {
                    "type": "http",
                    "url": std::env::var("G1T_MCP").unwrap_or_else(|_| "https://mcp.g1t.sh".to_owned()),
                    "headers": { "Authorization": format!("Bearer {token}") },
                }
            }
        });
        let path = "/work/g1t-mcp.json";
        if std::fs::write(path, config.to_string()).is_ok() {
            tools = vec!["--mcp-config".to_owned(), path.to_owned()];
        }
        // People can message the agent while it works: after each tool call
        // a hook asks g1t for messages and hands any to the agent.
        if let (Ok(repo), Ok(number)) = (std::env::var("G1T_REPO"), std::env::var("PULL_NUMBER")) {
            let steer = serde_json::json!({
                "api": std::env::var("G1T_API").unwrap_or_else(|_| "https://api.g1t.sh".to_owned()),
                "token": token,
                "repo": repo,
                "number": number.parse::<u32>().unwrap_or_default(),
            });
            let hooks = serde_json::json!({
                "hooks": {
                    "PostToolUse": [{
                        "matcher": "*",
                        "hooks": [{ "type": "command", "command": "MODE=steer /usr/local/bin/g1t-runner", "timeout": 15 }],
                    }],
                    "Stop": [{
                        "hooks": [{ "type": "command", "command": "MODE=steer G1T_HOOK=stop /usr/local/bin/g1t-runner", "timeout": 15 }],
                    }],
                }
            });
            let home = std::env::var("HOME").unwrap_or_else(|_| "/home/node".to_owned());
            let settings = format!("{home}/.claude/settings.json");
            if std::fs::write(crate::steer::CONFIG, steer.to_string()).is_ok()
                && std::fs::create_dir_all(format!("{home}/.claude")).is_ok()
            {
                let _ = std::fs::write(settings, hooks.to_string());
            }
        }
    }
    let mut child = Command::new("claude")
        .current_dir(workdir)
        .args(&tools)
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
        .env_remove("REVIEW_TOKEN")
        .env_remove("CHECK_TOKEN")
        .env_remove("BILLING_TOKEN")
        .env_remove("PLAN_TOKEN")
        .env_remove("G1T_AGENT_TOKEN")
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
