/**
 * The Invites page's forms and tabs: the waitlist, every invite, shared
 * invite links, grants of more invites, and a person's invite tree. No
 * Workers imports, so it can be tested under Node. Identity checks
 * everything again.
 */
import type { NewSharedInvite, SharedInvite, SharedInviteStatus, WaitlistStatus } from "@g1t/contracts";

import type { Parsed } from "./forms.ts";

export const INVITE_TABS = ["waitlist", "invites", "shared", "grant", "tree"] as const;
export type InviteTab = (typeof INVITE_TABS)[number];

export const TAB_LABEL: Record<InviteTab, string> = {
  waitlist: "Waitlist",
  invites: "Invites",
  shared: "Shared links",
  grant: "Grant & mint",
  tree: "Invite tree",
};

export function parseTab(raw: string | null): InviteTab {
  return (INVITE_TABS as readonly string[]).includes(raw ?? "") ? (raw as InviteTab) : "waitlist";
}

const STATUSES: (WaitlistStatus | "all")[] = ["waiting", "invited", "dismissed", "all"];

export function parseWaitlistStatus(raw: string | null): WaitlistStatus | "all" {
  return STATUSES.includes(raw as WaitlistStatus) ? (raw as WaitlistStatus | "all") : "waiting";
}

/** Where a tab lives, with its search. */
export function invitesHref(tab: InviteTab, params: Record<string, string | null | undefined> = {}): string {
  const search = new URLSearchParams({ tab });
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  return `/invites?${search}`;
}

/** The most one grant gives or takes back; identity holds the same line. */
export const MAX_GRANT = 1000;

const NAME = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;

export type Grant = { target: "user" | "workspace"; name: string; amount: number; note: string };

/** A grant of invites, as typed: who, how many (negative takes back), and why. */
export function parseGrant(form: { get(name: string): unknown }): Parsed<Grant> {
  const read = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value.trim() : "";
  };
  const target = read("target");
  if (target !== "user" && target !== "workspace") return { ok: false, error: "Choose a person or a workspace." };
  const name = read("name").replace(/^@/, "").toLowerCase();
  if (!NAME.test(name)) return { ok: false, error: `“${read("name")}” is not a ${target === "user" ? "username" : "workspace slug"}.` };
  const raw = read("amount");
  if (!/^-?\d+$/.test(raw)) return { ok: false, error: "Give a whole number of invites, such as 10, or -5 to take some back." };
  const amount = Number(raw);
  if (amount === 0 || Math.abs(amount) > MAX_GRANT) return { ok: false, error: `Grant between 1 and ${MAX_GRANT} invites.` };
  const note = read("note");
  if (note.length < 3) return { ok: false, error: "Say why, for the record." };
  return { ok: true, value: { target, name, amount, note: note.slice(0, 500) } };
}

/** An address to mint an invite for, or none: anyone with the code. */
export function parseMintEmail(raw: string): Parsed<string | null> {
  const email = raw.trim().toLowerCase();
  if (!email) return { ok: true, value: null };
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? { ok: true, value: email } : { ok: false, error: `“${raw}” is not an email address.` };
}

/** The flash messages the page redirects back with (`?done=`). */
export const INVITES_DONE: Record<string, string> = {
  approved: "Approved. The invite is on its way to that address.",
  dismissed: "Dismissed.",
  revoked: "Invite revoked. It comes back to whoever it was charged to.",
  granted: "Granted. It applies at once.",
  "shared-created": "Shared link made. Copy it below and hand it to the group.",
  "shared-revoked": "Shared link revoked. It makes no more accounts; the ones it made stay.",
};

/** The flash for `?done=` and, after deciding several at once, `?n=` of them. */
export function doneMessage(done: string | null, n: string | null): string | null {
  if (!done) return null;
  const count = Number(n);
  if (Number.isInteger(count) && count > 1) {
    if (done === "approved") return `Approved ${count} requests. Each invite is on its way.`;
    if (done === "dismissed") return `Dismissed ${count} requests.`;
  }
  return INVITES_DONE[done] ?? null;
}

/** The most requests one bulk decision takes: each one is its own call to identity. */
export const MAX_BULK = 50;

/** The waitlist entries ticked on a bulk form, each once, in order. */
export function parseIds(form: { getAll(name: string): unknown[] }): Parsed<string[]> {
  const ids = [
    ...new Set(
      form
        .getAll("ids")
        .filter((id): id is string => typeof id === "string")
        .map((id) => id.trim())
        .filter((id) => /^wl_[0-9a-z]{1,40}$/.test(id)),
    ),
  ];
  if (ids.length === 0) return { ok: false, error: "Tick the requests to decide on first." };
  if (ids.length > MAX_BULK) return { ok: false, error: `Decide on at most ${MAX_BULK} at a time.` };
  return { ok: true, value: ids };
}

/** The most characters an approval's note keeps; identity holds the same line. */
export const MAX_NOTE = 500;

/** A note for the invite email: trimmed, or none. */
export function parseNote(raw: string | null | undefined): Parsed<string | null> {
  const note = (raw ?? "").trim();
  if (!note) return { ok: true, value: null };
  if (note.length > MAX_NOTE) return { ok: false, error: `Keep the note to ${MAX_NOTE} characters; it is ${note.length}.` };
  return { ok: true, value: note };
}

// --- Shared invite links ------------------------------------------------------------

/** The most accounts one shared link makes; identity holds the same line. */
export const MAX_SHARED_USES = 1000;
/** The most characters a shared link's label keeps; identity holds the same line. */
export const MAX_SHARED_LABEL = 80;
/** The most email domains a shared link may be limited to; identity holds the same line. */
export const MAX_SHARED_DOMAINS = 10;
/** How long a shared link works unless staff choose a day. */
export const SHARED_TTL_DAYS = 14;
/** The furthest ahead its last day may be. */
export const SHARED_MAX_DAYS = 365;

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The day `days` after `now`, as a date input holds it (UTC). */
export function dayAfter(now: number, days: number): string {
  return new Date(now + days * DAY_MS).toISOString().slice(0, 10);
}

/** The address a shared link has: sign-up with its code filled in. */
export function sharedInviteLink(code: string, origin = "https://g1t.sh"): string {
  return `${origin.replace(/\/+$/, "")}/register?invite=${encodeURIComponent(code)}`;
}

/** One email domain as staff typed it (`@Cloudflare.com` reads as `cloudflare.com`), if it is one. */
export function normalizeDomain(raw: string): string | null {
  const domain = raw.trim().replace(/^@+/, "").replace(/\.+$/, "").toLowerCase();
  if (domain.length < 3 || domain.length > 253 || !domain.includes(".")) return null;
  return domain.split(".").every((label) => DOMAIN_LABEL.test(label)) ? domain : null;
}

/**
 * A new shared link, as typed: a label, 1 to 1000 uses, a last day from
 * today to a year ahead (none: 14 days), and up to 10 domains separated by
 * commas or spaces.
 */
export function parseSharedInvite(form: { get(name: string): unknown }, now = Date.now()): Parsed<NewSharedInvite> {
  const read = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value.trim() : "";
  };
  const label = read("label").replace(/\s+/g, " ");
  if (!label) return { ok: false, error: "Give the link a label, such as Cloudflare judges." };
  if (label.length > MAX_SHARED_LABEL) return { ok: false, error: `Keep the label to ${MAX_SHARED_LABEL} characters.` };
  const uses = read("max_uses");
  if (!/^\d+$/.test(uses) || Number(uses) < 1 || Number(uses) > MAX_SHARED_USES) {
    return { ok: false, error: `A shared link makes between 1 and ${MAX_SHARED_USES} accounts.` };
  }
  const expires = read("expires_on");
  let expiresOn: string | null = null;
  if (expires) {
    const day = DATE.test(expires) ? new Date(`${expires}T00:00:00Z`) : null;
    if (!day || Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== expires) {
      return { ok: false, error: "Give the expiry as a date, such as 2026-10-28." };
    }
    if (expires < dayAfter(now, 0)) return { ok: false, error: "The expiry has passed. Choose today or a later day." };
    if (expires > dayAfter(now, SHARED_MAX_DAYS)) return { ok: false, error: `A shared link works for at most ${SHARED_MAX_DAYS} days.` };
    expiresOn = expires;
  }
  const domains: string[] = [];
  for (const typed of read("domains").split(/[\s,]+/).filter(Boolean)) {
    const domain = normalizeDomain(typed);
    if (!domain) return { ok: false, error: `${typed} is not an email domain. Write domains such as cloudflare.com.` };
    if (!domains.includes(domain)) domains.push(domain);
  }
  if (domains.length > MAX_SHARED_DOMAINS) return { ok: false, error: `Limit a link to at most ${MAX_SHARED_DOMAINS} domains.` };
  return { ok: true, value: { label, maxUses: Number(uses), expiresOn, domains } };
}

/** How a shared link's state reads, and its badge's tone. */
export function sharedStatus(status: SharedInviteStatus): { label: string; tone: "lavender" | "mint" | "danger" | "plain" } {
  switch (status) {
    case "live":
      return { label: "Live", tone: "lavender" };
    case "used_up":
      return { label: "Used up", tone: "mint" };
    case "expired":
      return { label: "Expired", tone: "plain" };
    case "revoked":
      return { label: "Revoked", tone: "danger" };
  }
}

/** How many of its uses are taken, in words. */
export function usesLine(link: Pick<SharedInvite, "uses" | "maxUses">): string {
  return `${link.uses} of ${link.maxUses} used`;
}

/** Whom a shared link is for, by address. */
export function domainsLine(domains: string[]): string {
  if (domains.length === 0) return "Any email address";
  return `Only addresses at ${domains.join(", ")}`;
}

/** What an account made with a shared link says about where it came from. */
export function joinedThrough(label: string): string {
  return `Joined through ${label}`;
}
