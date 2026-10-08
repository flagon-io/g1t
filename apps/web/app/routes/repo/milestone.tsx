import { ArrowLeft, MessageSquare, Pencil } from "lucide-react";
import { useState } from "react";
import { Link, redirect } from "react-router";

import type { Issue, Pull } from "@g1t/contracts";

import type { Route } from "./+types/milestone";
import { LabelChip, MilestoneBar } from "../../components/labels";
import { Markdown } from "../../components/markdown";
import {
  DeleteMilestone,
  DueLine,
  MilestoneForm,
  MilestoneStateButton,
  ProgressLine,
} from "../../components/milestones";
import { Button, EmptyState, ErrorText, TimeAgo } from "../../components/ui";
import { IssueIcon, PullIcon } from "../../components/work";
import { requireRepo } from "../../lib/access.server";
import { colorsOf } from "../../lib/labels";
import { page } from "../../lib/meta";
import { milestoneAction } from "../../lib/milestones.server";
import { openedBy } from "../../lib/opened-by";
import { work } from "../../lib/services.server";

export function meta({ loaderData, params, ...args }: Route.MetaArgs) {
  const title = loaderData?.detail.milestone.title;
  return page(args, { title: `${title ? `${title} · Milestone · ` : ""}${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const { viewer, access } = await requireRepo(context, params, "read");
  const path = { namespace: params.owner, name: params.repo };
  const state = new URL(request.url).searchParams.get("state") === "closed" ? "closed" : "open";
  const [found, labels] = await Promise.all([
    work.getMilestone(path, Number(params.number), viewer),
    work.listLabels(path, viewer),
  ]);
  if (!found.ok) throw new Response("Milestone not found.", { status: 404 });
  return {
    detail: found.value,
    labels: labels.ok ? labels.value : [],
    state,
    canEdit: access.can.manage_labels,
    today: new Date().toISOString(),
  } as const;
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const result = await milestoneAction(request, params, context);
  // Deleted: back to the list.
  if (result.intent === "delete" && !result.error) throw redirect(`/${params.owner}/${params.repo}/milestones`);
  return result;
}

type Item = { kind: "issue"; issue: Issue } | { kind: "pull"; pull: Pull };

function isOpen(item: Item): boolean {
  return item.kind === "issue" ? item.issue.state === "open" : item.pull.status === "open" || item.pull.status === "draft";
}

export default function MilestonePage({ loaderData, actionData, params }: Route.ComponentProps) {
  const { detail, labels, state, canEdit } = loaderData;
  const { milestone } = detail;
  const base = `/${params.owner}/${params.repo}`;
  const today = new Date(loaderData.today);
  const colors = colorsOf(labels);
  const [editing, setEditing] = useState(false);
  // Issues and pull requests together, newest first.
  const items: Item[] = [
    ...detail.issues.map((issue) => ({ kind: "issue" as const, issue })),
    ...detail.pulls.map((pull) => ({ kind: "pull" as const, pull })),
  ].sort((a, b) => (b.kind === "issue" ? b.issue.number : b.pull.number) - (a.kind === "issue" ? a.issue.number : a.pull.number));
  const openItems = items.filter(isOpen);
  const closedItems = items.filter((item) => !isOpen(item));
  const shown = state === "open" ? openItems : closedItems;
  const here = `${base}/milestones/${milestone.number}`;
  const tab = (value: "open" | "closed", label: string, count: number) => (
    <Link
      to={value === "open" ? here : `${here}?state=closed`}
      className={
        "rounded-md px-3 py-1.5 text-sm transition-colors " +
        (state === value ? "bg-raised font-medium text-fg" : "text-muted hover:text-fg")
      }
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
            <h2 className="text-2xl font-semibold tracking-tight text-balance">
              {milestone.title}
              {milestone.state === "closed" && (
                <span className="ml-2 rounded-full border border-line px-2 py-0.5 align-middle text-xs font-normal text-muted">
                  Closed
                </span>
              )}
            </h2>
            <p className="mt-1 text-sm">
              <DueLine milestone={milestone} today={today} />
            </p>
            {milestone.description && (
              <div className="mt-3 text-sm">
                <Markdown source={milestone.description} repo={{ namespace: params.owner, name: params.repo }} />
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
                <Button type="button" variant="quiet" onClick={() => setEditing(true)}>
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
      <div className="flex gap-1 self-start rounded-lg border border-line p-1 sm:w-fit">
        {tab("open", "Open", openItems.length)}
        {tab("closed", "Closed", closedItems.length)}
      </div>
      {shown.length === 0 ? (
        <EmptyState title={state === "open" ? "Nothing open in this milestone" : "Nothing closed in this milestone yet"}>
          {canEdit
            ? "Put an issue or a pull request in it from the Milestone menu in its sidebar."
            : "Issues and pull requests in this milestone show here."}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
          {shown.map((item) =>
            item.kind === "issue" ? (
              <li key={`i${item.issue.number}`}>
                <Link
                  to={`${base}/issues/${item.issue.number}`}
                  className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-surface"
                >
                  <span className="mt-0.5">
                    <IssueIcon issue={item.issue} />
                  </span>
                  <span className="min-w-0 grow">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-medium">{item.issue.title}</span>
                      {item.issue.labels.map((name) => (
                        <LabelChip key={name} name={name} color={colors[name]} />
                      ))}
                    </span>
                    <span className="mt-0.5 block text-xs text-faint">
                      #{item.issue.number} opened <TimeAgo at={item.issue.createdAt} /> by {item.issue.author.username}
                    </span>
                  </span>
                  {item.issue.commentCount > 0 && (
                    <span className="mt-0.5 flex shrink-0 items-center gap-1 text-xs text-muted">
                      <MessageSquare size={13} />
                      {item.issue.commentCount}
                    </span>
                  )}
                </Link>
              </li>
            ) : (
              <li key={`p${item.pull.number}`}>
                <Link
                  to={`${base}/pull/${item.pull.number}`}
                  className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-surface"
                >
                  <span className="mt-0.5">
                    <PullIcon status={item.pull.status} />
                  </span>
                  <span className="min-w-0 grow">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-medium">{item.pull.title}</span>
                      {(item.pull.labels ?? []).map((name) => (
                        <LabelChip key={name} name={name} color={colors[name]} />
                      ))}
                    </span>
                    <span className="mt-0.5 block text-xs text-faint">
                      #{item.pull.number} opened <TimeAgo at={item.pull.createdAt} /> by {openedBy(item.pull).name}
                      {item.pull.base && (
                        <>
                          {" "}
                          into <span className="font-mono">{item.pull.base}</span>
                        </>
                      )}
                    </span>
                  </span>
                </Link>
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}
