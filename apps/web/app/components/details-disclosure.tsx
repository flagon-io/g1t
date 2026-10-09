import { ChevronDown } from "lucide-react";
import { type ReactNode, useId, useState } from "react";

import { cn } from "../lib/cn";

/**
 * A page's sidebar: beside the page from `lg` up, and on anything narrower
 * a disclosure at the top that opens it in place, so a phone reaches the
 * conversation first and the metadata one tap away.
 */
export function DetailsDisclosure({
  label = "Details",
  summary,
  icon,
  className,
  bodyClassName = "space-y-6",
  children,
}: {
  /** What the button says. */
  label?: string;
  /** A few words beside it, such as who reviews and which labels. */
  summary?: ReactNode;
  icon?: ReactNode;
  className?: string;
  /** Classes of the body, as the sidebar lays it out. */
  bodyClassName?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <aside className={className}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className="flex min-h-11 w-full items-center gap-2.5 rounded-xl border border-line bg-surface px-4 py-2.5 text-left text-sm transition-colors hover:border-line-strong lg:hidden"
      >
        {icon}
        <span className="shrink-0 font-medium">{label}</span>
        {summary && <span className="min-w-0 grow truncate text-muted">{summary}</span>}
        <ChevronDown size={15} className={cn("ml-auto shrink-0 text-faint transition-transform", open && "rotate-180")} />
      </button>
      <div id={id} className={cn(open ? "mt-4 block" : "hidden", "lg:mt-0 lg:block", bodyClassName)}>
        {children}
      </div>
    </aside>
  );
}

/** `2 reviewers · 1 label`: what the sidebar holds, by count, leaving out what is empty. */
export function detailsSummary(counts: [count: number, one: string, many: string][]): string {
  return counts
    .filter(([count]) => count > 0)
    .map(([count, one, many]) => `${count} ${count === 1 ? one : many}`)
    .join(" · ");
}
