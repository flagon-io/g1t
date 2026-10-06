/**
 * What a workspace's deployments cost in a month, from its meter: every
 * request, CPU millisecond and custom domain, from the first, at what each
 * costs g1t. Billing adds the margin and draws on the plan's included usage
 * first. There are no allowances and no counts that stop anything: apps
 * (production and previews) are not metered at all, since Cloudflare's
 * Workers for Platforms includes far more scripts than g1t runs.
 *
 * No Workers imports, so it can be tested under Node.
 */

/** What each unit costs g1t, in millionths of a dollar. */
export type UnitCosts = {
  millionRequests: number;
  millionCpuMs: number;
  domainMonth: number;
};

/** A month's meter row, as the `meters` table keeps it. */
export type MonthMeter = {
  requests: number;
  cpu_ms: number;
  peak_domains: number | null;
};

/** What the month's traffic and domains cost g1t, and how much there was. */
export type MonthCost = {
  /** App requests and CPU time. */
  traffic: { micros: number; detail: string | null };
  /** Custom domains: the most the workspace had at once this month, each for the month. */
  domains: { micros: number; detail: string | null };
  /** Both, rounded up: what a month's close charges. */
  micros: number;
  /** For the ledger: `1,200,000 requests, 3,400,000 CPU ms, 2 custom domains`. */
  description: string;
};

/** `1.2 million`, `840,000`. */
export function amount(n: number): string {
  if (n >= 1_000_000) return `${(Math.round(n / 100_000) / 10).toLocaleString("en-US")} million`;
  return Math.round(n).toLocaleString("en-US");
}

export function monthCost(meter: MonthMeter, costs: UnitCosts): MonthCost {
  const requests = Math.max(0, meter.requests ?? 0);
  const cpuMs = Math.max(0, meter.cpu_ms ?? 0);
  const domains = Math.max(0, meter.peak_domains ?? 0);
  const traffic = Math.ceil((requests / 1_000_000) * costs.millionRequests + (cpuMs / 1_000_000) * costs.millionCpuMs);
  const domainMicros = Math.ceil(domains * costs.domainMonth);
  const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
  const trafficDetail = requests || cpuMs ? `${amount(requests)} requests and ${amount(cpuMs)} CPU ms` : null;
  const domainDetail = domains ? plural(domains, "custom domain") : null;
  const parts = [
    requests && `${requests.toLocaleString("en-US")} requests`,
    cpuMs && `${cpuMs.toLocaleString("en-US")} CPU ms`,
    domains && plural(domains, "custom domain"),
  ].filter(Boolean);
  return {
    traffic: { micros: traffic, detail: trafficDetail },
    domains: { micros: domainMicros, detail: domainDetail },
    micros: traffic + domainMicros,
    description: parts.join(", "),
  };
}
