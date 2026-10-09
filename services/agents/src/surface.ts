/**
 * Where a conversation happens, as the reply loop sees it: read what was
 * said, show that the agent is typing, post its answer. The loop knows
 * nothing else about the chat it is in, so the same agent (its definition,
 * budget and replies) answers wherever it is reached: g1t's own chat today,
 * another chat app the workspace connected later (docs/WORKSPACE.md,
 * "Working from another chat app"). Only g1t's adapter exists.
 */
import type { AgentDelivery, ChatMessage, ServiceBinding } from "@g1t/contracts";

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

export interface Surface {
  /** The latest `limit` messages of the conversation (the thread, or the DM or channel), oldest first. */
  history(limit: number): Promise<SurfaceMessage[]>;
  /** Shows the agent typing. Never throws: it is a courtesy. */
  typing(): Promise<void>;
  /** Posts as the agent, in the conversation it was asked in. Returns the new message's id. */
  post(body: string): Promise<string>;
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
 * were asked in, and carry the delivery's hops, `asked_by` and `asker` on,
 * so an agent the reply @mentions is woken one hop further along the same
 * person's request, with that person's access.
 */
export function g1tSurface(chat: ServiceBinding, delivery: AgentDelivery): Surface {
  const client = chatClient(chat);
  const { workspace, channel_id: channel, agent_id: agent } = delivery;
  return {
    async history(limit) {
      const page = await client.historyForAgent(workspace, channel, agent, { thread_root: delivery.thread_root, limit });
      if (!page.ok) throw new Error(`reading the conversation failed: ${page.error.message}`);
      return page.value.filter((message) => !message.deleted_at).map(fromChat);
    },
    async typing() {
      await client.agentTyping(workspace, channel, agent).catch(() => undefined);
    },
    async post(body) {
      const posted = await client.postAsAgent(workspace, channel, agent, {
        body,
        thread_root: delivery.thread_root,
        hops: Math.min(delivery.hops, CHAT_MAX_HOPS),
        asked_by: delivery.asked_by,
        // Agents this reply wakes act for the same person, with their access.
        asker: delivery.asker ?? null,
      });
      if (!posted.ok) throw new Error(`posting the reply failed: ${posted.error.message}`);
      return posted.value.id;
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
