import { type VariantProps, cva } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "../../lib/cn";

// shadcn/ui's card, styled with g1t's tokens: the rounded panel every
// section of the site sits in. It has no padding of its own: a card that
// is one block of text takes `p-4` (or `p-5` for a settings section); one
// that is a list of rows is `divided`, each row with its own padding. `tone`
// says what it stands on: `surface` (the default) is a step up from the
// page, `plain` keeps the page's own background for a card inside a card,
// `bg` sinks to the page's. `asChild` puts the panel on a <section>, an
// <article> or a <Link>.

export const cardVariants = cva("border border-line", {
  variants: {
    tone: {
      surface: "bg-surface",
      plain: "",
      bg: "bg-bg",
    },
    radius: {
      xl: "rounded-xl",
      lg: "rounded-lg",
    },
    divided: {
      true: "divide-y divide-line",
    },
  },
  defaultVariants: { tone: "surface", radius: "xl" },
});

export type CardProps = ComponentProps<"div"> & VariantProps<typeof cardVariants> & { asChild?: boolean };

export function Card({ className, tone, radius, divided, asChild = false, ...props }: CardProps) {
  const Comp = asChild ? Slot.Root : "div";
  return <Comp data-slot="card" className={cn(cardVariants({ tone, radius, divided }), className)} {...props} />;
}

export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-header" className={cn("flex flex-col gap-1 p-4", className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<"h2">) {
  return <h2 data-slot="card-title" className={cn("text-sm font-medium", className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return <p data-slot="card-description" className={cn("text-sm text-muted", className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("p-4", className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-footer" className={cn("flex items-center gap-2 p-4", className)} {...props} />;
}
