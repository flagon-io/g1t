import { ArrowLeft, Pencil } from "lucide-react";
import { useState } from "react";
import { Link, redirect } from "react-router";

import type { Pull, WorkItem } from "@g1t/contracts";

import type { Route } from "./+types/milestone";
import { LabelChip, MilestoneBar } from "../../../components/labels";
import { Markdown } from "../../../components/markdown";
import { DeleteMilestone, DueLine, MilestoneForm, MilestoneStateButton, ProgressLine } from "../../../components/milestones";
import { EmptyState, ErrorText, TimeAgo } from "../../../components/ui";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { PullIcon } from "../../../components/work";
import { WorkItemRow } from "../../../components/work-items";
import { readableRepos } from "../../../lib/access.server";
import { colorsOf } from "../../../lib/labels";
import { orElse, part } from "../../../lib/partial";
import { page } from "../../../lib/meta";
import { milestoneAction } from "../../../lib/milestones.server";
import { openedBy } from "../../../lib/opened-by";
import { work } from "../../../lib/services.server";
import { getViewer } from "../../../lib/session.server";
import { canItem } from "../../../lib/work-access";
import { shortPath, workPath } from "../../../lib/work-items";

export function meta({ loaderData, params, ...args }: Route.MetaArgs) {
  const title = loaderData?.detail.milestone.title;
  return page(args, { title: `${title ? `${title} · Milestone · ` : ""}Work · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const workspace = params.owner.toLowerCase();
  const state = new URL(request.url).searchParams.get("state") === "closed" ? "closed" : "open";
  const [found, labels] = await Promise.all([
    work.getMilestone(workspace, Number(params.number), viewer),
    // Only its chips' colors: without them a chip still names its label.
    part(work.listLabels(workspace, viewer), "Labels").then((labels) => orElse(labels, null)),
  ]);
  if (!found.ok) throw new Response("Milestone not found.", { status: 404 });
  // Its pull requests are each in a repository of the workspace: where each is.
  const ids = [...new Set(found.value.pulls.map((pull) => pull.repoId))];
  const repos = await readableRepos(ids, viewer).catch(() => []);
  return {
    workspace,
    detail: found.value,
    repoPaths: Object.fromEntries(repos.map((repo) => [repo.id, `${repo.namespace}/${repo.name}`])) as Record<string, string>,
    labels: labels?.ok ? labels.value : [],
    state,
    canEdit: canItem(viewer, workspace, null, "manage_labels"),
    today: new Date().toISOString(),
  } as const;
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const result = await milestoneAction(request, params, context);
  // Deleted: back to the list.
  if (result.intent === "delete" && !result.error) throw redirect(workPath(params.owner, "milestones"));
  return result;
}

type Entry = { kind: "item"; item: WorkItem } | { kind: "pull"; pull: Pull };

function isOpen(entry: Entry): boolean {
  return entry.kind === "item" ? entry.item.state === "open" : entry.pull.status === "open" || entry.pull.status === "draft";
}

/** When it was made, to put work items and pull requests in one order. */
function madeAt(entry: Entry): number {
  return Date.parse(entry.kind === "item" ? entry.item.createdAt : entry.pull.createdAt);
}

export default function MilestonePage({ loaderData, actionData }: Route.ComponentProps) {
  const { detail, labels, state, canEdit, workspace, repoPaths } = loaderData;
  const { milestone } = detail;
  const base = workPath(workspace);
  const today = new Date(loaderData.today);
  const colors = colorsOf(labels);
  const [editing, setEditing] = useState(false);
  // Work items and pull requests together, newest first.
  const entries: Entry[] = [
    ...detail.items.map((item) => ({ kind: "item" as const, item })),
    ...detail.pulls.map((pull) => ({ kind: "pull" as const, pull })),
  ].sort((a, b) => madeAt(b) - madeAt(a));
  const openEntries = entries.filter(isOpen);
  const closedEntries = entries.filter((entry) => !isOpen(entry));
  const shown = state === "open" ? openEntries : closedEntries;
  const here = `${base}/milestones/${milestone.number}`;
  const tab = (value: "open" | "closed", label: string, count: number) => (
    <Link
      to={value === "open" ? here : `${here}?state=closed`}
      className={"rounded-md px-3 py-1.5 text-sm transition-colors " + (state === value ? "bg-raised font-medium text-fg" : "text-muted hover:text-fg")}
    >
      {label} <span className="tabular-nums text-faint">{count}</span>
    </Link>
  );
  return (
    <div className="space-y-5">
      <Link to={`${base}/milestones`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} />
        Milestones
      </Link>
      {editing ? (
        <MilestoneForm milestone={milestone} onDone={() => setEditing(false)} />
      ) : (
        <header className="grid gap-4 sm:grid-cols-[1fr_18rem]">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-balance">
              {milestone.title}
              {milestone.state === "closed" && (
                <Badge size="md" className="ml-2 align-middle">
                  Closed
                </Badge>
              )}
            </h1>
            <p className="mt-1 text-sm">
              <DueLine milestone={milestone} today={today} />
            </p>
            {milestone.description && (
              <div className="mt-3 text-sm">
                <Markdown source={milestone.description} workspace={workspace} />
              </div>
            )}
          </div>
          <div className="min-w-0">
            <MilestoneBar milestone={milestone} />
            <p className="mt-1.5">
              <ProgressLine milestone={milestone} />
            </p>
            {canEdit && (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button type="button" variant="outline" onClick={() => setEditing(true)}>
                  <Pencil size={14} />
                  Edit
                </Button>
                <MilestoneStateButton milestone={milestone} />
                <DeleteMilestone milestone={milestone} />
              </div>
            )}
          </div>
        </header>
      )}
      {actionData?.error && actionData.intent !== "edit" && <ErrorText>{actionData.error}</ErrorText>}
      <Card tone="plain" radius="lg" className="flex gap-1 self-start p-1 sm:w-fit">
        {tab("open", "Open", openEntries.length)}
        {tab("closed", "Closed", closedEntries.length)}
      </Card>
      {shown.length === 0 ? (
        <EmptyState title={state === "open" ? "Nothing open in this milestone" : "Nothing closed in this milestone yet"}>
          {canEdit
            ? "Put a work item or a pull request in it from the Milestone menu in its sidebar."
            : "Work items and pull requests in this milestone show here."}
        </EmptyState>
      ) : (
        <Card asChild tone="plain" divided className="overflow-hidden">
          <ul>
            {shown.map((entry) =>
              entry.kind === "item" ? (
                <WorkItemRow key={`i${entry.item.id}`} item={entry.item} colors={colors} />
              ) : (
                <PullRow key={`p${entry.pull.id}`} pull={entry.pull} repo={repoPaths[entry.pull.repoId] ?? null} workspace={workspace} colors={colors} />
              ),
            )}
          </ul>
        </Card>
      )}
    </div>
  );
}

/** A pull request in the milestone, with the repository it is in. */
function PullRow({ pull, repo, workspace, colors }: { pull: Pull; repo: string | null; workspace: string; colors: Record<string, string> }) {
  const inner = (
    <>
      <span className="mt-0.5">
        <PullIcon status={pull.status} />
      </span>
      <span className="min-w-0 grow">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium wrap-break-word">{pull.title}</span>
          {(pull.labels ?? []).map((name) => (
            <LabelChip key={name} name={name} color={colors[name]} />
          ))}
        </span>
        <span className="mt-0.5 block text-xs text-faint">
          {repo && <span className="font-mono">{shortPath(repo, workspace)}</span>}#{pull.number} opened <TimeAgo at={pull.createdAt} /> by{" "}
          {openedBy(pull).name}
        </span>
      </span>
    </>
  );
  return (
    <li>
      {repo ? (
        <Link to={`/${repo}/pull/${pull.number}`} className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-surface">
          {inner}
        </Link>
      ) : (
        <div className="flex items-start gap-3 px-4 py-3">{inner}</div>
      )}
    </li>
  );
}
