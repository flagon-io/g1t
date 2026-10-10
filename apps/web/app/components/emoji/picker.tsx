import { Clock, Plus, Search, Sparkles } from "lucide-react";
import { type KeyboardEvent, type ReactElement, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router";

import { useEmojiContext } from "./context";
import { readRecent, readTone, rememberRecent, rememberTone, useEmojiData } from "./data";
import { EmojiGlyph } from "./render";
import { Button } from "../ui/button";
import { Hint } from "../ui/hint";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { type EmojiPick, SKIN_TONES, customPick, searchEmoji, skinned, unicodePick } from "../../lib/emoji";

/** Emoji per row. */
const COLUMNS = 9;
/** One for each group in data.json, in its order. */
const GROUP_ICONS = ["😀", "👋", "🐻", "🍔", "✈️", "⚽", "💡", "🔣", "🏁"];

type Section = { key: string; title: string; icon: ReactNode; picks: EmojiPick[] };

/**
 * Choosing an emoji: type to search by name, shortcode or keyword, or
 * browse by group; recently used and the workspace's own first. Arrow keys
 * move through the grid while typing, Enter picks, Escape closes (the
 * popover around it). The skin tone chosen is remembered in this browser.
 */
export function EmojiPicker({ onPick, autoFocus = true }: { onPick: (emoji: string) => void; autoFocus?: boolean }) {
  const { customs, byName, usercontent, manageHref } = useEmojiContext();
  const data = useEmojiData();
  const [query, setQuery] = useState("");
  const [tone, setTone] = useState(0);
  const [toning, setToning] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  const grid = useRef<HTMLDivElement>(null);
  const list = useId();

  useEffect(() => {
    setTone(readTone());
    setRecent(readRecent());
  }, []);

  const sections = useMemo<Section[]>(() => {
    if (query.trim()) {
      return [{ key: "results", title: "Results", icon: <Search size={14} />, picks: searchEmoji(data, customs, query, 90) }];
    }
    const out: Section[] = [];
    const recentPicks = recent.flatMap((emoji): EmojiPick[] => {
      const custom = /^:([a-z0-9_+-]{2,32}):$/.exec(emoji);
      if (custom) {
        const file = byName.get(custom[1]!);
        return file ? [customPick({ name: custom[1]!, file })] : [];
      }
      return [{ kind: "unicode", emoji, name: data?.emoji.find((e) => e[0] === emoji || e[5]?.includes(emoji))?.[1] ?? emoji, code: null }];
    });
    if (recentPicks.length) out.push({ key: "recent", title: "Recently used", icon: <Clock size={14} />, picks: recentPicks });
    if (customs.length) out.push({ key: "custom", title: "This workspace", icon: <Sparkles size={14} />, picks: customs.map(customPick) });
    data?.groups.forEach((title, group) => {
      out.push({ key: `g${group}`, title, icon: GROUP_ICONS[group] ?? "", picks: data.emoji.filter((e) => e[4] === group).map(unicodePick) });
    });
    return out;
  }, [query, data, customs, recent, byName]);

  const flat = useMemo(() => sections.flatMap((s) => s.picks), [sections]);
  useEffect(() => setActive(0), [query]);
  const current = flat[Math.min(active, flat.length - 1)] ?? null;

  // The active emoji stays in view as the arrows move it.
  useEffect(() => {
    grid.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (choice: EmojiPick) => {
    const emoji = choice.kind === "unicode" ? skinned(choice, tone) : choice.emoji;
    setRecent(rememberRecent(emoji));
    onPick(emoji);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const move = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS }[event.key];
    if (move != null && flat.length) {
      // Left and right belong to the search box while it has text to move through.
      if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && query && event.target instanceof HTMLInputElement) return;
      event.preventDefault();
      setActive((index) => Math.max(0, Math.min(flat.length - 1, index + move)));
    } else if (event.key === "Enter" && current) {
      event.preventDefault();
      pick(current);
    } else if (event.key === "Home" && !(event.target instanceof HTMLInputElement)) {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End" && !(event.target instanceof HTMLInputElement)) {
      event.preventDefault();
      setActive(flat.length - 1);
    }
  };

  const jump = (key: string) => {
    const at = grid.current?.querySelector<HTMLElement>(`[data-section="${key}"]`);
    if (at && grid.current) grid.current.scrollTop = at.offsetTop - grid.current.offsetTop;
  };

  let index = 0;
  return (
    <div className="flex h-[26rem] w-[22.5rem] max-w-[calc(100vw-1rem)] flex-col" onKeyDown={onKeyDown}>
      <div className="flex items-center gap-2 border-b border-line p-2">
        <label className="flex h-8 min-w-0 grow items-center gap-2 rounded-md border border-line-strong bg-bg px-2 focus-within:border-accent/50">
          <Search size={14} className="shrink-0 text-faint" />
          <input
            autoFocus={autoFocus}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search emoji"
            aria-label="Search emoji"
            role="combobox"
            aria-expanded
            aria-controls={list}
            aria-activedescendant={current ? `${list}-${Math.min(active, flat.length - 1)}` : undefined}
            autoComplete="off"
            data-1p-ignore
            className="min-w-0 grow bg-transparent text-sm text-fg outline-none placeholder:text-faint"
          />
        </label>
        <div className="relative">
          <Hint label="Skin tone">
            <Button
              type="button"
              aria-label="Skin tone"
              aria-expanded={toning}
              onClick={() => setToning((open) => !open)}
              variant="ghost"
              size="icon-sm"
              className="text-lg"
            >
              {SKIN_TONES[tone]}
            </Button>
          </Hint>
          {toning && (
            <div role="radiogroup" aria-label="Skin tone" className="absolute top-full right-0 z-10 mt-1 flex gap-0.5 rounded-lg border border-line-strong bg-raised p-1 shadow-xl shadow-black/40">
              {SKIN_TONES.map((hand, choice) => (
                <button
                  key={hand}
                  type="button"
                  role="radio"
                  aria-checked={choice === tone}
                  aria-label={choice === 0 ? "No skin tone" : `Skin tone ${choice}`}
                  onClick={() => {
                    setTone(choice);
                    rememberTone(choice);
                    setToning(false);
                  }}
                  className={`flex size-8 items-center justify-center rounded-md text-lg hover:bg-line ${choice === tone ? "bg-line" : ""}`}
                >
                  {hand}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {!query.trim() && (
        <nav aria-label="Emoji groups" className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line px-1.5 py-1 [scrollbar-width:none]">
          {sections.map((section) => (
            <Hint key={section.key} label={section.title}>
              <Button
                type="button"
                aria-label={section.title}
                onClick={() => jump(section.key)}
                variant="ghost"
                size="icon-xs"
                className="text-[0.95rem] text-faint grayscale-[0.6] transition hover:grayscale-0"
              >
                {section.icon}
              </Button>
            </Hint>
          ))}
        </nav>
      )}
      <div ref={grid} id={list} role="listbox" aria-label="Emoji" className="relative min-h-0 grow overflow-y-auto px-2 pb-2 [scrollbar-width:thin]">
        {!data && !query.trim() && <p className="px-1 py-6 text-center text-sm text-faint">Loading emoji…</p>}
        {sections.map((section) => (
          <section key={section.key} data-section={section.key} aria-label={section.title}>
            <h3 className="sticky top-0 z-[1] flex items-center justify-between bg-raised/95 px-1 pt-2 pb-1 text-[0.6875rem] font-semibold tracking-wide text-faint uppercase backdrop-blur">
              {section.title}
              {section.key === "custom" && manageHref && (
                <Link to={manageHref} className="font-medium tracking-normal normal-case text-accent hover:underline">
                  Manage
                </Link>
              )}
            </h3>
            {section.picks.length === 0 ? (
              <p className="px-1 py-6 text-center text-sm text-faint">No emoji match “{query.trim()}”.</p>
            ) : (
              <div className="grid grid-cols-9">
                {section.picks.map((choice) => {
                  const at = index++;
                  const glyph = choice.kind === "unicode" ? skinned(choice, tone) : choice.emoji;
                  return (
                    <button
                      key={`${section.key}:${choice.emoji}`}
                      type="button"
                      tabIndex={-1}
                      id={`${list}-${at}`}
                      data-index={at}
                      role="option"
                      aria-selected={at === active}
                      aria-label={choice.kind === "custom" ? `:${choice.name}:` : choice.name}
                      onMouseEnter={() => setActive(at)}
                      onClick={() => pick(choice)}
                      className={`flex aspect-square items-center justify-center rounded-md text-[1.375rem] leading-none transition-colors ${
                        at === active ? "bg-line" : "hover:bg-line"
                      }`}
                    >
                      <EmojiGlyph emoji={glyph} byName={byName} usercontent={usercontent} size={choice.kind === "custom" ? 24 : 22} />
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        ))}
        {!query.trim() && !customs.length && manageHref && (
          <Link to={manageHref} className="mt-2 flex items-center gap-2 rounded-md px-2 py-2 text-[0.8125rem] text-muted hover:bg-line hover:text-fg">
            <Plus size={14} /> Add this workspace’s own emoji
          </Link>
        )}
      </div>
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-t border-line px-3">
        {current ? (
          <>
            <EmojiGlyph emoji={current.kind === "unicode" ? skinned(current, tone) : current.emoji} byName={byName} usercontent={usercontent} size={26} />
            <span className="min-w-0 truncate text-sm">
              <span className="text-fg-soft first-letter:uppercase">{current.name}</span>
              {(current.kind === "custom" || current.code) && (
                <span className="ml-1.5 font-mono text-xs text-faint">:{current.kind === "custom" ? current.name : current.code}:</span>
              )}
            </span>
          </>
        ) : (
          <span className="text-sm text-faint">Pick an emoji</span>
        )}
      </div>
    </div>
  );
}

/** The picker in a popover, opened by `children` (one element). Picking closes it. */
export function EmojiPickerPopover({
  children,
  onPick,
  side = "top",
  align = "end",
  open: controlled,
  onOpenChange,
}: {
  children: ReactElement;
  onPick: (emoji: string) => void;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  const setOpen = (next: boolean) => {
    setOwn(next);
    onOpenChange?.(next);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent side={side} align={align} collisionPadding={8} className="w-auto overflow-hidden p-0">
        <EmojiPicker
          onPick={(emoji) => {
            onPick(emoji);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
