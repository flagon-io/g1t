import { Command as Cmdk } from "cmdk";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { type ComponentProps, type ReactNode, useState } from "react";

import { cn } from "../../lib/cn";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

// shadcn/ui's command menu and combobox, styled with g1t's tokens: a select
// with a search box, for lists too long to scroll. A `name` posts the
// chosen value from a hidden input, so it works in a plain <Form>.

export function Command({ className, ...props }: ComponentProps<typeof Cmdk>) {
  return <Cmdk className={cn("flex w-full flex-col overflow-hidden text-sm text-fg", className)} {...props} />;
}

export function CommandInput({ className, ...props }: ComponentProps<typeof Cmdk.Input>) {
  return (
    <div className="flex items-center gap-2 border-b border-line px-3" cmdk-input-wrapper="">
      <Search size={14} className="shrink-0 text-faint" />
      <Cmdk.Input
        className={cn("h-10 w-full bg-transparent text-sm outline-none placeholder:text-faint focus-visible:outline-none", className)}
        {...props}
      />
    </div>
  );
}

export function CommandList({ className, ...props }: ComponentProps<typeof Cmdk.List>) {
  return <Cmdk.List className={cn("max-h-72 scroll-py-1 overflow-x-hidden overflow-y-auto p-1", className)} {...props} />;
}

export function CommandEmpty({ className, ...props }: ComponentProps<typeof Cmdk.Empty>) {
  return <Cmdk.Empty className={cn("py-6 text-center text-sm text-faint", className)} {...props} />;
}

export function CommandGroup({ className, ...props }: ComponentProps<typeof Cmdk.Group>) {
  return (
    <Cmdk.Group
      className={cn(
        "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[0.6875rem] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-faint [&_[cmdk-group-heading]]:uppercase",
        className,
      )}
      {...props}
    />
  );
}

export function CommandSeparator({ className, ...props }: ComponentProps<typeof Cmdk.Separator>) {
  return <Cmdk.Separator className={cn("-mx-1 my-1 h-px bg-line", className)} {...props} />;
}

export function CommandItem({ className, ...props }: ComponentProps<typeof Cmdk.Item>) {
  return (
    <Cmdk.Item
      className={cn(
        "relative flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-fg/90 outline-none select-none",
        "data-[selected=true]:bg-line data-[selected=true]:text-fg data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-45",
        "[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted",
        className,
      )}
      {...props}
    />
  );
}

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
            "group/combobox flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-line bg-bg px-3 text-left text-sm text-fg outline-none transition-colors",
            "hover:border-line-strong focus-visible:border-accent-dim focus-visible:ring-2 focus-visible:ring-accent/25 focus-visible:outline-none",
            "data-[state=open]:border-accent-dim data-[state=open]:ring-2 data-[state=open]:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
        >
          <span className={cn("flex min-w-0 items-center gap-2 truncate [&_svg]:size-4 [&_svg]:shrink-0", !chosen && "text-faint")}>
            {chosen?.icon}
            <span className="truncate">{chosen ? chosen.label : placeholder}</span>
          </span>
          <ChevronsUpDown size={14} className="shrink-0 text-faint" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-60 p-0">
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
                  {option.description && (
                    <span className={cn("mt-0.5 text-xs text-faint", option.icon != null && "pl-6")}>{option.description}</span>
                  )}
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
