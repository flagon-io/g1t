import { ScrollArea as Primitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "../../lib/cn";

// shadcn/ui's scroll area, styled with g1t's tokens: a box that scrolls
// with a thin bar of its own, the same on every platform, for a list in a
// panel or a sidebar. Plain `overflow-y-auto` with `[scrollbar-width:thin]`
// does for most of the site; this is for where the bar must sit inside
// rounded corners or stay out of the way until hovered.

export function ScrollArea({ className, children, ...props }: ComponentProps<typeof Primitive.Root>) {
  return (
    <Primitive.Root data-slot="scroll-area" className={cn("relative overflow-hidden", className)} {...props}>
      <Primitive.Viewport data-slot="scroll-area-viewport" className="size-full rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-accent">
        {children}
      </Primitive.Viewport>
      <ScrollBar />
      <Primitive.Corner />
    </Primitive.Root>
  );
}

export function ScrollBar({ className, orientation = "vertical", ...props }: ComponentProps<typeof Primitive.Scrollbar>) {
  return (
    <Primitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        "flex touch-none p-px transition-colors select-none",
        orientation === "vertical" && "h-full w-2 border-l border-l-transparent",
        orientation === "horizontal" && "h-2 flex-col border-t border-t-transparent",
        className,
      )}
      {...props}
    >
      <Primitive.Thumb data-slot="scroll-area-thumb" className="relative flex-1 rounded-full bg-line-strong" />
    </Primitive.Scrollbar>
  );
}
