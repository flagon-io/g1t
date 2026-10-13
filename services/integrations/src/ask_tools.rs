//! The tools Ask g1t answers with, and what it may do with them.
//!
//! **g1t's own tools.** Ask is an MCP client of g1t's own MCP server: it
//! lists the tools there and calls them, so the model gets exactly the tool
//! definitions any agent gets, and every call goes through the API's own
//! permission checks, audit log and rate limits. It calls them with a
//! credential identity makes for the one answer (`create_ask_token`): the
//! person's own access, read scopes only, for the one workspace, minutes
//! long, revoked when the answer ends. The model never sees it, nor does
//! the browser. The server lists only the actions the credential may use,
//! and refuses any other.
//!
//! **What Ask may do** is decided here, per call, before anything runs
//! ([`Toolbox::decide`]): a read runs; anything else is refused. Ask never
//! does the work itself: when someone asks for work, it hands it to a
//! session in their own harness. Starting that session is a [`Kind::Dispatch`]
//! (and so is opening the issue the work hangs off): it will run only after
//! the person confirms it, which is the next step and not built yet.
//!
//! **g1t-native tools**, that are not operations of the MCP server, are
//! registered in [`native`]: `start_session` goes there when sessions can
//! be started on the workspace's own Anthropic key.
//!
//! The rest is plain functions, tested on their own: a step's label, link
//! and summary for the person watching, a result trimmed to fit, and the
//! pages an answer drew on.

use std::collections::{BTreeMap, HashSet};

use g1t_contracts::integrations::{ASK_MAX_SOURCES, AskEvent, AskSource};
use serde_json::{Map, Value, json};
use worker::Method;

use crate::ask::ToolSpec;
use crate::http;

/// The MCP protocol version Ask speaks.
const PROTOCOL: &str = "2025-06-18";

/// g1t's MCP server, as the person asking.
#[derive(Clone)]
pub struct Mcp {
    pub url: String,
    pub token: String,
}

/// A tool as the MCP server lists it.
#[derive(Clone, Debug, PartialEq)]
pub struct Listed {
    pub spec: ToolSpec,
    /// Every action the caller may use only reads.
    pub read_only: bool,
    /// The actions offered, from the schema's `action` enum.
    pub actions: Vec<String>,
    /// The action a call without one runs.
    pub default_action: Option<String>,
}

impl Mcp {
    async fn rpc(&self, method: &str, params: Value) -> Result<Value, String> {
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }).to_string();
        let authorization = format!("Bearer {}", self.token);
        let headers = [
            ("authorization", authorization.as_str()),
            ("content-type", "application/json"),
            ("accept", "application/json, text/event-stream"),
            ("mcp-protocol-version", PROTOCOL),
        ];
        let answer = http::send(Method::Post, &self.url, &headers, Some(body))
            .await
            .map_err(|error| format!("g1t could not be reached: {error}"))?;
        if !answer.ok() {
            return Err(match answer.status {
                401 => "g1t did not accept Ask's credential.".to_owned(),
                429 => "g1t is busy: too many requests. Try again in a minute.".to_owned(),
                status => format!("g1t answered {status}."),
            });
        }
        let said = answer.json();
        if let Some(message) = said["error"]["message"].as_str() {
            return Err(message.to_owned());
        }
        Ok(said["result"].clone())
    }

    /// The tools the person may use, as the server lists them for them.
    pub async fn list(&self) -> Result<Vec<Listed>, String> {
        let result = self.rpc("tools/list", json!({})).await?;
        Ok(listed(&result))
    }

    /// Runs a tool: its result as text, and whether it is a refusal or an
    /// error.
    pub async fn call(&self, name: &str, arguments: &Value) -> Result<(String, bool), String> {
        let result = self.rpc("tools/call", json!({ "name": name, "arguments": arguments })).await?;
        let text: Vec<&str> = result["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|part| part["type"] == "text")
            .filter_map(|part| part["text"].as_str())
            .collect();
        Ok((text.join("\n"), result["isError"].as_bool() == Some(true)))
    }
}

/// `tools/list`'s result read.
pub fn listed(result: &Value) -> Vec<Listed> {
    result["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|tool| {
            let name = tool["name"].as_str().filter(|name| !name.is_empty())?;
            let schema = tool["inputSchema"].clone();
            let action = &schema["properties"]["action"];
            Some(Listed {
                spec: ToolSpec {
                    name: name.to_owned(),
                    description: tool["description"].as_str().unwrap_or_default().to_owned(),
                    input_schema: if schema.is_object() { schema.clone() } else { json!({ "type": "object" }) },
                },
                read_only: tool["annotations"]["readOnlyHint"].as_bool() == Some(true),
                actions: action["enum"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect(),
                default_action: action["default"].as_str().map(str::to_owned),
            })
        })
        .collect()
}

/// What a tool does, for deciding whether Ask may run it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// Reads: runs.
    Read,
    /// Hands work off: starts a session in the person's own harness, or
    /// opens the issue the work hangs off. Runs only once the person
    /// confirms it: the answer shows it as a proposal to start.
    Dispatch,
    /// Anything else Ask does not do.
    Change,
}

/// Whether a call runs.
#[derive(Debug, PartialEq)]
pub enum Decision {
    Run,
    /// Needs the person's yes first.
    Confirm,
    Refuse(String),
}

/// Where a tool comes from.
#[derive(Clone, Debug, PartialEq)]
enum Origin {
    Mcp { actions: Vec<String>, default_action: Option<String> },
    Native,
}

#[derive(Clone, Debug)]
struct Entry {
    origin: Origin,
    kind: Kind,
}

/// The tools one answer may use.
#[derive(Clone, Debug, Default)]
pub struct Toolbox {
    specs: Vec<ToolSpec>,
    entries: BTreeMap<String, Entry>,
}

/// A g1t-native tool: one that is not an operation of the MCP server.
pub struct Native {
    pub spec: ToolSpec,
    pub kind: Kind,
}

/// The g1t-native tool that hands work off: Ask proposes a session and the
/// person starts it from the card the answer shows. The click is the
/// confirmation, so the model never starts anything itself.
pub const PROPOSE_SESSION: &str = "propose_session";

/// The g1t-native tools Ask offers: `propose_session`, a
/// [`Kind::Dispatch`] that the loop turns into a proposal event rather
/// than running.
pub fn native() -> Vec<Native> {
    vec![Native {
        spec: ToolSpec {
            name: PROPOSE_SESSION.to_owned(),
            description: "Propose handing work to a coding session in the person's own harness (their Claude, with                 their skills and subagents), tied to an issue. Use it when they ask for work to be done: planning,                 implementing, fixing or reviewing. It starts nothing: the person sees a card to start the session                 on their workspace's Anthropic account, or to copy a Claude Code command to run it themselves. Give                 `issue` when the work has one (read it first), else `title` and `body` for a new issue. Propose one                 session per piece of work."
                .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "repo": { "type": "string", "description": "The repository, owner/name." },
                    "issue": { "type": "integer", "description": "The issue the work belongs to." },
                    "title": { "type": "string", "description": "A new issue's title, when there is no issue yet." },
                    "body": { "type": "string", "description": "A new issue's description: what to do and what done means." },
                    "mode": { "type": "string", "enum": ["plan", "implement", "review"], "description": "plan: work out how and post the plan, no code. implement: make the change and open a pull request. review: review the issue's pull request." },
                    "instruction": { "type": "string", "description": "Anything the session should know beyond the issue." }
                },
                "required": ["repo", "mode"]
            }),
        },
        kind: Kind::Dispatch,
    }]
}

/// A proposal from a `propose_session` call, or what is wrong with it.
pub fn proposal(id: &str, arguments: &Value) -> Result<AskEvent, String> {
    let text = |key: &str| arguments[key].as_str().map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned);
    let repo = text("repo").filter(|repo| repo.split('/').count() == 2).ok_or("Give the repository as owner/name.")?;
    let issue = arguments["issue"].as_u64().filter(|number| *number > 0);
    let title = text("title");
    if issue.is_none() && title.is_none() {
        return Err("Give the issue the work belongs to, or a title and body for a new one.".to_owned());
    }
    let mode = match text("mode").as_deref() {
        Some(mode @ ("plan" | "implement" | "review")) => mode.to_owned(),
        _ => return Err("Give a mode: plan, implement or review.".to_owned()),
    };
    let clip = |value: Option<String>, max: usize| value.map(|value| value.chars().take(max).collect::<String>());
    Ok(AskEvent::Proposal {
        id: id.to_owned(),
        repo,
        issue,
        title: if issue.is_some() { None } else { clip(title, 200) },
        body: if issue.is_some() { None } else { clip(text("body"), 8_000) },
        mode,
        instruction: clip(text("instruction"), 4_000),
    })
}

/// Runs a g1t-native tool. `propose_session` never runs here: the loop
/// turns it into a proposal.
pub async fn run_native(name: &str, _arguments: &Value) -> Result<(String, bool), String> {
    Err(format!("{name} is not something Ask can do."))
}

impl Toolbox {
    /// From what the MCP server listed, and the native tools.
    pub fn new(listed: Vec<Listed>, natives: Vec<Native>) -> Self {
        let mut toolbox = Toolbox::default();
        for tool in listed {
            // A read-only credential lists reads only; a tool that says
            // otherwise is not one Ask uses.
            let kind = if tool.read_only { Kind::Read } else { Kind::Change };
            if kind != Kind::Read {
                continue;
            }
            toolbox.entries.insert(
                tool.spec.name.clone(),
                Entry { origin: Origin::Mcp { actions: tool.actions, default_action: tool.default_action }, kind },
            );
            toolbox.specs.push(tool.spec);
        }
        for tool in natives {
            if toolbox.entries.contains_key(&tool.spec.name) {
                continue;
            }
            toolbox.entries.insert(tool.spec.name.clone(), Entry { origin: Origin::Native, kind: tool.kind });
            toolbox.specs.push(tool.spec);
        }
        toolbox
    }

    pub fn specs(&self) -> &[ToolSpec] {
        &self.specs
    }

    pub fn is_empty(&self) -> bool {
        self.specs.is_empty()
    }

    pub fn is_native(&self, name: &str) -> bool {
        self.entries.get(name).is_some_and(|entry| entry.origin == Origin::Native)
    }

    /// Whether a call the model asked for runs.
    pub fn decide(&self, name: &str, arguments: &Value) -> Decision {
        let Some(entry) = self.entries.get(name) else {
            return Decision::Refuse(format!("There is no tool {name}."));
        };
        if let Origin::Mcp { actions, default_action } = &entry.origin {
            let action = arguments["action"].as_str().map(str::to_owned).or_else(|| default_action.clone());
            match action {
                Some(action) if actions.is_empty() || actions.contains(&action) => {}
                Some(action) => {
                    return Decision::Refuse(format!(
                        "{name} {action} is not something Ask can do: it reads g1t and hands work off, and changes nothing itself. Its actions: {}.",
                        actions.join(", ")
                    ));
                }
                None if actions.is_empty() => {}
                None => return Decision::Refuse(format!("Give an action: one of {}.", actions.join(", "))),
            }
        }
        match entry.kind {
            Kind::Read => Decision::Run,
            Kind::Dispatch => Decision::Confirm,
            Kind::Change => Decision::Refuse(format!("{name} changes g1t, which Ask does not do.")),
        }
    }
}

// --- What the person watching sees ------------------------------------------

/// The repository or workspace a call is about, as given.
fn target(arguments: &Value) -> Option<String> {
    let repo = arguments["repo"].as_str().or_else(|| arguments["repository"].as_str()).filter(|repo| repo.contains('/'));
    repo.or_else(|| arguments["workspace"].as_str()).map(str::to_owned).filter(|target| !target.is_empty())
}

fn noun(tool: &str, plural: bool) -> String {
    let (one, many) = match tool {
        "pull_request" => ("pull request", "pull requests"),
        "issue" => ("issue", "issues"),
        "repository" => ("repository", "repositories"),
        "workflow" => ("workflow", "workflows"),
        "workspace" => ("workspace", "workspaces"),
        "notifications" => ("notification", "notifications"),
        "package" => ("package", "packages"),
        "team" => ("team", "teams"),
        "artifact" => ("artifact", "artifacts"),
        "security" => ("security alert", "security alerts"),
        "observability" => ("production telemetry", "production telemetry"),
        other => return other.replace('_', " "),
    };
    (if plural { many } else { one }).to_owned()
}

/// One line saying what a call does: "Read pull request #7 in acme/web".
pub fn label(tool: &str, arguments: &Value) -> String {
    let action = arguments["action"].as_str().unwrap_or_default();
    let place = target(arguments).map(|target| format!(" in {target}")).unwrap_or_default();
    if tool == "search" && action != "ticket" {
        let query = arguments["query"].as_str().or_else(|| arguments["q"].as_str()).unwrap_or_default();
        let query: String = query.chars().take(80).collect();
        return format!("Searched g1t for \u{201c}{query}\u{201d}");
    }
    if tool == PROPOSE_SESSION {
        let what = arguments["issue"].as_u64().map(|number| format!("issue #{number}")).unwrap_or_else(|| "a new issue".to_owned());
        let repo = arguments["repo"].as_str().unwrap_or("the repository");
        return format!("Proposed a session on {what} in {repo}");
    }
    if tool == "workspace" && action == "activity" {
        let since = arguments["since"].as_str().map(|since| format!(" since {}", since.trim_end_matches("T00:00:00Z"))).unwrap_or_default();
        return format!("Read activity{place}{since}");
    }
    let number = arguments["number"].as_u64().map(|number| format!(" #{number}")).unwrap_or_default();
    let (verb, rest) = match action {
        "" | "get" => ("Read", None),
        "list" => ("Listed", None),
        _ => match action.split_once('_') {
            Some(("list", rest)) => ("Listed", Some(rest)),
            Some(("get", rest)) => ("Read", Some(rest)),
            _ => ("Read", Some(action)),
        },
    };
    let what = match rest {
        None => noun(tool, action == "list" && number.is_empty()),
        Some(rest) if number.is_empty() => rest.replace('_', " "),
        Some(rest) => format!("{} {}", noun(tool, false), rest.replace('_', " ")),
    };
    // "Read pull request #7 changes" reads better as "Read changes of pull request #7".
    let what = match (rest, number.is_empty()) {
        (Some(rest), false) => format!("{} of {}{number}", rest.replace('_', " "), noun(tool, false)),
        _ => format!("{what}{number}"),
    };
    format!("{verb} {what}{place}")
}

/// The page on the site a call is about, when it names one.
pub fn link(site: &str, tool: &str, arguments: &Value) -> Option<String> {
    let site = site.trim_end_matches('/');
    let action = arguments["action"].as_str().unwrap_or_default();
    if let Some(repo) = arguments["repo"].as_str().filter(|repo| repo.contains('/') && !repo.contains(' ')) {
        let repo = repo.trim_matches('/');
        let number = arguments["number"].as_u64();
        return Some(match (tool, number) {
            ("pull_request", Some(number)) => format!("{site}/{repo}/pull/{number}"),
            ("pull_request", None) => format!("{site}/{repo}/pulls"),
            ("issue", Some(number)) => format!("{site}/{repo}/issues/{number}"),
            ("issue", None) => format!("{site}/{repo}/issues"),
            ("workflow", _) => match arguments["run_id"].as_str().or_else(|| arguments["run_id"].as_u64().map(|_| "")) {
                Some("") | None => format!("{site}/{repo}/actions"),
                Some(run) => format!("{site}/{repo}/actions/runs/{run}"),
            },
            ("repository", _) if action.contains("release") => format!("{site}/{repo}/releases"),
            _ => format!("{site}/{repo}"),
        });
    }
    arguments["workspace"].as_str().filter(|slug| !slug.is_empty() && !slug.contains('/')).map(|slug| format!("{site}/{slug}"))
}

/// One line saying what a call found, for the person watching.
pub fn summary(text: &str, failed: bool) -> String {
    if failed {
        let first = text.lines().find(|line| !line.trim().is_empty()).unwrap_or("It failed.");
        return first.chars().take(160).collect();
    }
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return "Done".to_owned();
    };
    let count = |n: usize| if n == 1 { "1 result".to_owned() } else { format!("{n} results") };
    match &value {
        Value::Array(items) => count(items.len()),
        Value::Object(fields) => {
            // The list an answer is about, where it has one.
            for key in ["events", "items", "results", "pulls", "issues", "runs", "workflow_runs", "jobs", "chunks", "entries", "repositories", "threads"] {
                if let Some(items) = fields.get(key).and_then(Value::as_array) {
                    return count(items.len());
                }
            }
            match fields.get("title").and_then(Value::as_str) {
                Some(title) => title.chars().take(120).collect(),
                None => "Done".to_owned(),
            }
        }
        _ => "Done".to_owned(),
    }
}

// --- What the model is given --------------------------------------------------

/// Keys that cost the model tokens and tell it nothing.
const NOISE: &[&str] = &["avatar_url", "gravatar_id", "node_id", "avatar", "etag"];

/// Which end of a long result matters: the start of a list (newest first),
/// or the end of a log, where a failed job says why.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Keep {
    Start,
    End,
}

impl Keep {
    /// The end a call's result is read from.
    pub fn of(tool: &str, arguments: &Value) -> Keep {
        if tool == "workflow" && arguments["action"].as_str().is_some_and(|action| action.contains("log")) {
            Keep::End
        } else {
            Keep::Start
        }
    }
}

/// A result as the model is given it: compact JSON, at most `max`
/// characters. Long texts and long lists are trimmed first, each saying
/// how much was left out, so what is kept is still whole and readable; only
/// then is the text cut, with a note saying how to read the rest. `keep`
/// says which end of a list or text to keep.
pub fn trim_result(text: &str, max: usize, keep: Keep) -> String {
    let max = max.max(200);
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return cut(text, max, keep);
    };
    let value = strip(value);
    let compact = value.to_string();
    if compact.chars().count() <= max {
        return compact;
    }
    // Trim texts and lists, harder each time, until it fits.
    for (chars, items) in [(4_000, 100), (1_500, 50), (600, 25), (300, 12), (160, 6), (100, 3)] {
        let trimmed = shorten(&value, chars, items, keep).to_string();
        if trimmed.chars().count() <= max {
            return trimmed;
        }
    }
    cut(&shorten(&value, 100, 3, keep).to_string(), max, keep)
}

fn cut(text: &str, max: usize, keep: Keep) -> String {
    let total = text.chars().count();
    if total <= max {
        return text.to_owned();
    }
    let room = max.saturating_sub(120);
    let left = total - room;
    match keep {
        Keep::Start => {
            let kept: String = text.chars().take(room).collect();
            format!("{kept}\n[Cut: {left} more characters not shown. Ask for less: a narrower filter, a shorter span or one item.]")
        }
        Keep::End => {
            let kept: String = text.chars().skip(left).collect();
            format!("[Cut: the first {left} characters not shown.]\n{kept}")
        }
    }
}

fn strip(value: Value) -> Value {
    match value {
        Value::Object(fields) => Value::Object(
            fields
                .into_iter()
                .filter(|(key, value)| !NOISE.contains(&key.as_str()) && !value.as_str().is_some_and(|text| text.contains("{?")))
                .map(|(key, value)| (key, strip(value)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(strip).collect()),
        other => other,
    }
}

fn shorten(value: &Value, chars: usize, items: usize, keep: Keep) -> Value {
    match value {
        Value::String(text) if text.chars().count() > chars => {
            let total = text.chars().count();
            match keep {
                Keep::Start => {
                    let kept: String = text.chars().take(chars).collect();
                    json!(format!("{kept}… [{} more characters]", total - chars))
                }
                Keep::End => {
                    let kept: String = text.chars().skip(total - chars).collect();
                    json!(format!("[{} characters before] …{kept}", total - chars))
                }
            }
        }
        Value::Array(list) if list.len() > items => {
            let note = json!(format!("[{} more not shown: ask for fewer, or another page]", list.len() - items));
            let shortened = |item: &Value| shorten(item, chars, items, keep);
            match keep {
                Keep::Start => {
                    let mut kept: Vec<Value> = list.iter().take(items).map(shortened).collect();
                    kept.push(note);
                    Value::Array(kept)
                }
                Keep::End => {
                    let mut kept = vec![note];
                    kept.extend(list.iter().skip(list.len() - items).map(shortened));
                    Value::Array(kept)
                }
            }
        }
        Value::Array(list) => Value::Array(list.iter().map(|item| shorten(item, chars, items, keep)).collect()),
        Value::Object(fields) => Value::Object(
            fields.iter().map(|(key, value)| (key.clone(), shorten(value, chars, items, keep))).collect::<Map<_, _>>(),
        ),
        other => other.clone(),
    }
}

// --- Sources -------------------------------------------------------------------

/// The pages on g1t an answer read, kept in the order first read.
#[derive(Default)]
pub struct Sources {
    found: Vec<(String, String, bool)>,
    seen: HashSet<String>,
}

/// The most pages kept from what one answer read.
const MOST_READ: usize = 400;

impl Sources {
    fn add(&mut self, url: String, title: String, direct: bool) {
        if self.found.len() >= MOST_READ {
            return;
        }
        let url = url.trim_end_matches('/').to_owned();
        if self.seen.insert(url.clone()) {
            self.found.push((url, title, direct));
        } else if direct && let Some(found) = self.found.iter_mut().find(|found| found.0 == url) {
            found.2 = true;
        }
    }

    /// Notes the pages a call's result names: each item's own `url` or
    /// `html_url` on the site, a repository, and the issues and pull
    /// requests of the repository it was about. `direct` for a call about
    /// one thing (its link), which is a source whether cited or not.
    pub fn read(&mut self, site: &str, tool: &str, arguments: &Value, text: &str, direct: Option<(&str, &str)>) {
        let site = site.trim_end_matches('/');
        if let Some((url, title)) = direct {
            self.add(url.to_owned(), title.to_owned(), true);
        }
        let Ok(value) = serde_json::from_str::<Value>(text) else {
            return;
        };
        let repo = arguments["repo"].as_str().filter(|repo| repo.contains('/')).map(|repo| repo.trim_matches('/').to_owned());
        self.walk(site, tool, repo.as_deref(), &value, 0);
    }

    fn walk(&mut self, site: &str, tool: &str, repo: Option<&str>, value: &Value, depth: usize) {
        if depth > 6 {
            return;
        }
        match value {
            Value::Array(items) => items.iter().for_each(|item| self.walk(site, tool, repo, item, depth + 1)),
            Value::Object(fields) => {
                let text = |key: &str| fields.get(key).and_then(Value::as_str).filter(|text| !text.is_empty());
                let number = fields.get("number").and_then(Value::as_u64);
                let title = text("title").or_else(|| text("name")).or_else(|| text("full_name")).or_else(|| text("tag"));
                let own = text("html_url").or_else(|| text("url")).filter(|url| url.starts_with(site));
                if let Some(url) = own {
                    let title = match (title, number) {
                        (Some(title), Some(number)) => format!("#{number} {title}"),
                        (Some(title), None) => title.to_owned(),
                        (None, _) => url.trim_start_matches(site).trim_start_matches('/').to_owned(),
                    };
                    self.add(url.to_owned(), title, false);
                } else if let (Some(repo), Some(number), Some(title)) = (repo, number, text("title")) {
                    let section = if tool == "pull_request" || fields.contains_key("merged_at") { "pull" } else { "issues" };
                    self.add(format!("{site}/{repo}/{section}/{number}"), format!("#{number} {title}"), false);
                } else if let (Some(namespace), Some(name)) = (text("namespace"), text("name"))
                    && fields.contains_key("default_branch")
                {
                    self.add(format!("{site}/{namespace}/{name}"), format!("{namespace}/{name}"), false);
                }
                for (key, value) in fields {
                    if matches!(value, Value::Array(_) | Value::Object(_)) && key != "author" && key != "user" {
                        self.walk(site, tool, repo, value, depth + 1);
                    }
                }
            }
            _ => {}
        }
    }

    /// What the answer drew on: the pages it links to, in the order read,
    /// then those it read directly, at most [`ASK_MAX_SOURCES`].
    pub fn finish(&self, site: &str, answer: &str) -> Vec<AskSource> {
        let site = site.trim_end_matches('/');
        let cites = |url: &str| {
            let path = url.trim_start_matches(site);
            answer.contains(url) || (!path.is_empty() && path != "/" && contains_path(answer, path))
        };
        let mut sources: Vec<AskSource> = self
            .found
            .iter()
            .filter(|(url, _, _)| cites(url))
            .map(|(url, title, _)| AskSource { title: title.clone(), url: url.clone(), cited: true })
            .collect();
        for (url, title, direct) in &self.found {
            if *direct && !sources.iter().any(|source| &source.url == url) {
                sources.push(AskSource { title: title.clone(), url: url.clone(), cited: false });
            }
        }
        sources.truncate(ASK_MAX_SOURCES);
        sources
    }
}

/// Whether `answer` names `path` as a whole path, not the start of a
/// longer one (`/acme/web/pull/7` is not cited by `/acme/web/pull/70`).
fn contains_path(answer: &str, path: &str) -> bool {
    answer.match_indices(path).any(|(at, _)| {
        let next = answer[at + path.len()..].chars().next();
        !next.is_some_and(|c| c.is_ascii_alphanumeric() || c == '/' || c == '-' || c == '_')
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn listing() -> Value {
        json!({ "tools": [
            {
                "name": "pull_request",
                "description": "Pull requests",
                "inputSchema": { "type": "object", "properties": { "action": { "type": "string", "enum": ["list", "get", "changes"] } }, "required": ["action"] },
                "annotations": { "readOnlyHint": true },
            },
            {
                "name": "search",
                "description": "Find things",
                "inputSchema": { "type": "object", "properties": { "action": { "type": "string", "enum": ["code", "ticket"], "default": "code" } } },
                "annotations": { "readOnlyHint": true },
            },
            {
                "name": "issue",
                "description": "Issues",
                "inputSchema": { "type": "object", "properties": { "action": { "type": "string", "enum": ["list", "create"] } } },
                "annotations": { "readOnlyHint": false },
            },
        ] })
    }

    #[test]
    fn the_servers_tools_are_read_as_they_are_listed() {
        let tools = listed(&listing());
        assert_eq!(tools.len(), 3);
        assert_eq!(tools[0].spec.name, "pull_request");
        assert_eq!(tools[0].spec.input_schema["required"], json!(["action"]));
        assert_eq!(tools[0].actions, vec!["list", "get", "changes"]);
        assert_eq!(tools[1].default_action.as_deref(), Some("code"));
        assert!(!tools[2].read_only);
        assert!(listed(&json!({})).is_empty());
    }

    #[test]
    fn ask_runs_reads_and_refuses_everything_else() {
        let toolbox = Toolbox::new(listed(&listing()), native());
        // A tool that is not read-only is not offered at all.
        let names: Vec<&str> = toolbox.specs().iter().map(|spec| spec.name.as_str()).collect();
        assert_eq!(names, vec!["pull_request", "search", PROPOSE_SESSION]);
        assert_eq!(toolbox.decide("pull_request", &json!({ "action": "get", "repo": "a/b", "number": 1 })), Decision::Run);
        assert_eq!(toolbox.decide("search", &json!({ "query": "x" })), Decision::Run, "the default action");
        // An action the server did not list for this credential.
        let Decision::Refuse(why) = toolbox.decide("pull_request", &json!({ "action": "merge" })) else { panic!() };
        assert!(why.contains("changes nothing itself"), "{why}");
        assert!(matches!(toolbox.decide("pull_request", &json!({})), Decision::Refuse(_)));
        assert!(matches!(toolbox.decide("issue", &json!({ "action": "create" })), Decision::Refuse(_)));
        assert!(matches!(toolbox.decide("nope", &json!({})), Decision::Refuse(_)));
    }

    #[test]
    fn a_dispatch_waits_for_the_persons_yes() {
        let start = Native {
            spec: ToolSpec { name: "start_session".into(), description: "Start a session".into(), input_schema: json!({ "type": "object" }) },
            kind: Kind::Dispatch,
        };
        let toolbox = Toolbox::new(Vec::new(), vec![start]);
        assert!(toolbox.is_native("start_session"));
        assert_eq!(toolbox.decide("start_session", &json!({ "repo": "a/b", "number": 3 })), Decision::Confirm);
    }

    #[test]
    fn a_proposed_session_is_a_card_the_person_starts() {
        let toolbox = Toolbox::new(Vec::new(), native());
        assert!(toolbox.is_native(PROPOSE_SESSION));
        let on_issue = json!({ "repo": "acme/web", "issue": 12, "mode": "implement", "title": "ignored", "instruction": " use the new name " });
        assert_eq!(toolbox.decide(PROPOSE_SESSION, &on_issue), Decision::Confirm);
        let AskEvent::Proposal { id, repo, issue, title, body, mode, instruction } = proposal("proposal_0_0", &on_issue).unwrap() else {
            panic!()
        };
        assert_eq!((id.as_str(), repo.as_str(), issue, mode.as_str()), ("proposal_0_0", "acme/web", Some(12), "implement"));
        assert_eq!((title, body, instruction.as_deref()), (None, None, Some("use the new name")));
        let new_issue = json!({ "repo": "acme/web", "title": "Add a collaborators route", "body": "List them.", "mode": "plan" });
        let AskEvent::Proposal { issue, title, .. } = proposal("p", &new_issue).unwrap() else { panic!() };
        assert_eq!((issue, title.as_deref()), (None, Some("Add a collaborators route")));
        assert!(proposal("p", &json!({ "repo": "acme/web", "mode": "plan" })).is_err(), "no issue and no title");
        assert!(proposal("p", &json!({ "repo": "acme", "issue": 1, "mode": "plan" })).is_err(), "not owner/name");
        assert!(proposal("p", &json!({ "repo": "acme/web", "issue": 1, "mode": "ship" })).is_err(), "no such mode");
        assert_eq!(label(PROPOSE_SESSION, &on_issue), "Proposed a session on issue #12 in acme/web");
    }

    #[test]
    fn steps_say_what_they_do_in_a_line() {
        assert_eq!(label("pull_request", &json!({ "action": "list", "repo": "acme/web" })), "Listed pull requests in acme/web");
        assert_eq!(label("pull_request", &json!({ "action": "get", "repo": "acme/web", "number": 7 })), "Read pull request #7 in acme/web");
        assert_eq!(
            label("pull_request", &json!({ "action": "changes", "repo": "acme/web", "number": 7 })),
            "Read changes of pull request #7 in acme/web"
        );
        assert_eq!(label("workflow", &json!({ "action": "list_runs", "repo": "acme/web" })), "Listed runs in acme/web");
        assert_eq!(label("workflow", &json!({ "action": "job_logs", "repo": "acme/web" })), "Read job logs in acme/web");
        assert_eq!(
            label("workspace", &json!({ "action": "activity", "workspace": "acme", "since": "2026-10-12T00:00:00Z" })),
            "Read activity in acme since 2026-10-12"
        );
        assert_eq!(label("search", &json!({ "query": "login bug" })), "Searched g1t for \u{201c}login bug\u{201d}");
        assert_eq!(label("repository", &json!({ "action": "list" })), "Listed repositories");
    }

    #[test]
    fn steps_link_to_the_page_they_read() {
        let site = "https://g1t.sh/";
        assert_eq!(link(site, "pull_request", &json!({ "repo": "acme/web", "number": 7 })).unwrap(), "https://g1t.sh/acme/web/pull/7");
        assert_eq!(link(site, "issue", &json!({ "action": "list", "repo": "acme/web" })).unwrap(), "https://g1t.sh/acme/web/issues");
        assert_eq!(link(site, "workflow", &json!({ "action": "get_run", "repo": "acme/web", "run_id": "run_1" })).unwrap(), "https://g1t.sh/acme/web/actions/runs/run_1");
        assert_eq!(link(site, "workspace", &json!({ "action": "activity", "workspace": "acme" })).unwrap(), "https://g1t.sh/acme");
        assert_eq!(link(site, "search", &json!({ "query": "x" })), None);
    }

    #[test]
    fn steps_say_what_they_found() {
        assert_eq!(summary("[1,2,3]", false), "3 results");
        assert_eq!(summary("{\"events\":[{}],\"summary\":{}}", false), "1 result");
        assert_eq!(summary("{\"title\":\"Fix login\",\"number\":7}", false), "Fix login");
        assert_eq!(summary("Not allowed: needs pull_requests:write\nmore", true), "Not allowed: needs pull_requests:write");
        assert_eq!(summary("plain", false), "Done");
    }

    #[test]
    fn big_results_are_trimmed_not_dropped() {
        let small = json!({ "title": "x", "avatar_url": "https://a", "url_template": "https://x/{?q}" }).to_string();
        assert_eq!(trim_result(&small, 1_000, Keep::Start), "{\"title\":\"x\"}");
        // A long list keeps its first items, whole, and says how many more.
        let items: Vec<Value> = (0..400).map(|n| json!({ "number": n, "title": format!("Pull request {n}"), "body": "b".repeat(3_000) })).collect();
        let big = json!({ "items": items }).to_string();
        let kept = trim_result(&big, 16_000, Keep::Start);
        assert!(kept.chars().count() <= 16_000, "{}", kept.len());
        let read: Value = serde_json::from_str(&kept).expect("still JSON");
        let list = read["items"].as_array().unwrap();
        assert_eq!(list[0]["number"], 0);
        assert!(list.last().unwrap().as_str().unwrap().contains("more not shown"));
        assert!(list[0]["body"].as_str().unwrap().contains("more characters"));
        // Text that is not JSON is cut with a note.
        let log = "line\n".repeat(10_000);
        let kept = trim_result(&log, 1_000, Keep::Start);
        assert!(kept.chars().count() <= 1_000);
        assert!(kept.contains("[Cut:"));
    }

    #[test]
    fn a_logs_end_is_kept_where_a_failure_says_why() {
        assert_eq!(Keep::of("workflow", &json!({ "action": "job_logs" })), Keep::End);
        assert_eq!(Keep::of("workflow", &json!({ "action": "list_runs" })), Keep::Start);
        assert_eq!(Keep::of("pull_request", &json!({ "action": "list" })), Keep::Start);
        let mut chunks: Vec<Value> = (0..2_000).map(|seq| json!({ "seq": seq, "step": 3, "text": format!("building part {seq}\n") })).collect();
        chunks.push(json!({ "seq": 2_000, "step": 4, "text": "##[error]No space left on device\n" }));
        let log = json!({ "chunks": chunks, "done": true }).to_string();
        let kept = trim_result(&log, 4_000, Keep::End);
        assert!(kept.chars().count() <= 4_000);
        let read: Value = serde_json::from_str(&kept).expect("still JSON");
        let kept_chunks = read["chunks"].as_array().unwrap();
        assert!(kept_chunks[0].as_str().unwrap().contains("more not shown"));
        assert!(kept_chunks.last().unwrap()["text"].as_str().unwrap().contains("No space left on device"));
        // Plain text keeps its end too.
        let text = format!("{}error: disk full", "noise\n".repeat(1_000));
        let kept = trim_result(&text, 500, Keep::End);
        assert!(kept.ends_with("error: disk full"));
        assert!(kept.starts_with("[Cut: the first"));
    }

    #[test]
    fn sources_are_the_pages_the_answer_cites_then_those_it_read() {
        let site = "https://g1t.sh";
        let mut sources = Sources::default();
        let activity = json!({ "events": [
            { "kind": "pull_merged", "repo": "acme/web", "number": 7, "title": "Fix login", "url": "https://g1t.sh/acme/web/pull/7" },
            { "kind": "release_published", "repo": "acme/api", "tag": "v1.2.0", "title": "Faster", "url": "https://g1t.sh/acme/api/releases/tag/v1.2.0" },
            { "kind": "pull_merged", "repo": "acme/web", "number": 70, "title": "Other", "url": "https://g1t.sh/acme/web/pull/70" },
        ] });
        sources.read(site, "workspace", &json!({ "action": "activity", "workspace": "acme" }), &activity.to_string(), None);
        let list = json!([{ "number": 9, "title": "Docs", "merged_at": null }]);
        sources.read(site, "pull_request", &json!({ "action": "list", "repo": "acme/docs" }), &list.to_string(), None);
        sources.read(
            site,
            "issue",
            &json!({ "action": "get", "repo": "acme/web", "number": 3 }),
            "{\"issue\":{\"title\":\"Login fails\"}}",
            Some(("https://g1t.sh/acme/web/issues/3", "Read issue #3 in acme/web")),
        );
        let answer = "Shipped: [Fix login](https://g1t.sh/acme/web/pull/7) and acme/docs [#9](/acme/docs/pull/9).";
        let found = sources.finish(site, answer);
        assert_eq!(
            found,
            vec![
                AskSource { title: "#7 Fix login".into(), url: "https://g1t.sh/acme/web/pull/7".into(), cited: true },
                AskSource { title: "#9 Docs".into(), url: "https://g1t.sh/acme/docs/pull/9".into(), cited: true },
                AskSource { title: "Read issue #3 in acme/web".into(), url: "https://g1t.sh/acme/web/issues/3".into(), cited: false },
            ]
        );
    }
}
