/**
 * A session's card in chat (`card.kind === "session"`). On old messages,
 * g1t's agents posted it and kept it current; agents no longer exist, so
 * those are read-only, their state where it was left, and nothing pulses.
 * g1t's card for a hosted session started from a conversation with it
 * (chat's `g1t_session`) asks how its session stands instead
 * (lib/use-session-follow.ts `useHostedSessionState`), and pulses while it works.
 */

/** The states an agent session's card shows. */
export const SESSION_STATES = ["Queued", "Working", "Waiting on helpers", "Needs approval", "Done", "Stopped", "Failed"] as const;

export type SessionState = (typeof SESSION_STATES)[number];

/** How a state reads: its badge tone, and whether it is happening now (a soft pulse: never, now). */
export type SessionChip = { tone: "neutral" | "accent" | "info" | "warn" | "success" | "danger"; live: boolean };

const CHIPS: Record<string, SessionChip> = {
  queued: { tone: "neutral", live: false },
  working: { tone: "accent", live: false },
  "waiting on helpers": { tone: "info", live: false },
  "needs approval": { tone: "warn", live: false },
  done: { tone: "success", live: false },
  stopped: { tone: "neutral", live: false },
  failed: { tone: "danger", live: false },
};

/** A session card's state chip; a state it does not know reads quietly. */
export function sessionChip(state: string | null | undefined): SessionChip {
  return (
    CHIPS[
      String(state ?? "")
        .trim()
        .toLowerCase()
    ] ?? { tone: "neutral", live: false }
  );
}
