import { Check, Minus } from "lucide-react";
import { Checkbox as Primitive } from "radix-ui";
import { type ComponentProps, type ReactNode, useId } from "react";

import { cn } from "../../lib/cn";

// shadcn/ui's checkbox, styled with g1t's tokens.
//
// Inside a <Form>, a `name` makes Radix render a hidden checkbox beside it,
// so it posts `value` (default "on") when checked and nothing when not,
// exactly as a native one does. Wrap it and its text in a <label>, or point
// a <Label htmlFor> at its `id`.

/** A checkbox with its label, and optionally a line under it. */
export function CheckboxOption({
  label,
  description,
  className,
  labelClassName,
  ...props
}: ComponentProps<typeof Primitive.Root> & { label: ReactNode; description?: ReactNode; labelClassName?: string }) {
  const generated = useId();
  const id = props.id ?? generated;
  return (
    <div className={cn("flex items-start gap-2.5", props.disabled && "opacity-60", className)}>
      <Checkbox id={id} className={className?.includes("items-center") ? undefined : "mt-0.5"} aria-describedby={description ? `${id}-d` : undefined} {...props} />
      <label htmlFor={id} className={cn("min-w-0 text-sm text-fg", props.disabled ? "cursor-not-allowed" : "cursor-pointer", labelClassName)}>
        {label}
        {description && (
          <span id={`${id}-d`} className="mt-0.5 block text-xs text-faint">
            {description}
          </span>
        )}
      </label>
    </div>
  );
}

export function Checkbox({ className, ...props }: ComponentProps<typeof Primitive.Root>) {
  return (
    <Primitive.Root
      className={cn(
        "peer inline-flex size-4 shrink-0 items-center justify-center rounded-[5px] border border-line-strong bg-bg text-bg outline-none transition-colors",
        "hover:border-faint focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-1 focus-visible:ring-offset-bg focus-visible:outline-none",
        "data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent",
        "disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger/70",
        className,
      )}
      {...props}
    >
      <Primitive.Indicator className="flex items-center justify-center data-[state=checked]:animate-pop-in motion-reduce:animate-none">
        {props.checked === "indeterminate" ? (
          <Minus size={12} strokeWidth={3} />
        ) : (
          <Check size={12} strokeWidth={3} />
        )}
      </Primitive.Indicator>
    </Primitive.Root>
  );
}
