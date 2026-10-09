import { ArrowUp, AtSign, Smile } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { AgentPill, MemberAvatar } from "./marks";
import { Hint } from "../ui/hint";
// `:shortcode` completion and the emoji picker (components/emoji).
import { useEmojiAutocomplete } from "../emoji/autocomplete";
import { EmojiPickerPopover } from "../emoji/picker";
import { type MentionQuery, type Mentionable, mentionQuery } from "../../lib/chat";

/** How tall the box grows before it scrolls. */
const MAX_HEIGHT = 240;

/**
 * Where a message is written. Enter sends, Shift+Enter starts a new line;
 * `@` offers the workspace's people and agents (Up and Down to move, Tab or
 * Enter to take one, Escape to dismiss). What is typed is kept per
 * conversation while the tab is open, so moving away loses nothing.
 */
export function Composer({
  draftKey,
  placeholder,
  people,
  onSend,
  onTyping,
  disabled,
  autoFocus,
  compact,
}: {
  draftKey: string;
  placeholder: string;
  people: Mentionable[];
  onSend: (body: string) => void;
  onTyping?: () => void;
  disabled?: boolean;
  autoFocus?: boolean;
  compact?: boolean;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [match, setMatch] = useState<MentionQuery | null>(null);
  const [active, setActive] = useState(0);
  const list = useId();
  const emoji = useEmojiAutocomplete({ box, setText });

  // The draft for this conversation, if one was left.
  useEffect(() => {
    try {
      setText(sessionStorage.getItem(`chat-draft:${draftKey}`) ?? "");
    } catch {
      setText("");
    }
  }, [draftKey]);
  useEffect(() => {
    try {
      if (text) sessionStorage.setItem(`chat-draft:${draftKey}`, text);
      else sessionStorage.removeItem(`chat-draft:${draftKey}`);
    } catch {
      // No storage: the draft lives only while the page does.
    }
  }, [draftKey, text]);

  // Grows with what is written, up to a point.
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(MAX_HEIGHT, element.scrollHeight)}px`;
  }, [text]);

  const look = () => {
    const element = box.current;
    if (!element) return;
    emoji.look();
    setMatch(element.selectionStart === element.selectionEnd ? mentionQuery(element.value, element.selectionStart, people) : null);
    setActive(0);
  };

  const complete = (person: Mentionable) => {
    const element = box.current;
    if (!element || !match) return;
    const caret = element.selectionStart;
    const next = `${element.value.slice(0, match.start)}@${person.name} ${element.value.slice(caret)}`;
    setText(next);
    setMatch(null);
    requestAnimationFrame(() => {
      const at = match.start + person.name.length + 2;
      element.focus();
      element.setSelectionRange(at, at);
    });
  };

  const send = () => {
    const body = text.trim();
    if (!body || disabled) return;
    onSend(body);
    setText("");
    setMatch(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (emoji.onKeyDown(event)) return;
    if (match) {
      const count = match.options.length;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setActive((index) => (index + (event.key === "ArrowDown" ? 1 : count - 1)) % count);
        return;
      }
      if ((event.key === "Tab" || event.key === "Enter") && !event.shiftKey) {
        event.preventDefault();
        complete(match.options[active] ?? match.options[0]!);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMatch(null);
        return;
      }
    }
    // Enter sends; Shift+Enter, and Enter while composing an IME word, does not.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  const open = match != null;
  return (
    <div className="relative">
      {emoji.menu}
      {match && (
        <ul
          id={list}
          role="listbox"
          aria-label="Mention someone"
          className="absolute bottom-full left-0 z-20 mb-2 w-full max-w-sm overflow-hidden rounded-lg border border-line-strong bg-raised p-1 shadow-xl shadow-black/40"
        >
          {match.options.map((person, index) => (
            <li
              key={`${person.kind}:${person.name}`}
              id={`${list}-${index}`}
              role="option"
              aria-selected={index === active}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => complete(person)}
              className={`flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 ${index === active ? "bg-line" : ""}`}
            >
              <MemberAvatar member={person} size={22} />
              <span className="min-w-0 grow truncate text-sm">
                <span className="font-medium text-fg">{person.display_name}</span>
                <span className="ml-1.5 text-faint">@{person.name}</span>
              </span>
              {person.kind === "agent" && <AgentPill />}
            </li>
          ))}
        </ul>
      )}
      <div
        className={`rounded-xl border border-line-strong bg-surface transition-colors focus-within:border-accent/35 focus-within:ring-4 focus-within:ring-accent/[0.06] ${disabled ? "opacity-60" : ""}`}
      >
        <textarea
          ref={box}
          value={text}
          rows={1}
          disabled={disabled}
          autoFocus={autoFocus}
          placeholder={placeholder}
          aria-label={placeholder}
          role={open ? "combobox" : undefined}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? list : undefined}
          aria-activedescendant={open ? `${list}-${active}` : undefined}
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          onChange={(event) => {
            setText(event.target.value);
            onTyping?.();
          }}
          onInput={look}
          onClick={look}
          onKeyDown={onKeyDown}
          onBlur={() =>
            setTimeout(() => {
              setMatch(null);
              emoji.dismiss();
            }, 150)
          }
          className={`block w-full resize-none bg-transparent px-3.5 text-[0.9375rem] leading-6 text-fg outline-none placeholder:text-faint ${compact ? "pt-2.5 pb-1" : "pt-3 pb-1.5"}`}
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          <Hint label="Mention someone">
            <button
              type="button"
              aria-label="Mention someone"
              disabled={disabled}
              onClick={() => {
                const element = box.current;
                if (!element) return;
                const at = element.selectionStart;
                const before = element.value.slice(0, at);
                const insert = before && !/\s$/.test(before) ? " @" : "@";
                const next = `${before}${insert}${element.value.slice(at)}`;
                setText(next);
                requestAnimationFrame(() => {
                  element.focus();
                  element.setSelectionRange(at + insert.length, at + insert.length);
                  setMatch(mentionQuery(next, at + insert.length, people));
                });
              }}
              className="flex size-7 items-center justify-center rounded-md text-faint transition-colors hover:bg-raised hover:text-fg"
            >
              <AtSign size={15} />
            </button>
          </Hint>
          <EmojiPickerPopover
            side="top"
            align="start"
            onPick={(picked) => {
              const element = box.current;
              const at = element?.selectionStart ?? text.length;
              const end = element?.selectionEnd ?? at;
              const next = `${text.slice(0, at)}${picked}${text.slice(end)}`;
              setText(next);
              requestAnimationFrame(() => {
                element?.focus();
                element?.setSelectionRange(at + picked.length, at + picked.length);
              });
            }}
          >
            <Hint label="Add an emoji">
              <button
                type="button"
                aria-label="Add an emoji"
                disabled={disabled}
                className="flex size-7 items-center justify-center rounded-md text-faint transition-colors hover:bg-raised hover:text-fg"
              >
                <Smile size={15} />
              </button>
            </Hint>
          </EmojiPickerPopover>
          <span className="ml-1 hidden text-[0.6875rem] text-faint sm:inline">
            <kbd className="font-sans">Enter</kbd> to send · <kbd className="font-sans">Shift+Enter</kbd> for a new line
          </span>
          <button
            type="button"
            aria-label="Send"
            disabled={disabled || !text.trim()}
            onClick={send}
            className="ml-auto flex size-8 items-center justify-center rounded-lg bg-accent text-bg transition-[background-color,opacity] hover:bg-accent-hover disabled:bg-line disabled:text-faint"
          >
            <ArrowUp size={16} strokeWidth={2.4} />
          </button>
        </div>
      </div>
    </div>
  );
}
