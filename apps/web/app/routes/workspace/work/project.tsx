import { ArrowRight, FileText, Flag, GitBranch, Pencil, Plus, Target, Users, X } from "lucide-react";
import { useState } from "react";
import { Link, useFetcher } from "react-router";

import type { Horizon, Milestone, ProjectMember, ProjectRepo, WorkItem } from "@g1t/contracts";

import type { Route } from "./+types/project";
import { MilestoneBar } from "../../../components/labels";
import { Markdown } from "../../../components/markdown";
import { PlanRow } from "../../../components/plan";
import { BriefForm, ProjectHeader, ProjectHill } from "../../../components/projects";
import { ButtonLink, SubmitButton } from "../../../components/ui";
import { Avatar } from "../../../components/ui/avatar";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { Hint } from "../../../components/ui/hint";
import { Input } from "../../../components/ui/input";
import { SelectField } from "../../../components/ui/select";
import { cn } from "../../../lib/cn";
import { page } from "../../../lib/meta";
import { isFailed, part } from "../../../lib/partial";
import { progressOf } from "../../../lib/plan";
import { type ProjectResult, nowItems, peopleText, percentDone, projectPath, timeElapsed } from "../../../lib/projects";
import { loadProject, projectAction } from "../../../lib/projects.server";
import { workPages } from "../../../lib/repo-live";
import { getViewer } from "../../../lib/session.server";
import { useWorkspaceLive } from "../../../lib/use-repo-live";
import { HORIZON_LABELS, newItemPath, shortPath, workPath } from "../../../lib/work-items";
import { workspaceProjects } from "../../../lib/workspace-projects.server";

export function meta({ params, loaderData, ...args }: Route.MetaArgs) {
  return page(args, { title: `${loaderData?.project.name ?? params.slug} · Projects · ${params.owner} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const loaded = await loadProject({ params, context });
  const viewer = getViewer(context);
  // The repositories that can be added, for whoever may add them: only a suggestion list.
  const repos = loaded.canEdit ? await part(workspaceProjects(loaded.workspace, viewer), "Repositories") : null;
  return {
    ...loaded,
    repoChoices:
      repos == null || isFailed(repos) || !repos.ok
        ? []
        : repos.value
            .filter((p) => p.workspace.toLowerCase() === loaded.workspace)
            .map((p) => p.slug)
            .sort(),
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  return projectAction(request, params, context);
}

/**
 * A project's home: its brief, the work items of it in Now (in the plan's
 * order, each with where it is on its hill), its progress (every open item
 * on one hill, how much is done, and how far through its dates it is), its
 * milestones, and its people and repositories. Everything about how it is
 * going is read from the record; only the brief and the health are
 * written by hand.
 */
export default function ProjectPage({ loaderData }: Route.ComponentProps) {
  const { workspace, detail, project, canEdit, canOpen, members, member } = loaderData;
  const today = new Date(loaderData.today);
  useWorkspaceLive({ workspace, member, match: workPages.list() });
  const now = nowItems(detail.open);
  // Now in the project, for J and K on each item's page.
  const trail = { numbers: now.map((item) => item.number), label: project.name, href: projectPath(workspace, project.slug) };
  const progress = progressOf(detail.progress);
  const rest = horizonCounts(detail.open.filter((item) => item.horizon !== "now"));
  return (
    <div>
      <ProjectHeader project={project} workspace={workspace} tab="overview" canEdit={canEdit} canOpen={canOpen} members={members} today={today} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <div className="grid min-w-0 content-start gap-4">
          <BriefCard brief={project.brief} canEdit={canEdit && project.archivedAt == null} workspace={workspace} />
          <Card asChild className="min-w-0">
            <section aria-labelledby="project-now">
              <header className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 pt-3 pb-2">
                <h2 id="project-now" className="text-sm font-semibold">
                  Now in this project
                </h2>
                <span className="text-xs text-faint">in the plan&apos;s order</span>
                <span className="ml-auto font-mono text-xs tabular-nums text-faint">{now.length}</span>
              </header>
              {now.length === 0 ? (
                <p className="mx-4 mb-3 rounded-lg border border-dashed border-line px-3 py-4 text-center text-xs text-faint">
                  {detail.open.length === 0
                    ? "No open work items yet. File one into the project to start."
                    : "Nothing of this project is in Now. Move what it takes on next into Now from the plan."}
                </p>
              ) : (
                <ol className="px-2 pb-1">
                  {now.map((item, index) => (
                    <PlanRow
                      key={item.id}
                      item={item}
                      rank={index + 1}
                      workspace={workspace}
                      on={undefined}
                      waiting={[]}
                      progress={progress[item.number]}
                      trail={trail}
                    />
                  ))}
                </ol>
              )}
              <footer className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line px-4 py-2.5 text-xs text-muted">
                {rest.length > 0 && (
                  <span className="min-w-0">
                    Also open:{" "}
                    {rest.map(([horizon, count], index) => (
                      <span key={horizon}>
                        {index > 0 && ", "}
                        <span className="text-fg tabular-nums">{count}</span> in {HORIZON_LABELS[horizon]}
                      </span>
                    ))}
                  </span>
                )}
                <Link to={projectPath(workspace, project.slug, "items")} className="ml-auto inline-flex items-center gap-1 text-fg hover:text-accent">
                  View all items
                  <ArrowRight size={13} />
                </Link>
              </footer>
            </section>
          </Card>
        </div>

        <div className="grid min-w-0 content-start gap-4">
          <ProgressCard detail={detail} workspace={workspace} today={today} />
          {detail.milestones.length > 0 && <MilestonesCard milestones={detail.milestones} workspace={workspace} />}
          <PeopleCard members={detail.members} canEdit={canEdit} choices={members} />
          <ReposCard repos={detail.repos} workspace={workspace} canEdit={canEdit} choices={loaderData.repoChoices} />
          {canOpen && project.archivedAt == null && (
            <ButtonLink to={newItemPath(workspace, null, null, project.slug)} variant="outline" className="w-full border-dashed max-sm:h-10">
              <Plus size={15} />
              New work item in {project.name}
            </ButtonLink>
          )}
        </div>
      </div>
    </div>
  );
}

/** How many open work items are on each horizon but Now, in the plan's order of horizons. */
function horizonCounts(items: readonly WorkItem[]): [Horizon, number][] {
  const order: Horizon[] = ["next", "later", "triage", "set_aside"];
  return order.map((horizon) => [horizon, items.filter((item) => item.horizon === horizon).length] as [Horizon, number]).filter(([, count]) => count > 0);
}

/** The brief: the pitch, in Markdown, with Edit brief for whoever may change it. */
function BriefCard({ brief, canEdit, workspace }: { brief: string; canEdit: boolean; workspace: string }) {
  const [editing, setEditing] = useState(false);
  return (
    <Card asChild className="min-w-0">
      <section aria-labelledby="project-brief">
        <header className="flex items-center gap-2 px-4 pt-3 pb-2">
          <FileText size={14} className="text-faint" />
          <h2 id="project-brief" className="text-sm font-semibold">
            Brief
          </h2>
          {canEdit && !editing && (
            <Button type="button" variant="ghost" size="xs" onClick={() => setEditing(true)} className="ml-auto max-sm:h-9">
              <Pencil size={13} />
              Edit brief
            </Button>
          )}
        </header>
        <div className="px-4 pb-4">
          {editing ? (
            <BriefForm brief={brief} onDone={() => setEditing(false)} />
          ) : brief.trim() ? (
            <div className="max-h-128 overflow-y-auto text-sm">
              <Markdown source={brief} workspace={workspace} />
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-line px-4 py-6 text-center">
              <p className="text-sm text-muted">No brief yet.</p>
              <p className="mt-1 text-xs text-faint">
                The pitch: the problem, how much it is worth, the solution, the rabbit holes and what is out. People and agents work from it.
              </p>
              {canEdit && (
                <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)} className="mt-3">
                  <Pencil size={13} />
                  Write the brief
                </Button>
              )}
            </div>
          )}
        </div>
      </section>
    </Card>
  );
}

/**
 * How the project is going, read from the record: how many of its work
 * items are done, against how far through its dates it is, and every open
 * one on the hill.
 */
function ProgressCard({ detail, workspace, today }: { detail: Route.ComponentProps["loaderData"]["detail"]; workspace: string; today: Date }) {
  const { project } = detail;
  const percent = percentDone(project);
  const total = project.openItems + project.closedItems;
  const elapsed = timeElapsed(project, today);
  const behind = elapsed != null && total > 0 && elapsed - percent >= 25;
  return (
    <Card asChild className="min-w-0">
      <section aria-labelledby="project-progress">
        <header className="flex items-center gap-2 px-4 pt-3 pb-1">
          <Target size={14} className="text-faint" />
          <h2 id="project-progress" className="text-sm font-semibold">
            Progress
          </h2>
          <span className="ml-auto text-xs text-faint">read from the record</span>
        </header>
        <div className="px-4 pb-4">
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-semibold tracking-tight tabular-nums">{percent}%</span>
            <span className="text-sm text-muted">
              <span className="text-fg tabular-nums">{project.closedItems}</span> of <span className="tabular-nums">{total}</span> work items done
            </span>
          </div>
          <span
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label={`${percent}% of its work items done`}
            className="mt-2 block h-2 overflow-hidden rounded-full bg-line"
          >
            <span className="block h-full rounded-full transition-[width]" style={{ width: `${percent}%`, backgroundColor: `#${project.color}` }} />
          </span>
          {elapsed != null && (
            <p className={cn("mt-2 text-xs", behind ? "text-warn" : "text-faint")}>
              {elapsed}% of its time has gone{behind ? ", ahead of the work done" : ""}.
            </p>
          )}
          <div className="mt-4 border-t border-line pt-3">
            {detail.open.length === 0 ? (
              <p className="py-4 text-center text-xs text-faint">Nothing open to put on the hill.</p>
            ) : (
              <ProjectHill open={detail.open} progress={detail.progress} workspace={workspace} />
            )}
          </div>
        </div>
      </section>
    </Card>
  );
}

/** The workspace milestones the project's work items are in, each counting only its own. */
function MilestonesCard({ milestones, workspace }: { milestones: Milestone[]; workspace: string }) {
  return (
    <Card asChild className="min-w-0">
      <section aria-labelledby="project-milestones">
        <header className="flex items-center gap-2 px-4 pt-3 pb-2">
          <Flag size={14} className="text-faint" />
          <h2 id="project-milestones" className="text-sm font-semibold">
            Milestones
          </h2>
        </header>
        <ul className="grid gap-3 px-4 pb-4">
          {milestones.map((milestone) => (
            <li key={milestone.number}>
              <Link to={workPath(workspace, `milestones/${milestone.number}`)} className="group block">
                <span className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate group-hover:text-accent">
                    {milestone.state === "closed" && <span className="mr-1 text-success">✓</span>}
                    {milestone.title}
                  </span>
                  <span className="shrink-0 text-xs text-faint tabular-nums">
                    {milestone.closedItems}/{milestone.openItems + milestone.closedItems}
                    {milestone.dueOn && ` · ${milestone.dueOn}`}
                  </span>
                </span>
                <MilestoneBar milestone={milestone} className="mt-1.5 h-1.5" />
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </Card>
  );
}

/** Who is in the project, its lead first; whoever may change it adds and takes people out here. */
function PeopleCard({ members, canEdit, choices }: { members: ProjectMember[]; canEdit: boolean; choices: readonly string[] }) {
  const fetcher = useFetcher<ProjectResult>();
  const [adding, setAdding] = useState(false);
  const inIt = new Set(members.map((member) => member.username));
  const others = choices.filter((name) => !inIt.has(name));
  const error = fetcher.state === "idle" && fetcher.data?.error;
  return (
    <Card asChild className="min-w-0">
      <section aria-labelledby="project-people">
        <header className="flex items-center gap-2 px-4 pt-3 pb-2">
          <Users size={14} className="text-faint" />
          <h2 id="project-people" className="text-sm font-semibold">
            People
          </h2>
          <span className="text-xs text-faint">{peopleText(members.length)}</span>
          {canEdit && !adding && (
            <Button type="button" variant="ghost" size="xs" onClick={() => setAdding(true)} className="ml-auto max-sm:h-9">
              <Plus size={13} />
              Add
            </Button>
          )}
        </header>
        {members.length === 0 ? (
          <p className="px-4 pb-3 text-xs text-faint">Nobody yet.</p>
        ) : (
          <ul className="px-2 pb-2">
            {members.map((member) => (
              <li key={member.userId} className="group flex min-h-9 items-center gap-2 rounded-md px-2 py-1 hover:bg-raised/60">
                <Avatar name={member.username} size={22} />
                <span className="min-w-0 grow truncate text-sm">{member.username}</span>
                {member.role === "lead" && <Badge tone="accent">Lead</Badge>}
                {canEdit && (
                  <Hint label={`Take ${member.username} out of the project`}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Take ${member.username} out of the project`}
                      onClick={() => fetcher.submit({ intent: "remove-member", username: member.username }, { method: "post" })}
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-sm:opacity-100"
                    >
                      <X size={13} />
                    </Button>
                  </Hint>
                )}
              </li>
            ))}
          </ul>
        )}
        {canEdit && adding && (
          <fetcher.Form method="post" className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3" onSubmit={() => setAdding(false)}>
            <input type="hidden" name="intent" value="add-member" />
            <div className="min-w-40 grow">
              {others.length > 0 ? (
                <SelectField name="username" aria-label="Who" placeholder="Choose someone" options={others.map((name) => ({ value: name, label: name }))} />
              ) : (
                <Input name="username" aria-label="Username" placeholder="Username" autoComplete="off" autoCapitalize="none" required />
              )}
            </div>
            <SubmitButton fetcher={fetcher} size="sm" pending="Adding…" className="max-sm:h-10">
              Add
            </SubmitButton>
            <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)} className="max-sm:h-10">
              Cancel
            </Button>
          </fetcher.Form>
        )}
        {error && <p className="px-4 pb-3 text-xs text-danger">{error}</p>}
      </section>
    </Card>
  );
}

/** The repositories the project's work lands in; a default target is linked to each new work item filed into it. */
function ReposCard({ repos, workspace, canEdit, choices }: { repos: ProjectRepo[]; workspace: string; canEdit: boolean; choices: readonly string[] }) {
  const fetcher = useFetcher<ProjectResult>();
  const [adding, setAdding] = useState(false);
  const named = new Set(repos.map((repo) => shortPath(repo.path, workspace)));
  const others = choices.filter((name) => !named.has(name));
  const error = fetcher.state === "idle" && fetcher.data?.error;
  return (
    <Card asChild className="min-w-0">
      <section aria-labelledby="project-repos">
        <header className="flex items-center gap-2 px-4 pt-3 pb-2">
          <GitBranch size={14} className="text-faint" />
          <h2 id="project-repos" className="text-sm font-semibold">
            Repositories
          </h2>
          {canEdit && !adding && others.length > 0 && (
            <Button type="button" variant="ghost" size="xs" onClick={() => setAdding(true)} className="ml-auto max-sm:h-9">
              <Plus size={13} />
              Add
            </Button>
          )}
        </header>
        {repos.length === 0 ? (
          <p className="px-4 pb-3 text-xs text-faint">None named yet. Name the repositories its work lands in, and new work items in it target them.</p>
        ) : (
          <ul className="px-2 pb-2">
            {repos.map((repo) => (
              <li key={repo.repoId} className="group flex min-h-9 items-center gap-2 rounded-md px-2 py-1 hover:bg-raised/60">
                <Link to={`/${repo.path}`} className="min-w-0 grow truncate font-mono text-[0.8125rem] hover:text-accent">
                  {shortPath(repo.path, workspace)}
                </Link>
                {repo.defaultTarget && (
                  <Hint label="Linked as a target to each work item filed into the project">
                    <Badge>Default target</Badge>
                  </Hint>
                )}
                {canEdit && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Take ${repo.path} off the project`}
                    onClick={() => fetcher.submit({ intent: "remove-repo", repo: repo.path }, { method: "post" })}
                    className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-sm:opacity-100"
                  >
                    <X size={13} />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canEdit && adding && (
          <fetcher.Form method="post" className="grid gap-2 border-t border-line px-4 py-3" onSubmit={() => setAdding(false)}>
            <input type="hidden" name="intent" value="add-repo" />
            <SelectField name="repo" aria-label="Repository" placeholder="Choose a repository" options={others.map((name) => ({ value: name, label: name }))} />
            <SelectField
              name="defaultTarget"
              aria-label="Whether new work items target it"
              defaultValue="1"
              options={[
                { value: "1", label: "New work items in the project target it" },
                { value: "0", label: "Named only" },
              ]}
            />
            <div className="flex gap-2">
              <SubmitButton fetcher={fetcher} size="sm" pending="Adding…" className="max-sm:h-10">
                Add
              </SubmitButton>
              <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)} className="max-sm:h-10">
                Cancel
              </Button>
            </div>
          </fetcher.Form>
        )}
        {error && <p className="px-4 pb-3 text-xs text-danger">{error}</p>}
      </section>
    </Card>
  );
}
