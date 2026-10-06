import assert from "node:assert/strict";
import { test } from "node:test";

import { hostedOpen, listedWorkspaces } from "./hosted.ts";

const live = { enabled: true, live: true };
const testMode = { enabled: true, live: false };
const none = { enabled: false, live: false };

test("listed workspaces use hosted models whatever billing is", () => {
  assert.equal(hostedOpen("flagon-io", "flagon-io", testMode), true);
  assert.equal(hostedOpen("Flagon-IO", " flagon-io , acme", none), true);
  assert.equal(hostedOpen("anyone", "*", testMode), true);
});

test("with a test key a card check opens nothing: other workspaces bring their own provider", () => {
  assert.equal(hostedOpen("acme", "flagon-io", testMode), false);
  assert.equal(hostedOpen("acme", "flagon-io", none), false);
  assert.equal(hostedOpen("acme", "", testMode), false);
});

test("once billing takes real money, every workspace may use them", () => {
  assert.equal(hostedOpen("acme", "flagon-io", live), true);
});

test("the setting is a comma-separated list", () => {
  assert.deepEqual(listedWorkspaces(" a, B ,,*"), ["a", "b", "*"]);
});
