import assert from "node:assert/strict";
import { test } from "node:test";

import {
  filterInvitations,
  filterMembers,
  invitationCounts,
  invitationFilter,
  invitationFilterOf,
  invitationTone,
  inviteKind,
  G1T_INVITES,
  bringIntoChoices,
  inviteActions,
  inviteDraft,
  leftBadge,
  remainingLine,
  memberFilters,
  invitePageCopy,
  workspaceInviteCopy,
  cleanCode,
  cleanProof,
  invitePath,
  inviteSignUpCopy,
  inviteFor,
  inviteLink,
  inviteState,
  landingFor,
  looksAutomated,
  signUpCopy,
  suggestUsername,
  welcomeCookie,
  clearWelcome,
  welcomes,
} from "./invites.ts";

const CODE = "g1t-k7m2-q9xd-4hpw-abcd-0123-4567-89ef-ghjk";

test("the Invitations page sorts every state under one filter, and counts them", () => {
  const statuses = ["pending", "awaiting_confirmation", "awaiting_answer", "redeemed", "declined", "expired", "revoked"] as const;
  const invites = statuses.map((status) => ({ status }));
  assert.equal(invitationFilterOf("pending"), "pending");
  assert.equal(invitationFilterOf("awaiting_confirmation"), "pending");
  assert.equal(invitationFilterOf("awaiting_answer"), "pending");
  assert.equal(invitationFilterOf("redeemed"), "accepted");
  assert.equal(invitationFilterOf("declined"), "declined");
  assert.equal(invitationFilterOf("expired"), "expired");
  assert.equal(invitationFilterOf("revoked"), "revoked");
  assert.deepEqual(invitationCounts(invites), { all: 7, pending: 3, accepted: 1, declined: 1, expired: 1, revoked: 1 });
  assert.equal(filterInvitations(invites, "all").length, 7);
  assert.deepEqual(
    filterInvitations(invites, "pending").map((invite) => invite.status),
    ["pending", "awaiting_confirmation", "awaiting_answer"],
  );
  assert.deepEqual(
    filterInvitations(invites, "accepted").map((invite) => invite.status),
    ["redeemed"],
  );
  // The query names a filter, or means All.
  assert.equal(invitationFilter("pending"), "pending");
  assert.equal(invitationFilter("failed"), "all");
  assert.equal(invitationFilter(null), "all");
  // Waiting is amber, joined green, a no red, and over is quiet.
  assert.equal(invitationTone("awaiting_answer"), "warn");
  assert.equal(invitationTone("redeemed"), "success");
  assert.equal(invitationTone("revoked"), "danger");
  assert.equal(invitationTone("expired"), "neutral");
});

test("the Members page filters by role, two-factor, team and words", () => {
  const members = [
    { username: "ada", name: "Ada Lovelace", role: "owner" as const, two_factor: true },
    { username: "grace", name: "Grace Hopper", role: "member" as const, two_factor: false },
    { username: "linus", name: null, role: "member" as const, two_factor: true },
  ];
  const teams = { ada: [{ slug: "core" }], grace: [{ slug: "web" }, { slug: "core" }] };
  assert.deepEqual(memberFilters(""), { role: "all", twoFactor: "all", team: null, query: "" });
  assert.deepEqual(memberFilters("?role=owner&2fa=off&team=Core&q=%20ada%20"), { role: "owner", twoFactor: "off", team: "core", query: "ada" });
  assert.deepEqual(memberFilters("?role=admin&2fa=maybe"), { role: "all", twoFactor: "all", team: null, query: "" });
  const names = (filters: string) => filterMembers(members, memberFilters(filters), teams).map((member) => member.username);
  assert.deepEqual(names(""), ["ada", "grace", "linus"]);
  assert.deepEqual(names("?role=member"), ["grace", "linus"]);
  assert.deepEqual(names("?2fa=off"), ["grace"]);
  assert.deepEqual(names("?team=core"), ["ada", "grace"]);
  assert.deepEqual(names("?q=hopper"), ["grace"]);
  assert.deepEqual(names("?q=@LIN"), ["linus"]);
  assert.deepEqual(names("?role=owner&team=web"), []);
});

test("open registration offers a plain sign-up", () => {
  assert.deepEqual(signUpCopy(), { primary: "Sign up", secondary: null });
  assert.deepEqual(signUpCopy(false), { primary: "Sign up", secondary: null });
});

test("in private preview the sign-up buttons ask for access", () => {
  assert.equal(signUpCopy(true).primary, "Request access");
  assert.match(signUpCopy(true).secondary ?? "", /invite email/);
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

test("the two invites say which they are", () => {
  // A workspace's People page: an invitation to accept or decline, which signs up whoever has no account.
  const copy = workspaceInviteCopy("Flagon, Inc.");
  assert.equal(copy.heading, "Invite to Flagon, Inc.");
  assert.match(copy.hint, /invitation to join Flagon, Inc\..*join only if they accept/);
  assert.match(copy.hint, /If they do not have a g1t account yet, they sign up from the invitation first/);
  assert.doesNotMatch(copy.hint, /one of yours|shared invites/);
});

test("an invite's page names the invite it is", () => {
  const base = { kind: "account" as const, invitedBy: { username: "syntaqx" }, workspace: null, repository: null, hasAccount: false };
  const g1t = invitePageCopy(base, false);
  assert.equal(`${g1t.before}${g1t.place ?? ""}${g1t.after}`, "@syntaqx invited you to g1t");
  assert.match(g1t.about, /Sign up from this invite and your address is filled in for you\. It does not add you to anyone's workspace/);
  const join = invitePageCopy({ ...base, workspace: { name: "Flagon, Inc." } }, false);
  assert.equal(`${join.before}${join.place}${join.after}`, "@syntaqx invited you to join Flagon, Inc. on g1t");
  assert.equal(join.place, "Flagon, Inc.");
  assert.match(join.about, /invitation to join Flagon, Inc\., which you accept or decline/);
  assert.match(join.about, /You do not have a g1t account yet, so it also lets you make one/);
  // Someone with an account, or signed in, just accepts.
  assert.match(
    invitePageCopy({ ...base, kind: "workspace", workspace: { name: "Flagon, Inc." }, hasAccount: true }, false).about,
    /Accepting joins you to Flagon, Inc\./,
  );
  assert.equal(invitePageCopy({ ...base, invitedBy: null }, false).before, "The g1t team invited you to g1t");
});

test("Invite a friend never reads as a gate on signing up", () => {
  for (const words of Object.values(G1T_INVITES)) {
    assert.doesNotMatch(words, /invite-only|waitlist|request access|need an invite|held for/i, words);
  }
  assert.match(G1T_INVITES.about, /Anyone can sign up for g1t/);
  assert.match(G1T_INVITES.out, /can still sign up/);
});

test("a friend can also be invited only to a paid workspace the person owns", () => {
  const memberships = [
    { slug: "Acme", name: "Acme Labs", role: "owner" as const },
    { slug: "hobby", name: null, role: "owner" as const },
    { slug: "flagon-io", name: "Flagon, Inc.", role: "member" as const },
  ];
  assert.deepEqual(bringIntoChoices(memberships, ["hobby"]), [{ slug: "acme", name: "Acme Labs" }]);
  // Nothing paid that they own: no box at all.
  assert.deepEqual(bringIntoChoices(memberships, ["acme", "hobby"]), []);
});

test("the form sends a workspace only when its box is ticked and it was offered", () => {
  const form = (fields: Record<string, string>) => new Map(Object.entries(fields));
  const offered = [{ slug: "acme", name: "Acme Labs" }];
  assert.deepEqual(inviteDraft(form({ email: " ada@example.com ", message: "  " }), offered), { email: "ada@example.com", message: null });
  assert.deepEqual(inviteDraft(form({ email: "ada@example.com", join: "acme", join_role: "owner" }), offered), { email: "ada@example.com", message: null });
  assert.deepEqual(inviteDraft(form({ email: "ada@example.com", message: "Come build", also_join: "on", join: "acme", join_role: "owner" }), offered), {
    email: "ada@example.com",
    message: "Come build",
    join: "acme",
    joinRole: "owner",
  });
  // A workspace not offered (free, or not theirs) is dropped.
  assert.deepEqual(inviteDraft(form({ email: "ada@example.com", also_join: "on", join: "hobby" }), offered), { email: "ada@example.com", message: null });
});

test("how many invites are left reads plainly, and the menu shows the count", () => {
  assert.equal(remainingLine({ limit: 20, remaining: 18 }), "18 of 20 invites left");
  assert.equal(remainingLine({ limit: 20, remaining: 0 }), "You have used all 20 of your invites");
  assert.equal(remainingLine({ limit: 1, remaining: 1 }), "1 of 1 invite left");
  assert.equal(remainingLine({ limit: 0, remaining: 0 }), "Invites to g1t are turned off on this installation");
  assert.equal(leftBadge(18), "18 left");
  assert.equal(leftBadge(0), "0 left");
  assert.equal(leftBadge(null), null);
  assert.equal(leftBadge(undefined), null);
});

test("only a pending invite is sent again or copied; one waiting on its friend can still be revoked", () => {
  assert.deepEqual(inviteActions({ status: "pending", code: "g1t-abcd" }), { revoke: true, resend: true, copy: true });
  assert.deepEqual(inviteActions({ status: "pending", code: null }), { revoke: true, resend: true, copy: false });
  assert.deepEqual(inviteActions({ status: "awaiting_confirmation", code: null }), { revoke: true, resend: false, copy: false });
  for (const status of ["redeemed", "expired", "revoked", "declined"] as const) {
    assert.deepEqual(inviteActions({ status, code: null }), { revoke: false, resend: false, copy: false }, status);
  }
});
