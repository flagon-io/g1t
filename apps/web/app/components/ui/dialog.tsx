import { X } from "lucide-react";
import { Dialog as Primitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "../../lib/cn";

// shadcn/ui's dialog, styled with g1t's tokens.

export const Dialog = Primitive.Root;
export const DialogTrigger = Primitive.Trigger;
export const DialogClose = Primitive.Close;
export const DialogPortal = Primitive.Portal;

export function DialogOverlay({ className, ...props }: ComponentProps<typeof Primitive.Overlay>) {
  return (
    <Primitive.Overlay
      className={cn(
        "fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px]",
        "data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The panel, centred. On a phone (below 640px) it is a sheet from the
 * bottom instead, the full width, clear of the home indicator and sitting
 * on the keyboard while it is up (`--keyboard-inset`, components/mobile.tsx).
 */
export const DIALOG_PANEL =
  "fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto overscroll-contain rounded-xl border border-line-strong bg-surface p-6 text-fg shadow-2xl shadow-black/60 outline-none data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out motion-reduce:animate-none " +
  "max-sm:top-auto max-sm:bottom-(--keyboard-inset,0px) max-sm:left-0 max-sm:w-full max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:max-h-[calc(var(--vv-height,100dvh)-env(safe-area-inset-top)-0.5rem)] max-sm:rounded-b-none max-sm:border-x-0 max-sm:border-b-0 max-sm:pb-[calc(1.5rem+env(safe-area-inset-bottom))] max-sm:data-[state=open]:animate-[sheet-in-bottom_0.24s_cubic-bezier(0.16,1,0.3,1)] max-sm:data-[state=closed]:animate-fade-out";

export function DialogContent({
  className,
  children,
  showClose = true,
  ...props
}: ComponentProps<typeof Primitive.Content> & { showClose?: boolean }) {
  return (
    <Primitive.Portal>
      <DialogOverlay />
      <Primitive.Content className={cn(DIALOG_PANEL, className)} {...props}>
        {children}
        {showClose && (
          <Primitive.Close
            aria-label="Close"
            className="absolute top-4 right-4 rounded-md p-1 text-faint transition-colors hover:bg-raised hover:text-fg max-sm:top-2.5 max-sm:right-2.5 max-sm:flex max-sm:size-10 max-sm:items-center max-sm:justify-center"
          >
            <X size={16} />
          </Primitive.Close>
        )}
      </Primitive.Content>
    </Primitive.Portal>
  );
}

export function DialogHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-1.5 pr-6", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />;
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof Primitive.Title>) {
  return <Primitive.Title className={cn("text-base font-semibold tracking-tight", className)} {...props} />;
}

export function DialogDescription({ className, ...props }: ComponentProps<typeof Primitive.Description>) {
  return <Primitive.Description className={cn("text-sm text-muted", className)} {...props} />;
}
