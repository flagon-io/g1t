import { X } from "lucide-react";
import { Dialog as Primitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "../../lib/cn";
import { DialogOverlay } from "./dialog";

// shadcn/ui's sheet, styled with g1t's tokens: a dialog that slides in
// from the edge of the screen, for a panel to work in beside the page.

export const Sheet = Primitive.Root;
export const SheetTrigger = Primitive.Trigger;
export const SheetClose = Primitive.Close;

type Side = "right" | "left";

const SIDES: Record<Side, string> = {
  // Full width on a phone, a column beside the page from there up.
  right:
    "inset-y-0 right-0 border-l data-[state=open]:animate-sheet-in-right data-[state=closed]:animate-sheet-out-right sm:max-w-md",
  left: "inset-y-0 left-0 border-r data-[state=open]:animate-sheet-in-left data-[state=closed]:animate-sheet-out-left sm:max-w-md",
};

export function SheetContent({
  side = "right",
  className,
  children,
  showClose = true,
  ...props
}: ComponentProps<typeof Primitive.Content> & { side?: Side; showClose?: boolean }) {
  return (
    <Primitive.Portal>
      <DialogOverlay />
      <Primitive.Content
        className={cn(
          "fixed z-50 flex h-dvh w-full flex-col border-line-strong bg-surface text-fg shadow-2xl shadow-black/60 outline-none motion-reduce:animate-none",
          SIDES[side],
          className,
        )}
        {...props}
      >
        {children}
        {showClose && (
          <Primitive.Close
            aria-label="Close"
            className="absolute top-4 right-4 rounded-md p-1 text-faint transition-colors hover:bg-raised hover:text-fg"
          >
            <X size={16} />
          </Primitive.Close>
        )}
      </Primitive.Content>
    </Primitive.Portal>
  );
}

export function SheetHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-1.5 border-b border-line px-5 py-4 pr-12", className)} {...props} />;
}

export function SheetFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("mt-auto flex items-center gap-2 border-t border-line px-5 py-3", className)} {...props} />;
}

export function SheetTitle({ className, ...props }: ComponentProps<typeof Primitive.Title>) {
  return <Primitive.Title className={cn("text-base font-semibold tracking-tight", className)} {...props} />;
}

export function SheetDescription({ className, ...props }: ComponentProps<typeof Primitive.Description>) {
  return <Primitive.Description className={cn("text-sm text-muted", className)} {...props} />;
}
