/**
 * How the AI Gateway page speaks of its requests. Pure, so it can be tested.
 */

import type { GatewayRequest } from "@g1t/contracts";

/** Where the AI Gateway is documented. */
export const GATEWAY_DOCS = "https://docs.g1t.sh/guides/ai-gateway/";

/** The base URL an Anthropic SDK or Claude Code is pointed at. */
export const GATEWAY_BASE_URL = "https://models.g1t.sh/anthropic";

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
