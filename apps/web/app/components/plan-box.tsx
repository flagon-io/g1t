import { Link, useFetcher } from "react-router";
import { useEffect, useId, useState } from "react";

import { Check, Sparkles } from "lucide-react";

import { APPETITES, HORIZONS, type Horizon, type Progress, type WorkItem, appetiteLetter, hillLabel, horizonLabel } from "@g1t/contracts";

import { AppetiteChip, HillMark, QuietBadge, StandingText } from "./plan";
import { ErrorText } from "./ui";
import { Input, InputAddon, InputGroup } from "./ui/input";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { SelectField } from "./ui/select";
import { Switch } from "./ui/switch";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { Card } from "./ui/card";
import { Hint } from "./ui/hint";
import { cn } from "../lib/cn";
import { itemPath } from "../lib/work-items";
import { APPETITE_HINTS, APPETITE_SUMMARY, HORIZON_HINTS, acceptForm, budgetText, canAccept, planPath, suggestionText } from "../lib/plan";

/**
 * The item page's Plan, in its sidebar beside Milestone: where it stands
 * in the plan (a horizon), its appetite, a budget in dollars for an agent
 * working on it, and urgent, which puts it first in Now. Each change posts
 * `action=plan` to the page. Read-only for who cannot plan (`canEdit`, the
 * Triage role); Now and urgent also take the right to manage milestones
 * (`canNow`), which the work service checks again. In Triage, where g1t
 * suggests it goes, with Accept; in Now, how it stands (`progress`): its
 * hill and where it stands, as the plan reads them.
 */
export function PlanBox({
  item,
  workspace,
  canEdit,
  canNow,
  progress,
}: {
  item: Pick<WorkItem, "horizon" | "appetite" | "budgetUsd" | "urgent" | "state" | "suggestion">;
  workspace: string;
  canEdit: boolean;
  canNow: boolean;
  /** How it stands, while it is in Now; null when it could not be read. */
  progress?: Progress | null;
}) {
  const fetcher = useFetcher<{ error?: string } | null>();
  const budgetId = useId();
  const editable = canEdit && item.state === "open";
  // While saving, what was asked for.
  const posted = fetcher.state !== "idle" ? fetcher.formData : null;
  const horizon = (posted?.get("urgent") === "1" ? "now" : (posted?.get("horizon") as Horizon | null)) ?? item.horizon;
  const appetite = posted?.has("appetite") ? (posted.get("appetite") === "none" ? null : (posted.get("appetite") as WorkItem["appetite"])) : item.appetite;
  const urgent = posted?.has("urgent") ? posted.get("urgent") === "1" : item.urgent;
  const [budget, setBudget] = useState(item.budgetUsd == null ? "" : String(item.budgetUsd));
  useEffect(() => setBudget(item.budgetUsd == null ? "" : String(item.budgetUsd)), [item.budgetUsd]);
  const post = (fields: Record<string, string>) => fetcher.submit({ action: "plan", ...fields }, { method: "post" });
  const lockedInNow = horizon === "now" && !canNow;
  const suggestion = item.horizon === "triage" && horizon === "triage" && item.state === "open" ? (item.suggestion ?? null) : null;
  const standing = item.horizon === "now" && horizon === "now" && item.state === "open" ? (progress ?? null) : null;
  return (
    <section>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Plan</h3>
        <Link to={planPath(workspace)} className="text-xs text-faint hover:text-fg">
          Open the plan
        </Link>
      </div>
      {suggestion && (
        <Card tone="plain" radius="lg" className="mt-2 space-y-1.5 border-accent/20 bg-accent/5 px-3 py-2 text-xs">
          <p className="flex items-center gap-1.5">
            <Sparkles size={12} className="shrink-0 text-accent" aria-hidden />
            <span className="font-medium text-fg">Suggested: {suggestionText(suggestion)}</span>
          </p>
          {suggestion.duplicateOf != null && (
            <p className="text-muted">
              Looks like{" "}
              <Link to={itemPath(workspace, suggestion.duplicateOf)} className="font-mono text-fg underline-offset-4 hover:underline">
                #{suggestion.duplicateOf}
              </Link>
            </p>
          )}
          <p className="text-muted">{suggestion.why}</p>
          {editable && canAccept(suggestion, canNow) && (
            <Button size="xs" variant="accent" disabled={fetcher.state !== "idle"} onClick={() => post(acceptForm(suggestion))}>
              <Check size={13} />
              Accept
            </Button>
          )}
        </Card>
      )}
      {standing && (
        <div className="mt-2 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <HillMark hill={standing.hill} />
            <span className="text-xs text-muted">{hillLabel(standing.hill)}</span>
            <QuietBadge progress={standing} />
          </div>
          <StandingText standing={standing} />
        </div>
      )}
      {editable ? (
        <div className={cn("space-y-3", suggestion || standing ? "mt-3" : "mt-2")}>
          <SelectField
            aria-label="Horizon"
            size="sm"
            value={horizon}
            disabled={lockedInNow}
            onValueChange={(value) => value !== horizon && post({ horizon: value })}
            options={HORIZONS.map((one) => ({
              value: one,
              label: horizonLabel(one),
              description: HORIZON_HINTS[one],
              disabled: one === "now" && !canNow,
            }))}
          />
          <div className="flex items-center justify-between gap-2">
            <Hint label={APPETITE_SUMMARY}>
              <span className="text-xs text-muted underline decoration-line-strong decoration-dotted underline-offset-4">Appetite</span>
            </Hint>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              aria-label="Appetite"
              value={appetite ?? ""}
              onValueChange={(value) => post({ appetite: value || "none" })}
            >
              {APPETITES.map((one) => (
                <ToggleGroupItem key={one} value={one} aria-label={APPETITE_HINTS[one]} className="font-mono">
                  {appetiteLetter(one)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <fetcher.Form method="post" className="flex items-center gap-2">
            <input type="hidden" name="action" value="plan" />
            <label htmlFor={budgetId} className="grow text-xs text-muted">
              Budget
            </label>
            <InputGroup className="h-8 w-24">
              <InputAddon className="pr-0 text-xs">$</InputAddon>
              <Input id={budgetId} name="budget" inputMode="decimal" value={budget} onChange={(event) => setBudget(event.target.value)} className="pl-1.5" />
            </InputGroup>
            <Button type="submit" size="sm" variant="outline" disabled={budget === (item.budgetUsd == null ? "" : String(item.budgetUsd))}>
              Save
            </Button>
          </fetcher.Form>
          <label className="flex items-center justify-between gap-2">
            <span className="min-w-0">
              <span className="block text-xs text-muted">Urgent</span>
              <span className="block text-[0.6875rem] text-faint">First in Now, until it closes</span>
            </span>
            <Switch size="sm" checked={urgent} disabled={!canNow} onCheckedChange={(on) => post({ urgent: on ? "1" : "0" })} aria-label="Urgent" />
          </label>
          {lockedInNow && <p className="text-xs text-faint">Moving it out of Now takes the right to manage milestones.</p>}
        </div>
      ) : (
        <div className={cn("flex flex-wrap items-center gap-1.5 text-sm", suggestion || standing ? "mt-3" : "mt-2")}>
          {item.urgent && <Badge tone="danger">Urgent</Badge>}
          <span>{horizonLabel(item.horizon)}</span>
          {item.appetite && <AppetiteChip appetite={item.appetite} />}
          {item.budgetUsd != null && <span className="text-xs text-muted">{budgetText(item.budgetUsd)} budget</span>}
        </div>
      )}
      {fetcher.state === "idle" && fetcher.data?.error && (
        <div className="mt-2">
          <ErrorText>{fetcher.data.error}</ErrorText>
        </div>
      )}
    </section>
  );
}
