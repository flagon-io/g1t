import { Inbox, Plus, X } from "lucide-react";
import { Link, useFetcher } from "react-router";

import { APPETITES, LIST_PAGE, type WorkItem, appetiteLetter } from "@g1t/contracts";

import type { Route } from "./+types/triage";
import { ButtonLink, EmptyState, ErrorText, TimeAgo } from "../../../components/ui";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { Hint } from "../../../components/ui/hint";
import { ToggleGroup, ToggleGroupItem } from "../../../components/ui/toggle-group";
import { RepoChips } from "../../../components/work-items";
import { page } from "../../../lib/meta";
import { isFailed, part } from "../../../lib/partial";
import { APPETITE_HINTS, APPETITE_SUMMARY, moreText, planInput, planPath } from "../../../lib/plan";
import { workPages } from "../../../lib/repo-live";
import { work } from "../../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../../lib/session.server";
import { useWorkspaceLive } from "../../../lib/use-repo-live";
import { canItem } from "../../../lib/work-access";
import { itemPath, newItemPath } from "../../../lib/work-items";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Triage · Work · ${params.owner} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const workspace = params.owner.toLowerCase();
  const member = roleIn(viewer, workspace) != null;
  // The newest first, at most a page; the plan says how many there are in all.
  const [items, plan] = await Promise.all([
    work.listWorkItems(workspace, viewer, { horizon: "triage", limit: LIST_PAGE }),
    part(work.getPlan(workspace, viewer), "The plan"),
  ]);
  const shown = unwrap(items);
  const total = isFailed(plan) || !plan.ok ? shown.length : Math.max(plan.value.triageTotal, shown.length);
  return {
    workspace,
    member,
    items: shown,
    triageTotal: total,
    canPlan: canItem(viewer, workspace, null, "triage"),
    canNow: canItem(viewer, workspace, null, "manage_labels"),
    canOpen: viewer != null && member,
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const workspace = params.owner.toLowerCase();
  const form = await request.formData();
  const number = Number(form.get("number"));
  if (!Number.isInteger(number) || number < 1) return { error: "Choose a work item.", number: null };
  // Closing as not planned, as the item's own page does.
  if (form.get("action") === "close-not-planned") {
    const result = await work.closeWorkItem(user, workspace, number, "not_planned");
    return result.ok ? { error: null, number } : { error: result.error.message, number };
  }
  const input = planInput(form);
  if (typeof input === "string") return { error: input, number };
  const result = await work.planWorkItem(user, workspace, number, input);
  return result.ok ? { error: null, number } : { error: result.error.message, number };
}

/**
 * Work's Triage: the work items nobody has placed in the plan yet, newest
 * first, each with the moves that place it.
 */
export default function Triage({ loaderData }: Route.ComponentProps) {
  const { workspace, items, triageTotal, canPlan, canNow, member } = loaderData;
  useWorkspaceLive({ workspace, member, match: workPages.list() });
  const more = moreText(items.length, triageTotal);
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <Inbox size={17} className="text-accent" />
            Triage
          </h1>
          <p className="mt-1 text-sm text-muted">
            New work items land here until someone places them: in Now, in Next to be taken in turn, or in Later. Give each an appetite while you are at it.
          </p>
        </div>
        {loaderData.canOpen && (
          <ButtonLink to={newItemPath(workspace)} className="max-sm:h-10">
            <Plus size={15} />
            New work item
          </ButtonLink>
        )}
      </div>
      <div className="mt-5">
        {items.length === 0 ? (
          <EmptyState title="Nothing to triage">
            Every open work item has a place in the{" "}
            <Link to={planPath(workspace)} className="text-fg underline underline-offset-4">
              plan
            </Link>
            . New ones land here.
          </EmptyState>
        ) : (
          <Card asChild divided className="overflow-hidden">
            <ul>
              {items.map((item) => (
                <TriageRow key={item.id} item={item} workspace={workspace} canPlan={canPlan} canNow={canNow} />
              ))}
            </ul>
          </Card>
        )}
        {more && <p className="mt-3 text-sm text-muted">{more}, older than these. Place some, and the next ones show here.</p>}
      </div>
    </div>
  );
}

/** One work item waiting to be placed, with its quick moves. Once placed, it leaves the list. */
function TriageRow({ item, workspace, canPlan, canNow }: { item: WorkItem; workspace: string; canPlan: boolean; canNow: boolean }) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const posted = fetcher.formData;
  // Placed or closed: gone from Triage before the answer, back if it was refused.
  const leaving = busy && posted != null && (posted.has("horizon") || posted.get("action") === "close-not-planned");
  const appetite = busy && posted?.has("appetite") ? (String(posted.get("appetite")) as WorkItem["appetite"] | "none") : item.appetite;
  const post = (fields: Record<string, string>) => fetcher.submit({ number: String(item.number), ...fields }, { method: "post" });
  if (leaving) return null;
  return (
    <li className="flex flex-col gap-2.5 px-4 py-3">
      <div className="min-w-0">
        <Link to={itemPath(workspace, item.number)} prefetch="intent" className="flex min-w-0 items-baseline gap-1.5 font-medium hover:text-accent">
          <span className="shrink-0 font-mono text-xs font-normal text-faint">#{item.number}</span>
          <span className="min-w-0 wrap-break-word">{item.title}</span>
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-faint">
          <span className="whitespace-nowrap">
            opened <TimeAgo at={item.createdAt} /> by {item.author.username}
          </span>
          <RepoChips repos={item.repos} workspace={workspace} />
        </div>
      </div>
      {canPlan && (
        <div className="flex flex-wrap items-center gap-2">
          {canNow && (
            <Button size="sm" variant="soft" disabled={busy} onClick={() => post({ horizon: "now" })}>
              Now
            </Button>
          )}
          <Hint label="To the bottom of Next">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => post({ horizon: "next" })}>
              Next
            </Button>
          </Hint>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => post({ horizon: "later" })}>
            Later
          </Button>
          <Hint label={APPETITE_SUMMARY}>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              aria-label="Appetite"
              value={appetite && appetite !== "none" ? appetite : ""}
              onValueChange={(value) => post({ appetite: value || "none" })}
              disabled={busy}
            >
              {APPETITES.map((one) => (
                <ToggleGroupItem key={one} value={one} aria-label={APPETITE_HINTS[one]} className="font-mono">
                  {appetiteLetter(one)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Hint>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => post({ action: "close-not-planned" })} className="sm:ml-auto">
            <X size={14} />
            Close as not planned
          </Button>
        </div>
      )}
      {fetcher.state === "idle" && fetcher.data?.error && <ErrorText>{fetcher.data.error}</ErrorText>}
    </li>
  );
}
