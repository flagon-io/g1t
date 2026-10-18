import assert from "node:assert/strict";
import { test } from "node:test";

import { DeadlineExceeded, LONG_DEADLINE_MS, READ_DEADLINE_MS, SLOW_READ_DEADLINE_MS, WRITE_DEADLINE_MS, deadlineFor, withDeadline } from "./deadline.ts";
import { STUCK_NAVIGATION_MS } from "./stuck.ts";

test("an answer in time is passed through", async () => {
  assert.equal(await withDeadline("repos get_repo", 1000, async () => "ok"), "ok");
});

test("a call that never answers fails at its deadline, and its signal aborts", async () => {
  let seen: AbortSignal | undefined;
  const never = withDeadline("repos get_repo", 20, (signal) => {
    seen = signal;
    return new Promise<never>(() => {});
  });
  await assert.rejects(never, (error: unknown) => error instanceof DeadlineExceeded && /repos get_repo did not answer within 20ms/.test(error.message));
  assert.equal(seen?.aborted, true);
});

test("a call that ignores its signal is still let go", async () => {
  await assert.rejects(
    withDeadline("chat sidebar", 10, () => new Promise<never>(() => {})),
    DeadlineExceeded,
  );
});

test("a failure in time is the call's own, not a deadline", async () => {
  await assert.rejects(
    withDeadline("work get_pull", 1000, async () => {
      throw new Error("get_pull failed with status 500");
    }),
    /status 500/,
  );
});

test("the caller's own signal aborts the call", async () => {
  const outer = new AbortController();
  let seen: AbortSignal | undefined;
  const call = withDeadline(
    "repos get_repo",
    1000,
    (signal) =>
      new Promise<never>((_, reject) => {
        seen = signal;
        signal.addEventListener("abort", () => reject(signal.reason));
      }),
    outer.signal,
  );
  outer.abort(new Error("visitor left"));
  await assert.rejects(call, /visitor left/);
  assert.equal(seen?.aborted, true);
});

test("each call gets the time its work needs", () => {
  assert.equal(deadlineFor("repos", "get_repo", false), READ_DEADLINE_MS);
  assert.equal(deadlineFor("work", "merge_pull", true), WRITE_DEADLINE_MS);
  assert.equal(deadlineFor("security", "overview", false), SLOW_READ_DEADLINE_MS);
  assert.equal(deadlineFor("repos", "blame", false), SLOW_READ_DEADLINE_MS);
  assert.equal(deadlineFor("integrations", "github_import", true), LONG_DEADLINE_MS);
  assert.equal(deadlineFor("security", "rescan", true), LONG_DEADLINE_MS);
});

test("a long method of one service is not long in another", () => {
  assert.equal(deadlineFor("security", "rescan", true), LONG_DEADLINE_MS);
  assert.equal(deadlineFor("work", "rescan", true), WRITE_DEADLINE_MS);
  assert.equal(deadlineFor("work", "draft", true), WRITE_DEADLINE_MS);
  assert.equal(deadlineFor("identity", "overview", false), READ_DEADLINE_MS);
});

test("no read outlasts the browser's patience with a navigation", () => {
  assert.ok(SLOW_READ_DEADLINE_MS < STUCK_NAVIGATION_MS && READ_DEADLINE_MS < STUCK_NAVIGATION_MS);
});
