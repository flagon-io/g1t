import type { ComponentProps } from "react";

import { cn } from "../../lib/cn";

// shadcn/ui's table, styled with g1t's tokens. The table sits in a frame
// that scrolls sideways on its own, so a wide one never widens the page;
// the frame takes focus when it has to scroll, for the keyboard.

export function Table({ className, frameProps, ...props }: Omit<ComponentProps<"table">, "frame"> & { frameProps?: ComponentProps<"div"> }) {
  return (
    <div
      data-slot="table-frame"
      {...frameProps}
      className={cn("relative w-full overflow-x-auto outline-none [scrollbar-width:thin] focus-visible:ring-2 focus-visible:ring-accent", frameProps?.className)}
    >
      <table data-slot="table" className={cn("w-full caption-bottom border-collapse text-sm", className)} {...props} />
    </div>
  );
}

export function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("bg-surface [&_tr]:border-b [&_tr]:border-line", className)} {...props} />;
}

export function TableBody({ className, ...props }: ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

export function TableRow({ className, ...props }: ComponentProps<"tr">) {
  return <tr data-slot="table-row" className={cn("border-b border-line transition-colors data-[state=selected]:bg-raised", className)} {...props} />;
}

export function TableHead({ className, ...props }: ComponentProps<"th">) {
  return <th data-slot="table-head" className={cn("h-9 px-3 text-left align-middle font-medium whitespace-nowrap text-muted", className)} {...props} />;
}

export function TableCell({ className, ...props }: ComponentProps<"td">) {
  return <td data-slot="table-cell" className={cn("px-3 py-2 align-top", className)} {...props} />;
}

export function TableCaption({ className, ...props }: ComponentProps<"caption">) {
  return <caption data-slot="table-caption" className={cn("mt-3 text-xs text-faint", className)} {...props} />;
}
