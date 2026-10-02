import { Tabs as Primitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "../../lib/cn";

// shadcn/ui's tabs, styled with g1t's tokens.

export const Tabs = Primitive.Root;

export function TabsList({
  className,
  ...props
}: ComponentProps<typeof Primitive.List>) {
  return (
    <Primitive.List
      className={cn(
        "inline-flex items-center gap-1 rounded-lg border border-line bg-bg p-1",
        className,
      )}
      {...props}
    />
  );
}

export function TabsTrigger({
  className,
  ...props
}: ComponentProps<typeof Primitive.Trigger>) {
  return (
    <Primitive.Trigger
      className={cn(
        "rounded-md px-2.5 py-1 text-xs font-medium text-muted transition-colors outline-none hover:text-fg",
        "data-[state=active]:bg-raised data-[state=active]:text-fg",
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-muted",
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({
  className,
  ...props
}: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Content className={cn("mt-3 outline-none", className)} {...props} />
  );
}
