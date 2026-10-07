import { ArrowUpRight, CreditCard } from "lucide-react";
import { Link, data } from "react-router";

import { MICROS_PER_DOLLAR, type UsageSlice } from "@g1t/contracts";

import type { Route } from "./+types/usage";
import { foldTasks, planStatus, usageTask } from "../../lib/billing";
import { page } from "../../lib/meta";
import { ButtonLink } from "../../components/ui";
import { billing } from "../../lib/services.server";
import { getViewer, roleIn, unwrap } from "../../lib/session.server";

const PERIODS = {
  month: "This month",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
} as const;
type Period = keyof typeof PERIODS;

/** What each kind of agent work is called, and its colour. */
const task = usageTask;

function start(period: Period, now = new Date()): Date {
  if (period === "month") return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const days = Number(period.replace("d", ""));
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return new Date(day.getTime() - (days - 1) * 86_400_000);
}

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Usage · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const asked = new URL(request.url).searchParams.get("period");
  const period: Period = asked && asked in PERIODS ? (asked as Period) : "month";
  const since = start(period);
  const [usage, account, features, entitlements] = await Promise.all([
    billing.usage(params.owner, viewer, since.toISOString()),
    billing.account(params.owner, viewer),
    billing.features(params.owner, viewer).catch(() => null),
    billing.entitlements(params.owner).catch(() => null),
  ]);
  const plan = features?.ok ? (features.value.find((state) => state.plan.feature === "plan") ?? null) : null;
  // A comped workspace is charged nothing, so it has no credit to run down.
  const comped = planStatus(plan, entitlements).kind === "comped";
  return { period, since: since.toISOString(), usage: unwrap(usage), account: unwrap(account), comped };
}

function dollars(micros: number, digits = 2): string {
  return `$${(micros / MICROS_PER_DOLLAR).toFixed(digits)}`;
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-2xl bg-surface p-5 ring-1 ring-line">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-2 text-3xl font-semibold tracking-tight tabular-nums">{value}</p>
      {note && <p className="mt-1 text-xs text-faint">{note}</p>}
    </div>
  );
}

/** Spend per day, stacked by kind of work. */
function Chart({ since, slices }: { since: string; slices: UsageSlice[] }) {
  const first = new Date(since);
  const today = new Date();
  const days: string[] = [];
  for (let day = first; day <= today; day = new Date(day.getTime() + 86_400_000)) {
    days.push(day.toISOString().slice(0, 10));
  }
  const byDay = new Map<string, { task: string; micros: number }[]>();
  for (const slice of slices) {
    const [day, kind] = slice.key.split("/");
    byDay.set(day!, [...(byDay.get(day!) ?? []), { task: kind ?? "other", micros: slice.micros }]);
  }
  const totals = days.map((day) => (byDay.get(day) ?? []).reduce((sum, part) => sum + part.micros, 0));
  const max = Math.max(...totals, 1);
  const height = 160;
  const width = 100 / days.length;
  return (
    <div>
      <div className="relative" style={{ height }}>
        {/* Gridlines at a quarter, a half and three quarters of the highest day. */}
        {[0.25, 0.5, 0.75, 1].map((at) => (
          <div key={at} className="absolute inset-x-0 border-t border-line/60" style={{ bottom: `${at * 100}%` }}>
            <span className="absolute -top-2.5 right-0 bg-surface pl-1 font-mono text-[0.625rem] text-faint">
              {dollars(max * at)}
            </span>
          </div>
        ))}
        <div className="absolute inset-0 flex items-end gap-px pr-12">
          {days.map((day, index) => {
            const parts = byDay.get(day) ?? [];
            return (
              <div
                key={day}
                className="group relative flex h-full flex-col justify-end"
                style={{ width: `${width}%` }}
                title={`${day}: ${dollars(totals[index]!)}`}
              >
                {parts.map((part) => (
                  <div
                    key={part.task}
                    className="w-full first:rounded-t-sm"
                    style={{ height: `${(part.micros / max) * 100}%`, background: task(part.task).color }}
                  />
                ))}
                <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 hidden -translate-x-1/2 rounded-md bg-raised px-2 py-1 text-xs whitespace-nowrap ring-1 ring-line-strong group-hover:block">
                  <span className="text-muted">{day}</span> {dollars(totals[index]!)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="mt-2 flex justify-between pr-12 font-mono text-[0.625rem] text-faint">
        <span>{days[0]}</span>
        <span>{days[days.length - 1]}</span>
      </div>
    </div>
  );
}

function Breakdown({
  title,
  slices,
  total,
  label,
  link,
  color,
}: {
  title: string;
  slices: UsageSlice[];
  total: number;
  label?: (key: string) => string;
  link?: (key: string) => string | null;
  color?: (key: string) => string;
}) {
  return (
    <section className="rounded-2xl bg-surface p-5 ring-1 ring-line">
      <h3 className="text-sm font-medium">{title}</h3>
      {slices.length === 0 ? (
        <p className="mt-4 text-sm text-faint">Nothing in this period.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {slices.map((slice) => {
            const to = link?.(slice.key);
            const name = label ? label(slice.key) : slice.key;
            return (
              <li key={slice.key}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate">
                    {to ? (
                      <Link to={to} className="hover:underline">
                        {name}
                      </Link>
                    ) : (
                      name
                    )}
                  </span>
                  <span className="shrink-0 font-mono text-xs tabular-nums">
                    {dollars(slice.micros)} <span className="text-faint">· {slice.runs} {slice.runs === 1 ? "run" : "runs"}</span>
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-raised">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${total ? (slice.micros / total) * 100 : 0}%`,
                      background: color?.(slice.key) ?? "var(--color-merged)",
                    }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export default function UsagePage({ loaderData, params }: Route.ComponentProps) {
  const { period, since, usage, account, comped } = loaderData;
  const byTask = foldTasks(usage.byTask);
  const base = `/${params.owner}`;
  const days = Math.max(1, Math.ceil((Date.now() - new Date(since).getTime()) / 86_400_000));
  // While g1t is free nothing is charged, so usage is measured at cost
  // and credit is not drawn down.
  // Free or comped, nothing is charged: what the runs used, at cost, is
  // what there is to show.
  const atCost = usage.free || comped;
  const total = atCost ? usage.usedMicros : usage.spentMicros;
  const perDay = atCost ? 0 : total / days;
  const runway = perDay > 0 ? Math.floor(account.balanceMicros / perDay) : null;
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-end gap-4">
        <nav className="flex rounded-lg bg-surface p-1 ring-1 ring-line">
          {(Object.keys(PERIODS) as Period[]).map((key) => (
            <Link
              key={key}
              to={`?period=${key}`}
              preventScrollReset
              className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                key === period ? "bg-raised text-fg" : "text-muted hover:text-fg"
              }`}
            >
              {PERIODS[key]}
            </Link>
          ))}
        </nav>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {atCost ? (
          <Stat
            label="Used"
            value={dollars(total)}
            note={comped ? "At cost. The workspace is comped: nothing is charged." : "At cost. Nothing is charged while g1t is being built out."}
          />
        ) : (
          <Stat
            label="Spent"
            value={dollars(usage.spentMicros)}
            note={
              usage.providerMicros > 0
                ? `Plus about ${dollars(usage.providerMicros)} billed by your own model provider`
                : `${dollars(usage.costMicros)} of it the model provider's`
            }
          />
        )}
        <Stat label="Agent runs" value={String(usage.runs)} note={PERIODS[period]} />
        <Stat
          label="Average run"
          value={usage.runs ? dollars(total / usage.runs, 3) : "—"}
          note="Making a change, reviewing, revising…"
        />
        {comped ? (
          // Nothing is charged to a comped workspace: no credit to run down.
          <div className="rounded-2xl bg-surface p-5 ring-1 ring-line">
            <p className="text-sm text-muted">Credit</p>
            <p className="mt-2 text-3xl font-semibold tracking-tight text-accent">Comped</p>
            <p className="mt-1 text-xs text-faint">Recorded at what it costs; nothing is charged to this workspace.</p>
          </div>
        ) : (
          <div className="rounded-2xl bg-surface p-5 ring-1 ring-line">
            <p className="flex items-center justify-between text-sm text-muted">
              Credit left
              {!usage.free && (
                <Link to={`${base}/-/billing`} className="text-xs text-accent hover:underline">
                  Add credit
                </Link>
              )}
            </p>
            <p className={`mt-2 text-3xl font-semibold tracking-tight tabular-nums ${account.balanceMicros <= 0 ? "text-warn" : ""}`}>
              {dollars(account.balanceMicros)}
            </p>
            <p className="mt-1 text-xs text-faint">
              {usage.free
                ? "Not drawn down while g1t is free."
                : runway == null
                  ? "Nothing spent in this period."
                  : `About ${runway} ${runway === 1 ? "day" : "days"} at this rate.`}
            </p>
          </div>
        )}
      </div>

      <section className="rounded-2xl bg-surface p-5 ring-1 ring-line">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h3 className="text-sm font-medium">{atCost ? "Usage per day" : "Spend per day"}</h3>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            {byTask.map((slice) => (
              <li key={slice.key} className="flex items-center gap-1.5">
                <span className="size-2 rounded-sm" style={{ background: task(slice.key).color }} />
                {task(slice.key).label}
              </li>
            ))}
          </ul>
        </div>
        <div className="mt-6">
          <Chart since={since} slices={usage.byDay} />
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Breakdown
          title="By kind of work"
          slices={byTask}
          total={total}
          label={(key) => task(key).label}
          color={(key) => task(key).color}
        />
        <Breakdown title="By repository" slices={usage.byRepo} total={total} link={(key) => `/${key}`} />
        <Breakdown
          title="Pull requests that cost most"
          slices={usage.byPull}
          total={usage.byPull[0]?.micros ?? 0}
          // Planning runs belong to a repository, not a pull request.
          label={(key) => (key.endsWith("#0") ? `${key.slice(0, -2)} · planning` : key)}
          link={(key) => {
            const [repo, number] = key.split("#");
            if (!repo) return null;
            return number && number !== "0" ? `/${repo}/pull/${number}` : `/${repo}/plans`;
          }}
        />
        <Breakdown title="By model" slices={usage.byModel} total={total} color={() => "var(--color-info)"} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-surface px-5 py-4 text-sm ring-1 ring-line">
        <span className="flex items-center gap-2 text-muted">
          <CreditCard size={15} />
          {usage.addedMicros > 0
            ? `${dollars(usage.addedMicros)} of credit added in this period.`
            : "Every charge and payment is on the workspace's statement."}
        </span>
        <ButtonLink to={`${base}/-/billing`} variant="quiet">
          Statement and credit
          <ArrowUpRight size={14} />
        </ButtonLink>
      </div>
    </div>
  );
}
