import { Bot } from "lucide-react";
import { type ComponentProps, type KeyboardEvent, useRef, useState } from "react";

import { AGENT_MENTION as AGENT_HANDLE, partialMention } from "../lib/mention";
import { Textarea } from "./ui";

/**
 * A comment box that offers to complete `@g1t-agent`: Tab or Enter takes
 * the suggestion, Escape dismisses it.
 */
export function MentionTextarea(props: ComponentProps<"textarea">) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [start, setStart] = useState<number | null>(null);

  const look = () => {
    const box = ref.current;
    if (!box) return;
    setStart(box.selectionStart === box.selectionEnd ? partialMention(box.value, box.selectionStart) : null);
  };

  const complete = () => {
    const box = ref.current;
    if (!box || start == null) return;
    const caret = box.selectionStart;
    box.setRangeText(`${AGENT_HANDLE} `, start, caret, "end");
    setStart(null);
    box.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (start != null && (event.key === "Tab" || event.key === "Enter") && !event.shiftKey) {
      event.preventDefault();
      complete();
      return;
    }
    if (event.key === "Escape") setStart(null);
    props.onKeyDown?.(event);
  };

  return (
    <div className="relative">
      <Textarea
        {...props}
        ref={ref}
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
          // After a click on the suggestion has landed.
          setTimeout(() => setStart(null), 150);
          props.onBlur?.(event);
        }}
      />
      {start != null && (
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={complete}
          className="absolute bottom-2 left-2 flex items-center gap-1.5 rounded-md border border-line bg-raised px-2 py-1 font-mono text-xs text-fg shadow-sm"
        >
          <Bot size={12} className="text-merged" />
          {AGENT_HANDLE}
          <span className="font-sans text-faint">Tab</span>
        </button>
      )}
    </div>
  );
}
