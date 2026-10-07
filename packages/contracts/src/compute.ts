/**
 * Compute gating: whether a workspace may start something that costs g1t
 * real money, and with what caps. Every place compute starts (agent runs,
 * checks, the merge queue, merge checks and catch-ups in the runner,
 * workflow jobs, deploy builds and context embeddings) asks the billing
 * service through `ComputeGate.admit` first, and settles what it reserved
 * when the work ends.
 *
 * The billing service owns the decision (`reserve`); this module only
 * shapes the call, words the refusal, and decides what happens when billing
 * cannot be reached:
 *
 * - **Free workspaces fail closed.** If billing errors, nothing starts:
 *   a free workspace never gets compute because billing was down.
 * - **Paid, internal and enterprise workspaces fail open.** If billing
 *   errors, the work starts without a reservation and the error is logged,
 *   so a billing blip never stops paying customers. The plan is read from
 *   `entitlements`, or, when that call fails too, from the last plan seen
 *   for the workspace (kept in the isolate and in the Cache API for a day).
 *   A workspace whose plan is not known is treated as free.
 * - **Internal and enterprise plans always pass.** A refusal from billing
 *   for one is logged, not shown.
 *
 * Estimates and settlements are at what the work costs g1t, before the
 * margin: billing applies the margin as it does to every other meter.
 *
 * Only type imports, so services' unit tests can load it on its own.
 *
 * Mirrors `entitlements`, `reserve` and `settle` in the billing service
 * (`g1t_contracts::billing`), which speak camelCase. Answers are read in
 * either case, so an older or newer billing never reads as no plan.
 */
import type { ServiceBinding } from "./clients";
import type { RepoPath } from "./repos";
import type { Result } from "./result";

/** What a workspace pays for. */
export type ComputePlan = "free" | "paid" | "internal" | "enterprise";

/** What kind of compute is being started. */
export type ComputeKind = "agent" | "check" | "workflow" | "queue" | "deploy" | "embedding";

/** What pays for a reservation. */
export type PaidBy = "credit" | "trial" | "oss" | "on_demand";

/** Why billing refused a reservation. */
export type ComputeRefusalCode = "not_paid" | "trial_used" | "limit" | "paused" | "oss_pool_empty";

/**
 * Codes the gate itself refuses with, besides billing's: `issue_cap` (an
 * issue's agents spent their cap), `billing_unavailable` (a free workspace
 * while billing cannot be reached).
 */
export type GateRefusalCode = ComputeRefusalCode | "issue_cap" | "billing_unavailable";

/** The compute side of what a workspace's plan gives it. */
export type ComputeEntitlements = {
  plan: ComputePlan;
  /** Whether its plan includes compute at all. */
  compute: boolean;
  /** The one-time trial's usage left. */
  trialMicrosLeft: number;
  /** Whether the workspace passed the card check the trial and open-source pool need. */
  trialVerified: boolean;
  /** A paid workspace in its first month: tighter caps. */
  firstMonth: boolean;
  /** Agent runs at once; zero means no cap. */
  maxConcurrentAgents: number;
  /** The longest any sandbox may run, in minutes; zero means no cap. */
  maxRunMinutes: number;
  /** The most one agent run may cost; zero means no cap. */
  runCapMicros: number;
  /** The most the agents on one issue may cost in all; zero means no cap. */
  issueCapMicros: number;
  ceilingMicros: number;
  exposureMicros: number;
  /** Why g1t paused the workspace's compute; null when it is not paused. */
  paused: string | null;
};

export type Reservation = { id: string; paidBy: PaidBy };

/** Compute the open-source pool can pay for, on public repositories. */
export const OSS_KINDS: ReadonlySet<ComputeKind> = new Set(["check", "workflow", "queue"]);

const REFUSAL_CODES: ReadonlySet<string> = new Set(["not_paid", "trial_used", "limit", "paused", "oss_pool_empty"]);

// ---- Reading billing's answers ----------------------------------------------

type Raw = Record<string, unknown>;

/** A field in camelCase or snake_case. */
function field(raw: Raw, camel: string): unknown {
  if (camel in raw) return raw[camel];
  const snake = camel.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  return raw[snake];
}

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

const PLANS: ReadonlySet<string> = new Set(["free", "paid", "internal", "enterprise"]);

/**
 * Billing's `entitlements`, as this module reads them. Null when they do
 * not say the plan (the billing service has not got the compute contract
 * yet, or answered something else).
 */
export function readEntitlements(answer: unknown): ComputeEntitlements | null {
  if (!answer || typeof answer !== "object") return null;
  let raw = answer as Raw;
  // An outcome, if billing wraps it in one.
  if ("ok" in raw && ("value" in raw || "error" in raw)) {
    if (raw.ok !== true || !raw.value || typeof raw.value !== "object") return null;
    raw = raw.value as Raw;
  }
  const plan = field(raw, "plan");
  if (typeof plan !== "string" || !PLANS.has(plan)) return null;
  const paused = field(raw, "paused");
  return {
    plan: plan as ComputePlan,
    compute: field(raw, "compute") === true,
    trialMicrosLeft: num(field(raw, "trialMicrosLeft")),
    trialVerified: field(raw, "trialVerified") === true,
    firstMonth: field(raw, "firstMonth") === true,
    maxConcurrentAgents: num(field(raw, "maxConcurrentAgents")),
    maxRunMinutes: num(field(raw, "maxRunMinutes")),
    runCapMicros: num(field(raw, "runCapMicros")),
    issueCapMicros: num(field(raw, "issueCapMicros")),
    ceilingMicros: num(field(raw, "ceilingMicros")),
    exposureMicros: num(field(raw, "exposureMicros")),
    paused: typeof paused === "string" && paused.trim() ? paused.trim() : null,
  };
}

/** A reservation from billing's `reserve`, or null if it is not one. */
export function readReservation(value: unknown): Reservation | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Raw;
  const id = field(raw, "id");
  if (typeof id !== "string" || !id) return null;
  const paidBy = field(raw, "paidBy");
  return { id, paidBy: (typeof paidBy === "string" ? paidBy : "credit") as PaidBy };
}

/**
 * Billing's refusal code, if a failure is a refusal rather than an error.
 * Accepts the code itself, a `reason` beside a generic code, and
 * `payment_required`, which billing has used for refusals before.
 */
export function refusalCode(failure: { code?: unknown; reason?: unknown } | null | undefined): ComputeRefusalCode | null {
  if (!failure) return null;
  for (const candidate of [failure.code, failure.reason]) {
    if (typeof candidate === "string" && REFUSAL_CODES.has(candidate)) return candidate as ComputeRefusalCode;
  }
  return failure.code === "payment_required" ? "not_paid" : null;
}

// ---- Who can run what -------------------------------------------------------

/** Plans that never wait on billing. */
export function alwaysPasses(plan: ComputePlan | null | undefined): boolean {
  return plan === "internal" || plan === "enterprise";
}

/** What happens when billing cannot be reached: paying plans go on, the rest stop. */
export function onBillingError(plan: ComputePlan | null | undefined): "allow" | "refuse" {
  return plan === "paid" || alwaysPasses(plan) ? "allow" : "refuse";
}

/**
 * Whether a workspace can start `kind` at all, from its entitlements alone:
 * the note people see before they try, and the check for work too small to
 * reserve one by one (a search query's embedding). Billing's `reserve` is
 * the decision for everything else. Null when it can; the refusal when not.
 */
export function localRefusal(
  ent: ComputeEntitlements,
  kind: ComputeKind,
  isPublic: boolean,
): ComputeRefusalCode | null {
  if (ent.paused) return "paused";
  if (ent.plan !== "free") return null;
  if (ent.compute) return null;
  if (ent.trialVerified && ent.trialMicrosLeft > 0) return null;
  if (isPublic && OSS_KINDS.has(kind) && ent.trialVerified) return null;
  return ent.trialVerified && ent.trialMicrosLeft <= 0 ? "trial_used" : "not_paid";
}

/** Where a workspace's owners start the plan or the trial. */
export function billingPath(workspace: string): string {
  return `/${workspace.toLowerCase()}/-/billing`;
}

const WHAT: Record<ComputeKind, string> = {
  agent: "Agents need",
  check: "Checks run in g1t's sandboxes, which need",
  workflow: "Workflows run in g1t's sandboxes, which need",
  queue: "The merge queue runs in g1t's sandboxes, which needs",
  deploy: "Deployments need",
  embedding: "Semantic search needs",
};

/** What people are told when compute is refused: plain, with what to do and where. */
export function refusalMessage(
  code: GateRefusalCode,
  workspace: string,
  kind: ComputeKind,
  detail?: string | null,
): string {
  const link = billingPath(workspace);
  switch (code) {
    case "not_paid": {
      const oss = OSS_KINDS.has(kind)
        ? " Public repositories can use g1t's open-source pool instead, after a card check."
        : "";
      return `${WHAT[kind]} a paid workspace.${oss} Start the $20 plan or try it with $5 of free usage after a card check: ${link}`;
    }
    case "trial_used":
      return `This workspace has used its $5 of free usage. Start the $20 plan to keep going: ${link}`;
    case "limit":
      return `This workspace reached its spend limit for the month, so nothing new starts. An owner can raise it: ${link}#limit`;
    case "paused":
      return `g1t paused compute for this workspace${detail ? `: ${detail.replace(/.$/, "")}` : ""}. Contact support@g1t.sh to have it looked at.`;
    case "oss_pool_empty":
      return `g1t's open-source pool is used up for this month, so checks and workflows on public repositories wait until next month. Start the $20 plan to run them now: ${link}`;
    case "issue_cap":
      return `${detail ?? "This issue's agents reached its spending cap"}. An owner can raise the cap per issue: ${link}#caps`;
    case "billing_unavailable":
      return "g1t could not reach its billing service, so it did not start this. Try again in a minute.";
  }
}

/**
 * The note people see before they try to start `kind`, when their
 * workspace's plan would refuse it: plain, with where to fix it. Null when
 * it would go ahead.
 */
export function computeNote(
  ent: ComputeEntitlements,
  kind: ComputeKind,
  isPublic: boolean,
  workspace: string,
): string | null {
  const refused = localRefusal(ent, kind, isPublic);
  if (!refused) return null;
  const link = billingPath(workspace);
  if (refused === "paused") return refusalMessage("paused", workspace, kind, ent.paused);
  if (refused === "trial_used") {
    return `This workspace has used its free trial. ${WHAT[kind]} a paid workspace: ${link}`;
  }
  if (OSS_KINDS.has(kind) && isPublic) {
    return `${WHAT[kind]} a paid workspace or the free trial. On a public repository, g1t's open-source pool runs them after a card check: ${link}`;
  }
  return `${WHAT[kind]} a paid workspace or the free trial: ${link}`;
}

// ---- Estimates --------------------------------------------------------------

/** The kinds of agent run, as the runner names them. */
export type AgentRunKind = "implement" | "revise" | "review" | "answer" | "update" | "plan" | "reply";

/**
 * What the model part of each kind of agent run costs g1t, on average, from
 * measured runs: implement about $0.094, review $0.07, plan $0.104. The
 * rest are scaled from those by how much they do.
 */
export const MODEL_ESTIMATE_MICROS: Record<AgentRunKind, number> = {
  implement: 100_000,
  revise: 100_000,
  review: 70_000,
  plan: 100_000,
  update: 50_000,
  answer: 30_000,
  reply: 30_000,
};

/**
 * What one second of a sandbox costs g1t, in millionths of a dollar, when
 * the price book cannot be read: Containers standard-1 with its Durable
 * Object, rounded up.
 */
export const FALLBACK_SANDBOX_MICROS_PER_SECOND = 25;

/** What Workers AI's embedding model costs g1t per token. */
export const EMBEDDING_MICROS_PER_TOKEN = 0.067;

/** A sandbox for `minutes` at `microsPerSecond`. */
export function sandboxEstimateMicros(minutes: number, microsPerSecond: number): number {
  return Math.ceil(Math.max(0, minutes) * 60 * Math.max(0, microsPerSecond));
}

/**
 * An agent run: its model's average, unless the workspace's own provider
 * pays for the model, plus its sandbox for its whole time cap.
 */
export function agentEstimateMicros(
  task: AgentRunKind,
  minutes: number,
  microsPerSecond: number,
  ownModel = false,
): number {
  return (ownModel ? 0 : MODEL_ESTIMATE_MICROS[task]) + sandboxEstimateMicros(minutes, microsPerSecond);
}

/** Embedding `tokens` of text. */
export function embeddingEstimateMicros(tokens: number): number {
  return Math.ceil(Math.max(0, tokens) * EMBEDDING_MICROS_PER_TOKEN);
}

/** What a sandbox that ran `seconds` cost, plus a model's cost in dollars. */
export function actualMicros(seconds: number, microsPerSecond: number, modelUsd = 0): number {
  const model = Number.isFinite(modelUsd) && modelUsd > 0 ? modelUsd * 1_000_000 : 0;
  return Math.ceil(Math.max(0, seconds) * Math.max(0, microsPerSecond) + model);
}

// ---- Caps ---------------------------------------------------------------------

/** The lower of two caps, where null, zero or less means no cap. */
export function lowerCap(a: number | null | undefined, b: number | null | undefined): number | null {
  const caps = [a, b].filter((cap): cap is number => typeof cap === "number" && Number.isFinite(cap) && cap > 0);
  return caps.length ? Math.min(...caps) : null;
}

/** A run's time cap: the guardrails' and the plan's, whichever is lower. */
export function runMinutes(guardMinutes: number, ent: ComputeEntitlements | null): number {
  return lowerCap(guardMinutes, ent?.maxRunMinutes) ?? guardMinutes;
}

/** A run's cost cap in dollars: the guardrails' and the plan's, whichever is lower. */
export function runBudgetUsd(guardBudgetUsd: number | null, ent: ComputeEntitlements | null): number | null {
  const planCap = ent && ent.runCapMicros > 0 ? ent.runCapMicros / 1_000_000 : null;
  return lowerCap(guardBudgetUsd, planCap);
}

// ---- Agents at once ---------------------------------------------------------------

/** How a run waiting for room says so; `isWaiting` recognises it. */
export const WAITING_PREFIX = "Waiting for a free slot";

/** Whether another agent run fits under the workspace's cap. */
export function slotFree(activeAgents: number, ent: ComputeEntitlements | null): boolean {
  if (!ent || ent.maxConcurrentAgents <= 0 || alwaysPasses(ent.plan)) return true;
  return activeAgents < ent.maxConcurrentAgents;
}

export function waitingMessage(max: number): string {
  return `${WAITING_PREFIX}: this workspace runs ${max} ${max === 1 ? "agent" : "agents"} at a time and all are busy. It starts by itself when one finishes.`;
}

export function isWaiting(message: string | null | undefined): boolean {
  return typeof message === "string" && message.startsWith(WAITING_PREFIX);
}

/** Why an issue's agents may not start again: they spent its cap. Null when they may. */
export function issueCapReached(spentMicros: number, ent: ComputeEntitlements | null, issue: number): string | null {
  if (!ent || ent.issueCapMicros <= 0 || alwaysPasses(ent.plan)) return null;
  if (spentMicros < ent.issueCapMicros) return null;
  const dollars = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;
  return `The agents on #${issue} have spent ${dollars(spentMicros)}, its cap of ${dollars(ent.issueCapMicros)}, so g1t will not start on it again`;
}

// ---- The gate -------------------------------------------------------------------

/** Where the last plan seen for each workspace is kept, for when billing is down. */
export interface PlanMemory {
  get(workspace: string): Promise<ComputePlan | null>;
  put(workspace: string, plan: ComputePlan): Promise<void>;
}

/** The part of the Cache API this uses. */
type PlanCache = {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
};

const PLAN_MEMORY_SECONDS = 24 * 60 * 60;
const isolatePlans = new Map<string, { plan: ComputePlan; until: number }>();

/**
 * The last plan seen, in this isolate and in the Cache API (where the
 * runtime has one), for a day.
 */
export const defaultPlanMemory: PlanMemory = {
  async get(workspace) {
    const kept = isolatePlans.get(workspace);
    if (kept && kept.until > Date.now()) return kept.plan;
    const cache = (globalThis as { caches?: { default?: PlanCache } }).caches?.default;
    if (!cache) return null;
    try {
      const hit = await cache.match(planKey(workspace));
      const plan = hit ? await hit.text() : null;
      return plan && PLANS.has(plan) ? (plan as ComputePlan) : null;
    } catch {
      return null;
    }
  },
  async put(workspace, plan) {
    isolatePlans.set(workspace, { plan, until: Date.now() + PLAN_MEMORY_SECONDS * 1000 });
    const cache = (globalThis as { caches?: { default?: PlanCache } }).caches?.default;
    if (!cache) return;
    try {
      await cache.put(
        planKey(workspace),
        new Response(plan, { headers: { "cache-control": `max-age=${PLAN_MEMORY_SECONDS}` } }),
      );
    } catch {
      // Remembering is a convenience; the isolate's copy is enough.
    }
  },
};

function planKey(workspace: string): string {
  return `https://compute-gate.g1t.internal/plan/${encodeURIComponent(workspace)}`;
}

export type ReserveRequest = {
  workspace: string;
  repo: RepoPath;
  public: boolean;
  kind: ComputeKind;
  estimateMicros: number;
  /** An agent run on g1t's hosted models, which g1t's daily spend breaker can pause. Unsaid, an agent run is taken to be one. */
  hostedModel?: boolean;
};

/** The gate's answer: go ahead (with what was reserved, if anything), or why not. */
export type Admission =
  | { ok: true; reservation: Reservation | null; entitlements: ComputeEntitlements | null }
  | { ok: false; code: GateRefusalCode; message: string; entitlements: ComputeEntitlements | null };

const ENTITLEMENTS_SECONDS = 30;
/**
 * An answer that holds compute back (paused, or a free workspace without
 * compute) is kept only a few seconds: the owner who just resumed it or
 * added a plan presses Run next, and must not be refused by a copy from
 * before they did.
 */
const HOLDING_BACK_SECONDS = 3;
const PRICE_SECONDS = 10 * 60;

/** How long the gate keeps an entitlements answer, in seconds. */
export function entitlementsKeptSeconds(ent: ComputeEntitlements): number {
  const holdsBack = Boolean(ent.paused) || (ent.plan === "free" && !ent.compute);
  return holdsBack ? HOLDING_BACK_SECONDS : ENTITLEMENTS_SECONDS;
}

export class ComputeGate {
  private ents = new Map<string, { value: ComputeEntitlements; until: number }>();
  private price: { value: number; until: number } | null = null;

  private readonly billing: ServiceBinding;
  private readonly memory: PlanMemory;
  private readonly log: (...args: unknown[]) => void;

  // Plain fields, not parameter properties: Node's type stripping, which
  // the services' tests run under, does not take those.
  constructor(
    billing: ServiceBinding,
    memory: PlanMemory = defaultPlanMemory,
    log: (...args: unknown[]) => void = console.log,
  ) {
    this.billing = billing;
    this.memory = memory;
    this.log = log;
  }

  private async call<T>(method: string, args: object): Promise<T> {
    const response = await this.billing.fetch(`https://service/rpc/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!response.ok) throw new Error(`${method} failed with status ${response.status}`);
    return (await response.json()) as T;
  }

  /**
   * The workspace's entitlements, kept for half a minute. Null when billing
   * cannot say; never throws.
   */
  async entitlements(workspace: string): Promise<ComputeEntitlements | null> {
    const slug = workspace.toLowerCase();
    const kept = this.ents.get(slug);
    if (kept && kept.until > Date.now()) return kept.value;
    try {
      const ent = readEntitlements(await this.call<unknown>("entitlements", { workspace: slug }));
      if (!ent) throw new Error("entitlements did not say the workspace's plan");
      this.ents.set(slug, { value: ent, until: Date.now() + entitlementsKeptSeconds(ent) * 1000 });
      await this.memory.put(slug, ent.plan);
      return ent;
    } catch (error) {
      this.log("compute gate: entitlements unavailable", slug, String(error));
      return null;
    }
  }

  /** What one second of a sandbox costs g1t, from the price book. */
  async microsPerSecond(): Promise<number> {
    if (this.price && this.price.until > Date.now()) return this.price.value;
    let value = FALLBACK_SANDBOX_MICROS_PER_SECOND;
    try {
      const book = await this.call<{ prices?: { meter: string; costMicros?: number; cost_micros?: number }[] }>("prices", {});
      const meter = book.prices?.find((price) => price.meter === "sandbox_second");
      const cost = meter?.costMicros ?? meter?.cost_micros;
      if (typeof cost === "number" && cost > 0) value = cost;
    } catch (error) {
      this.log("compute gate: price book unavailable", String(error));
    }
    this.price = { value, until: Date.now() + PRICE_SECONDS * 1000 };
    return value;
  }

  /**
   * Asks billing to reserve what `request` is expected to cost. Refused
   * when billing refuses, or when billing cannot be reached for a workspace
   * that is not known to pay (see the module's comment). Never throws.
   */
  async admit(request: ReserveRequest, known?: ComputeEntitlements | null): Promise<Admission> {
    const workspace = request.workspace.toLowerCase();
    const ent = known === undefined ? await this.entitlements(workspace) : known;
    const refuse = (code: GateRefusalCode, message?: string | null): Admission => ({
      ok: false,
      code,
      message: message || refusalMessage(code, workspace, request.kind, ent?.paused),
      entitlements: ent,
    });
    if (ent?.paused) return refuse("paused");
    const plan = ent?.plan ?? (await this.memory.get(workspace));
    let answer: Result<unknown>;
    try {
      answer = await this.call<Result<unknown>>("reserve", {
        workspace,
        repo: request.repo,
        public: request.public,
        kind: request.kind,
        estimateMicros: Math.max(0, Math.ceil(request.estimateMicros)),
        ...(request.hostedModel === undefined ? {} : { hostedModel: request.hostedModel }),
      });
    } catch (error) {
      return this.unavailable(plan, refuse, ent, request, String(error));
    }
    if (answer.ok) {
      const reservation = readReservation(answer.value);
      if (!reservation) return this.unavailable(plan, refuse, ent, request, "reserve answered without a reservation");
      return { ok: true, reservation, entitlements: ent };
    }
    const code = refusalCode(answer.error as { code?: unknown; reason?: unknown });
    if (!code) return this.unavailable(plan, refuse, ent, request, answer.error.message);
    // A pause holds for every plan: g1t's own caps (a comped account's
    // monthly budget, the daily spend breaker) and staff holds included.
    if (alwaysPasses(plan) && code !== "paused") {
      this.log("compute gate: refusal ignored for", plan, workspace, request.kind, code, answer.error.message);
      return { ok: true, reservation: null, entitlements: ent };
    }
    // Billing's own words when it gave them; they carry the link to act on.
    return refuse(code, answer.error.message || null);
  }

  private unavailable(
    plan: ComputePlan | null,
    refuse: (code: GateRefusalCode, message?: string | null) => Admission,
    ent: ComputeEntitlements | null,
    request: ReserveRequest,
    why: string,
  ): Admission {
    if (onBillingError(plan) === "allow") {
      this.log("compute gate: billing unavailable; allowed for", plan, request.workspace, request.kind, why);
      return { ok: true, reservation: null, entitlements: ent };
    }
    this.log("compute gate: billing unavailable; refused for", plan ?? "unknown plan", request.workspace, request.kind, why);
    return refuse("billing_unavailable");
  }

  /** Settles a reservation at what the work cost. Never throws; a failure is logged. */
  async settle(reservationId: string, actual: number): Promise<void> {
    const micros = Math.max(0, Math.ceil(actual));
    try {
      const settled = await this.call<Result<unknown>>("settle", { reservationId, actualMicros: micros });
      if (settled && settled.ok === false) this.log("compute gate: settle refused", reservationId, settled.error.message);
    } catch (error) {
      this.log("compute gate: settle failed", reservationId, micros, String(error));
    }
  }
}
