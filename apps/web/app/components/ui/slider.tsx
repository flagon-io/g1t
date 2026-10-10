import { Slider as Primitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "../../lib/cn";

// shadcn/ui's slider, styled with g1t's tokens: a value picked along a
// line, with the keyboard (arrows, Home, End, Page Up and Down) as well as
// the pointer. Give it an `aria-label`, or point a <Label> at the thumb
// through `aria-labelledby`. One thumb unless `value` has several.

export function Slider({ className, value, defaultValue, min = 0, max = 100, ...props }: ComponentProps<typeof Primitive.Root>) {
  const thumbs = Array.isArray(value) ? value : Array.isArray(defaultValue) ? defaultValue : [min];
  return (
    <Primitive.Root
      data-slot="slider"
      value={value}
      defaultValue={defaultValue}
      min={min}
      max={max}
      className={cn(
        "relative flex w-full touch-none items-center select-none data-[disabled]:opacity-50",
        "data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-44 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col",
        className,
      )}
      {...props}
    >
      <Primitive.Track
        data-slot="slider-track"
        className="relative grow overflow-hidden rounded-full bg-line data-[orientation=horizontal]:h-1.5 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1.5"
      >
        <Primitive.Range data-slot="slider-range" className="absolute bg-accent data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full" />
      </Primitive.Track>
      {thumbs.map((_, index) => (
        <Primitive.Thumb
          key={index}
          data-slot="slider-thumb"
          className={cn(
            "block size-4 shrink-0 rounded-full border border-accent bg-fg shadow-sm transition-[color,box-shadow] outline-none",
            "hover:ring-4 hover:ring-accent/25 focus-visible:ring-4 focus-visible:ring-accent/40 disabled:pointer-events-none",
          )}
        />
      ))}
    </Primitive.Root>
  );
}
