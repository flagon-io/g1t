import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { Select as Primitive } from "radix-ui";
import { type ComponentProps, type ReactNode, useState } from "react";

import { cn } from "../../lib/cn";

// shadcn/ui's select, styled with g1t's tokens.
//
// Inside a <Form>, give <Select> a `name` and Radix renders a hidden native
// <select> beside the trigger, so the value posts like any other field.
// An item's value can never be "": use a word such as "none" and map it.

export const Select = Primitive.Root;
export const SelectGroup = Primitive.Group;
export const SelectValue = Primitive.Value;

const TRIGGER_SIZES = { sm: "h-8 px-2.5 text-[0.8125rem]", default: "h-9", lg: "h-11" };

/** The control people see: the chosen value, or the placeholder, and a chevron. */
export function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: ComponentProps<typeof Primitive.Trigger> & { size?: "sm" | "default" | "lg" }) {
  return (
    <Primitive.Trigger
      data-size={size}
      className={cn(
        "group/select flex w-full min-w-0 items-center justify-between gap-2 rounded-md border border-line bg-bg px-3 text-left text-sm whitespace-nowrap text-fg outline-none transition-colors",
        TRIGGER_SIZES[size],
        "hover:border-line-strong focus-visible:border-accent-dim focus-visible:ring-2 focus-visible:ring-accent/25 focus-visible:outline-none",
        "data-[state=open]:border-accent-dim data-[state=open]:ring-2 data-[state=open]:ring-accent/25",
        "data-placeholder:text-faint aria-invalid:border-danger/70",
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-line",
        "[&>span]:flex [&>span]:min-w-0 [&>span]:items-center [&>span]:gap-2 [&>span]:truncate",
        "[&_svg]:shrink-0",
        className,
      )}
      {...props}
    >
      {children}
      <Primitive.Icon asChild>
        <ChevronDown
          size={15}
          className="text-faint transition-transform duration-200 group-data-[state=open]/select:rotate-180"
        />
      </Primitive.Icon>
    </Primitive.Trigger>
  );
}

export function SelectContent({
  className,
  children,
  position = "popper",
  sideOffset = 6,
  ...props
}: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        position={position}
        sideOffset={position === "popper" ? sideOffset : undefined}
        className={cn(
          "relative z-50 max-h-(--radix-select-content-available-height) min-w-36 overflow-hidden rounded-lg border border-line-strong bg-raised text-sm text-fg shadow-xl shadow-black/40",
          "origin-(--radix-select-content-transform-origin) data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out motion-reduce:animate-none",
          position === "popper" && "min-w-(--radix-select-trigger-width) max-w-[calc(100vw-2rem)]",
          className,
        )}
        {...props}
      >
        <SelectScrollUpButton />
        <Primitive.Viewport
          className={cn("p-1", position === "popper" && "max-h-80 scroll-my-1")}
        >
          {children}
        </Primitive.Viewport>
        <SelectScrollDownButton />
      </Primitive.Content>
    </Primitive.Portal>
  );
}

export function SelectLabel({ className, ...props }: ComponentProps<typeof Primitive.Label>) {
  return (
    <Primitive.Label
      className={cn("px-2 pt-2 pb-1 text-[0.6875rem] font-medium tracking-wide text-faint uppercase", className)}
      {...props}
    />
  );
}

/**
 * One option. `icon` (an icon or an avatar) and the label show in the
 * trigger once chosen; `description` shows only in the list.
 */
export function SelectItem({
  className,
  children,
  icon,
  description,
  ...props
}: ComponentProps<typeof Primitive.Item> & { icon?: ReactNode; description?: ReactNode }) {
  return (
    <Primitive.Item
      className={cn(
        "relative flex w-full cursor-default items-start gap-2 rounded-md py-1.5 pr-8 pl-2 text-fg/90 outline-none select-none",
        "data-highlighted:bg-line data-highlighted:text-fg data-disabled:pointer-events-none data-disabled:opacity-45",
        "data-[state=checked]:text-fg",
        className,
      )}
      {...props}
    >
      <span className="flex min-w-0 flex-col">
        <Primitive.ItemText>
          <span className="flex min-w-0 items-center gap-2 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted">
            {icon}
            <span className="truncate">{children}</span>
          </span>
        </Primitive.ItemText>
        {description && (
          <span className={cn("mt-0.5 text-xs leading-snug text-faint", icon != null && "pl-6")}>{description}</span>
        )}
      </span>
      <span className="absolute top-2 right-2 flex size-4 items-center justify-center">
        <Primitive.ItemIndicator>
          <Check size={14} className="text-accent" />
        </Primitive.ItemIndicator>
      </span>
    </Primitive.Item>
  );
}

export function SelectSeparator({ className, ...props }: ComponentProps<typeof Primitive.Separator>) {
  return <Primitive.Separator className={cn("-mx-1 my-1 h-px bg-line", className)} {...props} />;
}

export function SelectScrollUpButton({ className, ...props }: ComponentProps<typeof Primitive.ScrollUpButton>) {
  return (
    <Primitive.ScrollUpButton
      className={cn("flex cursor-default items-center justify-center py-1 text-faint", className)}
      {...props}
    >
      <ChevronUp size={14} />
    </Primitive.ScrollUpButton>
  );
}

export function SelectScrollDownButton({ className, ...props }: ComponentProps<typeof Primitive.ScrollDownButton>) {
  return (
    <Primitive.ScrollDownButton
      className={cn("flex cursor-default items-center justify-center py-1 text-faint", className)}
      {...props}
    >
      <ChevronDown size={14} />
    </Primitive.ScrollDownButton>
  );
}

export type SelectOption = { value: string; label: ReactNode; disabled?: boolean; description?: ReactNode; icon?: ReactNode };

/** Radix items cannot have "" as a value; this stands in for it inside. */
const EMPTY = "__g1t_empty__";
const inside = (value: string | undefined) => (value === "" ? EMPTY : value);
const outside = (value: string) => (value === EMPTY ? "" : value);

/**
 * A select for what used to be a native <select>: a list of options, posted
 * by `name` with its form. Options may have "" as their value (Any, None),
 * which posts "" as a native select would. `onValueChange` sees the new
 * value at once; `afterChange` runs once the form's fields hold it, so it
 * can submit the form (filters that apply as they change).
 */
export function SelectField({
  options,
  name,
  form,
  value,
  defaultValue,
  onValueChange,
  afterChange,
  placeholder,
  required,
  disabled,
  size,
  id,
  className,
  contentClassName,
  itemClassName,
  align,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: {
  options: SelectOption[];
  name?: string;
  form?: string;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  afterChange?: (value: string) => void;
  placeholder?: ReactNode;
  required?: boolean;
  disabled?: boolean;
  size?: "sm" | "default" | "lg";
  id?: string;
  className?: string;
  contentClassName?: string;
  itemClassName?: string;
  align?: "start" | "center" | "end";
  "aria-label"?: string;
  "aria-labelledby"?: string;
}) {
  const [own, setOwn] = useState(defaultValue);
  const current = value !== undefined ? value : own;
  // With a "" option, a hidden input posts the value, so "" posts as "".
  const empty = options.some((option) => option.value === "");
  return (
    <>
      <Select
        value={(empty ? inside(current) : current) ?? ""}
        onValueChange={(next) => {
          const chosen = outside(next);
          setOwn(chosen);
          onValueChange?.(chosen);
          if (afterChange) setTimeout(() => afterChange(chosen), 0);
        }}
        name={empty ? undefined : name}
        form={empty ? undefined : form}
        required={required}
        disabled={disabled}
      >
        <SelectTrigger id={id} size={size} aria-label={ariaLabel} aria-labelledby={ariaLabelledBy} className={className}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent className={contentClassName} align={align}>
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={inside(option.value)!}
              disabled={option.disabled}
              description={option.description}
              icon={option.icon}
              className={itemClassName}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {empty && name && <input type="hidden" name={name} form={form} value={current ?? ""} disabled={disabled} />}
    </>
  );
}
