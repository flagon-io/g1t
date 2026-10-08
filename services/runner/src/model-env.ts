/**
 * The kinds of work a g1t agent does, as model routes and billing name
 * them. A workspace routes each to a provider (Integrations → Models).
 */
export type AgentTask = "implement" | "review" | "update" | "plan";

/**
 * What the router routes: every kind of agent job. Revising a change and
 * answering a question are routed on their own, and go to the workspace's
 * `implement` route (`taskOf`).
 */
export type JobKind = AgentTask | "revise" | "answer";

/** The route and the bill a job goes on. */
export function taskOf(kind: JobKind): AgentTask {
  return kind === "revise" || kind === "answer" ? "implement" : kind;
}

/**
 * How capable, and how costly, a model is: `small` (fast and cheap, for
 * work a smaller model does as well), `large` (the standard, most
 * changes) and `frontier` (the most capable, for hard work only).
 */
export type Tier = "small" | "large" | "frontier";

/** Cheapest first. */
export const TIERS: Tier[] = ["small", "large", "frontier"];

/** Per million tokens, in US dollars: what the provider lists. */
export type TokenPrice = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** Where one kind of work goes: what people see, and what is sent. */
export type ModelRoute = {
  /** The model's public name, e.g. `Claude Sonnet 5.5`. */
  modelName: string;
  /** The identifier sent to the provider. */
  model: string;
  /**
   * The provider's list price, for estimates (the savings report, routing
   * by cost). Never what anyone is charged: runs are charged what AI
   * Gateway priced them at.
   */
  price?: TokenPrice;
};

/** How a job's rule decides: a tier, or `change` to size the change it reads. */
export type TaskRule = Tier | "change";

/**
 * Learning from a repository's own runs: of its last `window` runs of the
 * same kind, a cheaper tier that finished at least `stepDownAt` of at
 * least `minRuns` takes the work; a tier that finished less than
 * `stepUpAt` of at least `minRuns` hands it up.
 */
export type Learning = { window: number; minRuns: number; stepDownAt: number; stepUpAt: number };

/**
 * g1t's routing policy. Nobody assigning an agent has to pick a model:
 * "Auto" decides here, by the work, and the operator changes the policy in
 * one place (`AGENT_ROUTING` in wrangler.jsonc), never in code.
 */
export type AgentRouting = {
  /** The model behind each tier: the catalogue. */
  tiers: Record<Tier, ModelRoute>;
  /** The tier each kind of job starts from, or `change` to size it. */
  tasks: Record<JobKind, TaskRule>;
  /** The largest change `change` sends to the small tier. */
  smallChange: { files: number; lines: number };
  /** A change larger than this (either) is reviewed on the frontier tier. */
  largeChange: { files: number; lines: number };
  /** Issue labels that keep work off the small tier. */
  largeLabels: string[];
  /** Issue labels that send work to the frontier tier. */
  frontierLabels: string[];
  /** Issue labels that let changes and answers start on the small tier. */
  smallLabels: string[];
  /** Failed attempts at the same work, in a row, before the frontier tier. */
  frontierAfter: number;
  learning: Learning;
};

/** What a change is, as far as routing cares. */
export type ChangeSize = {
  files: number;
  /** Lines added and removed. */
  lines: number;
  /**
   * What it touches that runs, configures or guards things: CI, secrets,
   * infrastructure, ownership (work's confidence.rs `sensitive`).
   */
  sensitive: string[];
};

/** One past run of the same kind of job in the repository, for learning. */
export type PastOutcome = {
  /** The tier it ran on, when it ran on one of g1t's. */
  tier: Tier | null;
  /** It finished, and did not leave a change g1t had low confidence in. */
  ok: boolean;
};

/** What g1t knows about one piece of work when it routes it. */
export type RouteSignals = {
  /** The change the work reads; null or absent when g1t does not know it. */
  change?: ChangeSize | null;
  /** Labels on the issue the work is for. */
  labels?: string[];
  /** The last attempt at the same work failed. Same as `failures: 1`. */
  retry?: boolean;
  /** Failed attempts at the same work, in a row, most recent last. */
  failures?: number;
  /** The last attempt finished, but left a change g1t has low confidence in. */
  lowConfidence?: boolean;
  /** Recent runs of the same kind in this repository, newest first. */
  history?: PastOutcome[];
  /** A tier the workspace chose for this work instead of Auto. */
  chosen?: Tier | null;
};

/** The router's answer: the tier, and why, in one line people can read. */
export type Routed = {
  tier: Tier;
  /** E.g. `Used a fast model (Claude Haiku 4.5): small change, 3 files and 80 lines.` */
  reason: string;
};

/** The routing g1t ships with, for whatever the configuration leaves out. */
export const DEFAULT_ROUTING: AgentRouting = {
  tiers: {
    small: {
      modelName: "Claude Haiku 4.5",
      model: "claude-haiku-4-5-20251001",
      price: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    },
    large: {
      modelName: "Claude Sonnet 5.5",
      model: "claude-sonnet-5-5",
      price: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    },
    frontier: {
      modelName: "Claude Opus 5.5",
      model: "claude-opus-5-5",
      price: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    },
  },
  tasks: { implement: "large", revise: "large", answer: "small", review: "change", update: "small", plan: "frontier" },
  smallChange: { files: 10, lines: 200 },
  largeChange: { files: 60, lines: 3000 },
  largeLabels: ["security"],
  frontierLabels: ["architecture"],
  smallLabels: ["documentation", "docs", "typo"],
  frontierAfter: 2,
  learning: { window: 20, minRuns: 5, stepDownAt: 0.9, stepUpAt: 0.5 },
};

function isTier(value: unknown): value is Tier {
  return value === "small" || value === "large" || value === "frontier";
}

/**
 * The routing in `AGENT_ROUTING`, with anything it leaves out taken from
 * `DEFAULT_ROUTING`. An unset or unreadable value is the default, and so is
 * any single rule that names no tier.
 */
export function parseRouting(json: string | undefined): AgentRouting {
  let given: Partial<AgentRouting> = {};
  try {
    const parsed: unknown = json ? JSON.parse(json) : {};
    given = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Partial<AgentRouting>) : {};
  } catch {
    console.log("AGENT_ROUTING is not JSON; using the default routing");
  }
  const tasks = { ...DEFAULT_ROUTING.tasks };
  for (const [kind, rule] of Object.entries(given.tasks ?? {})) {
    if (kind in tasks && (isTier(rule) || rule === "change")) tasks[kind as JobKind] = rule;
  }
  const tiers = { ...DEFAULT_ROUTING.tiers };
  for (const tier of TIERS) {
    const route = given.tiers?.[tier];
    if (route && typeof route.model === "string" && route.model) {
      // A model named without a price has none: estimates leave it out
      // rather than price it as another model.
      tiers[tier] = { modelName: route.modelName || route.model, model: route.model, ...(route.price ? { price: route.price } : {}) };
    }
  }
  const labels = (list: unknown, fallback: string[]) =>
    Array.isArray(list) ? list.filter((label): label is string => typeof label === "string") : fallback;
  return {
    tiers,
    tasks,
    smallChange: { ...DEFAULT_ROUTING.smallChange, ...given.smallChange },
    largeChange: { ...DEFAULT_ROUTING.largeChange, ...given.largeChange },
    largeLabels: labels(given.largeLabels, DEFAULT_ROUTING.largeLabels),
    frontierLabels: labels(given.frontierLabels, DEFAULT_ROUTING.frontierLabels),
    smallLabels: labels(given.smallLabels, DEFAULT_ROUTING.smallLabels),
    frontierAfter: typeof given.frontierAfter === "number" && given.frontierAfter >= 1 ? given.frontierAfter : DEFAULT_ROUTING.frontierAfter,
    learning: { ...DEFAULT_ROUTING.learning, ...given.learning },
  };
}

/** How each tier is named to people. */
export const TIER_LABEL: Record<Tier, { noun: string; used: string }> = {
  small: { noun: "fast", used: "Used a fast model" },
  large: { noun: "standard", used: "Used the standard model" },
  frontier: { noun: "most capable", used: "Used the most capable model" },
};

const up = (tier: Tier): Tier => TIERS[Math.min(TIERS.indexOf(tier) + 1, TIERS.length - 1)];
const down = (tier: Tier): Tier => TIERS[Math.max(TIERS.indexOf(tier) - 1, 0)];
const rank = (tier: Tier) => TIERS.indexOf(tier);

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** How a tier did in the repository's recent runs of the same kind. */
export function record(history: PastOutcome[], tier: Tier, window: number): { runs: number; ok: number } {
  const recent = history.slice(0, window).filter((run) => run.tier === tier);
  return { runs: recent.length, ok: recent.filter((run) => run.ok).length };
}

/**
 * Where one job runs, and why. In order:
 *
 * 1. A tier the workspace chose for this work is used as chosen.
 * 2. The job's rule gives the starting tier: a fixed tier, or for
 *    `change`, the change's size (small and touching nothing sensitive:
 *    small; larger than `largeChange`: frontier; unknown or anything
 *    else: large). Issue labels move it: `frontierLabels` to the frontier,
 *    `largeLabels` off the small tier, `smallLabels` let a change or an
 *    answer start small.
 * 3. Escalation: `frontierAfter` failures in a row go to the frontier; one
 *    failure, or a last attempt that left low confidence, one tier up.
 * 4. Otherwise, learning from the repository's own runs of the same kind:
 *    one tier down when the cheaper tier finished nearly all of its recent
 *    ones (never for sensitive or labelled work), one tier up when this
 *    tier failed half of its own.
 */
export function route(kind: JobKind, signals: RouteSignals, routing: AgentRouting = DEFAULT_ROUTING): Routed {
  const say = (tier: Tier, why: string): Routed => ({
    tier,
    reason: `${TIER_LABEL[tier].used} (${routing.tiers[tier].modelName}): ${why}.`,
  });
  if (signals.chosen && isTier(signals.chosen)) {
    return say(signals.chosen, `the workspace chose the ${TIER_LABEL[signals.chosen].noun} model for this work`);
  }

  const labels = new Set((signals.labels ?? []).map((label) => label.toLowerCase()));
  const has = (list: string[]) => list.find((label) => labels.has(label.toLowerCase()));
  const rule = routing.tasks[kind] ?? "large";
  let tier: Tier;
  let why: string;
  // Sensitive or labelled work is never stepped down by learning.
  let pinned = false;
  if (rule === "change") {
    const change = signals.change;
    if (!change || change.files === 0) {
      [tier, why] = ["large", "the change's size is not known"];
    } else if (change.sensitive.length > 0) {
      [tier, why, pinned] = ["large", `it touches ${change.sensitive.join(", ")}`, true];
    } else if (change.files > routing.largeChange.files || change.lines > routing.largeChange.lines) {
      [tier, why] = ["frontier", `large change, ${plural(change.files, "file", "files")} and ${plural(change.lines, "line", "lines")}`];
    } else if (change.files <= routing.smallChange.files && change.lines <= routing.smallChange.lines) {
      [tier, why] = ["small", `small change, ${plural(change.files, "file", "files")} and ${plural(change.lines, "line", "lines")}`];
    } else {
      [tier, why] = ["large", `a change of ${plural(change.files, "file", "files")} and ${plural(change.lines, "line", "lines")}`];
    }
  } else {
    tier = rule;
    why = DEFAULT_WHY[kind];
  }
  const frontierLabel = has(routing.frontierLabels);
  const largeLabel = has(routing.largeLabels);
  const smallLabel = has(routing.smallLabels);
  if (frontierLabel) {
    [tier, why, pinned] = ["frontier", `the issue is labelled ${frontierLabel}`, true];
  } else if (largeLabel && tier === "small") {
    [tier, why, pinned] = ["large", `the issue is labelled ${largeLabel}`, true];
  } else if (largeLabel) {
    pinned = true;
  } else if (smallLabel && tier === "large" && (kind === "implement" || kind === "revise" || kind === "answer")) {
    [tier, why] = ["small", `the issue is labelled ${smallLabel}`];
  }

  const failures = Math.max(signals.failures ?? 0, signals.retry ? 1 : 0);
  if (failures >= routing.frontierAfter) {
    return say("frontier", `the last ${plural(failures, "attempt", "attempts")} at this work failed`);
  }
  if (failures > 0) {
    return tier === "frontier" ? say(tier, `${why}; the last attempt failed`) : say(up(tier), "the last attempt at this work failed");
  }
  if (signals.lowConfidence) {
    return tier === "frontier" ? say(tier, why) : say(up(tier), "the last attempt left a change g1t was not confident in");
  }

  const history = signals.history ?? [];
  const { window, minRuns, stepDownAt, stepUpAt } = routing.learning;
  const here = record(history, tier, window);
  if (here.runs >= minRuns && here.ok / here.runs < stepUpAt && tier !== "frontier") {
    const failed = here.runs - here.ok;
    return say(up(tier), `the ${TIER_LABEL[tier].noun} model failed ${failed} of its last ${here.runs} runs like this here`);
  }
  if (!pinned && tier !== "small") {
    const cheaper = record(history, down(tier), window);
    if (cheaper.runs >= minRuns && cheaper.ok / cheaper.runs >= stepDownAt) {
      return say(down(tier), `it finished ${cheaper.ok} of its last ${cheaper.runs} runs like this here`);
    }
  }
  return say(tier, why);
}

/** Why each kind of job starts where it does, when nothing else decides. */
const DEFAULT_WHY: Record<JobKind, string> = {
  implement: "making a change",
  revise: "revising a change",
  answer: "answering a question",
  review: "reviewing a change",
  update: "catching up with the base branch",
  plan: "planning work",
};

/**
 * The tier one piece of work runs on: `route`'s tier, for callers that
 * need no reason.
 */
export function chooseTier(kind: JobKind, signals: RouteSignals, routing: AgentRouting = DEFAULT_ROUTING): Tier {
  return route(kind, signals, routing).tier;
}

/** The tier a model ran as, by its public name or id; null when none of g1t's. */
export function tierOfModel(model: string | null | undefined, routing: AgentRouting): Tier | null {
  if (!model) return null;
  return TIERS.find((tier) => routing.tiers[tier].modelName === model || routing.tiers[tier].model === model) ?? null;
}

/** The settings that decide where model requests go. */
export type ModelRouting = {
  /**
   * The provider's key. Not needed when the gateway holds it and requests
   * authenticate to the gateway instead.
   */
  ANTHROPIC_API_KEY?: string;
  /** A Cloudflare AI Gateway id; empty sends requests to the provider directly. */
  AI_GATEWAY_ID: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  /** Authenticates to the gateway, if it requires it. */
  AI_GATEWAY_TOKEN?: string;
};

/**
 * What a run is for, attached to each of its requests at the gateway.
 * `session` is the run's id there: billing finds the run's requests by it
 * and settles the run to what the gateway priced them at.
 */
export type RunTags = { repo: string; pull: number; session?: string };

/**
 * A session id for a run that goes straight to the gateway (no model
 * proxy): `rs_` and 24 hex characters, which billing's log filter needs
 * no escaping for.
 */
export function gatewaySession(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `rs_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Whether there is a way to reach a model at all. */
export function canReachModel(env: ModelRouting): boolean {
  return Boolean(env.ANTHROPIC_API_KEY || (env.AI_GATEWAY_ID && env.AI_GATEWAY_TOKEN));
}

/**
 * The model variables of a run on g1t's hosted models: the tier's model
 * for the work, and the small tier's for the harness's own small tasks.
 */
export function tierVars(routing: AgentRouting, tier: Tier): Record<string, string> {
  const route = routing.tiers[tier];
  return {
    ANTHROPIC_MODEL: route.model,
    // Recorded at the top of the session, so anyone can see what ran.
    AGENT_MODEL_NAME: route.modelName,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: routing.tiers.small.model,
    ANTHROPIC_SMALL_FAST_MODEL: routing.tiers.small.model,
  };
}

/** Where the sandbox sends model requests, and what it sends with them. */
export function modelEnv(
  env: ModelRouting,
  routing: AgentRouting,
  task: AgentTask,
  tier: Tier,
  tags: RunTags,
): Record<string, string> {
  const vars = tierVars(routing, tier);
  if (env.ANTHROPIC_API_KEY) vars.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
  if (!env.AI_GATEWAY_ID) return vars;

  vars.ANTHROPIC_BASE_URL = `https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/anthropic`;
  // The gateway logs these with every request, so spend and failures can
  // be read per kind of work, tier, repository and pull request; and by
  // the run's session, which billing settles the run's charge by.
  const headers = [`cf-aig-metadata: ${JSON.stringify({ task, tier, ...tags })}`];
  if (env.AI_GATEWAY_TOKEN) {
    vars.AI_GATEWAY_TOKEN = env.AI_GATEWAY_TOKEN;
    headers.push(`cf-aig-authorization: Bearer ${env.AI_GATEWAY_TOKEN}`);
    // With the provider's key stored in the gateway, the sandbox never
    // holds it. The harness still wants the variable set.
    vars.ANTHROPIC_API_KEY ??= env.AI_GATEWAY_TOKEN;
  }
  vars.ANTHROPIC_CUSTOM_HEADERS = headers.join("\n");
  return vars;
}

/** Lines added and removed across a change's files. */
export function changeSize(files: { additions: number; deletions: number }[], sensitive: string[]): ChangeSize {
  return {
    files: files.length,
    lines: files.reduce((sum, file) => sum + file.additions + file.deletions, 0),
    sensitive,
  };
}

/** A past run of the same work, as the work service lists it. */
export type PastAttempt = {
  status: string;
  halted?: string | null;
  title?: string | null;
  /** The pull request or issue it was for. */
  number?: number | null;
  /** The model it ran on, by its public name. */
  model?: string | null;
  confidence?: { level: string } | null;
};

/**
 * Whether the latest attempt at the same work failed: it failed, or g1t
 * stopped it at a cap of its guardrails. A person stopping it is not a
 * failure. `title` narrows it to the same plan, whose runs have no pull
 * request to tell them apart.
 */
export function lastAttemptFailed(newestFirst: PastAttempt[], title?: string): boolean {
  const last = newestFirst[0];
  if (!last) return false;
  if (title !== undefined && (last.title ?? "").trim() !== title.trim()) return false;
  return last.status === "failed" || (last.status === "stopped" && Boolean(last.halted));
}

/** Whether a past run failed: it failed, or g1t stopped it at a cap of its guardrails. */
function failed(run: PastAttempt): boolean {
  return run.status === "failed" || (run.status === "stopped" && Boolean(run.halted));
}

/**
 * How many of the latest attempts at the same work failed in a row. A
 * finished one, or a person stopping one, ends the count. `title` narrows
 * it to the same plan, as for `lastAttemptFailed`.
 */
export function failuresInARow(newestFirst: PastAttempt[], title?: string): number {
  let count = 0;
  for (const run of newestFirst) {
    if (title !== undefined && (run.title ?? "").trim() !== title.trim()) break;
    if (!failed(run)) break;
    count += 1;
  }
  return count;
}

/** Whether the latest attempt finished but left a change g1t was not confident in. */
export function leftLowConfidence(newestFirst: PastAttempt[]): boolean {
  const last = newestFirst[0];
  return Boolean(last && last.status === "succeeded" && last.confidence?.level === "low");
}

/**
 * The repository's recent runs of one kind, as learning reads them: the
 * tier each ran on, and whether it did the work. Runs still going say
 * nothing yet, and a person stopping one is not the model's failure.
 */
export function outcomesOf(newestFirst: PastAttempt[], routing: AgentRouting): PastOutcome[] {
  return newestFirst
    .filter((run) => run.status === "succeeded" || failed(run))
    .map((run) => ({
      tier: tierOfModel(run.model, routing),
      ok: run.status === "succeeded" && run.confidence?.level !== "low",
    }));
}
