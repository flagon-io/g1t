/**
 * The Usage page's pieces, shared by the workspace's page and a project's:
 * the filters, the included-usage and credit bar with what paid, the
 * consumption chart (stacked columns by product, money on one axis, a
 * tooltip per column, a legend, a table view), and the breakdown by
 * product family with sparklines, allowance rings and each meter's
 * projects. Every amount is usage at price, as on every other page.
 */
import { ChevronDown, Download, Ellipsis, FileCode } from "lucide-react";
import { type ReactNode, useId, useRef } from "react";
import { Form, Link } from "react-router";

import type { MeterLine, ProductUsage, UsageReport } from "@g1t/contracts";

import {
  type Column,
  type Grain,
  type GroupBy,
  PERIODS,
  type Period,
  axisMoney,
  byProject,
  money,
  productStyle,
  quantity,
  rangeLabel,
  receipt,
  shownLines,
  ticks,
  usageCsv,
} from "../lib/usage";
import { cn } from "../lib/cn";
import { Checkbox } from "./ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Hint } from "./ui/hint";
import { Input } from "./ui/input";
import { SelectField } from "./ui/select";
import { Skeleton } from "./ui/skeleton";

const SELECT =
  "h-8 rounded-md border border-line bg-bg px-2 text-sm text-fg outline-none transition-colors hover:border-line-strong focus:border-accent-dim";

// --- Filters ------------------------------------------------------------------------

export type UsageFilters = {
  period: Period;
  from: string;
  until: string;
  products: string[];
  projects: string[];
  group: GroupBy;
  grain: Grain;
  cumulative: boolean;
};

/** A multi-select as a disclosure of checkboxes, part of the filter form. */
function MultiSelect({ name, label, options, chosen }: { name: string; label: string; options: { value: string; label: string }[]; chosen: string[] }) {
  const summary = chosen.length === 0 ? `All ${label.toLowerCase()}` : chosen.length === 1 ? (options.find((o) => o.value === chosen[0])?.label ?? chosen[0]) : `${chosen.length} ${label.toLowerCase()}`;
  return (
    <details className="group relative">
      <summary className={cn(SELECT, "flex cursor-pointer list-none items-center gap-1.5 [&::-webkit-details-marker]:hidden")}>
        <span className="text-muted">{label}:</span>
        <span className="max-w-[10rem] truncate">{summary}</span>
        <ChevronDown size={13} className="text-muted transition-transform group-open:rotate-180" />
      </summary>
      <div className="absolute left-0 z-20 mt-1 w-64 rounded-lg border border-line bg-raised p-2 shadow-xl">
        {options.length === 0 ? (
          <p className="px-2 py-1.5 text-sm text-faint">None in this range.</p>
        ) : (
          <ul className="max-h-64 overflow-y-auto">
            {options.map((option) => (
              <li key={option.value}>
                <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-surface">
                  <Checkbox name={name} value={option.value} defaultChecked={chosen.includes(option.value)} />
                  <span className="truncate">{option.label}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <button type="submit" className="mt-2 w-full rounded-md bg-fg px-2 py-1.5 text-sm font-medium text-bg hover:bg-fg-hover">
          Apply
        </button>
      </div>
    </details>
  );
}

/**
 * The filters, in one row above everything: period (with its days),
 * products, projects, group by, and a menu with the CSV and the API.
 * A plain GET form, so a filtered page is a link.
 */
export function UsageFilterBar({
  filters,
  products,
  projects,
  report,
  apiHref,
  fixedProject,
}: {
  filters: UsageFilters;
  products: { key: string; label: string }[];
  projects: string[];
  report: UsageReport | null;
  apiHref: string;
  /** A project's own page: no project filter. */
  fixedProject?: string;
}) {
  const form = useRef<HTMLFormElement>(null);
  const submit = () => form.current?.requestSubmit();
  const download = () => {
    if (!report) return;
    const blob = new Blob([usageCsv(report)], { type: "text/csv" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `usage-${report.from}-${report.until}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };
  return (
    <Form ref={form} method="get" preventScrollReset className="flex flex-wrap items-center gap-2">
      <SelectField
        key={`period-${filters.period}`}
        name="period"
        defaultValue={filters.period}
        afterChange={submit}
        size="sm"
        className="w-auto"
        aria-label="Period"
        options={(Object.keys(PERIODS) as Period[]).map((key) => ({ value: key, label: PERIODS[key] }))}
      />
      {filters.period === "custom" ? (
        <span className="flex items-center gap-1 text-sm">
          <Input type="date" name="from" defaultValue={filters.from} aria-label="From" className="h-8 w-auto px-2" />
          <span className="text-faint">to</span>
          <Input type="date" name="until" defaultValue={filters.until} aria-label="Until" className="h-8 w-auto px-2" />
        </span>
      ) : (
        <span className="px-1 text-sm text-muted tabular-nums">{rangeLabel(filters.from, filters.until)}</span>
      )}
      <MultiSelect name="product" label="Products" options={products.map((p) => ({ value: p.key, label: p.label }))} chosen={filters.products} />
      {!fixedProject && <MultiSelect name="project" label="Projects" options={projects.map((p) => ({ value: p, label: p }))} chosen={filters.projects} />}
      <SelectField
        key={`group-${filters.group}`}
        name="group"
        defaultValue={filters.group}
        afterChange={submit}
        size="sm"
        className="w-auto"
        aria-label="Group by"
        options={[
          { value: "product", label: "Group by product" },
          ...(fixedProject ? [] : [{ value: "project", label: "Group by project" }]),
          { value: "day", label: "Group by day" },
        ]}
      />
      <input type="hidden" name="grain" value={filters.grain} />
      {filters.cumulative && <input type="hidden" name="cumulative" value="1" />}
      <noscript>
        <button type="submit" className={SELECT}>
          Apply
        </button>
      </noscript>
      <span className="ml-auto" />
      <DropdownMenu>
        <DropdownMenuTrigger className={cn(SELECT, "inline-flex items-center")} aria-label="More">
          <Ellipsis size={15} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={download} disabled={!report}>
            <Download size={14} /> Export CSV
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href={apiHref}>
              <FileCode size={14} /> Usage API
            </a>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </Form>
  );
}

// --- What is included and what paid ------------------------------------------------------

/** A bar of how much of something is used. */
function Bar({ used, of, tone = "accent" }: { used: number; of: number; tone?: "accent" | "warn" }) {
  const part = of > 0 ? Math.min(1, used / of) : 0;
  return (
    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line" role="presentation">
      <div className={cn("h-full rounded-full", tone === "warn" ? "bg-warn" : "bg-success")} style={{ width: `${part > 0 ? Math.max(2, part * 100) : 0}%` }} />
    </div>
  );
}

/**
 * The plan's included usage, the credit balances, and the receipt: usage
 * at price, what a discount, included usage and credit took off, and what
 * is charged.
 */
export function IncludedAndCredit({ report, billingHref, owner }: { report: UsageReport; billingHref: string; owner: boolean }) {
  const lines = receipt(report.totals, report.discountPercent);
  const free = report.plan === "free";
  const fullDiscount = (report.discountPercent ?? 0) >= 100;
  return (
    <section className="grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-3">
      <div className="bg-surface p-4">
        <p className="text-sm text-muted">{report.included ? "Included usage this month" : free ? "Trial credit" : "Plan"}</p>
        {report.included ? (
          <>
            <p className="mt-1 text-lg font-semibold tabular-nums">
              {money(report.included.used)} <span className="text-sm font-normal text-faint">/ {money(report.included.of)}</span>
            </p>
            <Bar used={report.included.used} of={report.included.of} />
          </>
        ) : free ? (
          <>
            <p className="mt-1 text-lg font-semibold tabular-nums">{report.trialMicros != null ? `${money(report.trialMicros)} left` : "None"}</p>
            <p className="mt-1 text-xs text-faint">
              The forge is free. Compute needs the plan or the trial.{" "}
              <Link to={billingHref} className="text-fg-soft underline-offset-2 hover:underline">
                See plans
              </Link>
            </p>
          </>
        ) : (
          <p className="mt-1 text-sm">{fullDiscount ? `${report.discountPercent}% discount from g1t` : report.plan === "enterprise" ? "Paid by an enterprise" : "On the g1t plan"}</p>
        )}
      </div>
      <div className="bg-surface p-4">
        <p className="text-sm text-muted">Credit</p>
        {fullDiscount ? (
          <p className="mt-1 text-sm">AI usage is free under the {report.discountPercent}% discount: nothing to buy.</p>
        ) : (
          <dl className="mt-1 space-y-1 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-muted">AI credit</dt>
              <dd className="font-medium tabular-nums">{money(report.aiCreditMicros)}</dd>
            </div>
            {report.creditMicros > 0 && (
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Credit from g1t</dt>
                <dd className="tabular-nums">{money(report.creditMicros)}</dd>
              </div>
            )}
            {owner && report.plan === "paid" && (
              <dd>
                <Link to={`${billingHref}#ai-credit`} className="text-xs text-fg-soft underline-offset-2 hover:underline">
                  Buy AI credit or turn on auto-reload
                </Link>
              </dd>
            )}
          </dl>
        )}
      </div>
      <div className="bg-surface p-4">
        <p className="text-sm text-muted">This range</p>
        <dl className="mt-1 space-y-1 text-sm">
          {lines.map((line, i) => (
            <div key={line.label} className={cn("flex justify-between gap-3", i === lines.length - 1 && "border-t border-line pt-1 font-medium")}>
              <dt className={i === lines.length - 1 ? "" : "text-muted"}>{line.label}</dt>
              <dd className="tabular-nums">
                {line.minus ? "−" : ""}
                {money(line.micros)}
              </dd>
            </div>
          ))}
        </dl>
        {report.totals.pendingMicros > 0 && (
          <p className="mt-1 text-xs text-faint">{money(report.totals.pendingMicros)} of it is metered this month and charged when it closes.</p>
        )}
      </div>
    </section>
  );
}

// --- The chart -----------------------------------------------------------------------------

const CHART_HEIGHT = 200;

/**
 * Consumption: one column per day (or week, or month), stacked by product,
 * money on the one axis. Hovering or focusing a column shows its products;
 * the legend names them; the table view has every number.
 */
export function UsageChart({
  columns,
  products,
  grain,
  cumulative,
  grainHref,
  cumulativeHref,
}: {
  columns: Column[];
  products: ProductUsage[];
  grain: Grain;
  cumulative: boolean;
  grainHref: (grain: Grain) => string;
  cumulativeHref: string;
}) {
  const used = products.filter((p) => p.micros !== 0 && columns.some((c) => (c.parts[p.key] ?? 0) !== 0));
  const max = Math.max(0, ...columns.map((c) => c.total));
  const scale = ticks(max);
  const top = scale[scale.length - 1] || 1;
  const id = useId();
  const labelEvery = Math.max(1, Math.ceil(columns.length / 6));
  return (
    <section className="rounded-xl border border-line bg-surface p-4 sm:p-5" aria-labelledby={`${id}-title`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={`${id}-title`} className="font-medium">
          Consumption
        </h2>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <nav className="flex rounded-md border border-line p-0.5" aria-label="Columns">
            {(["day", "week", "month"] as Grain[]).map((g) => (
              <Link
                key={g}
                to={grainHref(g)}
                preventScrollReset
                aria-current={g === grain ? "true" : undefined}
                className={cn("rounded px-2 py-0.5 capitalize", g === grain ? "bg-raised text-fg" : "text-muted hover:text-fg")}
              >
                {g === "day" ? "Daily" : g === "week" ? "Weekly" : "Monthly"}
              </Link>
            ))}
          </nav>
          <Link to={cumulativeHref} preventScrollReset className="flex items-center gap-1.5 text-muted hover:text-fg" role="checkbox" aria-checked={cumulative}>
            <span className={cn("grid size-3.5 place-items-center rounded-sm border", cumulative ? "border-accent bg-accent text-bg" : "border-line-strong")}>
              {cumulative && <span className="text-[0.6rem] leading-none">✓</span>}
            </span>
            Cumulative
          </Link>
        </div>
      </div>
      {used.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="Legend">
          {used.map((p) => (
            <li key={p.key} className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm" style={{ background: productStyle(p.key).color }} />
              {p.label}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex gap-2">
        {/* The one money axis: clean ticks, every label different. */}
        <div className="relative w-12 shrink-0 text-right text-[0.6875rem] text-faint tabular-nums" style={{ height: CHART_HEIGHT }} aria-hidden="true">
          {scale.map((t) => (
            <span key={t} className="absolute right-0 -translate-y-1/2" style={{ top: `${100 - (t / top) * 100}%` }}>
              {axisMoney(t)}
            </span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1" style={{ height: CHART_HEIGHT }}>
          {scale.map((t) => (
            <div key={t} className="absolute inset-x-0 border-t border-line" style={{ top: `${100 - (t / top) * 100}%` }} aria-hidden="true" />
          ))}
          <div className="absolute inset-0 flex items-end" role="list" aria-label="Usage per column">
            {columns.map((column, i) => (
              <div
                key={column.key}
                role="listitem"
                tabIndex={0}
                aria-label={`${column.label}: ${money(column.total)}`}
                className="group relative flex h-full min-w-0 flex-1 flex-col items-center justify-end outline-none"
              >
                <div className="flex w-full max-w-6 flex-col-reverse gap-[2px] px-[1px]" style={{ height: `${(column.total / top) * 100}%` }}>
                  {used
                    .filter((p) => (column.parts[p.key] ?? 0) > 0)
                    .map((p, at, all) => (
                      <div
                        key={p.key}
                        className={cn("w-full min-h-[2px]", at === all.length - 1 && "rounded-t")}
                        style={{ flexGrow: column.parts[p.key] ?? 0, flexBasis: 0, background: productStyle(p.key).color }}
                      />
                    ))}
                </div>
                <div className="absolute inset-y-0 left-1/2 -z-0 w-full -translate-x-1/2 rounded group-hover:bg-fg/[0.04] group-focus-visible:bg-fg/[0.06]" aria-hidden="true" />
                <div
                  className={cn(
                    "pointer-events-none absolute bottom-full z-10 mb-2 hidden w-52 rounded-lg border border-line-strong bg-raised p-2.5 text-xs shadow-xl group-hover:block group-focus-visible:block",
                    i < columns.length / 2 ? "left-0" : "right-0",
                  )}
                  role="tooltip"
                >
                  <p className="flex justify-between font-medium">
                    <span>{column.label}</span>
                    <span className="tabular-nums">{money(column.total)}</span>
                  </p>
                  <ul className="mt-1.5 space-y-1">
                    {used.map((p) => (
                      <li key={p.key} className="flex items-center justify-between gap-2 text-muted">
                        <span className="flex items-center gap-1.5">
                          <span className="size-2 rounded-sm" style={{ background: productStyle(p.key).color }} />
                          {p.label}
                        </span>
                        <span className="tabular-nums text-fg-soft">{money(column.parts[p.key] ?? 0)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="ml-14 mt-1.5 flex text-[0.6875rem] text-faint" aria-hidden="true">
        {columns.map((column, i) => (
          <span key={column.key} className="min-w-0 flex-1 truncate text-center">
            {i % labelEvery === 0 ? column.label : ""}
          </span>
        ))}
      </div>
      {max === 0 && <p className="mt-3 text-center text-sm text-faint">Nothing used in this range.</p>}
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-xs text-muted hover:text-fg">Show as a table</summary>
        <div className="mt-2 max-h-72 overflow-auto">
          <table className="w-full text-left text-xs tabular-nums">
            <thead className="sticky top-0 bg-surface text-muted">
              <tr>
                <th className="py-1 pr-3 font-medium">{grain === "day" ? "Day" : grain === "week" ? "Week of" : "Month"}</th>
                {used.map((p) => (
                  <th key={p.key} className="py-1 pr-3 text-right font-medium">
                    {p.label}
                  </th>
                ))}
                <th className="py-1 text-right font-medium">{cumulative ? "Running total" : "Total"}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {columns.map((column) => (
                <tr key={column.key}>
                  <td className="py-1 pr-3">{column.label}</td>
                  {used.map((p) => (
                    <td key={p.key} className="py-1 pr-3 text-right">
                      {money(column.parts[p.key] ?? 0)}
                    </td>
                  ))}
                  <td className="py-1 text-right">{money(column.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

// --- The breakdown ---------------------------------------------------------------------------

/** A meter's days as a small line, in the product's color. */
export function Sparkline({ values, color }: { values: number[]; color: string }) {
  const max = Math.max(...values, 0);
  if (values.length < 2 || max <= 0) return <span className="block h-5 w-20" aria-hidden="true" />;
  const points = values.map((v, i) => `${(i / (values.length - 1)) * 78 + 1},${19 - (v / max) * 17}`).join(" ");
  return (
    <svg viewBox="0 0 80 20" className="h-5 w-20" aria-hidden="true">
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** How much of an allowance is used, as a ring. */
export function AllowanceRing({ used, of }: { used: number; of: number }) {
  const part = of > 0 ? Math.min(1, used / of) : 0;
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 18 18" className="size-4 shrink-0 -rotate-90" aria-hidden="true">
      <circle cx="9" cy="9" r={r} fill="none" stroke="var(--g1t-line-strong)" strokeWidth="2.5" />
      <circle cx="9" cy="9" r={r} fill="none" stroke={part >= 1 ? "var(--g1t-warn)" : "var(--g1t-success)"} strokeWidth="2.5" strokeDasharray={`${part * c} ${c}`} strokeLinecap="round" />
    </svg>
  );
}

function MeterUsed({ meter }: { meter: MeterLine }) {
  if (meter.allowance) {
    const unit = meter.allowance.unit;
    return (
      <span className="flex items-center gap-1.5 sm:justify-end">
        <AllowanceRing used={meter.allowance.used} of={meter.allowance.of} />
        <span>
          {quantity(meter.allowance.used, unit)} <span className="text-faint">/ {quantity(meter.allowance.of, unit).replace(/ (operations|entries)$/, "")} free</span>
        </span>
      </span>
    );
  }
  return <span>{meter.quantity ? quantity(meter.quantity, meter.unit) : <span className="text-faint">—</span>}</span>;
}

const ROW = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-2.5 sm:grid-cols-[minmax(0,1fr)_5.5rem_14rem_6rem]";

/** One meter: its days, how much was used and its charge; open, its projects. */
function MeterRow({ meter, color, projectHref }: { meter: MeterLine; color: string; projectHref?: (project: string) => string }) {
  const parts = meter.byProject.filter((p) => p.micros !== 0 || p.quantity !== 0);
  const body = (
    <>
      <span className="flex min-w-0 items-center gap-2">
        <span className="size-2 shrink-0 rounded-sm" style={{ background: color }} />
        <span className="min-w-0">
          <span className="block truncate">{meter.label}</span>
          {meter.note && (
            <Hint label={meter.note}>
              <span className="block truncate text-[0.6875rem] text-faint">{meter.note}</span>
            </Hint>
          )}
        </span>
        {parts.length > 0 && <ChevronDown size={13} className="shrink-0 text-faint transition-transform group-open:rotate-180" />}
      </span>
      <span className="hidden sm:block">
        <Sparkline values={meter.daily} color={color} />
      </span>
      <span className="order-3 col-span-2 text-sm text-muted tabular-nums sm:order-none sm:col-span-1 sm:text-right">
        <MeterUsed meter={meter} />
      </span>
      <span className="text-right tabular-nums">
        {money(meter.micros)}
        {(meter.pendingMicros ?? 0) > 0 && <span className="block text-[0.6875rem] text-faint">{money(meter.pendingMicros ?? 0)} pending</span>}
      </span>
    </>
  );
  if (parts.length === 0) return <li className={cn(ROW, "text-sm")}>{body}</li>;
  return (
    <li>
      <details className="group">
        <summary className={cn(ROW, "cursor-pointer list-none text-sm hover:bg-raised/50 [&::-webkit-details-marker]:hidden")}>{body}</summary>
        <ul className="border-t border-line bg-bg/40 py-1">
          {parts.map((part) => (
            <li key={part.project || "none"} className="flex justify-between gap-3 py-1.5 pl-10 pr-4 text-sm text-muted">
              <span className="truncate">
                {part.project ? (
                  projectHref ? (
                    <Link to={projectHref(part.project)} className="hover:text-fg hover:underline">
                      {part.project}
                    </Link>
                  ) : (
                    part.project
                  )
                ) : (
                  "Not tied to a project"
                )}
              </span>
              <span className="flex gap-4 tabular-nums">
                {part.quantity > 0 && meter.unit !== "entries" && <span className="hidden sm:inline">{quantity(part.quantity, meter.unit)}</span>}
                <span className="text-fg-soft">{money(part.micros)}</span>
              </span>
            </li>
          ))}
        </ul>
      </details>
    </li>
  );
}

/** The breakdown, by product family (or by project, or by day). */
export function Breakdown({
  report,
  group,
  columns,
  projectHref,
}: {
  report: UsageReport;
  group: GroupBy;
  columns: Column[];
  projectHref?: (project: string) => string;
}) {
  const header = (first: string) => (
    <div className={cn(ROW, "border-b border-line py-2 text-xs text-muted")}>
      <span>{first}</span>
      <span className="hidden sm:block">Trend</span>
      <span className="hidden text-right sm:block">Usage</span>
      <span className="text-right">Charge at price</span>
    </div>
  );
  if (group === "project") {
    const rows = byProject(report);
    return (
      <section className="overflow-hidden rounded-xl border border-line bg-surface">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] border-b border-line px-4 py-2 text-xs text-muted">
          <span>Project</span>
          <span>Charge at price</span>
        </div>
        {rows.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-faint">Nothing used in this range.</p>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((row) => (
              <li key={row.project || "none"} className="px-4 py-2.5 text-sm">
                <div className="flex justify-between gap-3">
                  <span className="truncate font-medium">
                    {row.project ? projectHref ? <Link to={projectHref(row.project)} className="hover:underline">{row.project}</Link> : row.project : "Not tied to a project"}
                  </span>
                  <span className="tabular-nums">{money(row.micros)}</span>
                </div>
                <p className="mt-0.5 text-xs text-faint">{row.meters.map((m) => `${m.label} ${money(m.micros)}`).join(" · ")}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }
  if (group === "day") {
    const days = columns.filter((c) => c.total !== 0).reverse();
    return (
      <section className="overflow-hidden rounded-xl border border-line bg-surface">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] border-b border-line px-4 py-2 text-xs text-muted">
          <span>Day</span>
          <span>Charge at price</span>
        </div>
        {days.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-faint">Nothing used in this range.</p>
        ) : (
          <ul className="divide-y divide-line">
            {days.map((column) => (
              <li key={column.key} className="px-4 py-2.5 text-sm">
                <div className="flex justify-between gap-3">
                  <span className="font-medium">{column.label}</span>
                  <span className="tabular-nums">{money(column.total)}</span>
                </div>
                <p className="mt-0.5 text-xs text-faint">
                  {Object.entries(column.parts)
                    .filter(([, micros]) => micros !== 0)
                    .map(([product, micros]) => `${productStyle(product).label} ${money(micros)}`)
                    .join(" · ")}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }
  const products = report.products.filter((p) => shownLines(p.meters).length > 0);
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface">
      {header("Product")}
      {products.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-faint">Nothing used in this range.</p>
      ) : (
        products.map((product) => {
          const color = productStyle(product.key).color;
          return (
            <div key={product.key} className="border-b border-line last:border-b-0">
              <div className="flex items-baseline justify-between gap-3 bg-raised/40 px-4 py-2">
                <h3 className="text-sm font-medium">{product.label}</h3>
                <span className="text-sm font-medium tabular-nums">{money(product.micros)}</span>
              </div>
              {product.features && product.features.length > 0 && (
                <p className="px-4 pt-2 text-xs text-faint">
                  {product.features.map((f) => `${f.label}${f.count ? ` (${f.count})` : ""} ${money(f.micros)}`).join(" · ")}
                </p>
              )}
              {product.key === "agent" && report.models && report.models.length > 0 && (
                <p className="px-4 pt-1 text-xs text-faint">
                  Tokens by model:{" "}
                  {report.models.map((m) => `${m.model} ${quantity(m.input + m.output + m.cacheRead + m.cacheWrite, "tokens")}`).join(" · ")}
                </p>
              )}
              <ul className="divide-y divide-line/60">
                {shownLines(product.meters).map((meter) => (
                  <MeterRow key={meter.key} meter={meter} color={color} projectHref={projectHref} />
                ))}
              </ul>
            </div>
          );
        })
      )}
    </section>
  );
}

// --- Loading --------------------------------------------------------------------------------

/** Each region's shape while the report is on its way: the same heights, so nothing moves. */
export function UsageSkeleton({ children }: { children?: ReactNode }) {
  return (
    <div className="space-y-6" aria-busy="true">
      <span role="status" className="sr-only">
        Loading usage…
      </span>
      {children}
      <div className="grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-3" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-[7.5rem] bg-surface p-4">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="mt-3 h-5 w-20" />
            <Skeleton className="mt-3 h-1.5 w-full" />
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-line bg-surface p-5" aria-hidden="true">
        <Skeleton className="h-4 w-28" />
        <div className="mt-6 flex h-[200px] items-end gap-1">
          {Array.from({ length: 24 }, (_, i) => (
            <Skeleton key={i} className="flex-1 rounded-t" style={{ height: `${20 + ((i * 37) % 60)}%` }} />
          ))}
        </div>
      </div>
      <div className="rounded-xl border border-line bg-surface" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex items-center justify-between border-b border-line px-4 py-3 last:border-b-0">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
