import { AlertOctagon, ArrowRight, CalendarClock, CreditCard, FileText, Gauge } from "lucide-react";
import type { ReactNode } from "react";
import { Link, redirect } from "react-router";

import type { Route } from "./+types/overview";
import { KindBreakdown, MonthsChart } from "~/components/charts";
import { SignalBadge, StaffName, StageBadge } from "~/components/sales";
import { Avatar, Notice, PageHeader, Section, Stat } from "~/components/ui";
import { change, marginOf, monthLong } from "~/lib/chart";
import { usd } from "~/lib/money";
import { admin } from "~/lib/services.server";
import { settle } from "~/lib/settle";
import { bySignalUrgency, reachOutHref } from "~/lib/signals";
import { requireStaff } from "~/lib/staff";

export const meta: Route.MetaFunction = () => [{ title: "Overview · sudo" }, { name: "robots", content: "noindex, nofollow" }];

export async function loader({ request, context }: Route.LoaderArgs) {
  const staff = requireStaff(context);
  // The workspaces list used to live here: old links with a search go on to it.
  const { search, searchParams } = new URL(request.url);
  if (searchParams.has("q") || searchParams.has("show") || searchParams.has("page")) throw redirect(`/workspaces${search}`);

  const [overview, signals] = await Promise.all([settle(admin.overview()), settle(admin.signals())]);
  return {
    me: staff.email,
    overview: overview.ok ? overview.value : null,
    overviewError: overview.ok ? null : overview.error,
    signals: signals.ok ? bySignalUrgency(signals.value) : [],
    signalCount: signals.ok ? signals.value.length : 0,
    signalsError: signals.ok ? null : signals.error,
  };
}

export default function Overview({ loaderData }: Route.ComponentProps) {
  const { me, overview, overviewError, signals, signalCount, signalsError } = loaderData;
  const months = overview?.months ?? [];
  const current = months.find((month) => month.month === overview?.month) ?? months.at(-1) ?? null;
  const previous = current ? months[months.indexOf(current) - 1] ?? null : null;
  const charged = current?.chargedMicros ?? overview?.byKind.reduce((sum, row) => sum + row.chargedMicros, 0) ?? 0;
  const cost = current?.costMicros ?? overview?.byKind.reduce((sum, row) => sum + row.costMicros, 0) ?? 0;
  const margin = marginOf(charged, cost);
  const growth = previous ? change(previous.chargedMicros, charged) : null;

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:py-10">
      <PageHeader
        title="Overview"
        description={overview ? <>The business in {monthLong(overview.month)}, so far, and who needs a word.</> : "The business at a glance."}
      />

      {overviewError && (
        <div className="mt-6">
          <Notice tone="warn">Billing did not answer for the overview: {overviewError}</Notice>
        </div>
      )}

      {overview && (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label="Charged this month"
              value={usd(charged)}
              hint={growth == null ? "Nothing last month to compare" : `${growth >= 0 ? "+" : "−"}${Math.abs(growth)}% on last month`}
              tone={growth != null && growth > 0 ? "mint" : undefined}
            />
            <Stat label="Cost to g1t" value={usd(cost)} hint="What the usage cost on Cloudflare and model providers" />
            <Stat
              label="Margin"
              value={usd(margin.micros)}
              hint={margin.percent == null ? "Nothing charged yet" : `${margin.percent}% of what was charged`}
              tone={margin.micros < 0 ? "danger" : undefined}
            />
            <Stat label="Paying workspaces" value={String(overview.payingWorkspaces)} hint="Charged something this month" />
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <Section title="Last six months" description="Charged against what it cost g1t, every workspace together.">
              <MonthsChart months={months} />
            </Section>
            <Section title="This month by kind" description="Where the money comes from, and what each earns.">
              <KindBreakdown kinds={overview.byKind} />
            </Section>
          </div>

          <h2 className="mt-10 text-lg font-semibold tracking-tight">Needs attention</h2>
          <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-5">
            <AttentionCard
              to={reachOutHref({ kind: "at_limit" })}
              icon={<AlertOctagon size={15} />}
              label="Stopped"
              value={overview.stopped}
              hint="At their limit; work is stopped"
              tone={overview.stopped > 0 ? "danger" : undefined}
            />
            <AttentionCard
              to={reachOutHref({ kind: "near_ceiling" })}
              icon={<Gauge size={15} />}
              label="Near limit"
              value={overview.nearCeiling}
              hint="Past 80% of what is available"
              tone={overview.nearCeiling > 0 ? "warn" : undefined}
            />
            <AttentionCard
              to={reachOutHref({ kind: "declined" })}
              icon={<CreditCard size={15} />}
              label="Declined"
              value={overview.declined}
              hint="Card declined or payment disputed"
              tone={overview.declined > 0 ? "danger" : undefined}
            />
            <AttentionCard
              to="/invoices"
              icon={<FileText size={15} />}
              label="Open invoices"
              value={usd(overview.openInvoicesMicros)}
              hint="Sent and not yet paid"
            />
            <AttentionCard
              to={reachOutHref({})}
              icon={<CalendarClock size={15} />}
              label="Follow-ups due"
              value={overview.followUpsDue}
              hint="Next steps due today or earlier"
              tone={overview.followUpsDue > 0 ? "warn" : undefined}
            />
          </div>
        </>
      )}

      <Section
        title="Reach out"
        description={signalsError ? undefined : signalCount === 0 ? "Nobody needs a word right now." : `The most urgent of ${signalCount}.`}
        actions={
          signalCount > 0 && (
            <Link to="/reach-out" className="inline-flex items-center gap-1 text-sm text-merged hover:underline hover:underline-offset-4">
              All {signalCount}
              <ArrowRight size={14} />
            </Link>
          )
        }
        className="mt-10"
      >
        {signalsError ? (
          <Notice tone="warn">Billing did not answer for signals: {signalsError}</Notice>
        ) : signals.length === 0 ? (
          <p className="text-sm text-muted">No signals. Workspaces show up here when they stop, get close to their limit, are declined, or grow.</p>
        ) : (
          <ul className="-mx-4 -my-4 divide-y divide-line sm:-mx-5 sm:-my-5">
            {signals.slice(0, 5).map((signal, index) => (
              <li key={`${signal.workspace}-${signal.kind}-${index}`}>
                <Link
                  to={`/workspaces/${encodeURIComponent(signal.workspace)}#sales`}
                  className="flex flex-col gap-2 px-4 py-3 transition-colors hover:bg-raised/40 sm:flex-row sm:items-center sm:gap-4 sm:px-5"
                >
                  <span className="flex min-w-0 items-center gap-2.5 sm:w-48 sm:shrink-0">
                    <Avatar name={signal.workspace} size={20} />
                    <span className="truncate font-mono text-sm text-fg">{signal.workspace}</span>
                  </span>
                  <span className="flex min-w-0 grow flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                    <span className="shrink-0">
                      <SignalBadge kind={signal.kind} />
                    </span>
                    <span className="min-w-0 text-sm text-muted">{signal.detail}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3 text-xs sm:w-56 sm:justify-end">
                    <span className="tabular text-fg-soft">{usd(signal.valueMicros)}</span>
                    {signal.stage && signal.stage !== "none" && <StageBadge stage={signal.stage} />}
                    <StaffName email={signal.owner} me={me} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </main>
  );
}

function AttentionCard({
  to,
  icon,
  label,
  value,
  hint,
  tone,
}: {
  to: string;
  icon: ReactNode;
  label: string;
  value: ReactNode;
  hint: string;
  tone?: "danger" | "warn";
}) {
  const color = tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : "text-fg";
  return (
    <Link to={to} className="group rounded-lg border border-line bg-surface px-4 py-3 transition-colors hover:border-line-strong">
      <p className="flex items-center gap-1.5 text-xs text-muted">
        <span className={tone ? color : "text-faint"}>{icon}</span>
        {label}
        <ArrowRight size={12} className="ml-auto text-faint opacity-0 transition-opacity group-hover:opacity-100" />
      </p>
      <p className={`tabular mt-1 text-lg font-semibold tracking-tight ${color}`}>{value}</p>
      <p className="mt-0.5 text-xs text-faint">{hint}</p>
    </Link>
  );
}
