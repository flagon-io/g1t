import { Collapsible as Primitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "../../lib/cn";

// shadcn/ui's collapsible, styled with g1t's tokens: a region that opens
// and closes under a trigger, for a panel whose state a page controls
// (`open`/`onOpenChange`). A disclosure that should work before the page
// hydrates, such as a section of a long form, stays a native <details>.

export const Collapsible = Primitive.Root;

export function CollapsibleTrigger({ className, ...props }: ComponentProps<typeof Primitive.Trigger>) {
  return (
    <Primitive.Trigger
      data-slot="collapsible-trigger"
      className={cn("group/collapsible inline-flex items-center gap-1.5 text-sm text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent [&_svg]:transition-transform data-[state=open]:[&_svg]:rotate-90", className)}
      {...props}
    />
  );
}

export function CollapsibleContent({ className, ...props }: ComponentProps<typeof Primitive.Content>) {
  return <Primitive.Content data-slot="collapsible-content" className={cn("outline-none", className)} {...props} />;
}
