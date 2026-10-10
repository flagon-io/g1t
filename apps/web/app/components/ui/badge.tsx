import { type VariantProps, cva } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "../../lib/cn";

// shadcn/ui's badge, styled with g1t's tokens: a small outlined label whose
// tone says how much it matters. `sm` (the default) is the 11px label beside
// a title or in a table; `md` the 12px pill in a list of properties.

export const badgeVariants = cva("inline-flex shrink-0 items-center gap-1 rounded-full border whitespace-nowrap", {
  variants: {
    tone: {
      neutral: "border-line text-muted",
      accent: "border-accent/40 bg-accent/10 text-accent",
      success: "border-success/40 bg-success/10 text-success",
      info: "border-info/40 bg-info/10 text-info",
      merged: "border-merged/40 bg-merged/10 text-merged",
      warn: "border-warn/40 bg-warn/10 text-warn",
      danger: "border-danger/40 bg-danger/10 text-danger",
    },
    size: {
      sm: "px-2 py-px text-[0.6875rem] font-medium",
      md: "px-2 py-0.5 text-xs",
    },
  },
  defaultVariants: { tone: "neutral", size: "sm" },
});

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>["tone"]>;

export function Badge({ tone, size, className, ...props }: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ tone, size }), className)} {...props} />;
}
