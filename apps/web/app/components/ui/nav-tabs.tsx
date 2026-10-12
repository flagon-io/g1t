import { type VariantProps, cva } from "class-variance-authority";
import type { ComponentProps, ReactNode } from "react";
import { Link } from "react-router";

import { cn } from "../../lib/cn";
import { SoonPill } from "./index";
import { TabStrip } from "./tab-strip";

// Navigation tabs: links that say which page or view you are on, in a row
// that scrolls sideways on a phone (./tab-strip). shadcn's Tabs switch panels
// on one page; these go to other addresses. Two variants, one per level:
//
// `line` is the primary row along a header's bottom border: the current tab
// is underlined on that border, and the row sits one pixel into it so the
// two lines are one. `pill` is a secondary row inside a page's content, for
// the views of one section: the current view a quiet raised chip, nothing
// drawn outside the tab's own box, so the strip's overflow never cuts it.

export const navTabsVariants = cva("", {
  variants: {
    variant: {
      // Over the border: the strip's bottom edge is the header's line. The
      // first tab's text lines up with the page's gutter, its underline a
      // hair past it, and on a phone either row runs to the screen's edges
      // as it scrolls.
      line: "-mx-4 -mb-px gap-4 px-3 sm:-mx-1 sm:px-0",
      pill: "-mx-4 gap-1 px-4 sm:mx-0 sm:px-0",
    },
  },
  defaultVariants: { variant: "line" },
});

export const navTabVariants = cva(
  "flex items-center gap-1.5 text-sm whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        line: "h-11 border-b-2 border-transparent px-1 hover:border-line-strong aria-[current=page]:border-accent",
        pill: "h-8 rounded-md px-3 hover:bg-raised/60 aria-[current=page]:bg-raised",
      },
      soon: {
        true: "text-faint hover:text-muted",
        false: "text-muted hover:text-fg aria-[current=page]:font-medium aria-[current=page]:text-fg",
      },
    },
    defaultVariants: { variant: "line", soon: false },
  },
);

type Variant = NonNullable<VariantProps<typeof navTabsVariants>["variant"]>;

/** A row of navigation tabs: `line` along a header's border, `pill` within a page. */
export function NavTabs({ label, variant, className, children }: { label: string; variant?: Variant; className?: string; children: ReactNode }) {
  return (
    <TabStrip label={label} className={cn(navTabsVariants({ variant }), className)}>
      {children}
    </TabStrip>
  );
}

/**
 * One tab: a link, current when `current` says so (not by its address,
 * which would also mark a section's first page current under every other).
 * `count` shows beside the label when there are any; `soon` marks a tab
 * whose page is still coming.
 */
export function NavTab({
  current,
  variant,
  soon,
  count,
  className,
  children,
  ...props
}: ComponentProps<typeof Link> & VariantProps<typeof navTabVariants> & { current?: boolean; count?: number }) {
  return (
    <Link
      prefetch="intent"
      aria-current={current ? "page" : undefined}
      data-active={current || undefined}
      className={cn(navTabVariants({ variant, soon }), className)}
      {...props}
    >
      {children}
      {count != null && count > 0 && <NavTabCount>{count}</NavTabCount>}
      {soon && <SoonPill />}
    </Link>
  );
}

/** How many there are, beside a tab's label. */
function NavTabCount({ children }: { children: ReactNode }) {
  return <span className="rounded-full bg-raised px-1.5 text-xs leading-5 font-normal text-muted tabular-nums">{children}</span>;
}
