/**
 * AI Elements' Message (registry.ai-sdk.dev/message.json), in g1t's
 * tokens: a person's words as a bubble on the right, g1t's as text on the
 * page, and a row of quiet actions under an answer. The Markdown itself is
 * response.tsx.
 */
import type { ComponentProps, ReactNode } from "react";

import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Hint } from "../ui/hint";

export function Message({ from, className, ...props }: ComponentProps<"div"> & { from: "user" | "assistant" }) {
  return (
    <div data-from={from} className={cn("group/message flex w-full flex-col gap-1.5", from === "user" ? "items-end" : "items-start", className)} {...props} />
  );
}

/** A person's words: a bubble, their line breaks kept. */
export function MessageContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "w-fit max-w-[85%] rounded-2xl rounded-br-md bg-raised px-3.5 py-2 text-[0.9375rem] leading-[1.55] wrap-break-word whitespace-pre-wrap text-fg",
        className,
      )}
      {...props}
    />
  );
}

/** What can be done with an answer, shown under it; brighter on hover. */
export function MessageActions({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex min-h-7 flex-wrap items-center gap-0.5 text-xs text-faint", className)} {...props} />;
}

export function MessageAction({ label, children, className, ...props }: ComponentProps<typeof Button> & { label: string; children: ReactNode }) {
  return (
    <Hint label={label}>
      <Button type="button" variant="ghost" size="icon-xs" aria-label={label} className={cn("size-7 text-faint hover:text-fg", className)} {...props}>
        {children}
      </Button>
    </Hint>
  );
}
