/**
 * Which agents a new message is handed to, and how many agent-to-agent
 * hops along it is. Pure, so it is tested apart from the service.
 *
 * The rules (docs/WORKSPACE.md, "Talking to each other"):
 * - A person's message wakes every agent in a direct message with them,
 *   and in a channel only the agent members it @mentions. That starts a
 *   chain at hop 0.
 * - An agent's message wakes other agents only when it @mentions them
 *   (addressed only, never because they were in the room), one hop further
 *   along the chain it was answering.
 * - A chain stops after `MAX_HOPS` hops, and asks a person instead.
 * - An agent is never handed its own message.
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

/**
 * The agent that sent the author its work: the one before the author in
 * the chain. The author's message never goes back to it (no ping-pong).
 */
export function sender(chain: string[]): string | null {
  return chain.length >= 2 ? chain[chain.length - 2] : null;
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
  /** For an agent's message: the agent that sent it the work, never handed it back. */
  notTo?: string | null;
}): Wake[] {
  const mentioned = new Set(input.mentioned.map((h) => h.toLowerCase()));
  const named = (agent: AgentMember) => mentioned.has(agent.handle.toLowerCase());
  if (input.author.startsWith("user:")) {
    const woken = input.channelKind === "dm" ? input.agents : input.agents.filter(named);
    return woken.map((agent) => ({ agent_id: agent.id, hops: 0 }));
  }
  const hops = Math.max(0, Math.floor(input.hops || 0)) + 1;
  if (hops > MAX_HOPS) return [];
  return input.agents
    .filter((agent) => named(agent) && `agent:${agent.id}` !== input.author && agent.id !== input.notTo)
    .map((agent) => ({ agent_id: agent.id, hops }));
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
