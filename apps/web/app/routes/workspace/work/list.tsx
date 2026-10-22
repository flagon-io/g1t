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
import {
  HORIZON_LABELS,
  type ListPage,
  type WorkFilters,
  emptyListTitle,
  filtered,
  newItemPath,
  pageQuery,
  shortPath,
  workPath,
  workQuery,
} from "../../../lib/work-items";
import { workPages } from "../../../lib/repo-live";
import { useRefreshWhile } from "../../../lib/refresh";
import { useWorkspaceLive } from "../../../lib/use-repo-live";
import { type WorkListData, loadWorkList } from "../../../lib/work-list.server";

export function meta({ params, location, ...args }: Route.MetaArgs) {
  const repo = new URLSearchParams(location.search).get("repo");
  return page({ location, ...args }, { title: `Work${repo ? ` · ${repo}` : ""} · ${params.owner} · g1t` });
}

export async function loader(args: Route.LoaderArgs) {
  return loadWorkList(args);
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
  return <WorkListView data={loaderData} />;
}

/**
 * The Work list, drawn from what `loadWorkList` read. With `project` (its
 * slug and its Items tab's address), it is that project's list: its
 * filters keep to the tab, and a new work item is filed into it.
 */
export function WorkListView({ data: loaderData, project }: { data: WorkListData; project?: { slug: string; base: string } }) {
  const { workspace, items, member, at, older, more } = loaderData;
  // On a project's tab, its project is where the list is, not a filter to show or carry.
  const filters = project ? { ...loaderData.filters, project: "" } : loaderData.filters;
  const { pathname, search } = useLocation();
  const colors = colorsOf(loaderData.labels ?? []);
  const repoName = filters.repo ? shortPath(filters.repo, workspace) : null;
  // The tabs keep the filters but a horizon, which holds only open items; each filter keeps the state and the others.
  const kept = new URLSearchParams(workQuery({ ...filters, state: "open", horizon: null }));
  const emptyTitle = project && !filtered(filters) ? `No ${filters.state} work items in this project` : emptyListTitle(filters, repoName);
  useWorkspaceLive({ workspace, member, match: workPages.list() });
  // The list as it shows, for J and K on each item's page.
  const trail = { numbers: items.map((item) => item.number), label: project ? "Project" : "All items", href: `${pathname}${search}` };
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
          // A project's header has its own New work item.
          loaderData.canOpen && !project ? (
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
          base={project?.base}
          choices={{
            repos: loaderData.repos,
            labels: loaderData.labels,
            milestones: loaderData.milestones,
            people: loaderData.people,
            me: loaderData.me,
            projects: loaderData.projects,
          }}
        />
        <span className={project ? "hidden" : "ml-auto hidden items-center gap-1 sm:flex"}>
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
          <EmptyState title={emptyTitle}>
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
                <WorkItemRow key={item.id} item={item} colors={colors} showProject={!project} trail={trail} />
              ))}
            </ul>
          </Card>
        )}
        <Paging filters={filters} at={at} older={older} />
      </div>
    </div>
  );
}
