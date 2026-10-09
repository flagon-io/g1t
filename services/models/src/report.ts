/**
 * What the proxy tells billing about one answer: its tokens, under the
 * run's session and the person it is for, for usage views. Billing still
 * prices runs from AI Gateway, not from these.
 */
import type { ModelUpstream } from "@g1t/contracts";

import type { Tokens } from "./usage";

export type TokenReport = {
  workspace: string;
  session: string;
  person: string | null;
  model: string;
  tier: "small" | "large" | "frontier" | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/**
 * Whether a request's answer is a model's answer, and so used tokens.
 * Counting tokens is a question about a request, not an answer.
 */
export function isAnswer(path: string): boolean {
  return /^\/v1\/messages\/?(\?|$)/.test(path);
}

/**
 * Whether a run's token may make a request: a model's answer, counting a
 * request's tokens, or listing models. Nothing else, so no other route
 * (a batch of messages, say) spends past the run's cap uncounted.
 */
export function runMayCall(path: string, method: string): boolean {
  const route = path.split("?")[0];
  if (isAnswer(route)) return true;
  if (/^\/v1\/messages\/count_tokens\/?$/.test(route)) return true;
  return (method === "GET" || method === "HEAD") && /^\/v1\/models(\/[^/]+)?\/?$/.test(route);
}

/**
 * The report for one answer, or null when it used nothing or its session
 * has no id to count it under. The model is the run's when its route names
 * one, else the one that answered.
 */
export function tokenReport(upstream: ModelUpstream, answeredBy: string | null, tokens: Tokens): TokenReport | null {
  const used = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  if (used === 0 || !upstream.session) return null;
  return {
    workspace: upstream.workspace,
    session: upstream.session,
    person: upstream.requestedBy ?? null,
    model: upstream.model ?? answeredBy ?? "unknown",
    tier: upstream.tier ?? null,
    input: tokens.input,
    output: tokens.output,
    cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite,
  };
}
