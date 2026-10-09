/**
 * Cards people can act on in chat (docs/WORKSPACE.md, "Cards"): how a
 * card's state reads, which of its actions are links and which run, and
 * the money and text people type into them. Pure, so it is tested on its
 * own; components/chat/card.tsx draws them.
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
 * How a draft issue's state reads; null for other kinds (a session's chip
 * is lib/session-card.ts's, others are guessed from their words).
 */
export function cardChip(card: Pick<MessageCard, "kind" | "state">): CardChip | null {
  if (!card.state) return null;
  if (card.kind === "draft_issue") return DRAFT_CHIPS[card.state.trim().toLowerCase()] ?? { tone: "neutral", live: false };
  return null;
}

/** What pressing an action does: opens a place, asks first, asks for a value first, or just runs. */
export type ActionMode = "link" | "confirm" | "input" | "run";

export function actionMode(action: CardAction): ActionMode {
  if (action.href) return "link";
  if (action.input) return "input";
  if (action.confirm) return "confirm";
  return "run";
}

/**
 * The actions a card shows: links always; the rest only when the card has
 * an owner to answer them (chat drops them otherwise, this is the same rule
 * for a card that never went through it).
 */
export function shownActions(card: Pick<MessageCard, "actions" | "owner">): CardAction[] {
  return (card.actions ?? []).filter((a) => !!a.href || !!card.owner);
}

/** Dollars as people type them ("5", "$12.5", "1,200") as "12.50", or null when it is not an amount. */
export function moneyValue(input: string | null | undefined): string | null {
  const text = String(input ?? "")
    .trim()
    .replace(/^\$\s*/, "")
    .replace(/,/g, "");
  if (!/^\d+(\.\d{0,2})?$|^\.\d{1,2}$/.test(text)) return null;
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount.toFixed(2);
}

/** What a money field starts with: the suggestion as an amount, or empty. */
export function moneyInitial(initial: string | null | undefined): string {
  return moneyValue(initial) ?? "";
}

/** What is typed into a text action, trimmed, or null when there is nothing. */
export function textValue(input: string | null | undefined): string | null {
  const text = String(input ?? "").trim();
  return text ? text : null;
}

/** The value an input action sends, or null when it is not ready to send. */
export function inputValue(action: CardAction, typed: string): string | null {
  if (!action.input) return null;
  return action.input.kind === "money" ? moneyValue(typed) : textValue(typed);
}

/** Whether a body is long enough that its preview starts folded (over about eight lines). */
export function foldsBody(body: string, lines = 8): boolean {
  const rows = body.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 80)), 0);
  return rows > lines;
}
