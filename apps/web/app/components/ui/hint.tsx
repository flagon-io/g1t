import { type ComponentProps, type MouseEvent, type PointerEvent, type ReactElement, type ReactNode, useRef, useState } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

/**
 * A hover hint: the site's tooltip around exactly one element, in place of
 * the browser's `title`, which g1t does not use (app/lib/no-native-title.test.ts
 * keeps it out). It opens on hover and keyboard focus, and on a tap of
 * something that does nothing else when tapped, since a touch screen has no
 * hover. Without a `label` the child renders as it is.
 *
 * The hint is not the element's accessible name: an icon-only button keeps
 * its `aria-label`, and text cut short keeps its whole text for a screen
 * reader. Anything else passed (as from a parent's `asChild`) goes to the child.
 */
export function Hint({
  label,
  children,
  side,
  align,
  disabled,
  onClick,
  onPointerDown,
  ...props
}: Omit<ComponentProps<typeof TooltipTrigger>, "children"> & {
  label: ReactNode;
  /** One element that takes a ref and passes its props on (asChild). */
  children: ReactElement;
  side?: ComponentProps<typeof TooltipContent>["side"];
  align?: ComponentProps<typeof TooltipContent>["align"];
  /**
   * The child is disabled, so it gets no pointer events and no focus: the
   * hint hangs on a focusable span around it instead, as when it says why.
   */
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const touch = useRef(false);
  if (label == null || label === false || label === "") return children;
  const trigger = disabled ? (
    <span tabIndex={0} className="inline-flex rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent *:pointer-events-none">
      {children}
    </span>
  ) : (
    children
  );
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger
        asChild
        {...props}
        onPointerDown={(event: PointerEvent<HTMLButtonElement>) => {
          touch.current = event.pointerType === "touch";
          onPointerDown?.(event);
        }}
        onClick={(event: MouseEvent<HTMLButtonElement>) => {
          onClick?.(event);
          // A tap on text or a badge shows the hint; a tap on a link or a
          // button does what it does. preventDefault keeps the trigger's own
          // click handler from closing the hint again.
          if (touch.current && !event.defaultPrevented && !(event.target as Element).closest("a, button, input, select, textarea, label, summary")) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {trigger}
      </TooltipTrigger>
      <TooltipContent side={side} align={align}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
