/**
 * AI Elements' Loader and Shimmer (registry.ai-sdk.dev/loader.json,
 * shimmer.json), in g1t's tokens: before g1t's first words, its mark
 * breathing beside a line whose lavender sweeps across it. Still for
 * anyone who asked for less motion.
 */
import type { ComponentProps } from "react";

import { cn } from "../../lib/cn";
import { MarkGlyph } from "../logo";

export function Shimmer({ className, children, ...props }: ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "animate-shimmer bg-[linear-gradient(90deg,var(--color-muted)_0%,var(--color-muted)_40%,var(--color-accent)_50%,var(--color-muted)_60%,var(--color-muted)_100%)] bg-size-[200%_100%] bg-clip-text text-transparent motion-reduce:animate-none motion-reduce:text-muted",
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}

export function Loader({ label = "Thinking", className, ...props }: ComponentProps<"div"> & { label?: string }) {
  return (
    <div role="status" className={cn("flex items-center gap-2 text-sm", className)} {...props}>
      <MarkGlyph className="h-3 animate-pulse motion-reduce:animate-none" />
      <Shimmer>{label}…</Shimmer>
    </div>
  );
}
