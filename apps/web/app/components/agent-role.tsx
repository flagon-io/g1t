import { GripVertical, Pencil, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";

import type { AgentRouting, ModelTier, SubagentDef } from "@g1t/contracts";

import { Hint } from "./ui/hint";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "./ui/sheet";
import { MAX_RESPONSIBILITIES, TIER_LABELS, clampRouting, cleanSubagentName } from "../lib/agent-form";

const FIELD =
  "w-full rounded-md border border-line bg-bg px-3 py-2 text-sm outline-none transition-colors placeholder:text-faint hover:border-line-strong focus:border-accent-dim";

/** The departments an agent can sit in when it is on no team, as the role gallery groups them. */
export const DEPARTMENTS = ["Engineering", "QA", "Operations", "Docs", "Product", "Customer Support", "Sales"];

/**
 * An agent's role: its title, the team it is on (or a department, when it
 * is on none), and what it is responsible for, as a list to add to, edit
 * and reorder.
 */
export function RoleFields({
  title,
  team,
  department,
  responsibilities,
  teams,
  errors,
  locked,
  personal = false,
}: {
  /** A personal agent: on no team, so no team to choose. */
  personal?: boolean;
  title: string;
  team: string | null;
  department: string;
  responsibilities: string[];
  teams: { slug: string; name: string }[];
  errors: Record<string, string>;
  locked?: boolean;
}) {
  const [items, setItems] = useState<string[]>(responsibilities.length > 0 ? responsibilities : [""]);
  const [onTeam, setOnTeam] = useState(team ?? "none");
  const [dragging, setDragging] = useState<number | null>(null);
  const move = (from: number, to: number) =>
    setItems((now) => {
      const next = [...now];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item!);
      return next;
    });
  return (
    <>
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="title" className="mb-1.5 flex items-baseline justify-between text-sm font-medium text-fg-soft">
            Title
            {errors.title && <span className="text-xs font-normal text-danger">{errors.title}</span>}
          </label>
          <input
            id="title"
            name="title"
            defaultValue={title}
            readOnly={locked}
            placeholder="QA Engineer"
            className={`${FIELD} ${locked ? "cursor-not-allowed text-muted" : ""}`}
            autoComplete="off"
            data-1p-ignore
          />
        </div>
        {personal ? (
          <div>
            <p className="mb-1.5 text-sm font-medium text-fg-soft">Team</p>
            <p className="flex min-h-9 items-center text-[0.8125rem] text-muted">Personal agents join teams once an owner promotes them.</p>
          </div>
        ) : (
        <div>
          <label htmlFor="team" className="mb-1.5 block text-sm font-medium text-fg-soft">
            Team
          </label>
          <Select name="team" value={onTeam} onValueChange={setOnTeam} disabled={locked}>
            <SelectTrigger id="team">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none" description="Placed by a department label instead">
                No team
              </SelectItem>
              {teams.map((t) => (
                <SelectItem key={t.slug} value={t.slug}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        )}
      </div>
      {onTeam === "none" && (
        <div>
          <label htmlFor="department" className="mb-1.5 flex items-baseline justify-between text-sm font-medium text-fg-soft">
            Department
            <span className="text-xs font-normal text-faint">Where it shows in the Agents sidebar</span>
          </label>
          <input
            id="department"
            name="department"
            list="departments"
            defaultValue={department}
            readOnly={locked}
            placeholder="QA"
            className={`${FIELD} ${locked ? "cursor-not-allowed text-muted" : ""}`}
            autoComplete="off"
            data-1p-ignore
          />
          <datalist id="departments">
            {DEPARTMENTS.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
        </div>
      )}
      <div>
        <p className="mb-1.5 flex items-baseline justify-between text-sm font-medium text-fg-soft">
          Responsibilities
          <span className="text-xs font-normal text-faint">Broad duties, not tasks. Up to {MAX_RESPONSIBILITIES}.</span>
        </p>
        <ul className="space-y-1.5">
          {items.map((item, index) => (
            <li
              key={index}
              draggable={!locked && items.length > 1}
              onDragStart={() => setDragging(index)}
              onDragOver={(event) => dragging != null && event.preventDefault()}
              onDrop={() => {
                if (dragging != null && dragging !== index) move(dragging, index);
                setDragging(null);
              }}
              onDragEnd={() => setDragging(null)}
              className={`group flex items-center gap-1.5 ${dragging === index ? "opacity-50" : ""}`}
            >
              <span className="cursor-grab text-faint opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true">
                <GripVertical size={14} />
              </span>
              <input
                name="responsibility"
                value={item}
                onChange={(event) => setItems((now) => now.map((v, i) => (i === index ? event.target.value : v)))}
                readOnly={locked}
                aria-label={`Responsibility ${index + 1}`}
                placeholder={index === 0 ? "Keep the test suite green and fast" : "Another duty"}
                className={FIELD}
                autoComplete="off"
                data-1p-ignore
              />
              {!locked && (
                <Hint label="Remove">
                  <button
                    type="button"
                    aria-label={`Remove responsibility ${index + 1}`}
                    onClick={() => setItems((now) => (now.length > 1 ? now.filter((_, i) => i !== index) : [""]))}
                    className="flex size-8 shrink-0 items-center justify-center rounded-md text-faint hover:bg-raised hover:text-fg"
                  >
                    <X size={14} />
                  </button>
                </Hint>
              )}
            </li>
          ))}
        </ul>
        {!locked && items.length < MAX_RESPONSIBILITIES && (
          <button
            type="button"
            onClick={() => setItems((now) => [...now, ""])}
            className="mt-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[0.8125rem] text-muted hover:bg-raised hover:text-fg"
          >
            <Plus size={14} />
            Add a responsibility
          </button>
        )}
      </div>
    </>
  );
}

const BLANK_SUBAGENT: SubagentDef = { name: "", description: "", instructions: "", routing: { floor: null, ceiling: null }, max_parallel: 2 };

/**
 * Subagents: help an agent keeps for its own work, as a list, edited in a
 * drawer. Their routing stays within the agent's own. Posted as JSON.
 */
export function SubagentsField({ initial, routing }: { initial: SubagentDef[]; routing: Pick<AgentRouting, "floor" | "ceiling"> }) {
  const [list, setList] = useState<SubagentDef[]>(initial);
  const [editing, setEditing] = useState<{ index: number | null; draft: SubagentDef } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    if (!editing) return;
    const name = cleanSubagentName(editing.draft.name);
    if (!name) return setError("Give it a name, like flake-hunter.");
    if (list.some((s, i) => s.name === name && i !== editing.index)) return setError(`There's already a ${name}.`);
    const next: SubagentDef = { ...editing.draft, name, routing: clampRouting(editing.draft.routing, routing) };
    setList((now) => (editing.index == null ? [...now, next] : now.map((s, i) => (i === editing.index ? next : s))));
    setEditing(null);
  };
  const tier = (value: string): ModelTier | null => (value === "none" ? null : (value as ModelTier));
  return (
    <div>
      <input type="hidden" name="subagents" value={JSON.stringify(list)} />
      <p className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5 text-xs text-muted">Used inside tasks: coming soon</p>
      {list.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-4 py-5 text-sm text-muted">None yet. A subagent is help it calls on for one kind of work, such as finding flaky tests.</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {list.map((sub, index) => (
            <li key={sub.name} className="flex items-center gap-3 px-3.5 py-2.5">
              <span className="min-w-0 grow">
                <span className="block font-mono text-sm text-fg">{sub.name}</span>
                <span className="block truncate text-xs text-muted">{sub.description || "No description"}</span>
              </span>
              <span className="hidden text-xs text-faint sm:inline">
                {sub.routing.floor ?? "any"} to {sub.routing.ceiling ?? "any"} · {sub.max_parallel} at once
              </span>
              <Hint label="Edit">
                <button
                  type="button"
                  aria-label={`Edit ${sub.name}`}
                  onClick={() => {
                    setError(null);
                    setEditing({ index, draft: sub });
                  }}
                  className="flex size-8 items-center justify-center rounded-md text-faint hover:bg-raised hover:text-fg"
                >
                  <Pencil size={14} />
                </button>
              </Hint>
              <Hint label="Remove">
                <button
                  type="button"
                  aria-label={`Remove ${sub.name}`}
                  onClick={() => setList((now) => now.filter((_, i) => i !== index))}
                  className="flex size-8 items-center justify-center rounded-md text-faint hover:bg-raised hover:text-danger"
                >
                  <Trash2 size={14} />
                </button>
              </Hint>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={() => {
          setError(null);
          setEditing({ index: null, draft: { ...BLANK_SUBAGENT, routing: clampRouting(BLANK_SUBAGENT.routing, routing) } });
        }}
        className="mt-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[0.8125rem] text-muted hover:bg-raised hover:text-fg"
      >
        <Plus size={14} />
        Add a subagent
      </button>
      <Sheet open={editing != null} onOpenChange={(open) => !open && setEditing(null)}>
        <SheetContent side="right" className="w-[28rem] max-w-[100vw]">
          {editing && (
            <div className="flex h-full flex-col">
              <div className="border-b border-line px-5 py-4">
                <SheetTitle>{editing.index == null ? "New subagent" : editing.draft.name}</SheetTitle>
                <SheetDescription className="mt-1 text-sm text-muted">Its routing stays within its agent&apos;s own limits.</SheetDescription>
              </div>
              <div className="min-h-0 grow space-y-5 overflow-y-auto px-5 py-5">
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium text-fg-soft">Name</span>
                  <input
                    value={editing.draft.name}
                    onChange={(event) => setEditing({ ...editing, draft: { ...editing.draft, name: event.target.value } })}
                    placeholder="flake-hunter"
                    className={`${FIELD} font-mono`}
                    autoComplete="off"
                    data-1p-ignore
                  />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium text-fg-soft">Description</span>
                  <input
                    value={editing.draft.description}
                    onChange={(event) => setEditing({ ...editing, draft: { ...editing.draft, description: event.target.value } })}
                    placeholder="Finds which tests flake, and why"
                    className={FIELD}
                    autoComplete="off"
                    data-1p-ignore
                  />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium text-fg-soft">Instructions</span>
                  <textarea
                    value={editing.draft.instructions}
                    onChange={(event) => setEditing({ ...editing, draft: { ...editing.draft, instructions: event.target.value } })}
                    rows={6}
                    placeholder="Rerun the failing test 20 times; report the failure rate and the first stack trace."
                    className={`${FIELD} resize-y font-mono text-[0.8125rem]`}
                  />
                </label>
                <div className="grid grid-cols-2 gap-4">
                  {(["floor", "ceiling"] as const).map((key) => (
                    <div key={key}>
                      <span className="mb-1.5 block text-sm font-medium text-fg-soft capitalize">{key}</span>
                      <Select
                        value={editing.draft.routing[key] ?? "none"}
                        onValueChange={(value) =>
                          setEditing({ ...editing, draft: { ...editing.draft, routing: clampRouting({ ...editing.draft.routing, [key]: tier(value) }, routing) } })
                        }
                      >
                        <SelectTrigger aria-label={key}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">{key === "floor" ? "No floor" : "No ceiling"}</SelectItem>
                          {(["small", "large", "frontier"] as const).map((t) => (
                            <SelectItem key={t} value={t}>
                              {TIER_LABELS[t].split(":")[0]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
                <label className="block max-w-40">
                  <span className="mb-1.5 block text-sm font-medium text-fg-soft">At once, in one task</span>
                  <input
                    type="number"
                    min={1}
                    max={8}
                    value={editing.draft.max_parallel}
                    onChange={(event) =>
                      setEditing({ ...editing, draft: { ...editing.draft, max_parallel: Math.max(1, Math.min(8, Number(event.target.value) || 1)) } })
                    }
                    className={`${FIELD} tabular-nums`}
                  />
                </label>
              </div>
              <div className="flex items-center gap-3 border-t border-line px-5 py-3">
                {error && <p className="text-sm text-danger">{error}</p>}
                <button
                  type="button"
                  onClick={() => setEditing(null)}
                  className="ml-auto h-9 rounded-md border border-line px-3.5 text-sm font-medium text-fg/90 hover:border-line-strong hover:bg-surface"
                >
                  Cancel
                </button>
                <button type="button" onClick={save} className="h-9 rounded-md bg-accent px-3.5 text-sm font-medium text-bg hover:bg-accent-hover">
                  {editing.index == null ? "Add" : "Done"}
                </button>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
