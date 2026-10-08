import { Bot, Users } from "lucide-react";
import { type ComponentProps, type KeyboardEvent, useId, useRef, useState } from "react";

import { AGENT_MENTION as AGENT_HANDLE, type MentionMatch, mentionSuggestions } from "../lib/mention";
import { Textarea } from "./ui";

/**
 * A comment box that offers to complete `@g1t`, and the teams in `handles`
 * (`@acme/backend`): Up and Down move through the suggestions, Tab or Enter
 * takes one, Escape dismisses them.
 */
export function MentionTextarea({ handles, ...props }: ComponentProps<"textarea"> & { handles?: readonly string[] }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [match, setMatch] = useState<MentionMatch | null>(null);
  const [active, setActive] = useState(0);
  const list = useId();

  const look = () => {
    const box = ref.current;
    if (!box) return;
    const found = box.selectionStart === box.selectionEnd ? mentionSuggestions(box.value, box.selectionStart, handles) : null;
    setMatch(found);
    setActive(0);
  };

  const complete = (handle: string) => {
    const box = ref.current;
    if (!box || !match) return;
    const caret = box.selectionStart;
    box.setRangeText(`${handle} `, match.start, caret, "end");
    setMatch(null);
    box.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
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
    props.onKeyDown?.(event);
  };

  const open = match != null;
  return (
    <div className="relative">
      <Textarea
        {...props}
        ref={ref}
        role={open ? "combobox" : undefined}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? list : undefined}
        aria-activedescendant={open ? `${list}-${active}` : undefined}
        onKeyDown={onKeyDown}
        onInput={(event) => {
          look();
          props.onInput?.(event);
        }}
        onClick={(event) => {
          look();
          props.onClick?.(event);
        }}
        onBlur={(event) => {
          // After a click on a suggestion has landed.
          setTimeout(() => setMatch(null), 150);
          props.onBlur?.(event);
        }}
      />
      {match && (
        <ul
          id={list}
          role="listbox"
          aria-label="Mentions"
          className="absolute top-full left-0 z-20 mt-1 max-w-full min-w-44 overflow-hidden rounded-md border border-line bg-raised p-1 shadow-lg shadow-black/30"
        >
          {match.options.map((handle, index) => (
            <li
              key={handle}
              id={`${list}-${index}`}
              role="option"
              aria-selected={index === active}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => complete(handle)}
              className={`flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 font-mono text-xs text-fg ${
                index === active ? "bg-line" : ""
              }`}
            >
              {handle === AGENT_HANDLE ? (
                <Bot size={12} className="shrink-0 text-merged" />
              ) : (
                <Users size={12} className="shrink-0 text-faint" />
              )}
              <span className="min-w-0 truncate">{handle}</span>
              {index === active && <span className="ml-auto pl-3 font-sans text-faint">Tab</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
