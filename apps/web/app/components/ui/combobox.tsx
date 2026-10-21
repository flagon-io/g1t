import { Check, ChevronsUpDown } from "lucide-react";
import { type ReactNode, useState } from "react";

import { cn } from "../../lib/cn";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "./command";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

// shadcn/ui's combobox, styled with g1t's tokens: a select with a search
// box, for lists too long to scroll. A `name` posts the chosen value from a
// hidden input, so it works in a plain <Form>.

export type ComboboxOption = {
  value: string;
  label: string;
  description?: ReactNode;
  icon?: ReactNode;
  /** More words that should find it. */
  keywords?: string[];
  disabled?: boolean;
};

/** A searchable select. Controlled with `value`, or not with `defaultValue`. */
export function Combobox({
  options,
  value: controlled,
  defaultValue = "",
  onValueChange,
  name,
  disabled,
  placeholder = "Choose…",
  searchPlaceholder = "Search…",
  emptyText = "Nothing matches.",
  id,
  className,
  variant = "field",
  "aria-label": ariaLabel,
}: {
  options: ComboboxOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  name?: string;
  disabled?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  id?: string;
  className?: string;
  /** `field`, a form's select; `pill`, a compact chip in a composer's toolbar (components/chat/agent-composer.tsx). */
  variant?: "field" | "pill";
  "aria-label"?: string;
}) {
  const [open, setOpen] = useState(false);
  const [uncontrolled, setUncontrolled] = useState(defaultValue);
  const value = controlled ?? uncontrolled;
  const chosen = options.find((option) => option.value === value);
  const choose = (next: string) => {
    setUncontrolled(next);
    onValueChange?.(next);
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {name && <input type="hidden" name={name} value={value} />}
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn(
            variant === "pill"
              ? [
                  "group/combobox flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-full px-2.5 text-left text-xs font-medium text-muted outline-none transition-colors",
                  "hover:bg-raised hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/40 data-[state=open]:bg-raised data-[state=open]:text-fg",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                ]
              : [
                  "group/combobox flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-line bg-bg px-3 text-left text-sm text-fg outline-none transition-colors",
                  "hover:border-line-strong focus-visible:border-accent-dim focus-visible:ring-2 focus-visible:ring-accent/25 focus-visible:outline-none",
                  "data-[state=open]:border-accent-dim data-[state=open]:ring-2 data-[state=open]:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-50",
                ],
            className,
          )}
        >
          <span
            className={cn(
              "flex min-w-0 items-center truncate [&_svg]:shrink-0",
              variant === "pill" ? "gap-1.5 [&_svg]:size-3.5" : "gap-2 [&_svg]:size-4",
              !chosen && "text-faint",
            )}
          >
            {chosen?.icon}
            <span className="truncate">{chosen ? chosen.label : placeholder}</span>
          </span>
          <ChevronsUpDown size={variant === "pill" ? 12 : 14} className="shrink-0 text-faint" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className={cn("min-w-60 p-0", variant === "pill" ? "w-80 max-w-[calc(100vw-2rem)]" : "w-(--radix-popover-trigger-width)")}>
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            {options.map((option) => (
              <CommandItem
                key={option.value}
                value={option.value}
                keywords={[option.label, ...(option.keywords ?? [])]}
                disabled={option.disabled}
                onSelect={() => choose(option.value)}
                className="items-start pr-8"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="flex min-w-0 items-center gap-2">
                    {option.icon}
                    <span className="truncate">{option.label}</span>
                  </span>
                  {option.description && <span className={cn("mt-0.5 text-xs text-faint", option.icon != null && "pl-6")}>{option.description}</span>}
                </span>
                {option.value === value && <Check className="absolute top-2 right-2 size-3.5! text-accent!" />}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
