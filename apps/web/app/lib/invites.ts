/**
 * Invites, as the site shows them: links to an invite, and how each
 * invitation reads in a list.
 * No Workers or React imports, so it can be tested under Node.
 */

/**
 * What the sign-up buttons say: Sign up while anyone may register, and
 * Request access while g1t is in private preview, where /register asks for
 * access instead of making an account.
 */
export function signUpCopy(inviteOnly = false): { primary: string; secondary: string | null } {
  return inviteOnly ? { primary: "Request access", secondary: "Have an invite? Use the link in your invite email." } : { primary: "Sign up", secondary: null };
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
  else if (/^https?:\/\//i.test(text))
    text =
      text
        .replace(/[?#].*$/, "")
        .split("/")
        .filter(Boolean)
        .pop() ?? "";
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

type Previewed = {
  kind: "account" | "workspace";
  invitedBy: { username: string } | null;
  workspace: { name: string } | null;
  repository: { name: string; role: string } | null;
  hasAccount: boolean;
};

/**
 * What an invite's page (/invite/:code) says it is, so nobody mistakes one
 * kind for the other: the headline, in three parts with the place between
 * (shown in bold), and the line under it. "@syntaqx invited you to g1t" is
 * an account and no workspace; "@syntaqx invited you to join Flagon, Inc.
 * on g1t" is a workspace invitation, which also makes the account of
 * someone who has none.
 */
export function invitePageCopy(invite: Previewed, signedIn: boolean): { before: string; place: string | null; after: string; about: string } {
  const from = invite.invitedBy ? `@${invite.invitedBy.username}` : "The g1t team";
  const signingUp = !signedIn && !invite.hasAccount && invite.kind === "account";
  const g1t = "g1t is where a team and the coding agents it already uses ship code";
  if (invite.workspace) {
    const name = invite.workspace.name;
    return {
      before: `${from} invited you to join `,
      place: name,
      after: " on g1t",
      about: `This is an invitation to join ${name}, which you accept or decline. ${
        signingUp ? `You do not have a g1t account yet, so it also lets you make one: make it below, then join ${name}.` : `Accepting joins you to ${name}.`
      }`,
    };
  }
  if (invite.repository) {
    return {
      before: `${from} invited you to collaborate on `,
      place: invite.repository.name,
      after: "",
      about: `${g1t}. ${signingUp ? "Make your account below and you get" : "Accepting gives you"} the ${invite.repository.role} role on ${invite.repository.name}.`,
    };
  }
  return {
    before: `${from} invited you to g1t`,
    place: null,
    after: "",
    about: `${g1t}: repositories, pull requests and checks that hold, a merge queue and deployments, with chat for the team. Sign up from this invite and your address is filled in for you. It does not add you to anyone's workspace: your account starts with a workspace of its own.`,
  };
}

/** What inviting someone came to (lib/member-invitations.server.ts): who was invited, or why not. */
export type InviteResult = { invited: string } | { error: string };

/** What revoking or resending an invitation came to. */
export type InvitationResult = { done: "revoked" | "resent"; id: string } | { error: string; id: string };

/**
 * The Invitations page's filters: every invitation, or the ones in one
 * state. Pending gathers the three states an invitation waits in (to be
 * used, for the new account to confirm its address, for the person's
 * answer); Accepted is the ones that joined. g1t does not record an email
 * that could not be delivered, so an invitation nobody used shows as
 * Expired once its 30 days are up; there is no Failed filter until it does.
 */
export type InvitationFilter = "all" | "pending" | "accepted" | "declined" | "expired" | "revoked";

export const INVITATION_FILTERS: readonly { key: InvitationFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "accepted", label: "Accepted" },
  { key: "declined", label: "Declined" },
  { key: "expired", label: "Expired" },
  { key: "revoked", label: "Revoked" },
];

/** The filter an invitation's state falls under. */
export function invitationFilterOf(status: Listed["status"]): Exclude<InvitationFilter, "all"> {
  switch (status) {
    case "pending":
    case "awaiting_confirmation":
    case "awaiting_answer":
      return "pending";
    case "redeemed":
      return "accepted";
    case "declined":
      return "declined";
    case "expired":
      return "expired";
    case "revoked":
      return "revoked";
  }
}

/** The filter `?state=` names; All for anything else. */
export function invitationFilter(raw: string | null | undefined): InvitationFilter {
  return INVITATION_FILTERS.some((filter) => filter.key === raw) ? (raw as InvitationFilter) : "all";
}

/** The invitations under `filter`. */
export function filterInvitations<T extends Pick<Listed, "status">>(invites: readonly T[], filter: InvitationFilter): T[] {
  if (filter === "all") return [...invites];
  return invites.filter((invite) => invitationFilterOf(invite.status) === filter);
}

/** How many invitations each filter holds, for the counts on the chips. */
export function invitationCounts(invites: readonly Pick<Listed, "status">[]): Record<InvitationFilter, number> {
  const counts: Record<InvitationFilter, number> = { all: invites.length, pending: 0, accepted: 0, declined: 0, expired: 0, revoked: 0 };
  for (const invite of invites) counts[invitationFilterOf(invite.status)] += 1;
  return counts;
}

/** The tone of an invitation's status badge, from how its state reads. */
export function invitationTone(status: Listed["status"]): "neutral" | "success" | "warn" | "danger" {
  switch (invitationFilterOf(status)) {
    case "pending":
      return "warn";
    case "accepted":
      return "success";
    case "declined":
    case "revoked":
      return "danger";
    default:
      return "neutral";
  }
}

/** Who an invite is for, in a list. */
export function inviteFor(invite: Listed): string {
  return invite.email ?? (invite.invitee ? `@${invite.invitee}` : "Anyone with the link");
}

/**
 * Which of the two invites a listed one is, in words: an invite to g1t
 * (an account, and no workspace), or an invitation to join a workspace.
 */
export function inviteKind(invite: { workspace: string | null }): { kind: "g1t" | "workspace"; label: string } {
  return invite.workspace ? { kind: "workspace", label: `Invite to join ${invite.workspace}` } : { kind: "g1t", label: "Invite to g1t" };
}

// --- Invite a friend ----------------------------------------------------------
//
// Settings → Invites to g1t (`/settings/invites`): any person invites a friend
// to g1t by email. Anyone can sign up without one; the invite is a note from
// someone they know, with a link that opens sign-up with their address filled
// in and confirmed. Twenty each, for good: a revoked or expired one that was
// never used comes back.

/** The words for Invite a friend. Never says sign-up is held or needs an invite. */
export const G1T_INVITES = {
  /** Its name in the settings menu. */
  nav: "Invites to g1t",
  /** The page's heading. */
  heading: "Invite friends to g1t",
  about:
    "Anyone can sign up for g1t. An invite is a note from you: your friend gets an email with a link that opens sign-up with their address filled in and confirmed, and you see when they join.",
  /** The account menu's entry and the page's button. */
  action: "Invite a friend",
  /** The dialog's description. */
  dialog: "They get an email from you with a link to sign up. Their account starts with a workspace of its own, and the invite works for 30 days.",
  /** Under the count. */
  comesBack: "A revoked invite that was never used comes back to you.",
  /** The off-by-default box that also invites the person to a workspace. */
  alsoJoin: "Also invite them to a workspace",
  alsoJoinHint: "Once their account is made, they get an invitation to the workspace to accept or decline. Left off, the invite is to g1t only.",
  /** When none are left: on the disabled button. */
  out: "You have used all your invites. Your friends can still sign up at g1t.sh without one.",
  /** When none are left: under the count, which says so already. */
  outNote: "Your friends can still sign up at g1t.sh without one.",
} as const;

type Membership = { slug: string; name?: string | null; role: "owner" | "member" };

/** One workspace an invite to g1t can also invite its person to. */
export type BringInto = { slug: string; name: string };

/**
 * The workspaces Invite a friend can also invite the person to, when "Also
 * invite them to a workspace" is ticked: the ones the viewer owns that are
 * on a paid plan. A free workspace invites no one, so it is not offered, and
 * with none to offer the box is not shown at all.
 */
export function bringIntoChoices(memberships: readonly Membership[], free: readonly string[]): BringInto[] {
  const isFree = new Set(free.map((slug) => slug.toLowerCase()));
  return memberships
    .filter((m) => m.role === "owner" && !isFree.has(m.slug.toLowerCase()))
    .map((m) => ({ slug: m.slug.toLowerCase(), name: m.name?.trim() || m.slug }));
}

/**
 * What the Invite a friend form sends to identity. The workspace goes with
 * it only when "Also invite them to a workspace" (`also_join`) is ticked and
 * it is one of `offered`: unticked, the invite is to g1t alone, whatever
 * else the form held.
 */
export function inviteDraft(
  form: { get(name: string): unknown },
  offered: readonly BringInto[] = [],
): { email: string; message: string | null; join?: string; joinRole?: "owner" | "member" } {
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value.trim() : "";
  };
  const draft: ReturnType<typeof inviteDraft> = { email: text("email"), message: text("message") || null };
  const join = text("join").toLowerCase();
  if (text("also_join") === "on" && join && offered.some((workspace) => workspace.slug === join)) {
    draft.join = join;
    draft.joinRole = text("join_role") === "owner" ? "owner" : "member";
  }
  return draft;
}

/** How many invites are left, in words: "18 of 20 invites left". */
export function remainingLine(allowance: { limit: number; remaining: number }): string {
  if (allowance.limit === 0) return "Invites to g1t are turned off on this installation";
  if (allowance.remaining === 0) return `You have used all ${allowance.limit} of your invites`;
  return `${allowance.remaining} of ${allowance.limit} invite${allowance.limit === 1 ? "" : "s"} left`;
}

/** The account menu's badge: "18 left", or nothing when the count is not known. */
export function leftBadge(left: number | null | undefined): string | null {
  return left == null ? null : `${left} left`;
}

/** Which of a person's invites to g1t can be revoked, sent again, or copied. */
export function inviteActions(invite: { status: Listed["status"]; code: string | null }): {
  revoke: boolean;
  resend: boolean;
  copy: boolean;
} {
  const pending = invite.status === "pending";
  return {
    revoke: pending || invite.status === "awaiting_confirmation" || invite.status === "awaiting_answer",
    resend: pending,
    copy: pending && invite.code != null,
  };
}

/** The words for a workspace's People page, the invitation to join it. */
export function workspaceInviteCopy(name: string): { heading: string; hint: string } {
  return {
    heading: `Invite to ${name}`,
    hint: `Search people on g1t by username or name, or enter an email address. They get an invitation to join ${name}, in their notifications and by email, and join only if they accept. If they do not have a g1t account yet, they sign up from the invitation first.`,
  };
}

/**
 * The Members page's filters, from its query: the role to show (`role=`:
 * owners or members), whether two-factor authentication is on (`2fa=`: on
 * or off; owners only see it), a team by slug (`team=`) and words to
 * search by (`q=`, matched against the username and the name). Anything
 * else is every member.
 */
export type MemberFilters = { role: "all" | "owner" | "member"; twoFactor: "all" | "on" | "off"; team: string | null; query: string };

export function memberFilters(search: URLSearchParams | string): MemberFilters {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const role = params.get("role");
  const twoFactor = params.get("2fa");
  return {
    role: role === "owner" || role === "member" ? role : "all",
    twoFactor: twoFactor === "on" || twoFactor === "off" ? twoFactor : "all",
    team: params.get("team")?.trim().toLowerCase() || null,
    query: params.get("q")?.trim() ?? "",
  };
}

type Listable = {
  username: string;
  name?: string | null;
  role: "owner" | "member";
  two_factor?: boolean | null;
};

/** The members `filters` keep, in the order given. `teams` is each member's teams, by slug. */
export function filterMembers<T extends Listable>(members: readonly T[], filters: MemberFilters, teams: Record<string, { slug: string }[]> = {}): T[] {
  const words = filters.query.toLowerCase().replace(/^@+/, "");
  return members.filter((member) => {
    if (filters.role !== "all" && member.role !== filters.role) return false;
    if (filters.twoFactor !== "all" && member.two_factor !== (filters.twoFactor === "on")) return false;
    if (filters.team && !(teams[member.username] ?? []).some((team) => team.slug.toLowerCase() === filters.team)) return false;
    if (words && !member.username.toLowerCase().includes(words) && !(member.name ?? "").toLowerCase().includes(words)) return false;
    return true;
  });
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
 * A username to offer someone signing up with `email`: its local part,
 * lowercased, with anything a username cannot hold made single hyphens,
 * up to 39. They can type it in any case they like. Empty when nothing
 * usable is left. Identity checks it is free.
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
