/**
 * What an agent may reach in folios for the person it acts for (its
 * asker), and who else will see its answer (the audience): the leak rules
 * (docs.g1t.sh/guides/agent-access/), apart from where rows come from.
 * Pure.
 *
 * - The agent never has more than its asker (`agentFolioRole`).
 * - Finding things (lists, search, recall, stale) is narrowed to folios
 *   every person in the audience can read, so nothing turns up in a
 *   conversation that someone in it can't open.
 * - A public channel's audience is "the workspace": only folios readable
 *   through an open space or general access `workspace`. Never a link
 *   folio, a share, or Private. More than 20 people reads the same way.
 * - Reading one folio the asker named (a link they gave) works whenever
 *   the asker can read it; the result says `audience_can_read: false`
 *   when someone else in the conversation can't, so the agent says it
 *   sent the link to the asker instead of quoting it.
 */
import type { DocAgentAbilities, DocAgentMode, DocAudience, DocRole } from "@g1t/contracts";

import { agentAbilities, agentFolioRole, effectiveRole, folioReadableByWorkspace, roleOf, type FolioAclNode, type FolioGrants, type Person, type SpaceRules } from "../access.ts";

/** More people than this in a conversation read as the whole workspace. */
export const AUDIENCE_AS_WORKSPACE = 20;

/** Who an answer reaches, as access checks it. */
export type AudienceRule =
  /** The asker alone (no audience, or only them). */
  | { kind: "asker" }
  /** These other people besides the asker, by user id. */
  | { kind: "people"; user_ids: string[] }
  /** Everyone in the workspace. */
  | { kind: "workspace" };

export function audienceRule(audience: DocAudience | null | undefined, askerId: string): AudienceRule {
  if (!audience) return { kind: "asker" };
  if (audience.kind === "workspace") return { kind: "workspace" };
  if (audience.kind !== "people" || !Array.isArray(audience.user_ids)) return { kind: "asker" };
  const others = [...new Set(audience.user_ids.map(String))].filter((id) => id && id !== askerId);
  if (!others.length) return { kind: "asker" };
  if (others.length + 1 > AUDIENCE_AS_WORKSPACE) return { kind: "workspace" };
  return { kind: "people", user_ids: others };
}

/** One folio as an agent sees it. */
export type AgentReach = {
  /** The asker's role, or null when they can't read it. */
  asker_role: DocRole | null;
  /** Whether everyone in the audience can read it too. */
  audience_can_read: boolean;
  /** What the agent may do: the asker's role, nothing more, by the folio's agent mode. */
  can: DocAgentAbilities;
};

export type ReachInput = {
  chain: readonly FolioAclNode[];
  grants: FolioGrants;
  /** The folio's space's rules, when its chain inherits one (else null). */
  space: SpaceRules | null;
  asker: Person;
  askerVisited: boolean;
  rule: AudienceRule;
  /** The audience's people (for a `people` rule). */
  people: readonly Person[];
  /** Whether a person opened the folio's link. */
  visited: (person: Person) => boolean;
  agent_mode: DocAgentMode;
};

export function agentReach(input: ReachInput): AgentReach {
  const spaceRole = (p: Person) => (input.space ? roleOf(input.space, p) : null);
  const asker = effectiveRole(input.chain, input.grants, spaceRole(input.asker), input.asker, { visited: input.askerVisited });
  let audience = true;
  if (input.rule.kind === "workspace") audience = folioReadableByWorkspace(input.chain, input.space);
  else if (input.rule.kind === "people") audience = input.people.every((p) => !!effectiveRole(input.chain, input.grants, spaceRole(p), p, { visited: input.visited(p) }));
  const role = agentFolioRole(asker, true);
  return { asker_role: role, audience_can_read: !!asker && audience, can: agentAbilities(role, input.agent_mode) };
}

/** Whether an agent may find a folio (lists, search, recall): its asker and every person in the audience can read it. */
export function agentMayFind(reach: AgentReach): boolean {
  return !!reach.asker_role && reach.audience_can_read;
}
