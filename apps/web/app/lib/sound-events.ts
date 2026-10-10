/**
 * Where chat's events meet the sound rules: a message over the open
 * conversation's socket (components/chat/channel.tsx) or a notification
 * over the feed (lib/notify-client.ts) comes here with what the page knows
 * of itself, lib/chat-sounds.ts decides, and lib/sounds.ts plays. One gate
 * keeps sounds apart. Browser-only; the rules it runs are tested in
 * chat-sounds.test.ts.
 *
 * It also shows the system notification (the browser's Notifications API)
 * a person asked for under Desktop notifications: for a message to them
 * while the window is not in front, from the open tab itself, with no
 * service worker and no push involved.
 */
import type { ChatMessage, FeedNotification } from "@g1t/contracts";
import { type SoundCue, cueOn } from "@g1t/contracts/sounds";

import { type Arrival, type FocusState, SoundGate, arrivalKey, cueFor, wantsDesktopToast } from "./chat-sounds";
import { play, soundSettings } from "./sounds";

let me: { id: string; username: string } | null = null;
let viewing: string | null = null;
let muted: ReadonlySet<string> = new Set();
const gate = new SoundGate();

/** Who is signed in, from the root with the page: their own messages never sound. */
export function setSoundViewer(viewer: { id: string; username: string } | null): void {
  me = viewer;
}

/** The conversation on screen, from its page: null when leaving it. */
export function viewingConversation(channelId: string | null): void {
  viewing = channelId;
}

export function viewingChannel(): string | null {
  return viewing;
}

/** The conversations muted in the sidebar, as it last read them. */
export function setMutedConversations(channelIds: Iterable<string>): void {
  muted = new Set(channelIds);
}

/** What the tab can see of itself right now. */
export function focusState(): FocusState {
  const has = typeof document !== "undefined";
  return {
    visible: has && document.visibilityState === "visible",
    focused: has && document.hasFocus(),
    viewingChannel: viewing,
  };
}

function sound(arrival: Arrival, dnd: boolean, mutedHere?: boolean): SoundCue | null {
  const all = mutedHere ? new Set([...muted, arrival.source === "chat" ? arrival.message.channel_id : (arrival.notification.channel_id ?? "")]) : muted;
  const cue = cueFor(arrival, { me, focus: focusState(), muted: all, dnd, settings: soundSettings() });
  // Heard of either way, so the same message over the other door stays quiet.
  const allowed = gate.allow(arrivalKey(arrival), Date.now());
  if (!cue || !allowed) return null;
  play(cue);
  return cue;
}

/**
 * A new message in the conversation open on this page. `muted` is that
 * conversation's own setting, which the sidebar may not have told us yet.
 * Returns what played, for the harness.
 */
export function chatMessageArrived(message: ChatMessage, channelKind: "channel" | "dm", options: { dnd: boolean; muted?: boolean }): SoundCue | null {
  return sound({ source: "chat", message, channelKind }, options.dnd, options.muted);
}

/**
 * A notification over the feed. `toast` is the feed's own decision about a
 * pop-up; the sound is decided here from the same facts. Shows the system
 * notification too, when wanted (`wantsDesktopToast`).
 */
export function notificationArrived(
  notification: FeedNotification,
  options: {
    toast: boolean;
    dnd: boolean;
    permission: "default" | "granted" | "denied";
    pushOn: boolean;
    open: (href: string) => void;
  },
): { cue: SoundCue | null; desktopToast: boolean } {
  const cue = sound({ source: "feed", notification }, options.dnd);
  const desktopToast = wantsDesktopToast({
    notification,
    toast: options.toast,
    ctx: { focus: focusState(), dnd: options.dnd, settings: soundSettings() },
    permission: options.permission,
    pushOn: options.pushOn,
  });
  if (desktopToast) showDesktopToast(notification, options.open);
  return { cue, desktopToast };
}

/** The soft tick as you send, if turned on (it is off until then), and never while not to be disturbed. */
export function messageSent(options: { dnd: boolean }): void {
  const settings = soundSettings();
  if (!settings.sounds_enabled || options.dnd || !cueOn(settings, "sent")) return;
  play("sent");
}

/**
 * The browser's own notification, from this tab: it closes itself after a
 * while, a newer one about the same conversation replaces it (`tag`), and a
 * click brings the window forward and opens the conversation. Never asks
 * for permission: that is the settings page's button alone.
 */
export function showDesktopToast(notification: FeedNotification, open: (href: string) => void): void {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const shown = new Notification(notification.title, {
      body: notification.body,
      tag: notification.channel_id ? `chat:${notification.channel_id}` : `${notification.kind}:${notification.id}`,
      icon: "/icon-192.png",
      silent: true,
    });
    shown.onclick = () => {
      try {
        window.focus();
      } catch {
        // Some browsers refuse; the page still moves.
      }
      open(notification.href);
      shown.close();
    };
    setTimeout(() => shown.close(), 8_000);
  } catch {
    // A browser that has the API but not here (an iframe, say): nothing shown.
  }
}

/** Test seam: the gate forgets everything, so a harness can play cue after cue. */
export function resetSoundGateForTest(): void {
  (gate as unknown as { lastAt: number; seen: Map<string, number> }).lastAt = Number.NEGATIVE_INFINITY;
  (gate as unknown as { seen: Map<string, number> }).seen.clear();
}
