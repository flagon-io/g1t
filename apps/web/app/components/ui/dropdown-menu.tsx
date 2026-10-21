import { Check, ChevronRight, Circle } from "lucide-react";
import { DropdownMenu as Primitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "../../lib/cn";

// shadcn/ui's dropdown menu, styled with g1t's tokens.

// Not modal: a modal menu locks the page's scroll, which hides its scrollbar, widens the page
// and moves the menu's own anchor (the app bar's + and account menus) while it is open.
export function DropdownMenu({ modal = false, ...props }: ComponentProps<typeof Primitive.Root>) {
  return <Primitive.Root modal={modal} {...props} />;
}
export const DropdownMenuTrigger = Primitive.Trigger;
export const DropdownMenuGroup = Primitive.Group;

export function DropdownMenuContent({ className, sideOffset = 6, collisionPadding = 8, ...props }: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        sideOffset={sideOffset}
        // Never off the edge of a phone: kept 8px inside it, and as tall as there is room for.
        collisionPadding={collisionPadding}
        className={cn(
          "z-50 max-h-(--radix-dropdown-menu-content-available-height) max-w-[calc(100vw-1rem)] min-w-48 origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-lg border border-line-strong bg-raised p-1 text-sm shadow-xl shadow-black/40",
          "data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out motion-reduce:animate-none",
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  );
}

export function DropdownMenuItem({
  className,
  variant = "default",
  ...props
}: ComponentProps<typeof Primitive.Item> & {
  /** `destructive`: an item that deletes something, in the danger color (shadcn's variant). */
  variant?: "default" | "destructive";
}) {
  return (
    <Primitive.Item
      data-variant={variant}
      className={cn(
        // Taller rows under a finger, so each is a fair target.
        "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-fg/90 outline-none select-none pointer-coarse:min-h-10",
        "data-highlighted:bg-line data-highlighted:text-fg data-disabled:opacity-50",
        "[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-faint",
        "data-[variant=destructive]:text-danger data-[variant=destructive]:data-highlighted:bg-danger/10 data-[variant=destructive]:data-highlighted:text-danger data-[variant=destructive]:[&_svg]:text-danger",
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof Primitive.Label>) {
  return <Primitive.Label className={cn("px-2 py-1.5 text-xs text-faint", className)} {...props} />;
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof Primitive.Separator>) {
  return <Primitive.Separator className={cn("-mx-1 my-1 h-px bg-line", className)} {...props} />;
}

export const DropdownMenuSub = Primitive.Sub;

/** A row that opens a submenu beside it, with a chevron at its end. */
export function DropdownMenuSubTrigger({ className, children, ...props }: ComponentProps<typeof Primitive.SubTrigger>) {
  return (
    <Primitive.SubTrigger
      className={cn(
        // Taller rows under a finger, so each is a fair target.
        "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-fg/90 outline-none select-none pointer-coarse:min-h-10",
        "data-highlighted:bg-line data-highlighted:text-fg data-[state=open]:bg-line data-[state=open]:text-fg data-disabled:opacity-50",
        "[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-faint",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRight className="ml-auto" />
    </Primitive.SubTrigger>
  );
}

export function DropdownMenuSubContent({ className, sideOffset = 6, collisionPadding = 8, ...props }: ComponentProps<typeof Primitive.SubContent>) {
  return (
    <Primitive.Portal>
      <Primitive.SubContent
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          "z-50 max-h-(--radix-dropdown-menu-content-available-height) max-w-[calc(100vw-1rem)] min-w-44 origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-lg border border-line-strong bg-raised p-1 text-sm shadow-xl shadow-black/40",
          "data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out motion-reduce:animate-none",
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  );
}

const CHOICE =
  "relative flex cursor-default items-center gap-2 rounded-md py-1.5 pr-2 pl-8 text-fg/90 outline-none select-none pointer-coarse:min-h-10 data-highlighted:bg-line data-highlighted:text-fg data-disabled:opacity-50 [&_svg]:shrink-0";

/** A row that is on or off, with a check when it is on. */
export function DropdownMenuCheckboxItem({ className, children, ...props }: ComponentProps<typeof Primitive.CheckboxItem>) {
  return (
    <Primitive.CheckboxItem className={cn(CHOICE, className)} {...props}>
      <span className="absolute left-2 flex size-4 items-center justify-center">
        <Primitive.ItemIndicator>
          <Check size={14} />
        </Primitive.ItemIndicator>
      </span>
      {children}
    </Primitive.CheckboxItem>
  );
}

export const DropdownMenuRadioGroup = Primitive.RadioGroup;

/** One of a group's choices, with a dot on the chosen one. */
export function DropdownMenuRadioItem({ className, children, ...props }: ComponentProps<typeof Primitive.RadioItem>) {
  return (
    <Primitive.RadioItem className={cn(CHOICE, className)} {...props}>
      <span className="absolute left-2 flex size-4 items-center justify-center">
        <Primitive.ItemIndicator>
          <Circle size={8} className="fill-current" />
        </Primitive.ItemIndicator>
      </span>
      {children}
    </Primitive.RadioItem>
  );
}
