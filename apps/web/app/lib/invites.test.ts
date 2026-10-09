import assert from "node:assert/strict";
import { test } from "node:test";

import { CONTACT } from "./legal.ts";
import {
  HAVE_AN_INVITE,
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
  assert.equal(proven.intro, "You join Flagon, Inc. as soon as you create it.");
  assert.match(proven.confirmed ?? "", /^ada@example\.com is confirmed: you came here from the invite we emailed to it/);
  assert.match(proven.hint, /confirmed already/);
  assert.doesNotMatch(proven.hint, /code/);

  // No proof (a code typed in, or a link passed on): nothing new is said.
  const plain = inviteSignUpCopy(base);
  assert.equal(plain.intro, "You join Flagon, Inc. as soon as you confirm your email.");
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
  assert.equal(inviteFor({ ...base, status: "pending", email: "ada@example.com", workspace: "acme" }), "ada@example.com · joins acme");
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
