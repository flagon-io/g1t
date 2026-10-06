import type { ReactNode } from "react";

/**
 * Settings that move or remove what the page is about, apart from the
 * rest and outlined in the danger colour, each with what it does.
 */
export function DangerZone({ children }: { children: ReactNode }) {
  return (
    <section aria-labelledby="danger-zone" className="space-y-3">
      <h2 id="danger-zone" className="font-medium text-danger">
        Danger zone
      </h2>
      <div className="divide-y divide-danger/20 rounded-xl border border-danger/40">{children}</div>
    </section>
  );
}

/** One action in the danger zone: what it is, what it does, and its button. */
export function DangerAction({ title, children, action }: { title: string; children: ReactNode; action: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <div className="mt-1 text-sm text-muted">{children}</div>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}
