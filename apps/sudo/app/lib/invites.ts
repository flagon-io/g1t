/**
 * The Invites page's forms and tabs: the waitlist, every invite, grants of
 * more invites, and a person's invite tree. No Workers imports, so it can
 * be tested under Node. Identity checks everything again.
 */
import type { WaitlistStatus } from "@g1t/contracts";

import type { Parsed } from "./forms.ts";

export const INVITE_TABS = ["waitlist", "invites", "grant", "tree"] as const;
export type InviteTab = (typeof INVITE_TABS)[number];

export const TAB_LABEL: Record<InviteTab, string> = {
  waitlist: "Waitlist",
  invites: "Invites",
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
};
