import { Tabs as Primitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "../../lib/cn";

// shadcn/ui's tabs, styled with g1t's tokens. `variant="rail"` lays the
// list out as a column of steps, each trigger a full-width row with room
// for an icon and a line under its title (Getting started's step rail);
// give the Tabs `orientation="vertical"` so the arrow keys go up and down.

type Variant = "default" | "rail";

export const Tabs = Primitive.Root;

const LISTS: Record<Variant, string> = {
  default: "inline-flex items-center gap-1 rounded-lg border border-line bg-bg p-1",
  rail: "flex flex-col items-stretch gap-0.5",
};

const TRIGGERS: Record<Variant, string> = {
  default: cn(
    "rounded-md px-2.5 py-1 text-xs font-medium text-muted transition-colors outline-none hover:text-fg",
    "data-[state=active]:bg-raised data-[state=active]:text-fg",
    "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-muted",
  ),
  rail: cn(
    "flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-muted transition-colors outline-none",
    "hover:bg-raised/60 hover:text-fg focus-visible:ring-1 focus-visible:ring-accent/40 focus-visible:ring-inset",
    "data-[state=active]:bg-raised data-[state=active]:text-fg",
  ),
};

export function TabsList({
  className,
  variant = "default",
  ...props
}: ComponentProps<typeof Primitive.List> & { variant?: Variant }) {
  return <Primitive.List className={cn(LISTS[variant], className)} {...props} />;
}

export function TabsTrigger({
  className,
  variant = "default",
  ...props
}: ComponentProps<typeof Primitive.Trigger> & { variant?: Variant }) {
  return <Primitive.Trigger className={cn(TRIGGERS[variant], className)} {...props} />;
}

export function TabsContent({
  className,
  ...props
}: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Content className={cn("mt-3 outline-none", className)} {...props} />
  );
}
