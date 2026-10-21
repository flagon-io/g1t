import { Archive, CalendarClock, FolderKanban, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";

import type { WorkProject } from "@g1t/contracts";

import type { Route } from "./+types/projects";
import { HealthDot, NewProjectDialog, ProjectMark, StateBadge } from "../../../components/projects";
import { EmptyState } from "../../../components/ui";
import { Avatar } from "../../../components/ui/avatar";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { Hint } from "../../../components/ui/hint";
import { cn } from "../../../lib/cn";
import { page } from "../../../lib/meta";
import { isFailed, part } from "../../../lib/partial";
import { HEALTH_LABELS, datesText, percentDone, projectGroups, projectPath, projectsPath, timeLeft } from "../../../lib/projects";
import { projectAction } from "../../../lib/projects.server";
import { identity, work } from "../../../lib/services.server";
import { getViewer, roleIn, unwrap } from "../../../lib/session.server";
import { canItem } from "../../../lib/work-access";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Projects · Work · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const workspace = params.owner.toLowerCase();
  const query = new URL(request.url).searchParams;
  const archived = query.get("archived") === "1";
  const member = roleIn(viewer, workspace) != null;
  // The projects are what the page is about; the people to lead a new one are a part.
  const [projects, members] = await Promise.all([
    work.listProjects(workspace, viewer, { archived }),
    member ? part(identity.listMembers(workspace, viewer), "The workspace's people") : null,
  ]);
  return {
    workspace,
    archived,
    projects: unwrap(projects),
    // Made and changed with the Write role in the workspace.
    canEdit: canItem(viewer, workspace, null, "manage_labels"),
    members: members == null || isFailed(members) || !members.ok ? [] : members.value.map((m) => m.username).sort(),
    today: new Date().toISOString(),
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  return projectAction(request, params, context);
}

/**
 * Work's projects: every live one as a card with its health, progress,
 * lead and how long is left, then those done or dropped, and the archived
 * ones on a tab of their own. New project opens a dialog (also from the
 * sidebar, as `?new=1`).
 */
export default function Projects({ loaderData }: Route.ComponentProps) {
  const { workspace, projects, archived, canEdit, members } = loaderData;
  const today = new Date(loaderData.today);
  const [params, setParams] = useSearchParams();
  const asked = canEdit && params.get("new") === "1";
  const [creating, setCreating] = useState(asked);
  // The sidebar's New project, from this page too.
  useEffect(() => {
    if (asked) setCreating(true);
  }, [asked]);
  const setOpen = (open: boolean) => {
    setCreating(open);
    if (!open && params.has("new")) {
      const next = new URLSearchParams(params);
      next.delete("new");
      setParams(next, { replace: true, preventScrollReset: true });
    }
  };
  const { live, finished } = projectGroups(projects);
  const tab = (value: boolean, label: string) => (
    <Link
      to={value ? projectsPath(workspace, "archived=1") : projectsPath(workspace)}
      aria-current={archived === value ? "page" : undefined}
      className={cn(
        "inline-flex h-full items-center rounded-[5px] px-2.5 text-sm transition-colors",
        archived === value ? "bg-raised font-medium text-fg" : "text-muted hover:text-fg",
      )}
    >
      {label}
    </Link>
  );
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Card tone="plain" radius="lg" className="flex h-8 gap-0.5 rounded-md p-0.5">
          {tab(false, "Projects")}
          {tab(true, "Archived")}
        </Card>
        {canEdit && (
          <Button type="button" onClick={() => setOpen(true)} className="max-sm:h-10">
            <Plus size={15} />
            New project
          </Button>
        )}
      </div>
      {canEdit && <NewProjectDialog workspace={workspace} open={creating} onOpenChange={setOpen} members={members} />}

      {projects.length === 0 ? (
        archived ? (
          <EmptyState title="No archived projects">
            A project you archive leaves the lists and takes no new work items; its work items keep it. It shows here.
          </EmptyState>
        ) : (
          <Card className="flex flex-col items-center px-6 py-14 text-center">
            <span className="flex size-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <FolderKanban size={22} />
            </span>
            <h2 className="mt-4 text-base font-semibold">Give a body of work a home</h2>
            <p className="mt-1.5 max-w-md text-sm text-muted">
              A project gathers the work items toward one outcome with its brief, its lead and people, its repositories and its dates, and shows how it is going
              from the record, so nobody has to type a status.
            </p>
            {canEdit ? (
              <Button type="button" onClick={() => setOpen(true)} className="mt-5">
                <Plus size={15} />
                New project
              </Button>
            ) : (
              <p className="mt-4 text-xs text-faint">Making a project takes the Write role in the workspace.</p>
            )}
          </Card>
        )
      ) : (
        <>
          {live.length > 0 && (
            <section aria-label="Under way">
              <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {live.map((project) => (
                  <ProjectCard key={project.id} project={project} workspace={workspace} today={today} />
                ))}
              </ul>
            </section>
          )}
          {finished.length > 0 && (
            <section aria-labelledby="projects-finished">
              <h2 id="projects-finished" className="mb-2 text-sm font-semibold text-muted">
                {archived ? "Finished" : "Done and dropped"}
              </h2>
              <Card asChild tone="plain" divided className="overflow-hidden">
                <ul>
                  {finished.map((project) => (
                    <li key={project.id}>
                      <Link
                        to={projectPath(workspace, project.slug)}
                        prefetch="intent"
                        className="flex min-w-0 items-center gap-3 px-4 py-3 transition-colors hover:bg-surface"
                      >
                        <ProjectMark project={project} size={22} />
                        <span className="min-w-0 grow truncate text-sm font-medium">{project.name}</span>
                        <span className="hidden text-xs text-faint tabular-nums sm:inline">
                          {project.closedItems}/{project.openItems + project.closedItems} done
                        </span>
                        <StateBadge project={project} />
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          )}
        </>
      )}
      {!archived && projects.length > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-faint">
          <Archive size={12} />
          <span>
            Archived projects are under{" "}
            <Link to={projectsPath(workspace, "archived=1")} className="text-muted hover:text-fg">
              Archived
            </Link>
            .
          </span>
        </p>
      )}
    </div>
  );
}

/** One live project: its mark and name, state and health, summary, progress, lead and what is left of its time. */
function ProjectCard({ project, workspace, today }: { project: WorkProject; workspace: string; today: Date }) {
  const percent = percentDone(project);
  const total = project.openItems + project.closedItems;
  const left = timeLeft(project, today);
  const dates = datesText(project, today);
  return (
    <li className="min-w-0">
      <Card asChild className="group flex h-full flex-col gap-3 p-4 transition-colors hover:border-line-strong">
        <Link to={projectPath(workspace, project.slug)} prefetch="intent">
          <div className="flex min-w-0 items-start gap-3">
            <ProjectMark project={project} size={36} className="rounded-lg" />
            <div className="min-w-0 grow">
              <div className="flex min-w-0 items-center gap-2">
                <h3 className="truncate text-[0.9375rem] font-semibold group-hover:text-accent">{project.name}</h3>
                <Hint label={project.health ? HEALTH_LABELS[project.health] : "No health yet"}>
                  <span className="inline-flex" aria-label={project.health ? HEALTH_LABELS[project.health] : "No health yet"}>
                    <HealthDot health={project.health} />
                  </span>
                </Hint>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <StateBadge project={project} />
                {project.health && <span className="text-xs text-muted">{HEALTH_LABELS[project.health]}</span>}
              </div>
            </div>
          </div>
          <p className={cn("line-clamp-2 min-h-10 text-sm", project.summary ? "text-muted" : "text-faint")}>{project.summary || "No summary yet."}</p>
          <div className="mt-auto space-y-1.5">
            <div className="flex items-baseline justify-between text-xs">
              <span className="text-muted">
                <span className="font-medium text-fg tabular-nums">{percent}%</span> done
              </span>
              <span className="text-faint tabular-nums">
                {project.closedItems}/{total} work items
              </span>
            </div>
            <span
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-label={`${percent}% of its work items done`}
              className="block h-1.5 overflow-hidden rounded-full bg-line"
            >
              <span className="block h-full rounded-full transition-[width]" style={{ width: `${percent}%`, backgroundColor: `#${project.color}` }} />
            </span>
          </div>
          <div className="flex min-w-0 items-center justify-between gap-2 border-t border-line pt-3 text-xs text-muted">
            {project.lead ? (
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <Avatar name={project.lead} size={18} />
                <span className="truncate">{project.lead}</span>
              </span>
            ) : (
              <span className="text-faint">No lead</span>
            )}
            {(left || dates) && (
              <span className={cn("inline-flex shrink-0 items-center gap-1", left?.late ? "text-danger" : "text-muted")}>
                <CalendarClock size={12} />
                {left?.text ?? dates}
              </span>
            )}
          </div>
        </Link>
      </Card>
    </li>
  );
}
