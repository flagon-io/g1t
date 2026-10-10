import { test } from "node:test";
import assert from "node:assert/strict";

import { activitySpan, chatActivity } from "./activity.ts";

const span = { from: "2026-10-08T18:00:00.000Z", until: "2026-10-09T18:00:00.000Z" };

test("messages, conversations with any, and who said how much, most first", () => {
  const activity = chatActivity(
    [
      { channel_id: "chn_general", author: "user:usr_ana", n: 70 },
      { channel_id: "chn_general", author: "agent:agt_margo", n: 15 },
      { channel_id: "chn_dev", author: "user:usr_bo", n: 30 },
      { channel_id: "chn_dev", author: "user:usr_ana", n: 5 },
      // A conversation with nothing in the span is not active.
      { channel_id: "chn_quiet", author: "user:usr_bo", n: 0 },
    ],
    span,
  );
  assert.deepEqual(activity, {
    ...span,
    messages: 120,
    channels: 2,
    authors: [
      { key: "user:usr_ana", messages: 75 },
      { key: "user:usr_bo", messages: 30 },
      { key: "agent:agt_margo", messages: 15 },
    ],
  });
});

test("nothing said is zeros, not an error", () => {
  assert.deepEqual(chatActivity([], span), { ...span, messages: 0, channels: 0, authors: [] });
});

test("a span is two times in order", () => {
  assert.equal(activitySpan(span.from, span.until)?.fromMs, Date.parse(span.from));
  assert.equal(activitySpan(span.until, span.from), null);
  assert.equal(activitySpan("yesterday", span.until), null);
  assert.equal(activitySpan(null, span.until), null);
});
