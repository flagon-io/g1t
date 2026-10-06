import { Link } from "react-router";

import type { Route } from "./+types/velocity";
import { Badge, EmptyState, Notice, PageHeader, Stat } from "~/components/ui";
import { usd } from "~/lib/money";
import { age, isFast, ratioLabel, spikeLabel } from "~/lib/pricing";
import { admin } from "~/lib/services.server";
import { settle } from "~/lib/settle";
import { requireStaff } from "~/lib/staff";

export const meta: Route.MetaFunction = () => [{ title: "Velocity · sudo" }, { name: "robots", content: "noindex, nofollow" }];

export async function loader({ context }: Route.LoaderArgs) {
  requireStaff(context);
  const rows = await settle(admin.velocity());
  return { rows: rows.ok ? rows.value : [], error: rows.ok ? null : rows.error, now: new Date().toISOString() };
}

export default function Velocity({ loaderData }: Route.ComponentProps) {
  const { rows, error, now } = loaderData;
  const fast = rows.filter((row) => isFast(row.ratio) && row.averageHourMicros > 0).length;
  const waiting = rows.filter((row) => row.spike?.status === "open").length;
  const lastHour = rows.reduce((sum, row) => sum + row.lastHourMicros, 0);
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:py-10">
      <PageHeader
        title="Velocity"
        description="Workspaces spending in the last day, fastest first. An hour at five times the usual hour, and at least $5, is a spike: new compute pauses until an owner chooses Keep going or Stop."
      />
      {error && (
        <div className="mt-5">
          <Notice tone="warn">Billing did not answer for velocity: {error}</Notice>
        </div>
      )}
      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Spending today" value={String(rows.length)} hint="Workspaces with usage in the last day" />
        <Stat label="Last hour, everyone" value={usd(lastHour)} />
        <Stat label="Five times their usual" value={String(fast)} tone={fast > 0 ? "warn" : undefined} />
        <Stat label="Paused, waiting on an owner" value={String(waiting)} tone={waiting > 0 ? "danger" : undefined} />
      </div>
      <div className="mt-6">
        {rows.length === 0 && !error ? (
          <EmptyState title="Nobody is spending right now" />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line bg-surface">
            <table className="w-full min-w-[46rem] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th className="px-4 py-2 font-medium">Workspace</th>
                  <th className="px-4 py-2 text-right font-medium">Last hour</th>
                  <th className="px-4 py-2 text-right font-medium">Usual hour</th>
                  <th className="px-4 py-2 text-right font-medium">Pace</th>
                  <th className="px-4 py-2 text-right font-medium">Last day</th>
                  <th className="px-4 py-2 text-right font-medium">This month</th>
                  <th className="px-4 py-2 font-medium">Spike</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const hot = isFast(row.ratio) && row.averageHourMicros > 0;
                  const spike = row.spike ? spikeLabel(row.spike.status) : null;
                  const seen = age(row.firstSeen, new Date(now));
                  return (
                    <tr key={row.workspace} className="border-b border-line last:border-0">
                      <td className="px-4 py-2.5">
                        <Link to={`/workspaces/${encodeURIComponent(row.workspace)}#billing`} className="font-mono text-fg hover:underline">
                          {row.workspace}
                        </Link>
                        <span className="block text-xs text-faint">
                          {row.plan}
                          {seen ? ` · seen for ${seen}` : ""}
                        </span>
                      </td>
                      <td className="tabular px-4 py-2.5 text-right">{usd(row.lastHourMicros)}</td>
                      <td className="tabular px-4 py-2.5 text-right text-muted">{usd(row.averageHourMicros)}</td>
                      <td className={`tabular px-4 py-2.5 text-right font-medium ${hot ? "text-warn" : "text-fg-soft"}`}>
                        {ratioLabel(row.ratio, row.averageHourMicros)}
                      </td>
                      <td className="tabular px-4 py-2.5 text-right">{usd(row.lastDayMicros)}</td>
                      <td className="tabular px-4 py-2.5 text-right">{usd(row.thisMonthMicros)}</td>
                      <td className="px-4 py-2.5">
                        {spike ? <Badge tone={spike.tone === "plain" ? "plain" : spike.tone}>{spike.label}</Badge> : <span className="text-faint">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
