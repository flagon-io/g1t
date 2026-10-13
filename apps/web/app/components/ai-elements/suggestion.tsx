/**
 * AI Elements' Suggestion (registry.ai-sdk.dev/suggestion.json), in g1t's
 * tokens: what someone might ask first, as quiet pills that wrap.
 */
import type { ComponentProps } from "react";

import { cn } from "../../lib/cn";
import { Button } from "../ui/button";

export function Suggestions({ className, ...props }: ComponentProps<"div">) {
  return <div role="list" className={cn("flex flex-wrap gap-2", className)} {...props} />;
}

export function Suggestion({
  suggestion,
  onPick,
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, "onClick"> & { suggestion: string; onPick: (suggestion: string) => void }) {
  return (
    <Button
      type="button"
      role="listitem"
      variant="outline"
      size="sm"
      onClick={() => onPick(suggestion)}
      className={cn("h-auto rounded-full px-3 py-1.5 text-left font-normal whitespace-normal text-fg-soft", className)}
      {...props}
    >
      {suggestion}
    </Button>
  );
}
