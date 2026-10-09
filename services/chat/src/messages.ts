/**
 * What a message may hold and how pages of them are read. Pure, so it is
 * tested apart from the service.
 */

/** The longest message body, in characters. */
export const MAX_BODY = 40_000;

/** Messages on one page when none is asked for, and the most on one page. */
export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 200;

/** How long "is typing" shows after a person's keystroke and while an agent works. */
export const PERSON_TYPING_MS = 5_000;
export const AGENT_TYPING_MS = 8_000;

/** A body as kept, or why it cannot be: something to say, and not too much. */
export function messageBody(body: unknown, hasCard = false): { ok: true; body: string } | { ok: false; message: string } {
  const text = typeof body === "string" ? body.replace(/\s+$/, "") : "";
  if (!text.trim() && !hasCard) return { ok: false, message: "A message needs something in it." };
  if (text.length > MAX_BODY) return { ok: false, message: `A message is at most ${MAX_BODY.toLocaleString("en-US")} characters.` };
  return { ok: true, body: text };
}

/** How many messages a page holds: the default, or what was asked within 1 to the most. */
export function pageSize(limit: unknown): number {
  const n = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_PAGE;
  return Math.min(MAX_PAGE, Math.max(1, n));
}

/**
 * A page read one past its size, newest first: the page, and the cursor
 * for the next one back (its oldest id), or null when this is the start.
 */
export function pageOf<T extends { id: string }>(rows: T[], size: number): { rows: T[]; older: string | null } {
  if (rows.length <= size) return { rows, older: null };
  const page = rows.slice(0, size);
  return { rows: page, older: page[page.length - 1].id };
}

/** Messages an agent reads before replying when none is asked for, and the most. */
export const DEFAULT_HISTORY = 30;
export const MAX_HISTORY = 100;

/** How many messages an agent's history holds: the default, or what was asked within 1 to the most. */
export function historySize(limit: unknown): number {
  const n = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_HISTORY;
  return Math.min(MAX_HISTORY, Math.max(1, n));
}

/**
 * An agent's history, oldest first, from rows read newest first: a
 * thread's root (when there is one) leads, then the rest in order.
 */
export function historyOf<T extends { id: string }>(newestFirst: T[], root: T | null = null): T[] {
  const rest = [...newestFirst].reverse().filter((row) => row.id !== root?.id);
  return root ? [root, ...rest] : rest;
}

/**
 * Whether a frame from a client's socket says it is typing in `channelId`:
 * `{"type":"typing"}`, optionally naming the channel. A frame naming
 * another channel is ignored.
 */
export function isTypingFrame(frame: unknown, channelId: string): boolean {
  if (typeof frame !== "string" || frame.length > 1024) return false;
  let said: unknown;
  try {
    said = JSON.parse(frame);
  } catch {
    return false;
  }
  if (!said || typeof said !== "object") return false;
  const { type, channel_id } = said as { type?: unknown; channel_id?: unknown };
  return type === "typing" && (channel_id === undefined || channel_id === null || channel_id === channelId);
}

/** The UTC day a time falls on, as the meter keys it. */
export function meterDay(iso: string): string {
  return iso.slice(0, 10);
}
