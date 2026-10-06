/**
 * How the billing pages speak of money, read their forms and word a
 * workspace's alerts. Pure, so it can be tested.
 */

import type { Entitlements, FeatureState, Limit, LimitRequest, MeterUsage, Usage, UsageAlert } from "@g1t/contracts";

/** Millionths of a dollar in one dollar, as `MICROS_PER_DOLLAR`; here so the tests need no build of the contracts. */
const MICROS_PER_DOLLAR = 1_000_000;

/** Millionths of a dollar as dollars, to the cent or finer. */
export function dollars(micros: number, digits = 2): string {
  const sign = micros < 0 ? "−" : "";
  return `${sign}$${(Math.abs(micros) / MICROS_PER_DOLLAR).toFixed(digits)}`;
}

/** Whole dollars when they are whole, with thousands separated: "$1,000", "$0.10". */
export function wholeDollars(micros: number): string {
  const d = micros / MICROS_PER_DOLLAR;
  const sign = d < 0 ? "−" : "";
  const abs = Math.abs(d);
  const digits = Number.isInteger(abs) ? 0 : 2;
  return `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** A form's dollar amount as micros, or null when it is empty or not a number. */
export function readDollars(value: FormDataEntryValue | null | undefined): number | null {
  const text = String(value ?? "").replace(/[$,\s]/g, "");
  if (!text) return null;
  const amount = Number(text);
  if (!Number.isFinite(amount)) return null;
  return Math.round(amount * MICROS_PER_DOLLAR);
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** The smallest prepayment, the most by card, and where bank transfer starts, in dollars. */
export const PREPAY = { min: 25, maxCard: 10_000, bankFrom: 1_000, presets: [100, 500, 1_000] } as const;

/** A prepayment: a preset or a custom amount, by card or bank transfer. */
export function parsePrepay(form: {
  amount?: FormDataEntryValue | null;
  custom?: FormDataEntryValue | null;
  method?: FormDataEntryValue | null;
}): Parsed<{ amountCents: number; method: "card" | "bank_transfer" }> {
  const micros = readDollars(form.custom) ?? readDollars(form.amount);
  const method = String(form.method ?? "card") === "bank_transfer" ? "bank_transfer" : "card";
  if (micros == null) return { ok: false, error: "Choose an amount to prepay." };
  const amount = micros / MICROS_PER_DOLLAR;
  if (amount < PREPAY.min) return { ok: false, error: `The smallest prepayment is $${PREPAY.min}.` };
  if (method === "card" && amount > PREPAY.maxCard)
    return { ok: false, error: `By card, the most is $${PREPAY.maxCard.toLocaleString("en-US")}; pay more by bank transfer.` };
  if (method === "bank_transfer" && amount < PREPAY.bankFrom)
    return { ok: false, error: `Bank transfer is for $${PREPAY.bankFrom.toLocaleString("en-US")} or more.` };
  return { ok: true, value: { amountCents: Math.round(amount * 100), method } };
}

/** What owners may set each cap to, in micros, and what applies when they set none. */
export const CAPS = {
  run: { min: 100_000, max: 100_000_000, default: 2_000_000 },
  issue: { min: 1_000_000, max: 1_000_000_000, default: 10_000_000 },
} as const;

/** The owners' caps: empty goes back to the default. */
export function parseCaps(form: {
  run?: FormDataEntryValue | null;
  issue?: FormDataEntryValue | null;
}): Parsed<{ runCapMicros: number | null; issueCapMicros: number | null }> {
  const run = readDollars(form.run);
  const issue = readDollars(form.issue);
  if (String(form.run ?? "").trim() && run == null) return { ok: false, error: "A run's cap is a dollar amount." };
  if (String(form.issue ?? "").trim() && issue == null) return { ok: false, error: "An issue's cap is a dollar amount." };
  if (run != null && (run < CAPS.run.min || run > CAPS.run.max))
    return { ok: false, error: `A run's cap is between ${wholeDollars(CAPS.run.min)} and ${wholeDollars(CAPS.run.max)}.` };
  if (issue != null && (issue < CAPS.issue.min || issue > CAPS.issue.max))
    return {
      ok: false,
      error: `An issue's cap is between ${wholeDollars(CAPS.issue.min)} and ${wholeDollars(CAPS.issue.max)}.`,
    };
  return { ok: true, value: { runCapMicros: run, issueCapMicros: issue } };
}

/** A request for a higher limit, or for help with usage past what was meant. */
export function parseLimitRequest(form: {
  kind?: FormDataEntryValue | null;
  amount?: FormDataEntryValue | null;
  reason?: FormDataEntryValue | null;
  expected?: FormDataEntryValue | null;
}): Parsed<{ kind: "limit" | "overage"; amountMicros: number; reason: string; expectedMonthlyMicros: number }> {
  const kind = String(form.kind ?? "limit") === "overage" ? "overage" : "limit";
  const reason = String(form.reason ?? "").trim();
  const amount = readDollars(form.amount);
  const expected = readDollars(form.expected);
  if (!reason)
    return {
      ok: false,
      error: kind === "limit" ? "Say what the higher limit is for." : "Say what happened, so we can look at it.",
    };
  if (kind === "limit") {
    if (amount == null || amount <= 0) return { ok: false, error: "Say the limit you need, in dollars." };
    if (expected == null || expected < 0) return { ok: false, error: "Say what you expect to spend in a month." };
  }
  return {
    ok: true,
    value: {
      kind,
      amountMicros: Math.max(0, amount ?? 0),
      reason: reason.slice(0, 2000),
      expectedMonthlyMicros: Math.max(0, expected ?? 0),
    },
  };
}

/**
 * A spend limit as owners set it: automatic, fixed at an amount, as high as
 * is available, or the one-time raise (an amount, or blank for as high as
 * it goes, which the page fills in from the limit).
 */
export function parseSpendLimit(form: {
  mode?: FormDataEntryValue | null;
  limit?: FormDataEntryValue | null;
}): Parsed<{ micros: number | null; useFull: boolean; raiseOnce: boolean }> {
  const mode = String(form.mode ?? "automatic");
  if (mode === "full") return { ok: true, value: { micros: null, useFull: true, raiseOnce: false } };
  if (mode !== "fixed" && mode !== "raise") return { ok: true, value: { micros: null, useFull: false, raiseOnce: false } };
  const micros = readDollars(form.limit);
  if (mode === "raise" && micros == null) return { ok: true, value: { micros: null, useFull: false, raiseOnce: true } };
  if (micros == null || micros < MICROS_PER_DOLLAR) return { ok: false, error: "A spend limit is a dollar amount, $1 or more." };
  return { ok: true, value: { micros, useFull: false, raiseOnce: mode === "raise" } };
}

/**
 * How far owners may set their spend limit themselves: up to the highest
 * ceiling the workspace has had plus what is prepaid, and, once, up to
 * twice that highest ceiling. Null `selfServeMicros` means no ceiling
 * (g1t's own, or staff set it).
 */
export type SpendRange = { selfServeMicros: number | null; raiseOnceMicros: number | null; raisedAt: string | null };

export function spendRange(
  limit: Pick<Limit, "availableMicros" | "ceilingMicros" | "raiseOnceMicros" | "raisedAt">,
): SpendRange {
  const selfServe = limit.availableMicros !== undefined ? limit.availableMicros : limit.ceilingMicros;
  const once = limit.raiseOnceMicros ?? null;
  return {
    selfServeMicros: selfServe ?? null,
    // The raise only matters when it goes further than owners can already.
    raiseOnceMicros: once != null && (selfServe == null || once > selfServe) ? once : null,
    raisedAt: limit.raisedAt ?? null,
  };
}

/**
 * What setting the spend limit to `micros` takes, as billing decides it:
 * nothing (`self`), the one-time raise (`raise`), or a request to g1t
 * (`ask`).
 */
export function spendPath(micros: number, range: SpendRange): "self" | "raise" | "ask" {
  if (range.selfServeMicros == null || micros <= range.selfServeMicros) return "self";
  if (range.raiseOnceMicros != null && micros <= range.raiseOnceMicros) return "raise";
  return "ask";
}

/** Where the workspace stands with the g1t plan, for the plan card. */
export type PlanStatus = {
  kind: "free" | "trial" | "paid" | "canceling" | "past_due" | "comped" | "enterprise";
  label: string;
};

export function planStatus(
  plan: Pick<FeatureState, "on" | "included" | "subscription"> | null | undefined,
  entitlements: Pick<Entitlements, "plan" | "trialMicrosLeft" | "trialVerified" | "firstMonth"> | null | undefined,
): PlanStatus {
  if (entitlements?.plan === "internal") return { kind: "comped", label: "Comped by g1t" };
  if (entitlements?.plan === "enterprise") return { kind: "enterprise", label: "Paid by an enterprise" };
  if (plan?.included) return { kind: "comped", label: "Included by g1t" };
  const subscription = plan?.subscription;
  if (subscription?.status === "past_due") return { kind: "past_due", label: "Payment failed" };
  if (plan?.on && subscription?.status === "canceling") return { kind: "canceling", label: "Ends at the end of the period" };
  if ((plan?.on && subscription) || entitlements?.plan === "paid") {
    return { kind: "paid", label: entitlements?.firstMonth ? "On the g1t plan, first month" : "On the g1t plan" };
  }
  if (entitlements?.trialVerified && entitlements.trialMicrosLeft > 0) return { kind: "trial", label: "Free, on the trial" };
  return { kind: "free", label: "Free" };
}

/** Meters only the plan runs: a free workspace never builds, serves apps or adds custom domains. */
const PLAN_ONLY_METERS = new Set(["builds", "requests", "domains"]);

/**
 * The lines of "This month's usage": every meter on the plan, so it reads
 * the same each month; without it, only what a free workspace can use,
 * plus anything that was used anyway (from before the plan ended).
 */
export function shownMeters(meters: MeterUsage[], onPlan: boolean): MeterUsage[] {
  return meters.filter((meter) => onPlan || !PLAN_ONLY_METERS.has(meter.key) || meter.micros > 0);
}

/** `1 GB`, `500 MB`: storage as it is priced, in powers of ten. */
export function gigabytes(bytes: number): string {
  if (bytes >= 1e9) return `${Math.round((bytes / 1e9) * 10) / 10} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}

/** A share from 0 to 1 of `used` against `of`, for a meter. */
export function share(used: number, of: number | null | undefined): number {
  if (!of || of <= 0) return 0;
  return Math.min(1, Math.max(0, used / of));
}

/** Where the trial stands after a card check, in a sentence for the owner. */
export function cardCheckResult(
  entitlements: Pick<Entitlements, "trialVerified" | "trialMicrosLeft">,
  trialMicros: number,
): string {
  if (!entitlements.trialVerified) return "The card check did not finish. Try again; the card is never charged.";
  if (entitlements.trialMicrosLeft > 0) return `Card checked. Your ${wholeDollars(entitlements.trialMicrosLeft)} trial is ready to use.`;
  return `Card checked, but no trial started. The ${wholeDollars(trialMicros)} trial needs a credit or debit card that has not started one before, and comes from a monthly pool that can run out. Prepaid cards can still pay for the plan.`;
}

const METERS: Record<string, string> = {
  included: "the plan's included usage",
  spend_limit: "your spend limit",
  ceiling: "what g1t lets go unpaid",
};

/** One alert as a sentence: "90% of the plan's included usage: $9.00 of $10.00." */
export function alertText(alert: UsageAlert): string {
  const what = METERS[alert.meter] ?? alert.meter.replace(/_/g, " ");
  const reached = alert.level >= 100 ? `All of ${what}` : `${alert.level}% of ${what}`;
  return `${reached}: ${dollars(alert.usedMicros)} of ${dollars(alert.limitMicros)}.`;
}

/** How loud an alert is. */
export function alertTone(level: number): "ok" | "warning" | "stopped" {
  if (level >= 100) return "stopped";
  return level >= 75 ? "warning" : "ok";
}

/** Whether the workspace needs an owner's eye now: compute paused, a spike waiting, or an alert at 90% or more. */
export function needsAttention(entitlements: Pick<Entitlements, "paused" | "spike" | "alerts"> | null | undefined): boolean {
  if (!entitlements) return false;
  if (entitlements.paused) return true;
  if (entitlements.spike && entitlements.spike.status !== "continued") return true;
  return (entitlements.alerts ?? []).some((alert) => alert.level >= 90);
}

/** A request's state as the owner sees it. */
export function requestStatus(request: LimitRequest): string {
  if (request.status === "approved")
    return request.decidedMicros != null ? `Approved at ${wholeDollars(request.decidedMicros)}` : "Approved";
  if (request.status === "declined") return "Declined";
  return "Waiting for an answer";
}

/** What each kind of agent work is called, and its colour, on Usage and the workspace's overview. */
export const USAGE_TASKS: Record<string, { label: string; color: string }> = {
  implement: { label: "Making changes", color: "var(--color-merged)" },
  review: { label: "Reviews", color: "var(--color-info)" },
  revise: { label: "Revisions", color: "var(--color-warn)" },
  update: { label: "Catching up", color: "var(--color-accent)" },
  plan: { label: "Planning", color: "#f0a6ca" },
  other: { label: "Other", color: "var(--color-faint)" },
};

/** A kind of work's words and colour, or Other's. */
export function usageTask(key: string): { label: string; color: string } {
  return USAGE_TASKS[key] ?? USAGE_TASKS.other!;
}

/** The workspace's month at a glance, for the Usage card on its overview. */
export type UsageGlance = {
  /**
   * `beta` while g1t charges nothing; `comped` when g1t or an enterprise
   * pays; `plan` on the g1t plan; `trial` on trial credit; `forge` with
   * neither, where only what runs no compute is open.
   */
  kind: "beta" | "comped" | "plan" | "trial" | "forge";
  /** Charged this month, or used at cost while g1t is free. */
  spentMicros: number;
  /** What pays first, and how much of it is used: the plan's included usage, or the trial. */
  credit: { label: string; usedMicros: number; ofMicros: number } | null;
  /** Charged past what is included, and the spend limit if there is one; null when it does not apply. */
  onDemand: { micros: number; limitMicros: number | null } | null;
  /** What it went on, most first. */
  lines: { key: string; label: string; micros: number; runs: number }[];
};

export function usageGlance(input: {
  usage: Pick<Usage, "free" | "spentMicros" | "usedMicros" | "byTask">;
  status: PlanStatus;
  entitlements: Pick<Entitlements, "includedMicros" | "includedUsedMicros" | "trialMicrosLeft"> | null;
  limit: Pick<Limit, "spentMicros" | "spendLimitMicros"> | null;
  trialMicros: number;
}): UsageGlance {
  const { usage, status, entitlements, limit, trialMicros } = input;
  const lines = [...usage.byTask]
    .filter((slice) => slice.micros > 0)
    .sort((a, b) => b.micros - a.micros)
    .map((slice) => ({ key: slice.key, label: usageTask(slice.key).label, micros: slice.micros, runs: slice.runs }));
  const spentMicros = usage.free ? usage.usedMicros : usage.spentMicros;
  const plain = { spentMicros, credit: null, onDemand: null, lines };
  if (usage.free) return { kind: "beta", ...plain };
  if (status.kind === "comped" || status.kind === "enterprise") return { kind: "comped", ...plain };
  if (status.kind === "trial") {
    const left = Math.max(0, entitlements?.trialMicrosLeft ?? 0);
    const of = Math.max(trialMicros, left);
    return { ...plain, kind: "trial", credit: { label: "Trial credit", usedMicros: of - left, ofMicros: of } };
  }
  if (status.kind === "free") return { kind: "forge", ...plain };
  const included = entitlements?.includedMicros ?? 0;
  const includedUsed = Math.min(entitlements?.includedUsedMicros ?? 0, included);
  return {
    ...plain,
    kind: "plan",
    credit: included > 0 ? { label: "Included usage", usedMicros: includedUsed, ofMicros: included } : null,
    onDemand: {
      micros: limit?.spentMicros ?? Math.max(0, spentMicros - includedUsed),
      limitMicros: limit?.spendLimitMicros ?? null,
    },
  };
}
