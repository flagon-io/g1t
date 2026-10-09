/**
 * Presence and status in the browser, apart from the browser: the status
 * presets, what "clear after" and "pause notifications" mean as times, how
 * a person shows (dot and words), and when a tab counts as idle. Pure, so
 * it is tested on its own; the store and the socket are in
 * lib/notify-client.ts, the menus in components/presence.tsx.
 *
 * Times are the viewer's own: "today" ends at their midnight, "until
 * tomorrow" is their 9 in the morning. The feed only keeps the instant.
 */
import type { PersonStatus, Presence, PresenceEntry } from "@g1t/contracts";

/** A tab with no input for this long is idle; when every tab is, the person shows away. */
export const IDLE_MS = 10 * 60_000;

export type ClearAfter = "30m" | "1h" | "4h" | "today" | "week" | "never" | "custom";

export const CLEAR_AFTER: { key: ClearAfter; label: string }[] = [
  { key: "30m", label: "30 minutes" },
  { key: "1h", label: "1 hour" },
  { key: "4h", label: "4 hours" },
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "never", label: "Don't clear" },
  { key: "custom", label: "Choose a time…" },
];

export type StatusPreset = { emoji: string; text: string; clear: ClearAfter };

/** The statuses offered first: one click each. */
export const STATUS_PRESETS: StatusPreset[] = [
  { emoji: "🗓️", text: "In a meeting", clear: "1h" },
  { emoji: "🚌", text: "Commuting", clear: "30m" },
  { emoji: "🎯", text: "Focusing", clear: "1h" },
  { emoji: "🤒", text: "Out sick", clear: "today" },
  { emoji: "🌴", text: "On vacation", clear: "never" },
];

export type PauseFor = "30m" | "1h" | "tomorrow";

export const PAUSE_FOR: { key: PauseFor; label: string }[] = [
  { key: "30m", label: "For 30 minutes" },
  { key: "1h", label: "For 1 hour" },
  { key: "tomorrow", label: "Until tomorrow" },
];

const MINUTE = 60_000;

/** The next midnight after `now`, the viewer's. */
function nextMidnight(now: Date): Date {
  const at = new Date(now);
  at.setHours(24, 0, 0, 0);
  return at;
}

/**
 * When a status set now clears, as an instant; null keeps it until
 * changed. `custom` is a `datetime-local` value, in the viewer's time.
 */
export function clearAtFor(choice: ClearAfter, now: Date, custom?: string | null): string | null {
  switch (choice) {
    case "30m":
      return new Date(now.getTime() + 30 * MINUTE).toISOString();
    case "1h":
      return new Date(now.getTime() + 60 * MINUTE).toISOString();
    case "4h":
      return new Date(now.getTime() + 240 * MINUTE).toISOString();
    case "today":
      return nextMidnight(now).toISOString();
    case "week": {
      // The end of Sunday: the coming Monday's midnight.
      const at = nextMidnight(now);
      while (at.getDay() !== 1) at.setDate(at.getDate() + 1);
      return at.toISOString();
    }
    case "never":
      return null;
    case "custom": {
      const at = custom ? new Date(custom) : null;
      return at && Number.isFinite(at.getTime()) && at.getTime() > now.getTime() ? at.toISOString() : null;
    }
  }
}

/** When notifications resume: in half an hour, an hour, or at nine tomorrow morning. */
export function pauseUntil(choice: PauseFor, now: Date): string {
  if (choice === "30m") return new Date(now.getTime() + 30 * MINUTE).toISOString();
  if (choice === "1h") return new Date(now.getTime() + 60 * MINUTE).toISOString();
  const at = nextMidnight(now);
  at.setHours(9, 0, 0, 0);
  return at.toISOString();
}

/** Whether an instant is still ahead. */
function ahead(value: string | null | undefined, now: number): boolean {
  if (!value) return false;
  const at = Date.parse(value);
  return Number.isFinite(at) && at > now;
}

/** A status as it stands now: gone once its time has passed, even before the feed says so. */
export function liveStatus(status: PersonStatus | null | undefined, now: number): PersonStatus | null {
  if (!status) return null;
  return status.clear_at && !ahead(status.clear_at, now) ? null : status;
}

export function dndOn(entry: Pick<PresenceEntry, "dnd_until"> | null | undefined, now: number): boolean {
  return ahead(entry?.dnd_until, now);
}

/** What a person's dot shows. */
export type Shown = "active" | "away" | "dnd" | "offline";

export function shownAs(entry: Pick<PresenceEntry, "presence" | "dnd_until"> | null | undefined, now: number): Shown {
  if (!entry || entry.presence === "offline") return "offline";
  if (dndOn(entry, now)) return "dnd";
  return entry.presence;
}

export const SHOWN_LABEL: Record<Shown, string> = {
  active: "Active",
  away: "Away",
  dnd: "Notifications paused",
  offline: "Offline",
};

export function presenceLabel(presence: Presence): string {
  return SHOWN_LABEL[presence];
}

/**
 * "until 3:30 PM", "until tomorrow 9:00 AM", "until Mon 9:00 AM" or
 * "until 12 Oct": short words for when something ends, the viewer's time.
 */
export function untilLabel(value: string, now: Date, locale?: string): string {
  const at = new Date(value);
  if (!Number.isFinite(at.getTime())) return "";
  const clock = at.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(at) - day(now)) / (24 * 3600 * 1000));
  // Midnight is the end of the day before: "until tomorrow" reads better as "today".
  const midnight = at.getHours() === 0 && at.getMinutes() === 0;
  if (days === 0) return `until ${clock}`;
  if (days === 1 && midnight) return "until the end of today";
  if (days === 1) return `until tomorrow ${clock}`;
  if (days <= 7 && midnight) return `until the end of ${new Date(at.getTime() - 1).toLocaleDateString(locale, { weekday: "long" })}`;
  if (days < 7) return `until ${at.toLocaleDateString(locale, { weekday: "short" })} ${clock}`;
  return `until ${at.toLocaleDateString(locale, { day: "numeric", month: "short" })}`;
}

/** A status in words, for screen readers and hints: "🗓️ In a meeting, until 3:30 PM". */
export function statusWords(status: PersonStatus, now: Date, locale?: string): string {
  const text = [status.emoji, status.text].filter(Boolean).join(" ");
  return status.clear_at ? `${text}, ${untilLabel(status.clear_at, now, locale)}` : text;
}

/** Whether a tab is idle: no input for `IDLE_MS`. */
export function isIdle(lastInput: number, now: number): boolean {
  return now - lastInput >= IDLE_MS;
}

/** A custom emoji's `:name:`, or null for an ordinary emoji. */
export function customEmojiName(emoji: string | null | undefined): string | null {
  const match = emoji ? /^:([a-z0-9_+-]{1,64}):$/.exec(emoji) : null;
  return match ? match[1]! : null;
}

/** A `datetime-local` value for an instant, in the viewer's time: what the custom time field starts at. */
export function localInputValue(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * People by id and by username (lowercased), after a word from the feed:
 * all of a workspace (`full`), or some who changed. A later word wins.
 */
export function mergePeople(
  people: Record<string, PresenceEntry>,
  incoming: PresenceEntry[],
  full: boolean,
): Record<string, PresenceEntry> {
  const next: Record<string, PresenceEntry> = { ...people };
  let changed = false;
  for (const entry of incoming) {
    if (!entry?.user_id) continue;
    const before = next[entry.user_id];
    if (before && before.at > entry.at) continue;
    next[entry.user_id] = entry;
    changed = true;
  }
  return changed || full ? next : people;
}
