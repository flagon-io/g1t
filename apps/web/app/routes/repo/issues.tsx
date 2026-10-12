import { GitPullRequest, MessageSquare, Milestone as MilestoneIcon, Plus, Tag } from "lucide-react";
import { Link, useLocation, useRouteLoaderData } from "react-router";

import type { Route } from "./+types/issues";
import { page } from "../../lib/meta";
import { ButtonLink, EmptyState, TimeAgo } from "../../components/ui";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Hint } from "../../components/ui/hint";
import { mirrorReason, type MirroredRepo } from "../../lib/mirror";
import {
  Assignee,
  AssigneeStack,
  IssueIcon,
  StateTabs,
} from "../../components/work";
import { FilterMenu, LabelChip, Swatch } from "../../components/labels";
import { colorsOf, listFilters, withFilter } from "../../lib/labels";
import { work } from "../../lib/services.server";
import { getViewer, unwrap } from "../../lib/session.server";
import { repoPages } from "../../lib/repo-live";
import { useRepoLive } from "../../lib/use-repo-live";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Issues · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const path = { namespace: params.owner, name: params.repo };
  // `?label=bug&milestone=3`, or `label:bug milestone:3` written in `q`.
  const { state, label, milestone } = listFilters(new URL(request.url).searchParams);
  const [issues, labels, milestones] = await Promise.all([    work.listIssues(path, viewer, { state, label: label || undefined, milestone: milestone ?? undefined }),
    work.listLabels(path, viewer),
    work.listMilestones(path, viewer, "open"),
  ]);
  return {
    issues: unwrap(issues),
    labels: unwrap(labels),
    milestones: milestones.ok ? milestones.value : [],
    state,
    label,
    milestone,
  } as const;
}

export default function Issues({ loaderData, params }: Route.ComponentProps) {
  const { issues, labels, milestones, state, label, milestone } = loaderData;
  // Issues opened, commented on and closed show as it happens.
  useRepoLive({ match: repoPages.issues() });
  const repo = `/${params.owner}/${params.repo}`;
  const base = `${repo}/issues`;
  const current = new URLSearchParams(useLocation().search);
  const colors = colorsOf(labels);
  const milestoneTitle = milestones.find((m) => m.number === milestone)?.title ?? (milestone ? `#${milestone}` : null);
  const filtered = [label, milestone].some(Boolean);
  // The tabs keep the filters; each filter keeps the state and the other.
  const kept = new URLSearchParams(current);
  kept.delete("state");
  kept.delete("q");

  // An archived repository's issues are locked: no new ones.
  const layout = useRouteLoaderData("routes/repo/layout") as { repo?: MirroredRepo & { archivedAt?: string | null } } | undefined;
  const archived = Boolean(layout?.repo?.archivedAt);
  // A mirror takes no new issues until someone takes over: the button says why.
  const mirrorBlocked = mirrorReason(layout?.repo);
  return (
    <div>
      <StateTabs
        to={base}
        state={state}
        query={kept.toString()}
        action={
          archived ? undefined : mirrorBlocked ? (
            <Hint label={mirrorBlocked} disabled>
              <Button type="button" disabled>
                <Plus size={15} />
                New issue
              </Button>
            </Hint>
          ) : (
            <ButtonLink to={`${base}/new`}>
              <Plus size={15} />
              New issue
            </ButtonLink>
          )
        }
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <FilterMenu
          label="Label"
          active={label || undefined}
          clearTo={label ? withFilter(base, current, "label", null) : undefined}
          searchPlaceholder="Filter labels"
          emptyText="No label matches."
          options={labels.map((each) => ({
            key: each.name,
            to: withFilter(base, current, "label", each.name),
            keywords: `${each.name} ${each.description}`,
            selected: each.name === label,
            label: (
              <>
                <Swatch color={each.color} />
                <span className="truncate">{each.name}</span>
              </>
            ),
          }))}
        />
        <FilterMenu
          label="Milestone"
          active={milestoneTitle ?? undefined}
          clearTo={milestone ? withFilter(base, current, "milestone", null) : undefined}
          searchPlaceholder="Filter milestones"
          emptyText="No open milestone matches."
          options={milestones.map((each) => ({
            key: String(each.number),
            to: withFilter(base, current, "milestone", String(each.number)),
            keywords: `${each.title} ${each.number}`,
            selected: each.number === milestone,
            label: <span className="truncate">{each.title}</span>,
          }))}
        />
        {filtered && (
          <Link to={state === "closed" ? `${base}?state=closed` : base} className="text-xs text-muted hover:text-fg">
            Clear filters
          </Link>
        )}
        <span className="ml-auto flex items-center gap-1">
          <Link
            to={`${repo}/labels`}
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-muted transition-colors hover:bg-surface hover:text-fg"
          >
            <Tag size={14} />
            Labels
          </Link>
        </span>
      </div>
      <div className="mt-4">
        {issues.length === 0 ? (
          <EmptyState
            title={
              filtered
                ? `No ${state} issues match these filters`
                : state === "open"
                  ? "No open issues"
                  : "No closed issues"
            }
          >
            An issue says what should change: a bug, a feature, a question.
            People and their coding agents open pull requests against it.
          </EmptyState>
        ) : (
          <Card asChild tone="plain" divided className="overflow-hidden">
            <ul>
              {issues.map((issue) => (
                <li key={issue.id} className="flex items-start transition-colors hover:bg-surface">
                  <Link
                    prefetch="intent"
                    to={`${base}/${issue.number}`}
                    className="flex min-w-0 grow items-start gap-3 px-4 py-3"
                  >
                    <span className="mt-0.5">
                      <IssueIcon issue={issue} />
                    </span>
                    <span className="min-w-0 grow">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-medium">{issue.title}</span>
                        {issue.labels.map((name) => (
                          <LabelChip key={name} name={name} color={colors[name]} />
                        ))}
                        {issue.state === "open" && issue.agent && (
                          <Assignee agent={issue.agent} />
                        )}
                      </span>
                      <span className="mt-0.5 block text-xs text-faint">
                        #{issue.number} opened <TimeAgo at={issue.createdAt} /> by{" "}
                        {issue.author.username}
                        {issue.requestedBy && <> for {issue.requestedBy.username}</>}
                        {issue.resolvedBy != null && (
                          <span className="text-merged"> · resolved by #{issue.resolvedBy}</span>
                        )}
                        {issue.milestone && (
                          <span className="inline-flex items-center gap-1">
                            {" "}
                            · <MilestoneIcon size={11} className="inline" /> {issue.milestone.title}
                          </span>
                        )}
                      </span>
                    </span>
                    <span className="mt-0.5 flex shrink-0 items-center gap-3 text-xs text-muted">
                      <AssigneeStack people={issue.assignees} />
                      {issue.pullCount > 0 && (
                        <Hint label={`${issue.pullCount} pull ${issue.pullCount === 1 ? "request" : "requests"}`}>
                          <span className="flex items-center gap-1">
                            <GitPullRequest size={13} />
                            {issue.pullCount}
                            <span className="sr-only">pull {issue.pullCount === 1 ? "request" : "requests"}</span>
                          </span>
                        </Hint>
                      )}
                      {issue.commentCount > 0 && (
                        <span className="flex items-center gap-1">
                          <MessageSquare size={13} />
                          {issue.commentCount}
                        </span>
                      )}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}
