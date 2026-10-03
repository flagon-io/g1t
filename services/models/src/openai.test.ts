import assert from "node:assert/strict";
import { test } from "node:test";

import { StreamTranslator, carryId, errorFromChat, fromChat, toChat, uncarryId } from "./openai.ts";

test("a conversation with tool calls becomes a chat completion", () => {
  const body = toChat(
    {
      system: [{ type: "text", text: "You are a coding agent." }],
      max_tokens: 4096,
      temperature: 0.2,
      stream: true,
      tools: [
        { name: "Bash", description: "Run a command", input_schema: { type: "object", properties: { command: { type: "string" } } } },
        { name: "web_search", type: "web_search_20250305" },
      ],
      messages: [
        { role: "user", content: "Fix the test." },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Running it." },
            { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "cargo test" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "1 failed" }] },
            { type: "text", text: "Keep going." },
          ],
        },
      ],
    },
    "gpt-5",
    { official: true },
  );
  assert.deepEqual(body.messages, [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: "Fix the test." },
    {
      role: "assistant",
      content: "Running it.",
      tool_calls: [{ id: "toolu_1", type: "function", function: { name: "Bash", arguments: '{"command":"cargo test"}' } }],
    },
    { role: "tool", tool_call_id: "toolu_1", content: "1 failed" },
    { role: "user", content: "Keep going." },
  ]);
  assert.equal(body.model, "gpt-5");
  assert.equal(body.max_completion_tokens, 4096);
  assert.equal(body.temperature, undefined);
  assert.deepEqual(body.stream_options, { include_usage: true });
  // Only functions cross over; Anthropic's server tools do not.
  assert.equal((body.tools as unknown[]).length, 1);
});

test("a compatible endpoint gets max_tokens and temperature", () => {
  const body = toChat({ messages: [{ role: "user", content: "hi" }], max_tokens: 10, temperature: 0.5 }, "llama", { official: false });
  assert.equal(body.max_tokens, 10);
  assert.equal(body.temperature, 0.5);
});

test("a completion comes back as an Anthropic message", () => {
  const message = fromChat(
    {
      id: "chatcmpl-1",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: "Let me look.",
            tool_calls: [{ id: "call_1", type: "function", function: { name: "Read", arguments: '{"file_path":"a.rs"}' } }],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    },
    "gpt-5",
  );
  assert.deepEqual(message.content, [
    { type: "text", text: "Let me look." },
    { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "a.rs" } },
  ]);
  assert.equal(message.stop_reason, "tool_use");
  assert.deepEqual(message.usage, { input_tokens: 10, output_tokens: 5 });
});

function events(sse: string): { type: string; [key: string]: unknown }[] {
  return sse
    .split("\n\n")
    .filter(Boolean)
    .map((block) => JSON.parse(block.split("\n")[1].slice(6)));
}

test("a streamed answer becomes Anthropic's stream, text then a tool call", () => {
  const translator = new StreamTranslator("gpt-5");
  const chunks = [
    { id: "c1", choices: [{ delta: { role: "assistant", content: "On it" } }] },
    { id: "c1", choices: [{ delta: { content: "." } }] },
    { id: "c1", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_9", function: { name: "Bash", arguments: '{"comm' } }] } }] },
    { id: "c1", choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] } }] },
    { id: "c1", choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    { id: "c1", choices: [], usage: { prompt_tokens: 12, completion_tokens: 7 } },
  ];
  // Delivered in awkward pieces, as networks do.
  const raw = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  let out = "";
  for (let at = 0; at < raw.length; at += 17) out += translator.push(raw.slice(at, at + 17));
  out += translator.finish();
  const seen = events(out);
  assert.deepEqual(
    seen.map((e) => e.type),
    [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ],
  );
  assert.deepEqual(seen[5].content_block, { type: "tool_use", id: "call_9", name: "Bash", input: {} });
  const json = seen
    .filter((e) => (e.delta as { type?: string } | undefined)?.type === "input_json_delta")
    .map((e) => (e.delta as { partial_json: string }).partial_json)
    .join("");
  assert.deepEqual(JSON.parse(json), { command: "ls" });
  assert.deepEqual(seen[9].delta, { stop_reason: "tool_use", stop_sequence: null });
  assert.deepEqual(seen[9].usage, { input_tokens: 12, output_tokens: 7 });
});

test("a provider's error keeps its status and says what it said", () => {
  const error = errorFromChat(429, JSON.stringify({ error: { message: "Rate limit reached" } }));
  assert.deepEqual(error, { type: "error", error: { type: "rate_limit_error", message: "The provider said: Rate limit reached" } });
});

test("each provider's quirks are met", () => {
  const ask = { messages: [{ role: "user" as const, content: "hi" }], max_tokens: 32000, stream: true, tool_choice: { type: "any" as const }, tools: [{ name: "Bash", input_schema: { type: "object" } }] };
  const deepseek = toChat(ask, "deepseek-chat", { official: false, provider: "deepseek" });
  assert.equal(deepseek.max_tokens, 8192);
  assert.equal(deepseek.tool_choice, "required");
  const mistral = toChat(ask, "mistral-large-latest", { official: false, provider: "mistral" });
  assert.equal(mistral.tool_choice, "any");
  assert.equal(mistral.stream_options, undefined);
});

test("what a provider attaches to a tool call comes back with it", () => {
  const signature = { google: { thought_signature: "c2lnbmF0dXJl+/==" } };
  const id = carryId("call_1", signature);
  assert.match(id, /^call_1__g1t_[A-Za-z0-9_-]+$/);
  assert.deepEqual(uncarryId(id), { id: "call_1", extra: signature });
  assert.deepEqual(uncarryId("toolu_plain"), { id: "toolu_plain", extra: undefined });

  const body = toChat(
    {
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
      ],
    },
    "gemini-3-pro",
    { official: false, provider: "gemini" },
  );
  const messages = body.messages as Record<string, unknown>[];
  assert.deepEqual((messages[1].tool_calls as Record<string, unknown>[])[0].extra_content, signature);
  assert.equal((messages[1].tool_calls as Record<string, unknown>[])[0].id, "call_1");
  assert.equal(messages[2].tool_call_id, "call_1");
});
