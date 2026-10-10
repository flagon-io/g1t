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
export function invitePageCopy(
  invite: Previewed,
  signedIn: boolean,
): { before: string; place: string | null; after: string; about: string } {
  const from = invite.invitedBy ? `@${invite.invitedBy.username}` : "The g1t team";
  const signingUp = !signedIn && !invite.hasAccount && invite.kind === "account";
  const g1t = "g1t is one workspace where a team and its agents talk, work and ship";
  if (invite.workspace) {
    const name = invite.workspace.name;
    return {
      before: `${from} invited you to join `,
      place: name,
      after: " on g1t",
      about: `This is an invitation to join ${name}, which you accept or decline. ${
        signingUp
          ? `You do not have a g1t account yet, so it also lets you make one: make it below, then join ${name}.`
          : `Accepting joins you to ${name}.`
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
    about: `${g1t}: chat with people and agents, give agents a job and a budget, and land code through checks that hold. This invite lets you make an account. It does not add you to anyone's workspace: your account starts with a workspace of its own.`,
  };
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
  return invite.workspace
    ? { kind: "workspace", label: `Invite to join ${invite.workspace}` }
    : { kind: "g1t", label: "Invite to g1t" };
}

type Membership = { slug: string; name?: string | null; role: "owner" | "member" };

/** One workspace an own invite can also invite its person to. */
export type BringInto = { slug: string; name: string };

/**
 * The workspaces Settings → Invites can also invite the person to, when
 * "Also invite them to a workspace" is ticked: the ones the viewer owns
 * that are not on the free plan, which adds no one. None is chosen for
 * them: the box is off at first, and the list starts on "Choose a
 * workspace". `note` says why the viewer's current workspace is missing.
 */
export function bringIntoChoices(
  memberships: Membership[],
  free: string[],
  current: string | null | undefined,
): { options: BringInto[]; note: string | null } {
  const isFree = new Set(free.map((slug) => slug.toLowerCase()));
  const options = memberships
    .filter((m) => m.role === "owner" && !isFree.has(m.slug.toLowerCase()))
    .map((m) => ({ slug: m.slug.toLowerCase(), name: m.name?.trim() || m.slug }));
  const here = current?.trim().toLowerCase() || null;
  let note: string | null = null;
  const membership = here ? memberships.find((m) => m.slug.toLowerCase() === here) : undefined;
  if (membership && !options.some((option) => option.slug === here)) {
    note =
      membership.role !== "owner"
        ? `Only the owners of ${membership.slug} can invite people to it.`
        : `${membership.slug} is on the free plan, so it cannot add people. Start the plan to invite people to it.`;
  }
  return { options, note };
}

/**
 * What the Settings → Invites form sends to identity. The workspace goes
 * with it only when "Also invite them to a workspace" (`also_join`) is
 * ticked: unticked, the invite is to g1t alone, whatever else the form held.
 */
export function inviteDraft(form: { get(name: string): unknown }): {
  email: string | null;
  workspace: string | null;
  join?: string;
  joinRole?: "owner" | "member";
} {
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value.trim() : "";
  };
  const charge = text("charge");
  const draft: ReturnType<typeof inviteDraft> = {
    email: text("email") || null,
    workspace: charge && charge !== "mine" ? charge : null,
  };
  const join = text("join");
  if (text("also_join") === "on" && join) {
    draft.join = join;
    draft.joinRole = text("join_role") === "owner" ? "owner" : "member";
  }
  return draft;
}

/**
 * What Settings → Invites shows. Invites to g1t exist only while sign-up
 * takes one: then the page has the form. Once anyone can sign up, it
 * keeps only the list of invites already made, and the settings menu
 * lists the page only when there are some.
 */
export function invitesPage(mode: "invite" | "open" | null | undefined, made: number): { form: boolean; listed: boolean } {
  const inviteOnly = mode !== "open";
  return { form: inviteOnly, listed: inviteOnly || made > 0 };
}

/** The words for Settings → Invites, the invite to g1t. */
export const G1T_INVITES = {
  /** The page's heading. */
  heading: "Invite people to g1t",
  /** Its name in the settings menu and the account menu. */
  nav: "Invites to g1t",
  about:
    "An invite to g1t lets one person make an account. It does not add them to any workspace: their account starts with a workspace of its own.",
  /** In place of the form once anyone can sign up. */
  open: "Anyone can sign up for g1t now, so there are no invites to make here. Invitations to a workspace live on each workspace's People page.",
  /** The off-by-default box that also invites the person to a workspace. */
  alsoJoin: "Also invite them to a workspace",
  alsoJoinHint:
    "Once their account is made, they get an invitation to the workspace to accept or decline. Left off, the invite is to g1t only.",
  /** Where the other kind of invite lives. */
  elsewhere: "To bring someone into a workspace, invite them from that workspace's People page",
} as const;

/**
 * The words for a workspace's People page, the invitation to join it.
 * `inviteOnly` says whether sign-up takes an invite: then an invitation to
 * an address with no account also lets it make one (and costs an invite),
 * and the page points to Settings → Invites for an invite to g1t alone.
 */
export function workspaceInviteCopy(name: string, inviteOnly: boolean): { heading: string; hint: string; elsewhere: string | null } {
  const base = `Search people on g1t by username or name, or enter an email address. They get an invitation to join ${name}, in their notifications and by email, and join only if they accept.`;
  return {
    heading: `Invite to ${name}`,
    hint: inviteOnly
      ? `${base} If they do not have a g1t account yet, the invitation also lets them sign up; that uses one of ${name}'s shared invites, or else one of yours.`
      : `${base} If they do not have a g1t account yet, they sign up from the invitation first.`,
    elsewhere: inviteOnly ? `To invite someone to g1t without adding them to ${name}, use Settings → Invites.` : null,
  };
}

/**
 * The People pages Settings → Invites points to for a workspace
 * invitation: the workspaces the viewer owns (only owners invite), the
 * current one first.
 */
export function peoplePages(memberships: Membership[], current: string | null | undefined): { slug: string; name: string; to: string }[] {
  const here = current?.trim().toLowerCase() || null;
  return memberships
    .filter((m) => m.role === "owner")
    .map((m) => ({ slug: m.slug.toLowerCase(), name: m.name?.trim() || m.slug, to: `/${m.slug.toLowerCase()}/-/people` }))
    .sort((a, b) => Number(b.slug === here) - Number(a.slug === here));
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
