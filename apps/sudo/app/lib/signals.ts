/**
 * Reach out: why a workspace is worth a word, how urgent that is, and what
 * staff are doing about it. Billing finds the signals and keeps the sales
 * records; this orders, filters and names them. No Workers imports, so it
 * can be tested under Node.
 */
import type { SalesStage, Signal, SignalKind } from "@g1t/contracts";

export type Tone = "plain" | "lavender" | "mint" | "warn" | "danger" | "info";

/** Each kind of signal, most urgent first. */
export const SIGNAL_KINDS: { kind: SignalKind; label: string; tone: Tone; about: string }[] = [
  { kind: "at_limit", label: "At limit", tone: "danger", about: "Work is stopped: it reached its limit or its owners' spend limit." },
  { kind: "declined", label: "Declined", tone: "danger", about: "Its card was declined or a payment disputed." },
  { kind: "near_ceiling", label: "Near limit", tone: "warn", about: "Past 80% of what is available to it; about to need more." },
  { kind: "high_spend", label: "High spend", tone: "lavender", about: "Spending enough that custom terms or an enterprise may suit it." },
  { kind: "growing", label: "Growing", tone: "mint", about: "This month is well ahead of last month." },
  { kind: "established", label: "Established", tone: "info", about: "Became Established: its limit now follows its spend." },
  { kind: "first_payment", label: "First payment", tone: "mint", about: "Paid g1t for the first time." },
];

const RANK = new Map(SIGNAL_KINDS.map((entry, index) => [entry.kind as string, index]));

export function signalMeta(kind: string): { label: string; tone: Tone; about: string } {
  return SIGNAL_KINDS.find((entry) => entry.kind === kind) ?? { label: kind.replace(/_/g, " "), tone: "plain", about: "" };
}

export function isSignalKind(value: string | null | undefined): value is SignalKind {
  return value != null && RANK.has(value);
}

/**
 * Most urgent first: by kind, then the larger figure. Stable, so billing's
 * own order holds between equals. A kind sudo does not know goes last.
 */
export function bySignalUrgency(signals: Signal[]): Signal[] {
  return signals
    .map((signal, index) => ({ signal, index }))
    .sort(
      (a, b) =>
        (RANK.get(a.signal.kind) ?? RANK.size) - (RANK.get(b.signal.kind) ?? RANK.size) ||
        b.signal.valueMicros - a.signal.valueMicros ||
        a.index - b.index,
    )
    .map(({ signal }) => signal);
}

/** Whose signals to show: everyone's, nobody's yet, or the signed-in staff member's. */
export type Who = "all" | "unassigned" | "mine";

export function parseWho(value: string | null): Who {
  return value === "unassigned" || value === "mine" ? value : "all";
}

function sameEmail(a: string | null | undefined, b: string): boolean {
  return a != null && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The signals that match a kind (or any) and whose they are. */
export function filterSignals(signals: Signal[], { kind, who, me }: { kind: SignalKind | null; who: Who; me: string }): Signal[] {
  return signals.filter((signal) => {
    if (kind && signal.kind !== kind) return false;
    if (who === "unassigned") return !signal.owner;
    if (who === "mine") return sameEmail(signal.owner, me);
    return true;
  });
}

/** How many signals of each kind, for the filter's counts. */
export function countByKind(signals: Signal[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const signal of signals) counts[signal.kind] = (counts[signal.kind] ?? 0) + 1;
  return counts;
}

/** A link to the queue with these filters; the defaults are left out. */
export function reachOutHref({ kind, who }: { kind?: string | null; who?: Who }): string {
  const params = new URLSearchParams();
  if (kind) params.set("kind", kind);
  if (who && who !== "all") params.set("who", who);
  const query = params.toString();
  return query ? `/reach-out?${query}` : "/reach-out";
}

/** The sales stages, in the order a deal moves through them. */
export const STAGES: { stage: SalesStage; label: string; tone: Tone }[] = [
  { stage: "none", label: "No stage", tone: "plain" },
  { stage: "lead", label: "Lead", tone: "info" },
  { stage: "contacted", label: "Contacted", tone: "lavender" },
  { stage: "negotiating", label: "Negotiating", tone: "warn" },
  { stage: "won", label: "Won", tone: "mint" },
  { stage: "lost", label: "Lost", tone: "plain" },
  { stage: "churn_risk", label: "Churn risk", tone: "danger" },
];

export function stageMeta(stage: string | null | undefined): { label: string; tone: Tone } {
  return STAGES.find((entry) => entry.stage === (stage ?? "none")) ?? { label: String(stage), tone: "plain" };
}

export function isStage(value: string): value is SalesStage {
  return STAGES.some((entry) => entry.stage === value);
}
