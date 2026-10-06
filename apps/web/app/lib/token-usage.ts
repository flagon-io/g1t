/**
 * Model tokens for mission control's usage panel: a person's or the
 * workspace's, over the last weeks (billing's `token_usage`).
 */

import type { TokenUsage } from "@g1t/contracts";

/** What billing answers. */
export type TokenUsageView = TokenUsage;

/** "8.5B", "412M", "12.3K", "940". */
export function compactTokens(n: number): string {
  const units: [number, string][] = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, unit] of units) {
    if (n >= size) {
      const value = n / size;
      return `${value >= 100 ? Math.round(value) : Number(value.toFixed(1))}${unit}`;
    }
  }
  return String(Math.max(0, Math.round(n)));
}

/** The share of prompt tokens read from the provider's cache, 0..1; null with no prompt. */
export function cacheShare(usage: Pick<TokenUsageView, "inputTokens" | "cacheReadTokens" | "cacheWriteTokens">): number | null {
  const prompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return prompt > 0 ? usage.cacheReadTokens / prompt : null;
}

/** Shading levels for the daily grid: 0 for none, then 1..4 by quartile of the busiest day. */
export const HEAT_LEVELS = 4;

export function heatLevel(tokens: number, busiest: number): number {
  if (tokens <= 0 || busiest <= 0) return 0;
  return Math.min(HEAT_LEVELS, Math.max(1, Math.ceil((tokens / busiest) * HEAT_LEVELS)));
}

/** The busiest day, or null when none had tokens. */
export function bestDay(byDay: TokenUsageView["byDay"]): { day: string; tokens: number } | null {
  let best: { day: string; tokens: number } | null = null;
  for (const entry of byDay) if (entry.tokens > 0 && (!best || entry.tokens > best.tokens)) best = entry;
  return best;
}

/** One part of the token mix, in stacking order. */
export type MixPart = { key: "input" | "cacheRead" | "cacheWrite" | "output"; label: string; tokens: number; share: number };

/**
 * New input, cache reads, cache writes and output, in that order: the
 * order the colours were checked in (neighbours stay apart for every kind
 * of colour vision).
 */
export function tokenMix(usage: TokenUsageView): MixPart[] {
  const parts: Omit<MixPart, "share">[] = [
    { key: "input", label: "New input", tokens: usage.inputTokens },
    { key: "cacheRead", label: "Cache reads", tokens: usage.cacheReadTokens },
    { key: "cacheWrite", label: "Cache writes", tokens: usage.cacheWriteTokens },
    { key: "output", label: "Output", tokens: usage.outputTokens },
  ];
  const total = parts.reduce((sum, part) => sum + part.tokens, 0);
  return parts.map((part) => ({ ...part, share: total > 0 ? part.tokens / total : 0 }));
}

/** "22 Sept"-style short day, read in UTC since days are UTC dates. */
export function shortDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? day
    : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}
