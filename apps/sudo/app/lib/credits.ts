/**
 * Giving a workspace credit from sudo: a preset or custom amount, a kind,
 * an optional expiry, and a note. Small credits are one step; past
 * `CONFIRM_OVER_MICROS` the workspace's slug is typed out as well. No
 * Workers or React imports, so it can be tested under Node.
 */
import type { CreditGrant, CreditKind } from "@g1t/contracts";

import { type Parsed, parseCredit, parseNote, text } from "./forms.ts";
import { MICROS_PER_DOLLAR } from "./money.ts";

/** The amounts offered as one click, in dollars. */
export const CREDIT_PRESETS = [10, 20, 25, 50, 100] as const;

/** Over this, the slug is typed out to give it. */
export const CONFIRM_OVER_MICROS = 100 * MICROS_PER_DOLLAR;

export const CREDIT_KINDS: { value: CreditKind; title: string; text: string }[] = [
  { value: "promotional", title: "Promotional", text: "A welcome, a referral, an event. Given away when spent." },
  { value: "goodwill", title: "Goodwill", text: "An apology. Given away when spent." },
  { value: "refund", title: "Refund", text: "Money back for something that went wrong. Never expires." },
];

/** How long unused credit lasts. */
export const EXPIRIES: { value: string; label: string }[] = [
  { value: "none", label: "Never" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
  { value: "date", label: "On a date" },
];

const MAX_REFUND_FOR = 200;
const MAX_EXPIRY_DAYS = 5 * 366;
const DAY_MS = 24 * 60 * 60 * 1000;

export function kindLabel(kind: CreditKind): string {
  return CREDIT_KINDS.find((k) => k.value === kind)?.title ?? kind;
}

export function isCreditKind(value: string): value is CreditKind {
  return CREDIT_KINDS.some((k) => k.value === value);
}

export type CreditInput = {
  amountMicros: number;
  kind: CreditKind;
  /** The last second of the day it expires, UTC; null never. */
  expiresAt: string | null;
  refundFor: string | null;
  refundDay: string | null;
  note: string;
};

/** The last second of a day, UTC, as billing keeps times: `2027-01-05T23:59:59Z`. */
export function endOfDay(day: string): string {
  return `${day}T23:59:59Z`;
}

function isDay(raw: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const date = new Date(`${raw}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === raw;
}

/** The amount: a preset (`preset=25`) or, with `preset=custom`, what was typed in `amount`. */
export function parseCreditAmount(preset: string, typed: string): Parsed<number> {
  if (preset !== "custom") {
    const dollars = Number(preset);
    if (!CREDIT_PRESETS.includes(dollars as (typeof CREDIT_PRESETS)[number])) return { ok: false, error: "Choose an amount, or Custom and type one." };
    return { ok: true, value: dollars * MICROS_PER_DOLLAR };
  }
  return parseCredit(typed);
}

/** When unused credit stops counting: never, in 30, 90 or 365 days, or at the end of a chosen day (UTC). */
export function parseExpiry(choice: string, day: string, now = new Date()): Parsed<string | null> {
  if (choice === "" || choice === "none") return { ok: true, value: null };
  if (choice === "date") {
    if (!isDay(day)) return { ok: false, error: "Choose the day the credit expires." };
    const end = new Date(endOfDay(day));
    if (end.getTime() <= now.getTime()) return { ok: false, error: "The expiry has to be in the future." };
    if (end.getTime() > now.getTime() + MAX_EXPIRY_DAYS * DAY_MS) return { ok: false, error: "The expiry is within five years." };
    return { ok: true, value: endOfDay(day) };
  }
  const days = Number(choice);
  if (![30, 90, 365].includes(days)) return { ok: false, error: "Choose when the credit expires." };
  return { ok: true, value: endOfDay(new Date(now.getTime() + days * DAY_MS).toISOString().slice(0, 10)) };
}

/**
 * The credit form: amount, kind, expiry (never for a refund), what a refund
 * is for and the day it refunds, the note, and the slug typed out past
 * `CONFIRM_OVER_MICROS`.
 */
export function parseCreditForm(form: FormData, workspace: string, now = new Date()): Parsed<CreditInput> {
  const amount = parseCreditAmount(text(form, "preset") || "custom", text(form, "amount"));
  if (!amount.ok) return amount;
  const kind = text(form, "kind");
  if (!isCreditKind(kind)) return { ok: false, error: "Choose what kind of credit it is: promotional, goodwill or a refund." };

  let refundFor: string | null = null;
  let refundDay: string | null = null;
  let expiresAt: string | null = null;
  if (kind === "refund") {
    refundFor = text(form, "refundFor").replace(/\s+/g, " ");
    if (!refundFor) return { ok: false, error: "Say what the refund is for, such as the failed runs on Oct 2." };
    if (refundFor.length > MAX_REFUND_FOR) return { ok: false, error: `Keep what the refund is for under ${MAX_REFUND_FOR} characters.` };
    const day = text(form, "refundDay");
    if (day) {
      if (!isDay(day)) return { ok: false, error: "The day refunded is not a date." };
      if (day > now.toISOString().slice(0, 10)) return { ok: false, error: "The day refunded cannot be in the future." };
      refundDay = day;
    }
  } else {
    const expiry = parseExpiry(text(form, "expires"), text(form, "expiresOn"), now);
    if (!expiry.ok) return expiry;
    expiresAt = expiry.value;
  }

  const note = parseNote(text(form, "note"));
  if (!note.ok) return note;
  if (amount.value > CONFIRM_OVER_MICROS && text(form, "confirmation") !== workspace) {
    return { ok: false, error: `Over $100: type the workspace's slug, ${workspace}, exactly, to give it.` };
  }
  return { ok: true, value: { amountMicros: amount.value, kind, expiresAt, refundFor, refundDay, note: note.value } };
}

/** `$25.00 credit, $12.40 left, expires Jan 5`: a grant in a line, as the Billing page says it. */
export function grantSummary(
  grant: Pick<CreditGrant, "amountMicros" | "leftMicros" | "expiresAt" | "state">,
  usd: (micros: number) => string,
  now = new Date(),
): string {
  const parts = [`${usd(grant.amountMicros)} credit`];
  if (grant.state === "open") parts.push(`${usd(grant.leftMicros)} left`);
  else parts.push(grant.state === "used" ? "all used" : grant.state);
  if (grant.state === "open" && grant.expiresAt) parts.push(`expires ${shortDay(grant.expiresAt, now)}`);
  return parts.join(", ");
}

/** `Jan 5`, or `Jan 5, 2028` outside this year, UTC. */
export function shortDay(at: string, now = new Date()): string {
  const date = new Date(at);
  const sameYear = date.getUTCFullYear() === now.getUTCFullYear();
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" });
}

/** The months of the credits list: `YYYY-MM`, or null. */
export function parseMonth(value: string | null): string | null {
  return value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : null;
}
