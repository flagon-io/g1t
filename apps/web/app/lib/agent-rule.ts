/**
 * Why g1t says a change is an agent's, in words: the rule that matched
 * (signals' `agentRule`, a pull request's `agentWork.rule`). The rules
 * are services/work's (signals/base.sql) and the commit conventions
 * `coding_agents::agent_mark` reads.
 */
import { codingAgentById } from "@g1t/contracts/coding-agents";

/** The agent a rule names, by its id, as its card calls it. */
function agentName(id: string): string {
  return codingAgentById(id)?.name ?? id;
}

/**
 * A rule as a phrase that finishes "An agent's: …", such as "an
 * Agent-Logs-Url trailer on its commits". Null for no rule; an unknown
 * rule is shown as it is.
 */
export function agentRuleText(rule: string | null | undefined): string | null {
  if (!rule) return null;
  if (rule === "g1t") return "opened by g1t's agent, or as an agent's";
  if (rule === "session") return "a session g1t recorded is tied to it";
  if (rule === "trailer:agent-logs-url") return "an Agent-Logs-Url trailer on its commits";
  if (rule === "trailer:claude-session") return "a Claude-Session trailer on its commits";
  if (rule === "trailer:made-with-cursor") return "“Made with Cursor” on its commits";
  const [kind, agent] = rule.split(":", 2);
  if (kind === "author" && agent) return `${agentName(agent)} is the author of its commits`;
  if (kind === "coauthor" && agent) return `${agentName(agent)} is a co-author of its commits`;
  return rule;
}

/** The title for an agent's mark: "An agent's: …", or just "An agent's" without a rule. */
export function agentTitle(rule: string | null | undefined): string {
  const text = agentRuleText(rule);
  return text ? `An agent's: ${text}` : "An agent's";
}
