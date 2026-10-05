import { Tooltip as Primitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "../../lib/cn";

// shadcn/ui's tooltip, styled with g1t's tokens. Each tooltip carries its
// own provider, so one can be dropped in anywhere without setup.

export function TooltipProvider({ delayDuration = 200, ...props }: ComponentProps<typeof Primitive.Provider>) {
  return <Primitive.Provider delayDuration={delayDuration} {...props} />;
}

export function Tooltip(props: ComponentProps<typeof Primitive.Root>) {
  return (
    <TooltipProvider>
      <Primitive.Root {...props} />
    </TooltipProvider>
  );
}

export const TooltipTrigger = Primitive.Trigger;

export function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        sideOffset={sideOffset}
        className={cn(
          "z-50 max-w-xs rounded-md border border-line-strong bg-raised px-2.5 py-1.5 text-xs text-fg shadow-lg shadow-black/40",
          "origin-(--radix-tooltip-content-transform-origin) animate-pop-in data-[state=closed]:animate-pop-out motion-reduce:animate-none",
          className,
        )}
        {...props}
      >
        {children}
        <Primitive.Arrow className="fill-raised" width={10} height={5} />
      </Primitive.Content>
    </Primitive.Portal>
  );
}
