/**
 * The Usage page's arithmetic: which days a period covers, how a report's
 * days become the chart's columns, clean axis ticks, quantities in their
 * units, and the CSV export. Pure, so it can be tested.
 *
 * Every figure is usage at price (`UsageReport.totals.priceMicros`), the
 * one number mission control, the agent fleet, Usage and Billing all show:
 * what was charged, plus what included usage, credit or a discount paid.
 */

import type { MeterLine, UsageDay, UsageReport, UsageTotals } from "@g1t/contracts";

import { MICROS_PER_DOLLAR, money } from "./money.ts";
import { monthSpan } from "./spend.ts";

const DAY_MS = 86_400_000;

/** The product families in order, with their names and colors (the chart's categorical slots, validated against the dark surface). */
export const PRODUCT_STYLE: { key: string; label: string; color: string }[] = [
  { key: "agent", label: "Agent", color: "#3987e5" },
  { key: "sandboxes", label: "Sandboxes", color: "#d95926" },
  { key: "gateway", label: "AI Gateway", color: "#199e70" },
  { key: "deployments", label: "Deployments", color: "#c98500" },
  { key: "git_storage", label: "Git & storage", color: "#d55181" },
  { key: "packages", label: "Packages", color: "#008300" },
  { key: "security", label: "Security & quality", color: "#9085e9" },
  { key: "search", label: "Search", color: "#e66767" },
];

export function productStyle(key: string): { key: string; label: string; color: string } {
  return PRODUCT_STYLE.find((p) => p.key === key) ?? { key, label: key, color: "#86868e" };
}

/** The periods the page offers. Billing cycles are calendar months (UTC). */
export const PERIODS = {
  cycle: "Current billing cycle",
  last_cycle: "Last billing cycle",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  custom: "Custom range",
} as const;
export type Period = keyof typeof PERIODS;

export type Grain = "day" | "week" | "month";
export type GroupBy = "product" | "project" | "day";

function day(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function isDay(text: string | null | undefined): text is string {
  return !!text && /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`)) && day(new Date(`${text}T00:00:00Z`)) === text;
}

/** The days a period covers, both included, as `YYYY-MM-DD` (UTC), and the period actually used. */
export function resolveRange(
  asked: string | null | undefined,
  custom: { from?: string | null; until?: string | null },
  now = new Date(),
): { period: Period; from: string; until: string } {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const period: Period = asked && asked in PERIODS ? (asked as Period) : "cycle";
  if (period === "custom" && isDay(custom.from) && isDay(custom.until)) {
    const [from, until] = custom.from <= custom.until ? [custom.from, custom.until] : [custom.until, custom.from];
    // At most 400 days, as billing reads them.
    const earliest = day(new Date(Date.parse(`${until}T00:00:00Z`) - 399 * DAY_MS));
    return { period, from: from < earliest ? earliest : from, until };
  }
  if (period === "last_cycle") {
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
    const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
    return { period, from: day(start), until: day(end) };
  }
  if (period === "7d" || period === "30d" || period === "90d") {
    const days = Number(period.slice(0, -1));
    return { period, from: day(new Date(today.getTime() - (days - 1) * DAY_MS)), until: day(today) };
  }
  // This month is the one range Spend and the top bar read too (`spend.ts` `monthSpan`).
  return { period: "cycle", ...monthSpan(today) };
}

/** `Oct 1 – Oct 8, 2026`. */
export function rangeLabel(from: string, until: string): string {
  const f = new Date(`${from}T00:00:00Z`);
  const u = new Date(`${until}T00:00:00Z`);
  const short = (d: Date, year: boolean) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC", ...(year ? { year: "numeric" } : {}) });
  return from === until ? short(u, true) : `${short(f, f.getUTCFullYear() !== u.getUTCFullYear())} – ${short(u, true)}`;
}

/** Every day from `from` to `until`, both included. */
export function daysIn(from: string, until: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${until}T00:00:00Z`); t += DAY_MS) out.push(day(new Date(t)));
  return out;
}

/** One column of the chart: a day, a week (from its Monday) or a month, with each product's part. */
export type Column = { key: string; label: string; from: string; until: string; parts: Record<string, number>; total: number };

function columnKey(d: string, grain: Grain): string {
  if (grain === "month") return d.slice(0, 7);
  if (grain === "week") {
    const t = new Date(`${d}T00:00:00Z`);
    const monday = new Date(t.getTime() - ((t.getUTCDay() + 6) % 7) * DAY_MS);
    return day(monday);
  }
  return d;
}

function columnLabel(key: string, grain: Grain): string {
  if (grain === "month") return new Date(`${key}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  return new Date(`${key}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * The chart's columns: every day (or week, or month) of the range, zeros
 * included, each product's usage at price. Cumulative adds each column to
 * the ones before, product by product.
 */
export function columns(days: UsageDay[], from: string, until: string, grain: Grain = "day", cumulative = false): Column[] {
  const out: Column[] = [];
  const at = new Map<string, Column>();
  for (const d of daysIn(from, until)) {
    const key = columnKey(d, grain);
    let column = at.get(key);
    if (!column) {
      column = { key, label: columnLabel(key, grain), from: d, until: d, parts: {}, total: 0 };
      at.set(key, column);
      out.push(column);
    }
    column.until = d;
  }
  for (const d of days) {
    const column = at.get(columnKey(d.day, grain));
    if (!column) continue;
    column.parts[d.product] = (column.parts[d.product] ?? 0) + d.micros;
    column.total += d.micros;
  }
  if (cumulative) {
    const running: Record<string, number> = {};
    for (const column of out) {
      for (const [product, micros] of Object.entries(column.parts)) running[product] = (running[product] ?? 0) + micros;
      column.parts = { ...running };
      column.total = Object.values(running).reduce((a, b) => a + b, 0);
    }
  }
  return out;
}

/** The finest grain that keeps the chart readable: days up to 45 of them, weeks up to 200, months past that. */
export function defaultGrain(from: string, until: string): Grain {
  const days = daysIn(from, until).length;
  return days <= 45 ? "day" : days <= 200 ? "week" : "month";
}

/**
 * Clean ticks for a money axis from 0 to at least `max` micros: 1, 2 or 5
 * times a power of ten, every label different. With nothing used, one tick
 * at $0.
 */
export function ticks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? 10 * power;
  const out: number[] = [];
  for (let v = 0; v < max + step / 2 && out.length <= count + 1; v += step) out.push(Math.round(v));
  if (out[out.length - 1]! < max) out.push(Math.round(out[out.length - 1]! + step));
  return out;
}

function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toLocaleString("en-US", { maximumFractionDigits: 1 })}B`;
  if (n >= 1e6) return `${(n / 1e6).toLocaleString("en-US", { maximumFractionDigits: 1 })}M`;
  if (n >= 1e4) return `${(n / 1e3).toLocaleString("en-US", { maximumFractionDigits: 1 })}K`;
  return Math.round(n).toLocaleString("en-US");
}

/** How much of a meter, in its unit: `1.2M tokens`, `3h 12m`, `504 MB`, `12 entries`. */
export function quantity(amount: number, unit: string): string {
  switch (unit) {
    case "tokens":
      return `${compact(amount)} tokens`;
    case "seconds": {
      const s = Math.round(amount);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
    }
    case "bytes":
      return bytes(amount);
    case "operations":
      return `${compact(amount)} ${amount === 1 ? "operation" : "operations"}`;
    case "requests":
      return `${compact(amount)} ${amount === 1 ? "request" : "requests"}`;
    case "micros":
      return money(amount);
    default:
      return `${compact(amount)} ${amount === 1 ? "entry" : "entries"}`;
  }
}

/** Storage in powers of ten, as it is priced: `504 MB`, `1 TB`. */
export function bytes(n: number): string {
  const units: [number, string][] = [
    [1e12, "TB"],
    [1e9, "GB"],
    [1e6, "MB"],
    [1e3, "KB"],
  ];
  for (const [size, name] of units) {
    if (n >= size) return `${(n / size).toLocaleString("en-US", { maximumFractionDigits: n / size >= 100 ? 0 : 1 })} ${name}`;
  }
  return `${Math.round(n)} B`;
}

/** What paid for usage, in order, each line with anything to show: the receipt under the totals. */
export function receipt(totals: UsageTotals, discountPercent: number | null | undefined): { label: string; micros: number; minus: boolean }[] {
  const lines: { label: string; micros: number; minus: boolean }[] = [{ label: "Usage at price", micros: totals.priceMicros, minus: false }];
  if (totals.discountMicros > 0) lines.push({ label: `Discount${discountPercent ? ` (${discountPercent}%)` : ""}`, micros: totals.discountMicros, minus: true });
  if (totals.includedMicros > 0) lines.push({ label: "Included usage and pools", micros: totals.includedMicros, minus: true });
  if (totals.creditsMicros > 0) lines.push({ label: "Credits applied", micros: totals.creditsMicros, minus: true });
  lines.push({ label: "Charged", micros: totals.chargedMicros, minus: false });
  return lines;
}

/**
 * The note under the receipt: what is metered this month and not yet
 * closed, with the fraction of a cent it carries (it explains a gap of
 * one), and what of it the close will charge on the account's terms. An
 * older billing says only that it is charged at the close.
 */
export function pendingSentence(totals: Pick<UsageTotals, "pendingMicros" | "pendingChargedMicros">): string {
  const pending = money(totals.pendingMicros, { precise: true });
  const charged = totals.pendingChargedMicros;
  if (charged == null) return `${pending} of it is metered this month and not yet closed; it is charged when the month closes.`;
  const part = charged <= 0 ? "nothing" : charged >= totals.pendingMicros ? "all of it" : `${money(charged, { precise: true })} of it`;
  return `${pending} of it is metered this month and not yet closed; ${part} will be charged when the month closes, after your discount and included usage.`;
}

/** Rows of the breakdown when grouped by project: each project's usage across every meter. */
export function byProject(report: Pick<UsageReport, "products">): { project: string; micros: number; meters: { label: string; micros: number }[] }[] {
  const rows = new Map<string, { project: string; micros: number; meters: { label: string; micros: number }[] }>();
  for (const product of report.products) {
    for (const meter of product.meters) {
      for (const part of meter.byProject) {
        if (part.micros === 0) continue;
        const row = rows.get(part.project) ?? { project: part.project, micros: 0, meters: [] };
        row.micros += part.micros;
        row.meters.push({ label: meter.label, micros: part.micros });
        rows.set(part.project, row);
      }
    }
  }
  return [...rows.values()].sort((a, b) => b.micros - a.micros);
}

/** The report as CSV: one row per meter, day and amount at price. */
export function usageCsv(report: Pick<UsageReport, "from" | "until" | "products">): string {
  const days = daysIn(report.from, report.until);
  const quote = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = ["day,product,meter,usd"];
  for (const product of report.products) {
    for (const meter of product.meters) {
      meter.daily.forEach((micros, i) => {
        if (micros !== 0) lines.push([days[i] ?? "", quote(product.label), quote(meter.label), (micros / MICROS_PER_DOLLAR).toFixed(6)].join(","));
      });
      if ((meter.pendingMicros ?? 0) !== 0) {
        lines.push(["pending", quote(product.label), quote(meter.label), ((meter.pendingMicros ?? 0) / MICROS_PER_DOLLAR).toFixed(6)].join(","));
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

/** The meters worth a row: anything used, and those with an allowance. */
export function shownLines(meters: MeterLine[]): MeterLine[] {
  return meters.filter((m) => m.micros !== 0 || m.quantity !== 0 || m.allowance);
}

/** Who sees test-mode hints: g1t's own people (members of Flagon's workspace). */
export const STAFF_WORKSPACE = "flagon-io";
export function isStaff(viewer: { workspaces?: { slug: string }[] } | null | undefined): boolean {
  return !!viewer?.workspaces?.some((w) => w.slug === STAFF_WORKSPACE);
}
