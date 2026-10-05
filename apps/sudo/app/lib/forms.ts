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
 * Terms from the terms form. Standard clears everything else; a ceiling
 * applies to comped and custom; a discount to custom only. An end date is
 * a day, and the terms last to its end, UTC.
 */
export function parseTerms(form: FormData, by: string, now = new Date()): Parsed<Terms> {
  const kind = text(form, "kind");
  if (kind !== "standard" && kind !== "comped" && kind !== "custom") return { ok: false, error: "Choose standard, comped or custom terms." };
  const note = parseNote(text(form, "note"));
  if (!note.ok) return note;

  let discountPercent = 0;
  if (kind === "custom") {
    const raw = text(form, "discount");
    if (raw !== "") {
      if (!/^\d{1,3}$/.test(raw) || Number(raw) > 100) return { ok: false, error: "The discount is a whole percent from 0 to 100." };
      discountPercent = Number(raw);
    }
  }

  let ceilingMicros: number | null = null;
  if (kind !== "standard") {
    const raw = text(form, "ceiling");
    if (raw !== "") {
      const micros = parseDollars(raw);
      if (micros == null) return { ok: false, error: "The ceiling is a dollar amount, such as 250 or 1,000.00." };
      ceilingMicros = micros;
    }
  }
  if (kind === "custom" && discountPercent === 0 && ceilingMicros == null) {
    return { ok: false, error: "Custom terms need a discount, a ceiling, or both." };
  }

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

/**
 * Allowances from the plan-and-pools form: Team without charge, and the
 * account's share of the open-source pool and of trials. A blank amount
 * means the default.
 */
export function parseAllowances(form: FormData): Parsed<Allowances> {
  const amount = (name: string, what: string): Parsed<number | null> => {
    const raw = text(form, name);
    if (!raw) return { ok: true, value: null };
    const micros = parseDollars(raw);
    if (micros == null || micros < 0) return { ok: false, error: `${what} is dollars and cents, such as 5 or 2.50, or blank for the default.` };
    if (micros > MAX_POOL_SHARE_MICROS) return { ok: false, error: `${what} is at most $1,000.` };
    return { ok: true, value: micros };
  };
  const oss = amount("oss", "The open-source share");
  if (!oss.ok) return oss;
  const trial = amount("trial", "The trial credit");
  if (!trial.ok) return trial;
  return { ok: true, value: { team: text(form, "team") === "on", ossRepoMicros: oss.value, trialMicros: trial.value } };
}
