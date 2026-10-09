import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ACCOUNT_SETTINGS } from "./account-settings.ts";
import { CONTACT } from "./legal.ts";
import {
  G1T_INVITES,
  HAVE_AN_INVITE,
  bringIntoChoices,
  inviteDraft,
  inviteKind,
  invitePageCopy,
  invitesPage,
  peoplePages,
  workspaceInviteCopy,
  INVITES_CONTACT,
  cleanCode,
  cleanProof,
  invitePath,
  inviteSignUpCopy,
  inviteFor,
  inviteLink,
  inviteState,
  landingFor,
  looksAutomated,
  moreInvitesMailto,
  remainingLine,
  sharedDomainsHint,
  sharedInviteLine,
  sharedInviteLink,
  signUpCopy,
  suggestUsername,
  welcomeCookie,
  clearWelcome,
  welcomes,
} from "./invites.ts";

const CODE = "g1t-k7m2-q9xd-4hpw-abcd-0123-4567-89ef-ghjk";

test("while invite-only, nobody is offered a plain sign-up", () => {
  // Sign up everywhere; only the sign-up page says registration takes an invite.
  assert.deepEqual(signUpCopy(), { primary: "Sign up", secondary: null });
  assert.equal(HAVE_AN_INVITE, "/register#invite");
});

test("asking for more invites goes to support with the [g1t Invites] subject", () => {
  assert.equal(INVITES_CONTACT, CONTACT.support);
  assert.equal(moreInvitesMailto(), "mailto:hey@flagon.io?subject=%5Bg1t%20Invites%5D%20More%20invites");
  assert.equal(
    moreInvitesMailto("acme"),
    "mailto:hey@flagon.io?subject=%5Bg1t%20Invites%5D%20More%20invites%20for%20acme",
  );
});

test("an invite link is on g1t.sh unless told otherwise", () => {
  assert.equal(inviteLink(CODE), `https://g1t.sh/invite/${CODE}`);
  assert.equal(inviteLink(CODE, "http://localhost:8787/"), `http://localhost:8787/invite/${CODE}`);
});

const PROOF = "4f9c2a7e0b13d5c84f9c2a7e0b13d5c84f9c2a7e0b13d5c84f9c2a7e0b13d5c8";

test("an invite email's proof is kept only when it looks like one, and goes along to the invite's page", () => {
  assert.equal(cleanProof(PROOF), PROOF);
  assert.equal(cleanProof(` ${PROOF.toUpperCase()} `), PROOF);
  assert.equal(cleanProof("not-a-proof"), null);
  assert.equal(cleanProof("abc"), null);
  assert.equal(cleanProof("a".repeat(500)), null);
  assert.equal(cleanProof(null), null);
  assert.equal(invitePath(CODE, PROOF), `/invite/${CODE}?proof=${PROOF}`);
  assert.equal(invitePath(CODE, null), `/invite/${CODE}`);
  assert.equal(invitePath(CODE), `/invite/${CODE}`);
});

test("signing up from the invite email says the address is confirmed already; otherwise the code step applies", () => {
  const base = { address: "ada@example.com", emailProven: false, workspace: { name: "Flagon, Inc." }, repository: null };
  const proven = inviteSignUpCopy({ ...base, emailProven: true });
  assert.equal(proven.intro, "You can join Flagon, Inc. as soon as you create it: accept the invitation then.");
  assert.match(proven.confirmed ?? "", /^ada@example\.com is confirmed: you came here from the invite we emailed to it/);
  assert.match(proven.hint, /confirmed already/);
  assert.doesNotMatch(proven.hint, /code/);

  // No proof (a code typed in, or a link passed on): nothing new is said.
  const plain = inviteSignUpCopy(base);
  assert.equal(plain.intro, "You can join Flagon, Inc. as soon as you confirm your email: accept the invitation then.");
  assert.equal(plain.confirmed, null);
  assert.equal(plain.hint, "Your invite was sent here. We email it a code to confirm it before you start.");

  // An invite for anyone with the code has no address to prove.
  const open = inviteSignUpCopy({ ...base, address: null, emailProven: true, workspace: null });
  assert.equal(open.confirmed, null);
  assert.equal(open.intro, "It takes a minute.");
  assert.equal(open.hint, "We email it a code to confirm it before you start.");

  const repo = inviteSignUpCopy({ ...base, workspace: null, repository: { name: "flagon-io/g1t" }, emailProven: true });
  assert.equal(repo.intro, "You get flagon-io/g1t as soon as you create it.");
});

test("a pasted link or code is tidied to the code", () => {
  assert.equal(cleanCode(CODE), CODE);
  assert.equal(cleanCode(`  ${CODE}  `), CODE);
  assert.equal(cleanCode(`https://g1t.sh/invite/${CODE}`), CODE);
  assert.equal(cleanCode(`https://g1t.sh/register?invite=${CODE}&next=%2F`), CODE);
  assert.equal(cleanCode("g1t-k7m2 q9xd"), "g1t-k7m2q9xd");
  assert.equal(cleanCode(null), "");
  assert.equal(cleanCode("x".repeat(500)).length, 80);
});

test("each invite says where it stands and whom it is for", () => {
  const base = { redeemedBy: null, email: null, workspace: null };
  assert.deepEqual(inviteState({ ...base, status: "pending" }), { label: "Pending", tone: "pending" });
  assert.deepEqual(inviteState({ ...base, status: "redeemed", redeemedBy: "ada" }), { label: "Joined as @ada", tone: "done" });
  assert.deepEqual(inviteState({ ...base, status: "awaiting_confirmation", redeemedBy: "ada" }), {
    label: "@ada is confirming their email",
    tone: "pending",
  });
  assert.deepEqual(inviteState({ ...base, status: "expired" }), { label: "Expired", tone: "dead" });
  assert.deepEqual(inviteState({ ...base, status: "revoked" }), { label: "Revoked", tone: "dead" });
  assert.equal(inviteFor({ ...base, status: "pending" }), "Anyone with the link");
  assert.equal(inviteFor({ ...base, status: "pending", email: "ada@example.com", workspace: "acme" }), "ada@example.com");
  assert.equal(inviteFor({ ...base, status: "pending", invitee: "daweazl", workspace: "flagon-io" }), "@daweazl");
  // Which kind each is, beside whom it is for.
  assert.deepEqual(inviteKind({ workspace: null }), { kind: "g1t", label: "Invite to g1t" });
  assert.deepEqual(inviteKind({ workspace: "flagon-io" }), { kind: "workspace", label: "Invite to join flagon-io" });
  assert.deepEqual(inviteState({ ...base, status: "awaiting_answer", redeemedBy: "daweazl" }), { label: "Waiting for @daweazl to accept", tone: "pending" });
  assert.deepEqual(inviteState({ ...base, status: "declined", invitee: "daweazl" }), { label: "@daweazl declined", tone: "dead" });
});

test("what is left reads plainly", () => {
  assert.equal(remainingLine({ limit: 5, used: 2, remaining: 3 }), "3 of 5 invites left");
  assert.equal(remainingLine({ limit: 1, used: 0, remaining: 1 }), "1 of 1 invite left");
  assert.equal(remainingLine({ limit: 5, used: 5, remaining: 0 }), "You have used all 5 of your invites");
  assert.equal(remainingLine({ limit: null, used: 40, remaining: null }), "No limit on your invites");
});

test("bots that fill the hidden field or answer instantly are turned away", () => {
  const form = (fields: Record<string, string>) => ({ get: (name: string) => fields[name] ?? null });
  const now = 1_000_000;
  assert.equal(looksAutomated(form({ website: "http://spam.example" }), now), true);
  assert.equal(looksAutomated(form({ started: String(now - 200) }), now), true);
  assert.equal(looksAutomated(form({ started: String(now - 10_000) }), now), false);
  assert.equal(looksAutomated(form({}), now), false);
  assert.equal(looksAutomated(form({ website: "  " }), now), false);
});

test("a username is suggested from the invited address", () => {
  assert.equal(suggestUsername("ada.lovelace@example.com"), "ada-lovelace");
  assert.equal(suggestUsername("Margaret_Hamilton+g1t@example.com"), "margaret-hamilton");
  assert.equal(suggestUsername("--x--@example.com"), "x");
  assert.equal(suggestUsername(`${"a".repeat(38)}.b@example.com`), "a".repeat(38));
  assert.equal(suggestUsername("...@example.com"), "");
  assert.equal(suggestUsername(null), "");
});

test("an invite lands in its workspace, else its repository", () => {
  assert.equal(landingFor({ workspace: { slug: "Flagon-IO" }, repository: null }), "flagon-io");
  assert.equal(landingFor({ workspace: null, repository: { name: "flagon-io/g1t" } }), "flagon-io/g1t");
  assert.equal(landingFor({ workspace: null, repository: null }), null);
});

test("the welcome is for one place, and ends", () => {
  const set = welcomeCookie("flagon-io/g1t", true);
  assert.match(set, /^g1t_welcome=flagon-io%2Fg1t; Path=\/; Max-Age=300; HttpOnly; SameSite=Lax; Secure$/);
  const header = `a=1; ${set.split(";")[0]}; b=2`;
  assert.equal(welcomes(header, "flagon-io/g1t"), true);
  assert.equal(welcomes(header, "flagon-io"), false);
  assert.equal(welcomes("g1t_welcome=flagon-io", "Flagon-IO"), true);
  assert.equal(welcomes("g1t_welcome=%E0%A4%A", "flagon-io"), false);
  assert.equal(welcomes("g1t_welcome=..%2F..%2Fx", "../../x"), false);
  assert.equal(welcomes(null, "flagon-io"), false);
  assert.match(clearWelcome(false), /^g1t_welcome=; Path=\/; Max-Age=0; HttpOnly; SameSite=Lax$/);
});

test("a shared invite link names its group above the sign-up form", () => {
  assert.equal(sharedInviteLine("Cloudflare judges"), "Invited as part of Cloudflare judges");
  assert.equal(sharedInviteLine("  Hacker News readers "), "Invited as part of Hacker News readers");
  // A one-person invite has no group, and says nothing of the kind.
  assert.equal(sharedInviteLine(null), null);
  assert.equal(sharedInviteLine(undefined), null);
  assert.equal(sharedInviteLine("   "), null);
});

test("a shared invite link is sign-up with its code filled in", () => {
  assert.equal(sharedInviteLink(CODE), `https://g1t.sh/register?invite=${CODE}`);
  assert.equal(sharedInviteLink(CODE, "http://localhost:5173/"), `http://localhost:5173/register?invite=${CODE}`);
  // The register page reads the code back out of its own link.
  assert.equal(cleanCode(sharedInviteLink(CODE)), CODE);
});

test("a shared link limited to domains says which, on the email field", () => {
  assert.equal(sharedDomainsHint([]), undefined);
  assert.equal(sharedDomainsHint(null), undefined);
  assert.equal(sharedDomainsHint(["cloudflare.com"]), "This invite is for addresses at cloudflare.com. Use yours there.");
  assert.equal(
    sharedDomainsHint(["a.com", "b.com", "c.com"]),
    "This invite is for addresses at a.com, b.com or c.com. Use yours there.",
  );
});

test("an invite to g1t can also invite its person to a workspace you own that can add people, never chosen for you", () => {
  const memberships = [
    { slug: "flagon-io", name: "Flagon, Inc.", role: "owner" as const },
    { slug: "side", name: "side", role: "owner" as const },
    { slug: "friends", name: "Friends", role: "member" as const },
  ];
  // Free ones and ones you only belong to are not offered; nothing is chosen, not even the current one.
  const here = bringIntoChoices(memberships, ["side"], "flagon-io");
  assert.deepEqual(here, { options: [{ slug: "flagon-io", name: "Flagon, Inc." }], note: null });
  assert.equal("chosen" in here, false);
  // In a free workspace: not offered, and the form says why.
  assert.match(bringIntoChoices(memberships, ["side"], "side").note ?? "", /side is on the free plan, so it cannot add people/);
  // In one you are only a member of.
  assert.match(bringIntoChoices(memberships, [], "friends").note ?? "", /Only the owners of friends/);
  assert.deepEqual(bringIntoChoices([], [], null), { options: [], note: null });
});

/** A submitted form, as `inviteDraft` reads it. */
const form = (fields: Record<string, string>) => ({ get: (name: string) => fields[name] ?? null });

test("an invite to g1t sends no workspace unless its box is ticked", () => {
  // Off by default: a form without the box sends no `join`, even with a workspace left in it.
  assert.deepEqual(inviteDraft(form({ intent: "create-invite", email: " ada@example.com ", charge: "mine" })), {
    email: "ada@example.com",
    workspace: null,
  });
  const untickedButFilled = inviteDraft(form({ email: "", join: "flagon-io", join_role: "owner" }));
  assert.equal("join" in untickedButFilled, false);
  assert.equal("joinRole" in untickedButFilled, false);
  assert.equal(untickedButFilled.email, null);
  // Ticked: the workspace and its role go with it.
  assert.deepEqual(inviteDraft(form({ also_join: "on", join: "flagon-io", join_role: "owner", charge: "flagon-io" })), {
    email: null,
    workspace: "flagon-io",
    join: "flagon-io",
    joinRole: "owner",
  });
  // Ticked with no workspace chosen: still none. Any role but owner is member.
  assert.equal("join" in inviteDraft(form({ also_join: "on", join: "" })), false);
  assert.equal(inviteDraft(form({ also_join: "on", join: "acme", join_role: "admin" })).joinRole, "member");
});

test("the invites form keeps the workspace behind an unticked box", () => {
  const section = readFileSync(new URL("../components/invites-section.tsx", import.meta.url), "utf8");
  assert.match(section, /useState\(false\)/);
  assert.match(section, /name="also_join"/);
  // The workspace and role fields are drawn only once the box is ticked, so nothing else is sent.
  assert.match(section, /\{alsoJoin && \(\s*<div[^]*?name="join"[^]*?name="join_role"/);
  assert.match(section, /<option value="" disabled>\s*Choose a workspace/);
  assert.doesNotMatch(section, /bringInto\.chosen|Bring them into/);
});

test("invites to g1t are made only while sign-up takes one; after that only the list stays", () => {
  assert.deepEqual(invitesPage("invite", 0), { form: true, listed: true });
  assert.deepEqual(invitesPage(null, 0), { form: true, listed: true });
  // Open: no form; the menus list the page only with invites to look back on.
  assert.deepEqual(invitesPage("open", 0), { form: false, listed: false });
  assert.deepEqual(invitesPage("open", 3), { form: false, listed: true });
  assert.match(G1T_INVITES.open, /^Anyone can sign up for g1t now/);
  assert.match(G1T_INVITES.open, /workspace's People page/);
});

test("the two invites say which they are", () => {
  // Settings → Invites: an account, and no workspace.
  assert.equal(G1T_INVITES.heading, "Invite people to g1t");
  assert.equal(ACCOUNT_SETTINGS.invites.heading, G1T_INVITES.heading);
  assert.equal(ACCOUNT_SETTINGS.invites.title, G1T_INVITES.nav);
  assert.equal(ACCOUNT_SETTINGS.invites.about, G1T_INVITES.about);
  assert.match(G1T_INVITES.about, /lets one person make an account\. It does not add them to any workspace/);
  assert.equal(G1T_INVITES.alsoJoin, "Also invite them to a workspace");
  // A workspace's People page: an invitation to accept or decline, which signs up whoever has no account.
  const closed = workspaceInviteCopy("Flagon, Inc.", true);
  assert.equal(closed.heading, "Invite to Flagon, Inc.");
  assert.match(closed.hint, /invitation to join Flagon, Inc\..*join only if they accept/);
  assert.match(closed.hint, /If they do not have a g1t account yet, the invitation also lets them sign up/);
  assert.equal(closed.elsewhere, "To invite someone to g1t without adding them to Flagon, Inc., use Settings → Invites.");
  // Once anyone can sign up, there is no invite to g1t to point to.
  const open = workspaceInviteCopy("Flagon, Inc.", false);
  assert.equal(open.elsewhere, null);
  assert.doesNotMatch(open.hint, /one of yours/);
  // Settings → Invites points to the People pages of the workspaces you own, the current one first.
  assert.deepEqual(
    peoplePages(
      [
        { slug: "side", name: null, role: "owner" },
        { slug: "Flagon-io", name: "Flagon, Inc.", role: "owner" },
        { slug: "friends", name: "Friends", role: "member" },
      ],
      "flagon-io",
    ),
    [
      { slug: "flagon-io", name: "Flagon, Inc.", to: "/flagon-io/-/people" },
      { slug: "side", name: "side", to: "/side/-/people" },
    ],
  );
});

test("an invite's page names the invite it is", () => {
  const base = { kind: "account" as const, invitedBy: { username: "syntaqx" }, workspace: null, repository: null, hasAccount: false };
  const g1t = invitePageCopy(base, false);
  assert.equal(`${g1t.before}${g1t.place ?? ""}${g1t.after}`, "@syntaqx invited you to g1t");
  assert.match(g1t.about, /lets you make an account\. It does not add you to anyone's workspace/);
  const join = invitePageCopy({ ...base, workspace: { name: "Flagon, Inc." } }, false);
  assert.equal(`${join.before}${join.place}${join.after}`, "@syntaqx invited you to join Flagon, Inc. on g1t");
  assert.equal(join.place, "Flagon, Inc.");
  assert.match(join.about, /invitation to join Flagon, Inc\., which you accept or decline/);
  assert.match(join.about, /You do not have a g1t account yet, so it also lets you make one/);
  // Someone with an account, or signed in, just accepts.
  assert.match(invitePageCopy({ ...base, kind: "workspace", workspace: { name: "Flagon, Inc." }, hasAccount: true }, false).about, /Accepting joins you to Flagon, Inc\./);
  assert.equal(invitePageCopy({ ...base, invitedBy: null }, false).before, "The g1t team invited you to g1t");
});
