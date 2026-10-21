/**
 * When messages shown outside their conversation count as read: g1t's
 * answer on Home's Summarize card, or any other
 * page that shows a conversation's messages. Pure rules, and the record of
 * which conversations this page shows right now, so a toast, a sound or a
 * system notification does not repeat what is on screen (lib/notify-client,
 * lib/sound-events). The hook that uses them is lib/use-read-when-shown.ts.
 */

/** What a surface knows when it might mark its conversation read. */
export type ReadMoment = {
  /** `document.visibilityState === "visible"`. */
  visible: boolean;
  /** The messages are on screen: the panel open, the card scrolled into view. */
  onScreen: boolean;
  /** The newest message shown and finished, or null while there is none. */
  newestId: string | null;
  /** The newest this surface has already marked read. */
  lastRead: string | null;
};

/**
 * The message to mark read now, or null: only while the page is visible
 * and the messages are on screen, each newest id once, and only forward
 * (ids sort by time).
 */
export function readNow(moment: ReadMoment): string | null {
  if (!moment.visible || !moment.onScreen || !moment.newestId) return null;
  if (moment.lastRead !== null && moment.newestId <= moment.lastRead) return null;
  return moment.newestId;
}

// ── Conversations shown on this page ─────────────────────────────────────

const shown = new Map<string, number>();

/** This page shows `channelId`'s messages until the returned function is called. Counted: two surfaces may show the same one. */
export function showConversation(channelId: string): () => void {
  shown.set(channelId, (shown.get(channelId) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const left = (shown.get(channelId) ?? 1) - 1;
    if (left > 0) shown.set(channelId, left);
    else shown.delete(channelId);
  };
}

/** The conversations this page shows right now, besides the one open in Chat. */
export function shownConversations(): ReadonlySet<string> {
  return new Set(shown.keys());
}
