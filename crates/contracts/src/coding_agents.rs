//! Coding agents and bots that commit under their own names (Claude Code,
//! Codex, Copilot, Dependabot…), matched by the address on their commits.
//! The same ids, addresses and logins as `packages/contracts/src/coding-agents.ts`,
//! which also holds their names and marks; a test keeps the two equal.

/// One agent: its id, the addresses it commits with, and the GitHub logins
/// whose noreply addresses are its. All lowercase.
pub struct CodingAgent {
    pub id: &'static str,
    pub emails: &'static [&'static str],
    pub logins: &'static [&'static str],
}

pub const CODING_AGENTS: &[CodingAgent] = &[
    CodingAgent { id: "claude", emails: &["noreply@anthropic.com"], logins: &["claude", "claude[bot]"] },
    CodingAgent { id: "codex", emails: &[], logins: &["chatgpt-codex-connector[bot]", "codex[bot]"] },
    CodingAgent { id: "copilot", emails: &[], logins: &["copilot", "copilot-swe-agent[bot]", "copilot-pull-request-reviewer[bot]"] },
    CodingAgent { id: "gemini", emails: &[], logins: &["gemini-code-assist[bot]", "gemini-cli[bot]"] },
    CodingAgent { id: "jules", emails: &[], logins: &["google-labs-jules[bot]"] },
    CodingAgent { id: "cursor", emails: &["cursoragent@cursor.com"], logins: &["cursor[bot]", "cursor-agent[bot]"] },
    CodingAgent { id: "devin", emails: &[], logins: &["devin-ai-integration[bot]"] },
    CodingAgent { id: "aider", emails: &["noreply@aider.chat", "aider@aider.chat"], logins: &[] },
    CodingAgent { id: "dependabot", emails: &["support@dependabot.com"], logins: &["dependabot[bot]", "dependabot-preview[bot]"] },
    CodingAgent { id: "renovate", emails: &["bot@renovateapp.com"], logins: &["renovate[bot]"] },
    CodingAgent { id: "github-actions", emails: &["action@github.com"], logins: &["github-actions[bot]"] },
];

/// The login a GitHub noreply address names (`123+login@users.noreply.github.com`).
fn github_login(address: &str) -> Option<&str> {
    let local = address.strip_suffix("@users.noreply.github.com")?;
    Some(local.split_once('+').map_or(local, |(_, login)| login))
}

/// The id of the coding agent a commit's address belongs to.
pub fn coding_agent_for(email: &str) -> Option<&'static str> {
    let address = email.trim().to_ascii_lowercase();
    if address.is_empty() {
        return None;
    }
    let login = github_login(&address);
    CODING_AGENTS
        .iter()
        .find(|agent| agent.emails.contains(&address.as_str()) || login.is_some_and(|login| agent.logins.contains(&login)))
        .map(|agent| agent.id)
}

/// The bots of [`CODING_AGENTS`]: they keep dependencies and builds
/// running, nobody starts them for a change, and their work is no agent's
/// in [`agent_mark`]'s sense.
const BOTS: &[&str] = &["dependabot", "renovate", "github-actions"];

/// GitHub's address for a change made on its site by nobody in particular.
const GITHUB_WEB: &str = "noreply@github.com";

/// How a commit says a coding agent made it, and whose work it is: the
/// rule that matched, the agent, and the address of the person who
/// started it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentMark {
    /// The coding agent's id ([`CODING_AGENTS`]).
    pub agent: &'static str,
    /// The rule that matched, strongest first:
    /// - `trailer:agent-logs-url`: an `Agent-Logs-Url` trailer, which
    ///   GitHub's cloud agent (Copilot) writes on each commit it makes,
    ///   authored by itself with the person who gave it the task as
    ///   co-author;
    /// - `trailer:claude-session`: a `Claude-Session` trailer, which Claude
    ///   Code writes on commits from a cloud or Remote Control session;
    /// - `author:<agent>`: the agent's address is the author's, as Copilot,
    ///   Cursor's cloud agents and Devin can commit;
    /// - `coauthor:<agent>`: a `Co-authored-by` trailer with the agent's
    ///   address, as Claude Code and Cursor write;
    /// - `trailer:made-with-cursor`: Cursor's `Made with Cursor` line.
    pub rule: String,
    /// The address, lowercase, of the person it counts for: with an agent
    /// as author, the first co-author who is no agent; otherwise the
    /// author, unless that is an agent too. `None` when the commit names
    /// no person. Matching it to an account is the caller's (an address a
    /// member verified, never a name).
    pub starter: Option<String>,
}

/// A commit's message as trailers: each `Key: value` line, the key
/// lowercased. Lines anywhere count, as a squashed commit carries its
/// commits' trailers in its body.
fn trailer_lines(message: &str) -> impl Iterator<Item = (String, &str)> {
    message.lines().filter_map(|line| {
        let (key, value) = line.trim().split_once(':')?;
        let key = key.trim();
        if key.is_empty() || key.contains(|c: char| !(c.is_ascii_alphanumeric() || c == '-')) {
            return None;
        }
        Some((key.to_ascii_lowercase(), value.trim()))
    })
}

/// The address in `Name <address>`, lowercase.
fn address_in(value: &str) -> Option<String> {
    let start = value.rfind('<')?;
    let end = start + value[start..].find('>')?;
    let address = value[start + 1..end].trim().to_ascii_lowercase();
    address.contains('@').then_some(address)
}

/// Whether an address is a person's: some address, no coding agent's or
/// bot's, and not GitHub's own.
fn is_person_address(address: &str) -> bool {
    address.contains('@') && address != GITHUB_WEB && coding_agent_for(address).is_none()
}

/// The coding agent, not a bot, an address belongs to.
fn agent_at(address: &str) -> Option<&'static str> {
    coding_agent_for(address).filter(|id| !BOTS.contains(id))
}

/// Whether a coding agent made a commit, by the conventions agents write
/// on their commits, and who it counts for ([`AgentMark`]). `author_email`
/// is the commit's author's address. Names are never read: anyone can
/// write "Copilot" as their name. A commit no rule matches is `None`; so is
/// one only a bot made.
pub fn agent_mark(message: &str, author_email: Option<&str>) -> Option<AgentMark> {
    let author = author_email
        .map(|email| email.trim().to_ascii_lowercase())
        .filter(|email| !email.is_empty());
    let mut co_authors: Vec<String> = Vec::new();
    let (mut logs_url, mut claude_session, mut made_with_cursor) = (false, false, false);
    for (key, value) in trailer_lines(message) {
        match key.as_str() {
            "co-authored-by" => {
                if let Some(address) = address_in(value)
                    && !co_authors.contains(&address)
                {
                    co_authors.push(address);
                }
            }
            "agent-logs-url" if value.starts_with("https://") => logs_url = true,
            "claude-session" if value.starts_with("https://") => claude_session = true,
            "made-with" if value.eq_ignore_ascii_case("cursor") => made_with_cursor = true,
            _ => {}
        }
    }
    made_with_cursor |= message
        .lines()
        .any(|line| line.trim().eq_ignore_ascii_case("made with cursor"));
    let author_agent = author.as_deref().and_then(agent_at);
    let person_author = author.clone().filter(|address| is_person_address(address));
    let person_co_author = || {
        co_authors
            .iter()
            .find(|address| is_person_address(address))
            .cloned()
    };
    // An agent as author: the work is whoever it names as co-author.
    let for_co_author = |agent: &'static str, rule: &str| AgentMark {
        agent,
        rule: rule.to_owned(),
        starter: person_co_author(),
    };
    // A person as author, with an agent's help: theirs.
    let for_author = |agent: &'static str, rule: &str| AgentMark {
        agent,
        rule: rule.to_owned(),
        starter: person_author.clone().or_else(person_co_author),
    };
    if logs_url {
        return Some(for_co_author(
            author_agent.unwrap_or("copilot"),
            "trailer:agent-logs-url",
        ));
    }
    if claude_session {
        return Some(match author_agent {
            Some(agent) => for_co_author(agent, "trailer:claude-session"),
            None => for_author("claude", "trailer:claude-session"),
        });
    }
    if let Some(agent) = author_agent {
        return Some(for_co_author(agent, &format!("author:{agent}")));
    }
    if let Some(agent) = co_authors.iter().find_map(|address| agent_at(address)) {
        return Some(for_author(agent, &format!("coauthor:{agent}")));
    }
    if made_with_cursor {
        return Some(for_author("cursor", "trailer:made-with-cursor"));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agents_are_found_by_their_commit_addresses() {
        assert_eq!(coding_agent_for("noreply@anthropic.com"), Some("claude"));
        assert_eq!(coding_agent_for(" NoReply@Anthropic.com "), Some("claude"));
        assert_eq!(coding_agent_for("49699333+dependabot[bot]@users.noreply.github.com"), Some("dependabot"));
        assert_eq!(coding_agent_for("198982749+Copilot@users.noreply.github.com"), Some("copilot"));
        assert_eq!(coding_agent_for("ada@example.com"), None);
        assert_eq!(coding_agent_for("1+ada@users.noreply.github.com"), None);
        assert_eq!(coding_agent_for(""), None);
    }

    type Found = Option<(&'static str, String, Option<String>)>;

    fn mark(message: &str, author: &str) -> Found {
        agent_mark(message, Some(author)).map(|mark| (mark.agent, mark.rule, mark.starter))
    }

    fn found(agent: &'static str, rule: &str, starter: Option<&str>) -> Found {
        Some((agent, rule.to_owned(), starter.map(str::to_owned)))
    }

    const COPILOT: &str = "198982749+Copilot@users.noreply.github.com";
    const DEVIN: &str = "158243242+devin-ai-integration[bot]@users.noreply.github.com";

    #[test]
    fn copilot_s_commits_count_for_whoever_gave_it_the_task() {
        let message = "Add retries to the client\n\nCo-authored-by: Ada Lovelace <ada@example.com>\n\
                       Agent-Logs-Url: https://github.com/acme/web/sessions/1a2b";
        assert_eq!(
            mark(message, COPILOT),
            found("copilot", "trailer:agent-logs-url", Some("ada@example.com"))
        );
        // Without the trailer, its address as author still says so.
        let older = "Add retries\n\nCo-authored-by: ada <1+ada@users.noreply.github.com>";
        assert_eq!(
            mark(older, COPILOT),
            found(
                "copilot",
                "author:copilot",
                Some("1+ada@users.noreply.github.com")
            )
        );
        // Another agent on GitHub's cloud writes the same trailer as itself.
        let claude = "Fix it\n\nCo-authored-by: Ada <ada@example.com>\nAgent-Logs-Url: https://github.com/acme/web/sessions/9";
        assert_eq!(
            mark(claude, "209825114+claude[bot]@users.noreply.github.com"),
            found("claude", "trailer:agent-logs-url", Some("ada@example.com"))
        );
    }

    #[test]
    fn cursor_s_agents_count_for_the_person_beside_them() {
        // A cloud agent: Cursor's address as author, the person as co-author.
        let cloud = "Tidy the parser\n\nCo-authored-by: Ada <ada@example.com>";
        assert_eq!(
            mark(cloud, "cursoragent@cursor.com"),
            found("cursor", "author:cursor", Some("ada@example.com"))
        );
        // The person as author, Cursor as co-author.
        let beside = "Tidy the parser\n\nCo-authored-by: Cursor <cursoragent@cursor.com>";
        assert_eq!(
            mark(beside, "ada@example.com"),
            found("cursor", "coauthor:cursor", Some("ada@example.com"))
        );
        // The editor's and CLI's line, in either spelling.
        assert_eq!(
            mark("Tidy\n\nMade with Cursor", "Ada@Example.com"),
            found(
                "cursor",
                "trailer:made-with-cursor",
                Some("ada@example.com")
            )
        );
        assert_eq!(
            mark("Tidy\n\nMade-with: Cursor", "ada@example.com"),
            found(
                "cursor",
                "trailer:made-with-cursor",
                Some("ada@example.com")
            )
        );
    }

    #[test]
    fn claude_and_devin_are_found_by_their_trailers_and_addresses() {
        let local = "Fix it\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>";
        assert_eq!(
            mark(local, "ada@example.com"),
            found("claude", "coauthor:claude", Some("ada@example.com"))
        );
        let cloud = "Fix it\n\nClaude-Session: https://claude.ai/code/session_01abc";
        assert_eq!(
            mark(cloud, "ada@example.com"),
            found("claude", "trailer:claude-session", Some("ada@example.com"))
        );
        let devin = "Fix it\n\nCo-authored-by: Ada <ada@example.com>";
        assert_eq!(
            mark(devin, DEVIN),
            found("devin", "author:devin", Some("ada@example.com"))
        );
        let helped = format!("Fix\n\nCo-authored-by: Devin AI <{DEVIN}>");
        assert_eq!(
            mark(&helped, "ada@example.com"),
            found("devin", "coauthor:devin", Some("ada@example.com"))
        );
    }

    #[test]
    fn nothing_is_an_agent_s_on_a_name_alone_or_a_bot_s() {
        assert_eq!(
            mark(
                "Fix it\n\nCo-authored-by: Claude <claude@example.com>",
                "ada@example.com"
            ),
            None
        );
        assert_eq!(
            mark(
                "Explain the Agent-Logs-Url: trailer in the docs",
                "ada@example.com"
            ),
            None
        );
        assert_eq!(
            mark(
                "Bump serde",
                "49699333+dependabot[bot]@users.noreply.github.com"
            ),
            None
        );
        assert_eq!(mark("Plain change", "ada@example.com"), None);
        assert_eq!(agent_mark("Plain change", None), None);
        // An agent with nobody beside it is still an agent's, for nobody.
        assert_eq!(
            mark("Plain change", "cursoragent@cursor.com"),
            found("cursor", "author:cursor", None)
        );
        // GitHub's own address is nobody's.
        let web = "Fix\n\nCo-authored-by: GitHub <noreply@github.com>\nAgent-Logs-Url: https://github.com/acme/web/sessions/1";
        assert_eq!(
            mark(web, COPILOT),
            found("copilot", "trailer:agent-logs-url", None)
        );
    }

    /// The site's list (packages/contracts/src/coding-agents.ts) has every
    /// agent here, with the same addresses and logins, and no others.
    #[test]
    fn the_typescript_list_is_the_same() {
        let ts = include_str!("../../../packages/contracts/src/coding-agents.ts");
        let ids: Vec<&str> = ts.match_indices("    id: \"").map(|(at, m)| &ts[at + m.len()..]).map(|rest| &rest[..rest.find('"').unwrap()]).collect();
        assert_eq!(ids, CODING_AGENTS.iter().map(|a| a.id).collect::<Vec<_>>());
        for agent in CODING_AGENTS {
            let start = ts.find(&format!("    id: \"{}\"", agent.id)).unwrap();
            let block = &ts[start..ts[start..].find("\n  },").map(|end| start + end).unwrap()];
            let list = |key: &str| -> Vec<String> {
                let line = block.lines().find(|l| l.trim_start().starts_with(&format!("{key}:"))).unwrap();
                line.split('"').skip(1).step_by(2).map(str::to_owned).collect()
            };
            assert_eq!(list("emails"), agent.emails.iter().map(|s| s.to_string()).collect::<Vec<_>>(), "{} emails", agent.id);
            assert_eq!(list("logins"), agent.logins.iter().map(|s| s.to_string()).collect::<Vec<_>>(), "{} logins", agent.id);
        }
    }
}
