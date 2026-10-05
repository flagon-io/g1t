import { AlertDialog as Primitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "../../lib/cn";
import { DIALOG_PANEL } from "./dialog";

// shadcn/ui's alert dialog, for confirming what cannot be undone. It does
// not close on a click outside; the person has to choose.

export const AlertDialog = Primitive.Root;
export const AlertDialogTrigger = Primitive.Trigger;

export function AlertDialogContent({ className, ...props }: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out motion-reduce:animate-none" />
      <Primitive.Content className={cn(DIALOG_PANEL, "max-w-md", className)} {...props} />
    </Primitive.Portal>
  );
}

export function AlertDialogHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-1.5", className)} {...props} />;
}

export function AlertDialogFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />;
}

export function AlertDialogTitle({ className, ...props }: ComponentProps<typeof Primitive.Title>) {
  return <Primitive.Title className={cn("text-base font-semibold tracking-tight", className)} {...props} />;
}

export function AlertDialogDescription({ className, ...props }: ComponentProps<typeof Primitive.Description>) {
  return <Primitive.Description className={cn("text-sm text-muted", className)} {...props} />;
}

const BUTTON =
  "inline-flex items-center justify-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium transition-colors disabled:opacity-50";

/** The destructive choice. Put a submit button inside with `asChild` to post a form. */
export function AlertDialogAction({ className, ...props }: ComponentProps<typeof Primitive.Action>) {
  return (
    <Primitive.Action
      className={cn(BUTTON, "bg-danger text-bg hover:bg-danger/90", className)}
      {...props}
    />
  );
}

export function AlertDialogCancel({ className, ...props }: ComponentProps<typeof Primitive.Cancel>) {
  return (
    <Primitive.Cancel
      className={cn(BUTTON, "border border-line text-fg/80 hover:border-line-strong hover:bg-raised hover:text-fg", className)}
      {...props}
    />
  );
}
