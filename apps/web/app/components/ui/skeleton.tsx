import type { ComponentProps } from "react";

import { cn } from "../../lib/cn";

// The shape of something still loading: a quiet raised block that pulses
// (still for people who ask for less motion). Give it the size of what it
// stands for, so nothing moves when the real thing arrives. Hidden from
// screen readers; the region it sits in says it is busy (`aria-busy`).

/** One block. Size it with classes: `h-3 w-24`, `size-8 rounded-full`. */
export function Skeleton({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      aria-hidden="true"
      className={cn("block rounded bg-raised motion-safe:animate-pulse", className)}
      {...props}
    />
  );
}

/**
 * Lines of text: `lines` bars `h-3` apart by `gap`, the last one shorter,
 * as a paragraph or a list's titles would sit.
 */
export function SkeletonText({ lines = 3, className, lineClassName }: { lines?: number; className?: string; lineClassName?: string }) {
  return (
    <span aria-hidden="true" className={cn("flex flex-col gap-2", className)}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} className={cn("h-3", index === lines - 1 && lines > 1 ? "w-3/5" : "w-full", lineClassName)} />
      ))}
    </span>
  );
}

/**
 * Rows of a list, each `rowClassName` tall (`h-10` by default) with a
 * leading dot and a title, as the app's lists are laid out.
 */
export function SkeletonRows({ rows = 3, className, rowClassName }: { rows?: number; className?: string; rowClassName?: string }) {
  return (
    <div aria-hidden="true" className={cn("divide-y divide-line", className)}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className={cn("flex h-10 items-center gap-3 px-3", rowClassName)}>
          <Skeleton className="size-4 shrink-0 rounded-full" />
          <Skeleton className="h-3 grow" style={{ maxWidth: `${70 - ((index * 17) % 30)}%` }} />
          <Skeleton className="h-3 w-12 shrink-0" />
        </div>
      ))}
    </div>
  );
}
