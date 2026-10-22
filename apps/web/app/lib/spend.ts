/**
 * Spend's arithmetic (routes/workspace/spend.tsx): the span a page asks
 * for, a person's rows summed by day and by what they went into, and the
 * words for who sees each person's spend. Work's `get_spend` returns the
 * rows, one per day, repository, work item, harness, model and landed;
 * this only groups and sums them. Pure, so it is tested on its own.
 */
import type { CostProvider, CostUnit, ProviderPersonCosts, SpendRow, SpendVisibility } from "@g1t/contracts";

const DAY_MS = 86_400_000;

/** The spans the page offers, in days; 30 is the default. */
export const SPEND_DAYS = [7, 30, 90] as const;
export type SpendDays = (typeof SPEND_DAYS)[number];

/** The span asked for: one of `SPEND_DAYS` ending today, or the days `since` through `until`. */
export type SpendSpan = { days: SpendDays | null; since: string; until: string };

const isDay = (value: string | null): value is string => value != null && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * The span in a page's query (`?days=7`, or `?since=…&until=…`) on the UTC
 * day `today`: two valid days in order win, else a span of `SPEND_DAYS`
 * ending today, else the last 30 days.
 */
export function spendSpan(query: URLSearchParams, today: string): SpendSpan {
  const since = query.get("since");
  const until = query.get("until") ?? (isDay(since) ? today : null);
  if (isDay(since) && isDay(until) && since <= until) return { days: null, since, until };
  const asked = Number(query.get("days"));
  const days = SPEND_DAYS.find((n) => n === asked) ?? 30;
  return { days, since: dayOf(Date.parse(`${today}T00:00:00Z`) - (days - 1) * DAY_MS), until: today };
}

/** One day's cost, and what of it went into work that landed. */
export type SpendDay = { day: string; costUsd: number; landedUsd: number };

/** Every day from `since` through `until`, a day without sessions at nothing. */
export function spendDays(since: string, until: string, rows: SpendRow[]): SpendDay[] {
  const byDay = new Map<string, SpendDay>();
  for (let at = Date.parse(`${since}T00:00:00Z`), end = Date.parse(`${until}T00:00:00Z`); at <= end; at += DAY_MS) {
    const day = dayOf(at);
    byDay.set(day, { day, costUsd: 0, landedUsd: 0 });
  }
  for (const row of rows) {
    const day = byDay.get(row.day);
    if (!day) continue;
    day.costUsd += row.costUsd;
    if (row.landed) day.landedUsd += row.costUsd;
  }
  return [...byDay.values()];
}

/** What the rows can be summed by. */
export type SpendKey = "item" | "repo" | "harness" | "model";

/** One work item, repository, harness or model: null for none (no work item, a repository the viewer can't read, no model reported). */
export type SpendGroup = { key: string | number | null; costUsd: number; landedUsd: number };

/** Less than this rounds to $0.00: a group of only sessions of no known cost, which the headline already counts. */
const NOTHING_USD = 0.005;

/**
 * The rows summed by `key`, the costliest first, then by name, with none
 * last among equals. Groups that come to nothing are left out.
 */
export function spendBy(rows: SpendRow[], key: SpendKey): SpendGroup[] {
  const groups = new Map<string | number | null, SpendGroup>();
  for (const row of rows) {
    const value = row[key];
    const group = groups.get(value) ?? { key: value, costUsd: 0, landedUsd: 0 };
    group.costUsd += row.costUsd;
    if (row.landed) group.landedUsd += row.costUsd;
    groups.set(value, group);
  }
  return [...groups.values()]
    .filter((group) => group.costUsd >= NOTHING_USD)
    .sort((a, b) => b.costUsd - a.costUsd || Number(a.key == null) - Number(b.key == null) || String(a.key ?? "").localeCompare(String(b.key ?? ""), "en"));
}

/** Of `costUsd`, the share `landedUsd` is, as a whole percent; null when nothing was spent. */
export function landedShare(costUsd: number, landedUsd: number): number | null {
  return costUsd > 0 ? Math.round((Math.min(landedUsd, costUsd) / costUsd) * 100) : null;
}

/** Dollars as millionths of one, the way `money` takes them. */
export const usdMicros = (usd: number) => Math.round(usd * 1_000_000);

/** The harnesses g1t records sessions of, among those a provider's per-person rows name: only these are compared. */
const RECORDED_HARNESSES = new Set(["claude_code", "codex", "cursor", "copilot"]);

/** What each provider's per-person rows say the use was, in a sentence's words: "your Cursor use". */
export const REPORTED_HARNESS_NAMES: Record<string, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  amp: "Amp",
  openai: "OpenAI API",
  devin: "Devin",
  devin_desktop: "Devin Desktop",
};

/**
 * What one provider reported for a person's use of one harness in the span, in millionths of `unit`, beside what g1t's
 * sessions of that harness cost. `sawMicros` is null where g1t can't compare: a unit that isn't dollars, or a harness
 * g1t doesn't record sessions of (Amp, Devin) or the provider can't tell apart (OpenAI's API, Codex or not). `share` is
 * the whole percent g1t saw; null when it saw more than was reported, which is said plainly rather than as a percent
 * over 100, or when there is nothing to compare.
 */
export type ProviderComparison = {
  provider: CostProvider;
  harness: string;
  unit: CostUnit;
  /** The provider gave tokens only, and g1t priced them at list price. */
  listPrice: boolean;
  reportedMicros: number;
  sawMicros: number | null;
  share: number | null;
  complete: boolean;
};

/**
 * Each provider's figure for each harness the person used in the span, most first, dollars before credits. Empty when
 * no per-person report is connected or none holds anything for the span.
 */
export function providerComparisons(costs: ProviderPersonCosts | null, rows: SpendRow[]): ProviderComparison[] {
  if (!costs?.connected) return [];
  const groups = new Map<string, ProviderComparison>();
  for (const day of costs.days) {
    const unit = day.unit ?? "usd";
    const key = [day.provider, day.harness, unit].join(" ");
    const group = groups.get(key) ?? {
      provider: day.provider,
      harness: day.harness,
      unit,
      listPrice: false,
      reportedMicros: 0,
      sawMicros: null,
      share: null,
      complete: costs.complete,
    };
    group.reportedMicros += day.micros;
    group.listPrice ||= day.listPrice === true;
    groups.set(key, group);
  }
  const comparisons = [...groups.values()].filter((group) => group.reportedMicros > 0);
  for (const c of comparisons) {
    if (c.unit !== "usd" || !RECORDED_HARNESSES.has(c.harness)) continue;
    c.sawMicros = usdMicros(rows.filter((row) => row.harness === c.harness).reduce((sum, row) => sum + row.costUsd, 0));
    c.share = c.sawMicros > c.reportedMicros ? null : Math.round((c.sawMicros / c.reportedMicros) * 100);
  }
  return comparisons.sort((a, b) => Number(a.unit !== "usd") - Number(b.unit !== "usd") || b.reportedMicros - a.reportedMicros);
}

/** Credits or ACUs, as millionths of one, in words: "125 credits", "12.5 ACUs". */
export function unitAmount(micros: number, unit: Exclude<CostUnit, "usd">): string {
  const amount = (micros / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 2 });
  return unit === "credits" ? `${amount} ${amount === "1" ? "credit" : "credits"}` : `${amount} ${amount === "1" ? "ACU" : "ACUs"}`;
}

/** Who sees each person's spend, besides that person, in a sentence's words. */
export const SPEND_VISIBILITY: Record<SpendVisibility, { label: string; who: string }> = {
  owners: { label: "Owners and billing managers", who: "its owners and billing managers" },
  members: { label: "Every member", who: "every member" },
  nobody: { label: "Nobody", who: "nobody but each person" },
};
