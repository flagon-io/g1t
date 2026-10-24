/**
 * The waitlist page's pure parts: which status the address asks for,
 * where each tab and search lead, and the note an approval sends. No
 * Workers or React imports, so it can be tested under Node.
 */
import type { RegistrationMode, WaitlistStatus } from "@g1t/contracts";

import type { Parsed } from "./forms.ts";

/** Identity keeps this much of an approval's note (`MAX_WAITLIST_NOTE` in @g1t/contracts). */
export const MAX_NOTE = 500;

export const WAITLIST_TABS = ["waiting", "invited", "dismissed", "all"] as const;
export type WaitlistTab = (typeof WAITLIST_TABS)[number];

/** The status tab from the address: waiting unless another is named. */
export function parseWaitlistTab(value: string | null): WaitlistTab {
  return WAITLIST_TABS.find((tab) => tab === value) ?? "waiting";
}

/** What identity is asked for: null for every status. */
export function statusFilter(tab: WaitlistTab): WaitlistStatus | null {
  return tab === "all" ? null : tab;
}

/** A tab's address, keeping the search. */
export function waitlistHref(tab: WaitlistTab, query = ""): string {
  const params = new URLSearchParams();
  if (tab !== "waiting") params.set("status", tab);
  const q = query.trim();
  if (q) params.set("q", q);
  const search = params.toString();
  return search ? `/waitlist?${search}` : "/waitlist";
}

/** The note an approval puts in the invite email: trimmed, blank for none, at most MAX_NOTE characters. */
export function parseNote(raw: string): Parsed<string | null> {
  const note = raw.trim();
  if (!note) return { ok: true, value: null };
  if ([...note].length > MAX_NOTE) return { ok: false, error: `Keep the note to ${MAX_NOTE} characters.` };
  return { ok: true, value: note };
}

/** What staff chose: approve (invite) or dismiss. */
export function parseWaitlistDecision(value: string): Parsed<boolean> {
  if (value === "approve") return { ok: true, value: true };
  if (value === "dismiss") return { ok: true, value: false };
  return { ok: false, error: "Choose Approve and invite, or Dismiss." };
}

/** The mode the sign-up switch asks for: open, or invite (private preview). */
export function parseRegistrationMode(value: string): Parsed<RegistrationMode> {
  if (value === "open" || value === "invite") return { ok: true, value };
  return { ok: false, error: "Choose open sign-up or invite only." };
}
