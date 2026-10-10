/**
 * The agent builder's page logic (components/agents/builder.tsx): a drafted
 * definition read back from the page, what an integration it needs asks of
 * the person, and a change drafted in words as a before-and-after. Pure,
 * with type-only contract imports and the connector catalog, so it is
 * tested under Node.
 */
import type { AgentBudget, AgentRouting, NewWorkspaceAgent, PersonalityPreset, WorkspaceAgent, WorkspaceAgentScope } from "@g1t/contracts";
import { connectorById, connectorPath } from "@g1t/contracts/connectors";

/** The draft as the page keeps it while it is edited: everything `create` takes, and its scope. */
export type BuilderDefinition = NewWorkspaceAgent & { scope: WorkspaceAgentScope; avatar_seed?: string };

const PRESETS: PersonalityPreset[] = ["crisp", "friendly", "socratic", "terse"];
const TIERS = ["small", "large", "frontier"] as const;

/**
 * A definition the page sent back as JSON, checked for shape: the agents
 * service checks every rule again. Null when it isn't one.
 */
export function readDefinition(raw: FormDataEntryValue | null): BuilderDefinition | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw ?? ""));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const d = parsed as Record<string, unknown>;
  const text = (key: string, max: number) => (typeof d[key] === "string" ? (d[key] as string).trim().slice(0, max) : "");
  const list = (key: string, max: number, count: number) =>
    Array.isArray(d[key]) ? (d[key] as unknown[]).filter((v): v is string => typeof v === "string").map((v) => v.trim().slice(0, max)).filter(Boolean).slice(0, count) : [];
  const tier = (value: unknown) => ((TIERS as readonly unknown[]).includes(value) ? (value as AgentRouting["floor"]) : null);
  const routing = (d.routing && typeof d.routing === "object" ? d.routing : {}) as Partial<AgentRouting>;
  const budget = (d.budget && typeof d.budget === "object" ? d.budget : {}) as Partial<AgentBudget>;
  const micros = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null);
  return {
    handle: text("handle", 40),
    display_name: text("display_name", 64),
    title: text("title", 60),
    department: text("department", 40),
    team: null,
    role: "",
    instructions: text("instructions", 8000),
    responsibilities: list("responsibilities", 160, 8),
    personality_preset: PRESETS.includes(d.personality_preset as PersonalityPreset) ? (d.personality_preset as PersonalityPreset) : "crisp",
    personality: text("personality", 1000),
    routing: { floor: tier(routing.floor), ceiling: tier(routing.ceiling), providers: [], pinned: null },
    budget: { monthly_micros: micros(budget.monthly_micros), daily_micros: micros(budget.daily_micros), task_micros: micros(budget.task_micros) },
    skills_off: list("skills_off", 40, 20),
    template: null,
    avatar_seed: text("avatar_seed", 64) || undefined,
    scope: d.scope === "personal" ? "personal" : "workspace",
  };
}

/** What the person is asked to do about an integration the agent needs. */
export type IntegrationHint = {
  id: string;
  name: string;
  why: string;
  /** `connect` (an owner sets it up), `ask` (anyone else asks an owner), `soon` (nobody can yet). */
  action: "connect" | "ask" | "soon";
  /** Its page in the Marketplace, which connects it or asks for it. */
  href: string;
};

export function integrationHint(slug: string, suggestion: { id: string; why: string }, owner: boolean): IntegrationHint | null {
  const connector = connectorById(suggestion.id);
  if (!connector) return null;
  const href = `/${slug}/-/marketplace/integrations/${encodeURIComponent(connector.id)}`;
  const action = connector.status === "soon" ? "soon" : owner ? "connect" : "ask";
  return { id: connector.id, name: connector.name, why: suggestion.why, action, href: action === "connect" && connector.href?.workspace ? connectorPath(connector.href.workspace, slug) : href };
}

// ── A change in words, before and after ───────────────────────────────────

export type DiffLine = { kind: "same" | "added" | "removed"; text: string };

/** Lines of `before` and `after`, as kept, removed and added (longest common subsequence). */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  // Long jobs are compared in full; past this, as removed and added wholesale.
  if (a.length * b.length > 250_000) return [...a.map((text) => ({ kind: "removed" as const, text })), ...b.map((text) => ({ kind: "added" as const, text }))];
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) out.push({ kind: "removed", text: a[i++]! });
    else out.push({ kind: "added", text: b[j++]! });
  }
  while (i < a.length) out.push({ kind: "removed", text: a[i++]! });
  while (j < b.length) out.push({ kind: "added", text: b[j++]! });
  return out;
}

/** One field a drafted change touches: its name, and the before and after as people read them. */
export type ChangeRow = { field: string; label: string; before: string; after: string; lines?: DiffLine[] };

const dollars = (micros: number | null | undefined) => (micros == null ? "No cap" : `$${(micros / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 2 })}`);
const tierWord = (tier: string | null | undefined) => (tier === "small" ? "Fast" : tier === "large" ? "Standard" : tier === "frontier" ? "Most capable" : "None");

/**
 * A drafted change as rows to review: each field it sets, before and
 * after; the job as a line diff. `skillName` names a skill by id.
 */
export function changeRows(agent: Pick<WorkspaceAgent, keyof NewWorkspaceAgent & keyof WorkspaceAgent>, changes: Partial<NewWorkspaceAgent>, skillName: (id: string) => string = (id) => id): ChangeRow[] {
  const rows: ChangeRow[] = [];
  const plain = (field: keyof NewWorkspaceAgent, label: string) => {
    const after = changes[field];
    if (after === undefined) return;
    rows.push({ field, label, before: String(agent[field as keyof typeof agent] ?? "") || "None", after: String(after ?? "") || "None" });
  };
  plain("display_name", "Name");
  if (changes.handle !== undefined) rows.push({ field: "handle", label: "Handle", before: `@${agent.handle}`, after: `@${changes.handle}` });
  plain("title", "Title");
  plain("department", "Department");
  if (changes.instructions !== undefined) {
    rows.push({ field: "instructions", label: "Job", before: agent.instructions, after: changes.instructions, lines: lineDiff(agent.instructions, changes.instructions) });
  }
  if (changes.responsibilities !== undefined) {
    const before = agent.responsibilities ?? [];
    rows.push({
      field: "responsibilities",
      label: "Responsibilities",
      before: before.join("\n"),
      after: changes.responsibilities.join("\n"),
      lines: lineDiff(before.join("\n"), changes.responsibilities.join("\n")),
    });
  }
  plain("personality_preset", "Voice");
  plain("personality", "Personality");
  if (changes.skills_off !== undefined) {
    const off = new Set(changes.skills_off);
    const was = new Set(agent.skills_off ?? []);
    const on = [...was].filter((id) => !off.has(id)).map(skillName);
    const offNow = [...off].filter((id) => !was.has(id)).map(skillName);
    rows.push({
      field: "skills_off",
      label: "Skills",
      before: [...was].length ? `Off: ${[...was].map(skillName).join(", ")}` : "All on",
      after: [on.length ? `Turned on: ${on.join(", ")}` : "", offNow.length ? `Turned off: ${offNow.join(", ")}` : ""].filter(Boolean).join(". "),
    });
  }
  if (changes.routing) {
    for (const key of ["floor", "ceiling"] as const) {
      if (changes.routing[key] === undefined) continue;
      rows.push({ field: key, label: key === "floor" ? "Model floor" : "Model ceiling", before: tierWord(agent.routing[key]), after: tierWord(changes.routing[key]) });
    }
  }
  if (changes.budget) {
    for (const [key, label] of [
      ["monthly_micros", "Monthly budget"],
      ["daily_micros", "Daily budget"],
      ["task_micros", "Per session"],
    ] as const) {
      if (changes.budget[key] === undefined) continue;
      rows.push({ field: key, label, before: dollars(agent.budget[key]), after: dollars(changes.budget[key]) });
    }
  }
  return rows;
}
