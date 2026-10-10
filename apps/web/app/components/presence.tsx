/**
 * People's presence and status, wherever a person shows: the dot on their
 * avatar (active, away, notifications paused), the emoji after their name,
 * and, for yourself, the menu and dialog that set them. Live from the feed
 * socket (lib/notify-client.ts); the rules are in lib/presence.ts.
 *
 * Agents keep their own dots (idle, working, out of budget: chat/marks.tsx);
 * nothing here draws one for an agent.
 */
import { BellOff, BellRing, Moon, Smile, Sun, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import type { PersonStatus, PresenceEntry } from "@g1t/contracts";

import { EmojiGlyph } from "./emoji/render";
import { EmojiPickerPopover } from "./emoji/picker";
import { useEmojiContext } from "./emoji/context";

import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "./ui/dropdown-menu";
import { Hint } from "./ui/hint";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { cn } from "../lib/cn";
import { setPresence, useOwnPresence, usePresenceOf } from "../lib/notify-client";
import {
  CLEAR_AFTER,
  type ClearAfter,
  PAUSE_FOR,
  SHOWN_LABEL,
  STATUS_PRESETS,
  type Shown,
  clearAtFor,
  dndOn,
  liveStatus,
  localInputValue,
  pauseUntil,
  shownAs,
  statusWords,
  untilLabel,
} from "../lib/presence";

/** Re-renders every half minute, so a status or a pause past its time goes without a word from the feed. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const DOT: Record<Exclude<Shown, "offline">, string> = {
  active: "bg-success",
  // Away: a ring, the dot's colour gone out of it.
  away: "bg-[var(--presence-ring,var(--color-bg))] shadow-[inset_0_0_0_2px_var(--color-faint)]",
  // Paused: amber, with a bar across, as a "do not enter" sign.
  dnd: "bg-warn",
};

/**
 * The dot itself. `ring` is the colour behind it, so it sits cut out of
 * the avatar's corner; nothing shows for someone offline, or not known.
 */
export function PresenceDot({ entry, size = 10, ring = "var(--color-bg)", className }: { entry: PresenceEntry | null; size?: number; ring?: string; className?: string }) {
  const now = useMinute();
  const shown = shownAs(entry, now);
  if (shown === "offline") return null;
  return (
    <span
      className={cn("pointer-events-none flex items-center justify-center rounded-full", DOT[shown], className)}
      style={{ width: size, height: size, boxShadow: `0 0 0 2px ${ring}`, ["--presence-ring" as string]: ring }}
    >
      {shown === "dnd" && <span className="h-[2px] w-1/2 rounded-full bg-bg" aria-hidden="true" />}
      <span className="sr-only">{SHOWN_LABEL[shown]}</span>
    </span>
  );
}

/**
 * An avatar with the person's dot in its corner. `person` names them by
 * id or username; agents and anyone unknown get the avatar alone.
 */
export function WithPresence({
  person,
  size,
  ring,
  children,
  className,
}: {
  person: { id?: string | null; username?: string | null } | null;
  /** The avatar's size: the dot is a third of it, within limits. */
  size: number;
  ring?: string;
  children: ReactNode;
  className?: string;
}) {
  const entry = usePresenceOf(person);
  const dot = Math.max(8, Math.min(14, Math.round(size * 0.34)));
  return (
    <span className={cn("relative inline-flex shrink-0", className)}>
      {children}
      <PresenceDot entry={entry} size={dot} ring={ring} className="absolute -right-0.5 -bottom-0.5" />
    </span>
  );
}

/**
 * A status's emoji after a name, its words in a hint. `inert` inside a link
 * or a button: no hint and no focus of its own, the words for screen
 * readers only.
 */
export function StatusEmoji({ status, size = 14, className, inert = false }: { status: PersonStatus | null | undefined; size?: number; className?: string; inert?: boolean }) {
  const now = useMinute();
  const { byName, usercontent } = useEmojiContext();
  const live = liveStatus(status, now);
  if (!live) return null;
  const words = statusWords(live, new Date(now));
  const glyph = live.emoji ? (
    <EmojiGlyph emoji={live.emoji} byName={byName} usercontent={usercontent} size={size} />
  ) : (
    <Smile size={size} className="text-faint" aria-hidden="true" />
  );
  if (inert) {
    return (
      <span className={cn("inline-flex shrink-0 items-center", className)}>
        <span aria-hidden="true" className="inline-flex">
          {glyph}
        </span>
        <span className="sr-only">, {words}</span>
      </span>
    );
  }
  return (
    <Hint label={words}>
      <span className={cn("inline-flex shrink-0 items-center", className)} tabIndex={0} aria-label={`Status: ${words}`}>
        {glyph}
      </span>
    </Hint>
  );
}

/** A person's status emoji, live, by id or username. */
export function PersonStatusEmoji({
  person,
  size,
  className,
  inert,
}: {
  person: { id?: string | null; username?: string | null };
  size?: number;
  className?: string;
  inert?: boolean;
}) {
  const entry = usePresenceOf(person);
  return <StatusEmoji status={entry?.status} size={size} className={className} inert={inert} />;
}

/**
 * One short line: their status ("🗓️ In a meeting") or, without one, how
 * they show ("Active", "Away", "Notifications paused"). Nothing while it
 * is not known, or when they are offline with nothing to say.
 */
export function PersonStatusLine({ person, className }: { person: { id?: string | null; username?: string | null }; className?: string }) {
  const entry = usePresenceOf(person);
  const now = useMinute();
  const { byName, usercontent } = useEmojiContext();
  if (!entry) return null;
  const status = liveStatus(entry.status, now);
  const shown = shownAs(entry, now);
  if (!status && shown === "offline") return null;
  return (
    <p className={cn("flex min-w-0 items-center gap-1.5", className)}>
      {status ? (
        <>
          {status.emoji && <EmojiGlyph emoji={status.emoji} byName={byName} usercontent={usercontent} size={12} />}
          <span className="truncate">{status.text || SHOWN_LABEL[shown]}</span>
        </>
      ) : (
        <span className="truncate">{SHOWN_LABEL[shown]}</span>
      )}
    </p>
  );
}

/**
 * A person's presence and status in a line or two, for their card:
 * "Active", "Away", "Notifications paused until 3:00 PM", and "🗓️ In a
 * meeting, until 3:30 PM".
 */
export function PresenceSummary({ person, className }: { person: { id?: string | null; username?: string | null }; className?: string }) {
  const entry = usePresenceOf(person);
  const now = useMinute();
  const { byName, usercontent } = useEmojiContext();
  if (!entry) return null;
  const shown = shownAs(entry, now);
  const status = liveStatus(entry.status, now);
  return (
    <div className={cn("space-y-1.5", className)}>
      {status && (
        <p className="flex items-center gap-2 text-fg-soft">
          {status.emoji ? <EmojiGlyph emoji={status.emoji} byName={byName} usercontent={usercontent} size={14} /> : <Smile size={13} className="text-faint" />}
          <span className="min-w-0 truncate">
            {status.text}
            {status.clear_at && <span className="text-faint"> · {untilLabel(status.clear_at, new Date(now))}</span>}
          </span>
        </p>
      )}
      <p className="flex items-center gap-2">
        <span className="flex size-[13px] items-center justify-center">
          {shown === "offline" ? <span className="size-2 rounded-full shadow-[inset_0_0_0_1.5px_var(--color-line-strong)]" /> : <PresenceDot entry={entry} size={9} ring="transparent" />}
        </span>
        {SHOWN_LABEL[shown]}
        {shown === "dnd" && entry.dnd_until && <span className="text-faint">{untilLabel(entry.dnd_until, new Date(now))}</span>}
      </p>
    </div>
  );
}

// ── Your own ─────────────────────────────────────────────────────────────

/**
 * The account menu's part: your status (set, change or clear it), away by
 * hand, and pausing notifications. `onEdit` opens the status dialog, which
 * lives outside the menu so the menu can close.
 */
export function OwnPresenceItems({ onEdit, className }: { onEdit: () => void; className?: string }) {
  const me = useOwnPresence();
  const now = useMinute();
  const { byName, usercontent } = useEmojiContext();
  const status = liveStatus(me?.status, now);
  const paused = dndOn(me, now);
  const away = me?.away_manual === true;
  return (
    <>
      <DropdownMenuItem className={cn("gap-2.5 px-2.5", className)} onSelect={onEdit}>
        {status?.emoji ? (
          <span className="flex size-4 items-center justify-center">
            <EmojiGlyph emoji={status.emoji} byName={byName} usercontent={usercontent} size={15} />
          </span>
        ) : (
          <Smile />
        )}
        <span className="min-w-0 grow">
          <span className={cn("block truncate", status ? "text-fg" : "")}>{status ? status.text || "Status set" : "Set a status"}</span>
          {status?.clear_at && <span className="block truncate text-xs text-faint">{untilLabel(status.clear_at, new Date(now))}</span>}
        </span>
      </DropdownMenuItem>
      {status && (
        <DropdownMenuItem
          className={cn("gap-2.5 px-2.5", className)}
          onSelect={(event) => {
            event.preventDefault();
            void setPresence({ status: null }, { status: null });
          }}
        >
          <X />
          Clear status
        </DropdownMenuItem>
      )}
      <DropdownMenuItem
        className={cn("gap-2.5 px-2.5", className)}
        onSelect={(event) => {
          event.preventDefault();
          void setPresence({ away: !away }, { away_manual: !away, presence: away ? "active" : "away" });
        }}
      >
        {away ? <Sun /> : <Moon />}
        {away ? "Set yourself active" : "Set yourself away"}
      </DropdownMenuItem>
      {paused ? (
        <DropdownMenuItem
          className={cn("gap-2.5 px-2.5", className)}
          onSelect={(event) => {
            event.preventDefault();
            void setPresence({ dnd_until: null }, { dnd_until: null });
          }}
        >
          <BellRing />
          <span className="grow">Resume notifications</span>
          {me?.dnd_until && <span className="text-xs text-faint">{untilLabel(me.dnd_until, new Date(now)).replace(/^until /, "paused until ")}</span>}
        </DropdownMenuItem>
      ) : (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className={cn("gap-2.5 px-2.5", className)}>
            <BellOff />
            Pause notifications
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {PAUSE_FOR.map((choice) => (
              <DropdownMenuItem
                key={choice.key}
                onSelect={() => {
                  const until = pauseUntil(choice.key, new Date());
                  void setPresence({ dnd_until: until }, { dnd_until: until });
                }}
              >
                {choice.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <p className="max-w-52 px-2 py-1 text-xs leading-snug text-faint">Counts still move. Nothing toasts or pushes until then.</p>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )}
    </>
  );
}

/** The dot on your own avatar in the rail: how others see you. */
export function OwnPresenceDot({ ring, className }: { ring: string; className?: string }) {
  const me = useOwnPresence();
  // Until the feed says, you are here: you are looking at the page.
  const entry: PresenceEntry = me ?? { user_id: "", username: "", presence: "active", dnd_until: null, status: null, at: 0 };
  return <PresenceDot entry={entry} size={12} ring={ring} className={className} />;
}

/**
 * Setting your status: an emoji and a few words, or one of the presets,
 * and when it clears: in 30 minutes, an hour, four hours, at the end of
 * today or the week, never, or at a time you choose.
 */
export function StatusDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const me = useOwnPresence();
  const { byName, usercontent } = useEmojiContext();
  const [emoji, setEmoji] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [clear, setClear] = useState<ClearAfter>("today");
  const [custom, setCustom] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Opened: starts from the status you have now.
  useEffect(() => {
    if (!open) return;
    const status = liveStatus(me?.status, Date.now());
    setEmoji(status?.emoji ?? null);
    setText(status?.text ?? "");
    setClear(status ? (status.clear_at ? "custom" : "never") : "today");
    setCustom(status?.clear_at ? localInputValue(new Date(status.clear_at)) : localInputValue(new Date(Date.now() + 60 * 60_000)));
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const save = async (next: { emoji: string | null; text: string; clear: ClearAfter }) => {
    const words = next.text.trim();
    if (!words && !next.emoji) {
      setError("Say something, or pick an emoji.");
      return;
    }
    const clearAt = clearAtFor(next.clear, new Date(), custom);
    if (next.clear === "custom" && !clearAt) {
      setError("Choose a time that is still ahead.");
      return;
    }
    setSaving(true);
    const saved = await setPresence({ status: { emoji: next.emoji, text: words, clear_at: clearAt } });
    setSaving(false);
    if (!saved) {
      setError("Your status didn't save. Try again.");
      return;
    }
    onOpenChange(false);
  };

  const clearNow = async () => {
    setSaving(true);
    await setPresence({ status: null }, { status: null });
    setSaving(false);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Set a status</DialogTitle>
          <DialogDescription>Everyone in your workspaces sees it beside your name.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save({ emoji, text, clear });
          }}
        >
          <div className="flex items-center gap-2">
            <EmojiPickerPopover onPick={(picked) => setEmoji(picked)} side="bottom" align="start">
              <Button
                type="button"
                aria-label={emoji ? `Emoji: ${emoji}. Change it` : "Choose an emoji"}
                variant="outline"
                size="icon"
                className="bg-bg hover:bg-raised"
              >
                {emoji ? <EmojiGlyph emoji={emoji} byName={byName} usercontent={usercontent} size={18} /> : <Smile size={17} className="text-faint" />}
              </Button>
            </EmojiPickerPopover>
            <Input
              value={text}
              onChange={(event) => setText(event.target.value)}
              maxLength={100}
              placeholder="What's your status?"
              aria-label="Status"
              autoComplete="off"
              data-1p-ignore
              autoFocus
            />
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium text-faint">Suggestions</p>
            <ul className="space-y-px">
              {STATUS_PRESETS.map((preset) => (
                <li key={preset.text}>
                  <button
                    type="button"
                    onClick={() => {
                      setEmoji(preset.emoji);
                      setText(preset.text);
                      setClear(preset.clear);
                      setError(null);
                    }}
                    className="flex h-9 w-full items-center gap-3 rounded-md px-2 text-left text-sm transition-colors hover:bg-raised"
                  >
                    <span className="w-5 text-center text-base leading-none">{preset.emoji}</span>
                    <span className="grow text-fg/90">{preset.text}</span>
                    <span className="text-xs text-faint">{CLEAR_AFTER.find((c) => c.key === preset.clear)?.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div className="grid gap-2 sm:grid-cols-[auto_1fr] sm:items-center sm:gap-3">
            <label htmlFor="status-clear" className="text-sm text-muted">
              Clear after
            </label>
            <Select value={clear} onValueChange={(value) => setClear(value as ClearAfter)}>
              <SelectTrigger id="status-clear" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CLEAR_AFTER.map((choice) => (
                  <SelectItem key={choice.key} value={choice.key}>
                    {choice.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {clear === "custom" && (
              <>
                <label htmlFor="status-clear-at" className="text-sm text-muted">
                  At
                </label>
                <Input id="status-clear-at" type="datetime-local" value={custom} onChange={(event) => setCustom(event.target.value)} />
              </>
            )}
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
          <DialogFooter>
            {liveStatus(me?.status, Date.now()) && (
              <Button type="button" variant="outline" disabled={saving} onClick={() => void clearNow()}>
                Clear status
              </Button>
            )}
            <Button type="submit" variant="accent" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
