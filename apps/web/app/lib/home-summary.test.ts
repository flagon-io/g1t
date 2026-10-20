import assert from "node:assert/strict";
import { test } from "node:test";

import { summaryAsked, summaryPollMs } from "./home-summary.ts";

test("one request leaves the card answering the question it asked", () => {
  assert.deepEqual(summaryAsked({ ok: true, value: { channel_id: "chn_1", question_id: "msg_2" } }), {
    step: "answering",
    channelId: "chn_1",
    questionId: "msg_2",
  });
});

test("Ask without a provider says so, with the owner's link only for an owner", () => {
  const problem = "No AI provider is chosen for Ask in this workspace yet.";
  assert.deepEqual(summaryAsked({ ok: true, value: { problem, owner: true } }), { step: "problem", message: problem, setup: true, owner: true });
  assert.deepEqual(summaryAsked({ ok: true, value: { problem, owner: false } }), { step: "problem", message: problem, setup: true, owner: false });
});

test("a refusal says why, and no answer at all says Ask could not be reached", () => {
  assert.deepEqual(summaryAsked({ ok: false, error: { code: "unavailable", message: "Chat didn't answer." } }), {
    step: "problem",
    message: "Chat didn't answer.",
    setup: false,
    owner: false,
  });
  const unreached = summaryAsked(null);
  assert.equal(unreached.step, "problem");
  assert.match(unreached.step === "problem" ? unreached.message : "", /could not be reached/);
});

test("with the socket open, the card reads again only now and then; without it, often", () => {
  assert.equal(summaryPollMs("open"), 10_000);
  assert.equal(summaryPollMs("connecting"), 2_500);
  assert.equal(summaryPollMs("reconnecting"), 2_500);
});
