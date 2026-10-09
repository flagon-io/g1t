import assert from "node:assert/strict";
import { test } from "node:test";

import { PAUSE_KEPT_MS, forgetPlatformPause, platformPause, readPause } from "../../../packages/contracts/src/platform.ts";
import { STATIC_CARD, pausedCard } from "./paused.ts";

test("while renders are paused, a miss gets the cached brand card, kept a minute", async () => {
  const brand = new Response("png", { headers: { "content-type": "image/png", "cache-control": "public, max-age=3600" } });
  const answer = pausedCard(brand);
  assert.equal(answer.status, 200);
  assert.equal(answer.headers.get("content-type"), "image/png");
  assert.equal(answer.headers.get("cache-control"), "public, max-age=60");
  assert.equal(await answer.text(), "png");
});

test("with no brand card cached, a miss is sent to the static logo", () => {
  const answer = pausedCard(undefined);
  assert.equal(answer.status, 302);
  assert.equal(answer.headers.get("location"), STATIC_CARD);
});

test("the platform pause is read once per 30 seconds, and nothing is paused when billing cannot say", async () => {
  forgetPlatformPause();
  let calls = 0;
  const billing = {
    async fetch() {
      calls += 1;
      return new Response(JSON.stringify({ compute: false, schedules: true, indexing: false, renders: true }));
    },
  };
  const now = 1_000_000;
  assert.equal((await platformPause(billing, now)).renders, true);
  assert.equal((await platformPause(billing, now + PAUSE_KEPT_MS - 1)).schedules, true);
  assert.equal(calls, 1);
  const down = { fetch: async () => new Response("no", { status: 500 }) };
  assert.deepEqual(await platformPause(down, now + PAUSE_KEPT_MS), { compute: false, schedules: false, indexing: false, renders: false });
  // No binding: never paused.
  assert.equal((await platformPause(undefined)).renders, false);
  assert.deepEqual(readPause({ renders: "yes", indexing: true }), { compute: false, schedules: false, indexing: true, renders: false });
  forgetPlatformPause();
});
