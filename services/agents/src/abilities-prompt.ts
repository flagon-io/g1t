/**
 * What the prompt says about an agent's abilities outside g1t
 * (abilities.ts), and what a turn "said" for "alone when asked for it".
 * Pure, with type-only imports, so it is tested under Node as it is.
 */
import type { Ability, AbilitySection } from "@g1t/contracts";

/**
 * The abilities as the prompt tells the agent about them: what each
 * connected integration lets it do and at which level, its MCP servers,
 * and what isn't connected, so it asks rather than guesses.
 */
export function abilitiesSection(sections: AbilitySection[]): string | null {
  const lines: string[] = [];
  const words = (ability: Ability) => (ability.level === "alone" ? "on your own" : ability.level === "asked" ? "on your own only when they asked for it, else it asks first" : ability.level === "ask" ? "asks first (a card)" : "never");
  for (const section of sections) {
    if (section.group !== "integration" && section.group !== "mcp") continue;
    for (const source of section.sources) {
      if (!source.connected) continue;
      const ready = source.abilities.filter((ability) => ability.status === "ready");
      if (!ready.length) continue;
      lines.push(`- ${source.name}: ${ready.map((ability) => `${ability.label.toLowerCase()} ${words(ability)}`).join("; ")}.`);
    }
  }
  const missing = sections
    .filter((section) => section.group === "integration")
    .flatMap((section) => section.sources)
    .filter((source) => !source.connected && source.abilities.length)
    .map((source) => source.name);
  if (!lines.length && !missing.length) return null;
  return [
    "## Your abilities outside g1t",
    "",
    "These are set on your Abilities tab and enforced in code: a call that isn't allowed is refused with the rule, and one that asks first posts a card. Never work around a refusal.",
    ...(lines.length ? ["", ...lines] : []),
    ...(missing.length ? ["", `Not connected to this workspace: ${missing.join(", ")}. When someone needs one, say so and use request_ability.`] : []),
  ].join("\n");
}

/** What a turn says, for "alone when asked for it": the latest messages from people, or a session's goal and steering. */
export function saidText(parts: (string | null | undefined)[]): string {
  return parts.filter((part): part is string => typeof part === "string" && part.trim().length > 0).join("\n").slice(0, 20_000);
}
