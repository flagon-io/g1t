import { MoreHorizontal } from "lucide-react";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "../../lib/cn";

// shadcn/ui's breadcrumb, styled with g1t's tokens: where you are as a
// trail of links, the page you are on last and not a link of its own
// (BreadcrumbPage), with a quiet `/` between. `asChild` on a link puts its
// look on a router <Link>.

export function Breadcrumb(props: ComponentProps<"nav">) {
  return <nav aria-label="Breadcrumb" data-slot="breadcrumb" {...props} />;
}

export function BreadcrumbList({ className, ...props }: ComponentProps<"ol">) {
  return <ol data-slot="breadcrumb-list" className={cn("flex min-w-0 items-center gap-1 text-sm text-muted", className)} {...props} />;
}

export function BreadcrumbItem({ className, ...props }: ComponentProps<"li">) {
  return <li data-slot="breadcrumb-item" className={cn("inline-flex min-w-0 items-center gap-1", className)} {...props} />;
}

export function BreadcrumbLink({ asChild, className, ...props }: ComponentProps<"a"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "a";
  return (
    <Comp
      data-slot="breadcrumb-link"
      className={cn("truncate rounded-md px-1.5 py-1 outline-none transition-colors hover:bg-raised hover:text-fg focus-visible:ring-2 focus-visible:ring-accent", className)}
      {...props}
    />
  );
}

/** The page you are on: the trail's end, in the foreground. */
export function BreadcrumbPage({ asChild, className, ...props }: ComponentProps<"span"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span";
  return (
    <Comp
      data-slot="breadcrumb-page"
      aria-current="page"
      className={cn("truncate rounded-md px-1.5 py-1 font-medium text-fg outline-none focus-visible:ring-2 focus-visible:ring-accent", className)}
      {...props}
    />
  );
}

export function BreadcrumbSeparator({ children, className, ...props }: ComponentProps<"li">) {
  return (
    <li data-slot="breadcrumb-separator" role="presentation" aria-hidden="true" className={cn("text-line-strong select-none", className)} {...props}>
      {children ?? "/"}
    </li>
  );
}

export function BreadcrumbEllipsis({ className, ...props }: ComponentProps<"span">) {
  return (
    <span data-slot="breadcrumb-ellipsis" role="presentation" aria-hidden="true" className={cn("flex size-8 items-center justify-center", className)} {...props}>
      <MoreHorizontal size={16} />
      <span className="sr-only">More</span>
    </span>
  );
}
