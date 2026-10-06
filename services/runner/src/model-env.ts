/** The kinds of work a g1t agent does. Each is routed on its own. */
export type AgentTask = "implement" | "review" | "update" | "plan";

/**
 * How capable, and how costly, a model is. g1t's hosted models come in
 * two: `small` for work a smaller model does as well, `large` for the rest.
 */
export type Tier = "small" | "large";

/** Where one kind of work goes: what people see, and what is sent. */
export type ModelRoute = {
  /** The model's public name, e.g. `Claude Sonnet 5.5`. */
  modelName: string;
  /** The identifier sent to the provider. */
  model: string;
};

/**
 * g1t's routing policy for the runs it pays the model for. Nobody
 * assigning an agent picks a model; the work decides, here, and the
 * operator changes it in one place (`AGENT_ROUTING` in wrangler.jsonc).
 */
export type AgentRouting = {
  /** The model behind each tier. */
  tiers: Record<Tier, ModelRoute>;
  /**
   * The tier each kind of work runs on. `change` decides by the change the
   * work reads: small when it is small and touches nothing sensitive.
   */
  tasks: Record<AgentTask, Tier | "change">;
  /** The largest change `change` sends to the small tier. */
  smallChange: { files: number; lines: number };
  /** Labels on the issue behind the work that send `change` to the large tier. */
  largeLabels: string[];
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

/** What g1t knows about one piece of work when it routes it. */
export type RouteSignals = {
  /** The change the work reads; null or absent when g1t does not know it. */
  change?: ChangeSize | null;
  /** Labels on the issue the work is for. */
  labels?: string[];
  /** The last attempt at the same work failed. */
  retry?: boolean;
};

/** The routing g1t ships with, for whatever the configuration leaves out. */
export const DEFAULT_ROUTING: AgentRouting = {
  tiers: {
    small: { modelName: "Claude Haiku 4.5", model: "claude-haiku-4-5-20251001" },
    large: { modelName: "Claude Sonnet 5.5", model: "claude-sonnet-5-5" },
  },
  tasks: { implement: "large", review: "change", update: "small", plan: "small" },
  smallChange: { files: 10, lines: 200 },
  largeLabels: ["security"],
};

/**
 * The routing in `AGENT_ROUTING`, with anything it leaves out taken from
 * `DEFAULT_ROUTING`. An unset or unreadable value is the default.
 */
export function parseRouting(json: string | undefined): AgentRouting {
  let given: Partial<AgentRouting> = {};
  try {
    given = json ? (JSON.parse(json) as Partial<AgentRouting>) : {};
  } catch {
    console.log("AGENT_ROUTING is not JSON; using the default routing");
  }
  return {
    tiers: { ...DEFAULT_ROUTING.tiers, ...given.tiers },
    tasks: { ...DEFAULT_ROUTING.tasks, ...given.tasks },
    smallChange: { ...DEFAULT_ROUTING.smallChange, ...given.smallChange },
    largeLabels: given.largeLabels ?? DEFAULT_ROUTING.largeLabels,
  };
}

/**
 * The tier one piece of work runs on: the cheapest that can do it.
 * Planning and catching up are small; making a change is large; a review
 * is small for a small change that touches nothing sensitive, and large
 * for anything else, including a change g1t does not know the size of.
 * A retry after a failed attempt is always large, so that work the small
 * tier could not finish goes up rather than failing again the same way.
 */
export function chooseTier(task: AgentTask, signals: RouteSignals, routing: AgentRouting = DEFAULT_ROUTING): Tier {
  if (signals.retry) return "large";
  const rule = routing.tasks[task] ?? "large";
  if (rule !== "change") return rule;
  const change = signals.change;
  if (!change || change.files === 0) return "large";
  const large = new Set(routing.largeLabels.map((label) => label.toLowerCase()));
  if ((signals.labels ?? []).some((label) => large.has(label.toLowerCase()))) return "large";
  const small =
    change.sensitive.length === 0 &&
    change.files <= routing.smallChange.files &&
    change.lines <= routing.smallChange.lines;
  return small ? "small" : "large";
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

/** What a run is for, attached to each of its requests at the gateway. */
export type RunTags = { repo: string; pull: number };

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
  // be read per kind of work, tier, repository and pull request.
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
export type PastAttempt = { status: string; halted?: string | null; title?: string | null };

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
