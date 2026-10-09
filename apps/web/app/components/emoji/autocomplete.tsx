import { type KeyboardEvent, type ReactNode, type RefObject, useId, useState } from "react";

import { useEmojiContext } from "./context";
import { loadEmojiData, readTone, rememberRecent } from "./data";
import { EmojiGlyph } from "./render";
import { type EmojiData, type EmojiPick, searchEmoji, shortcodeQuery, skinned } from "../../lib/emoji";

/** Suggestions shown at once. */
const SHOWN = 8;

type Match = { start: number; typed: string; options: EmojiPick[] };

/**
 * `:shortcode` completion for a text box. Typing `:` and two letters
 * offers emoji by name; Up and Down move, Tab or Enter take one, Escape
 * dismisses. A standard emoji goes in as the emoji itself; the workspace's
 * own as `:name:`, which messages draw as its image.
 *
 * Use: call `look()` after input and clicks, give `onKeyDown` the box's
 * key events first (it says whether it used one), render `menu` above the
 * box, and dismiss on blur.
 */
export function useEmojiAutocomplete({
  box,
  setText,
}: {
  box: RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
  setText: (text: string) => void;
}): { menu: ReactNode; open: boolean; look: () => void; onKeyDown: (event: KeyboardEvent<HTMLElement>) => boolean; dismiss: () => void; listId: string; activeId: string | undefined } {
  const { customs, byName, usercontent } = useEmojiContext();
  const [match, setMatch] = useState<Match | null>(null);
  const [active, setActive] = useState(0);
  const list = useId();

  const look = () => {
    const element = box.current;
    if (!element || element.selectionStart == null || element.selectionStart !== element.selectionEnd) return setMatch(null);
    const query = shortcodeQuery(element.value, element.selectionStart);
    if (!query) return setMatch(null);
    const show = (data: EmojiData | null) => {
      const options = searchEmoji(data, customs, query.typed, SHOWN);
      setMatch(options.length ? { ...query, options } : null);
      setActive(0);
    };
    // The workspace's own at once; the standard ones as soon as they load.
    show(null);
    void loadEmojiData()
      .then((data) => {
        const now = box.current;
        if (now && now.selectionStart != null && shortcodeQuery(now.value, now.selectionStart)?.typed === query.typed) show(data);
      })
      .catch(() => {});
  };

  const take = (choice: EmojiPick) => {
    const element = box.current;
    if (!element || !match) return;
    const caret = element.selectionStart ?? match.start;
    const emoji = choice.kind === "unicode" ? skinned(choice, readTone()) : choice.emoji;
    rememberRecent(emoji);
    const next = `${element.value.slice(0, match.start)}${emoji} ${element.value.slice(caret)}`;
    setText(next);
    setMatch(null);
    requestAnimationFrame(() => {
      const at = match.start + emoji.length + 1;
      element.focus();
      element.setSelectionRange(at, at);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): boolean => {
    if (!match) return false;
    const count = match.options.length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => (index + (event.key === "ArrowDown" ? 1 : count - 1)) % count);
      return true;
    }
    if ((event.key === "Tab" || event.key === "Enter") && !event.shiftKey) {
      event.preventDefault();
      take(match.options[active] ?? match.options[0]!);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setMatch(null);
      return true;
    }
    return false;
  };

  const menu = match ? (
    <ul
      id={list}
      role="listbox"
      aria-label="Emoji"
      className="absolute bottom-full left-0 z-20 mb-2 w-full max-w-sm overflow-hidden rounded-lg border border-line-strong bg-raised p-1 shadow-xl shadow-black/40"
    >
      <li role="presentation" className="px-2 pt-1 pb-1.5 text-[0.6875rem] font-semibold tracking-wide text-faint uppercase">
        Emoji matching :{match.typed}
      </li>
      {match.options.map((choice, index) => (
        <li
          key={choice.emoji}
          id={`${list}-${index}`}
          role="option"
          aria-selected={index === active}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => setActive(index)}
          onClick={() => take(choice)}
          className={`flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 ${index === active ? "bg-line" : ""}`}
        >
          <span className="flex size-6 items-center justify-center">
            <EmojiGlyph emoji={choice.emoji} byName={byName} usercontent={usercontent} size={choice.kind === "custom" ? 22 : 18} />
          </span>
          <span className="min-w-0 grow truncate font-mono text-[0.8125rem] text-fg-soft">
            :{choice.kind === "custom" ? choice.name : (choice.code ?? choice.name)}:
          </span>
          {choice.kind === "custom" && <span className="text-[0.6875rem] text-faint">This workspace</span>}
        </li>
      ))}
    </ul>
  ) : null;

  return {
    menu,
    open: match != null,
    look,
    onKeyDown,
    dismiss: () => setMatch(null),
    listId: list,
    activeId: match ? `${list}-${active}` : undefined,
  };
}
