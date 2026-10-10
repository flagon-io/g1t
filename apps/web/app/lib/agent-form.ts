/**
 * The agent form (components/agents-mode.tsx) as the agents service takes
 * it: what each field means, and the checks made before it is sent. Pure,
 * so it is tested on its own.
 */
import type { AgentEffort, AgentLook, ModelTier, NewWorkspaceAgent, PersonalityPreset, SubagentDef, WorkspaceAgent } from "@g1t/contracts";
import { readLook } from "@g1t/contracts/agent-look";

import { plainDollars } from "./money.ts";

/** An effort setting from a form: one of the five, or null. */
export function readEffort(value: FormDataEntryValue | null): AgentEffort | null {
  const text = String(value ?? "");
  return text === "auto" || text === "low" || text === "medium" || text === "high" || text === "max" ? text : null;
}

/** The tiers, cheapest first: `MODEL_TIERS` in the contracts. */
const MODEL_TIERS: ModelTier[] = ["small", "large", "frontier"];

export const PRESETS: { value: PersonalityPreset; label: string; about: string }[] = [
  { value: "crisp", label: "Crisp", about: "Clear and to the point, with enough context to act on." },
  { value: "friendly", label: "Friendly", about: "Warm and encouraging; explains as it goes." },
  { value: "socratic", label: "Socratic", about: "Asks before it assumes; draws out what you mean." },
  { value: "terse", label: "Terse operator", about: "As few words as will do. Status, then done." },
];

export const TIER_LABELS: Record<ModelTier, string> = {
  small: "Fast: replies and triage",
  large: "Standard: making changes, most reviews",
  frontier: "Most capable: planning and hard work",
};

export const AUTONOMY = {
  open_pull_requests: { label: "Open pull requests", options: [["alone", "On its own"], ["approval", "After approval"]] },
  merge: { label: "Merge", options: [["alone", "On its own"], ["approval", "After approval"], ["never", "Never"]] },
  deploy_production: { label: "Deploy to production", options: [["approval", "After approval"], ["never", "Never"]] },
  edit_docs: { label: "Edit docs", options: [["alone", "Directly"], ["suggest", "As suggestions"]] },
} as const;

/** The handle as people type it: lowercase letters, digits and dashes. */
export function cleanHandle(typed: string): string {
  return typed
    .trim()
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 39);
}

/** Handles the site's own addresses use, and g1t's: never an agent's. */
const RESERVED_HANDLES = new Set(["g1t", "new", "runs", "fleet"]);

function tier(value: FormDataEntryValue | null): ModelTier | null {
  const text = String(value ?? "");
  return (MODEL_TIERS as string[]).includes(text) ? (text as ModelTier) : null;
}

function pick<T extends string>(value: FormDataEntryValue | null, allowed: readonly (readonly [T, string])[], fallback: T): T {
  const text = String(value ?? "");
  return (allowed.find(([key]) => key === text)?.[0] ?? fallback) as T;
}

export type AgentFormResult = { ok: true; input: NewWorkspaceAgent } | { ok: false; errors: Record<string, string> };

/** The form, checked: the agent to make or the changes to save, or what to fix, by field. */
export function readAgentForm(form: FormData, options: { orchestrator?: boolean } = {}): AgentFormResult {
  const errors: Record<string, string> = {};
  const display_name = String(form.get("display_name") ?? "").trim();
  const handle = cleanHandle(String(form.get("handle") ?? "") || display_name);
  const title = String(form.get("title") ?? "").trim();
  const responsibilities = form
    .getAll("responsibility")
    .map((value) => String(value).trim())
    .filter(Boolean)
    .slice(0, MAX_RESPONSIBILITIES);
  const subagents = readSubagents(form.get("subagents"));
  // Docs spaces it reads first; the agents service checks them.
  const reading = [...new Set(form.getAll("reading").map((value) => String(value).trim()).filter(Boolean))].slice(0, 10);
  const instructions = String(form.get("instructions") ?? "").trim();
  if (!display_name) errors.display_name = "Give it a name.";
  if (!handle) errors.handle = "Give it a handle, like @ship.";
  else if (RESERVED_HANDLES.has(handle) && !(options.orchestrator && handle === "g1t")) errors.handle = `@${handle} is taken by g1t.`;
  if (!title && !options.orchestrator) errors.title = "Give it a title, like QA Engineer.";
  if (subagents == null) errors.subagents = "The subagents couldn't be read. Edit one and save again.";
  // g1t's job is fixed; what is written here is added to it, and may be nothing.
  if (!instructions && !options.orchestrator) errors.instructions = "Tell it what it's responsible for.";
  const floor = tier(form.get("floor"));
  const ceiling = tier(form.get("ceiling"));
  if (floor && ceiling && MODEL_TIERS.indexOf(floor) > MODEL_TIERS.indexOf(ceiling)) errors.ceiling = "The ceiling can't be below the floor.";
  const budget = {
    monthly_micros: microsFromDollars(form.get("monthly")),
    daily_micros: microsFromDollars(form.get("daily")),
    task_micros: microsFromDollars(form.get("task")),
  };
  for (const [field, value] of [["monthly", budget.monthly_micros], ["daily", budget.daily_micros], ["task", budget.task_micros]] as const) {
    if (value != null && Number.isNaN(value)) errors[field] = "A sum in dollars, like 25.";
  }
  const capacity = Number(form.get("capacity") ?? 3);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 20) errors.capacity = "Between 1 and 20.";
  const providers = String(form.get("providers") ?? "any");
  const pinned = String(form.get("pinned") ?? "").trim();
  // How hard it works; a form without the control leaves it as it is.
  const effort = readEffort(form.get("effort"));
  if (pinned && !/^[\w.-]+\/[\w.:@-]+$/.test(pinned)) errors.pinned = "As provider/model.";
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    input: {
      handle,
      display_name,
      // Its title, made by the agents service.
      role: "",
      title,
      responsibilities,
      subagents: subagents ?? [],
      reading,
      instructions,
      personality_preset: pick(form.get("personality_preset"), PRESETS.map((p) => [p.value, p.label] as const), "crisp"),
      personality: String(form.get("personality") ?? "").trim(),
      routing: {
        floor,
        ceiling,
        providers: providers === "any" ? [] : [providers],
        pinned: pinned || null,
        ...(effort ? { effort } : {}),
      },
      budget,
      autonomy: {
        open_pull_requests: pick(form.get("open_pull_requests"), AUTONOMY.open_pull_requests.options, "alone"),
        merge: pick(form.get("merge"), AUTONOMY.merge.options, "approval"),
        deploy_production: pick(form.get("deploy_production"), AUTONOMY.deploy_production.options, "approval"),
        edit_docs: pick(form.get("edit_docs"), AUTONOMY.edit_docs.options, "suggest"),
      },
      capacity,
      template: String(form.get("template") ?? "") || null,
      // A drafted agent carries its scope, the skills it keeps off and its face.
      ...(form.get("scope") === "personal" || form.get("scope") === "workspace" ? { scope: form.get("scope") as "personal" | "workspace" } : {}),
      ...(form.has("skills_off") ? { skills_off: String(form.get("skills_off") ?? "").split(",").map((id) => id.trim()).filter(Boolean) } : {}),
      ...(String(form.get("avatar_seed") ?? "").trim() ? { avatar_seed: String(form.get("avatar_seed")).trim().slice(0, 64) } : {}),
      // Its face: a chosen look, or `null` for the seed's; a form without the field leaves it as it is.
      ...readLookField(form.get("look")),
    },
  };
}

/** Most responsibilities an agent lists. */
export const MAX_RESPONSIBILITIES = 8;

/**
 * The Face section's field: `null` (the word) gives the agent back its
 * seed's face, a look as JSON sets one, and nothing or something that is
 * not a look changes nothing.
 */
export function readLookField(value: FormDataEntryValue | null): { look?: AgentLook | null } {
  const text = String(value ?? "").trim();
  if (!text) return {};
  if (text === "null") return { look: null };
  const look = readLook(text);
  return look ? { look } : {};
}

/** The subagents, as the form sends them (JSON); null when they are not valid. */
function readSubagents(value: FormDataEntryValue | null): SubagentDef[] | null {
  const text = String(value ?? "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (item): item is SubagentDef =>
        item != null && typeof item === "object" && typeof (item as SubagentDef).name === "string" && typeof (item as SubagentDef).description === "string",
    );
  } catch {
    return null;
  }
}

/** A subagent's name: lowercase letters, digits and hyphens. */
export function cleanSubagentName(typed: string): string {
  return cleanHandle(typed).slice(0, 40);
}

/**
 * A subagent's routing limits, kept within its agent's: a floor below the
 * agent's is raised to it, a ceiling above the agent's is lowered to it,
 * and a floor above the ceiling comes down to it.
 */
export function clampRouting(
  sub: { floor: ModelTier | null; ceiling: ModelTier | null },
  agent: { floor: ModelTier | null; ceiling: ModelTier | null },
): { floor: ModelTier | null; ceiling: ModelTier | null } {
  const rank = (tier: ModelTier) => MODEL_TIERS.indexOf(tier);
  let floor = sub.floor;
  let ceiling = sub.ceiling;
  if (agent.floor && (!floor || rank(floor) < rank(agent.floor))) floor = agent.floor;
  if (agent.ceiling && (!ceiling || rank(ceiling) > rank(agent.ceiling))) ceiling = agent.ceiling;
  if (floor && ceiling && rank(floor) > rank(ceiling)) floor = ceiling;
  return { floor, ceiling };
}

/**
 * The teams a new agent joins as it is made (the form's "Add to teams"),
 * by slug: membership is the team's, never part of the agent.
 */
export function readTeams(form: FormData): string[] {
  return [...new Set(form.getAll("teams").map((value) => String(value).trim().toLowerCase()).filter((slug) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)))].slice(0, 20);
}

/** What the form starts from: an agent being edited, a template, or nothing. */
export type AgentDraft = Pick<
  WorkspaceAgent,
  | "handle"
  | "display_name"
  | "role"
  | "title"
  | "responsibilities"
  | "subagents"
  | "reading"
  | "instructions"
  | "personality_preset"
  | "personality"
  | "routing"
  | "budget"
  | "autonomy"
  | "capacity"
  | "template"
  | "look"
>;

export const BLANK_DRAFT: AgentDraft = {
  handle: "",
  display_name: "",
  role: "",
  title: "",
  responsibilities: [],
  subagents: [],
  reading: [],
  instructions: "",
  personality_preset: "crisp",
  personality: "",
  routing: { floor: null, ceiling: null, providers: [], pinned: null, effort: "auto" },
  budget: { monthly_micros: 50_000_000, daily_micros: null, task_micros: 5_000_000 },
  autonomy: { open_pull_requests: "alone", merge: "approval", deploy_production: "approval", edit_docs: "suggest" },
  capacity: 3,
  template: null,
  look: null,
};

/** Dollars from micro-dollars, for a form field: empty for none, `20` for a whole sum, else to the cent. */
export function dollarsField(micros: number | null | undefined): string {
  if (micros == null) return "";
  return plainDollars(micros, { whole: true });
}

/** Micro-dollars from a form field in dollars: null when empty, NaN when not a sum. */
export function microsFromDollars(value: FormDataEntryValue | null): number | null {
  const text = String(value ?? "").trim().replace(/^\$/, "").replaceAll(",", "");
  if (!text) return null;
  const dollars = Number(text);
  if (!Number.isFinite(dollars) || dollars < 0) return Number.NaN;
  return Math.round(dollars * 1_000_000);
}

