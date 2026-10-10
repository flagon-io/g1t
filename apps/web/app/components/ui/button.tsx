import { type VariantProps, cva } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "../../lib/cn";

// shadcn/ui's button, styled with g1t's tokens: the one button. `asChild`
// puts its look on a <Link> or a menu's trigger; a form's submit button
// that says it is working is `SubmitButton` in ./index, and a link that
// looks like one is `ButtonLink` there, both drawn with `buttonVariants`.
//
// Variants: `default` is the plain dark-on-light (light-on-dark) button for
// the main action; `accent` the lavender one, for the one action a page
// is for; `outline` a bordered quiet one; `secondary` a raised one;
// `ghost` bare until hovered, for icons and toolbars; `soft` the accent as
// a wash, the one tinted control in a row, such as Ask g1t; `destructive`
// for what cannot be undone; `link` words alone.
//
// Sizes: `default` 36px, `sm` 32px, `xs` 28px, `lg` 40px; the icon sizes
// are squares of the same. `bar` is the top bar's: 32px on a computer, 44px
// to a finger on a phone, and `icon-bar` its square.

export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap outline-none transition-[color,background-color,border-color,box-shadow] focus-visible:ring-2 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-fg text-bg hover:bg-fg-hover",
        accent: "bg-accent text-bg hover:bg-accent-hover",
        outline: "border border-line text-fg/80 hover:border-line-strong hover:bg-surface hover:text-fg",
        secondary: "bg-raised text-fg hover:bg-line",
        ghost: "text-muted hover:bg-raised hover:text-fg data-[state=open]:bg-raised data-[state=open]:text-fg aria-pressed:bg-raised aria-pressed:text-fg",
        soft: "bg-accent/10 text-fg ring-1 ring-accent/20 ring-inset hover:bg-accent/15 hover:ring-accent/35",
        destructive: "border border-danger/40 text-danger hover:border-danger hover:bg-danger/10",
        link: "font-normal text-accent underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-3.5",
        sm: "h-8 gap-1.5 px-2.5 text-[0.8125rem]",
        xs: "h-7 gap-1 px-2 text-xs",
        lg: "h-10 px-5",
        bar: "h-8 gap-1.5 px-2 text-[0.8125rem] max-md:h-11 max-md:min-w-11",
        icon: "size-9",
        "icon-sm": "size-8",
        "icon-xs": "size-7",
        "icon-lg": "size-10",
        "icon-bar": "size-8 max-md:size-11",
        // Words in a sentence, for the `link` variant: no box of its own.
        inline: "h-auto gap-1.5 p-0 text-[length:inherit]",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;
export type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>["size"]>;

export type ButtonProps = ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean };

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
