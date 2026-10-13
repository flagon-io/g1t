import { test } from "node:test";
import assert from "node:assert/strict";
import { npmCi, retryable } from "./npm-ci.mjs";

const quiet = () => {};
const noSleep = async () => {};

/** A fake npm that answers each try in turn. */
function tries(...answers) {
  const seen = [];
  const run = async (args) => {
    seen.push(args);
    return { stalled: false, output: "", ...answers[seen.length - 1] };
  };
  return { seen, run };
}

test("a body that broke off is worth another try, a lockfile out of step is not", () => {
  assert.equal(retryable("npm error code ECONNRESET\nnpm error network aborted"), true);
  assert.equal(retryable("npm error request to https://registry.npmjs.org/x failed, reason: socket hang up"), true);
  assert.equal(retryable("npm error code EAI_AGAIN"), true);
  assert.equal(retryable("npm error `npm ci` can only install packages when your package.json and package-lock.json are in sync"), false);
  assert.equal(retryable("npm error code E404"), false);
});

test("an install that ends without saying why, or stalls, is tried again", () => {
  assert.equal(retryable(""), true);
  assert.equal(retryable("added 12 packages"), true);
  assert.equal(retryable("npm error code E404", { stalled: true }), true);
});

test("a dropped connection is tried again until the install passes", async () => {
  const waits = [];
  const { seen, run } = tries({ code: 1, output: "npm error code ECONNRESET" }, { code: 0 });
  const code = await npmCi(["--prefer-offline", "--no-audit"], { run, sleep: async (ms) => waits.push(ms), waits: [5, 15], log: quiet });
  assert.equal(code, 0);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1], ["ci", "--prefer-offline", "--no-audit"]);
  assert.deepEqual(waits, [5]);
});

test("a real error fails at once", async () => {
  const { seen, run } = tries({ code: 1, output: "npm error code ERESOLVE" });
  assert.equal(await npmCi([], { run, sleep: noSleep, log: quiet }), 1);
  assert.equal(seen.length, 1);
});

test("it gives up after its tries, with npm's exit code", async () => {
  const reset = { code: 7, output: "npm error network aborted" };
  const { seen, run } = tries(reset, reset, reset, reset);
  assert.equal(await npmCi([], { run, sleep: noSleep, attempts: 3, log: quiet }), 7);
  assert.equal(seen.length, 3);
});

test("a stalled install is run again", async () => {
  const { seen, run } = tries({ code: 1, stalled: true }, { code: 0 });
  assert.equal(await npmCi([], { run, sleep: noSleep, log: quiet }), 0);
  assert.equal(seen.length, 2);
});
