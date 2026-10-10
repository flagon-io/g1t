/**
 * Handing work to a colleague from chat (docs.g1t.sh/guides/agents/,
 * "Hand off"): the `hand_off` tool's port. Pure apart from what it is
 * given, so its refusals are tested on their own.
 *
 * The agent's words never wake a colleague; this does. It checks who the
 * colleague is here (an agent of the workspace, available, not the agent
 * itself, not @g1t, not one already on this request) and that the person
 * who asked may use the workspace's agents, then asks the surface to hand
 * it over. The chat service checks the same rails again, and decides
 * where the brief goes: here, when the colleague is in this channel or
 * group message, or the group message of the person, the agent and the
 * colleague. The colleague answers through its own reply, paid from its
 * own budget, with the asker's access.
 */
import type { AgentStatus, AskerAccess } from "@g1t/contracts";

import type { HandedOff } from "./surface.ts";

/** A colleague as the hand-off sees it. */
export type Colleague = { id: string; handle: string; display_name: string; builtin: boolean; status: AgentStatus };

export type HandOffPorts = {
  /** The agent itself. */
  self: { id: string; handle: string };
  /** The agents that handled this request before, oldest first. */
  chain: string[];
  /** What the person who asked may do; null when the chat service didn't say. */
  asker: AskerAccess | null;
  /** An agent of the workspace by handle, not archived, or null. */
  agent(handle: string): Promise<Colleague | null>;
  /** Whether a person of the workspace has this username. */
  person(handle: string): Promise<boolean>;
  /** Hands the work over (Surface.handOff). */
  handOff(colleagueId: string, brief: string): Promise<HandedOff>;
};

const UNAVAILABLE: Partial<Record<AgentStatus, string>> = {
  paused: "is paused",
  out_of_budget: "is out of budget this month",
};

/** Why the work can't go to `colleague`, or null when it can. */
export function handOffRefusal(handle: string, colleague: Colleague | null, ports: Pick<HandOffPorts, "self" | "chain" | "asker">, isPerson: boolean): string | null {
  if (!colleague) {
    return isPerson
      ? `@${handle} is a person, not an agent: hand_off is only for agents. Tell them who to ask, by name.`
      : `There is no agent called @${handle} in this workspace. Check the names in your colleagues list.`;
  }
  if (colleague.id === ports.self.id) return "That's you. Do the work yourself, or hand it to someone else.";
  if (colleague.builtin) return "@g1t can't be handed work by an agent. If the person wants g1t, they can ask it themselves.";
  if (ports.chain.includes(colleague.id)) return `@${handle} has already handled this request: don't hand it back. Answer with what you have.`;
  if (ports.asker?.role === "outside") return "The person you're working for isn't a member of this workspace, so its agents can't take work on for them.";
  const why = UNAVAILABLE[colleague.status];
  if (why) return `@${handle} ${why}, so they can't take this on. Tell the person they're unavailable and why.`;
  return null;
}

/** The brief as it is posted: addressed to the colleague, by @mention if it isn't already. */
export function addressed(handle: string, brief: string): string {
  // Handles are letters, digits, `_` and `-`: nothing to escape.
  const named = new RegExp(`(^|[^a-z0-9_.@-])@${handle}(?![a-z0-9_/-])`, "i");
  return named.test(brief) ? brief : `@${handle} ${brief}`;
}

/** What the agent is told once the work is handed over. */
export function handedMessage(colleague: Colleague, asker: string | null, done: Extract<HandedOff, { ok: true }>): string {
  const who = asker ? `@${asker}` : "the person who asked";
  if (done.where === "here") {
    return `Handed to @${colleague.handle}: your brief is posted in this conversation and they're on it; they answer ${who} here. Say so in a sentence; don't repeat the brief.`;
  }
  const dm = done.opened ? "a new group message" : "the group message you three already have";
  return `Handed to @${colleague.handle} in ${dm} with ${who}, you and them; your brief is there, and a card here links to it. Tell ${who} in a sentence that ${colleague.display_name} has it there. Don't repeat the brief.`;
}

/** The `hand_off` port (ActionPorts.handOff). */
export function handOffPort(ports: HandOffPorts): (handle: string, brief: string) => Promise<{ ok: boolean; message: string }> {
  return async (handle, brief) => {
    const colleague = await ports.agent(handle);
    const refused = handOffRefusal(handle, colleague, ports, colleague ? false : await ports.person(handle).catch(() => false));
    if (refused) return { ok: false, message: refused };
    const done = await ports.handOff(colleague!.id, addressed(colleague!.handle, brief));
    if (!done.ok) return { ok: false, message: `It couldn't be handed over: ${done.message}` };
    return { ok: true, message: handedMessage(colleague!, ports.asker?.username ?? null, done) };
  };
}
