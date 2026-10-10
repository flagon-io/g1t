/**
 * When chat makes a sound, apart from the browser: which cue a message or
 * a notification earns, given who you are, what you are looking at, what
 * you muted and whether you are not to be disturbed; and how close
 * together two sounds may come. Pure, so every rule is tested on its own
 * (chat-sounds.test.ts); lib/sound-events.ts runs it on each event with
 * the page's real state, and lib/sounds.ts plays the result.
 *
 * The rules, as the chat guide says them ("Sounds and do not disturb"):
 *
 * - `mention` for a message that @mentions you, `direct` for a direct
 *   message, `message` for a message in a conversation you have open while
 *   the window is not in front or you are in another conversation, and
 *   `agent_done` when an agent posts a card saying it finished something.
 * - Never for your own messages, never in a muted conversation, never
 *   while Do not disturb is on, and never for the conversation you are
 *   looking at in a window that is in front: what is on screen is silent.
 * - Agents' messages count like people's.
 * - At most one sound every 1.5 seconds, and never twice for one message,
 *   however many ways it arrives (its conversation's socket and your feed).
 */
import type { ChatMessage, FeedNotification } from "@g1t/contracts";
import { type SoundCue, type SoundSettings, cueOn } from "@g1t/contracts/sounds";

/** What the tab can see of itself: shown, in front, and which conversation it has open. */
export type FocusState = {
  /** `document.visibilityState === "visible"`. */
  visible: boolean;
  /** `document.hasFocus()`: the window is in front and this tab has the keyboard. */
  focused: boolean;
  /** The conversation on screen, by channel id; null on any other page. */
  viewingChannel: string | null;
};

export type SoundContext = {
  me: { id: string; username: string } | null;
  focus: FocusState;
  /** Conversations muted in the sidebar, by channel id. */
  muted: ReadonlySet<string>;
  /** Do not disturb holds (the person's presence, `dnd_until`). */
  dnd: boolean;
  settings: SoundSettings;
};

/**
 * Something that arrived: a message over the open conversation's socket,
 * or a notification over the feed (which only carries what is for you: a
 * DM, a mention, a reply in your thread, an agent waiting on you).
 */
export type Arrival =
  | { source: "chat"; message: ChatMessage; channelKind: "channel" | "dm" }
  | { source: "feed"; notification: FeedNotification };

/** No two sounds closer than this: a burst of messages is one sound. */
export const SOUND_GAP_MS = 1_500;
/** The same message is not sounded again within this, whichever way it arrives. */
export const SAME_MESSAGE_MS = 10_000;

/** `@you` in a message's text: whole handles only, so `@you-and-me` is not you, and not inside code. */
export function mentionsMe(body: string, username: string): boolean {
  const name = username.trim().toLowerCase();
  if (!name) return false;
  const outsideCode = String(body ?? "").replace(/```[\s\S]*?(```|$)/g, " ").replace(/`[^`\n]*`/g, " ");
  const pattern = new RegExp(`(^|[^a-z0-9_.@-])@${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9_/-])`, "i");
  return pattern.test(outsideCode);
}

/** States a card shows when the agent's work is done, as agents' cards word them. */
const FINISHED = /^(done|finished|complete|completed|filed|merged|shipped|ready|passed)\b/i;

/** Whether a message is an agent's card saying it finished something. */
export function finishedCard(message: Pick<ChatMessage, "kind" | "author" | "card">): boolean {
  if (message.kind !== "card" || message.author.kind !== "agent" || !message.card) return false;
  return FINISHED.test(message.card.state ?? "") || FINISHED.test(message.card.detail ?? "");
}

/** What a feed notification's kind sounds like; null for what has no sound (inbox items have the bell). */
export function cueForNotificationKind(kind: FeedNotification["kind"]): SoundCue | null {
  switch (kind) {
    case "dm":
      return "direct";
    case "mention":
    case "approval":
      return "mention";
    case "thread_reply":
      return "message";
    case "agent_waiting":
      return "agent_done";
    default:
      return null;
  }
}

/** The conversation an arrival is in, by channel id; null for an inbox notification. */
export function channelOf(arrival: Arrival): string | null {
  return arrival.source === "chat" ? arrival.message.channel_id : (arrival.notification.channel_id ?? null);
}

/** Whether `me` wrote it. */
function mine(arrival: Arrival, me: SoundContext["me"]): boolean {
  if (!me) return false;
  const who = arrival.source === "chat" ? arrival.message.author : arrival.notification.actor;
  return who.kind === "user" && who.id === me.id;
}

/** Whether the person is looking at the conversation right now: on screen, in a window in front. */
export function lookingAt(channelId: string | null, focus: FocusState): boolean {
  return channelId !== null && focus.visible && focus.focused && focus.viewingChannel === channelId;
}

/** The cue an arrival earns, or null for silence. Every rule above, in order. */
export function cueFor(arrival: Arrival, ctx: SoundContext): SoundCue | null {
  if (!ctx.settings.sounds_enabled || ctx.dnd) return null;
  if (mine(arrival, ctx.me)) return null;
  const channel = channelOf(arrival);
  if (channel && ctx.muted.has(channel)) return null;
  if (lookingAt(channel, ctx.focus)) return null;
  let cue: SoundCue | null;
  if (arrival.source === "chat") {
    const { message } = arrival;
    if (message.deleted_at) return null;
    if (finishedCard(message)) cue = "agent_done";
    else if (ctx.me && mentionsMe(message.body, ctx.me.username)) cue = "mention";
    else cue = arrival.channelKind === "dm" ? "direct" : "message";
  } else {
    cue = cueForNotificationKind(arrival.notification.kind);
  }
  return cue && cueOn(ctx.settings, cue) ? cue : null;
}

/** What identifies an arrival, so the same message sounds once: its message id. */
export function arrivalKey(arrival: Arrival): string {
  return arrival.source === "chat" ? `msg:${arrival.message.id}` : `msg:${arrival.notification.id}`;
}

/**
 * Keeps sounds apart: one every `SOUND_GAP_MS` at most, and the same key
 * (a message id) once in `SAME_MESSAGE_MS`. `allow` says whether to play
 * now, and remembers it if so.
 */
export class SoundGate {
  private lastAt = Number.NEGATIVE_INFINITY;
  private readonly seen = new Map<string, number>();
  private readonly gapMs: number;
  private readonly sameMs: number;

  constructor(gapMs = SOUND_GAP_MS, sameMs = SAME_MESSAGE_MS) {
    this.gapMs = gapMs;
    this.sameMs = sameMs;
  }

  allow(key: string | null, now: number): boolean {
    for (const [k, at] of this.seen) if (now - at > this.sameMs) this.seen.delete(k);
    if (key !== null && this.seen.has(key)) return false;
    if (key !== null) this.seen.set(key, now);
    if (now - this.lastAt < this.gapMs) return false;
    this.lastAt = now;
    return true;
  }
}

/**
 * Whether an open tab shows a system notification for a feed notification:
 * the person turned desktop notifications on and the browser allows them,
 * the window is not in front, it is something for them that the feed would
 * toast, and this browser does not already get pushes (which show the same
 * notification once no tab is in front).
 */
export function wantsDesktopToast(input: {
  notification: Pick<FeedNotification, "kind">;
  toast: boolean;
  ctx: Pick<SoundContext, "focus" | "dnd" | "settings">;
  permission: "default" | "granted" | "denied";
  /** This browser is subscribed to pushes (`pushChoice() === "on"`). */
  pushOn: boolean;
}): boolean {
  const { ctx } = input;
  if (!ctx.settings.desktop_toasts || input.permission !== "granted" || input.pushOn) return false;
  if (ctx.dnd || !input.toast) return false;
  if (ctx.focus.visible && ctx.focus.focused) return false;
  return cueForNotificationKind(input.notification.kind) !== null;
}
