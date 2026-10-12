import assert from "node:assert/strict";
import { test } from "node:test";

import { FIRST_RETRY_MS, IDLE_POLL_MS, MAX_RETRY_MS, QUIET_AFTER_MS, RUNNING_POLL_MS, elapsed, nextPoll, quietWords, retryAfterMs } from "./log-poll.ts";

const live = { failures: 0, live: true, running: true };

test("a live job is asked every second while a step runs, less often while none does", () => {
  assert.deepEqual(nextPoll({ ok: true, done: false, full: false }, live), { delayMs: RUNNING_POLL_MS, failures: 0 });
  assert.deepEqual(nextPoll({ ok: true, done: false, full: false }, { ...live, running: false }), { delayMs: IDLE_POLL_MS, failures: 0 });
  // A full page: the rest at once.
  assert.deepEqual(nextPoll({ ok: true, done: false, full: true }, live), { delayMs: 0, failures: 0 });
  // Done, or shown as finished: no more.
  assert.deepEqual(nextPoll({ ok: true, done: true, full: false }, live), { delayMs: null, failures: 0 });
  assert.deepEqual(nextPoll({ ok: true, done: false, full: false }, { ...live, live: false }), { delayMs: null, failures: 0 });
});

test("a failed answer is tried again, waiting longer each time, never stopping a live log", () => {
  let failures = 0;
  const waits: (number | null)[] = [];
  for (let i = 0; i < 8; i++) {
    const next = nextPoll({ ok: false, status: 503 }, { ...live, failures });
    failures = next.failures;
    waits.push(next.delayMs);
  }
  assert.deepEqual(waits, [FIRST_RETRY_MS, 4000, 8000, 16_000, MAX_RETRY_MS, MAX_RETRY_MS, MAX_RETRY_MS, MAX_RETRY_MS]);
  // An answer resets it.
  assert.deepEqual(nextPoll({ ok: true, done: false, full: false }, { ...live, failures }), { delayMs: RUNNING_POLL_MS, failures: 0 });
  // The network failing is a failure like any other.
  assert.deepEqual(nextPoll({ ok: false }, live), { delayMs: FIRST_RETRY_MS, failures: 1 });
});

test("a 429 waits as long as Retry-After says; a 404 stops; a finished job's last fetch gives up", () => {
  assert.deepEqual(nextPoll({ ok: false, status: 429, retryAfterMs: 20_000 }, live), { delayMs: 20_000, failures: 1 });
  assert.deepEqual(nextPoll({ ok: false, status: 429, retryAfterMs: 500 }, live), { delayMs: FIRST_RETRY_MS, failures: 1 });
  assert.deepEqual(nextPoll({ ok: false, status: 429, retryAfterMs: 3_600_000 }, live), { delayMs: 2 * MAX_RETRY_MS, failures: 1 });
  assert.deepEqual(nextPoll({ ok: false, status: 404 }, live), { delayMs: null, failures: 1 });
  const finished = { failures: 4, live: false, running: false };
  assert.deepEqual(nextPoll({ ok: false, status: 500 }, finished), { delayMs: null, failures: 5 });
  assert.equal(nextPoll({ ok: false, status: 500 }, { ...finished, failures: 0 }).delayMs, FIRST_RETRY_MS);
});

test("a quiet step says for how long it has printed nothing", () => {
  const start = Date.parse("2026-10-12T10:00:00Z");
  assert.equal(quietWords(start, null, start + 130_000), "Running · no output yet, 2m 10s");
  assert.equal(quietWords(null, null, start), "Running · no output yet");
  // Output a moment ago: nothing to say.
  assert.equal(quietWords(start, start + 60_000, start + 65_000), null);
  assert.equal(quietWords(start, start + 60_000, start + 60_000 + QUIET_AFTER_MS), "Running · no output for 10s");
  assert.equal(quietWords(start, start, start + 3_725_000), "Running · no output for 1h 2m");
  assert.equal(elapsed(-5), "0s");
});

test("Retry-After reads as seconds or as a date", () => {
  assert.equal(retryAfterMs("12"), 12_000);
  assert.equal(retryAfterMs(null), undefined);
  assert.equal(retryAfterMs("soon"), undefined);
  const now = Date.parse("2026-10-12T10:00:00Z");
  assert.equal(retryAfterMs("Mon, 12 Oct 2026 10:00:30 GMT", now), 30_000);
  assert.equal(retryAfterMs("Mon, 12 Oct 2026 09:00:00 GMT", now), 0);
});
