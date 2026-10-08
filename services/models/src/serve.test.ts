import assert from "node:assert/strict";
import { test } from "node:test";

import type { GatewayModel, GatewayProvider, GatewayRecord, User } from "@g1t/contracts";

import { findOffered, listModels, matchPattern, routeModel } from "./catalogue.ts";
import { type GatewayDeps, serveGateway } from "./serve.ts";

// --- The catalogue and the workspace's own providers ---------------------------

const model = (row: Partial<GatewayModel> & Pick<GatewayModel, "model" | "name" | "provider">): GatewayModel => ({
  kind: "chat",
  inputMicros: 0,
  outputMicros: 0,
  cacheReadMicros: 0,
  cacheWriteMicros: 0,
  ...row,
});

const OFFERED: GatewayModel[] = [
  model({
    model: "claude-haiku-5-5",
    name: "Claude Haiku 5.5",
    provider: "anthropic",
    inputMicros: 100_000,
    outputMicros: 500_000,
    cacheReadMicros: 10_000,
    cacheWriteMicros: 125_000,
    cacheWrite1hMicros: 200_000,
    threshold: 100_000,
    overInputMicros: 500_000,
    overOutputMicros: 2_500_000,
    overCacheReadMicros: 50_000,
    overCacheWriteMicros: 625_000,
    overCacheWrite1hMicros: 1_000_000,
  }),
  model({ model: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", provider: "anthropic", inputMicros: 2_000_000, outputMicros: 10_000_000 }),
  model({ model: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic" }),
  model({ model: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", provider: "anthropic" }),
  model({ model: "@cf/openai/gpt-oss-120b", name: "gpt-oss-120b", provider: "workers-ai", inputMicros: 350_000, outputMicros: 750_000 }),
  model({ model: "@cf/baai/bge-m3", name: "BGE M3", provider: "workers-ai", kind: "embeddings", inputMicros: 12_000 }),
];

const KEY = "sk-own-0123456789abcdefghij";

const provider = (row: Partial<GatewayProvider> & Pick<GatewayProvider, "provider" | "api" | "patterns">): GatewayProvider => ({
  id: "con_1",
  name: "Ours",
  official: false,
  baseUrl: "https://llm.acme.dev/v1",
  apiKey: KEY,
  authHeader: "authorization",
  gatewayToken: null,
  models: [],
  ...row,
});

const OLLAMA = provider({ id: "con_ollama", name: "Ollama", provider: "openai_endpoint", api: "openai", patterns: ["ollama/*"], models: ["llama3.3", "qwen3"] });
const OPENAI = provider({ id: "con_openai", name: "OpenAI", provider: "openai", api: "openai", official: true, baseUrl: "https://api.openai.com/v1", patterns: ["gpt-*"], models: ["gpt-5.5", "gpt-5.5-mini"] });
const ANTHROPIC = provider({ id: "con_anthropic", name: "Our Anthropic key", provider: "anthropic", api: "anthropic", baseUrl: "https://api.anthropic.com", authHeader: "x-api-key", patterns: ["claude-*"] });

test("patterns take models by id, prefix or namespace", () => {
  assert.equal(matchPattern("gpt-5.5", "gpt-5.5"), "gpt-5.5");
  assert.equal(matchPattern("gpt-5.5", "gpt-5.5-mini"), null);
  assert.equal(matchPattern("gpt-*", "gpt-5.5-mini"), "gpt-5.5-mini");
  assert.equal(matchPattern("ollama/*", "ollama/llama3.3"), "llama3.3");
  assert.equal(matchPattern("ollama/*", "ollama/"), null);
  assert.equal(matchPattern("ollama/*", "llama3.3"), null);
  assert.equal(matchPattern("*", "anything"), "anything");
});

test("a catalogue model is found by its own id or with its provider in front", () => {
  assert.equal(findOffered("claude-sonnet-5-5", OFFERED)?.model, "claude-sonnet-5-5");
  assert.equal(findOffered("anthropic/claude-sonnet-5-5", OFFERED)?.model, "claude-sonnet-5-5");
  assert.equal(findOffered("workers-ai/@cf/openai/gpt-oss-120b", OFFERED)?.provider, "workers-ai");
  assert.equal(findOffered("@cf/openai/gpt-oss-120b", OFFERED)?.provider, "workers-ai");
  // A provider that does not offer it.
  assert.equal(findOffered("workers-ai/claude-sonnet-5-5", OFFERED), null);
});

test("the workspace's own providers come first, then g1t's catalogue", () => {
  const providers = [OLLAMA, OPENAI, ANTHROPIC];
  const own = routeModel("ollama/qwen3", "chat", providers, OFFERED);
  assert.ok(own.to === "own");
  assert.equal(own.provider.id, "con_ollama");
  assert.equal(own.model, "qwen3");
  // Its own Anthropic key takes Claude, by its bare id or the catalogue's.
  const claude = routeModel("anthropic/claude-sonnet-5-5", "chat", providers, OFFERED);
  assert.ok(claude.to === "own" && claude.provider.id === "con_anthropic" && claude.model === "claude-sonnet-5-5");
  // Without one, Claude is g1t's.
  const hosted = routeModel("claude-sonnet-5-5", "chat", [OLLAMA], OFFERED);
  assert.ok(hosted.to === "g1t" && hosted.api === "anthropic" && hosted.model === "claude-sonnet-5-5");
  const open = routeModel("workers-ai/@cf/openai/gpt-oss-120b", "chat", [], OFFERED);
  assert.ok(open.to === "g1t" && open.api === "openai" && open.model === "@cf/openai/gpt-oss-120b");
});

test("a model nobody offers, or of the wrong kind, goes nowhere and says why", () => {
  const none = routeModel("gpt-5.5", "chat", [], OFFERED);
  assert.ok(none.to === "none");
  assert.equal(none.status, 404);
  assert.match(none.message, /gpt-5\.5 is not offered/);
  assert.match(none.message, /anthropic\/claude-haiku-5-5, anthropic\/claude-sonnet-5-5/);
  assert.doesNotMatch(none.message, /bge-m3/);
  assert.match(none.message, /connect the workspace's own provider/);
  const embedChat = routeModel("@cf/baai/bge-m3", "chat", [], OFFERED);
  assert.ok(embedChat.to === "none" && embedChat.status === 400 && /embeddings model/.test(embedChat.message));
  const chatEmbed = routeModel("claude-haiku-5-5", "embeddings", [], OFFERED);
  assert.ok(chatEmbed.to === "none" && /chat model/.test(chatEmbed.message));
  const missing = routeModel(undefined, "chat", [], OFFERED);
  assert.ok(missing.to === "none" && missing.status === 400);
  const anthropicEmbed = routeModel("claude-x", "embeddings", [ANTHROPIC], OFFERED);
  assert.ok(anthropicEmbed.to === "none" && /no embeddings/.test(anthropicEmbed.message));
});

test("the models list: the workspace's own, then the catalogue with g1t's prices, each once", () => {
  const listed = listModels([OLLAMA, OPENAI], OFFERED);
  const ids = listed.map((m) => m.id);
  assert.deepEqual(ids, [
    "ollama/llama3.3",
    "ollama/qwen3",
    "gpt-5.5",
    "gpt-5.5-mini",
    "anthropic/claude-haiku-5-5",
    "anthropic/claude-sonnet-5-5",
    "anthropic/claude-haiku-4-5",
    "workers-ai/@cf/openai/gpt-oss-120b",
    "workers-ai/@cf/baai/bge-m3",
  ]);
  const ollama = listed[0]!;
  assert.equal(ollama.billed_to, "workspace");
  assert.equal(ollama.connection, "Ollama");
  assert.equal(ollama.pricing, null);
  const haiku = listed.find((m) => m.id === "anthropic/claude-haiku-5-5")!;
  assert.equal(haiku.billed_to, "g1t");
  assert.deepEqual(haiku.pricing, {
    currency: "usd",
    input: 0.1,
    output: 0.5,
    cache_read: 0.01,
    cache_write: 0.125,
    cache_write_1h: 0.2,
    long_prompt: { above_tokens: 100_000, input: 0.5, output: 2.5, cache_read: 0.05, cache_write: 0.625, cache_write_1h: 1 },
  });
  assert.equal(listed.find((m) => m.id.endsWith("bge-m3"))!.kind, "embeddings");
  // With its own Anthropic key, the catalogue's Claude is the workspace's.
  const mine = listModels([ANTHROPIC], OFFERED).find((m) => m.id === "anthropic/claude-sonnet-5-5")!;
  assert.equal(mine.billed_to, "workspace");
  assert.equal(mine.pricing, null);
});

// --- Serving, end to end, with no network ---------------------------------------

const WORKSPACE_TOKEN: User = {
  id: "wsp_1",
  username: "acme",
  kind: "workspace",
  workspaces: [{ slug: "acme", role: "member" }],
  token: { token_id: "tok_1", scopes: ["models:write"], name: "ci" },
};

type Sent = { url: string; headers: Headers; body: Record<string, unknown> };

function harness(options: {
  providers?: GatewayProvider[];
  admit?: string | null;
  user?: User | null;
  answer: (sent: Sent) => Response;
}) {
  const sent: Sent[] = [];
  const records: GatewayRecord[] = [];
  const pending: Promise<unknown>[] = [];
  let admitted = 0;
  const deps: GatewayDeps = {
    hosted: { AI_GATEWAY_ID: "g1t", CLOUDFLARE_ACCOUNT_ID: "acct", AI_GATEWAY_TOKEN: "aig-secret-token", WORKERS_AI_TOKEN: "wai-secret-token" },
    caller: async () => (options.user === undefined ? WORKSPACE_TOKEN : options.user),
    providers: async () => options.providers ?? [],
    offered: async () => OFFERED,
    admit: async () => {
      admitted += 1;
      return options.admit ?? null;
    },
    record: async (record) => {
      records.push(record);
    },
    fetch: async (url, init) => {
      const one = { url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) as Record<string, unknown> };
      sent.push(one);
      return options.answer(one);
    },
    waitUntil: (promise) => {
      pending.push(promise);
    },
  };
  return {
    deps,
    sent,
    records,
    admitted: () => admitted,
    settled: () => Promise.all(pending),
  };
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://models.g1t.sh${path}`, {
    method: "POST",
    headers: { authorization: "Bearer g1t_workspace_token", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const json = (body: unknown, status = 200) => Response.json(body, { status });
const stream = (text: string) => new Response(text, { headers: { "content-type": "text/event-stream" } });
const sse = (events: object[]) => events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

const MESSAGE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-haiku-5-5",
  content: [{ type: "text", text: "Hello." }],
  stop_reason: "end_turn",
  usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 15 } },
};

test("OpenAI's format reaches g1t's Claude, translated, and is charged by Claude's own usage", async () => {
  const h = harness({ answer: () => json(MESSAGE) });
  const response = await serveGateway(
    post("/openai/v1/chat/completions", { model: "anthropic/claude-haiku-5-5", messages: [{ role: "user", content: "Hi" }], reasoning_effort: "low" }),
    "g1t_workspace_token",
    h.deps,
  );
  assert.equal(response.status, 200);
  const completion = (await response.json()) as { object: string; model: string; choices: { message: { content: string } }[]; usage: unknown };
  assert.equal(completion.object, "chat.completion");
  assert.equal(completion.model, "anthropic/claude-haiku-5-5");
  assert.equal(completion.choices[0]!.message.content, "Hello.");
  assert.match(response.headers.get("x-g1t-request-id") ?? "", /^gw_/);
  await h.settled();

  const [sent] = h.sent;
  assert.equal(sent!.url, "https://gateway.ai.cloudflare.com/v1/acct/g1t/anthropic/v1/messages");
  assert.equal(sent!.body.model, "claude-haiku-5-5");
  assert.deepEqual(sent!.body.output_config, { effort: "low" });
  assert.equal(sent!.headers.get("authorization"), null);
  assert.equal(sent!.headers.get("anthropic-version"), "2023-06-01");
  assert.equal(sent!.headers.get("cf-aig-authorization"), "Bearer aig-secret-token");
  assert.equal(h.admitted(), 1);

  const [record] = h.records;
  assert.equal(record!.format, "openai");
  assert.equal(record!.provider, "anthropic");
  assert.equal(record!.model, "claude-haiku-5-5");
  assert.equal(record!.ownKey, false);
  assert.equal(record!.connection, null);
  assert.deepEqual([record!.input, record!.output, record!.cacheRead, record!.cacheWrite, record!.cacheWriteHour], [12, 4, 100, 20, 15]);
});

test("a streamed OpenAI-format request to Claude streams chat chunks and counts the tokens", async () => {
  const events = sse([
    { type: "message_start", message: { id: "msg_2", usage: { input_tokens: 7, cache_read_input_tokens: 50, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi there" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } },
    { type: "message_stop" },
  ]);
  const h = harness({ answer: () => stream(events) });
  const response = await serveGateway(
    post("/openai/v1/chat/completions", { model: "claude-sonnet-5-5", stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "Hi" }] }),
    "g1t_workspace_token",
    h.deps,
  );
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const text = await response.text();
  assert.match(text, /"content":"Hi there"/);
  assert.match(text, /"finish_reason":"stop"/);
  assert.match(text, /"prompt_tokens":57/);
  assert.ok(text.trimEnd().endsWith("data: [DONE]"));
  await h.settled();
  assert.equal(h.sent[0]!.body.stream, true);
  const [record] = h.records;
  assert.deepEqual([record!.input, record!.output, record!.cacheRead], [7, 9, 50]);
  assert.equal(record!.streamed, true);
});

test("Anthropic's format reaches an open model on Workers AI, translated both ways", async () => {
  const h = harness({
    answer: () =>
      json({
        id: "chatcmpl-1",
        model: "@cf/openai/gpt-oss-120b",
        choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: '{"a":1}' } }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 200, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 50 } },
      }),
  });
  const response = await serveGateway(
    post("/anthropic/v1/messages", {
      model: "workers-ai/@cf/openai/gpt-oss-120b",
      max_tokens: 100,
      tools: [{ name: "f", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: "call f" }],
    }),
    "g1t_workspace_token",
    h.deps,
  );
  const message = (await response.json()) as { type: string; stop_reason: string; content: { type: string; input?: unknown }[]; usage: unknown };
  assert.equal(message.type, "message");
  assert.equal(message.stop_reason, "tool_use");
  assert.deepEqual(message.content[0], { type: "tool_use", id: "call_1", name: "f", input: { a: 1 } });
  assert.deepEqual(message.usage, { input_tokens: 150, output_tokens: 30, cache_read_input_tokens: 50 });
  await h.settled();
  const [sent] = h.sent;
  assert.equal(sent!.url, "https://gateway.ai.cloudflare.com/v1/acct/g1t/workers-ai/v1/chat/completions");
  assert.equal(sent!.headers.get("authorization"), "Bearer wai-secret-token");
  assert.equal(sent!.body.model, "@cf/openai/gpt-oss-120b");
  assert.equal((sent!.body.tools as unknown[]).length, 1);
  const [record] = h.records;
  assert.equal(record!.format, "anthropic");
  assert.equal(record!.provider, "workers-ai");
  assert.equal(record!.model, "@cf/openai/gpt-oss-120b");
  assert.deepEqual([record!.input, record!.output, record!.cacheRead], [150, 30, 50]);
});

test("the workspace's own endpoint gets the request with its key, never admitted or charged", async () => {
  const h = harness({
    providers: [OLLAMA],
    answer: () => json({ id: "c", model: "qwen3", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
  });
  const response = await serveGateway(post("/openai/v1/chat/completions", { model: "ollama/qwen3", messages: [{ role: "user", content: "hi" }] }), "g1t_workspace_token", h.deps);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.doesNotMatch(body, new RegExp(KEY));
  await h.settled();
  const [sent] = h.sent;
  assert.equal(sent!.url, "https://llm.acme.dev/v1/chat/completions");
  assert.equal(sent!.body.model, "qwen3");
  assert.equal(sent!.headers.get("authorization"), `Bearer ${KEY}`);
  assert.equal(sent!.headers.get("cf-aig-metadata"), null);
  assert.equal(h.admitted(), 0);
  const [record] = h.records;
  assert.equal(record!.ownKey, true);
  assert.equal(record!.provider, "openai_endpoint");
  assert.equal(record!.connection, "Ollama");
  assert.equal(record!.model, "qwen3");
  assert.deepEqual([record!.input, record!.output], [5, 2]);
});

test("an Anthropic-format request on the workspace's own Anthropic key passes through", async () => {
  const h = harness({ providers: [ANTHROPIC], answer: () => json(MESSAGE) });
  const response = await serveGateway(
    post("/anthropic/v1/messages", { model: "claude-haiku-5-5", max_tokens: 10, tools: [{ type: "web_search_20260209", name: "web_search" }], messages: [] }, { "x-api-key": "g1t_workspace_token", "anthropic-beta": "x" }),
    "g1t_workspace_token",
    h.deps,
  );
  // Server tools are the provider's to bill on the workspace's own key.
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), MESSAGE);
  await h.settled();
  const [sent] = h.sent;
  assert.equal(sent!.url, "https://api.anthropic.com/v1/messages");
  assert.equal(sent!.headers.get("x-api-key"), KEY);
  assert.equal(sent!.headers.get("anthropic-beta"), "x");
  assert.equal(h.admitted(), 0);
  assert.equal(h.records[0]!.ownKey, true);
});

test("an own provider's error never shows its key, to the caller or the log", async () => {
  const leak = { error: { message: `Incorrect API key provided: ${KEY}. Also ${KEY.slice(0, 20)}...`, type: "invalid_request_error", code: "invalid_api_key" } };
  const h = harness({ providers: [OPENAI], answer: () => json(leak, 401) });
  const response = await serveGateway(post("/openai/v1/chat/completions", { model: "gpt-5.5", messages: [{ role: "user", content: "x" }] }), "g1t_workspace_token", h.deps);
  assert.equal(response.status, 401);
  const text = await response.text();
  assert.doesNotMatch(text, new RegExp(KEY.slice(0, 12)));
  assert.match(text, /OpenAI refused the workspace's key/);
  assert.match(text, /\[redacted\]/);
  await h.settled();
  assert.doesNotMatch(h.records[0]!.error ?? "", new RegExp(KEY.slice(0, 12)));
  assert.equal(h.records[0]!.status, 401);
  // And the Anthropic-format view of the same.
  const a = harness({ providers: [ANTHROPIC], answer: () => json({ type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${KEY}` } }, 401) });
  const refused = await serveGateway(post("/anthropic/v1/messages", { model: "claude-sonnet-5-5", max_tokens: 5, messages: [] }), "g1t_workspace_token", a.deps);
  const body = (await refused.json()) as { type: string; error: { type: string; message: string } };
  assert.equal(body.error.type, "authentication_error");
  assert.doesNotMatch(body.error.message, new RegExp(KEY.slice(0, 12)));
});

test("refusals: unknown model, unpriced features, no credit, a token without the scope", async () => {
  const never = () => {
    throw new Error("nothing should be sent");
  };
  const unknown = harness({ answer: never });
  const missing = await serveGateway(post("/openai/v1/chat/completions", { model: "gpt-5.5", messages: [] }), "g1t_workspace_token", unknown.deps);
  assert.equal(missing.status, 404);
  const error = ((await missing.json()) as { error: { code: string; message: string } }).error;
  assert.equal(error.code, "model_not_found");
  assert.match(error.message, /not offered/);
  await unknown.settled();
  assert.equal(unknown.records[0]!.status, 404);
  assert.equal(unknown.records[0]!.format, "openai");

  const search = harness({ answer: never });
  const searched = await serveGateway(post("/openai/v1/chat/completions", { model: "claude-sonnet-5-5", web_search_options: {}, messages: [] }), "g1t_workspace_token", search.deps);
  assert.equal(searched.status, 400);
  assert.equal(search.admitted(), 0);

  const fast = harness({ answer: never });
  const fastAnswer = await serveGateway(post("/anthropic/v1/messages", { model: "claude-sonnet-5-5", speed: "fast", max_tokens: 1, messages: [] }), "g1t_workspace_token", fast.deps);
  assert.equal(fastAnswer.status, 400);
  assert.equal(((await fastAnswer.json()) as { error: { type: string } }).error.type, "invalid_request_error");

  const broke = harness({ admit: "The acme workspace is out of AI credit.", answer: never });
  const poor = await serveGateway(post("/openai/v1/chat/completions", { model: "claude-sonnet-5-5", messages: [] }), "g1t_workspace_token", broke.deps);
  assert.equal(poor.status, 402);
  assert.equal(((await poor.json()) as { error: { type: string } }).error.type, "insufficient_quota");
  const poorAnthropic = await serveGateway(post("/anthropic/v1/messages", { model: "claude-sonnet-5-5", max_tokens: 1, messages: [] }), "g1t_workspace_token", broke.deps);
  assert.equal(((await poorAnthropic.json()) as { error: { type: string } }).error.type, "billing_error");

  const reader = harness({ user: { ...WORKSPACE_TOKEN, token: { token_id: "tok_2", scopes: ["models:read"] } }, answer: never });
  const forbidden = await serveGateway(post("/openai/v1/chat/completions", { model: "claude-sonnet-5-5", messages: [] }), "g1t_x", reader.deps);
  assert.equal(forbidden.status, 403);
  await reader.settled();
  assert.equal(reader.records.length, 0);

  const translation = harness({ answer: never });
  const many = await serveGateway(post("/openai/v1/chat/completions", { model: "claude-sonnet-5-5", n: 3, messages: [] }), "g1t_workspace_token", translation.deps);
  assert.equal(many.status, 400);
  assert.match(((await many.json()) as { error: { message: string } }).error.message, /answer once/);
});

test("the models route lists what the workspace can use, in OpenAI's shape", async () => {
  const h = harness({ providers: [OPENAI], answer: () => json({}) });
  const response = await serveGateway(
    new Request("https://models.g1t.sh/openai/v1/models", { headers: { authorization: "Bearer g1t_workspace_token" } }),
    "g1t_workspace_token",
    h.deps,
  );
  const listed = (await response.json()) as { object: string; data: { id: string; billed_to: string }[] };
  assert.equal(listed.object, "list");
  assert.equal(listed.data[0]!.id, "gpt-5.5");
  assert.ok(listed.data.some((m) => m.id === "anthropic/claude-haiku-5-5" && m.billed_to === "g1t"));
  assert.equal(h.sent.length, 0);
});

test("embeddings go to Workers AI and are charged by their input", async () => {
  const h = harness({ answer: () => json({ object: "list", data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }], model: "@cf/baai/bge-m3", usage: { prompt_tokens: 8, total_tokens: 8 } }) });
  const response = await serveGateway(post("/openai/v1/embeddings", { model: "workers-ai/@cf/baai/bge-m3", input: "hello" }), "g1t_workspace_token", h.deps);
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { data: unknown[] }).data.length, 1);
  await h.settled();
  assert.equal(h.sent[0]!.url, "https://gateway.ai.cloudflare.com/v1/acct/g1t/workers-ai/v1/embeddings");
  assert.equal(h.records[0]!.model, "@cf/baai/bge-m3");
  assert.equal(h.records[0]!.input, 8);
});

test("counting tokens for an open model is estimated, and never logged", async () => {
  const h = harness({ answer: () => json({}) });
  const response = await serveGateway(
    post("/anthropic/v1/messages/count_tokens", { model: "@cf/openai/gpt-oss-120b", messages: [{ role: "user", content: "x".repeat(400) }] }),
    "g1t_workspace_token",
    h.deps,
  );
  const counted = (await response.json()) as { input_tokens: number };
  assert.ok(counted.input_tokens > 100);
  await h.settled();
  assert.equal(h.sent.length, 0);
  assert.equal(h.records.length, 0);
});

test("a route the gateway does not have is answered in the caller's format", async () => {
  const h = harness({ answer: () => json({}) });
  const openai = await serveGateway(post("/openai/v1/responses", {}), "g1t_workspace_token", h.deps);
  assert.equal(openai.status, 404);
  assert.match(((await openai.json()) as { error: { message: string } }).error.message, /chat\/completions/);
  const anthropic = await serveGateway(post("/anthropic/v1/messages/batches", {}), "g1t_workspace_token", h.deps);
  assert.equal(((await anthropic.json()) as { type: string }).type, "error");
});
