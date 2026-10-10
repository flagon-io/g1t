import type { ComponentProps } from "react";

import { cn } from "../../lib/cn";

// shadcn/ui's kbd, styled with g1t's tokens: a key, as a small raised cap
// in the text's own size and colour. `KbdGroup` holds a chord such as Ctrl K.

export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return <kbd data-slot="kbd" className={cn("rounded bg-raised px-1 font-mono ring-1 ring-line", className)} {...props} />;
}

export function KbdGroup({ className, ...props }: ComponentProps<"span">) {
  return <span data-slot="kbd-group" className={cn("inline-flex items-center gap-1", className)} {...props} />;
}
