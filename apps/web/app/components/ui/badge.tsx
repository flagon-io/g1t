import type { ComponentProps } from "react";

import { cn } from "../../lib/cn";

// shadcn/ui's badge, styled with g1t's tokens: a small outlined label whose
// tone says how much it matters.

export type BadgeTone = "neutral" | "accent" | "success" | "info" | "merged" | "warn" | "danger";

const TONES: Record<BadgeTone, string> = {
  neutral: "border-line text-muted",
  accent: "border-accent/40 bg-accent/10 text-accent",
  success: "border-success/40 bg-success/10 text-success",
  info: "border-info/40 bg-info/10 text-info",
  merged: "border-merged/40 bg-merged/10 text-merged",
  warn: "border-warn/40 bg-warn/10 text-warn",
  danger: "border-danger/40 bg-danger/10 text-danger",
};

export function Badge({ tone = "neutral", className, ...props }: ComponentProps<"span"> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-px text-[0.6875rem] font-medium whitespace-nowrap",
        TONES[tone],
        className,
      )}
      {...props}
    />
  );
}
