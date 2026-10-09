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

/**
 * What the sign-up buttons say: Sign up, whether or not registration is
 * invite-only. Only the sign-up page itself says how to get in (an invite,
 * or a request for one), so nothing else reads as a waiting room.
 */
export function signUpCopy(): { primary: string; secondary: string | null } {
  return { primary: "Sign up", secondary: null };
}

/** The /register address that opens on the invite-code field. */
export const HAVE_AN_INVITE = "/register#invite";

/** The address a shared invite link has: sign-up, with its code filled in. */
export function sharedInviteLink(code: string, origin = "https://g1t.sh"): string {
  return `${origin.replace(/\/+$/, "")}/register?invite=${encodeURIComponent(code)}`;
}

/** What sign-up says above the form for a shared invite link's group. Null for a one-person invite. */
export function sharedInviteLine(label: string | null | undefined): string | null {
  const group = (label ?? "").trim();
  return group ? `Invited as part of ${group}` : null;
}

/** The email field's hint for a shared invite link limited to some domains. */
export function sharedDomainsHint(domains: string[] | null | undefined): string | undefined {
  const list = (domains ?? []).filter(Boolean);
  if (list.length === 0) return undefined;
  const named = list.length === 1 ? list[0] : `${list.slice(0, -1).join(", ")} or ${list.at(-1)}`;
  return `This invite is for addresses at ${named}. Use yours there.`;
}

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

/**
 * The `proof` an invite email's link carries, tidied: hex, or null for
 * anything else. Identity decides whether it is the invite's own; this only
 * keeps junk out of what is passed on and put back into a form.
 */
export function cleanProof(raw: string | null | undefined): string | null {
  const text = (raw ?? "").trim().toLowerCase();
  return /^[0-9a-f]{16,128}$/.test(text) ? text : null;
}

/** An invite's page, keeping the email's proof when there is one. */
export function invitePath(code: string, proof?: string | null): string {
  const path = `/invite/${encodeURIComponent(code)}`;
  return proof ? `${path}?proof=${encodeURIComponent(proof)}` : path;
}

type Proven = {
  /** The bound address in full, or null for an invite to anyone with the code. */
  address: string | null;
  emailProven: boolean;
  workspace: { name: string } | null;
  repository: { name: string } | null;
};

/**
 * What signing up on an invite's page says about the email address. Opened
 * from the invite's own email (`emailProven`), the address is confirmed
 * already, so there is no code to enter; otherwise the address is confirmed
 * after sign-up, as it always is.
 */
export function inviteSignUpCopy(invite: Proven): {
  /** Under "Create your account". */
  intro: string;
  /** Under the email field. */
  hint: string;
  /** Said plainly above the form when the address is confirmed already; null otherwise. */
  confirmed: string | null;
} {
  const proven = invite.emailProven && invite.address !== null;
  const when = proven ? "as soon as you create it" : "as soon as you confirm your email";
  // A workspace is never joined without saying yes: the new account accepts its invitation.
  const intro = invite.workspace
    ? `You can join ${invite.workspace.name} ${when}: accept the invitation then.`
    : invite.repository
      ? `You get ${invite.repository.name} ${when}.`
      : "It takes a minute.";
  if (proven) {
    return {
      intro,
      hint: "Your invite was sent here, and you opened it from that email, so this address is confirmed already.",
      confirmed: `${invite.address} is confirmed: you came here from the invite we emailed to it, so there is no code to enter after you sign up.`,
    };
  }
  return {
    intro,
    hint: invite.address
      ? "Your invite was sent here. We email it a code to confirm it before you start."
      : "We email it a code to confirm it before you start.",
    confirmed: null,
  };
}

type Listed = {
  status: "pending" | "awaiting_confirmation" | "awaiting_answer" | "redeemed" | "declined" | "expired" | "revoked";
  redeemedBy: string | null;
  email: string | null;
  workspace: string | null;
  /** The account a workspace invitation is for, by username. */
  invitee?: string | null;
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
    case "awaiting_answer": {
      // The account is made and confirmed; the workspace waits for its yes or no.
      const who = invite.redeemedBy ?? invite.invitee;
      return { label: who ? `Waiting for @${who} to accept` : "Waiting for an answer", tone: "pending" };
    }
    case "redeemed":
      return { label: invite.redeemedBy ? `Joined as @${invite.redeemedBy}` : "Used", tone: "done" };
    case "declined":
      return { label: invite.invitee ? `@${invite.invitee} declined` : "Declined", tone: "dead" };
    case "expired":
      return { label: "Expired", tone: "dead" };
    case "revoked":
      return { label: "Revoked", tone: "dead" };
  }
}

/** Who an invite is for, in a list. */
export function inviteFor(invite: Listed): string {
  const who = invite.email ?? (invite.invitee ? `@${invite.invitee}` : "Anyone with the link");
  return invite.workspace ? `${who} · invited to ${invite.workspace}` : who;
}

type Membership = { slug: string; name?: string | null; role: "owner" | "member" };

/** One workspace an own invite can bring its person into. */
export type BringInto = { slug: string; name: string };

/** The value of "No workspace — they'll get their own" in the form. */
export const OWN_WORKSPACE = "";

/**
 * The "Bring them into" choices on Settings → Invites: the workspaces the
 * person may add members to (ones they own that are not on the free plan,
 * which adds no one), and which is chosen at first: the workspace they are
 * in (`current`) when it is one of those, else none (the new account gets
 * a workspace of its own). `note` says why the current one is not offered.
 */
export function bringIntoChoices(
  memberships: Membership[],
  free: string[],
  current: string | null | undefined,
): { options: BringInto[]; chosen: string; note: string | null } {
  const isFree = new Set(free.map((slug) => slug.toLowerCase()));
  const options = memberships
    .filter((m) => m.role === "owner" && !isFree.has(m.slug.toLowerCase()))
    .map((m) => ({ slug: m.slug.toLowerCase(), name: m.name?.trim() || m.slug }));
  const here = current?.trim().toLowerCase() || null;
  const chosen = here && options.some((option) => option.slug === here) ? here : OWN_WORKSPACE;
  let note: string | null = null;
  const membership = here ? memberships.find((m) => m.slug.toLowerCase() === here) : undefined;
  if (membership && !chosen) {
    note =
      membership.role !== "owner"
        ? `Only the owners of ${membership.slug} can bring people into it.`
        : `${membership.slug} is on the free plan, so it cannot add people. Start the plan to bring people into it.`;
  }
  return { options, chosen, note };
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
