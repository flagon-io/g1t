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
export type Chain<A> = { hops: number; asked_by: string; asker: A | null };

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
    .filter((agent) => named(agent) && `agent:${agent.id}` !== input.author)
    .map((agent) => ({ agent_id: agent.id, hops }));
}
