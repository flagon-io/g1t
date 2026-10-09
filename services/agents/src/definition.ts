/**
 * An agent's definition: what a new one gets by default, what a change may
 * set, and how a stored row reads. Pure, so it is tested on its own.
 */
import type {
  AgentAutonomy,
  AgentBudget,
  AgentRouting,
  NewWorkspaceAgent,
  PersonalityPreset,
} from "@g1t/contracts";

import { checkHandle } from "./handle.ts";
import { isTier, limitsAgree } from "./routing.ts";

export const PRESETS: PersonalityPreset[] = ["crisp", "friendly", "socratic", "terse"];

export const DEFAULT_ROUTING: AgentRouting = { floor: null, ceiling: null, providers: [], pinned: null };
export const DEFAULT_BUDGET: AgentBudget = { monthly_micros: null, daily_micros: null, task_micros: null };
/** What an agent may do alone until someone says otherwise: open pull requests; the rest asks. */
export const DEFAULT_AUTONOMY: AgentAutonomy = {
  open_pull_requests: "alone",
  merge: "approval",
  deploy_production: "approval",
  edit_docs: "suggest",
};
/** Tasks at once (docs/WORKSPACE.md, "Decisions to confirm"). */
export const DEFAULT_CAPACITY = 3;
export const MAX_CAPACITY = 10;

const LIMITS = { displayName: 64, role: 120, instructions: 8000, personality: 1000, providers: 10, pinned: 200 };
/** $100,000 in millionths: a cap above this is a typo. */
const MAX_MICROS = 100_000_000_000;

/** Everything a definition holds, complete: what is stored and versioned. */
export type Definition = {
  handle: string;
  display_name: string;
  role: string;
  instructions: string;
  personality_preset: PersonalityPreset;
  personality: string;
  routing: AgentRouting;
  budget: AgentBudget;
  autonomy: AgentAutonomy;
  capacity: number;
  template: string | null;
};

export type Checked<T> = { ok: true; value: T } | { ok: false; message: string };

const bad = (message: string): { ok: false; message: string } => ({ ok: false, message });

function text(value: unknown, what: string, max: number, required: boolean): Checked<string> {
  if (value === undefined || value === null) return required ? bad(`${what} is required.`) : { ok: true, value: "" };
  if (typeof value !== "string") return bad(`${what} is text.`);
  const trimmed = value.trim();
  if (required && !trimmed) return bad(`${what} is required.`);
  if (trimmed.length > max) return bad(`${what} is at most ${max} characters.`);
  return { ok: true, value: trimmed };
}

function routingOf(base: AgentRouting, given: unknown): Checked<AgentRouting> {
  if (given === undefined || given === null) return { ok: true, value: base };
  if (typeof given !== "object") return bad("Routing is an object.");
  const g = given as Partial<AgentRouting>;
  const next: AgentRouting = { ...base };
  for (const key of ["floor", "ceiling"] as const) {
    if (g[key] === undefined) continue;
    if (g[key] !== null && !isTier(g[key])) return bad(`The ${key} is small, large, frontier or none.`);
    next[key] = g[key] ?? null;
  }
  if (!limitsAgree(next.floor, next.ceiling)) return bad("The floor is above the ceiling: lower the floor or raise the ceiling.");
  if (g.providers !== undefined) {
    if (!Array.isArray(g.providers) || g.providers.some((p) => typeof p !== "string" || !p.trim())) return bad("Providers is a list of names.");
    const providers = [...new Set(g.providers.map((p) => p.trim()))];
    if (providers.length > LIMITS.providers) return bad(`An agent names at most ${LIMITS.providers} providers.`);
    next.providers = providers;
  }
  if (g.pinned !== undefined) {
    if (g.pinned === null || g.pinned === "") next.pinned = null;
    else if (typeof g.pinned !== "string" || g.pinned.trim().length > LIMITS.pinned || !/^[^/\s]+\/\S+$/.test(g.pinned.trim())) {
      return bad("A pinned model is written provider/model.");
    } else next.pinned = g.pinned.trim();
  }
  return { ok: true, value: next };
}

function budgetOf(base: AgentBudget, given: unknown): Checked<AgentBudget> {
  if (given === undefined || given === null) return { ok: true, value: base };
  if (typeof given !== "object") return bad("Budget is an object.");
  const g = given as Partial<AgentBudget>;
  const next: AgentBudget = { ...base };
  for (const key of ["monthly_micros", "daily_micros", "task_micros"] as const) {
    const value = g[key];
    if (value === undefined) continue;
    if (value === null) next[key] = null;
    else if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_MICROS) {
      return bad("A budget is a whole number of millionths of a dollar, or none.");
    } else next[key] = value;
  }
  return { ok: true, value: next };
}

const AUTONOMY_CHOICES: { [K in keyof AgentAutonomy]: AgentAutonomy[K][] } = {
  open_pull_requests: ["alone", "approval"],
  merge: ["alone", "approval", "never"],
  deploy_production: ["approval", "never"],
  edit_docs: ["alone", "suggest"],
};

function autonomyOf(base: AgentAutonomy, given: unknown): Checked<AgentAutonomy> {
  if (given === undefined || given === null) return { ok: true, value: base };
  if (typeof given !== "object") return bad("Autonomy is an object.");
  const next = { ...base } as Record<string, string>;
  for (const [key, choices] of Object.entries(AUTONOMY_CHOICES) as [string, string[]][]) {
    const value = (given as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !choices.includes(value)) return bad(`${key} is one of ${choices.join(", ")}.`);
    next[key] = value;
  }
  return { ok: true, value: next as AgentAutonomy };
}

/**
 * `changes` applied to `base` (a new agent's defaults, or its current
 * definition), checked. `templates` are the template ids an agent may name.
 */
export function applyChanges(base: Definition | null, changes: Partial<NewWorkspaceAgent>, templates: string[]): Checked<Definition> {
  if (!changes || typeof changes !== "object") return bad("Send the agent's fields.");
  const creating = base === null;
  const from: Definition = base ?? {
    handle: "",
    display_name: "",
    role: "",
    instructions: "",
    personality_preset: "crisp",
    personality: "",
    routing: DEFAULT_ROUTING,
    budget: DEFAULT_BUDGET,
    autonomy: DEFAULT_AUTONOMY,
    capacity: DEFAULT_CAPACITY,
    template: null,
  };
  const next: Definition = { ...from };
  if (creating || changes.handle !== undefined) {
    const handle = checkHandle(changes.handle);
    if (!handle.ok) return bad(handle.message);
    next.handle = handle.handle;
  }
  const fields = [
    ["display_name", "A display name", LIMITS.displayName, true],
    ["role", "The role", LIMITS.role, true],
    ["instructions", "The instructions", LIMITS.instructions, true],
    ["personality", "The personality", LIMITS.personality, false],
  ] as const;
  for (const [key, what, max, required] of fields) {
    if (!creating && changes[key] === undefined) continue;
    const value = text(changes[key], what, max, required);
    if (!value.ok) return value;
    next[key] = value.value;
  }
  if (changes.personality_preset !== undefined) {
    if (!PRESETS.includes(changes.personality_preset)) return bad(`The personality preset is one of ${PRESETS.join(", ")}.`);
    next.personality_preset = changes.personality_preset;
  }
  const routing = routingOf(next.routing, changes.routing);
  if (!routing.ok) return routing;
  next.routing = routing.value;
  const budget = budgetOf(next.budget, changes.budget);
  if (!budget.ok) return budget;
  next.budget = budget.value;
  const autonomy = autonomyOf(next.autonomy, changes.autonomy);
  if (!autonomy.ok) return autonomy;
  next.autonomy = autonomy.value;
  if (changes.capacity !== undefined) {
    const capacity = changes.capacity;
    if (typeof capacity !== "number" || !Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) {
      return bad(`Capacity is 1 to ${MAX_CAPACITY} tasks at once.`);
    }
    next.capacity = capacity;
  }
  if (changes.template !== undefined) {
    if (changes.template !== null && !templates.includes(changes.template)) return bad("There is no such template.");
    next.template = changes.template;
  }
  return { ok: true, value: next };
}

/** A stored JSON column, read defensively: a bad value is the default. */
export function readJson<T extends object>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string") return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { ...fallback, ...(parsed as T) } : fallback;
  } catch {
    return fallback;
  }
}
