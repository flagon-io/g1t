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
  AgentFaces,
  SubagentDef,
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

const LIMITS = { displayName: 64, role: 120, title: 60, department: 40, duty: 160, instructions: 8000, personality: 1000, providers: 10, pinned: 200 };
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
  /** What its generated avatar is drawn from. */
  avatar_seed: string;
  title: string;
  team: string | null;
  department: string;
  responsibilities: string[];
  subagents: SubagentDef[];
  faces: AgentFaces;
  /** Docs spaces it reads first. */
  reading: string[];
};

/** The one-line role a title and team (or department) make: "QA Engineer on the qa team". */
export function roleOf(d: Pick<Definition, "title" | "team" | "department">): string {
  const title = d.title.trim();
  if (!title) return "";
  if (d.team) return `${title} on the ${d.team} team`;
  return d.department.trim() ? `${title}, ${d.department.trim()}` : title;
}

export const MAX_SUBAGENTS = 8;

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

function responsibilitiesOf(given: unknown): Checked<string[]> {
  if (!Array.isArray(given) || given.some((d) => typeof d !== "string")) return bad("Responsibilities are a list of short duties.");
  const duties = [...new Set((given as string[]).map((d) => d.trim()).filter(Boolean))];
  if (duties.length && (duties.length < 2 || duties.length > 8)) return bad("Give 2 to 8 responsibilities, or none yet.");
  if (duties.some((d) => d.length > LIMITS.duty)) return bad(`Each responsibility is at most ${LIMITS.duty} characters.`);
  return { ok: true, value: duties };
}

const ORDER = ["small", "large", "frontier"] as const;

/** A subagent's limits held within its agent's: never a lower floor, never a higher ceiling. */
export function withinParent(
  sub: { floor: AgentRouting["floor"]; ceiling: AgentRouting["ceiling"] },
  parent: Pick<AgentRouting, "floor" | "ceiling">,
): { floor: AgentRouting["floor"]; ceiling: AgentRouting["ceiling"] } {
  const at = (tier: AgentRouting["floor"]) => (tier ? ORDER.indexOf(tier) : -1);
  let floor = sub.floor;
  let ceiling = sub.ceiling;
  if (parent.floor && at(floor) < at(parent.floor)) floor = parent.floor;
  if (parent.ceiling && (!ceiling || at(ceiling) > at(parent.ceiling))) ceiling = parent.ceiling;
  // Held inside, a floor can end above the ceiling: the ceiling, the spending rail, wins.
  if (floor && ceiling && at(floor) > at(ceiling)) floor = ceiling;
  return { floor, ceiling };
}

function subagentsOf(given: unknown): Checked<SubagentDef[]> {
  if (!Array.isArray(given)) return bad("Subagents are a list.");
  if (given.length > MAX_SUBAGENTS) return bad(`An agent keeps at most ${MAX_SUBAGENTS} subagents.`);
  const out: SubagentDef[] = [];
  for (const raw of given as Partial<SubagentDef>[]) {
    if (!raw || typeof raw !== "object") return bad("Each subagent has a name, a description and instructions.");
    const name = typeof raw.name === "string" ? raw.name.trim().toLowerCase() : "";
    if (!/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,31}$/.test(name)) return bad("A subagent's name is 2 to 32 lowercase letters, digits and single hyphens.");
    if (out.some((sub) => sub.name === name)) return bad(`Two subagents are called ${name}.`);
    const description = text(raw.description, `${name}'s description`, 200, true);
    if (!description.ok) return description;
    const instructions = text(raw.instructions, `${name}'s instructions`, 4000, true);
    if (!instructions.ok) return instructions;
    const routing = raw.routing ?? { floor: null, ceiling: null };
    for (const tier of [routing.floor, routing.ceiling]) {
      if (tier !== null && tier !== undefined && !isTier(tier)) return bad(`${name}'s limits are small, large, frontier or none.`);
    }
    if (!limitsAgree(routing.floor ?? null, routing.ceiling ?? null)) return bad(`${name}'s floor is above its ceiling.`);
    const parallel = raw.max_parallel ?? 2;
    if (typeof parallel !== "number" || !Number.isInteger(parallel) || parallel < 1 || parallel > 8) return bad(`${name} runs 1 to 8 at once.`);
    out.push({
      name,
      description: description.value,
      instructions: instructions.value,
      routing: { floor: routing.floor ?? null, ceiling: routing.ceiling ?? null },
      max_parallel: parallel,
    });
  }
  return { ok: true, value: out };
}

/**
 * `changes` applied to `base` (a new agent's defaults, or its current
 * definition), checked. `templates` are the template ids an agent may name.
 */
export function applyChanges(
  base: Definition | null,
  changes: Partial<NewWorkspaceAgent>,
  templates: string[],
  options: { builtin?: boolean } = {},
): Checked<Definition> {
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
    avatar_seed: "",
    title: "",
    team: null,
    department: "",
    responsibilities: [],
    subagents: [],
    faces: "internal",
    reading: [],
  };
  const next: Definition = { ...from };
  // Whether the role was made from the title and team, so it follows them.
  const roleDerived = !from.role || from.role === roleOf(from);
  if (creating || changes.handle !== undefined) {
    const handle = checkHandle(changes.handle);
    if (!handle.ok) return bad(handle.message);
    next.handle = handle.handle;
  }
  const fields = [
    ["display_name", "A display name", LIMITS.displayName, true],
    ["role", "The role", LIMITS.role, false],
    ["title", "The title", LIMITS.title, false],
    ["department", "The department", LIMITS.department, false],
    // The built-in agent's instructions are added to its fixed job, and may be empty.
    ["instructions", "The instructions", LIMITS.instructions, !options.builtin],
    ["personality", "The personality", LIMITS.personality, false],
  ] as const;
  for (const [key, what, max, required] of fields) {
    if (!creating && changes[key] === undefined) continue;
    const value = text(changes[key], what, max, required);
    if (!value.ok) return value;
    next[key] = value.value;
  }
  if (changes.team !== undefined) {
    if (changes.team === null || changes.team === "") next.team = null;
    else if (typeof changes.team !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(changes.team.trim().toLowerCase())) {
      return bad("A team is named by its slug.");
    } else next.team = changes.team.trim().toLowerCase();
  }
  if (changes.responsibilities !== undefined) {
    const duties = responsibilitiesOf(changes.responsibilities);
    if (!duties.ok) return duties;
    next.responsibilities = duties.value;
  }
  // A role left empty, or made from the title and team before, follows them.
  if (!next.role || (changes.role === undefined && roleDerived)) next.role = roleOf(next);
  if (!next.role) return bad("Give the agent a title or a one-line role.");
  if (changes.avatar_seed !== undefined) {
    const seed = text(changes.avatar_seed, "The avatar seed", 64, false);
    if (!seed.ok) return seed;
    next.avatar_seed = seed.value;
  }
  // A new face from the handle, unless one was chosen; renaming keeps the face.
  if (!next.avatar_seed) next.avatar_seed = next.handle;
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
  if (changes.subagents !== undefined) {
    const subagents = subagentsOf(changes.subagents);
    if (!subagents.ok) return subagents;
    next.subagents = subagents.value;
  }
  if (changes.reading !== undefined) {
    if (!Array.isArray(changes.reading)) return bad("Required reading is a list of Docs spaces.");
    const ids = [...new Set(changes.reading.filter((id): id is string => typeof id === "string").map((id) => id.trim()).filter(Boolean))];
    if (ids.length > 10) return bad("An agent has at most 10 spaces of required reading.");
    if (ids.some((id) => !/^[A-Za-z0-9_-]{1,80}$/.test(id))) return bad("That isn't a Docs space.");
    next.reading = ids;
  }
  if (changes.faces !== undefined) {
    if (changes.faces === "customers") return bad("Customer-facing agents aren't available yet.");
    if (changes.faces !== "internal") return bad("An agent faces internal: the workspace's own people.");
    next.faces = "internal";
  }
  // Never wider than their agent, whichever of the two changed.
  next.subagents = next.subagents.map((sub) => ({ ...sub, routing: withinParent(sub.routing, next.routing) }));
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
