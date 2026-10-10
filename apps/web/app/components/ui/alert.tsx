import { type VariantProps, cva } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "../../lib/cn";

// shadcn/ui's alert, styled with g1t's tokens: a short tinted notice in the
// flow of a page, such as why a form was refused. `danger` is for what went
// wrong, `warn` for what needs care, `info` for what is worth knowing. Give
// it `role="alert"` when it appears in answer to what someone just did, so
// a screen reader says it at once; a notice that is there from the start
// needs no role. `asChild` puts the notice on a <p>.

export const alertVariants = cva("rounded-lg border px-3 py-2 text-sm", {
  variants: {
    tone: {
      danger: "border-danger/40 bg-danger/10 text-danger",
      warn: "border-warn/40 bg-warn/10 text-fg",
      info: "border-info/40 bg-info/10 text-fg",
      success: "border-success/40 bg-success/10 text-fg",
    },
  },
  defaultVariants: { tone: "danger" },
});

export function Alert({ className, tone, asChild = false, ...props }: ComponentProps<"div"> & VariantProps<typeof alertVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "div";
  return <Comp data-slot="alert" className={cn(alertVariants({ tone }), className)} {...props} />;
}

export function AlertTitle({ className, ...props }: ComponentProps<"p">) {
  return <p data-slot="alert-title" className={cn("font-medium", className)} {...props} />;
}

export function AlertDescription({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="alert-description" className={cn("mt-0.5 text-muted", className)} {...props} />;
}
