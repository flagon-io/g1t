import assert from "node:assert/strict";
import { test } from "node:test";

import type { AskSetup, ChatAnswer } from "@g1t/contracts";

import { answerLog, runAnswer, type AnswerDeps } from "./answer.ts";

const ready: AskSetup = { provider_id: "ai_1", provider_name: "Anthropic", provider: "anthropic", model: "m", problem: null };

function ndjson(lines: object[], { split = false } = {}): Response {
  const text = lines.map((line) => `${JSON.stringify(line)}\n`).join("");
  const parts = split ? text.match(/[\s\S]{1,7}/g)! : [text];
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
        controller.close();
      },
    }),
  );
}

function harness(setup: AskSetup | null, answer: () => Response | Promise<Response>) {
  const seen = { typing: 0, shown: [] as string[], finished: null as null | { body: string; answer: ChatAnswer }, asked: 0 };
  let clock = 0;
  const deps: AnswerDeps = {
    slug: "acme",
    setup: async () => setup,
    ask: async () => {
      seen.asked++;
      return answer();
    },
    typing: () => void seen.typing++,
    show: (body) => void seen.shown.push(body),
    save: async () => {},
    finish: async (body, answer) => void (seen.finished = { body, answer }),
    now: () => (clock += 200),
  };
  return { deps, seen };
}

test("an answer streams into the message and ends as a normal one", async () => {
  const { deps, seen } = harness(ready, () =>
    ndjson(
      [
        { type: "meta", provider: "anthropic", provider_label: "Anthropic", model: "m" },
        { type: "text", text: "Two pull " },
        { type: "tool", name: "list_pulls" },
        { type: "text", text: "requests merged." },
        { type: "done", stop_reason: "end_turn" },
      ],
      { split: true },
    ),
  );
  await runAnswer(deps, new AbortController().signal);
  assert.equal(seen.typing, 1);
  assert.ok(seen.shown.length > 0);
  assert.equal(seen.finished!.body, "Two pull requests merged.");
  assert.equal(seen.finished!.answer.state, "done");
  assert.equal(seen.finished!.answer.model, "m");
  assert.equal(seen.finished!.answer.steps!.length, 1);
});

test("with no provider chosen, g1t says so once, without asking", async () => {
  const { deps, seen } = harness({ ...ready, provider_id: null, problem: "No AI provider is chosen for Ask in this workspace yet." }, () => ndjson([]));
  await runAnswer(deps, new AbortController().signal);
  assert.equal(seen.asked, 0);
  assert.equal(seen.finished!.answer.setup, "missing");
  assert.match(seen.finished!.body, /Settings → AI → Ask g1t/);
});

test("a chosen provider that cannot answer is a short message, not silence", async () => {
  const { deps, seen } = harness({ ...ready, problem: "The key for Anthropic cannot be read. Replace it." }, () => ndjson([]));
  await runAnswer(deps, new AbortController().signal);
  assert.equal(seen.finished!.answer.state, "error");
  assert.equal(seen.finished!.body, "I couldn't answer that: The key for Anthropic cannot be read. Replace it.");
});

test("a refusal or an unreachable service ends as an error message", async () => {
  const refused = harness(ready, () => ndjson([{ type: "error", message: "Write a question to ask." }]));
  await runAnswer(refused.deps, new AbortController().signal);
  assert.equal(refused.seen.finished!.body, "I couldn't answer that: Write a question to ask.");
  const down = harness(ready, () => {
    throw new Error("binding down");
  });
  await runAnswer(down.deps, new AbortController().signal);
  assert.equal(down.seen.finished!.answer.state, "error");
  assert.match(down.seen.finished!.body, /broke off/);
});

test("Stop keeps what came, marked stopped", async () => {
  const stop = new AbortController();
  let push!: (text: string) => void;
  const { deps, seen } = harness(ready, () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (text) => controller.enqueue(new TextEncoder().encode(text));
      },
    });
    return new Response(stream);
  });
  const running = runAnswer(deps, stop.signal);
  await new Promise((resolve) => setTimeout(resolve, 10));
  push(`${JSON.stringify({ type: "text", text: "Partly" })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 10));
  stop.abort();
  await running;
  assert.equal(seen.finished!.answer.state, "stopped");
  assert.equal(seen.finished!.body, "Partly");
});

test("an answer says how long its setup, the model's first word and its end took", async () => {
  let push!: (text: string) => void;
  let close!: () => void;
  const { deps } = harness(ready, () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (text) => controller.enqueue(new TextEncoder().encode(text));
        close = () => controller.close();
      },
    });
    return new Response(stream);
  });
  let clock = 1_000;
  deps.now = () => clock;
  deps.setup = async () => ((clock += 50), ready);
  const running = runAnswer(deps, new AbortController().signal);
  await new Promise((resolve) => setTimeout(resolve, 10));
  clock += 300;
  // The provider's meta line is not the model answering.
  push(`${JSON.stringify({ type: "meta", provider: "anthropic", model: "m" })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 10));
  clock += 400;
  push(`${JSON.stringify({ type: "text", text: "Two merged." })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 10));
  clock += 1_000;
  push(`${JSON.stringify({ type: "done", stop_reason: "end_turn" })}\n`);
  close();
  const times = await running;
  assert.deepEqual(times, { setup_ms: 50, first_token_ms: 750, end_ms: 1_750, asked: true });
});

test("an answer with nothing to ask says no first word", async () => {
  const { deps } = harness({ ...ready, provider_id: null, problem: "No AI provider is chosen for Ask in this workspace yet." }, () => ndjson([]));
  const times = await runAnswer(deps, new AbortController().signal);
  assert.equal(times.asked, false);
  assert.equal(times.first_token_ms, null);
});

test("the log line counts from the question, and says whether the room read Ask's setup", () => {
  const job = { slug: "acme", channel: { id: "chn_1" }, asked_at: 10_000 };
  const times = { setup_ms: 120, first_token_ms: 900, end_ms: 4_000, asked: true };
  const line = answerLog(job, 10_400, times, { state: "done", model: "m" });
  assert.deepEqual(line, {
    slug: "acme",
    channel_id: "chn_1",
    setup_read: true,
    asked: true,
    queued_ms: 400,
    setup_ms: 520,
    first_token_ms: 1_300,
    end_ms: 4_400,
    model: "m",
    state: "done",
  });
  // Handed the setup, and without the question's time: from the room's start.
  const handed = answerLog({ ...job, asked_at: undefined, setup: ready }, 10_400, { ...times, first_token_ms: null }, null);
  assert.equal(handed.setup_read, false);
  assert.equal(handed.queued_ms, 0);
  assert.equal(handed.first_token_ms, null);
  assert.equal(handed.state, null);
});
