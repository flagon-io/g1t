/**
 * An agent's skills in its instructions (docs.g1t.sh/guides/agent-skills/).
 * Pure, so it is tested on its own.
 *
 * Each foundational skill that is on (@g1t/contracts skills.ts) puts its
 * playbook in the system prompt, followed by what it can't do here: the
 * abilities whose tools this turn doesn't offer (code tools in a
 * conversation whose people can't all read code, say), and the abilities
 * that are coming. A skill never adds a tool: the tools offered are the
 * tool box's, decided before this runs.
 */
import { type AgentSkill, skillsOn } from "../../../packages/contracts/src/skills.ts";

/** "a, b and c". */
function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** What one skill says: its playbook, then what isn't available here and what is coming. */
export function skillBlock(skill: AgentSkill, offered: ReadonlySet<string>): string {
  const missingHere = skill.abilities.filter((a) => a.status === "ready" && a.tools.length > 0 && !a.tools.some((tool) => offered.has(tool)));
  const coming = skill.abilities.filter((a) => a.status === "coming");
  const lines = [`### ${skill.name}`, "", skill.instructions];
  if (missingHere.length) {
    lines.push(`- Not available in this conversation (its tools aren't offered here): ${list(missingHere.map((a) => a.label.toLowerCase()))}. If asked, say you can't do that here.`);
  }
  if (coming.length) {
    lines.push(`- Not yet in g1t: ${list(coming.map((a) => a.label.toLowerCase()))}. If asked, say plainly it isn't available yet and offer what you can do instead; never pretend to have done it.`);
  }
  return lines.join("\n");
}

/**
 * The "Your skills" section: every skill that is on, for the tools this
 * turn offers. Null when every skill is off.
 */
export function skillsSection(off: readonly string[] | null | undefined, offered: Iterable<string>): string | null {
  const on = skillsOn(off);
  if (!on.length) return null;
  const tools = new Set(offered);
  return [
    "## Your skills",
    "",
    "Playbooks for the work people ask of you, from g1t. They use only the tools you have; they never add one. When a request matches a skill, follow its playbook and deliver the thing itself.",
    "",
    on.map((skill) => skillBlock(skill, tools)).join("\n\n"),
  ].join("\n");
}
