import { useOutletContext } from "react-router";

import type { WorkspaceAgent } from "@g1t/contracts";

import { formatDollars } from "../../../lib/agent-form";

/** Spend this month against the agent's budget; by task and by model as tasks land. */
export default function Spend() {
  const agent = useOutletContext<WorkspaceAgent>();
  const spent = agent.spent_month_micros ?? 0;
  const cap = agent.budget.monthly_micros;
  const share = cap ? Math.min(1, spent / cap) : 0;
  const tone = share >= 1 ? "bg-danger" : share >= 0.8 ? "bg-warn" : "bg-accent";
  return (
    <div className="space-y-8">
      <section className="rounded-2xl border border-line bg-surface p-6">
        <p className="text-sm text-muted">Spent this month</p>
        <p className="mt-1 flex flex-wrap items-baseline gap-x-2">
          <span className="text-3xl font-semibold tracking-tight tabular-nums">{formatDollars(spent)}</span>
          <span className="text-sm text-muted">{cap ? `of ${formatDollars(cap)}` : "No monthly cap: the workspace limit applies"}</span>
        </p>
        {cap != null && (
          <>
            <div
              className="mt-4 h-2 overflow-hidden rounded-full bg-line"
              role="meter"
              aria-label="Spent of the monthly cap"
              aria-valuemin={0}
              aria-valuemax={cap}
              aria-valuenow={spent}
            >
              <div className={`h-full rounded-full ${tone} transition-[width]`} style={{ width: `${Math.max(share * 100, spent > 0 ? 1.5 : 0)}%` }} />
            </div>
            <p className="mt-2 text-xs text-faint">
              {Math.round(share * 100)}% used. At 80% it tells the channel that pays for it; at 100% it takes no new tasks.
            </p>
          </>
        )}
        <dl className="mt-6 grid grid-cols-2 gap-4 border-t border-line pt-5 sm:grid-cols-3">
          <div>
            <dt className="text-xs text-faint">Daily cap</dt>
            <dd className="mt-0.5 text-sm tabular-nums">{agent.budget.daily_micros != null ? formatDollars(agent.budget.daily_micros) : "None"}</dd>
          </div>
          <div>
            <dt className="text-xs text-faint">Per task</dt>
            <dd className="mt-0.5 text-sm tabular-nums">{agent.budget.task_micros != null ? formatDollars(agent.budget.task_micros) : "None"}</dd>
          </div>
          <div>
            <dt className="text-xs text-faint">While idle</dt>
            <dd className="mt-0.5 text-sm">Costs nothing</dd>
          </div>
        </dl>
      </section>
      <section>
        <h2 className="text-sm font-medium">By task and by model</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-dashed border-line px-5 py-8">
            <p className="text-sm font-medium">By task</p>
            <p className="mt-1 text-[0.8125rem] text-muted">Each task&apos;s spend against its cap shows here once it has worked one.</p>
          </div>
          <div className="rounded-xl border border-dashed border-line px-5 py-8">
            <p className="text-sm font-medium">By model</p>
            <p className="mt-1 text-[0.8125rem] text-muted">Every step records the model that ran it; the split shows here once it has worked.</p>
          </div>
        </div>
      </section>
    </div>
  );
}
