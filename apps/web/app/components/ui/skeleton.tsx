import type { ComponentProps, ReactNode } from "react";

import { cn } from "../../lib/cn";

// The shape of something still loading: a quiet raised block that pulses
// (still for people who ask for less motion). Give it the size of what it
// stands for, so nothing moves when the real thing arrives. Hidden from
// screen readers; the region it sits in says it is busy (`aria-busy`),
// which `Loading` does, with a "Loading…" for them to hear.
//
// The pieces below are the app's common shapes, each the height of the
// real thing: compose a page's outline from them rather than drawing one.

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
 * A bar standing in for one line of text, as tall as the line it sits in
 * (`1lh`), so a row keeps its height when the words arrive.
 */
export function SkeletonLine({ className, barClassName, width }: { className?: string; barClassName?: string; width?: string }) {
  return (
    <span aria-hidden="true" className={cn("flex h-[1lh] items-center", className)}>
      <Skeleton className={cn("h-3 w-full", barClassName)} style={width ? { width } : undefined} />
    </span>
  );
}

/**
 * A region whose content is on its way: busy for assistive technology,
 * with "Loading…" said once. The skeleton inside is hidden from them.
 */
export function Loading({
  label = "Loading…",
  className,
  children,
  ...props
}: { label?: string; children: ReactNode } & ComponentProps<"div">) {
  return (
    <div aria-busy="true" className={className} {...props}>
      <span role="status" className="sr-only">
        {label}
      </span>
      {children}
    </div>
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
          <Skeleton className="h-3 grow" style={{ maxWidth: varied(index) }} />
          <Skeleton className="h-3 w-12 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/** A width for row `index` that varies, so a list of bars does not look ruled. */
function varied(index: number, widest = 70, spread = 30) {
  return `${widest - ((index * 17) % spread)}%`;
}

/**
 * Rows of a table: `columns` cells across, the first wide, the rest as
 * `cellClassName` sizes them, in rows as tall as text rows (`py-2`).
 */
export function SkeletonTableRows({
  rows = 3,
  columns = 3,
  className,
  rowClassName,
}: {
  rows?: number;
  columns?: number;
  className?: string;
  rowClassName?: string;
}) {
  return (
    <div aria-hidden="true" className={cn("divide-y divide-line text-sm", className)}>
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className={cn("flex items-center gap-4 px-4 py-2", rowClassName)}>
          <SkeletonLine className="grow" width={varied(row)} />
          {Array.from({ length: columns - 1 }, (_, column) => (
            <SkeletonLine key={column} className="w-16 shrink-0" />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * An item of an issue's or pull request's timeline (components/work.tsx
 * `TimelineItem`): the avatar beside a card with its header and `lines`
 * of body.
 */
export function SkeletonTimelineItem({ lines = 2, className }: { lines?: number; className?: string }) {
  return (
    <div aria-hidden="true" className={cn("flex gap-3", className)}>
      <Skeleton className="mt-1 hidden size-8 shrink-0 rounded-full sm:block" />
      <div className="min-w-0 grow overflow-hidden rounded-xl border border-line bg-surface">
        <div className="flex items-center gap-2 border-b border-line bg-raised/40 px-4 py-2 text-sm">
          <SkeletonLine className="w-20" />
          <SkeletonLine className="w-32" />
        </div>
        {lines > 0 && <SkeletonText lines={lines} className="px-4 py-4" />}
      </div>
    </div>
  );
}

/** A card: a title and `lines` of text, in the app's bordered box. */
export function SkeletonCard({ lines = 2, className }: { lines?: number; className?: string }) {
  return (
    <div aria-hidden="true" className={cn("rounded-xl border border-line bg-surface p-4", className)}>
      <SkeletonLine className="w-1/3 text-sm" />
      {lines > 0 && <SkeletonText lines={lines} className="mt-3" />}
    </div>
  );
}

/** A sidebar section: its small heading and `rows` lines under it. */
export function SkeletonSidebarSection({ rows = 2, className }: { rows?: number; className?: string }) {
  return (
    <div aria-hidden="true" className={cn("text-sm", className)}>
      <SkeletonLine className="w-24" />
      <div className="mt-2 space-y-1.5">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="flex items-center gap-2">
            <Skeleton className="size-5 shrink-0 rounded-full" />
            <SkeletonLine className="grow" barClassName="w-28" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A stat tile, as mission control's tiles sit in their grid: its label,
 * the number, and the line under it, each the height of its text.
 */
export function SkeletonStat({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn("bg-surface px-4 py-3.5 sm:px-5 sm:py-4", className)}>
      <SkeletonLine className="w-16 text-xs" />
      <SkeletonLine className="mt-1 w-12 text-2xl sm:text-[1.75rem]" barClassName="h-6" />
      <SkeletonLine className="mt-0.5 w-24 text-xs" />
    </div>
  );
}

/**
 * Lines of code, numbered, as `CodeLines` and a README's code blocks set
 * them: `lines` rows of the monospace line height.
 */
export function SkeletonCode({ lines = 6, className }: { lines?: number; className?: string }) {
  return (
    <div aria-hidden="true" className={cn("py-2 font-mono text-[0.8125rem] leading-6", className)}>
      {Array.from({ length: lines }, (_, index) => (
        <div key={index} className="flex items-center gap-4 px-4">
          <SkeletonLine className="w-6 shrink-0" />
          <SkeletonLine className="grow" width={varied(index, 80, 50)} />
        </div>
      ))}
    </div>
  );
}
