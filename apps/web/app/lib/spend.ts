/**
 * Spend's arithmetic and wording (routes/workspace/spend.tsx and the top
 * bar's spend pill): which days a period covers, what the price book says
 * about pricing, a day-by-day series, a task's receipt from its session
 * tree, and what each budget does when it is reached. Pure, with type-only
 * imports, so it is tested on its own. Every number comes from a service;
 * nothing here invents one.
 */
import type { AgentSession, PriceBook, SpendPeriod, SpendSlice, UsageDay } from "@g1t/contracts";

/** Whose spend: your own (what agents did for you), or the whole workspace's. */
export type SpendScope = "me" | "workspace";

export const SPEND_PERIODS: { key: SpendPeriod; label: string; short: string }[] = [
  { key: "month", label: "This month", short: "This month" },
  { key: "last_month", label: "Last month", short: "Last month" },
  { key: "30d", label: "Last 30 days", short: "30 days" },
  { key: "7d", label: "Last 7 days", short: "7 days" },
];

export function readPeriod(raw: string | null | undefined): SpendPeriod {
  return SPEND_PERIODS.some((p) => p.key === raw) ? (raw as SpendPeriod) : "month";
}

export function periodLabel(period: SpendPeriod): string {
  return SPEND_PERIODS.find((p) => p.key === period)?.label ?? "This month";
}

/** Whose view a request asks for: the workspace's only for someone who may see it. */
export function readScope(raw: string | null | undefined, mayWorkspace: boolean): SpendScope {
  if (!mayWorkspace) return "me";
  return raw === "me" ? "me" : "workspace";
}

const iso = (at: Date) => at.toISOString().slice(0, 10);

/**
 * The days a period covers in UTC, both ends included, as the agents
 * service counts them (services/agents/src/budget.ts `spendSpan`).
 */
export function spanFor(period: SpendPeriod, now: Date): { from: string; until: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  switch (period) {
    case "last_month":
      return { from: iso(new Date(Date.UTC(y, m - 1, 1))), until: iso(new Date(Date.UTC(y, m, 0))) };
    case "7d":
      return { from: iso(new Date(Date.UTC(y, m, d - 6))), until: iso(now) };
    case "30d":
      return { from: iso(new Date(Date.UTC(y, m, d - 29))), until: iso(now) };
    default:
      return { from: iso(new Date(Date.UTC(y, m, 1))), until: iso(now) };
  }
}

/** Every day from `from` to `until`, with what was spent on it; days with none are 0. */
export function daySeries(from: string, until: string, spent: { day: string; micros: number }[]): { day: string; micros: number }[] {
  const by = new Map<string, number>();
  for (const s of spent) by.set(s.day, (by.get(s.day) ?? 0) + s.micros);
  const out: { day: string; micros: number }[] = [];
  const at = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${until}T00:00:00Z`);
  if (Number.isNaN(at.getTime()) || Number.isNaN(end.getTime())) return out;
  for (let n = 0; at <= end && n < 400; n++) {
    const key = iso(at);
    out.push({ day: key, micros: by.get(key) ?? 0 });
    at.setUTCDate(at.getUTCDate() + 1);
  }
  return out;
}

/** Usage's days (one row per product a day) as one total a day. */
export function usageByDay(days: UsageDay[]): { day: string; micros: number }[] {
  return days.map((d) => ({ day: d.day, micros: d.micros }));
}

/** What the price book says about pricing, for the page's pricing card. */
export type Pricing = {
  /** What models are marked up, in percent: 0 is the provider's price. */
  modelMarkupPercent: number;
  /** What g1t's own metered work is marked up: one figure, or the range across meters. */
  markup: { min: number; max: number } | null;
  /** g1t's agent rate per million tokens, on g1t's models and on your own key. Null when the book has none. */
  agentRateMicros: number | null;
  agentRateOwnMicros: number | null;
};

const AGENT_METERS = new Set(["agent_models", "agent_tokens", "agent_tokens_own"]);

export function pricingOf(book: PriceBook): Pricing {
  const run = book.prices.filter((p) => !AGENT_METERS.has(p.meter) && p.costMicros > 0);
  const markups = run.map((p) => p.markupPercent);
  const rate = (meter: string) => {
    const price = book.prices.find((p) => p.meter === meter);
    return price ? price.priceMicros : null;
  };
  return {
    modelMarkupPercent: book.modelMarginPercent,
    markup: markups.length ? { min: Math.min(...markups), max: Math.max(...markups) } : null,
    agentRateMicros: rate("agent_tokens"),
    agentRateOwnMicros: rate("agent_tokens_own"),
  };
}

/** "20%", or "15–20%" when meters differ. */
export function markupLabel(markup: { min: number; max: number }): string {
  return markup.min === markup.max ? `${markup.min}%` : `${markup.min}–${markup.max}%`;
}

/** One line of a task's receipt: one session of its tree. */
export type ReceiptLine = {
  session: AgentSession;
  depth: number;
  /** What this session's own steps were charged (a root's charge includes its tree's). */
  ownMicros: number;
};

export type Receipt = {
  root: AgentSession;
  lines: ReceiptLine[];
  /** The whole tree, as the root's charge counts it. */
  chargedMicros: number;
  /** The model answers at the provider's price, every session's together. */
  providerMicros: number;
  inputTokens: number;
  outputTokens: number;
  steps: number;
  toolCalls: number;
};

/**
 * A task's receipt from its session tree (root first, as the agents
 * service gives it): each session's own charge, children under their
 * parents, and the totals. A child's charge is added to the root as it is
 * spent, so the root's own share is its charge less its children's.
 */
export function receiptOf(tree: AgentSession[], rootId: string): Receipt | null {
  const root = tree.find((s) => s.id === rootId) ?? tree.find((s) => s.parent_id == null);
  if (!root) return null;
  const children = new Map<string, AgentSession[]>();
  for (const s of tree) {
    if (s.id === root.id || !s.parent_id) continue;
    children.set(s.parent_id, [...(children.get(s.parent_id) ?? []), s]);
  }
  const lines: ReceiptLine[] = [];
  const seen = new Set<string>();
  const walk = (s: AgentSession, depth: number) => {
    if (seen.has(s.id)) return;
    seen.add(s.id);
    lines.push({ session: s, depth, ownMicros: s.charged_micros });
    for (const kid of [...(children.get(s.id) ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at))) walk(kid, depth + 1);
  };
  walk(root, 0);
  const others = lines.slice(1).reduce((n, l) => n + l.ownMicros, 0);
  lines[0]!.ownMicros = Math.max(0, root.charged_micros - others);
  const sum = (pick: (s: AgentSession) => number) => lines.reduce((n, l) => n + (pick(l.session) || 0), 0);
  return {
    root,
    lines,
    chargedMicros: root.charged_micros,
    providerMicros: sum((s) => s.cost_micros ?? 0),
    inputTokens: sum((s) => s.input_tokens),
    outputTokens: sum((s) => s.output_tokens),
    steps: sum((s) => s.steps),
    toolCalls: sum((s) => s.tool_calls),
  };
}

/** A count of tokens for a receipt: "412K", "1.2M", "830". */
export function tokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 1 })}M`;
  if (n >= 10_000) return `${Math.round(n / 1000).toLocaleString("en-US")}K`;
  if (n >= 1000) return `${(n / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 })}K`;
  return n.toLocaleString("en-US");
}

/** How far through a budget: 0 to 1 (more when over), null with none. */
export function shareOfBudget(spent: number, budget: number | null | undefined): number | null {
  return budget != null && budget > 0 ? Math.max(0, spent) / budget : null;
}

/** "62%" of a budget, for a pill or a row; empty with none. */
export function percentLabel(spent: number, budget: number | null | undefined): string {
  const share = shareOfBudget(spent, budget);
  return share == null ? "" : `${Math.round(share * 100)}%`;
}

/** The slices a person's own view leaves out: the "who asked" one is only ever them. */
export function withoutSelf(slices: SpendSlice[], username: string): SpendSlice[] {
  return slices.filter((s) => s.key !== username);
}

/** What a level of budget does when it is reached, as the page says it. */
export const AT_LIMIT = {
  workspace: (pauses: boolean) =>
    pauses
      ? "New work stops until the month turns or an owner raises it: agents, workflows, builds and deploys. Work already running finishes."
      : "Owners are alerted, and work goes on; g1t's own ceiling still applies.",
  agents: "No agent takes new work until the 1st, or until an owner raises it.",
  person: "Agents take no new work for that person until the 1st; they say so where they were asked.",
  agent: "That agent takes no new work until the 1st, or the next day for a daily cap.",
  session: "The session stops at Needs approval, and an owner decides whether it goes on.",
} as const;
