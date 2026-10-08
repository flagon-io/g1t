/**
 * Reading sudo's forms. Everything typed is checked here before it goes
 * to the billing service, which checks it again.
 */
import type { Allowances, SalesStage, Terms } from "@g1t/contracts";

import { MICROS_PER_DOLLAR, parseDollars } from "./money.ts";
import { isStage } from "./signals.ts";

/** A workspace slug, as identity allows them (GitHub's rules). */
const SLUG = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;
/** An account id (`ws_<slug>`, `ent_…`) or a workspace slug. */
const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

/** The most one credit can be, against a slipped finger. */
export const MAX_CREDIT_MICROS = 10_000 * MICROS_PER_DOLLAR;
const MAX_NOTE = 500;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

/** The form's own fields, to carry through a confirmation step. */
export function fields(form: FormData, ...names: string[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => [name, text(form, name)]));
}

export function isSlug(value: string): boolean {
  return SLUG.test(value);
}

export function isAccountId(value: string): boolean {
  return ACCOUNT_ID.test(value);
}

export function parseSlug(raw: string): Parsed<string> {
  const slug = raw.trim().toLowerCase();
  return isSlug(slug) ? { ok: true, value: slug } : { ok: false, error: `“${raw}” is not a workspace slug.` };
}

/** Slugs separated by commas, spaces or lines; each once. */
export function parseSlugList(raw: string): Parsed<string[]> {
  const slugs: string[] = [];
  for (const part of raw.split(/[\s,]+/).filter(Boolean)) {
    const slug = parseSlug(part);
    if (!slug.ok) return slug;
    if (!slugs.includes(slug.value)) slugs.push(slug.value);
  }
  return { ok: true, value: slugs };
}

export function parseNote(raw: string): Parsed<string> {
  if (!raw) return { ok: false, error: "A note is required: say why, for whoever looks next." };
  if (raw.length > MAX_NOTE) return { ok: false, error: `Keep the note under ${MAX_NOTE} characters.` };
  return { ok: true, value: raw };
}

/**
 * Terms from the terms form: a discount (a preset, 0, 25, 50 or 100%, or
 * a custom whole percent), a limit, an end date and why. No discount and no
 * limit is standard, and clears everything else; anything else is custom
 * terms. A 100% discount charges nothing (what was "comped"), and its limit
 * is g1t's monthly budget for it, at cost. An end date is a day, and the
 * terms last to its end, UTC.
 */
export function parseTerms(form: FormData, by: string, now = new Date()): Parsed<Terms> {
  // A form from before discounts said `kind=comped`.
  const preset = text(form, "kind") === "comped" ? "100" : text(form, "preset") || "0";
  let discountPercent: number;
  if (preset === "custom") {
    const raw = text(form, "discount");
    if (!/^\d{1,3}$/.test(raw) || Number(raw) > 100) return { ok: false, error: "The discount is a whole percent from 0 to 100." };
    discountPercent = Number(raw);
  } else if (/^\d{1,3}$/.test(preset) && Number(preset) <= 100) {
    discountPercent = Number(preset);
  } else {
    return { ok: false, error: "Choose a discount: 0, 25, 50 or 100%, or Custom." };
  }

  let ceilingMicros: number | null = null;
  const rawCeiling = text(form, "ceiling");
  if (rawCeiling !== "") {
    const micros = parseDollars(rawCeiling);
    if (micros == null) return { ok: false, error: "The limit is a dollar amount, such as 250 or 1,000.00." };
    ceilingMicros = micros;
  }
  const kind: Terms["kind"] = discountPercent > 0 || ceilingMicros != null ? "custom" : "standard";
  const note = parseNote(text(form, "note"));
  if (!note.ok) return note;

  let until: string | null = null;
  if (kind !== "standard") {
    const raw = text(form, "until");
    if (raw !== "") {
      const end = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T23:59:59Z`) : null;
      if (!end || Number.isNaN(end.getTime()) || end.toISOString().slice(0, 10) !== raw) {
        return { ok: false, error: "The end date is not a date." };
      }
      if (end.getTime() <= now.getTime()) return { ok: false, error: "The end date has to be in the future." };
      until = end.toISOString().replace(".000Z", "Z");
    }
  }

  return {
    ok: true,
    value: { kind, discountPercent, ceilingMicros, note: note.value, until, setBy: by, setAt: now.toISOString() },
  };
}

/** An email address for invoices: one address, lowercased. */
export function parseEmail(raw: string): Parsed<string> {
  const email = raw.trim().toLowerCase();
  const [local, domain, ...rest] = email.split("@");
  const ok =
    rest.length === 0 &&
    email.length <= 254 &&
    !!local &&
    !!domain &&
    /^[^\s@,;<>"]+$/.test(local) &&
    /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain);
  return ok ? { ok: true, value: email } : { ok: false, error: "Enter one email address, such as billing@acme.com." };
}

export type SalesUpdate = { stage: SalesStage; owner: string | null; nextStep: string | null; nextAt: string | null };

const MAX_NEXT_STEP = 200;
const MAX_SALES_NOTE = 2000;

/**
 * A workspace's sales record from its form. The owner is a staff member's
 * email, or nobody; a next step may have a date (a day, UTC) or not.
 */
export function parseSales(form: FormData): Parsed<SalesUpdate> {
  const stage = text(form, "stage");
  if (!isStage(stage)) return { ok: false, error: "Choose a stage." };

  let owner: string | null = null;
  const rawOwner = text(form, "owner");
  if (rawOwner !== "") {
    const email = parseEmail(rawOwner);
    if (!email.ok) return { ok: false, error: "The owner is a staff member's email, such as you@g1t.sh, or blank for nobody." };
    owner = email.value;
  }

  const nextStep = text(form, "nextStep").replace(/\s+/g, " ");
  if (nextStep.length > MAX_NEXT_STEP) return { ok: false, error: `Keep the next step under ${MAX_NEXT_STEP} characters.` };

  let nextAt: string | null = null;
  const rawDate = text(form, "nextAt");
  if (rawDate !== "") {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? new Date(`${rawDate}T00:00:00Z`) : null;
    if (!day || Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== rawDate) {
      return { ok: false, error: "The follow-up date is not a date." };
    }
    nextAt = rawDate;
  }
  if (nextAt && !nextStep) return { ok: false, error: "Say what the next step is, as well as when." };

  return { ok: true, value: { stage, owner, nextStep: nextStep || null, nextAt } };
}

/** A note on a workspace's sales record. */
export function parseSalesNote(raw: string): Parsed<string> {
  if (!raw) return { ok: false, error: "Write the note first." };
  if (raw.length > MAX_SALES_NOTE) return { ok: false, error: `Keep a note under ${MAX_SALES_NOTE} characters.` };
  return { ok: true, value: raw };
}

/** A credit's amount: more than nothing, and no more than the cap. */
export function parseCredit(raw: string): Parsed<number> {
  const micros = parseDollars(raw);
  if (micros == null || micros <= 0) return { ok: false, error: "The amount is dollars and cents, more than zero, such as 25 or 120.50." };
  if (micros > MAX_CREDIT_MICROS) return { ok: false, error: "One credit is at most $10,000. Issue more than one if it really is more." };
  return { ok: true, value: micros };
}

/** The most staff can set an account's share of a pool to, against a slipped finger. */
export const MAX_POOL_SHARE_MICROS = 1_000 * MICROS_PER_DOLLAR;
/** The most agents at once staff can allow one account. */
export const MAX_AGENTS_AT_ONCE = 100;
/** Staff's overrides of the owners' caps: one run, and one issue's agents in all. */
export const MAX_RUN_CAP_MICROS = 1_000 * MICROS_PER_DOLLAR;
export const MAX_ISSUE_CAP_MICROS = 10_000 * MICROS_PER_DOLLAR;
/**
 * The most days of audit log staff can give one account: billing's
 * AUDIT_MAX_DAYS. The events service deletes anything older for everyone.
 */
export const MAX_AUDIT_DAYS = 400;
/** The smallest cap: ten cents, as owners may set. */
const MIN_CAP_MICROS = 100_000;
const MAX_HOLD = 200;

/**
 * Allowances from the plan-and-pools form: the g1t plan without its price,
 * the account's share of the open-source pool and of trials, and staff's
 * overrides of agents at once, the run cap, the issue cap and the days of
 * audit log kept. A blank amount means the default (for a cap, no
 * override; for the audit log, the plan's). A hold is a line saying why
 * new compute is held; blank is no hold.
 */
export function parseAllowances(form: FormData): Parsed<Allowances> {
  const amount = (name: string, what: string, max: number, maxText: string, min = 0): Parsed<number | null> => {
    const raw = text(form, name);
    if (!raw) return { ok: true, value: null };
    const micros = parseDollars(raw);
    if (micros == null) return { ok: false, error: `${what} is dollars and cents, such as 5 or 2.50, or blank for the default.` };
    if (micros < min) return { ok: false, error: `${what} is at least $${(min / MICROS_PER_DOLLAR).toFixed(2)}, or blank for the default.` };
    if (micros > max) return { ok: false, error: `${what} is at most ${maxText}.` };
    return { ok: true, value: micros };
  };
  const oss = amount("oss", "The open-source share", MAX_POOL_SHARE_MICROS, "$1,000");
  if (!oss.ok) return oss;
  const trial = amount("trial", "The trial credit", MAX_POOL_SHARE_MICROS, "$1,000");
  if (!trial.ok) return trial;
  const runCap = amount("runCap", "The run cap", MAX_RUN_CAP_MICROS, "$1,000", MIN_CAP_MICROS);
  if (!runCap.ok) return runCap;
  const issueCap = amount("issueCap", "The issue cap", MAX_ISSUE_CAP_MICROS, "$10,000", MIN_CAP_MICROS);
  if (!issueCap.ok) return issueCap;

  let maxConcurrentAgents: number | null = null;
  const rawAgents = text(form, "agents");
  if (rawAgents) {
    if (!/^\d{1,3}$/.test(rawAgents) || Number(rawAgents) < 1 || Number(rawAgents) > MAX_AGENTS_AT_ONCE) {
      return { ok: false, error: `Agents at once is a whole number from 1 to ${MAX_AGENTS_AT_ONCE}, or blank for the default.` };
    }
    maxConcurrentAgents = Number(rawAgents);
  }

  let auditRetentionDays: number | null = null;
  const rawAudit = text(form, "auditDays");
  if (rawAudit) {
    if (!/^\d{1,3}$/.test(rawAudit) || Number(rawAudit) < 1 || Number(rawAudit) > MAX_AUDIT_DAYS) {
      return { ok: false, error: `Audit log days is a whole number from 1 to ${MAX_AUDIT_DAYS}, or blank for the plan's.` };
    }
    auditRetentionDays = Number(rawAudit);
  }

  const hold = text(form, "hold").replace(/\s+/g, " ");
  if (hold.length > MAX_HOLD) return { ok: false, error: `Keep the hold's reason under ${MAX_HOLD} characters.` };

  return {
    ok: true,
    value: {
      plan: text(form, "plan") === "on",
      ossRepoMicros: oss.value,
      trialMicros: trial.value,
      maxConcurrentAgents,
      runCapMicros: runCap.value,
      issueCapMicros: issueCap.value,
      auditRetentionDays,
      hold: hold || null,
    },
  };
}

/** The most one recorded payment can be; billing refuses more. */
export const MAX_PAYMENT_MICROS = 100_000 * MICROS_PER_DOLLAR;
const MAX_REFERENCE = 100;

export type PaymentInput = { amountMicros: number; reference: string; note: string };

/**
 * A bank transfer that reached g1t outside Stripe's page, from its form:
 * the amount, the transfer's reference (each is recorded once), a note,
 * and the workspace's slug typed out to confirm.
 */
export function parsePayment(form: FormData, workspace: string): Parsed<PaymentInput> {
  const amountMicros = parseDollars(text(form, "amount"));
  if (amountMicros == null || amountMicros <= 0) {
    return { ok: false, error: "The amount is dollars and cents, more than zero, such as 1,500 or 2400.50." };
  }
  if (amountMicros > MAX_PAYMENT_MICROS) {
    return { ok: false, error: "One payment is at most $100,000. Record a larger transfer in parts, each with its own reference." };
  }
  const reference = text(form, "reference").replace(/\s+/g, " ");
  if (!reference) return { ok: false, error: "Give the transfer's reference, as the bank shows it, so it is recorded once." };
  if (reference.length > MAX_REFERENCE) return { ok: false, error: `Keep the reference under ${MAX_REFERENCE} characters.` };
  const note = parseNote(text(form, "note"));
  if (!note.ok) return note;
  if (text(form, "confirmation") !== workspace) {
    return { ok: false, error: `Type the workspace's slug, ${workspace}, exactly, to record the payment.` };
  }
  return { ok: true, value: { amountMicros, reference, note: note.value } };
}

/** The most staff can approve on a request; billing refuses more. */
export const MAX_REQUEST_MICROS = 1_000_000 * MICROS_PER_DOLLAR;

export type Decision = { id: string; decision: "approve" | "decline"; amountMicros: number | null; note: string };

/**
 * A decision on a limit or overage request. Approve takes the amount asked
 * (blank) or another; decline needs a note, which the owner reads.
 */
export function parseDecision(form: FormData): Parsed<Decision> {
  const id = text(form, "id");
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return { ok: false, error: "That is not a request." };
  const decision = text(form, "decision");
  if (decision !== "approve" && decision !== "decline") return { ok: false, error: "Approve or decline." };
  const note = text(form, "note");
  if (note.length > MAX_NOTE) return { ok: false, error: `Keep the note under ${MAX_NOTE} characters.` };
  if (decision === "decline") {
    if (!note) return { ok: false, error: "Say why, for the owner: they read it in the app and by email." };
    return { ok: true, value: { id, decision, amountMicros: null, note } };
  }
  let amountMicros: number | null = null;
  const raw = text(form, "amount");
  if (raw) {
    const micros = parseDollars(raw);
    if (micros == null || micros < MICROS_PER_DOLLAR) return { ok: false, error: "The amount is dollars and cents, at least $1, such as 750." };
    if (micros > MAX_REQUEST_MICROS) return { ok: false, error: "Approve at most $1,000,000." };
    amountMicros = micros;
  }
  return { ok: true, value: { id, decision, amountMicros, note } };
}

export type GoodwillInput = { amountMicros: number | null; reason: string; day: string | null };

/** A typed reason is a sentence: billing asks for at least this many characters. */
export const MIN_REASON = 10;

/**
 * A goodwill credit from its form. No amount is the one-click credit. A
 * reason is required when `needsReason` says so (more than the one-click
 * credit, or a second within 12 months). The day is when the accidental
 * usage happened; blank lets billing choose it.
 */
export function parseGoodwill(
  form: FormData,
  needsReason: (amountMicros: number | null) => boolean,
  now = new Date(),
): Parsed<GoodwillInput> {
  let amountMicros: number | null = null;
  const raw = text(form, "amount");
  if (raw) {
    const micros = parseDollars(raw);
    if (micros == null || micros <= 0) return { ok: false, error: "The amount is dollars and cents, more than zero, such as 40 or 12.50." };
    if (micros > MAX_CREDIT_MICROS) return { ok: false, error: "A goodwill credit is at most $10,000." };
    amountMicros = micros;
  }
  const reason = text(form, "reason").replace(/\s+/g, " ");
  if (reason.length > MAX_NOTE) return { ok: false, error: `Keep the reason under ${MAX_NOTE} characters.` };
  if (needsReason(amountMicros) && reason.length < MIN_REASON) {
    return { ok: false, error: "This credit needs a reason: say why, in a sentence, for whoever looks next." };
  }
  let day: string | null = null;
  const rawDay = text(form, "day");
  if (rawDay) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDay) ? new Date(`${rawDay}T00:00:00Z`) : null;
    if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== rawDay) return { ok: false, error: "The day is not a date." };
    if (date.getTime() > now.getTime()) return { ok: false, error: "The day of the usage cannot be in the future." };
    day = rawDay;
  }
  return { ok: true, value: { amountMicros, reason, day } };
}
