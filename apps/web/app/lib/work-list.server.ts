// What the Work list reads (routes/workspace/work/list.tsx), and a
// project's Items tab with it (routes/workspace/work/project-items.tsx).

import { LIST_PAGE } from "@g1t/contracts";

import type { Route } from "../routes/workspace/work/+types/list";
import { isFailed, part } from "./partial";
import { identity, repos, work } from "./services.server";
import { getViewer, roleIn, unwrap } from "./session.server";
import { splitLive } from "./sessions";
import { canItem } from "./work-access";
import { type ListPage, listPage, repoFilter, shortPath, workFilters } from "./work-items";
import { workspaceProjects } from "./workspace-projects.server";

/** How many live sessions the strip over the list shows. */
const COOKING = 6;

/**
 * The Work list's data: its work items, a page at a time, with what fills
 * its filters. With `project` (a slug), only that project's, as its Items
 * tab shows them (routes/workspace/work/project-items.tsx): there the
 * project is no filter to change, and the strip of live sessions is left out.
 */
export async function loadWorkList({ params, context, request }: Pick<Route.LoaderArgs, "params" | "context" | "request">, project?: string) {
  const viewer = getViewer(context);
  const workspace = params.owner.toLowerCase();
  const query = new URL(request.url).searchParams;
  const filters = { ...workFilters(query), ...(project ? { project } : {}) };
  // A page at a time, newest first, below the lowest number of the page above. A horizon is
  // read in the plan's order instead, its first page only: the plan pages it no further.
  const at: ListPage = filters.horizon ? { before: null, newer: [] } : listPage(query);
  const member = roleIn(viewer, workspace) != null;
  const repo = filters.repo ? repoFilter(workspace, filters.repo) : null;
  const assignee = filters.assignee === "@me" ? (viewer?.username ?? "") : filters.assignee;
  // The list is what the page is about; what fills its filters is a part
  // each, whose menu says so when its service fails.
  const [items, labels, milestones, projects, members, cooking, workProjects] = await Promise.all([
    work.listWorkItems(workspace, viewer, {
      state: filters.state,
      horizon: filters.horizon ?? undefined,
      before: at.before ?? undefined,
      label: filters.label || undefined,
      milestone: filters.milestone ?? undefined,
      assignee: assignee || undefined,
      repo: repo ?? undefined,
      role: filters.role ?? undefined,
      parent: filters.parent ?? undefined,
      project: filters.project || undefined,
    }),
    part(work.listLabels(workspace, viewer), "Labels"),
    part(work.listMilestones(workspace, viewer, "open"), "Milestones"),
    part(workspaceProjects(workspace, viewer), "Repositories"),
    // A member filters by the workspace's people; anyone else, by name in the address.
    member ? part(identity.listMembers(workspace, viewer), "The workspace's people") : null,
    // What is cooking now, over the list: a nicety, left out when Sessions cannot say.
    project
      ? null
      : work
          .listWorkspaceSessions(workspace, viewer, {
            shown: "live",
            sessionsOnly: true,
            repo: filters.repo ? shortPath(filters.repo, workspace) : undefined,
            limit: 30,
          })
          .catch(() => null),
    // Work's projects, to filter by; one project's own list has no such filter.
    project ? null : part(work.listProjects(workspace, viewer), "Projects"),
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
    // Left out (undefined) on one project's list, where there is no project to choose.
    projects:
      workProjects === null
        ? undefined
        : isFailed(workProjects) || !workProjects.ok
          ? null
          : workProjects.value.map(({ slug, name, color, icon }) => ({ slug, name, color, icon })),
  };
}

/** What the Work list draws, as `loadWorkList` reads it. */
export type WorkListData = Awaited<ReturnType<typeof loadWorkList>>;
