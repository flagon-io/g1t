import assert from "node:assert/strict";
import { test } from "node:test";

import { DeadlineExceeded, withDeadline } from "./deadline.ts";

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
  await assert.rejects(withDeadline("chat sidebar", 10, () => new Promise<never>(() => {})), DeadlineExceeded);
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
