/**
 * The arithmetic and wording behind Requests, Overages, Velocity and the
 * Overview's money: how long a request has waited against the promise of
 * an answer within one business day, what a goodwill credit costs g1t,
 * and margin kept apart from what g1t gives. Money is in micros. No
 * Workers or React imports, so it can be tested under Node.
 */
import type { GivenFigures, MonthFigures } from "@g1t/contracts";

// --- Requests -------------------------------------------------------------------

export const REQUEST_STATUSES = ["open", "approved", "declined", "all"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** The status filter from the address: open unless another is named. */
export function parseRequestStatus(value: string | null): RequestStatus {
  return REQUEST_STATUSES.find((status) => status === value) ?? "open";
}

export function requestsHref(status: RequestStatus): string {
  return status === "open" ? "/requests" : `/requests?status=${status}`;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

/**
 * When an answer is due: one business day after the request, UTC. A
 * request made on a Friday is due Monday at the same time; one made at
 * the weekend, by the end of Monday.
 */
export function answerDueAt(createdAt: string): Date {
  let start = new Date(createdAt);
  if (Number.isNaN(start.getTime())) return start;
  if (isWeekend(start)) {
    // Asked at the weekend: the business day is Monday, all of it.
    while (isWeekend(start)) start = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 1));
    return new Date(start.getTime() + DAY - 1000);
  }
  let due = new Date(start.getTime() + DAY);
  while (isWeekend(due)) due = new Date(due.getTime() + DAY);
  return due;
}

/** A span of time, short: `25 min`, `3 h`, `2 d 4 h`. */
export function span(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest > 0 ? `${days} d ${rest} h` : `${days} d`;
}

/** How long an open request has waited, and whether its one business day is up. */
export function waiting(createdAt: string, now = new Date()): { label: string; overdue: boolean; dueAt: Date } {
  const asked = new Date(createdAt);
  const dueAt = answerDueAt(createdAt);
  if (Number.isNaN(asked.getTime())) return { label: "—", overdue: false, dueAt };
  return { label: span(now.getTime() - asked.getTime()), overdue: now.getTime() > dueAt.getTime(), dueAt };
}

/** How old a workspace is, in the largest whole unit: `12 days`, `3 months`, `2 years`. */
export function age(createdAt: string | null | undefined, now = new Date()): string | null {
  if (!createdAt) return null;
  const then = new Date(createdAt);
  if (Number.isNaN(then.getTime())) return null;
  const days = Math.max(0, Math.floor((now.getTime() - then.getTime()) / DAY));
  const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"}`;
  if (days < 1) return "less than a day";
  if (days < 60) return plural(days, "day");
  if (days < 730) return plural(Math.floor(days / 30), "month");
  return plural(Math.floor(days / 365), "year");
}

// --- Goodwill -------------------------------------------------------------------

/**
 * What g1t absorbs of real cost on a goodwill credit: whatever is past its
 * margin on the overage. The margin is money g1t never had; the rest it
 * paid Cloudflare and model providers for.
 */
export function absorbedMicros(amountMicros: number, marginMicros: number): number {
  return Math.max(0, amountMicros - Math.max(0, marginMicros));
}

/**
 * Whether a goodwill credit needs a typed reason: more than the one-click
 * credit, or a second within 12 months. No amount is the one-click credit.
 * As billing decides it, so the form asks before billing refuses.
 */
export function goodwillNeedsReason(amountMicros: number | null, creditMicros: number, lastGoodwillAt: string | null): boolean {
  const amount = amountMicros ?? creditMicros;
  return amount > creditMicros || lastGoodwillAt != null;
}

/** The most of real cost a one-click goodwill credit absorbs, unless billing's price book says otherwise. */
export const FORGIVE_COST_MICROS = 50_000_000;

/**
 * What a goodwill credit of `amountMicros` (null: the one-click credit)
 * means: whether billing asks for a reason, what of it is real cost g1t
 * absorbs, and whether that is past the cap, where the red warning shows.
 */
export function goodwillWarning(
  amountMicros: number | null,
  goodwill: { creditMicros: number; marginMicros: number },
  lastGoodwillAt: string | null,
  capMicros: number = FORGIVE_COST_MICROS,
): { needsReason: boolean; absorbedMicros: number; overCap: boolean } {
  const amount = amountMicros ?? goodwill.creditMicros;
  const absorbed = absorbedMicros(amount, goodwill.marginMicros);
  return {
    needsReason: goodwillNeedsReason(amountMicros, goodwill.creditMicros, lastGoodwillAt),
    absorbedMicros: absorbed,
    overCap: absorbed > capMicros,
  };
}

/**
 * The amounts the Overages page offers beside the one-click credit: the
 * whole overage (margin and all its cost), when that is more.
 */
export function goodwillChoices(goodwill: { overageMicros: number; creditMicros: number }): { label: string; micros: number | null }[] {
  const choices: { label: string; micros: number | null }[] = [{ label: "One-click credit", micros: null }];
  if (goodwill.overageMicros > goodwill.creditMicros) choices.push({ label: "The whole overage", micros: goodwill.overageMicros });
  return choices;
}

/** The statement line a goodwill credit makes, as billing writes it. */
export function goodwillLine(day: string): string {
  return `Credit from g1t: accidental usage on ${day}`;
}

// --- Velocity -------------------------------------------------------------------

/** A last hour this many times the usual hour is fast; at $5 and over, it pauses compute. */
export const FAST_RATIO = 5;

export function isFast(ratio: number): boolean {
  return Number.isFinite(ratio) && ratio >= FAST_RATIO;
}

/** A ratio as staff read it: `7.2×`, `—` when there is no usual hour to compare. */
export function ratioLabel(ratio: number, averageHourMicros: number): string {
  if (averageHourMicros <= 0 || !Number.isFinite(ratio)) return "new";
  return `${ratio >= 10 ? Math.round(ratio) : Math.round(ratio * 10) / 10}×`;
}

const SPIKE: Record<string, { label: string; tone: "danger" | "warn" | "plain" }> = {
  open: { label: "Paused: waiting on the owner", tone: "danger" },
  stopped: { label: "Stopped by the owner", tone: "danger" },
  continued: { label: "Owner kept going", tone: "warn" },
};

export function spikeLabel(status: string): { label: string; tone: "danger" | "warn" | "plain" } {
  return SPIKE[status] ?? { label: status, tone: "plain" };
}

// --- Money: margin apart from what g1t gives ------------------------------------

/** What came in: usage charged plus the plan's price paid. */
export function revenueOf(month: Pick<MonthFigures, "chargedMicros" | "plansMicros">): number {
  return month.chargedMicros + (month.plansMicros ?? 0);
}

/**
 * Margin: what came in less what usage cost g1t. What g1t gave is not a
 * loss here; it is shown on its own.
 */
export function marginOfMonth(month: Pick<MonthFigures, "chargedMicros" | "plansMicros" | "costMicros">): { micros: number; percent: number | null } {
  const revenue = revenueOf(month);
  const micros = revenue - month.costMicros;
  return { micros, percent: revenue > 0 ? Math.round((micros / revenue) * 100) : null };
}

const GIVEN_LABELS: Record<string, string> = {
  internal: "Internal use",
  trial: "Trials",
  oss_pool: "Open-source pool",
  covered: "Covered by g1t",
  goodwill: "Goodwill credits",
};

/** What a source of given usage is called; billing's own label first. */
export function givenLabel(row: Pick<GivenFigures, "source" | "label">): string {
  return row.label || GIVEN_LABELS[row.source] || row.source;
}

/** Everything given, at price and at cost. */
export function givenTotal(rows: Pick<GivenFigures, "micros" | "costMicros">[]): { micros: number; costMicros: number } {
  return rows.reduce((sum, row) => ({ micros: sum.micros + row.micros, costMicros: sum.costMicros + row.costMicros }), { micros: 0, costMicros: 0 });
}

/**
 * The parts of a ledger line g1t gave rather than charged: a trial, the
 * open-source pool, or covered (internal use, the trial's last run).
 */
export function givenParts(entry: { trialMicros?: number; ossMicros?: number; givenMicros?: number }): { label: string; micros: number }[] {
  return [
    { label: "Trial", micros: entry.trialMicros ?? 0 },
    { label: "Open-source pool", micros: entry.ossMicros ?? 0 },
    { label: "Covered by g1t", micros: entry.givenMicros ?? 0 },
  ].filter((part) => part.micros > 0);
}

/**
 * A month's money with what g1t gave kept apart: revenue (usage charged
 * and plans paid), margin on what was sold (revenue less the cost of the
 * usage that was charged), and net (revenue less all cost, given included).
 * `givenCostMicros` is what the given usage cost g1t.
 */
export function moneyApart(
  month: Pick<MonthFigures, "chargedMicros" | "plansMicros" | "costMicros">,
  givenCostMicros: number,
): { revenueMicros: number; soldCostMicros: number; marginMicros: number; marginPercent: number | null; netMicros: number } {
  const revenueMicros = revenueOf(month);
  const soldCostMicros = Math.max(0, month.costMicros - Math.max(0, givenCostMicros));
  const marginMicros = revenueMicros - soldCostMicros;
  return {
    revenueMicros,
    soldCostMicros,
    marginMicros,
    marginPercent: revenueMicros > 0 ? Math.round((marginMicros / revenueMicros) * 100) : null,
    netMicros: revenueMicros - month.costMicros,
  };
}
