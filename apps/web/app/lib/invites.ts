/**
 * Invites, as the site shows them: what sign-up says while g1t is
 * invite-only, links to an invite, and how each invite reads in a list.
 * No Workers or React imports, so it can be tested under Node.
 */

/** Where people ask for more invites: support's mailbox (`CONTACT.support`). */
export const INVITES_CONTACT = "hey@flagon.io";

/** The subject that sorts a request for invites, as the support page lists them. */
export const INVITES_SUBJECT = "[g1t Invites] ";

/** A mail link asking for more invites, for a person or a workspace. */
export function moreInvitesMailto(about?: string): string {
  const subject = `${INVITES_SUBJECT}${about ? `More invites for ${about}` : "More invites"}`;
  return `mailto:${INVITES_CONTACT}?subject=${encodeURIComponent(subject)}`;
}

/** What the sign-up buttons say. While invite-only, nobody can just sign up. */
export function signUpCopy(inviteOnly: boolean): { primary: string; secondary: string | null } {
  return inviteOnly ? { primary: "Request access", secondary: "Have an invite?" } : { primary: "Sign up", secondary: null };
}

/** The /register address that opens on the invite-code field. */
export const HAVE_AN_INVITE = "/register#invite";

/** The address an invite link has. */
export function inviteLink(code: string, origin = "https://g1t.sh"): string {
  return `${origin.replace(/\/+$/, "")}/invite/${code}`;
}

/**
 * An invite code from however someone pasted it: the code, a whole
 * invite link, or a /register?invite= address. Identity reads it again;
 * this only tidies what is put back into a form.
 */
export function cleanCode(raw: string | null | undefined): string {
  let text = (raw ?? "").trim();
  const param = /[?&]invite=([^&#\s]+)/i.exec(text);
  if (param) text = decodeURIComponent(param[1]!);
  else if (/^https?:\/\//i.test(text)) text = text.replace(/[?#].*$/, "").split("/").filter(Boolean).pop() ?? "";
  return text.replace(/\s+/g, "").slice(0, 80);
}

type Listed = {
  status: "pending" | "awaiting_confirmation" | "redeemed" | "expired" | "revoked";
  redeemedBy: string | null;
  email: string | null;
  workspace: string | null;
};

/** How an invite's state reads in a list. */
export function inviteState(invite: Listed): { label: string; tone: "pending" | "done" | "dead" } {
  switch (invite.status) {
    case "pending":
      return { label: "Pending", tone: "pending" };
    case "awaiting_confirmation":
      // The account is made; it joins once it confirms its address.
      return {
        label: invite.redeemedBy ? `@${invite.redeemedBy} is confirming their email` : "Confirming their email",
        tone: "pending",
      };
    case "redeemed":
      return { label: invite.redeemedBy ? `Joined as @${invite.redeemedBy}` : "Used", tone: "done" };
    case "expired":
      return { label: "Expired", tone: "dead" };
    case "revoked":
      return { label: "Revoked", tone: "dead" };
  }
}

/** Who an invite is for, in a list. */
export function inviteFor(invite: Listed): string {
  const who = invite.email ?? "Anyone with the link";
  return invite.workspace ? `${who} · joins ${invite.workspace}` : who;
}

/** How many invites are left, in words. */
export function remainingLine(allowance: { limit: number | null; used: number; remaining: number | null }): string {
  if (allowance.limit == null) return "No limit on your invites";
  const left = allowance.remaining ?? 0;
  if (left === 0) return `You have used all ${allowance.limit} of your invites`;
  return `${left} of ${allowance.limit} invite${allowance.limit === 1 ? "" : "s"} left`;
}

/**
 * Whether a sign-up or access form was filled in by a bot: the hidden
 * `website` field people never see, or a form sent back faster than a
 * person types.
 */
export function looksAutomated(form: { get(name: string): unknown }, now = Date.now()): boolean {
  const trap = form.get("website");
  if (typeof trap === "string" && trap.trim() !== "") return true;
  const started = Number(form.get("started"));
  return Number.isFinite(started) && started > 0 && now - started < 1500;
}

/**
 * A username to offer someone signing up with `email`: its local part, as
 * usernames are written (lowercase letters, digits and single hyphens, up
 * to 39). Empty when nothing usable is left. Identity checks it is free.
 */
export function suggestUsername(email: string | null | undefined): string {
  const local = (email ?? "").split("@")[0]?.split("+")[0] ?? "";
  return local
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 39)
    .replace(/-+$/g, "");
}

type Lands = { workspace: { slug: string } | null; repository: { name: string } | null };

/**
 * Where using an invite lands: the workspace it joins, the repository it
 * gives access to, or nowhere in particular.
 */
export function landingFor(invite: Lands): string | null {
  if (invite.workspace) return invite.workspace.slug.toLowerCase();
  if (invite.repository) return invite.repository.name.toLowerCase();
  return null;
}

/** What someone who just joined is welcomed into, for one page view. */
export const WELCOME_COOKIE = "g1t_welcome";

const TARGET = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9._-]+)?$/;

/** The `Set-Cookie` value that welcomes the next view of `target` (a slug or `workspace/repo`). */
export function welcomeCookie(target: string, secure: boolean): string {
  return `${WELCOME_COOKIE}=${encodeURIComponent(target.toLowerCase())}; Path=/; Max-Age=300; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** The `Set-Cookie` value that ends the welcome, once it has been shown. */
export function clearWelcome(secure: boolean): string {
  return `${WELCOME_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** Whether the request's cookies welcome someone into `target`. */
export function welcomes(cookieHeader: string | null, target: string): boolean {
  for (const part of (cookieHeader ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key !== WELCOME_COOKIE) continue;
    let value: string;
    try {
      value = decodeURIComponent(rest.join("="));
    } catch {
      return false;
    }
    return TARGET.test(value) && value === target.toLowerCase();
  }
  return false;
}
