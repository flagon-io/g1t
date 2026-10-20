import { ChevronLeft, ChevronRight, Columns3, Flag, Plus, Tag } from "lucide-react";
import { Link, useLocation } from "react-router";

import { LIST_PAGE } from "@g1t/contracts";

import type { Route } from "./+types/list";
import { page } from "../../../lib/meta";
import { ButtonLink, EmptyState } from "../../../components/ui";
import { Card } from "../../../components/ui/card";
import { CookingStrip } from "../../../components/sessions";
import { StateTabs } from "../../../components/work";
import { WorkFiltersBar, WorkItemRow } from "../../../components/work-items";
import { Unavailable } from "../../../components/boundary";
import { colorsOf } from "../../../lib/labels";
import { isFailed, part } from "../../../lib/partial";
import { identity, repos, work } from "../../../lib/services.server";
import { getViewer, roleIn, unwrap } from "../../../lib/session.server";
import {
  HORIZON_LABELS,
  type ListPage,
  type WorkFilters,
  emptyListTitle,
  filtered,
  listPage,
  newItemPath,
  pageQuery,
  repoFilter,
  shortPath,
  workFilters,
  workPath,
  workQuery,
} from "../../../lib/work-items";
import { canItem } from "../../../lib/work-access";
import { workspaceProjects } from "../../../lib/workspace-projects.server";
import { workPages } from "../../../lib/repo-live";
import { useRefreshWhile } from "../../../lib/refresh";
import { splitLive } from "../../../lib/sessions";
import { useWorkspaceLive } from "../../../lib/use-repo-live";

/** How many live sessions the strip over the list shows. */
const COOKING = 6;

export function meta({ params, location, ...args }: Route.MetaArgs) {
  const repo = new URLSearchParams(location.search).get("repo");
  return page({ location, ...args }, { title: `Work${repo ? ` · ${repo}` : ""} · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const workspace = params.owner.toLowerCase();
  const query = new URL(request.url).searchParams;
  const filters = workFilters(query);
  // A page at a time, newest first, below the lowest number of the page above. A horizon is
  // read in the plan's order instead, its first page only: the plan pages it no further.
  const at: ListPage = filters.horizon ? { before: null, newer: [] } : listPage(query);
  const member = roleIn(viewer, workspace) != null;
  const repo = filters.repo ? repoFilter(workspace, filters.repo) : null;
  const assignee = filters.assignee === "@me" ? (viewer?.username ?? "") : filters.assignee;
  // The list is what the page is about; what fills its filters is a part
  // each, whose menu says so when its service fails.
  const [items, labels, milestones, projects, members, cooking] = await Promise.all([
    work.listWorkItems(workspace, viewer, {
      state: filters.state,
      horizon: filters.horizon ?? undefined,
      before: at.before ?? undefined,
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
    // What is cooking now, over the list: a nicety, left out when Sessions cannot say.
    work
      .listWorkspaceSessions(workspace, viewer, {
        shown: "live",
        sessionsOnly: true,
        repo: filters.repo ? shortPath(filters.repo, workspace) : undefined,
        limit: 30,
      })
      .catch(() => null),
  ]);
  const live = cooking?.ok ? splitLive(cooking.value.sessions) : null;
  // Who may open one here, as New work item says (routes/workspace/work/new.tsx): a member; anyone else
  // only from a repository of the workspace (`?repo=web`) they may take part in.
  const short = filters.repo ? shortPath(filters.repo, workspace) : null;
  let canOpen = viewer != null && member;
  if (viewer && !member && short && !short.includes("/")) {
    const found = await repos.get({ namespace: workspace, name: short }, viewer).catch(() => null);
    canOpen = Boolean(
      found?.ok && canItem(viewer, workspace, { id: found.value.id, namespace: found.value.namespace, isPrivate: found.value.isPrivate }, "participate"),
    );
  }
  const rows = unwrap(items);
  return {
    canOpen,
    workspace,
    filters,
    at,
    // The page below, from the lowest number shown, when this one is full.
    older: !filters.horizon && rows.length >= LIST_PAGE ? Math.min(...rows.map((item) => item.number)) : null,
    // A horizon's first page is all the list shows of it: the plan has the rest.
    more: filters.horizon != null && rows.length >= LIST_PAGE,
    member,
    signedIn: viewer != null,
    me: viewer?.username ?? null,
    items: rows,
    labels: isFailed(labels) || !labels.ok ? null : labels.value,
    milestones: isFailed(milestones) || !milestones.ok ? null : milestones.value,
    repos:
      isFailed(projects) || !projects.ok
        ? null
        : projects.value
            .filter((p) => p.workspace.toLowerCase() === workspace)
            .map((p) => p.slug)
            .sort(),
    people: members == null || isFailed(members) || !members.ok ? null : members.value.map((m) => m.username).sort(),
    labelsFailed: isFailed(labels),
    cooking: live ? { sessions: [...live.active, ...live.idle].slice(0, COOKING), total: live.active.length + live.idle.length } : null,
  };
}

/** Newer and Older under the list: links relative to wherever the list is served, so its filters come along. */
function Paging({ filters, at, older }: { filters: WorkFilters; at: ListPage; older: number | null }) {
  if (at.before == null && older == null) return null;
  return (
    <nav aria-label="Pages" className="mt-3 flex items-center justify-between gap-3">
      {at.before != null ? (
        <ButtonLink to={pageQuery(filters, at, "newer")} prefetch="intent" variant="outline" size="sm" className="max-sm:h-10">
          <ChevronLeft size={15} />
          Newer
        </ButtonLink>
      ) : (
        <span />
      )}
      {older != null && (
        <ButtonLink to={pageQuery(filters, at, { older })} prefetch="intent" variant="outline" size="sm" className="max-sm:h-10">
          Older
          <ChevronRight size={15} />
        </ButtonLink>
      )}
    </nav>
  );
}

export default function WorkList({ loaderData }: Route.ComponentProps) {
  const { workspace, filters, items, member, at, older, more } = loaderData;
  const { pathname, search } = useLocation();
  const colors = colorsOf(loaderData.labels ?? []);
  const repoName = filters.repo ? shortPath(filters.repo, workspace) : null;
  // The tabs keep the filters but a horizon, which holds only open items; each filter keeps the state and the others.
  const kept = new URLSearchParams(workQuery({ ...filters, state: "open", horizon: null }));
  useWorkspaceLive({ workspace, member, match: workPages.list() });
  // Sessions go idle (after 15 minutes) with no event to say so: looked at again each minute.
  useRefreshWhile((loaderData.cooking?.total ?? 0) > 0, 60_000);
  return (
    <div>
      {loaderData.cooking && <CookingStrip sessions={loaderData.cooking.sessions} total={loaderData.cooking.total} workspace={workspace} repo={repoName} />}
      {loaderData.labelsFailed && (
        <div className="mb-3">
          <Unavailable what="Labels" compact />
        </div>
      )}
      <StateTabs
        to={pathname}
        state={filters.state}
        query={kept.toString()}
        action={
          loaderData.canOpen ? (
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
            to={workPath(workspace, repoName ? `board?repo=${encodeURIComponent(repoName)}` : "board")}
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-muted transition-colors hover:bg-surface hover:text-fg"
          >
            <Columns3 size={14} />
            Board
          </Link>
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
      {filters.horizon && items.length > 0 && (
        <p className="mt-3 text-xs text-muted">
          {HORIZON_LABELS[filters.horizon]}, in the plan&apos;s order{filters.horizon === "triage" ? ", newest first" : ""}.
          {more && ` Showing the first ${LIST_PAGE}; the plan has the rest.`}{" "}
          <Link to={workPath(workspace)} className="text-fg underline-offset-4 hover:underline">
            Open the plan
          </Link>
        </p>
      )}
      <div className="mt-4">
        {items.length === 0 ? (
          <EmptyState title={emptyListTitle(filters, repoName)}>
            A work item says what should change: a feature, a bug, a chore. It belongs to the workspace and lands in the repositories it names; people and their
            coding agents open pull requests for it.
            {search && filtered(filters) && (
              <>
                {" "}
                <Link to={pathname} className="text-fg underline underline-offset-4">
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
        <Paging filters={filters} at={at} older={older} />
      </div>
    </div>
  );
}
