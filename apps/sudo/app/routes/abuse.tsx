import { Link } from "react-router";

import type { G1tEvent } from "@g1t/contracts";

import type { Route } from "./+types/abuse";
import { Badge, EmptyState, Notice, PageHeader, Section, When } from "~/components/ui";
import { events } from "~/lib/services.server";
import { settle } from "~/lib/settle";
import { reachOutHref } from "~/lib/signals";
import { requireStaff } from "~/lib/staff";

export const meta: Route.MetaFunction = () => [{ title: "Abuse & fraud · sudo" }, { name: "robots", content: "noindex, nofollow" }];

export async function loader({ context }: Route.LoaderArgs) {
  requireStaff(context);
  const flagged = await settle(events.list({ types: ["abuse.flagged"], limit: 100 }));
  return {
    flags: flagged.ok ? (flagged.value.filter((event) => event.type === "abuse.flagged") as G1tEvent<"abuse.flagged">[]) : [],
    error: flagged.ok ? null : flagged.error,
  };
}

/** A sandbox's measurements, short: `cpu 0.98 · io 0 · miner xmrig`. */
function metricsLine(metrics: Record<string, unknown> | null): string {
  if (!metrics) return "No measurements";
  const parts = Object.entries(metrics)
    .filter(([, value]) => value != null && typeof value !== "object")
    .map(([key, value]) => `${key.replace(/_/g, " ")} ${typeof value === "number" ? Math.round(value * 100) / 100 : String(value)}`);
  return parts.length > 0 ? parts.join(" · ") : "No measurements";
}

export default function Abuse({ loaderData }: Route.ComponentProps) {
  const { flags, error } = loaderData;
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:py-10">
      <PageHeader
        title="Abuse & fraud"
        description="Sandboxes g1t stopped because they looked like mining: CPU pinned with no progress, or a miner seen by name. Each was destroyed as it was flagged, and the owner was told why."
      />
      {error && (
        <div className="mt-5">
          <Notice tone="warn">The event log did not answer: {error}</Notice>
        </div>
      )}
      <Section title="Flagged sandboxes" description="The latest 100, newest first." className="mt-6">
        {flags.length === 0 ? (
          <EmptyState title={error ? "Nothing to show" : "No sandbox has been flagged"} />
        ) : (
          <ul className="-mx-4 -my-4 divide-y divide-line sm:-mx-5 sm:-my-5">
            {flags.map((event) => (
              <li key={event.id} className="flex flex-col gap-1 px-4 py-3 sm:px-5">
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  <Link to={`/workspaces/${encodeURIComponent(event.data.workspace)}#billing`} className="font-mono text-fg hover:underline">
                    {event.data.workspace}
                  </Link>
                  <Badge tone="danger">{event.data.kind}</Badge>
                  {event.data.repo && <span className="font-mono text-xs text-muted">{event.data.repo}</span>}
                  <span className="ml-auto text-xs text-faint">
                    <When at={event.time} time />
                  </span>
                </p>
                <p className="font-mono text-xs break-words text-faint">
                  {metricsLine(event.data.metrics)}
                  {event.data.run ? ` · run ${event.data.run}` : ""} · sandbox {event.data.sandbox}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Not listed here yet" className="mt-6">
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
          <li>
            Disputes and declined cards are signals in{" "}
            <Link to={reachOutHref({ kind: "declined" })} className="text-accent hover:underline">
              Reach out
            </Link>
            . Stripe Radar's early fraud warnings are not in sudo yet.
          </li>
          <li>Card checks refused a trial (a card used before, or a prepaid card) are in billing's records, not listed here.</li>
          <li>To stop a workspace's compute, set a hold on its page, under Plan, pools and caps.</li>
        </ul>
      </Section>
    </main>
  );
}
