/**
 * Where a conversation happens, as the reply loop sees it: read what was
 * said, show that the agent is typing, post its answer. The loop knows
 * nothing else about the chat it is in, so the same agent (its definition,
 * budget and replies) answers wherever it is reached: g1t's own chat today,
 * another chat app the workspace connected later (docs/WORKSPACE.md,
 * "Working from another chat app"). Only g1t's adapter exists.
 */
import type { AgentDelivery, ChatMessage, ConversationForAgent, MessageCard, ServiceBinding } from "@g1t/contracts";

// By path, not the package: it imports only types, so the adapter is tested under Node.
import { CHAT_MAX_HOPS, chatClient } from "../../../packages/contracts/src/chat.ts";

/** One message, as the reply loop reads it, whatever the surface. */
export type SurfaceMessage = {
  id: string;
  author: { kind: "user" | "agent"; id: string; name: string; display_name: string };
  body: string;
  /** A card's one-line summary, when the message is a card. */
  card: string | null;
  created_at: string;
};

/** One member of a conversation, as an agent is told about it. */
export type ConversationMember = {
  kind: "user" | "agent";
  id: string;
  /** What `@` mentions: a person's username, an agent's handle. */
  name: string;
  display_name: string;
  /** An agent's title, or its role when it has none; null for a person. */
  title: string | null;
};

/**
 * Where an agent is answering and who is in it (docs/WORKSPACE.md, "Where
 * you are"): only these members read what it says there.
 */
export type Conversation = {
  kind: "dm" | "group_dm" | "private_channel" | "public_channel";
  /** A channel's name; null for a direct message. */
  name: string | null;
  /** Every agent, then people up to a cap. */
  members: ConversationMember[];
  people: number;
  agents: number;
};

/** What handing work to a colleague did. */
export type HandedOff = { ok: true; where: "here" | "group_dm"; opened: boolean } | { ok: false; message: string };

export interface Surface {
  /** The latest `limit` messages of the conversation (the thread, or the DM or channel), oldest first. */
  history(limit: number): Promise<SurfaceMessage[]>;
  /** Shows the agent typing. Never throws: it is a courtesy. */
  typing(): Promise<void>;
  /**
   * Posts as the agent, in the conversation it was asked in, optionally as
   * a card (a consult, say). Returns the new message's id.
   */
  post(body: string, card?: MessageCard | null): Promise<string>;
  /**
   * Reacts 👀 to the message that woke the agent, so people see it is on
   * it. Never throws, and skipped where it adds nothing (see `reactsIn`).
   */
  acknowledge(): Promise<void>;
  /**
   * Once the reply has posted: 👀 becomes ✅ when it answered (`done`), or
   * is taken away when it posted a notice or an apology (`withdrawn`).
   * Never throws.
   */
  settle(outcome: "done" | "withdrawn"): Promise<void>;
  /** The conversation and who is in it; null when it can't be read. Never throws. */
  conversation(): Promise<Conversation | null>;
  /**
   * Hands work to a colleague agent for the person who asked: posted here
   * when the colleague is in this channel or group DM, otherwise in the
   * group DM of that person, this agent and the colleague, with a card
   * here saying where it went. Wakes the colleague and nobody else.
   */
  handOff(colleagueId: string, brief: string): Promise<HandedOff>;
}

/** A conversation as the chat service describes it, as the reply loop reads it. */
export function conversationFrom(value: ConversationForAgent): Conversation {
  const { channel } = value;
  const kind =
    channel.kind === "dm" ? (value.people + value.agents > 2 ? "group_dm" : "dm") : channel.private ? "private_channel" : "public_channel";
  return {
    kind,
    name: channel.kind === "dm" ? null : channel.name,
    members: value.members.map((m) => ({
      kind: m.kind,
      id: m.id,
      name: m.name,
      display_name: m.display_name,
      title: m.kind === "agent" ? m.title || m.role || null : null,
    })),
    people: value.people,
    agents: value.agents,
  };
}

export const SEEN = "👀";
export const DONE = "✅";

/**
 * Whether an agent reacts in a conversation: in channels and in direct
 * messages with more than one person. In a DM with one person, the typing
 * indicator says enough.
 */
export function reactsIn(kind: "channel" | "dm", people: number): boolean {
  return kind === "channel" || people > 1;
}

/** A g1t chat message as the loop reads it. */
export function fromChat(message: ChatMessage): SurfaceMessage {
  const card = message.card
    ? [message.card.kind, message.card.title, message.card.detail, message.card.state].filter(Boolean).join(" · ")
    : null;
  return {
    id: message.id,
    author: {
      kind: message.author.kind,
      id: message.author.id,
      name: message.author.name,
      display_name: message.author.display_name,
    },
    body: message.deleted_at ? "" : message.body,
    card,
    created_at: message.created_at,
  };
}

/**
 * g1t's own chat, over the chat service. Replies stay in the thread they
 * were asked in, and carry the delivery's hops, `asked_by` and `asker` on.
 * A reply wakes nobody, @mentions or not; a hand-off wakes its colleague
 * one hop further along the same person's request, with that person's
 * access.
 */
export function g1tSurface(chat: ServiceBinding, delivery: AgentDelivery): Surface {
  const client = chatClient(chat);
  const { workspace, channel_id: channel, agent_id: agent } = delivery;
  // Whether 👀 went on, so `settle` knows what to take back.
  let acknowledged: Promise<boolean> = Promise.resolve(false);
  return {
    async history(limit) {
      const page = await client.historyForAgent(workspace, channel, agent, { thread_root: delivery.thread_root, limit });
      if (!page.ok) throw new Error(`reading the conversation failed: ${page.error.message}`);
      return page.value.filter((message) => !message.deleted_at).map(fromChat);
    },
    async typing() {
      await client.agentTyping(workspace, channel, agent).catch(() => undefined);
    },
    async acknowledge() {
      acknowledged = (async () => {
        try {
          // A first message's hello answers nothing; a DM's people decide the rest.
          if (delivery.message_id.startsWith("hello:")) return false;
          if (delivery.channel_kind === "dm") {
            const audience = await client.audience(workspace, channel);
            if (!audience.ok || !reactsIn("dm", audience.value.member_count)) return false;
          }
          const reacted = await client.reactAsAgent(workspace, channel, agent, delivery.message_id, SEEN);
          return reacted.ok;
        } catch {
          return false;
        }
      })();
      await acknowledged;
    },
    async settle(outcome) {
      try {
        if (!(await acknowledged)) return;
        await client.reactAsAgent(workspace, channel, agent, delivery.message_id, SEEN, true);
        if (outcome === "done") await client.reactAsAgent(workspace, channel, agent, delivery.message_id, DONE);
      } catch {
        // A reaction is a courtesy: the reply stands without it.
      }
    },
    async post(body, card = null) {
      const posted = await client.postAsAgent(workspace, channel, agent, {
        body,
        card,
        thread_root: delivery.thread_root,
        hops: Math.min(delivery.hops, CHAT_MAX_HOPS),
        asked_by: delivery.asked_by,
        // Agents this reply wakes act for the same person, with their access.
        asker: delivery.asker ?? null,
        // Chat adds this agent, and never hands the post back to the one that sent it the work.
        chain: delivery.chain ?? [],
      });
      if (!posted.ok) throw new Error(`posting the reply failed: ${posted.error.message}`);
      return posted.value.id;
    },
    async conversation() {
      try {
        const found = await client.conversationForAgent(workspace, channel, agent, delivery.asked_by);
        return found.ok ? conversationFrom(found.value) : null;
      } catch {
        return null;
      }
    },
    async handOff(colleagueId, brief) {
      const done = await client.handOffAsAgent(workspace, channel, agent, {
        colleague_id: colleagueId,
        brief,
        thread_root: delivery.thread_root,
        hops: Math.min(delivery.hops, CHAT_MAX_HOPS),
        asked_by: delivery.asked_by,
        // The colleague works for the same person, with their access.
        asker: delivery.asker ?? null,
        chain: delivery.chain ?? [],
      });
      return done.ok ? { ok: true, where: done.value.where, opened: done.value.opened } : { ok: false, message: done.error.message };
    },
  };
}

/** The surface a delivery came from. Every delivery is g1t's today. */
export function surfaceFor(chat: ServiceBinding, delivery: AgentDelivery): Surface {
  switch (delivery.surface ?? "g1t") {
    case "g1t":
    default:
      return g1tSurface(chat, delivery);
  }
}
