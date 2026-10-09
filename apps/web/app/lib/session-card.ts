/**
 * An agent session's live card in chat (`card.kind === "session"`): the
 * agent posts it when the session starts and changes it in place as the
 * session moves (`message.updated`), so its state chip is always current.
 */

/** The states an agent session's card shows. */
export const SESSION_STATES = ["Queued", "Working", "Waiting on helpers", "Needs approval", "Done", "Stopped", "Failed"] as const;

export type SessionState = (typeof SESSION_STATES)[number];

/** How a state reads: its badge tone, and whether it is happening now (a soft pulse). */
export type SessionChip = { tone: "neutral" | "accent" | "info" | "warn" | "success" | "danger"; live: boolean };

const CHIPS: Record<string, SessionChip> = {
  queued: { tone: "neutral", live: false },
  working: { tone: "accent", live: true },
  "waiting on helpers": { tone: "info", live: true },
  "needs approval": { tone: "warn", live: false },
  done: { tone: "success", live: false },
  stopped: { tone: "neutral", live: false },
  failed: { tone: "danger", live: false },
};

/** A session card's state chip; a state it does not know reads quietly. */
export function sessionChip(state: string | null | undefined): SessionChip {
  return CHIPS[String(state ?? "").trim().toLowerCase()] ?? { tone: "neutral", live: false };
}
