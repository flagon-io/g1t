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
