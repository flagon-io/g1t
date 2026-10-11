/**
 * Which agents a new message is handed to, and how many agent-to-agent
 * hops along it is. Pure, so it is tested apart from the service.
 *
 * The rules (docs.g1t.sh/guides/agents/, "Talk to an agent"):
 * - A person's message in a channel wakes the agent members it @mentions.
 *   In a direct message it wakes the agents in it that it @mentions; one
 *   that mentions none wakes the only agent there, or, with several, the
 *   agent the person is talking with (`addressedAgents`), or all of them
 *   when the conversation doesn't say. That starts a chain at hop 0.
 * - An agent's message wakes nobody, @mentions or not. An agent gets a
 *   colleague working only by handing off (`handOffPlace`), which wakes
 *   that one colleague, one hop further along the chain it was answering.
 *   No loops, and no agent summoned because its name came up.
 * - A chain stops after `MAX_HOPS` hops, and asks a person instead.
 */

/** The most agent-to-agent hops one person's request may start. Same as CHAT_MAX_HOPS in @g1t/contracts. */
export const MAX_HOPS = 6;

export type AgentMember = { id: string; handle: string };

export type Wake = { agent_id: string; hops: number };

/**
 * Who a chain was started by, carried along every hop of it: the person's
 * id and what they may do. A person's message starts one with their own
 * access (`askerAccess` in @g1t/contracts); an agent's message carries on
 * the one it was answering, so an agent woken three hops along never does
 * more than the person who asked could.
 */
export type Chain<A> = {
  hops: number;
  asked_by: string;
  asker: A | null;
  /** The agents that handled the request so far, by id, oldest first: for an agent's message, ending with its author. */
  chain: string[];
  /**
   * Set for a message written with a workflow job's token (`G1T_TOKEN`):
   * it wakes no agent, or a workflow that posts on a failing check could
   * start one whose push runs the workflow again, without end.
   */
  quiet?: boolean;
};

/** The most agent ids a chain carries: the hop limit's worth, and some. */
const MAX_CHAIN = 16;

/**
 * An agent's post's chain: the one it was answering, as the agents service
 * passed it back, with the agent itself added. Anything that is not a list
 * of ids is no chain.
 */
export function chainFor(given: unknown, author: string): string[] {
  const before = Array.isArray(given) ? given.filter((id): id is string => typeof id === "string" && !!id).slice(-MAX_CHAIN) : [];
  return [...before, author];
}

/** What the agents service is handed for one wake (AgentDelivery), on g1t's own chat. */
export function delivery<P extends object, A>(
  place: P,
  wake: Wake,
  message: { id: string; thread_root: string | null },
  chain: Chain<A>,
) {
  return {
    ...place,
    agent_id: wake.agent_id,
    message_id: message.id,
    thread_root: message.thread_root,
    asked_by: chain.asked_by,
    asker: chain.asker,
    chain: chain.chain,
    hops: wake.hops,
    surface: "g1t" as const,
  };
}

/** One earlier message of the conversation, as much of it as addressing needs. */
export type RecentMessage = {
  /** Who wrote it: `user:<id>` or `agent:<id>`. */
  author: string;
  /** Handles it @mentions, lowercased. */
  mentioned: string[];
};

/** How many earlier messages decide who an unaddressed message is for. */
export const ADDRESSING_HISTORY = 30;

/**
 * In a direct message with several agents, which of them a message from
 * `author` that mentions none of them is for: the agent the person is
 * talking with, read from the conversation so far (`recent`, oldest
 * first, the message itself left out). Walking back from the latest
 * message:
 *
 * 1. The agents whose messages come before any person's are the last
 *    exchange: whoever answered last. The message is for them.
 * 2. With no answer yet, the person's own latest message that @mentions
 *    agents of this conversation says who they addressed: it is for those.
 *    Their messages that mention none are passed over on the way.
 *
 * So "@mike make a PDF", Mike's answer, then "now make a fake one" is for
 * Mike alone, however many agents are in the conversation, and so is a
 * second message sent before Mike answers; after a hand-off to a
 * colleague here, the colleague's answer makes the next message theirs.
 * Other people's mentions decide nothing, and agents no longer in the
 * conversation count for nothing. When nothing in `recent` decides, every
 * agent gets it, as every agent got the first message.
 */
export function addressedAgents(agents: AgentMember[], author: string, recent: RecentMessage[]): AgentMember[] {
  if (agents.length < 2) return agents;
  const byId = new Map(agents.map((agent) => [`agent:${agent.id}`, agent]));
  const byHandle = new Map(agents.map((agent) => [agent.handle.toLowerCase(), agent]));
  const exchange: AgentMember[] = [];
  for (let i = recent.length - 1; i >= 0; i--) {
    const message = recent[i];
    const agent = byId.get(message.author);
    if (agent) {
      if (!exchange.includes(agent)) exchange.push(agent);
      continue;
    }
    if (!message.author.startsWith("user:")) continue;
    // A person's message: the agents that answered since are the exchange.
    if (exchange.length) break;
    if (message.author !== author) continue;
    const named = message.mentioned.map((handle) => byHandle.get(handle.toLowerCase())).filter((found): found is AgentMember => !!found);
    if (named.length) return agents.filter((agent) => named.includes(agent));
  }
  if (exchange.length) return agents.filter((agent) => exchange.includes(agent));
  return agents;
}

export function deliveries(input: {
  /** Who wrote it: `user:<id>` or `agent:<id>`. */
  author: string;
  /** For an agent's message: the hops of the delivery it answers. */
  hops: number;
  channelKind: "channel" | "dm";
  /** The channel's agent members (archived ones left out). */
  agents: AgentMember[];
  /** Handles the message @mentions, lowercased. */
  mentioned: string[];
  /**
   * In a direct message with several agents: the conversation before this
   * message, oldest first (`addressedAgents`). Absent or empty, an
   * unaddressed message goes to every agent in it.
   */
  recent?: RecentMessage[];
}): Wake[] {
  // Only a person's message wakes anyone; agents reach each other by hand-off.
  if (!input.author.startsWith("user:")) return [];
  const mentioned = new Set(input.mentioned.map((h) => h.toLowerCase()));
  const named = input.agents.filter((agent) => mentioned.has(agent.handle.toLowerCase()));
  const woken = input.channelKind === "dm" && !named.length ? addressedAgents(input.agents, input.author, input.recent ?? []) : named;
  return woken.map((agent) => ({ agent_id: agent.id, hops: 0 }));
}

/**
 * Where a hand-off's brief goes: here, when the colleague is already a
 * member of this channel or group direct message (everyone here sees the
 * work move); otherwise a group direct message of the person who asked,
 * the agent and the colleague, so the colleague reads only what it was
 * handed and works for that person, with their access.
 */
export function handOffPlace(input: { channelKind: "channel" | "dm"; members: number; colleagueHere: boolean }): "here" | "group_dm" {
  const shared = input.channelKind === "channel" || input.members > 2;
  return input.colleagueHere && shared ? "here" : "group_dm";
}

/**
 * Why an agent may not hand work to `colleague`, or null when it may. The
 * colleague is already of the workspace and not archived; this decides the
 * rest of the rails: not itself, never @g1t (no agent puts g1t to work),
 * never an agent already on this request (no ping-pong), and within the
 * hop limit.
 */
export function handOffRefusal(input: { agent: string; colleague: { id: string; builtin?: boolean }; chain: string[]; hops: number }): string | null {
  if (input.colleague.id === input.agent) return "An agent can't hand work to itself.";
  if (input.colleague.builtin) return "An agent can't hand work to @g1t. The person can ask @g1t themselves.";
  if (input.chain.includes(input.colleague.id)) return "That agent has already handled this request: no handing work back.";
  if (Math.max(0, Math.floor(input.hops || 0)) + 1 > MAX_HOPS) return "This request has been passed along too many times. Ask a person to step in.";
  return null;
}

/** The built-in orchestrator's handle. Same as BUILTIN_AGENT_HANDLE in @g1t/contracts. */
export const ORCHESTRATOR = "g1t";

/**
 * Whether a message brings @g1t into the conversation: every workspace has
 * it, so mentioning it in a channel adds it as a member the first time,
 * with no invite. A direct message is made with its members and never
 * gains one; to talk to @g1t alone, open a DM with it.
 */
export function addsOrchestrator(input: { channelKind: "channel" | "dm"; mentioned: string[]; orchestratorIsMember: boolean }): boolean {
  if (input.channelKind !== "channel" || input.orchestratorIsMember) return false;
  return input.mentioned.some((handle) => handle.toLowerCase() === ORCHESTRATOR);
}

/**
 * Where a member's personal agent may be (docs.g1t.sh/guides/agents/,
 * "Personal agents"): only in the direct message of the two of them. Not
 * in a channel, not in a group direct message, never handed work by
 * another agent. `members` are the conversation's principal keys
 * (`user:<id>`, `agent:<id>`); null when it is a channel. Null: allowed;
 * otherwise why not, as people are told.
 */
export function personalAgentRefusal(
  agent: { id: string; handle: string; scope?: string | null; personal_owner_id?: string | null },
  place: { kind: "channel" | "dm" | "hand_off"; members: string[] | null },
): string | null {
  if (agent.scope !== "personal") return null;
  const mine = `user:${agent.personal_owner_id ?? ""}`;
  const refusal = `@${agent.handle} is someone's personal agent: only the person it belongs to talks to it, in a direct message of the two of them.`;
  if (place.kind !== "dm" || !place.members) return refusal;
  const others = place.members.filter((key) => key !== `agent:${agent.id}`);
  return others.length === 1 && others[0] === mine ? null : refusal;
}
