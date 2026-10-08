import assert from "node:assert/strict";
import { test } from "node:test";

import {
  INVITES_DONE,
  MAX_BULK,
  MAX_SHARED_USES,
  dayAfter,
  domainsLine,
  doneMessage,
  invitesHref,
  joinedThrough,
  normalizeDomain,
  parseGrant,
  parseIds,
  parseMintEmail,
  parseNote,
  parseSharedInvite,
  parseTab,
  parseWaitlistStatus,
  sharedInviteLink,
  sharedStatus,
  usesLine,
} from "./invites.ts";

const form = (fields: Record<string, string>) => ({ get: (name: string) => fields[name] ?? null });

test("the page opens on the waitlist, and each tab has an address", () => {
  assert.equal(parseTab(null), "waitlist");
  assert.equal(parseTab("tree"), "tree");
  assert.equal(parseTab("nope"), "waitlist");
  assert.equal(invitesHref("invites", { q: "g1t-k7m2", empty: "" }), "/invites?tab=invites&q=g1t-k7m2");
  assert.equal(parseWaitlistStatus(null), "waiting");
  assert.equal(parseWaitlistStatus("all"), "all");
  assert.equal(parseWaitlistStatus("dismissed"), "dismissed");
});

test("a grant names who, how many and why", () => {
  assert.deepEqual(parseGrant(form({ target: "user", name: "@Ada", amount: "10", note: "Launch partner" })), {
    ok: true,
    value: { target: "user", name: "ada", amount: 10, note: "Launch partner" },
  });
  assert.deepEqual(parseGrant(form({ target: "workspace", name: "acme", amount: "-5", note: "Abuse" })), {
    ok: true,
    value: { target: "workspace", name: "acme", amount: -5, note: "Abuse" },
  });
  assert.equal(parseGrant(form({ target: "team", name: "acme", amount: "5", note: "why" })).ok, false);
  assert.equal(parseGrant(form({ target: "user", name: "not a name", amount: "5", note: "why" })).ok, false);
  assert.equal(parseGrant(form({ target: "user", name: "ada", amount: "0", note: "why" })).ok, false);
  assert.equal(parseGrant(form({ target: "user", name: "ada", amount: "1.5", note: "why" })).ok, false);
  assert.equal(parseGrant(form({ target: "user", name: "ada", amount: "5000", note: "why" })).ok, false);
  assert.equal(parseGrant(form({ target: "user", name: "ada", amount: "5", note: "" })).ok, false);
});

test("a minted invite is for one address, or for anyone", () => {
  assert.deepEqual(parseMintEmail(""), { ok: true, value: null });
  assert.deepEqual(parseMintEmail(" Ada@Example.com "), { ok: true, value: "ada@example.com" });
  assert.equal(parseMintEmail("ada@").ok, false);
});

test("every outcome has words", () => {
  for (const key of ["approved", "dismissed", "revoked", "granted"]) assert.ok(INVITES_DONE[key]);
});

test("several requests are decided at once, each once", () => {
  const ticked = (ids: string[]) => ({ getAll: (name: string) => (name === "ids" ? ids : []) });
  assert.deepEqual(parseIds(ticked(["wl_01jb2k", "wl_01jb2m", "wl_01jb2k"])), { ok: true, value: ["wl_01jb2k", "wl_01jb2m"] });
  assert.equal(parseIds(ticked([])).ok, false);
  assert.equal(parseIds(ticked(["inv_01jb2k", "wl_<script>"])).ok, false);
  const many = Array.from({ length: MAX_BULK + 1 }, (_, n) => `wl_${n.toString(36)}`);
  assert.equal(parseIds(ticked(many)).ok, false);
  assert.equal(parseIds(ticked(many.slice(0, MAX_BULK))).ok, true);
});

test("an approval's note is optional and short", () => {
  assert.deepEqual(parseNote("  Welcome aboard.  "), { ok: true, value: "Welcome aboard." });
  assert.deepEqual(parseNote(""), { ok: true, value: null });
  assert.deepEqual(parseNote(null), { ok: true, value: null });
  assert.equal(parseNote("x".repeat(501)).ok, false);
});

test("the flash says how many were decided", () => {
  assert.equal(doneMessage("approved", "3"), "Approved 3 requests. Each invite is on its way.");
  assert.equal(doneMessage("dismissed", "2"), "Dismissed 2 requests.");
  assert.equal(doneMessage("approved", null), INVITES_DONE.approved);
  assert.equal(doneMessage("approved", "1"), INVITES_DONE.approved);
  assert.equal(doneMessage("nope", "4"), null);
  assert.equal(doneMessage(null, null), null);
});

// 2026-10-08T12:00:00Z.
const NOW = Date.UTC(2026, 9, 8, 12);

test("shared links have their own tab", () => {
  assert.equal(parseTab("shared"), "shared");
  assert.equal(invitesHref("shared"), "/invites?tab=shared");
  assert.ok(INVITES_DONE["shared-created"]);
  assert.match(INVITES_DONE["shared-revoked"]!, /ones it made stay/);
});

test("a shared link needs a label, 1 to 1000 uses, and a day within a year", () => {
  const ok = parseSharedInvite(form({ label: "  Cloudflare   judges ", max_uses: "40", expires_on: "2026-10-14", domains: "" }), NOW);
  assert.deepEqual(ok, { ok: true, value: { label: "Cloudflare judges", maxUses: 40, expiresOn: "2026-10-14", domains: [] } });
  // No day: identity's 14 days.
  const later = parseSharedInvite(form({ label: "Judges", max_uses: "1" }), NOW);
  assert.ok(later.ok && later.value.expiresOn === null);
  assert.ok(!parseSharedInvite(form({ label: "", max_uses: "10" }), NOW).ok);
  assert.ok(!parseSharedInvite(form({ label: "x".repeat(81), max_uses: "10" }), NOW).ok);
  for (const uses of ["0", "1001", "-3", "2.5", "ten", ""]) {
    const parsed = parseSharedInvite(form({ label: "Judges", max_uses: uses }), NOW);
    assert.ok(!parsed.ok && parsed.error.includes(String(MAX_SHARED_USES)), uses);
  }
  assert.ok(parseSharedInvite(form({ label: "Judges", max_uses: "1000" }), NOW).ok);
  // Today works; yesterday, a day past a year, and days that do not exist do not.
  assert.ok(parseSharedInvite(form({ label: "Judges", max_uses: "5", expires_on: "2026-10-08" }), NOW).ok);
  assert.ok(parseSharedInvite(form({ label: "Judges", max_uses: "5", expires_on: "2027-10-08" }), NOW).ok);
  for (const day of ["2026-10-07", "2027-10-09", "2026-02-30", "14/10/2026"]) {
    assert.ok(!parseSharedInvite(form({ label: "Judges", max_uses: "5", expires_on: day }), NOW).ok, day);
  }
});

test("a shared link's domains are tidied, checked and capped", () => {
  const parsed = parseSharedInvite(form({ label: "Judges", max_uses: "5", domains: "@Cloudflare.com, flagon.io  cloudflare.com" }), NOW);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value.domains, ["cloudflare.com", "flagon.io"]);
  const bad = parseSharedInvite(form({ label: "Judges", max_uses: "5", domains: "localhost" }), NOW);
  assert.ok(!bad.ok && bad.error.startsWith("localhost is not an email domain"));
  const many = Array.from({ length: 11 }, (_, n) => `d${n}.com`).join(",");
  assert.ok(!parseSharedInvite(form({ label: "Judges", max_uses: "5", domains: many }), NOW).ok);
  assert.equal(normalizeDomain(" @EXAMPLE.com. "), "example.com");
  assert.equal(normalizeDomain("-bad.com"), null);
  assert.equal(domainsLine([]), "Any email address");
  assert.equal(domainsLine(["cloudflare.com", "flagon.io"]), "Only addresses at cloudflare.com, flagon.io");
});

test("a shared link reads as its state, its uses and its address", () => {
  assert.deepEqual(sharedStatus("live"), { label: "Live", tone: "lavender" });
  assert.equal(sharedStatus("used_up").label, "Used up");
  assert.equal(sharedStatus("expired").label, "Expired");
  assert.equal(sharedStatus("revoked").tone, "danger");
  assert.equal(usesLine({ uses: 3, maxUses: 40 }), "3 of 40 used");
  assert.equal(sharedInviteLink("g1t-k7m2-q9xd"), "https://g1t.sh/register?invite=g1t-k7m2-q9xd");
  assert.equal(joinedThrough("Cloudflare judges"), "Joined through Cloudflare judges");
  assert.equal(dayAfter(NOW, 14), "2026-10-22");
  assert.equal(dayAfter(NOW, 0), "2026-10-08");
});
