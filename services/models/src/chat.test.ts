import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ChatStreamTranslator,
  Untranslatable,
  anthropicEffort,
  anthropicToChat,
  chatToAnthropic,
  chatUsage,
  finishReason,
  openaiError,
} from "./chat.ts";
import { reasoningEffort, toChat } from "./openai.ts";

test("a chat request with tools becomes an Anthropic message", () => {
  const body = chatToAnthropic(
    {
      model: "anthropic/claude-haiku-5-5",
      messages: [
        { role: "system", content: "You are terse." },
        { role: "developer", content: [{ type: "text", text: "Use the tools." }] },
        { role: "user", content: "Weather in Lisbon?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "toolu_1", type: "function", function: { name: "weather", arguments: '{"city":"Lisbon"}' } }],
        },
        { role: "tool", tool_call_id: "toolu_1", content: "21C, clear" },
        { role: "user", content: [{ type: "text", text: "And tomorrow?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
      ],
      tools: [{ type: "function", function: { name: "weather", description: "Forecast", parameters: { type: "object", properties: { city: { type: "string" } } }, strict: true } }],
      tool_choice: "auto",
      parallel_tool_calls: false,
      max_completion_tokens: 512,
      temperature: 0.3,
      stop: "END",
      stream: true,
      reasoning_effort: "minimal",
      user: "ada",
    },
    "claude-haiku-5-5",
  );
  assert.deepEqual(body, {
    model: "claude-haiku-5-5",
    system: "You are terse.\n\nUse the tools.",
    messages: [
      { role: "user", content: [{ type: "text", text: "Weather in Lisbon?" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "weather", input: { city: "Lisbon" } }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "21C, clear" },
          { type: "text", text: "And tomorrow?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ],
      },
    ],
    max_tokens: 512,
    stream: true,
    temperature: 0.3,
    stop_sequences: ["END"],
    metadata: { user_id: "ada" },
    output_config: { effort: "low" },
    tools: [{ name: "weather", description: "Forecast", input_schema: { type: "object", properties: { city: { type: "string" } } }, strict: true }],
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
  });
});

test("tool choice, structured output and the default max tokens", () => {
  const forced = chatToAnthropic(
    {
      messages: [{ role: "user", content: "x" }],
      tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
      tool_choice: { type: "function", function: { name: "f" } },
      response_format: { type: "json_schema", json_schema: { name: "a", schema: { type: "object" } } },
    },
    "m",
  );
  assert.deepEqual(forced.tool_choice, { type: "tool", name: "f" });
  assert.deepEqual(forced.output_config, { format: { type: "json_schema", schema: { type: "object" } } });
  assert.equal(forced.max_tokens, 8192);
  assert.deepEqual(chatToAnthropic({ messages: [{ role: "user", content: "x" }], tool_choice: "required" }, "m").tool_choice, { type: "any" });
  assert.deepEqual(chatToAnthropic({ messages: [{ role: "user", content: "x" }], tool_choice: "none" }, "m").tool_choice, { type: "none" });
  const json = chatToAnthropic({ messages: [{ role: "user", content: "x" }], response_format: { type: "json_object" } }, "m");
  assert.match(String(json.system), /JSON object/);
  // Anthropic's own thinking settings pass through for a caller that knows them.
  assert.deepEqual(chatToAnthropic({ messages: [{ role: "user", content: "x" }], thinking: { type: "adaptive" } }, "m").thinking, { type: "adaptive" });
});

test("what cannot be said to Claude is refused, not dropped", () => {
  assert.throws(() => chatToAnthropic({ messages: [{ role: "user", content: "x" }], n: 2 }, "m"), Untranslatable);
  assert.throws(() => chatToAnthropic({ messages: [{ role: "user", content: [{ type: "input_audio" }] }] }, "m"), Untranslatable);
  assert.throws(() => chatToAnthropic({ messages: [{ role: "user", content: "x" }], tools: [{ type: "web_search" }] }, "m"), Untranslatable);
});

test("effort maps between the two formats", () => {
  assert.equal(anthropicEffort("minimal"), "low");
  assert.equal(anthropicEffort("none"), "low");
  assert.equal(anthropicEffort("high"), "high");
  assert.equal(anthropicEffort("bogus"), undefined);
  assert.equal(reasoningEffort("max"), "high");
  assert.equal(reasoningEffort("xhigh"), "high");
  assert.equal(reasoningEffort("medium"), "medium");
  // Anthropic-format effort and schemas reach an OpenAI-shaped provider.
  const body = toChat(
    { messages: [{ role: "user", content: "x" }], output_config: { effort: "max", format: { type: "json_schema", schema: { type: "object" } } } },
    "gpt-oss",
    { official: false },
  );
  assert.equal(body.reasoning_effort, "high");
  assert.deepEqual(body.response_format, { type: "json_schema", json_schema: { name: "answer", schema: { type: "object" }, strict: true } });
});

test("an Anthropic answer becomes a chat completion, thinking carried with its tool call", () => {
  const thinking = { type: "thinking", thinking: "Check the tool.", signature: "sig-abc" };
  const completion = anthropicToChat(
    {
      id: "msg_01",
      content: [thinking, { type: "text", text: "Looking." }, { type: "tool_use", id: "toolu_9", name: "weather", input: { city: "Lisbon" } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 },
    },
    "anthropic/claude-sonnet-5-5",
  );
  assert.equal(completion.object, "chat.completion");
  assert.equal(completion.model, "anthropic/claude-sonnet-5-5");
  const choice = (completion.choices as Record<string, unknown>[])[0]!;
  assert.equal(choice.finish_reason, "tool_calls");
  const message = choice.message as Record<string, unknown>;
  assert.equal(message.content, "Looking.");
  assert.equal(message.reasoning_content, "Check the tool.");
  const call = (message.tool_calls as { id: string; function: { name: string; arguments: string } }[])[0]!;
  assert.equal(call.function.name, "weather");
  assert.deepEqual(JSON.parse(call.function.arguments), { city: "Lisbon" });
  assert.deepEqual(completion.usage, { prompt_tokens: 1050, completion_tokens: 20, total_tokens: 1070, prompt_tokens_details: { cached_tokens: 900 } });

  // The next turn gives the call back; the thinking that led to it goes with it.
  const next = chatToAnthropic(
    {
      messages: [
        { role: "user", content: "Weather?" },
        { role: "assistant", content: "Looking.", tool_calls: [call] },
        { role: "tool", tool_call_id: call.id, content: "21C" },
      ],
    },
    "claude-sonnet-5-5",
  );
  const assistant = (next.messages as { role: string; content: Record<string, unknown>[] }[])[1]!;
  assert.deepEqual(assistant.content[0], thinking);
  assert.deepEqual(assistant.content[2], { type: "tool_use", id: "toolu_9", name: "weather", input: { city: "Lisbon" } });
  const result = (next.messages as { content: Record<string, unknown>[] }[])[2]!.content[0]!;
  assert.equal(result.tool_use_id, "toolu_9");
});

const sse = (events: object[]) => events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

/** The chunks a translator sends, parsed, and whether it ended with [DONE]. */
function chunks(out: string): { data: Record<string, unknown>[]; done: boolean } {
  const lines = out.split("\n").filter((line) => line.startsWith("data: "));
  const done = lines.at(-1) === "data: [DONE]";
  return { data: lines.filter((line) => line !== "data: [DONE]").map((line) => JSON.parse(line.slice(6))), done };
}

test("Anthropic's stream becomes chat chunks: text, reasoning, a tool call, the stop and the usage", () => {
  const stream = sse([
    { type: "message_start", message: { id: "msg_7", usage: { input_tokens: 10, cache_read_input_tokens: 300, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Hmm." } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Let me " } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "check." } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_2", name: "weather", input: {} } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"city":' } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"Lisbon"}' } },
    { type: "content_block_stop", index: 2 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } },
    { type: "message_stop" },
  ]);
  const translator = new ChatStreamTranslator("anthropic/claude-haiku-5-5", true);
  // Split mid-line, as chunks arrive.
  const out = translator.push(stream.slice(0, 101)) + translator.push(stream.slice(101)) + translator.finish();
  const { data, done } = chunks(out);
  assert.ok(done);
  assert.ok(data.every((chunk) => chunk.id === "chatcmpl-7" && chunk.object === "chat.completion.chunk"));
  const deltas = data.filter((chunk) => (chunk.choices as unknown[]).length).map((chunk) => (chunk.choices as { delta: Record<string, unknown> }[])[0]!.delta);
  assert.deepEqual(deltas[0], { role: "assistant", content: "" });
  assert.equal(deltas.map((d) => d.content ?? "").join(""), "Let me check.");
  assert.equal(deltas.map((d) => d.reasoning_content ?? "").join(""), "Hmm.");
  const calls = deltas.flatMap((d) => (d.tool_calls as Record<string, unknown>[] | undefined) ?? []);
  assert.equal(calls[0]!.index, 0);
  assert.equal((calls[0]!.function as { name: string }).name, "weather");
  assert.match(String(calls[0]!.id), /^toolu_2__g1t_/);
  assert.equal(calls.map((c) => (c.function as { arguments: string }).arguments).join(""), '{"city":"Lisbon"}');
  const last = data.filter((chunk) => (chunk.choices as unknown[]).length).at(-1)!;
  assert.equal((last.choices as { finish_reason: string }[])[0]!.finish_reason, "tool_calls");
  const usage = data.at(-1)!;
  assert.deepEqual(usage.choices, []);
  assert.deepEqual(usage.usage, { prompt_tokens: 310, completion_tokens: 42, total_tokens: 352, prompt_tokens_details: { cached_tokens: 300 } });
  // Finishing twice sends nothing more.
  assert.equal(translator.finish(), "");

  // The carried id brings the thinking back, signature and all.
  const back = chatToAnthropic(
    { messages: [{ role: "user", content: "x" }, { role: "assistant", content: "", tool_calls: [{ id: calls[0]!.id, type: "function", function: { name: "weather", arguments: "{}" } }] }] },
    "m",
  );
  const assistant = (back.messages as { content: Record<string, unknown>[] }[])[1]!;
  assert.deepEqual(assistant.content[0], { type: "thinking", thinking: "Hmm.", signature: "sig" });
});

test("a stream with no usage asked for ends without it, and an error ends it", () => {
  const plain = new ChatStreamTranslator("m", false);
  const out = plain.push(sse([{ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 3 } } }, { type: "message_stop" }]));
  const { data, done } = chunks(out);
  assert.ok(done);
  assert.ok(data.every((chunk) => !("usage" in chunk)));
  const failing = new ChatStreamTranslator("m", true);
  const error = chunks(failing.push(sse([{ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }])));
  assert.deepEqual(error.data[0], { error: { message: "Overloaded", type: "overloaded_error", param: null, code: null } });
  assert.ok(error.done);
  assert.equal(failing.finish(), "");
});

test("stop reasons, usage and errors in OpenAI's terms", async () => {
  assert.equal(finishReason("end_turn"), "stop");
  assert.equal(finishReason("max_tokens"), "length");
  assert.equal(finishReason("refusal"), "content_filter");
  assert.deepEqual(chatUsage(null), { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } });
  const refused = openaiError(402, "Out of AI credit.");
  assert.equal(refused.status, 402);
  assert.deepEqual(await refused.json(), { error: { message: "Out of AI credit.", type: "insufficient_quota", param: null, code: "insufficient_quota" } });
  assert.deepEqual(await openaiError(404, "No such model.").json(), {
    error: { message: "No such model.", type: "invalid_request_error", param: null, code: "model_not_found" },
  });
});
