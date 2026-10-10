import { ToggleGroup as Primitive } from "radix-ui";
import { type ComponentProps, createContext, useContext } from "react";

import { cn } from "../../lib/cn";

// shadcn/ui's toggle group, styled with g1t's tokens: a row of choices of
// which one (type="single") or several (type="multiple") are pressed, drawn
// as one segmented control. The group's size and variant reach its items.

type Variant = "default" | "outline";
type Size = "sm" | "default";

const GroupContext = createContext<{ variant: Variant; size: Size }>({ variant: "default", size: "default" });

export function ToggleGroup({
  className,
  variant = "default",
  size = "default",
  children,
  ...props
}: ComponentProps<typeof Primitive.Root> & { variant?: Variant; size?: Size }) {
  return (
    <Primitive.Root
      data-variant={variant}
      data-size={size}
      className={cn("group/toggle-group inline-flex max-w-full flex-wrap items-center rounded-md", variant === "outline" && "border border-line bg-bg", className)}
      {...props}
    >
      <GroupContext.Provider value={{ variant, size }}>{children}</GroupContext.Provider>
    </Primitive.Root>
  );
}

const SIZES: Record<Size, string> = { sm: "h-7 min-w-7 px-2 text-xs", default: "h-8 min-w-8 px-2.5 text-[0.8125rem]" };

export function ToggleGroupItem({ className, children, variant, size, ...props }: ComponentProps<typeof Primitive.Item> & { variant?: Variant; size?: Size }) {
  const group = useContext(GroupContext);
  const v = variant ?? group.variant;
  return (
    <Primitive.Item
      data-variant={v}
      data-size={size ?? group.size}
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-1.5 font-medium whitespace-nowrap text-muted outline-none transition-colors select-none",
        "hover:bg-raised hover:text-fg focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-accent/40",
        "disabled:pointer-events-none disabled:opacity-50",
        "data-[state=on]:bg-accent/15 data-[state=on]:text-accent",
        "[&_svg]:size-3.5 [&_svg]:shrink-0",
        SIZES[size ?? group.size],
        v === "outline"
          ? "rounded-none border-l border-line first:rounded-l-[5px] first:border-l-0 last:rounded-r-[5px]"
          : "rounded-md",
        className,
      )}
      {...props}
    >
      {children}
    </Primitive.Item>
  );
}
