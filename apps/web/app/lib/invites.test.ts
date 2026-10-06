import assert from "node:assert/strict";
import { test } from "node:test";

import { CONTACT } from "./legal.ts";
import {
  HAVE_AN_INVITE,
  INVITES_CONTACT,
  cleanCode,
  inviteFor,
  inviteLink,
  inviteState,
  looksAutomated,
  moreInvitesMailto,
  remainingLine,
  signUpCopy,
} from "./invites.ts";

const CODE = "g1t-k7m2-q9xd-4hpw-abcd-0123-4567-89ef-ghjk";

test("while invite-only, nobody is offered a plain sign-up", () => {
  assert.deepEqual(signUpCopy(true), { primary: "Request access", secondary: "Have an invite?" });
  assert.deepEqual(signUpCopy(false), { primary: "Sign up", secondary: null });
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
