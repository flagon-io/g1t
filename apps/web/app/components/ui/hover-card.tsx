import { HoverCard as Primitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "../../lib/cn";

// shadcn/ui's hover card, styled with g1t's tokens. It opens on hover and
// keyboard focus, never on touch: a tap on its trigger does what the
// trigger does. Hover hints (a label, nothing more) use the Tooltip.

export function HoverCard({ openDelay = 450, closeDelay = 150, ...props }: ComponentProps<typeof Primitive.Root>) {
  return <Primitive.Root openDelay={openDelay} closeDelay={closeDelay} {...props} />;
}

export const HoverCardTrigger = Primitive.Trigger;

export function HoverCardContent({
  className,
  align = "start",
  sideOffset = 6,
  ...props
}: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={12}
        className={cn(
          "z-50 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-line-strong bg-raised p-4 text-sm text-fg shadow-xl shadow-black/40 outline-none",
          "origin-(--radix-hover-card-content-transform-origin) data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out motion-reduce:animate-none",
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  );
}
