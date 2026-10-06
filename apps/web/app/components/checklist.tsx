import { Check, ChevronRight, X } from "lucide-react";
import { useCallback, useSyncExternalStore } from "react";
import { Link } from "react-router";

import { type ChecklistItem, dismiss, isDismissed, progress } from "../lib/checklist";
import { cn } from "../lib/cn";

const storage = () => (typeof window === "undefined" ? null : window.localStorage);
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * The steps to production for one project, as `3/6`, until they are all
 * done or someone dismisses it. Dismissing is per project and remembered by
 * this browser.
 */
export function ProductionChecklist({ base, items }: { base: string; items: ChecklistItem[] }) {
  const hidden = useSyncExternalStore(
    subscribe,
    useCallback(() => isDismissed(storage, base), [base]),
    () => false,
  );
  const { done, total, complete } = progress(items);
  if (hidden || complete) return null;
  const next = items.find((item) => !item.done)?.key;

  return (
    <section aria-labelledby="checklist-title" className="rounded-2xl border border-line bg-surface">
      <div className="flex items-center gap-3 px-5 pt-4 pb-3 sm:px-6">
        <h2 id="checklist-title" className="text-sm font-semibold">
          Get to production
        </h2>
        <span className="rounded-full bg-raised px-2 py-px text-xs font-medium tabular-nums text-muted">
          {done}/{total}
        </span>
        <span className="hidden h-1.5 w-24 overflow-hidden rounded-full bg-line sm:block" aria-hidden>
          <span className="block h-full rounded-full bg-accent" style={{ width: `${(done / total) * 100}%` }} />
        </span>
        <button
          type="button"
          onClick={() => {
            dismiss(storage, base);
            for (const listener of listeners) listener();
          }}
          className="ml-auto rounded-md p-1 text-faint transition-colors hover:bg-raised hover:text-fg"
          aria-label="Dismiss the checklist for this project"
          title="Dismiss for this project"
        >
          <X size={14} />
        </button>
      </div>
      <ol className="grid border-t border-line sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => (
          <li key={item.key} className="border-b border-line last:border-b-0 sm:[&:nth-last-child(-n+2)]:border-b-0 lg:[&:nth-last-child(-n+3)]:border-b-0">
            <Link
              to={item.to}
              className={cn(
                "group flex h-full items-start gap-3 px-5 py-3 transition-colors hover:bg-raised/50 sm:px-6",
                item.done && "opacity-70",
              )}
            >
              <span
                className={cn(
                  "mt-px flex size-4.5 shrink-0 items-center justify-center rounded-full border",
                  item.done ? "border-accent bg-accent text-bg" : item.key === next ? "border-accent" : "border-line-strong",
                )}
                aria-hidden
              >
                {item.done && <Check size={11} strokeWidth={3} />}
              </span>
              <span className="min-w-0 grow">
                <span className={cn("block text-[0.8125rem] font-medium", item.done && "text-muted line-through decoration-line-strong")}>
                  {item.title}
                  <span className="sr-only">{item.done ? " (done)" : ""}</span>
                </span>
                {!item.done && <span className="mt-0.5 block text-xs leading-5 text-muted">{item.detail}</span>}
              </span>
              {!item.done && (
                <ChevronRight size={14} className="mt-0.5 shrink-0 text-faint transition-colors group-hover:text-fg" />
              )}
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
