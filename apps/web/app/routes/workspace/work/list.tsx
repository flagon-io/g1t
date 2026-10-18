import { Flag, Plus, Tag } from "lucide-react";
import { Link, useLocation } from "react-router";

import type { Route } from "./+types/list";
import { page } from "../../../lib/meta";
import { ButtonLink, EmptyState } from "../../../components/ui";
import { Card } from "../../../components/ui/card";
import { StateTabs } from "../../../components/work";
import { WorkFiltersBar, WorkItemRow } from "../../../components/work-items";
import { Unavailable } from "../../../components/boundary";
import { colorsOf } from "../../../lib/labels";
import { isFailed, part } from "../../../lib/partial";
import { identity, work } from "../../../lib/services.server";
import { getViewer, roleIn, unwrap } from "../../../lib/session.server";
import { filtered, newItemPath, repoFilter, shortPath, workFilters, workPath, workQuery } from "../../../lib/work-items";
import { workspaceProjects } from "../../../lib/workspace-projects.server";

export function meta({ params, location, ...args }: Route.MetaArgs) {
  const repo = new URLSearchParams(location.search).get("repo");
  return page({ location, ...args }, { title: `Work${repo ? ` · ${repo}` : ""} · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const workspace = params.owner.toLowerCase();
  const filters = workFilters(new URL(request.url).searchParams);
  const member = roleIn(viewer, workspace) != null;
  const repo = filters.repo ? repoFilter(workspace, filters.repo) : null;
  const assignee = filters.assignee === "@me" ? (viewer?.username ?? "") : filters.assignee;
  // The list is what the page is about; what fills its filters is a part
  // each, whose menu says so when its service fails.
  const [items, labels, milestones, projects, members] = await Promise.all([
    work.listWorkItems(workspace, viewer, {
      state: filters.state,
      label: filters.label || undefined,
      milestone: filters.milestone ?? undefined,
      assignee: assignee || undefined,
      repo: repo ?? undefined,
      role: filters.role ?? undefined,
    }),
    part(work.listLabels(workspace, viewer), "Labels"),
    part(work.listMilestones(workspace, viewer, "open"), "Milestones"),
    part(workspaceProjects(workspace, viewer), "Repositories"),
    // A member filters by the workspace's people; anyone else, by name in the address.
    member ? part(identity.listMembers(workspace, viewer), "The workspace's people") : null,
  ]);
  return {
    workspace,
    filters,
    member,
    signedIn: viewer != null,
    me: viewer?.username ?? null,
    items: unwrap(items),
    labels: isFailed(labels) || !labels.ok ? null : labels.value,
    milestones: isFailed(milestones) || !milestones.ok ? null : milestones.value,
    repos: isFailed(projects) || !projects.ok ? null : projects.value.filter((p) => p.workspace.toLowerCase() === workspace).map((p) => p.slug).sort(),
    people: members == null || isFailed(members) || !members.ok ? null : members.value.map((m) => m.username).sort(),
    labelsFailed: isFailed(labels),
  };
}

export default function WorkList({ loaderData }: Route.ComponentProps) {
  const { workspace, filters, items, member, signedIn } = loaderData;
  const { search } = useLocation();
  const colors = colorsOf(loaderData.labels ?? []);
  const repoName = filters.repo ? shortPath(filters.repo, workspace) : null;
  // The tabs keep the filters; each filter keeps the state and the others.
  const kept = new URLSearchParams(workQuery({ ...filters, state: "open" }));
  return (
    <div>
      {loaderData.labelsFailed && (
        <div className="mb-3">
          <Unavailable what="Labels" compact />
        </div>
      )}
      <StateTabs
        to={workPath(workspace)}
        state={filters.state}
        query={kept.toString()}
        action={
          signedIn && (member || repoName) ? (
            <ButtonLink to={newItemPath(workspace, repoName)} className="max-sm:h-10">
              <Plus size={15} />
              New work item
            </ButtonLink>
          ) : undefined
        }
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <WorkFiltersBar
          workspace={workspace}
          filters={filters}
          choices={{ repos: loaderData.repos, labels: loaderData.labels, milestones: loaderData.milestones, people: loaderData.people, me: loaderData.me }}
        />
        <span className="ml-auto hidden items-center gap-1 sm:flex">
          <Link
            to={workPath(workspace, "labels")}
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-muted transition-colors hover:bg-surface hover:text-fg"
          >
            <Tag size={14} />
            Labels
          </Link>
          <Link
            to={workPath(workspace, "milestones")}
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-muted transition-colors hover:bg-surface hover:text-fg"
          >
            <Flag size={14} />
            Milestones
          </Link>
        </span>
      </div>
      <div className="mt-4">
        {items.length === 0 ? (
          <EmptyState
            title={
              filtered(filters)
                ? `No ${filters.state} work items match these filters`
                : repoName
                  ? `No ${filters.state} work items linked to ${repoName}`
                  : filters.state === "open"
                    ? "No open work items"
                    : "No closed work items"
            }
          >
            A work item says what should change: a feature, a bug, a chore. It belongs to the workspace and lands in the repositories it
            names; people and their coding agents open pull requests for it.
            {search && filtered(filters) && (
              <>
                {" "}
                <Link to={workPath(workspace)} className="text-fg underline underline-offset-4">
                  Clear the filters
                </Link>
                .
              </>
            )}
          </EmptyState>
        ) : (
          <Card asChild tone="plain" divided className="overflow-hidden">
            <ul>
              {items.map((item) => (
                <WorkItemRow key={item.id} item={item} colors={colors} />
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}
