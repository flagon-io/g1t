import { Check, ShieldAlert, TriangleAlert } from "lucide-react";
import { useState } from "react";

import {
  DANGEROUS_SCOPES,
  PRESETS,
  SCOPE_GROUPS,
  describeScope,
  isDangerous,
  levelsOf,
  presetScopes,
  scopeLevel,
  scopeResource,
  type PresetId,
  type Scope,
} from "@g1t/contracts";

import { cn } from "../lib/cn";
import {
  accessSummary,
  everyScope,
  impliedBy,
  matchingPreset,
  normalizeScopes,
} from "../lib/token-scopes";
import { Badge } from "./ui/badge";
import { Hint } from "./ui/hint";

// Choosing what an application signed in with OAuth may do: a checklist
// of scopes. (Access tokens are made with permissions, the same scopes read
// per resource: components/token-form.tsx.) Every box is a plain form field (`scope`), so the form posts the
// same with or without JavaScript; the script applies presets and ticks the
// lower levels a higher one includes. `lib/token-scopes.ts` reads it back.

/** One box. Greyed out and ticked when a higher level of its resource is ticked. */
function ScopeBox({
  scope,
  ticked,
  onToggle,
}: {
  scope: Scope;
  ticked: readonly Scope[];
  onToggle: (scope: Scope, on: boolean) => void;
}) {
  const by = impliedBy(ticked, scope);
  const checked = by !== null || ticked.includes(scope);
  return (
    <Hint label={by ? `Included in ${by}` : undefined}>
      <label className={cn("flex min-w-0 items-start gap-2.5 py-1", by ? "cursor-default" : "cursor-pointer")}>
        {/* The real checkbox, drawn as the ui Checkbox is, so it still posts without script. */}
        <span className="relative mt-0.5 flex size-4 shrink-0">
          <input
            type="checkbox"
            name="scope"
            value={scope}
            checked={checked}
            disabled={by !== null}
            onChange={(event) => onToggle(scope, event.target.checked)}
            className={cn(
              "peer size-4 cursor-[inherit] appearance-none rounded-[5px] border border-line-strong bg-bg transition-colors hover:border-faint disabled:opacity-50",
              "focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-1 focus-visible:ring-offset-bg focus-visible:outline-none",
              isDangerous(scope) ? "checked:border-danger checked:bg-danger" : "checked:border-accent checked:bg-accent",
            )}
          />
          <Check size={12} strokeWidth={3} aria-hidden className="pointer-events-none absolute inset-0 m-auto hidden text-bg peer-checked:block peer-disabled:opacity-50" />
        </span>
        <span className="min-w-0">
          <span className={cn("block font-mono text-[0.8125rem]", isDangerous(scope) ? "text-danger" : "text-fg", by && "opacity-60")}>
            {scope}
          </span>
          <span className="block text-xs leading-snug text-faint">{describeScope(scope)}</span>
          {by && <span className="sr-only">Included in {by}</span>}
        </span>
      </label>
    </Hint>
  );
}

/**
 * The scope checklist: presets as quick buttons, then a box per scope,
 * grouped by area, with admin scopes under "Dangerous". Posts `scope` for
 * each ticked box and `preset` = `full` for full access.
 *
 * With `only`, it is the consent page: just the scopes an application
 * asked for, all ticked, to untick; nothing can be added.
 */
export function ScopeChecklist({
  initial,
  allowFull = true,
  only,
}: {
  /** Null: full access. */
  initial: readonly string[] | null;
  allowFull?: boolean;
  only?: readonly Scope[];
}) {
  const [full, setFull] = useState(allowFull && !only && initial === null);
  const [ticked, setTicked] = useState<Scope[]>(() => (initial === null ? everyScope() : normalizeScopes(initial)));
  const shown = (scope: Scope) => !only || only.includes(scope);
  const groups = SCOPE_GROUPS.map((group) => ({ ...group, scopes: group.scopes.filter(shown) })).filter(
    (group) => group.scopes.length > 0,
  );
  const dangerous = DANGEROUS_SCOPES.filter(shown);
  const preset: PresetId | null = full ? "full" : matchingPreset(ticked);
  const count = full ? null : normalizeScopes(ticked).length;

  const choosePreset = (id: PresetId) => {
    const scopes = presetScopes(id);
    setFull(scopes === null);
    setTicked(scopes === null ? everyScope() : normalizeScopes(scopes));
  };
  // Ticking a level includes the lower ones; unticking one leaves the
  // level below it ticked, so only the box you touched changes.
  const toggle = (scope: Scope, on: boolean) => {
    setFull(false);
    setTicked((current) => {
      const resource = scopeResource(scope);
      if (on) return normalizeScopes([...current, scope]);
      const levels = levelsOf(resource);
      const below = levels[levels.indexOf(scopeLevel(scope)) - 1];
      const rest = current.filter((held) => held !== scope);
      return normalizeScopes(below && shown(`${resource}:${below}` as Scope) ? [...rest, `${resource}:${below}`] : rest);
    });
  };

  return (
    <fieldset className="min-w-0 space-y-3">
      <legend className="sr-only">Scopes</legend>
      {full && <input type="hidden" name="preset" value="full" />}

      {!only && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-sm font-medium text-muted">Scopes</span>
          {PRESETS.filter((option) => allowFull || option.id !== "full").map((option) => (
            <Hint key={option.id} label={option.description}>
              <button
                type="button"
                aria-pressed={preset === option.id}
                onClick={() => choosePreset(option.id)}
                className={cn(
                  "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                  preset === option.id
                    ? option.id === "full"
                      ? "border-danger/50 bg-danger/10 text-danger"
                      : "border-accent/50 bg-accent/10 text-accent"
                    : "border-line text-muted hover:border-line-strong hover:text-fg",
                )}
              >
                {option.label}
              </button>
            </Hint>
          ))}
          <span className="ml-auto text-xs text-faint">
            {count === null ? "Everything you can do" : count === 1 ? "1 scope" : `${count} scopes`}
          </span>
        </div>
      )}

      {full && (
        <p className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-xs text-danger">
          <TriangleAlert size={14} className="mt-px shrink-0" />
          Full access can do everything you can, including scopes added later. Untick anything to
          narrow it.
        </p>
      )}

      <div className="divide-y divide-line rounded-md border border-line">
        {groups.map((group) => (
          <div key={group.id} role="group" aria-labelledby={`scopes-${group.id}`} className="px-3 py-2.5 sm:px-4">
            <p id={`scopes-${group.id}`} className="mb-1 text-xs font-medium text-muted">
              {group.label}
            </p>
            <div className="grid gap-x-6 sm:grid-cols-2">
              {group.scopes.map((scope) => (
                <ScopeBox key={scope} scope={scope} ticked={ticked} onToggle={toggle} />
              ))}
            </div>
          </div>
        ))}
      </div>

      {dangerous.length > 0 && (
        <div role="group" aria-labelledby="scopes-dangerous" className="rounded-md border border-danger/30 px-3 py-2.5 sm:px-4">
          <p id="scopes-dangerous" className="flex items-center gap-1.5 text-xs font-medium text-danger">
            <ShieldAlert size={14} className="shrink-0" />
            Dangerous
          </p>
          <p className="mt-0.5 mb-1 text-xs text-faint">
            Hard to undo, or decides who can reach what. Tick these only for something you trust as
            much as yourself.
          </p>
          <div className="grid gap-x-6 sm:grid-cols-2">
            {dangerous.map((scope) => (
              <ScopeBox key={scope} scope={scope} ticked={ticked} onToggle={toggle} />
            ))}
          </div>
        </div>
      )}
    </fieldset>
  );
}

/** An application's access in a list: what it may do. */
export function AccessSummary({
  holder,
  className,
}: {
  holder: { scopes: readonly string[] | null; legacy: boolean };
  className?: string;
}) {
  const summary = accessSummary(holder);
  const preset = matchingPreset(holder.scopes);
  const scopes = holder.scopes && !preset ? normalizeScopes(holder.scopes) : [];
  const tone = holder.scopes === null ? (holder.legacy ? "warn" : "danger") : scopes.length === 0 && !preset ? "neutral" : "accent";
  return (
    <div className={cn("mt-1.5 flex flex-wrap items-center gap-1.5", className)}>
      <Badge tone={tone}>{summary}</Badge>
      {scopes.map((scope) => (
        <Hint key={scope} label={describeScope(scope)}>
          <span
            className={cn(
              "rounded border px-1.5 py-px font-mono text-[0.6875rem]",
              isDangerous(scope) ? "border-danger/40 text-danger" : "border-line text-muted",
            )}
          >
            {scope}
          </span>
        </Hint>
      ))}
    </div>
  );
}
