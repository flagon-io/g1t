import { type VariantProps, cva } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "../../lib/cn";

// shadcn/ui's button, styled with g1t's tokens. `asChild` puts its look on
// a <Link> or a menu's trigger. The older `Button` in ./index stays until
// its callers move here.
//
// Sizes: `default` 36px, `sm` 32px, `lg` 40px; the icon sizes are squares
// of the same. `bar` is the top bar's: 32px on a computer, 44px to a finger
// on a phone, and `icon-bar` its square.

export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap outline-none transition-[color,background-color,border-color,box-shadow] focus-visible:ring-2 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-fg text-bg hover:bg-fg-hover",
        accent: "bg-accent text-bg hover:bg-accent-hover",
        outline: "border border-line bg-bg text-fg/90 hover:border-line-strong hover:bg-surface hover:text-fg",
        secondary: "bg-raised text-fg hover:bg-raised/80",
        ghost: "text-muted hover:bg-raised hover:text-fg data-[state=open]:bg-raised data-[state=open]:text-fg aria-pressed:bg-raised aria-pressed:text-fg",
        // The accent as a wash: the one tinted control in a row, such as Ask g1t.
        soft: "bg-accent/10 text-fg ring-1 ring-accent/20 ring-inset hover:bg-accent/15 hover:ring-accent/35",
        destructive: "border border-danger/40 text-danger hover:border-danger hover:bg-danger/10",
        link: "text-accent underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-3.5",
        sm: "h-8 gap-1.5 px-2.5 text-[0.8125rem]",
        lg: "h-10 px-5",
        bar: "h-8 gap-1.5 px-2 text-[0.8125rem] max-md:h-11 max-md:min-w-11",
        icon: "size-9",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
        "icon-bar": "size-8 max-md:size-11",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export type ButtonProps = ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean };

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
