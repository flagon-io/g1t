import assert from "node:assert/strict";
import { test } from "node:test";

import { isPending } from "./pending.ts";

const posted = (entries: Record<string, string>) => {
  const form = new FormData();
  for (const [name, value] of Object.entries(entries)) form.set(name, value);
  return form;
};

test("nothing is pending while the page is idle", () => {
  assert.equal(isPending({ state: "idle" }), false);
  assert.equal(isPending({ state: "idle", formMethod: "POST", formData: posted({ intent: "save" }) }, { intent: "save" }), false);
});

test("a post is pending while it is sent and while the page reloads after it", () => {
  const formData = posted({ intent: "save" });
  assert.equal(isPending({ state: "submitting", formMethod: "POST", formData }), true);
  assert.equal(isPending({ state: "loading", formMethod: "POST", formData }), true);
  assert.equal(isPending({ state: "loading", formMethod: "post", formData }, { intent: "save" }), true);
});

test("following a link, or a GET form, is not a pending write", () => {
  assert.equal(isPending({ state: "loading" }), false);
  assert.equal(isPending({ state: "loading", formMethod: "GET", formData: posted({ q: "x" }) }), false);
  assert.equal(isPending({ state: "submitting", formMethod: "GET", formData: posted({ q: "x" }) }), false);
});

test("only the submission that matches is pending, so one row's button does not speak for another's", () => {
  const formData = posted({ intent: "delete", id: "hook_1" });
  const sending = { state: "submitting" as const, formMethod: "POST", formData };
  assert.equal(isPending(sending, { intent: "delete", id: "hook_1" }), true);
  assert.equal(isPending(sending, { intent: "delete", id: "hook_2" }), false);
  assert.equal(isPending(sending, { intent: "ping" }), false);
  // A field left out (undefined) does not have to match.
  assert.equal(isPending(sending, { intent: "delete", id: undefined }), true);
});
