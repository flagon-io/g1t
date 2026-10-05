import { Switch as Primitive } from "radix-ui";
import { type ComponentProps, type ReactNode, useId } from "react";

import { cn } from "../../lib/cn";

// shadcn/ui's switch, styled with g1t's tokens. Like a checkbox, inside a
// <Form> a `name` posts `value` (default "on") when on and nothing when off.

export function Switch({
  className,
  size = "default",
  ...props
}: ComponentProps<typeof Primitive.Root> & { size?: "sm" | "default" }) {
  return (
    <Primitive.Root
      data-size={size}
      className={cn(
        "peer group/switch inline-flex shrink-0 items-center rounded-full border border-transparent p-px outline-none transition-colors",
        "data-[size=default]:h-5 data-[size=default]:w-9 data-[size=sm]:h-4 data-[size=sm]:w-7",
        "bg-line-strong data-[state=checked]:bg-accent",
        "focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-1 focus-visible:ring-offset-bg focus-visible:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <Primitive.Thumb
        className={cn(
          "pointer-events-none block rounded-full bg-fg shadow-sm ring-0 transition-transform duration-200",
          "group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3",
          "data-[state=unchecked]:translate-x-0 group-data-[size=default]/switch:data-[state=checked]:translate-x-4 group-data-[size=sm]/switch:data-[state=checked]:translate-x-3",
        )}
      />
    </Primitive.Root>
  );
}

/**
 * A setting that is on or off, as a card: a title, what it means, and the
 * switch. The whole card toggles it.
 */
export function SwitchCard({
  title,
  children,
  className,
  ...props
}: ComponentProps<typeof Primitive.Root> & { title: ReactNode; children?: ReactNode }) {
  const generated = useId();
  const id = props.id ?? generated;
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex cursor-pointer items-start justify-between gap-4 rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line-strong",
        "has-[[data-state=checked]]:border-accent/40 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60",
        className,
      )}
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium text-fg">{title}</span>
        {children && <span className="mt-1 block text-sm text-muted">{children}</span>}
      </span>
      <Switch id={id} className="mt-0.5" {...props} />
    </label>
  );
}
