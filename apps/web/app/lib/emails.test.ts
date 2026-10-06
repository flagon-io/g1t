import assert from "node:assert/strict";
import { test } from "node:test";

import type { AccountEmail } from "@g1t/contracts";

import { addressActions, backupChoices, pendingFields } from "./emails.ts";

const email = (address: string, verified: boolean, primary = false): AccountEmail => ({
  email: address,
  verified,
  primary,
  backup: false,
  createdAt: "2026-10-05T00:00:00.000Z",
  verifiedAt: verified ? "2026-10-05T00:00:00.000Z" : null,
});

test("the primary cannot be removed, and only a confirmed address can become it", () => {
  const all = [email("a@x.io", true, true), email("b@x.io", true), email("c@x.io", false)];
  assert.deepEqual(addressActions(all[0]!, all), { makePrimary: false, remove: false, resend: false });
  assert.deepEqual(addressActions(all[1]!, all), { makePrimary: true, remove: true, resend: false });
  assert.deepEqual(addressActions(all[2]!, all), { makePrimary: false, remove: true, resend: true });
});

test("the last confirmed address stays, even when it is not the primary", () => {
  const all = [email("a@x.io", false, true), email("b@x.io", true)];
  assert.equal(addressActions(all[1]!, all).remove, false);
});

test("the backup is a confirmed address other than the primary", () => {
  const all = [email("a@x.io", true, true), email("b@x.io", true), email("c@x.io", false)];
  assert.deepEqual(backupChoices(all).map((choice) => choice.email), ["b@x.io"]);
});

test("a change waiting on the password keeps its fields but never the password", () => {
  const form = new FormData();
  form.set("intent", "remove-email");
  form.set("email", "b@x.io");
  form.set("password", "hunter22hunter22");
  assert.deepEqual(pendingFields(form), { email: "b@x.io" });
});
