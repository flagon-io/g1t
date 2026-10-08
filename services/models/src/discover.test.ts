import assert from "node:assert/strict";
import { test } from "node:test";

import type { DiscoveryResult, ProviderModel } from "@g1t/contracts";

import { type Fetch, anthropicRequest, discover, fromAnthropic, fromWorkersAi, listAnthropic, listWorkersAi } from "./discover.ts";

const hosted = { AI_GATEWAY_ID: "g1t", CLOUDFLARE_ACCOUNT_ID: "acct", AI_GATEWAY_TOKEN: "aig-secret", WORKERS_AI_TOKEN: "wai-secret" };

function answering(pages: Record<string, unknown>, seen: { url: string; headers: Headers }[] = []): Fetch {
  return async (url, init) => {
    seen.push({ url, headers: new Headers(init?.headers) });
    const key = Object.keys(pages).find((prefix) => url.includes(prefix));
    if (!key) return new Response("not found", { status: 404 });
    return Response.json(pages[key]);
  };
}

test("Anthropic's list is read through g1t's gateway, with its token and never a model call", () => {
  const request = anthropicRequest(hosted, null)!;
  assert.equal(request.url, "https://gateway.ai.cloudflare.com/v1/acct/g1t/anthropic/v1/models?limit=1000");
  assert.equal(request.headers.get("cf-aig-authorization"), "Bearer aig-secret");
  assert.equal(request.headers.get("anthropic-version"), "2023-06-01");
  assert.equal(anthropicRequest(hosted, "claude-x")!.url.endsWith("&after_id=claude-x"), true);
  // Without a gateway, straight to Anthropic with g1t's key; with neither, no way.
  assert.equal(anthropicRequest({ AI_GATEWAY_ID: "", CLOUDFLARE_ACCOUNT_ID: "acct", ANTHROPIC_API_KEY: "sk" }, null)!.url, "https://api.anthropic.com/v1/models?limit=1000");
  assert.equal(anthropicRequest({ AI_GATEWAY_ID: "", CLOUDFLARE_ACCOUNT_ID: "acct" }, null), null);
});

test("an Anthropic model's context window and capabilities come from its list entry", () => {
  const model = fromAnthropic({
    id: "claude-haiku-6",
    display_name: "Claude Haiku 6",
    max_input_tokens: 400000,
    max_tokens: 64000,
    capabilities: { effort: { supported: true }, thinking: { supported: true }, image_input: { supported: false } },
  });
  assert.deepEqual(model, {
    id: "claude-haiku-6",
    name: "Claude Haiku 6",
    kind: "chat",
    contextWindow: 400000,
    maxOutput: 64000,
    capabilities: ["effort", "thinking", "tools"],
    price: null,
  });
  assert.equal(fromAnthropic({ display_name: "No id" }), null);
  // An older list with no capability tree: nothing claimed.
  assert.deepEqual(fromAnthropic({ id: "claude-haiku-4-5-20251001" })!.capabilities, []);
});

test("Anthropic's list is read page by page", async () => {
  const seen: { url: string; headers: Headers }[] = [];
  const fetcher: Fetch = async (url, init) => {
    seen.push({ url, headers: new Headers(init?.headers) });
    return url.includes("after_id=claude-b")
      ? Response.json({ data: [{ id: "claude-c" }], has_more: false, last_id: "claude-c" })
      : Response.json({ data: [{ id: "claude-a" }, { id: "claude-b" }], has_more: true, last_id: "claude-b" });
  };
  const models = await listAnthropic(hosted, fetcher);
  assert.deepEqual(models.map((m) => m.id), ["claude-a", "claude-b", "claude-c"]);
  assert.equal(seen.length, 2);
  await assert.rejects(listAnthropic(hosted, async () => new Response("nope", { status: 401 })), /answered 401/);
});

test("a Workers AI model's kind, context and price come from its search entry", () => {
  const chat = fromWorkersAi({
    name: "@cf/meta/llama-5-70b",
    task: { name: "Text Generation" },
    properties: [
      { property_id: "context_window", value: "131072" },
      { property_id: "function_calling", value: "true" },
      { property_id: "price", value: [{ unit: "per M input tokens", price: 0.29 }, { unit: "per M output tokens", price: 2.25 }] },
    ],
  })!;
  assert.deepEqual(chat, {
    id: "@cf/meta/llama-5-70b",
    name: "llama-5-70b",
    kind: "chat",
    contextWindow: 131072,
    maxOutput: 0,
    capabilities: ["tools"],
    price: { inputMicros: 290000, outputMicros: 2250000 },
  });
  const embed = fromWorkersAi({ name: "@cf/baai/bge-large-en-v1.5", task: { name: "Text Embeddings" }, properties: [] })!;
  assert.equal(embed.kind, "embeddings");
  assert.deepEqual(embed.capabilities, ["embeddings"]);
  assert.equal(embed.price, null);
  assert.equal(fromWorkersAi({ name: "@cf/openai/whisper", task: { name: "Automatic Speech Recognition" } })!.kind, "automatic-speech-recognition");
});

test("Workers AI's search is read with the Workers AI token", async () => {
  const seen: { url: string; headers: Headers }[] = [];
  const models = await listWorkersAi(
    hosted,
    answering({ "ai/models/search": { result: [{ name: "@cf/openai/gpt-oss-120b", task: { name: "Text Generation" } }] } }, seen),
  );
  assert.deepEqual(models.map((m) => m.id), ["@cf/openai/gpt-oss-120b"]);
  assert.equal(seen[0].url, "https://api.cloudflare.com/client/v4/accounts/acct/ai/models/search?per_page=100&page=1");
  assert.equal(seen[0].headers.get("authorization"), "Bearer wai-secret");
});

test("every provider is recorded, a failed one as a failed check without its key", async () => {
  const recorded: { provider: string; models: ProviderModel[]; by: string; error: string | null }[] = [];
  const record = async (provider: string, models: ProviderModel[], by: string, error: string | null): Promise<DiscoveryResult> => {
    recorded.push({ provider, models, by, error });
    return { provider, checkedAt: "", by, listed: models.length, added: [], deprecated: [], restored: [], error };
  };
  const fetcher: Fetch = async (url) =>
    url.includes("anthropic")
      ? Response.json({ data: [{ id: "claude-haiku-5-5" }], has_more: false })
      : new Response("token wai-secret is not allowed", { status: 403 });
  const results = await discover(hosted, fetcher, record, "staff@g1t.sh");
  assert.deepEqual(results.map((r) => [r.provider, r.listed]), [["anthropic", 1], ["workers-ai", 0]]);
  assert.equal(recorded[0].by, "staff@g1t.sh");
  assert.equal(recorded[0].error, null);
  assert.match(recorded[1].error!, /answered 403/);
  assert.doesNotMatch(recorded[1].error!, /wai-secret/);
  // An empty list is a failed check, never every model gone.
  await discover(hosted, async () => Response.json({ data: [], result: [] }), record, "");
  assert.equal(recorded[2].error, "The list was empty.");
  assert.equal(recorded[2].by, "schedule");
});
