/**
 * Cards in chat: how a card's state reads, which of its actions show (its
 * links), and when its preview folds. Pure, so it is tested on its own;
 * components/chat/card.tsx draws them.
 */
import type { CardAction, MessageCard } from "@g1t/contracts";

import type { SessionChip } from "./session-card";

/** A card's state chip, as a session's is, outlined only when it is waiting quietly. */
export type CardChip = { tone: SessionChip["tone"] | "merged"; live: boolean; outline?: boolean };

const DRAFT_CHIPS: Record<string, CardChip> = {
  // Waiting on someone to file it: lavender, outlined only.
  draft: { tone: "accent", live: false, outline: true },
  filed: { tone: "success", live: false },
  discarded: { tone: "neutral", live: false },
};

/**
 * How a draft work item's state reads; null for other kinds (a session's chip
 * is lib/session-card.ts's, others are guessed from their words).
 */
export function cardChip(card: Pick<MessageCard, "kind" | "state">): CardChip | null {
  if (!card.state) return null;
  if (card.kind === "draft_work_item") return DRAFT_CHIPS[card.state.trim().toLowerCase()] ?? { tone: "neutral", live: false };
  return null;
}

/**
 * The actions a card shows: its links. The service that answered the
 * others (agents) is gone, so an old card's buttons that ran something are
 * left out; the card stays to read.
 */
export function shownActions(card: Pick<MessageCard, "actions">): CardAction[] {
  return (card.actions ?? []).filter((a) => !!a.href);
}

/** Whether a body is long enough that its preview starts folded (over about eight lines). */
export function foldsBody(body: string, lines = 8): boolean {
  const rows = body.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 80)), 0);
  return rows > lines;
}
