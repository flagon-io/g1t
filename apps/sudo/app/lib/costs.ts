/**
 * Costs & margin: the arithmetic behind the page, apart from the SVG and
 * the Workers runtime so it can be tested under Node. Money is in micros.
 */
import type { CostDay, CostMappingInput, CostSettings, SpendCaps } from "@g1t/contracts";

import { parseDollars, usd } from "./money.ts";

/** Buckets Cloudflare does not bill: their cost is g1t's own figure. */
export const NOT_CLOUDFLARE = new Set(["models"]);

/** A day's cost: Cloudflare's bill, or g1t's own figure where Cloudflare does not bill it. */
export function dayCost(day: CostDay): number {
  return NOT_CLOUDFLARE.has(day.bucket) ? day.ownCostMicros : day.cfCostMicros;
}

export type DayFigures = { day: string; revenueMicros: number; costMicros: number };

/** Every day from `since` to `until`, inclusive (YYYY-MM-DD, UTC). */
export function daysBetween(since: string, until: string): string[] {
  const start = Date.parse(`${since}T00:00:00Z`);
  const end = Date.parse(`${until}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const out: string[] = [];
  for (let at = start; at <= end && out.length < 400; at += 86_400_000) out.push(new Date(at).toISOString().slice(0, 10));
  return out;
}

/**
 * A day per day of the range, every day there even with nothing on it.
 * All of g1t: money in (what workspaces paid, the plan too) against every
 * cost. One product: what customers were charged for it at price against
 * what it cost.
 */
export function daySeries(days: CostDay[], since: string, until: string, bucket: string | null): DayFigures[] {
  const totals = new Map<string, DayFigures>(daysBetween(since, until).map((day) => [day, { day, revenueMicros: 0, costMicros: 0 }]));
  for (const row of days) {
    if (bucket && row.bucket !== bucket) continue;
    const figures = totals.get(row.day);
    if (!figures) continue;
    figures.revenueMicros += bucket ? row.valueMicros : row.cashMicros;
    figures.costMicros += dayCost(row);
  }
  return [...totals.values()];
}

/** Margin as a whole percent of revenue; none when there was none. */
export function marginPercent(revenueMicros: number, costMicros: number): number | null {
  return revenueMicros > 0 ? ((revenueMicros - costMicros) / revenueMicros) * 100 : null;
}

/** `12.3%`, `−4.0%`, or a dash. */
export function percentLabel(percent: number | null | undefined, { signed = false }: { signed?: boolean } = {}): string {
  if (percent == null || !Number.isFinite(percent)) return "—";
  const text = `${Math.abs(percent).toFixed(1)}%`;
  if (percent < 0) return `−${text}`;
  return signed && percent > 0 ? `+${text}` : text;
}

/** How a margin reads against the floor: under it is danger, close to it a warning. */
export function marginTone(percent: number | null | undefined, floor: number): "danger" | "warn" | "mint" | undefined {
  if (percent == null) return undefined;
  if (percent < floor) return "danger";
  if (percent < floor + 5) return "warn";
  return "mint";
}

/** A count: `1,234` or `1.2M`. */
export function countLabel(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return Math.round(value).toLocaleString("en-US");
}

/** What a kind of drift is called. */
export function driftLabel(kind: string): string {
  return { count: "Count", cost: "Cost", leak: "Leak" }[kind] ?? kind;
}

/** A cost per unit in micros, as dollars with as many places as it needs: `$0.000016`, `$0.15`. */
export function unitDollars(micros: number): string {
  const dollars = micros / 1_000_000;
  if (dollars === 0) return "$0";
  if (Math.abs(dollars) >= 1) return `$${dollars.toFixed(2)}`;
  const places = Math.min(10, Math.max(2, 2 - Math.floor(Math.log10(Math.abs(dollars)))));
  return `$${dollars.toFixed(places)}`;
}

/** The range shown: 7 to 90 days, 30 when not said. */
export function parseRange(raw: string | null): number {
  const days = Number(raw);
  return Number.isInteger(days) && days >= 7 && days <= 90 ? days : 30;
}

/** The product to chart, if it is one the page has. */
export function parseBucket(raw: string | null, known: string[]): string | null {
  return raw && known.includes(raw) ? raw : null;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function numberField(form: FormData, name: string): number {
  const raw = String(form.get(name) ?? "").trim();
  return raw === "" ? Number.NaN : Number(raw);
}

/** The guardrails from the settings form. */
export function parseCostSettings(form: FormData): Parsed<CostSettings> {
  const autoApplyPercent = numberField(form, "autoApplyPercent");
  const noticeDays = numberField(form, "noticeDays");
  const marginFloorPercent = numberField(form, "marginFloorPercent");
  const alertDays = numberField(form, "alertDays");
  const anomalyFactor = numberField(form, "anomalyFactor");
  const minDaily = parseDollars(String(form.get("minDailyCost") ?? ""));
  const anomalyFloor = parseDollars(String(form.get("anomalyFloor") ?? ""));
  if (!(autoApplyPercent >= 0 && autoApplyPercent <= 100)) return { ok: false, error: "The guardrail is a percentage from 0 to 100." };
  if (!(Number.isInteger(noticeDays) && noticeDays >= 0 && noticeDays <= 90)) return { ok: false, error: "Notice is 0 to 90 days." };
  if (!(marginFloorPercent >= -100 && marginFloorPercent <= 100)) return { ok: false, error: "The margin floor is a percentage." };
  if (!(Number.isInteger(alertDays) && alertDays >= 1 && alertDays <= 30)) return { ok: false, error: "Alert after 1 to 30 days." };
  if (!(anomalyFactor > 0 && anomalyFactor <= 100)) return { ok: false, error: "The factor is a positive number." };
  if (minDaily == null || anomalyFloor == null) return { ok: false, error: "Amounts are dollars to the cent." };
  return {
    ok: true,
    value: {
      autoApply: form.get("autoApply") === "on",
      autoApplyPercent,
      noticeDays,
      marginFloorPercent,
      alertDays,
      minDailyCostMicros: minDaily,
      anomalyFactor,
      anomalyFloorMicros: anomalyFloor,
    },
  };
}

const NAME = /^(\*|[a-z0-9][a-z0-9_]{0,79})$/;

/** A mapping from the mapping form: Cloudflare's product and meter (or `*`) to one of g1t's products. */
export function parseMapping(form: FormData): Parsed<CostMappingInput> {
  const value = (name: string) => String(form.get(name) ?? "").trim();
  const product = value("product").toLowerCase();
  const meter = value("meter").toLowerCase() || "*";
  const remove = form.get("remove") === "1";
  if (!NAME.test(product) || product === "*") return { ok: false, error: "Cloudflare's product, as the lines table names it." };
  if (!NAME.test(meter)) return { ok: false, error: "A meter prefix as the lines table names it, or * for all of the product." };
  if (remove) return { ok: true, value: { product, meter, remove: true } };
  const bucket = value("bucket").toLowerCase();
  if (!NAME.test(bucket) || bucket === "*") return { ok: false, error: "Which of g1t's products it is a cost of." };
  const drift = value("driftPercent");
  const driftPercent = drift === "" ? null : Number(drift);
  if (driftPercent != null && !(driftPercent > 0 && driftPercent <= 1000)) return { ok: false, error: "Drift is a percentage above zero." };
  return {
    ok: true,
    value: {
      product,
      meter,
      bucket,
      priceMeter: value("priceMeter") || null,
      ownMeter: value("ownMeter") || null,
      scaleToOwn: form.get("scaleToOwn") === "on",
      driftPercent,
      note: value("note").slice(0, 200),
    },
  };
}

// --- g1t's own spend (billing's budget) ---------------------------------------

/**
 * The red bar on every sudo page: the daily breaker open, or a comped
 * account's monthly budget used up. Null when neither.
 */
export function spendBanner(caps: SpendCaps): string | null {
  const parts: string[] = [];
  if (caps.tripped) {
    parts.push(
      `the daily breaker is open (${usd(caps.todayMicros)} of ${usd(caps.dailyCapMicros)} today), so new hosted-model agent runs g1t pays for wait until 00:00 UTC`,
    );
  }
  for (const budget of caps.comped) {
    if (budget.ceilingMicros > 0 && budget.usedMicros >= budget.ceilingMicros) {
      parts.push(`${budget.name} used its ${usd(budget.ceilingMicros)} monthly budget, so new work on it is refused`);
    }
  }
  if (parts.length === 0) return null;
  const text = parts.join("; and ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/** What g1t paid this month, by bucket, with the free tier and Cloudflare's subscriptions; and the total. */
export function spendRows(caps: SpendCaps): { rows: { key: string; title: string; micros: number; note: string }[]; totalMicros: number } {
  const notes: Record<string, string> = {
    comped: "Work on comped accounts, at cost",
    trial: "Trial credit, at cost",
    oss: "Checks and workflows on public repositories, at cost",
    given: "Free workspaces' overruns past their trial",
    unpaid: "Charged, but no real money yet (test-mode payments)",
  };
  const rows = caps.monthBuckets.map((b) => ({ key: b.bucket, title: b.title, micros: b.micros, note: notes[b.bucket] ?? "" }));
  rows.push({ key: "free", title: "Free tier", micros: caps.freeTierMicros, note: "Free workspaces' share of git, storage and platform, reconciled through yesterday" });
  rows.push({
    key: "fixed",
    title: "Cloudflare subscriptions",
    micros: caps.fixedMonthlyMicros,
    note: caps.fixedSource === "cloudflare" ? "A month, as Cloudflare lists them" : "A month, estimated (CLOUDFLARE_FIXED_MONTHLY_MICROS)",
  });
  return { rows, totalMicros: rows.reduce((sum, row) => sum + row.micros, 0) };
}

/** How far a cap is used, 0 to 100, for a meter. */
export function capPercent(usedMicros: number, capMicros: number): number {
  if (capMicros <= 0) return 0;
  return Math.max(0, Math.min(100, (usedMicros / capMicros) * 100));
}
