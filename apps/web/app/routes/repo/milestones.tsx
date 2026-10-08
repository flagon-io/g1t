import { Milestone as MilestoneIcon, Plus } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/milestones";
import { MilestoneBar } from "../../components/labels";
import {
  DeleteMilestone,
  DueLine,
  MilestoneForm,
  MilestoneStateButton,
  ProgressLine,
} from "../../components/milestones";
import { Button, EmptyState, ErrorText } from "../../components/ui";
import { plainText } from "../../components/work";
import { requireRepo } from "../../lib/access.server";
import { page } from "../../lib/meta";
import { milestoneAction } from "../../lib/milestones.server";
import { work } from "../../lib/services.server";
import { unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Milestones · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const { viewer, access } = await requireRepo(context, params, "read");
  const state = new URL(request.url).searchParams.get("state") === "closed" ? "closed" : "open";
  // Both, for the tabs' counts; the list shows one.
  const milestones = unwrap(await work.listMilestones({ namespace: params.owner, name: params.repo }, viewer));
  return { milestones, state, canEdit: access.can.manage_labels, today: new Date().toISOString() } as const;
}

export async function action({ request, params, context }: Route.ActionArgs) {
  return milestoneAction(request, params, context);
}

export default function Milestones({ loaderData, actionData, params }: Route.ComponentProps) {
  const { milestones, state, canEdit } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const today = new Date(loaderData.today);
  const [creating, setCreating] = useState(false);
  const open = milestones.filter((milestone) => milestone.state === "open");
  const closed = milestones.filter((milestone) => milestone.state === "closed");
  const shown = state === "open" ? open : closed;
  const tab = (value: "open" | "closed", label: string, count: number) => (
    <Link
      to={value === "open" ? `${base}/milestones` : `${base}/milestones?state=closed`}
      className={
        "rounded-md px-3 py-1.5 text-sm transition-colors " +
        (state === value ? "bg-raised font-medium text-fg" : "text-muted hover:text-fg")
      }
    >
      {label} <span className="tabular-nums text-faint">{count}</span>
    </Link>
  );
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Milestones</h2>
        <p className="mt-1 text-sm text-muted">
          A milestone gathers issues and pull requests under one goal and a due date, and shows how much of it is done.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-lg border border-line p-1">
          {tab("open", "Open", open.length)}
          {tab("closed", "Closed", closed.length)}
        </div>
        {canEdit && !creating && (
          <Button type="button" onClick={() => setCreating(true)}>
            <Plus size={15} />
            New milestone
          </Button>
        )}
      </div>
      {creating && <MilestoneForm onDone={() => setCreating(false)} />}
      {actionData && actionData.intent !== "create" && actionData.error && <ErrorText>{actionData.error}</ErrorText>}
      {shown.length === 0 ? (
        <EmptyState title={state === "open" ? "No open milestones" : "No closed milestones"}>
          {state === "open"
            ? canEdit
              ? "Make one for the next release or goal, then put issues and pull requests in it from their sidebars."
              : "Nobody has made a milestone here yet."
            : "Milestones that are done show here once they are closed."}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
          {shown.map((milestone) => (
            <li key={milestone.number} className="grid gap-3 px-4 py-4 sm:grid-cols-[1fr_16rem]">
              <div className="min-w-0">
                <Link
                  to={`${base}/milestones/${milestone.number}`}
                  className="inline-flex max-w-full items-center gap-2 text-base font-medium hover:text-accent"
                >
                  <MilestoneIcon size={16} className="shrink-0 text-faint" />
                  <span className="truncate">{milestone.title}</span>
                </Link>
                <p className="mt-1 text-xs">
                  {milestone.state === "closed" && milestone.closedAt ? (
                    <span className="text-muted">Closed {milestone.closedAt.slice(0, 10)}</span>
                  ) : (
                    <DueLine milestone={milestone} today={today} />
                  )}
                </p>
                {milestone.description && (
                  <p className="mt-2 line-clamp-2 text-sm text-muted">{plainText(milestone.description)}</p>
                )}
              </div>
              <div className="min-w-0">
                <MilestoneBar milestone={milestone} />
                <p className="mt-1.5">
                  <ProgressLine milestone={milestone} />
                </p>
                {canEdit && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <MilestoneStateButton milestone={milestone} />
                    <DeleteMilestone milestone={milestone} />
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
