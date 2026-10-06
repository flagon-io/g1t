//! Guardrails inside the sandbox: the command rules the agent's harness
//! enforces, its cost and time caps, and trusting the certificate the
//! sandbox's HTTPS is re-signed with when its network is restricted.
//!
//! The runner service passes the run's guardrails as `GUARDRAILS`. Before
//! Claude Code starts, `install` writes them where the harness reads them:
//!
//! - Claude Code's managed settings (`/etc/claude-code/managed-settings.json`,
//!   root-owned, which no other settings file can override) get a
//!   `PreToolUse` hook that runs this program in `MODE=guard` before every
//!   tool call, and `permissions.deny` rules as a second layer.
//! - With the `sudo` rule on, the sandbox then gives up root, so the agent
//!   cannot change either. Where that cannot be done (no sudo), the same
//!   settings are passed with `--settings` instead.
//!
//! The hook (`hook_main`) decides with `decide`: a refused call is not
//! made, Claude Code tells the agent why, and the refusal is appended to
//! `DENIED_LOG`, which the harness reads and reports as a step of the run.
//!
//! Matching shell commands against rules is a guard against an agent's
//! mistakes, not a sandbox: a command can always be written in a way no
//! rule foresees. The network list, the credentials a sandbox holds, and
//! branch protection on g1t's side are the hard boundaries.

use std::collections::BTreeMap;
use std::fmt;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};

use serde::Deserialize;
use serde_json::{Value, json};

/// Where the guardrails are kept for the hook: root-owned where it can be.
const POLICY_FILES: [&str; 2] = ["/etc/g1t/guard.json", "/work/.g1t/guard.json"];
const MANAGED_SETTINGS: &str = "/etc/claude-code/managed-settings.json";
/// Settings passed with `--settings` when the managed file cannot be written.
pub const FALLBACK_SETTINGS: &str = "/work/.g1t/settings.json";
/// Refusals, one per line, for the harness to report.
pub const DENIED_LOG: &str = "/work/.g1t/denied.log";
/// The certificate the sandbox's HTTPS is re-signed with, when it is guarded.
const EGRESS_CA: &str = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const HOOK_COMMAND: &str = "MODE=guard /usr/local/bin/g1t-runner";

/// The run's guardrails, as the runner service passes them.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Policy {
    pub rules: BTreeMap<String, bool>,
    pub deny: Vec<String>,
    pub budget_usd: Option<f64>,
    /// This run's time cap, in minutes.
    pub minutes: Option<u32>,
    pub restrict_network: bool,
    /// The branch everything lands on, when the runner knows it.
    pub default_branch: Option<String>,
}

impl Policy {
    pub fn from_env() -> Option<Policy> {
        serde_json::from_str(&std::env::var("GUARDRAILS").ok()?).ok()
    }

    fn on(&self, rule: &str) -> bool {
        self.rules.get(rule).copied().unwrap_or(false)
    }
}

/// Why g1t stopped a run by itself: it reached a cap.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Halted {
    Budget,
    Time,
}

impl Halted {
    pub fn reason(self) -> &'static str {
        match self {
            Halted::Budget => "budget",
            Halted::Time => "time",
        }
    }
}

impl fmt::Display for Halted {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Halted::Budget => write!(f, "the run reached its cost cap"),
            Halted::Time => write!(f, "the run reached its time cap"),
        }
    }
}

impl std::error::Error for Halted {}

/// Whether a run failed because it reached a cap, rather than failing.
pub fn is_halt(error: &anyhow::Error) -> bool {
    error.downcast_ref::<Halted>().is_some()
}

/// Runs a command as root without asking. False where that is not allowed.
fn sudo(args: &[&str], input: Option<&str>) -> bool {
    let child = Command::new("sudo")
        .arg("-n")
        .args(args)
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = child else {
        return false;
    };
    if let (Some(input), Some(mut stdin)) = (input, child.stdin.take()) {
        let _ = stdin.write_all(input.as_bytes());
    }
    child.wait().is_ok_and(|status| status.success())
}

/// Writes `contents` to a root-owned file that others can read.
fn write_as_root(path: &str, contents: &str) -> bool {
    let dir = Path::new(path).parent().and_then(Path::to_str).unwrap_or("/");
    sudo(&["mkdir", "-p", dir], None)
        && sudo(&["tee", path], Some(contents))
        && sudo(&["chmod", "0644", path], None)
}

/// Trusts the certificate a guarded sandbox's HTTPS is re-signed with, so
/// that git, package managers and this program can reach allowed hosts.
/// Does nothing in a sandbox whose network is open. Called first thing,
/// before any request is made.
pub fn trust_egress_ca() {
    const TRUSTED: &str = "/usr/local/share/ca-certificates/cloudflare-containers-ca.crt";
    // Once per sandbox: the hooks run this program after every tool call.
    if !Path::new(EGRESS_CA).exists() || Path::new(TRUSTED).exists() {
        return;
    }
    let trusted = sudo(&["cp", EGRESS_CA, TRUSTED], None) && sudo(&["update-ca-certificates"], None);
    if !trusted {
        eprintln!("g1t-runner: could not trust the sandbox's egress certificate; HTTPS will fail");
    }
}

/// The permission rules that back up each built-in rule. The hook is what
/// enforces them; these are a second layer the harness applies itself.
fn rule_patterns(rule: &str) -> &'static [&'static str] {
    match rule {
        "force_push" => &[
            "Bash(git push --force:*)",
            "Bash(git push -f:*)",
            "Bash(git push --force-with-lease:*)",
            "Bash(git push --mirror:*)",
        ],
        "rewrite_default_branch" => &[
            "Bash(git filter-branch:*)",
            "Bash(git filter-repo:*)",
            "Bash(git replace:*)",
        ],
        "outside_workspace" => &[
            "Read(//proc/**)",
            "Read(//etc/claude-code/**)",
            "Read(//etc/g1t/**)",
            "Read(//work/.g1t/**)",
            "Read(//work/g1t-mcp.json)",
            "Read(//work/g1t-steer.json)",
            "Read(~/.claude/**)",
        ],
        "print_env" => &["Bash(env)", "Bash(printenv:*)", "Bash(export -p)"],
        "sudo" => &["Bash(sudo:*)", "Bash(su:*)", "Bash(doas:*)"],
        _ => &[],
    }
}

/// Claude Code's settings for a guarded run: the hook before every tool
/// call, the permission rules, and nothing sent anywhere but the model.
pub fn harness_settings(policy: &Policy) -> Value {
    let mut deny: Vec<String> = Vec::new();
    for (rule, on) in &policy.rules {
        if *on {
            deny.extend(rule_patterns(rule).iter().map(|pattern| (*pattern).to_owned()));
        }
    }
    for pattern in &policy.deny {
        if !deny.contains(pattern) {
            deny.push(pattern.clone());
        }
    }
    let mut settings = json!({
        "permissions": { "deny": deny },
        "hooks": {
            "PreToolUse": [{
                "matcher": "*",
                "hooks": [{ "type": "command", "command": HOOK_COMMAND, "timeout": 10 }],
            }],
        },
    });
    if policy.restrict_network {
        // Only the model and the allowed hosts are reachable: the harness
        // is told not to try anything else.
        settings["skipWebFetchPreflight"] = json!(true);
        settings["env"] = json!({
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "DISABLE_TELEMETRY": "1",
            "DISABLE_ERROR_REPORTING": "1",
            "DISABLE_AUTOUPDATER": "1",
        });
    }
    settings
}

/// What `install` managed to do.
#[derive(Debug, Default)]
pub struct Installed {
    /// Settings to pass with `--settings`, when they could not be managed.
    pub settings_file: Option<String>,
    /// Whether the sandbox gave up root.
    pub dropped_root: bool,
}

/// Puts the guardrails where the harness and the hook read them, then, if
/// the `sudo` rule is on, gives up root for the rest of the sandbox.
pub fn install(policy: &Policy, raw: &str) -> Installed {
    let _ = std::fs::create_dir_all("/work/.g1t");
    let _ = std::fs::write(DENIED_LOG, "");
    let settings = harness_settings(policy).to_string();
    let managed = write_as_root(POLICY_FILES[0], raw) && write_as_root(MANAGED_SETTINGS, &settings);
    let mut installed = Installed::default();
    if !managed {
        let _ = std::fs::write(POLICY_FILES[1], raw);
        if std::fs::write(FALLBACK_SETTINGS, &settings).is_ok() {
            installed.settings_file = Some(FALLBACK_SETTINGS.to_owned());
        }
    }
    if policy.on("sudo") && managed {
        installed.dropped_root = sudo(&["rm", "-f", "/etc/sudoers.d/node"], None);
    }
    installed
}

/// A remote as `namespace/name`, lower case, whatever host or suffix it has.
fn repo_of(remote: &str) -> String {
    let path = remote.split("://").nth(1).map_or(remote, |rest| rest.split_once('/').map_or("", |(_, path)| path));
    path.trim_end_matches('/').trim_end_matches(".git").to_lowercase()
}

/// Whether the checkout the agent works in is the repository's own: a
/// branch of the repository itself (the default branch, or one pushed to
/// it), never a fork. A fork's files are anyone's, so the harness must not
/// load their CLAUDE.md, settings, hooks, MCP servers or commands. Same
/// rule as the instructions the runner service reads (repo-instructions.ts).
/// Unsure is untrusted.
pub fn checkout_trusted(remote: Option<&str>, upstream: Option<&str>, repo: Option<&str>) -> bool {
    let Some(remote) = remote.map(repo_of).filter(|remote| !remote.is_empty()) else {
        return false;
    };
    let own = upstream
        .map(repo_of)
        .or_else(|| repo.map(|repo| repo.trim_matches('/').to_lowercase()))
        .filter(|own| !own.is_empty());
    own.is_some_and(|own| own == remote)
}

/// The same, from the sandbox's environment.
pub fn checkout_trusted_from_env() -> bool {
    let var = |name: &str| std::env::var(name).ok();
    checkout_trusted(
        var("GIT_REMOTE").as_deref(),
        var("UPSTREAM_REMOTE").as_deref(),
        var("G1T_REPO").as_deref(),
    )
}

/// Flags that keep Claude Code from loading anything from an untrusted
/// checkout: its `.claude/settings.json` and `settings.local.json` (with
/// their hooks and permissions), its `.mcp.json`, and its commands and
/// skills. Managed settings (the guard hook), `--settings` and
/// `--mcp-config` still apply. CLAUDE.md is turned off by
/// `UNTRUSTED_ENV`.
pub const UNTRUSTED_FLAGS: [&str; 4] = ["--setting-sources", "user", "--strict-mcp-config", "--disable-slash-commands"];
/// Turns off every CLAUDE.md, the checkout's included.
pub const UNTRUSTED_ENV: (&str, &str) = ("CLAUDE_CODE_DISABLE_CLAUDE_MDS", "1");

/// Refusals the hook has written since the last call, as run steps.
#[derive(Default)]
pub struct Denials {
    seen: usize,
}

impl Denials {
    pub fn take(&mut self) -> Vec<String> {
        let Ok(text) = std::fs::read_to_string(DENIED_LOG) else {
            return Vec::new();
        };
        let lines: Vec<String> = text.lines().map(str::to_owned).collect();
        let new = lines.iter().skip(self.seen).cloned().collect();
        self.seen = lines.len();
        new
    }
}

/// `MODE=guard`: Claude Code's `PreToolUse` hook. Reads the call on stdin;
/// exits 2 with the reason on stderr to refuse it, which Claude Code shows
/// the agent, and 0 to let it through.
pub fn hook_main() -> i32 {
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    let Ok(call) = serde_json::from_str::<Value>(&input) else {
        return 0;
    };
    let Some(policy) = POLICY_FILES
        .iter()
        .find_map(|path| std::fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str::<Policy>(&raw).ok())
    else {
        return 0;
    };
    let tool = call["tool_name"].as_str().unwrap_or_default();
    let home = std::env::var("HOME").unwrap_or_else(|_| "/home/node".to_owned());
    let place = Place {
        workdir: call["cwd"].as_str().unwrap_or(crate::WORKDIR).to_owned(),
        home,
        default_branch: policy
            .default_branch
            .clone()
            .or_else(origin_default_branch)
            .unwrap_or_else(|| "main".to_owned()),
    };
    let Some(reason) = decide(&policy, tool, &call["tool_input"], &place) else {
        return 0;
    };
    let what = crate::progress::describe_tool(tool, &call["tool_input"]);
    if let Ok(mut log) = std::fs::OpenOptions::new().create(true).append(true).open(DENIED_LOG) {
        let _ = writeln!(log, "{}", crate::progress::one_line(&format!("Denied: {what} ({reason})")));
    }
    eprintln!(
        "Blocked by g1t guardrails: {reason}. This project does not allow it. Do not try to get around it; if the task cannot be done without it, stop and say so in your summary."
    );
    2
}

/// The default branch of the clone's origin, if git knows it.
fn origin_default_branch() -> Option<String> {
    let output = Command::new("git")
        .current_dir(crate::WORKDIR)
        .args(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
        .output()
        .ok()?;
    let name = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    name.strip_prefix("origin/").map(str::to_owned)
}

/// Where a call is made from.
pub struct Place {
    pub workdir: String,
    pub home: String,
    pub default_branch: String,
}

/// Why a tool call is refused, or None to let it through.
pub fn decide(policy: &Policy, tool: &str, input: &Value, place: &Place) -> Option<String> {
    let field = |name: &str| input.get(name).and_then(Value::as_str).unwrap_or_default();
    if tool == "Bash" {
        let command = field("command");
        // Always on, whatever the project's rules: no sandbox mines.
        if let Some(miner) = crate::abuse::miner_in(command) {
            return Some(format!("no cryptocurrency mining ({miner})"));
        }
        for segment in segments(command) {
            let words = words(&segment);
            if let Some(reason) = builtin_shell(policy, &words, &segment, place) {
                return Some(reason);
            }
        }
    }
    if let Some(path) = file_path(tool, input) {
        let resolved = resolve(&path, place);
        if policy.on("outside_workspace") && !inside_allowed(&resolved, place) {
            return Some(format!("{resolved} is outside the project"));
        }
    }
    custom(policy, tool, input, place)
}

/// The path a file tool works on.
fn file_path(tool: &str, input: &Value) -> Option<String> {
    let field = |name: &str| input.get(name).and_then(Value::as_str).map(str::to_owned);
    match tool {
        "Read" | "Write" | "Edit" | "MultiEdit" => field("file_path"),
        "NotebookEdit" | "NotebookRead" => field("notebook_path"),
        "Glob" | "Grep" | "LS" => field("path"),
        _ => None,
    }
}

/// `path` made absolute against the working directory, without `.` or
/// `..`. Always with `/`, as in the sandbox.
fn resolve(path: &str, place: &Place) -> String {
    let expanded = match path.strip_prefix("~/") {
        Some(rest) => format!("{}/{rest}", place.home),
        None if path == "~" => place.home.clone(),
        None => path.to_owned(),
    };
    let joined = if expanded.starts_with('/') {
        expanded
    } else {
        format!("{}/{expanded}", place.workdir)
    };
    let mut parts: Vec<&str> = Vec::new();
    for part in joined.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            name => parts.push(name),
        }
    }
    format!("/{}", parts.join("/"))
}

/// Where file tools may go: the project, scratch space, and the caches
/// where dependencies' sources are.
fn inside_allowed(path: &str, place: &Place) -> bool {
    let roots = [
        crate::WORKDIR.to_owned(),
        "/tmp".to_owned(),
        format!("{}/.cargo/registry", place.home),
        format!("{}/.cargo/git", place.home),
        format!("{}/go/pkg/mod", place.home),
        format!("{}/.rustup/toolchains", place.home),
    ];
    roots
        .iter()
        .any(|root| path == root || path.strip_prefix(root.as_str()).is_some_and(|rest| rest.starts_with('/')))
}

/// Paths of g1t's own a shell command may not touch.
fn protected_paths(place: &Place) -> Vec<String> {
    vec![
        "/etc/claude-code".to_owned(),
        "/etc/g1t".to_owned(),
        "/etc/cloudflare".to_owned(),
        "/work/.g1t".to_owned(),
        "/work/g1t-mcp.json".to_owned(),
        crate::steer::CONFIG.to_owned(),
        format!("{}/.claude", place.home),
        "~/.claude".to_owned(),
        "$HOME/.claude".to_owned(),
    ]
}

/// A shell command split into the commands it runs.
pub fn segments(command: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let chars: Vec<char> = command.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match quote {
            Some(q) => {
                if c == q {
                    quote = None;
                }
                current.push(c);
            }
            None if c == '\'' || c == '"' => {
                quote = Some(c);
                current.push(c);
            }
            None if c == ';' || c == '\n' || c == '|' || c == '&' => {
                out.push(std::mem::take(&mut current));
                // `&&` and `||` are one separator.
                if (c == '|' || c == '&') && chars.get(i + 1) == Some(&c) {
                    i += 1;
                }
            }
            None if c == '(' || c == ')' || c == '`' || (c == '$' && chars.get(i + 1) == Some(&'(')) => {
                // A subshell or a command substitution runs a command of
                // its own.
                out.push(std::mem::take(&mut current));
            }
            None => current.push(c),
        }
        i += 1;
    }
    out.push(current);
    out.into_iter()
        .map(|segment| segment.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|segment| !segment.is_empty())
        .collect()
}

/// A command's words, with quotes removed, leading `VAR=value`
/// assignments and wrappers such as `nohup` skipped.
pub fn words(segment: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;
    for c in segment.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => current.push(c),
            None if c == '\'' || c == '"' => {
                quote = Some(c);
                started = true;
            }
            None if c.is_whitespace() => {
                if started || !current.is_empty() {
                    out.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            None if c == '{' || c == '}' => {}
            None => current.push(c),
        }
    }
    if started || !current.is_empty() {
        out.push(current);
    }
    let skip = out
        .iter()
        .take_while(|word| {
            is_assignment(word)
                || matches!(word.as_str(), "nohup" | "time" | "exec" | "command" | "builtin" | "then" | "do" | "else" | "!")
        })
        .count();
    out.split_off(skip)
}

fn is_assignment(word: &str) -> bool {
    word.split_once('=').is_some_and(|(name, _)| {
        !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    })
}

/// The name of a program, without its directory.
fn program(word: &str) -> &str {
    word.rsplit('/').next().unwrap_or(word)
}

/// git's subcommand and its arguments, past options such as `-C dir`.
fn git_command(words: &[String]) -> Option<(&str, &[String])> {
    if words.first().map(|word| program(word)) != Some("git") {
        return None;
    }
    let mut i = 1;
    while i < words.len() {
        let word = words[i].as_str();
        if word == "-C" || word == "-c" || word == "--git-dir" || word == "--work-tree" {
            i += 2;
        } else if word.starts_with('-') {
            i += 1;
        } else {
            return Some((word, &words[i + 1..]));
        }
    }
    None
}

/// Whether a variable's name looks like it holds a secret.
fn secret_name(name: &str) -> bool {
    let upper = name.to_uppercase();
    ["TOKEN", "KEY", "SECRET", "PASSWORD", "PASSWD", "CREDENTIAL", "AUTH"]
        .iter()
        .any(|part| upper.contains(part))
}

/// Variables a command reads, by name: `$NAME` and `${NAME}`.
fn variables(segment: &str) -> Vec<String> {
    let mut out = Vec::new();
    let chars: Vec<char> = segment.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '$' {
            let mut j = i + 1;
            if chars.get(j) == Some(&'{') {
                j += 1;
            }
            let start = j;
            while j < chars.len() && (chars[j].is_ascii_alphanumeric() || chars[j] == '_') {
                j += 1;
            }
            if j > start {
                out.push(chars[start..j].iter().collect());
            }
            i = j;
        } else {
            i += 1;
        }
    }
    out
}

/// The built-in rules, for one command of a shell line.
fn builtin_shell(policy: &Policy, words: &[String], segment: &str, place: &Place) -> Option<String> {
    let first = words.first().map(|word| program(word)).unwrap_or_default();
    let args = words.get(1..).unwrap_or_default();

    if policy.on("sudo") && matches!(first, "sudo" | "su" | "doas" | "pkexec") {
        return Some("no sudo".to_owned());
    }

    if let Some((sub, rest)) = git_command(words) {
        if sub == "push" {
            let options: Vec<&str> = rest.iter().map(String::as_str).filter(|a| a.starts_with('-')).collect();
            let positional: Vec<&str> = rest.iter().map(String::as_str).filter(|a| !a.starts_with('-')).collect();
            let refspecs = positional.get(1..).unwrap_or_default();
            if policy.on("force_push") {
                let forced = options.iter().any(|option| {
                    matches!(*option, "--force" | "--mirror" | "--delete" | "--prune" | "--force-if-includes")
                        || option.starts_with("--force-with-lease")
                        || (!option.starts_with("--") && (option.contains('f') || option.contains('d')))
                });
                if forced || refspecs.iter().any(|spec| spec.starts_with('+') || spec.starts_with(':')) {
                    return Some("no force-pushing".to_owned());
                }
            }
            if policy.on("rewrite_default_branch") {
                let branch = place.default_branch.as_str();
                let targets_default = refspecs.iter().any(|spec| {
                    let target = spec.rsplit(':').next().unwrap_or(spec).trim_start_matches('+');
                    target == branch || target == format!("refs/heads/{branch}")
                });
                if targets_default || options.contains(&"--all") {
                    return Some(format!("no pushing to {branch}, the default branch"));
                }
            }
        }
        if policy.on("rewrite_default_branch") {
            let branch = place.default_branch.as_str();
            let names_default = rest
                .iter()
                .any(|arg| arg == branch || *arg == format!("refs/heads/{branch}"));
            let moves = rest
                .iter()
                .any(|arg| matches!(arg.as_str(), "-f" | "--force" | "-D" | "-d" | "--delete" | "-m" | "-M" | "--move"));
            match sub {
                "filter-branch" | "filter-repo" | "replace" => {
                    return Some("no rewriting history".to_owned());
                }
                "branch" if names_default && moves => {
                    return Some(format!("no moving or deleting {branch}, the default branch"));
                }
                "update-ref" if names_default => {
                    return Some(format!("no moving {branch}, the default branch"));
                }
                _ => {}
            }
        }
    }

    if policy.on("print_env") {
        let prints = match first {
            "printenv" => true,
            // `env` alone, or with only options and assignments: no command.
            "env" => args.iter().all(|arg| arg.starts_with('-') || is_assignment(arg)),
            "export" | "declare" | "typeset" => args.is_empty() || args.iter().any(|arg| arg == "-p" || arg == "-x"),
            "set" => args.is_empty(),
            "compgen" => args.iter().any(|arg| arg == "-e" || arg == "-v"),
            _ => false,
        };
        let environ = segment.contains("/proc/") && segment.contains("environ");
        let secret = variables(segment).iter().any(|name| secret_name(name));
        if prints || environ || secret {
            return Some("no printing the environment".to_owned());
        }
    }

    if policy.on("outside_workspace") {
        let touched = protected_paths(place)
            .into_iter()
            .find(|path| segment.contains(path.as_str()));
        if let Some(path) = touched {
            return Some(format!("{path} is g1t's, not the project's"));
        }
        if segment.contains("/proc/") && segment.contains("environ") {
            return Some("no reading other processes' environments".to_owned());
        }
    }
    None
}

/// The tools a permission rule's tool name covers, as Claude Code reads
/// them: an `Edit` rule covers every tool that writes a file.
fn rule_covers(rule_tool: &str, tool: &str) -> bool {
    match rule_tool {
        "Edit" | "Write" => matches!(tool, "Edit" | "Write" | "MultiEdit" | "NotebookEdit"),
        "Read" => matches!(tool, "Read" | "Glob" | "Grep" | "NotebookRead" | "LS"),
        other => other == tool,
    }
}

/// The workspace's own deny patterns.
fn custom(policy: &Policy, tool: &str, input: &Value, place: &Place) -> Option<String> {
    for pattern in &policy.deny {
        let (rule_tool, spec) = match pattern.split_once('(') {
            Some((name, rest)) => (name, rest.strip_suffix(')')),
            None => (pattern.as_str(), None),
        };
        if !rule_covers(rule_tool, tool) {
            continue;
        }
        let matched = match spec {
            None => true,
            Some(spec) if tool == "Bash" => {
                let command = input.get("command").and_then(Value::as_str).unwrap_or_default();
                segments(command).iter().any(|segment| shell_matches(spec, segment))
            }
            Some(spec) if rule_tool == "WebFetch" => {
                let url = input.get("url").and_then(Value::as_str).unwrap_or_default();
                let host = url.split("://").nth(1).unwrap_or(url).split(['/', ':']).next().unwrap_or_default();
                let domain = spec.strip_prefix("domain:").unwrap_or(spec);
                host == domain || host.ends_with(&format!(".{domain}"))
            }
            Some(spec) => match file_path(tool, input) {
                Some(path) => {
                    let path = resolve(&path, place);
                    glob(&expand_rule_path(spec, place), &path)
                }
                None => false,
            },
        };
        if matched {
            return Some(format!("{pattern} is on this workspace's deny list"));
        }
    }
    None
}

/// A rule's path made absolute, as Claude Code reads it: `//` is the root
/// and `~/` the home directory; anything else is the project's.
fn expand_rule_path(spec: &str, place: &Place) -> String {
    if let Some(rest) = spec.strip_prefix("//") {
        format!("/{rest}")
    } else if let Some(rest) = spec.strip_prefix("~/") {
        format!("{}/{rest}", place.home)
    } else if let Some(rest) = spec.strip_prefix('/') {
        format!("{}/{rest}", crate::WORKDIR)
    } else {
        format!("{}/{spec}", crate::WORKDIR)
    }
}

/// Whether one command matches a `Bash(...)` rule: `prefix:*` for a
/// command that starts with those words, `*` anywhere as a wildcard, or
/// the exact command.
pub fn shell_matches(spec: &str, segment: &str) -> bool {
    let spec = spec.split_whitespace().collect::<Vec<_>>().join(" ");
    let segment = words(segment).join(" ");
    if let Some(prefix) = spec.strip_suffix(":*") {
        return segment == prefix
            || segment
                .strip_prefix(prefix)
                .is_some_and(|rest| rest.starts_with(' '));
    }
    if spec.contains('*') {
        return wildcard(&spec, &segment, false);
    }
    segment == spec
}

/// A path glob: `**` crosses directories, `*` and `?` do not.
pub fn glob(pattern: &str, path: &str) -> bool {
    wildcard(pattern, path, true)
}

fn wildcard(pattern: &str, text: &str, paths: bool) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    fn go(p: &[char], t: &[char], paths: bool) -> bool {
        match p.first() {
            None => t.is_empty(),
            Some('*') if paths && p.get(1) == Some(&'*') => {
                let rest = if p.get(2) == Some(&'/') { &p[3..] } else { &p[2..] };
                (0..=t.len()).any(|i| go(rest, &t[i..], paths))
                    || (p.get(2) == Some(&'/') && go(&p[2..], t, paths))
            }
            Some('*') => (0..=t.len())
                .take_while(|i| !paths || *i == 0 || t[i - 1] != '/')
                .any(|i| go(&p[1..], &t[i..], paths)),
            Some('?') => !t.is_empty() && (!paths || t[0] != '/') && go(&p[1..], &t[1..], paths),
            Some(c) => t.first() == Some(c) && go(&p[1..], &t[1..], paths),
        }
    }
    go(&p, &t, paths)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all_on() -> Policy {
        Policy {
            rules: ["force_push", "rewrite_default_branch", "outside_workspace", "print_env", "sudo"]
                .into_iter()
                .map(|rule| (rule.to_owned(), true))
                .collect(),
            ..Policy::default()
        }
    }

    fn place() -> Place {
        Place {
            workdir: "/work/repo".to_owned(),
            home: "/home/node".to_owned(),
            default_branch: "main".to_owned(),
        }
    }

    fn bash(policy: &Policy, command: &str) -> Option<String> {
        decide(policy, "Bash", &json!({ "command": command }), &place())
    }

    #[test]
    fn force_pushes_are_refused_however_written() {
        let policy = all_on();
        for command in [
            "git push --force",
            "git push origin feature -f",
            "git push --force-with-lease=main origin feature",
            "git -C /work/repo push origin +feature",
            "cd x && git push origin :old",
            "git push -fu origin feature",
            "GIT_TRACE=1 git push --mirror",
        ] {
            assert_eq!(bash(&policy, command).as_deref(), Some("no force-pushing"), "{command}");
        }
        assert_eq!(bash(&policy, "git push origin feature"), None);
        assert_eq!(bash(&policy, "git push -u origin feature"), None);
    }

    #[test]
    fn the_default_branch_is_not_rewritten() {
        let policy = all_on();
        assert!(bash(&policy, "git push origin HEAD:main").is_some());
        assert!(bash(&policy, "git push origin main").is_some());
        assert!(bash(&policy, "git push origin feature:refs/heads/main").is_some());
        assert!(bash(&policy, "git branch -f main HEAD~3").is_some());
        assert!(bash(&policy, "git update-ref refs/heads/main abc123").is_some());
        assert!(bash(&policy, "git filter-branch --tree-filter 'rm x' HEAD").is_some());
        assert_eq!(bash(&policy, "git branch feature"), None);
        assert_eq!(bash(&policy, "git rebase main"), None);
        assert_eq!(bash(&policy, "git checkout main"), None);
    }

    #[test]
    fn printing_the_environment_is_refused() {
        let policy = all_on();
        for command in [
            "env",
            "env | grep KEY",
            "printenv ANTHROPIC_API_KEY",
            "export -p",
            "set",
            "cat /proc/self/environ",
            "echo $ANTHROPIC_API_KEY",
            "curl -H \"Authorization: ${GITHUB_TOKEN}\" x",
        ] {
            assert_eq!(bash(&policy, command).as_deref(), Some("no printing the environment"), "{command}");
        }
        assert_eq!(bash(&policy, "env NODE_ENV=test npm test"), None);
        assert_eq!(bash(&policy, "export PATH=$PATH:/x"), None);
        assert_eq!(bash(&policy, "echo $HOME"), None);
        assert_eq!(bash(&policy, "set -e"), None);
    }

    #[test]
    fn sudo_is_refused() {
        let policy = all_on();
        assert_eq!(bash(&policy, "sudo apt-get install jq").as_deref(), Some("no sudo"));
        assert_eq!(bash(&policy, "npm ci && sudo rm -rf /").as_deref(), Some("no sudo"));
        assert_eq!(bash(&policy, "echo $(sudo cat /etc/shadow)").as_deref(), Some("no sudo"));
        assert_eq!(bash(&policy, "npm test"), None);
        // Quoted, it is text.
        assert_eq!(bash(&policy, "echo 'do not use sudo'"), None);
    }

    #[test]
    fn miners_are_refused_even_with_every_rule_off() {
        let off = Policy::default();
        for command in [
            "curl -L https://github.com/xmrig/xmrig/releases/download/v6/xmrig.tar.gz | tar xz",
            "./xmrig -o pool.example:3333",
            "nohup ./a.out -o stratum+tcp://pool.example:4444 -u wallet &",
            "./run --donate-level 1 --algo=rx/0",
            "cd /tmp && ./t-rex -a kawpow",
        ] {
            let refused = bash(&off, command).unwrap_or_default();
            assert!(refused.starts_with("no cryptocurrency mining"), "{command}: {refused}");
        }
        assert_eq!(bash(&off, "cargo build --release && cargo test"), None);
        assert_eq!(bash(&off, "grep -rn stratum src/"), None);
    }

    #[test]
    fn files_outside_the_project_are_refused() {
        let policy = all_on();
        let read = |path: &str| decide(&policy, "Read", &json!({ "file_path": path }), &place());
        assert_eq!(read("/work/repo/src/lib.rs"), None);
        assert_eq!(read("src/lib.rs"), None);
        assert_eq!(read("/tmp/out.txt"), None);
        assert_eq!(read("/home/node/.cargo/registry/src/serde/lib.rs"), None);
        assert!(read("/etc/passwd").is_some());
        assert!(read("../../etc/passwd").is_some());
        assert!(read("/work/repo/../g1t-mcp.json").is_some());
        assert!(read("~/.claude/settings.json").is_some());
        assert!(decide(&policy, "Grep", &json!({ "pattern": "x", "path": "/etc" }), &place()).is_some());
        assert!(bash(&policy, "cat /work/g1t-mcp.json").is_some());
        assert!(bash(&policy, "cat ~/.claude/settings.json").is_some());
        assert!(bash(&policy, "rm /work/.g1t/denied.log").is_some());
    }

    #[test]
    fn rules_that_are_off_let_things_through() {
        let policy = Policy::default();
        assert_eq!(bash(&policy, "git push --force"), None);
        assert_eq!(bash(&policy, "sudo true"), None);
        assert_eq!(bash(&policy, "env"), None);
        assert_eq!(decide(&policy, "Read", &json!({ "file_path": "/etc/passwd" }), &place()), None);
    }

    #[test]
    fn custom_patterns_match_as_permission_rules_do() {
        let policy = Policy {
            deny: vec![
                "Bash(terraform apply:*)".into(),
                "Bash(rm -rf *)".into(),
                "Edit(//etc/**)".into(),
                "Read(secrets/**)".into(),
                "WebFetch(domain:example.com)".into(),
                "WebSearch".into(),
            ],
            ..Policy::default()
        };
        assert!(bash(&policy, "terraform apply -auto-approve").is_some());
        assert!(bash(&policy, "cd infra && terraform apply").is_some());
        assert_eq!(bash(&policy, "terraform applyx"), None);
        assert_eq!(bash(&policy, "terraform plan"), None);
        assert!(bash(&policy, "rm -rf build").is_some());
        let write = |path: &str| decide(&policy, "Write", &json!({ "file_path": path }), &place());
        assert!(write("/etc/hosts").is_some());
        assert_eq!(write("/work/repo/etc/hosts"), None);
        let read = |path: &str| decide(&policy, "Read", &json!({ "file_path": path }), &place());
        assert!(read("secrets/prod/key.pem").is_some());
        assert_eq!(read("src/secrets.rs"), None);
        assert!(decide(&policy, "WebFetch", &json!({ "url": "https://docs.example.com/x" }), &place()).is_some());
        assert_eq!(decide(&policy, "WebFetch", &json!({ "url": "https://example.org" }), &place()), None);
        assert!(decide(&policy, "WebSearch", &json!({ "query": "x" }), &place()).is_some());
    }

    #[test]
    fn commands_split_where_the_shell_does() {
        assert_eq!(segments("a && b || c; d | e & f"), vec!["a", "b", "c", "d", "e", "f"]);
        assert_eq!(segments("echo 'a; b' && c"), vec!["echo 'a; b'", "c"]);
        assert_eq!(segments("x $(sudo y) `z`"), vec!["x", "sudo y", "z"]);
        assert_eq!(words("FOO=1 nohup \"git\" push"), vec!["git", "push"]);
    }

    #[test]
    fn globs_respect_directories() {
        assert!(glob("/etc/**", "/etc/a/b"));
        assert!(glob("/work/repo/**/*.pem", "/work/repo/a/b/key.pem"));
        assert!(glob("/work/repo/**/*.pem", "/work/repo/key.pem"));
        assert!(!glob("/work/repo/*.pem", "/work/repo/a/key.pem"));
        assert!(glob("/work/repo/?.rs", "/work/repo/a.rs"));
    }

    #[test]
    fn harness_settings_carry_the_hook_and_the_rules() {
        let mut policy = all_on();
        policy.deny = vec!["Bash(kubectl:*)".into()];
        policy.restrict_network = true;
        let settings = harness_settings(&policy);
        let deny: Vec<&str> = settings["permissions"]["deny"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert!(deny.contains(&"Bash(git push --force:*)"));
        assert!(deny.contains(&"Bash(sudo:*)"));
        assert!(deny.contains(&"Bash(kubectl:*)"));
        assert_eq!(
            settings["hooks"]["PreToolUse"][0]["hooks"][0]["command"],
            "MODE=guard /usr/local/bin/g1t-runner"
        );
        assert_eq!(settings["env"]["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"], "1");

        let open = harness_settings(&Policy::default());
        assert_eq!(open["permissions"]["deny"].as_array().unwrap().len(), 0);
        assert!(open.get("env").is_none());
        // The hook runs whatever the rules, for the workspace's own patterns.
        assert!(open["hooks"]["PreToolUse"].is_array());
    }

    #[test]
    fn the_policy_reads_as_the_runner_sends_it() {
        let policy: Policy = serde_json::from_str(
            r#"{"rules":{"sudo":true,"print_env":false},"deny":["Bash(x:*)"],"budgetUsd":5,"minutes":90,"restrictNetwork":true,"defaultBranch":null}"#,
        )
        .unwrap();
        assert!(policy.on("sudo"));
        assert!(!policy.on("print_env"));
        assert_eq!(policy.budget_usd, Some(5.0));
        assert_eq!(policy.minutes, Some(90));
        assert!(policy.restrict_network);
    }

    #[test]
    fn only_the_repositorys_own_checkout_is_trusted() {
        let repo = Some("acme/site");
        // The default branch or a branch of the repository itself.
        assert!(checkout_trusted(Some("https://g1t.sh/acme/site.git"), None, repo));
        assert!(checkout_trusted(
            Some("https://g1t.sh/Acme/Site"),
            Some("https://g1t.sh/acme/site.git"),
            None
        ));
        // A fork's head, whoever's fork it is, g1t-agent's included.
        assert!(!checkout_trusted(Some("https://g1t.sh/g1t-agent/site-12.git"), None, repo));
        assert!(!checkout_trusted(
            Some("https://g1t.sh/someone/site.git"),
            Some("https://g1t.sh/acme/site.git"),
            repo
        ));
        // Not knowing is not trusting.
        assert!(!checkout_trusted(Some("https://g1t.sh/acme/site.git"), None, None));
        assert!(!checkout_trusted(None, None, repo));
        // A look-alike name is another repository.
        assert!(!checkout_trusted(Some("https://g1t.sh/acme/site-evil.git"), None, repo));
    }

    #[test]
    fn untrusted_checkouts_load_nothing_of_their_own() {
        let flags = UNTRUSTED_FLAGS.join(" ");
        assert!(flags.contains("--setting-sources user"));
        assert!(!flags.contains("project") && !flags.contains("local"));
        assert!(flags.contains("--strict-mcp-config"));
        assert!(flags.contains("--disable-slash-commands"));
        assert_eq!(UNTRUSTED_ENV, ("CLAUDE_CODE_DISABLE_CLAUDE_MDS", "1"));
    }

    #[test]
    fn halts_are_told_apart_from_failures() {
        assert!(is_halt(&anyhow::Error::new(Halted::Budget)));
        assert!(!is_halt(&anyhow::anyhow!("the agent reported an error")));
        assert_eq!(Halted::Time.reason(), "time");
    }
}
