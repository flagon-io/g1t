import { Progress as Primitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "../../lib/cn";

// shadcn/ui's progress, styled with g1t's tokens: how far along something
// is, as a bar in `line` filled to `value` percent. The fill is the accent
// unless a `tone` class such as `bg-success` is passed in `indicatorClassName`.

export function Progress({
  className,
  indicatorClassName,
  value,
  ...props
}: ComponentProps<typeof Primitive.Root> & { indicatorClassName?: string }) {
  return (
    <Primitive.Root
      data-slot="progress"
      value={value}
      className={cn("relative block h-2 w-full overflow-hidden rounded-full bg-line", className)}
      {...props}
    >
      <Primitive.Indicator
        data-slot="progress-indicator"
        className={cn("block h-full rounded-full bg-accent transition-[width]", indicatorClassName)}
        style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%` }}
      />
    </Primitive.Root>
  );
}
