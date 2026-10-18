import type { GrowthCount } from "@g1t/contracts";
import {
  Activity,
  AlertOctagon,
  ArrowRight,
  Building2,
  CalendarClock,
  CreditCard,
  FileText,
  Gauge,
  HandHelping,
  Minus,
  TrendingDown,
  TrendingUp,
  UserPlus,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link, redirect } from "react-router";

import type { Route } from "./+types/overview";
import { KindBreakdown, MonthsChart } from "~/components/charts";
import { SignalBadge, StaffName, StageBadge } from "~/components/sales";
import { Avatar, Badge, Notice, PageHeader, Section, Stat } from "~/components/ui";
import { change, dayShort, monthLong } from "~/lib/chart";
import { givenLabel, givenTotal, marginApart, moneyApart } from "~/lib/pricing";
import { givenParts } from "~/lib/costs";
import { usd } from "~/lib/money";
import { admin, identity } from "~/lib/services.server";
import { settle } from "~/lib/settle";
import { bySignalUrgency, reachOutHref } from "~/lib/signals";
import { requireStaff } from "~/lib/staff";
import { ago } from "~/lib/time";

export const meta: Route.MetaFunction = () => [{ title: "Overview · sudo" }, { name: "robots", content: "noindex, nofollow" }];

export async function loader({ request, context }: Route.LoaderArgs) {
  const staff = requireStaff(context);
  // The workspaces list used to live here: old links with a search go on to it.
  const { search, searchParams } = new URL(request.url);
  if (searchParams.has("q") || searchParams.has("show") || searchParams.has("page")) throw redirect(`/workspaces${search}`);

  const [overview, signals, growth] = await Promise.all([settle(admin.overview()), settle(admin.signals()), settle(identity.growth())]);
  return {
    me: staff.email,
    now: Date.now(),
    growth: growth.ok ? growth.value : null,
    growthError: growth.ok ? null : growth.error,
    overview: overview.ok ? overview.value : null,
    overviewError: overview.ok ? null : overview.error,
    signals: signals.ok ? bySignalUrgency(signals.value) : [],
    signalCount: signals.ok ? signals.value.length : 0,
    signalsError: signals.ok ? null : signals.error,
  };
}

export default function Overview({ loaderData }: Route.ComponentProps) {
  const { me, now, growth: people, growthError, overview, overviewError, signals, signalCount, signalsError } = loaderData;
  const months = overview?.months ?? [];
  const current = months.find((month) => month.month === overview?.month) ?? months.at(-1) ?? null;
  const previous = current ? (months[months.indexOf(current) - 1] ?? null) : null;
  const charged = current?.chargedMicros ?? overview?.byKind.reduce((sum, row) => sum + row.chargedMicros, 0) ?? 0;
  const cost = current?.costMicros ?? overview?.byKind.reduce((sum, row) => sum + row.costMicros, 0) ?? 0;
  const plans = current?.plansMicros ?? 0;
  const given = overview?.given ?? [];
  const givenSum = givenTotal(given);
  // The Costs page's model when billing has rolled up a day of this month:
  // the same figures, so the two pages never disagree. Before that, the
  // ledger's month so far.
  const mm = overview?.monthMargin ?? null;
  const money = mm ? marginApart(mm) : moneyApart({ chargedMicros: charged, plansMicros: plans, costMicros: cost }, givenSum.costMicros);
  const usage = mm ? mm.usageMicros : charged;
  const plansIn = mm ? mm.plansMicros : plans;
  const allCost = mm ? mm.costMicros : cost;
  const givenRows = mm ? givenParts(mm) : [];
  const growth = previous ? change(previous.chargedMicros + (previous.plansMicros ?? 0), money.revenueMicros) : null;

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:py-10">
      <PageHeader
        title="Overview"
        description={
          overview ? (
            <>
              The business in {monthLong(overview.month)}
              {overview.marginThrough ? <>, through {dayShort(overview.marginThrough)}</> : ", so far"}, and who needs a word.
            </>
          ) : (
            "The business at a glance."
          )
        }
      />

      {growthError ? (
        <div className="mt-6">
          <Notice tone="warn">Identity did not answer for sign-ups: {growthError}</Notice>
        </div>
      ) : (
        people && (
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <GrowthCard
              to={people.people.newest ? `/users/${encodeURIComponent(people.people.newest)}` : "/invites"}
              icon={<UserPlus size={16} />}
              label="Customers"
              noun="sign-up"
              count={people.people}
              now={now}
            />
            <GrowthCard to="/workspaces" icon={<Building2 size={16} />} label="Workspaces" noun="new workspace" count={people.workspaces} now={now} />
          </div>
        )
      )}

      {overviewError && (
        <div className="mt-6">
          <Notice tone="warn">Billing did not answer for the overview: {overviewError}</Notice>
        </div>
      )}

      {overview && (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label="Revenue this month"
              value={usd(money.revenueMicros)}
              hint={
                <>
                  {usd(usage)} usage, {usd(plansIn)} plans
                  {growth == null ? "" : ` · ${growth >= 0 ? "+" : "−"}${Math.abs(growth)}% on last month`}
                </>
              }
              tone={growth != null && growth > 0 ? "mint" : undefined}
            />
            <Stat
              label="Margin on what was sold"
              value={money.revenueMicros > 0 ? usd(money.marginMicros) : "—"}
              hint={money.marginPercent == null ? "Nothing sold yet" : `${money.marginPercent}% of revenue, after ${usd(money.soldCostMicros)} of cost`}
              tone={money.revenueMicros > 0 && money.marginMicros < 0 ? "danger" : undefined}
            />
            {mm ? (
              <Stat
                label="Given by g1t"
                value={usd(mm.givenMicros)}
                hint={`What it cost g1t, ${givenRows.length === 0 ? "nothing yet" : "by why below"}. Not a loss on sales.`}
              />
            ) : (
              <Stat label="Given by g1t" value={usd(givenSum.micros)} hint={`At price; it cost g1t ${usd(givenSum.costMicros)}. Not a loss on sales.`} />
            )}
            <Stat
              label="Plans"
              value={String(overview.activePlans ?? 0)}
              hint={`${usd(overview.planMrrMicros ?? 0)} a month · ${overview.payingWorkspaces} paying this month`}
            />
          </div>
          <p className="mt-2 text-xs text-faint">
            Cost to g1t in all {usd(allCost)}
            {mm ? ` (Cloudflare ${usd(mm.cloudflareCostMicros ?? 0)}, models ${usd(mm.modelsCostMicros ?? 0)})` : ""}; revenue less all of it, given included:{" "}
            {usd(money.netMicros)}.{" "}
            <Link to="/costs" className="text-accent hover:underline">
              Costs &amp; margin
            </Link>
          </p>

          {overview.pools && (
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Stat
                label="Open-source pool"
                value={`${usd(overview.pools.ossUsedMicros)} of ${usd(overview.pools.ossPoolMicros)}`}
                hint={`Paid for work on public repositories this month; up to ${usd(overview.pools.ossRepoMicros)} each`}
                tone={overview.pools.ossUsedMicros >= overview.pools.ossPoolMicros ? "warn" : undefined}
              />
              <Stat
                label="Trials given"
                value={`${usd(overview.pools.trialGrantedMicros)} of ${usd(overview.pools.trialPoolMicros)}`}
                hint={`${overview.pools.trialGrants} trial${overview.pools.trialGrants === 1 ? "" : "s"} given this month; new trials wait when the pool is given out`}
                tone={overview.pools.trialGrantedMicros >= overview.pools.trialPoolMicros ? "warn" : undefined}
              />
            </div>
          )}

          <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <Section title="Last six months" description="Charged against what it cost g1t, every workspace together.">
              <MonthsChart months={months} />
            </Section>
            <Section title="This month by kind" description="Where the money comes from, and what each earns.">
              <KindBreakdown kinds={overview.byKind} />
            </Section>
          </div>

          <Section
            title="Given this month, apart from margin"
            description={
              mm
                ? "What g1t's gifts cost it, by why: comped workspaces, free use, trials, the open-source pool, discounts, and credits from g1t as they are spent."
                : "Internal use, trials, the open-source pool, goodwill and what g1t covered: at price, and what it cost."
            }
            className="mt-6"
          >
            {mm ? (
              givenRows.length === 0 ? (
                <p className="text-sm text-muted">Nothing given yet this month.</p>
              ) : (
                <div className="-mx-4 -my-4 overflow-x-auto sm:-mx-5 sm:-my-5">
                  <table className="w-full min-w-80 text-sm">
                    <thead>
                      <tr className="border-b border-line text-left text-xs text-muted">
                        <th className="px-4 py-2 font-medium sm:pl-5">Why</th>
                        <th className="px-4 py-2 text-right font-medium sm:pr-5">Cost to g1t</th>
                      </tr>
                    </thead>
                    <tbody>
                      {givenRows.map(([why, micros]) => (
                        <tr key={why} className="border-b border-line last:border-0">
                          <td className="px-4 py-2 first-letter:uppercase sm:pl-5">{why}</td>
                          <td className="tabular px-4 py-2 text-right sm:pr-5">{usd(micros)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            ) : given.length === 0 ? (
              <p className="text-sm text-muted">Nothing given yet this month.</p>
            ) : (
              <div className="-mx-4 -my-4 overflow-x-auto sm:-mx-5 sm:-my-5">
                <table className="w-full min-w-104 text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs text-muted">
                      <th className="px-4 py-2 font-medium sm:pl-5">Source</th>
                      <th className="px-4 py-2 text-right font-medium">At price</th>
                      <th className="px-4 py-2 text-right font-medium sm:pr-5">Cost to g1t</th>
                    </tr>
                  </thead>
                  <tbody>
                    {given.map((row) => (
                      <tr key={row.source} className="border-b border-line last:border-0">
                        <td className="px-4 py-2 sm:pl-5">{givenLabel(row)}</td>
                        <td className="tabular px-4 py-2 text-right">{usd(row.micros)}</td>
                        <td className="tabular px-4 py-2 text-right text-muted sm:pr-5">{usd(row.costMicros)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {(overview.internal ?? []).length > 0 && (
              <ul className="mt-6 space-y-1 border-t border-line pt-3 text-xs">
                {(overview.internal ?? []).map((row) => (
                  <li key={row.workspace} className="flex flex-wrap justify-between gap-2">
                    <span>
                      <Link to={`/workspaces/${encodeURIComponent(row.workspace)}`} className="font-mono text-fg-soft hover:underline">
                        {row.workspace}
                      </Link>{" "}
                      <span className="text-faint">{row.reason}</span>
                    </span>
                    <span className="tabular text-muted">
                      {usd(row.costMicros)} cost · {row.entries} entries
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <h2 className="mt-10 text-lg font-semibold tracking-tight">Needs attention</h2>
          <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <AttentionCard
              to="/requests"
              icon={<HandHelping size={15} />}
              label="Requests"
              value={overview.openRequests ?? 0}
              hint="Waiting for an answer, within one business day"
              tone={(overview.openRequests ?? 0) > 0 ? "warn" : undefined}
            />
            <AttentionCard
              to="/overages"
              icon={<TrendingUp size={15} />}
              label="Overages"
              value={overview.overages ?? 0}
              hint="Well past their typical month"
              tone={(overview.overages ?? 0) > 0 ? "warn" : undefined}
            />
            <AttentionCard
              to="/velocity"
              icon={<Activity size={15} />}
              label="Spikes"
              value={overview.openSpikes ?? 0}
              hint="Paused, waiting on an owner"
              tone={(overview.openSpikes ?? 0) > 0 ? "danger" : undefined}
            />
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
              to={reachOutHref({ due: true })}
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
            <Link to="/reach-out" className="inline-flex items-center gap-1 text-sm text-accent hover:underline hover:underline-offset-4">
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

/**
 * A headline count: the total, this week's new ones against the week
 * before, and the newest, so a sign-up is seen the day it happens.
 */
function GrowthCard({ to, icon, label, noun, count, now }: { to: string; icon: ReactNode; label: string; noun: string; count: GrowthCount; now: number }) {
  const delta = count.week - count.priorWeek;
  const Trend = delta > 0 ? TrendingUp : delta < 0 ? TrendingDown : Minus;
  const trendColor = delta > 0 ? "text-success" : delta < 0 ? "text-warn" : "text-faint";
  const fresh = count.day > 0;
  return (
    <Link to={to} className="group rounded-lg border border-line bg-surface px-5 py-4 transition-colors hover:border-line-strong">
      <p className="flex items-center gap-1.5 text-sm text-muted">
        <span className={fresh ? "text-accent" : "text-faint"}>{icon}</span>
        {label}
        {fresh && (
          <span className="ml-1">
            <Badge tone="lavender">{count.day} new today</Badge>
          </span>
        )}
        <ArrowRight size={14} className="ml-auto text-faint opacity-0 transition-opacity group-hover:opacity-100" />
      </p>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="tabular text-3xl font-semibold tracking-tight text-fg">{count.total.toLocaleString("en-US")}</span>
        <span className={`tabular inline-flex items-center gap-1 text-sm font-medium ${trendColor}`}>
          <Trend size={14} />
          {count.week > 0 ? `+${count.week}` : "None"} this week
        </span>
        <span className="tabular text-xs text-faint">
          {delta === 0 ? "same as" : `${delta > 0 ? "+" : "−"}${Math.abs(delta)} on`} the week before ({count.priorWeek})
        </span>
      </div>
      <p className="mt-2 truncate text-xs text-faint">
        {count.newest && count.newestAt ? (
          <>
            Newest {noun}: <span className="font-mono text-fg-soft">{count.newest}</span>, {ago(count.newestAt, now)}
          </>
        ) : (
          `No ${noun}s yet`
        )}
      </p>
    </Link>
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
