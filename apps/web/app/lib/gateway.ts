/**
 * How the AI Gateway page speaks of its requests. Pure, so it can be tested.
 */

import type { GatewayRequest } from "@g1t/contracts";

/** Where the AI Gateway is documented. */
export const GATEWAY_DOCS = "https://docs.g1t.sh/guides/ai-gateway/";

/** The base URL an Anthropic SDK or Claude Code is pointed at. */
export const GATEWAY_BASE_URL = "https://models.g1t.sh/anthropic";

/** The base URL an OpenAI SDK, or any tool that speaks OpenAI's API, is pointed at. */
export const GATEWAY_OPENAI_BASE_URL = "https://models.g1t.sh/openai/v1";

/** How a request's format reads. */
export function formatLabel(format: GatewayRequest["format"] | undefined): string {
  return format === "openai" ? "OpenAI" : "Anthropic";
}

/** Who served a request, as people read it, and a longer line for its hint. */
export function servedBy(request: Pick<GatewayRequest, "ownKey" | "provider" | "connection">): { label: string; hint: string } {
  if (request.ownKey) {
    const name = request.connection || "Your provider";
    return { label: name, hint: `${name}, the workspace's own ${providerName(request.provider)}: counted, not charged.` };
  }
  if (!request.provider) return { label: "None", hint: "Refused before it reached a model." };
  return { label: `g1t · ${providerName(request.provider)}`, hint: `g1t's account at ${providerName(request.provider)}, charged at the model's price.` };
}

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  "workers-ai": "Workers AI",
  openai: "OpenAI",
  openai_endpoint: "OpenAI-compatible endpoint",
  anthropic_endpoint: "Anthropic-compatible endpoint",
  azure_openai: "Azure OpenAI",
  gemini: "Google Gemini",
  openrouter: "OpenRouter",
};

/** A provider's name, as people know it. */
export function providerName(provider: string): string {
  return PROVIDER_NAMES[provider] ?? (provider || "provider");
}

/** A connection's AI Gateway models, as a field shows them, from what was typed. */
export function parseGatewayModels(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((model) => model.trim())
    .filter(Boolean);
}

/** A count of tokens, short: `812`, `12.4K`, `3.1M`. */
export function shortCount(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${trim(n / 1_000)}K`;
  return `${trim(n / 1_000_000)}M`;
}

function trim(value: number): string {
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
}

/** Every token a request used. */
export function totalTokens(request: Pick<GatewayRequest, "input" | "output" | "cacheRead" | "cacheWrite">): number {
  return request.input + request.output + request.cacheRead + request.cacheWrite;
}

/** The tokens of each kind, in words, for a hint. */
export function tokenKinds(request: Pick<GatewayRequest, "input" | "output" | "cacheRead" | "cacheWrite">): string {
  const n = (v: number) => v.toLocaleString("en-US");
  return `${n(request.input)} input, ${n(request.output)} output, ${n(request.cacheRead)} cache read, ${n(request.cacheWrite)} cache write`;
}

/** A request's cache tokens in words, for a hint: read, written, and how many of the writes last an hour. */
export function cacheKinds(request: Pick<GatewayRequest, "cacheRead" | "cacheWrite" | "cacheWriteHour">): string {
  const n = (v: number) => v.toLocaleString("en-US");
  const hour = request.cacheWriteHour ? `, ${n(request.cacheWriteHour)} of them to the hour-long cache` : "";
  return `${n(request.cacheRead)} read from the cache, ${n(request.cacheWrite)} written${hour}`;
}

/** How a status reads, and how much it matters. */
export function statusTone(status: number): { label: string; tone: "success" | "warn" | "danger" | "neutral" } {
  if (status >= 200 && status < 300) return { label: String(status), tone: "success" };
  if (status === 402 || status === 429) return { label: String(status), tone: "warn" };
  if (status >= 400) return { label: String(status), tone: "danger" };
  return { label: String(status), tone: "neutral" };
}

/** A request's duration: `840 ms`, `4.2 s`, `2 min 5 s`. */
export function duration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1).replace(/\.0$/, "")} s`;
  const seconds = Math.round(ms / 1_000);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}
