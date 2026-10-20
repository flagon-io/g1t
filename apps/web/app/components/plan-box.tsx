import { Link, useFetcher } from "react-router";
import { useEffect, useId, useState } from "react";

import { APPETITES, HORIZONS, type Horizon, type WorkItem, appetiteLetter, horizonLabel } from "@g1t/contracts";

import { AppetiteChip } from "./plan";
import { ErrorText } from "./ui";
import { Input, InputAddon, InputGroup } from "./ui/input";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { SelectField } from "./ui/select";
import { Switch } from "./ui/switch";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { Hint } from "./ui/hint";
import { APPETITE_HINTS, APPETITE_SUMMARY, HORIZON_HINTS, budgetText, planPath } from "../lib/plan";

/**
 * The item page's Plan, in its sidebar beside Milestone: where it stands
 * in the plan (a horizon), its appetite, a budget in dollars for an agent
 * working on it, and urgent, which puts it first in Now. Each change posts
 * `action=plan` to the page. Read-only for who cannot plan (`canEdit`, the
 * Triage role); Now and urgent also take the right to manage milestones
 * (`canNow`), which the work service checks again.
 */
export function PlanBox({
  item,
  workspace,
  canEdit,
  canNow,
}: {
  item: Pick<WorkItem, "horizon" | "appetite" | "budgetUsd" | "urgent" | "state">;
  workspace: string;
  canEdit: boolean;
  canNow: boolean;
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
  return (
    <section>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Plan</h3>
        <Link to={planPath(workspace)} className="text-xs text-faint hover:text-fg">
          Open the plan
        </Link>
      </div>
      {editable ? (
        <div className="mt-2 space-y-3">
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
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-sm">
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
