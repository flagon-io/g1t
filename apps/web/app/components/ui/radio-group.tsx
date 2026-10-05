import { RadioGroup as Primitive } from "radix-ui";
import { type ComponentProps, type ReactNode, useId } from "react";

import { cn } from "../../lib/cn";

// shadcn/ui's radio group, styled with g1t's tokens, in two shapes:
//
// - compact: <RadioOption> rows, a dot and a line of text each;
// - cards:   <RadioCard> tiles, an icon, a title and a description each.
//
// Inside a <Form>, the group's `name` makes Radix render a hidden radio per
// item, so the chosen `value` posts exactly as native radios do. The arrow
// keys move between items and choose as they go; disabled items are skipped.

export function RadioGroup({ className, ...props }: ComponentProps<typeof Primitive.Root>) {
  return <Primitive.Root className={cn("grid gap-2", className)} {...props} />;
}

/** The bare dot. */
export function RadioGroupItem({ className, ...props }: ComponentProps<typeof Primitive.Item>) {
  return (
    <Primitive.Item
      className={cn(
        "peer relative inline-flex size-4 shrink-0 items-center justify-center rounded-full border border-line-strong bg-bg outline-none transition-colors",
        "hover:border-faint focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-1 focus-visible:ring-offset-bg focus-visible:outline-none",
        "data-[state=checked]:border-accent disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <Primitive.Indicator className="size-2 rounded-full bg-accent data-[state=checked]:animate-pop-in motion-reduce:animate-none" />
    </Primitive.Item>
  );
}

/** A compact choice: the dot, a label, and optionally a line under it. */
export function RadioOption({
  value,
  label,
  description,
  icon,
  disabled,
  className,
}: {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn("flex items-start gap-2.5", disabled && "opacity-60", className)}>
      <RadioGroupItem value={value} id={id} disabled={disabled} className="mt-0.5" aria-describedby={description ? `${id}-d` : undefined} />
      <label htmlFor={id} className={cn("min-w-0 text-sm", disabled ? "cursor-not-allowed" : "cursor-pointer")}>
        <span className="flex items-center gap-1.5 text-fg [&_svg]:size-3.5 [&_svg]:text-muted">
          {icon}
          {label}
        </span>
        {description && (
          <span id={`${id}-d`} className="mt-0.5 block text-xs text-muted">
            {description}
          </span>
        )}
      </label>
    </div>
  );
}

/**
 * A big selectable card. The whole card is the radio: it takes focus, and
 * Space or a click chooses it. `badge` replaces the dot (for "Soon").
 */
export function RadioCard({
  value,
  title,
  description,
  icon,
  badge,
  disabled,
  className,
  children,
}: {
  value: string;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
  disabled?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <Primitive.Item
      value={value}
      disabled={disabled}
      aria-labelledby={`${id}-t`}
      aria-describedby={description ? `${id}-d` : undefined}
      className={cn(
        "group/card relative flex h-full w-full flex-col items-start rounded-xl border border-line bg-surface/40 p-4 text-left outline-none transition-[border-color,background-color,box-shadow] duration-150",
        "hover:border-line-strong hover:bg-surface",
        "focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-bg focus-visible:outline-none",
        "data-[state=checked]:border-accent/70 data-[state=checked]:bg-accent/[0.06] data-[state=checked]:shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-accent)_35%,transparent),0_8px_24px_-12px_color-mix(in_srgb,var(--color-accent)_40%,transparent)]",
        "disabled:cursor-not-allowed disabled:border-dashed disabled:bg-transparent disabled:opacity-60 disabled:hover:border-line",
        className,
      )}
    >
      <span className="flex w-full items-start justify-between gap-3">
        {icon && (
          <span className="flex size-8 items-center justify-center rounded-lg bg-raised text-muted ring-1 ring-line transition-colors group-data-[state=checked]/card:bg-accent/10 group-data-[state=checked]/card:text-accent group-data-[state=checked]/card:ring-accent/30 [&_svg]:size-4">
            {icon}
          </span>
        )}
        {badge ? (
          <span className="ml-auto rounded-full bg-raised px-2 py-0.5 text-[0.6875rem] text-muted ring-1 ring-line">{badge}</span>
        ) : (
          <span
            aria-hidden="true"
            className="ml-auto flex size-4 items-center justify-center rounded-full border border-line-strong transition-colors group-data-[state=checked]/card:border-accent"
          >
            <span className="size-2 scale-0 rounded-full bg-accent transition-transform duration-150 group-data-[state=checked]/card:scale-100" />
          </span>
        )}
      </span>
      <span id={`${id}-t`} className={cn("block text-sm font-medium text-fg", icon && "mt-3")}>
        {title}
      </span>
      {description && (
        <span id={`${id}-d`} className="mt-1 block text-xs leading-relaxed text-muted">
          {description}
        </span>
      )}
      {children}
    </Primitive.Item>
  );
}
