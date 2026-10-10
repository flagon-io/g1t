/**
 * Effort and "spend less, keep quality": the control that sets how hard an
 * agent works, with what each level has cost it, and the weekly
 * suggestions with Apply and Dismiss. Every figure is the agents service's,
 * measured from the agent's own sessions (lib/effort.ts).
 */
import { Check, Gauge, Lightbulb } from "lucide-react";
import { useState } from "react";
import { useFetcher } from "react-router";

import type { AgentEffort, AgentEffortCosts, AgentRecommendation, AgentRecommendations } from "@g1t/contracts";

import { AgentAvatar } from "./agent-avatar";
import { Hint } from "./ui/hint";
import { TimeAgo } from "./ui";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { cn } from "../lib/cn";
import { EFFORT_OPTIONS, acceptedLabel, costAt, costLine, effortLabel, savingLabel, totalSaving } from "../lib/effort";
import { money } from "../lib/usage";

/**
 * The five settings as one segmented control, radio inputs underneath so
 * it works inside any form. Each has a hint saying what it does; under it,
 * what the chosen one has cost this agent.
 */
export function EffortPicker({
  name = "effort",
  value,
  costs,
  disabled = false,
  onChange,
}: {
  name?: string;
  value: AgentEffort;
  costs: AgentEffortCosts | null | undefined;
  disabled?: boolean;
  onChange?: (effort: AgentEffort) => void;
}) {
  const [chosen, setChosen] = useState<AgentEffort>(value);
  return (
    <div className="min-w-0">
      <Card role="radiogroup" aria-label="Effort" tone="bg" radius="lg" className="grid grid-cols-5 gap-0.5 p-0.5 sm:inline-grid sm:w-auto sm:min-w-[22rem]">
        {EFFORT_OPTIONS.map((option) => {
          const on = chosen === option.key;
          return (
            <Hint key={option.key} label={option.about}>
              <label
                className={cn(
                  "relative flex h-8 cursor-pointer items-center justify-center rounded-md px-2 text-[0.8125rem] transition-colors select-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent",
                  on ? "bg-raised font-medium text-fg ring-1 ring-line-strong" : "text-muted hover:text-fg",
                  disabled && "cursor-not-allowed opacity-60",
                )}
              >
                <input
                  type="radio"
                  name={name}
                  value={option.key}
                  checked={on}
                  disabled={disabled}
                  onChange={() => {
                    setChosen(option.key);
                    onChange?.(option.key);
                  }}
                  className="sr-only"
                />
                {option.label}
              </label>
            </Hint>
          );
        })}
      </Card>
      <p className="mt-2 text-xs text-muted">{EFFORT_OPTIONS.find((o) => o.key === chosen)?.about}</p>
      {costs !== undefined && <p className="mt-0.5 text-xs text-faint tabular-nums">{costLine(costs, chosen)}</p>}
    </div>
  );
}

/** What each level has cost this agent: a typical task, how many sessions, and how often nobody had to step in. */
export function EffortCosts({ costs }: { costs: AgentEffortCosts | null }) {
  if (!costs) return null;
  return (
    <table className="w-full text-left text-xs">
      <caption className="sr-only">What each effort level has cost, from this agent&apos;s sessions</caption>
      <thead className="text-faint">
        <tr>
          <th className="py-1.5 pr-3 font-normal">Level</th>
          <th className="py-1.5 pr-3 font-normal">Typical task</th>
          <th className="py-1.5 pr-3 font-normal">Sessions</th>
          <th className="py-1.5 font-normal">
            <Hint label="Finished with nobody having to step in: not steered, stopped or failed.">
              <span className="cursor-help underline decoration-dotted underline-offset-2" tabIndex={0}>
                Accepted
              </span>
            </Hint>
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-line/60 tabular-nums">
        {costs.levels.map((level) => {
          const at = costAt(costs, level.effort);
          return (
            <tr key={level.effort} className={cn(costs.effort === level.effort && "text-fg")}>
              <td className="py-1.5 pr-3">
                {effortLabel(level.effort)}
                {costs.effort === level.effort && <span className="ml-1.5 text-faint">now</span>}
              </td>
              <td className="py-1.5 pr-3">{at ? money(at.typical_micros!) : <span className="text-faint">Not measured</span>}</td>
              <td className="py-1.5 pr-3 text-muted">{level.sessions}</td>
              <td className="py-1.5 text-muted">{acceptedLabel(at) || "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * One agent's effort, on its Spend tab: the control for owners (saved on
 * its own), read-only for everyone else, and what each level has cost it.
 */
export function EffortCard({ value, costs, owner, action, name }: { value: AgentEffort; costs: AgentEffortCosts | null; owner: boolean; action: string; name: string }) {
  const fetcher = useFetcher<{ ok: boolean; intent?: string; error?: string }>();
  const [picked, setPicked] = useState<AgentEffort>(value);
  const busy = fetcher.state !== "idle";
  const result = fetcher.data?.intent === "effort" ? fetcher.data : null;
  return (
    <section className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
          <Gauge size={16} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Effort</h2>
          <p className="mt-0.5 text-[0.8125rem] leading-relaxed text-muted">
            How hard {name} works: the tier its work starts on, how hard the model reasons, and how many steps a session may take. Its floor and
            ceiling still hold.
          </p>
        </div>
      </div>
      <fetcher.Form method="post" action={action} className="mt-4 space-y-3">
        <input type="hidden" name="intent" value="effort" />
        <EffortPicker value={value} costs={costs} disabled={!owner} onChange={setPicked} />
        {owner && (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={busy || picked === value} variant="accent">
              {busy ? "Saving…" : "Save effort"}
            </Button>
            {result?.ok && picked === value && (
              <span role="status" className="inline-flex items-center gap-1 text-xs text-success">
                <Check size={13} aria-hidden="true" /> Saved as a new version
              </span>
            )}
            {result && !result.ok && <span className="text-xs text-danger">{result.error}</span>}
          </div>
        )}
        {!owner && <p className="text-xs text-faint">Only the workspace&apos;s owners change it.</p>}
      </fetcher.Form>
      <div className="mt-5 border-t border-line pt-4">
        <p className="mb-1 text-xs font-medium text-muted">What each level has cost {name}{costs ? `, last ${costs.window_days} days` : ""}</p>
        {costs ? <EffortCosts costs={costs} /> : <p className="text-xs text-faint">Costs couldn&apos;t be read right now.</p>}
      </div>
    </section>
  );
}

/**
 * Spend less, keep quality: the weekly check's suggestions, each with the
 * evidence it rests on and Apply / Dismiss for owners; agents with too
 * little history to say, said plainly; and what was decided lately.
 */
export function Savings({ recs, owner, action, showAgent = true }: { recs: AgentRecommendations | null; owner: boolean; action: string; showAgent?: boolean }) {
  if (!recs) return <p className="rounded-xl border border-line bg-surface px-4 py-6 text-center text-sm text-muted">Suggestions couldn&apos;t be read right now.</p>;
  const total = totalSaving(recs);
  return (
    <div className="overflow-hidden rounded-xl border border-accent/30 bg-surface">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-line bg-accent/[0.05] px-4 py-3">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Lightbulb size={14} className="text-accent" aria-hidden="true" />
          {recs.open.length ? `${recs.open.length} suggestion${recs.open.length === 1 ? "" : "s"}` : "No suggestions right now"}
          {total > 0 && <span className="font-normal text-success tabular-nums">· about {money(total)} a month</span>}
        </p>
        <p className="text-xs text-faint">
          {recs.checked_at ? (
            <>
              Checked against your own past work <TimeAgo at={recs.checked_at} />, weekly
            </>
          ) : (
            "Checked weekly against your agents' own finished sessions"
          )}
        </p>
      </div>
      {recs.open.length > 0 && (
        <ul className="divide-y divide-line">
          {recs.open.map((rec) => (
            <Suggestion key={rec.id} rec={rec} owner={owner} action={action} showAgent={showAgent} />
          ))}
        </ul>
      )}
      {recs.open.length === 0 && (
        <p className="px-4 py-4 text-sm text-muted">
          {recs.checked_at
            ? "Nothing measured would save money without the work getting worse."
            : "The first check runs once agents have finished sessions. A suggestion appears only when a cheaper level held up on the same agent's past work."}
        </p>
      )}
      {recs.thin.length > 0 && (
        <div className="border-t border-line px-4 py-3">
          <p className="text-xs font-medium text-muted">Not enough history yet</p>
          <ul className="mt-1.5 space-y-1.5">
            {recs.thin.map((rec) => (
              <li key={rec.id} className="flex min-w-0 items-start gap-2 text-xs text-faint">
                {showAgent && <AgentAvatar agent={{ handle: rec.agent_handle, avatar_seed: rec.agent_avatar_seed }} size={16} />}
                <span className="min-w-0">
                  {showAgent && <span className="text-muted">@{rec.agent_handle}: </span>}
                  {rec.reason}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {recs.resolved.length > 0 && (
        <div className="border-t border-line px-4 py-3">
          <p className="text-xs font-medium text-muted">Decided lately</p>
          <ul className="mt-1.5 space-y-1">
            {recs.resolved.slice(0, 5).map((rec) => (
              <li key={rec.id} className="truncate text-xs text-faint">
                {rec.status === "applied" ? "Applied" : "Dismissed"}: {rec.title}
                {rec.resolved_by ? ` · @${rec.resolved_by}` : ""}
                {rec.resolved_at ? (
                  <>
                    {" "}
                    · <TimeAgo at={rec.resolved_at} />
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Suggestion({ rec, owner, action, showAgent }: { rec: AgentRecommendation; owner: boolean; action: string; showAgent: boolean }) {
  const fetcher = useFetcher<{ ok: boolean; intent?: string; error?: string }>();
  const doing = fetcher.formData?.get("do");
  const error = fetcher.data && !fetcher.data.ok && fetcher.data.intent === "recommendation" ? fetcher.data.error : null;
  const saving = savingLabel(rec);
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 px-4 py-3.5 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
      <span className="pt-0.5">
        {showAgent ? <AgentAvatar agent={{ handle: rec.agent_handle, avatar_seed: rec.agent_avatar_seed }} size={26} /> : <Gauge size={18} className="text-accent" aria-hidden="true" />}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium">{rec.title}</p>
        <p className="mt-0.5 text-[0.8125rem] leading-relaxed text-muted">{rec.reason}</p>
        <p className="mt-1 text-xs text-faint">
          {effortLabel(rec.from_effort)} to {effortLabel(rec.to_effort)}
          {saving && <span className="text-success"> · {saving}</span>}
        </p>
        {error && <p className="mt-1 text-xs text-danger">{error}</p>}
      </div>
      {owner ? (
        <fetcher.Form method="post" action={action} className="col-span-2 flex items-center gap-2 sm:col-span-1 sm:self-center">
          <input type="hidden" name="intent" value="recommendation" />
          <input type="hidden" name="id" value={rec.id} />
          <Button type="submit" name="do" value="apply" disabled={fetcher.state !== "idle"} variant="accent" size="sm">
            {doing === "apply" ? "Applying…" : "Apply"}
          </Button>
          <Button type="submit" name="do" value="dismiss" disabled={fetcher.state !== "idle"} variant="outline" size="sm">
            {doing === "dismiss" ? "Dismissing…" : "Dismiss"}
          </Button>
        </fetcher.Form>
      ) : (
        <p className="col-span-2 text-xs text-faint sm:col-span-1 sm:self-center">An owner can apply it</p>
      )}
    </li>
  );
}
