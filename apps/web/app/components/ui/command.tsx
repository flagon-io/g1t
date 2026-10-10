import { Command as Cmdk } from "cmdk";
import { Search } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "../../lib/cn";

// shadcn/ui's command menu (cmdk), styled with g1t's tokens: a searchable list
// for the palette and the combobox. The combobox in ./combobox wraps it in
// a popover.

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
