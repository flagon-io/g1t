/**
 * The box you write to an agent in, as claude.ai has it: a rounded card
 * with the text growing as you write, and a toolbar under it with what
 * the message goes with (a repository, a work item) on the left and the
 * round send button on the right, which turns into Stop while the agent
 * works. Chat's New (components/chat/agent-composer.tsx) and a hosted
 * session's page (components/session-answer.tsx) are drawn with it.
 */
import { ArrowUp, Square } from "lucide-react";
import type { ComponentProps, ReactNode, Ref } from "react";

import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Hint } from "../ui/hint";

/** The card around the text and its toolbar. */
export function PromptBox({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={cn(
        "flex flex-col rounded-2xl border border-line bg-surface shadow-sm transition-[border-color,box-shadow] focus-within:border-line-strong focus-within:shadow-md",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * The text: it grows with what is written, up to a third of the screen.
 * Enter sends (`onSend`, else the form it is in), Shift+Enter starts a new
 * line, and nothing is sent mid-composition (an IME) or while `busy`.
 */
export function PromptBoxInput({
  className,
  onSend,
  busy,
  ref,
  ...props
}: ComponentProps<"textarea"> & { onSend?: () => void; busy?: boolean; ref?: Ref<HTMLTextAreaElement> }) {
  return (
    <textarea
      ref={ref}
      rows={2}
      autoComplete="off"
      data-1p-ignore
      {...props}
      onKeyDown={(event) => {
        props.onKeyDown?.(event);
        if (event.defaultPrevented || event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
        event.preventDefault();
        if (busy) return;
        if (onSend) onSend();
        else event.currentTarget.form?.requestSubmit();
      }}
      className={cn(
        "max-h-[33dvh] min-h-14 w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[0.9375rem] leading-relaxed text-fg outline-none [field-sizing:content] placeholder:text-faint",
        className,
      )}
    />
  );
}

/** Under the text: what the message goes with, then `end` (the send button) on the right. */
export function PromptBoxToolbar({ children, end, className }: { children?: ReactNode; end: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 items-center gap-1 px-2 pb-2", className)}>
      <div className="flex min-w-0 grow flex-wrap items-center gap-0.5">{children}</div>
      <div className="flex shrink-0 items-center gap-2">{end}</div>
    </div>
  );
}

/** The round send button: a submit button of the form it is in, or `onClick`. */
export function PromptBoxSend({ label = "Send", disabled, busy, onClick }: { label?: string; disabled?: boolean; busy?: boolean; onClick?: () => void }) {
  return (
    <Hint label={label}>
      <Button
        type={onClick ? "button" : "submit"}
        variant="accent"
        size="icon-sm"
        aria-label={label}
        disabled={disabled}
        busy={busy}
        onClick={onClick}
        className="rounded-full"
      >
        {!busy && <ArrowUp size={16} strokeWidth={2.5} />}
      </Button>
    </Hint>
  );
}

/** Stop, in place of send while the agent works: a submit button of its own form (`form`), or `onClick`. */
export function PromptBoxStop({ label = "Stop", form, busy, onClick }: { label?: string; form?: string; busy?: boolean; onClick?: () => void }) {
  return (
    <Hint label={label}>
      <Button
        type={onClick ? "button" : "submit"}
        form={form}
        variant="secondary"
        size="icon-sm"
        aria-label={label}
        busy={busy}
        onClick={onClick}
        className="rounded-full ring-1 ring-line-strong"
      >
        {!busy && <Square size={12} fill="currentColor" />}
      </Button>
    </Hint>
  );
}
