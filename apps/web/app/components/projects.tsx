import { Archive, ArchiveRestore, CalendarClock, Check, ChevronDown, FolderKanban, MoreHorizontal, Pencil, Plus, Settings2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Form, Link, useActionData, useFetcher, useNavigate } from "react-router";

import { type Hill, type Progress, type ProjectHealth, type WorkItem, type WorkProject, type WorkProjectRef, hillLabel } from "@g1t/contracts";

import { cn } from "../lib/cn";
import { HILL_STEPS } from "../lib/plan";
import {
  HEALTHS,
  HEALTH_LABELS,
  PROJECT_COLORS,
  PROJECT_STATE_ORDER,
  STATE_HINTS,
  STATE_LABELS,
  type ProjectResult,
  datesText,
  hillCounts,
  hillDots,
  hillY,
  healthTone,
  isLive,
  projectPath,
  projectsPath,
  stateTone,
  timeLeft,
} from "../lib/projects";
import { itemPath, newItemPath } from "../lib/work-items";
import { ButtonLink, ErrorText, SubmitButton, usePending } from "./ui";
import { Avatar } from "./ui/avatar";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "./ui/command";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Hint } from "./ui/hint";
import { Input } from "./ui/input";
import { NavTab, NavTabs } from "./ui/nav-tabs";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { SelectField } from "./ui/select";
import { Textarea } from "./ui/textarea";

/** A project's own mark: its emoji, or its first letter, on its color. */
export function ProjectMark({
  project,
  size = 20,
  className,
}: {
  project: Pick<WorkProjectRef, "name" | "color" | "icon">;
  size?: number;
  className?: string;
}) {
  const color = `#${project.color}`;
  return (
    <span
      aria-hidden
      className={cn("inline-flex shrink-0 items-center justify-center rounded-md font-semibold leading-none select-none", className)}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * (project.icon ? 0.62 : 0.5)),
        backgroundColor: `color-mix(in oklab, ${color} 18%, transparent)`,
        color,
        boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${color} 35%, transparent)`,
      }}
    >
      {project.icon || project.name.trim().charAt(0).toUpperCase() || "·"}
    </span>
  );
}

/** A project's health as a small dot: green on track, amber at risk, red off track, hollow when nobody has said. */
export function HealthDot({ health, className }: { health: ProjectHealth | null; className?: string }) {
  const tone = healthTone(health);
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        tone === "success" && "bg-success",
        tone === "warn" && "bg-warn",
        tone === "danger" && "bg-danger",
        tone === "neutral" && "ring-1 ring-line-strong ring-inset",
        className,
      )}
    />
  );
}

export function HealthBadge({ health }: { health: ProjectHealth | null }) {
  return (
    <Badge tone={healthTone(health)} size="md">
      <HealthDot health={health} />
      {health ? HEALTH_LABELS[health] : "No health yet"}
    </Badge>
  );
}

export function StateBadge({ project }: { project: Pick<WorkProject, "state" | "archivedAt"> }) {
  if (project.archivedAt) return <Badge size="md">Archived</Badge>;
  return (
    <Hint label={STATE_HINTS[project.state]}>
      <Badge tone={stateTone(project.state)} size="md">
        {STATE_LABELS[project.state]}
      </Badge>
    </Hint>
  );
}

/**
 * A project's health, as a menu for whoever may change it: On track, At
 * risk, Off track, or not said. Saved as soon as it is chosen, shown at
 * once while it is on its way.
 */
export function HealthMenu({ health, canEdit }: { health: ProjectHealth | null; canEdit: boolean }) {
  const fetcher = useFetcher<ProjectResult>();
  const pending = fetcher.formData?.get("intent") === "health" ? String(fetcher.formData.get("health") ?? "") : null;
  const shown: ProjectHealth | null = pending == null ? health : (HEALTHS.find((one) => one === pending) ?? null);
  const error = fetcher.state === "idle" && fetcher.data?.intent === "health" ? fetcher.data.error : undefined;
  if (!canEdit) return <HealthBadge health={health} />;
  const choose = (value: ProjectHealth | null) => fetcher.submit({ intent: "health", health: value ?? "" }, { method: "post" });
  return (
    <span className="inline-flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Health: ${shown ? HEALTH_LABELS[shown] : "not said"}. Change it`}
            className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Badge tone={healthTone(shown)} size="md" className="cursor-pointer hover:brightness-110">
              <HealthDot health={shown} />
              {shown ? HEALTH_LABELS[shown] : "Set health"}
              <ChevronDown size={12} className="-mr-0.5 opacity-70" />
            </Badge>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          <DropdownMenuLabel>How is it going?</DropdownMenuLabel>
          {HEALTHS.map((value) => (
            <DropdownMenuItem key={value} onSelect={() => choose(value)}>
              <HealthDot health={value} />
              <span className="grow">{HEALTH_LABELS[value]}</span>
              {shown === value && <Check size={14} className="text-accent" />}
            </DropdownMenuItem>
          ))}
          {shown && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => choose(null)}>
                <X size={14} />
                Clear health
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {error && <span className="text-xs text-danger">{error}</span>}
    </span>
  );
}

/** The hill as a path, drawn from the same curve the dots sit on (lib/projects.ts `hillY`). */
const HILL_POINTS = Array.from({ length: 75 }, (_, index) => {
  const x = 12 + index * 4;
  return `${x} ${Math.round(hillY(x) * 10) / 10}`;
});
const HILL_LINE = `M${HILL_POINTS.join(" L")}`;
/** Its first half, where the work is still being figured out, closed down to the ground. */
const HILL_FIRST_HALF = `M${HILL_POINTS.slice(0, 38).join(" L")} L160 104 Z`;

/**
 * A project's hill: every open work item as a dot on one curve, placed by
 * where its record says it is (figuring it out up the left side, decided at
 * the top, building and landing down the right), never dragged. Each dot is
 * a link to its item, named for it; under the hill, how many are at each
 * stage.
 */
export function ProjectHill({ open, progress, workspace }: { open: readonly WorkItem[]; progress: readonly Progress[]; workspace: string }) {
  const dots = hillDots(open, progress);
  const counts = hillCounts(dots);
  const [hover, setHover] = useState<number | null>(null);
  const hovered = dots.find((dot) => dot.item.number === hover);
  return (
    <figure className="min-w-0">
      <div className="relative">
        <svg viewBox="0 0 320 120" className="h-auto w-full overflow-visible" role="group" aria-label="Where each open work item is on the hill">
          {/* The two halves: working out what to do, then doing it. */}
          <path d={HILL_FIRST_HALF} className="fill-accent/5" />
          <line x1="160" y1="12" x2="160" y2="108" className="stroke-line" strokeDasharray="2 3" />
          <path d={HILL_LINE} fill="none" className="stroke-line-strong" strokeWidth="1.5" strokeLinejoin="round" />
          <line x1="8" y1="104.5" x2="312" y2="104.5" className="stroke-line" />
          {dots.map((dot) => (
            <Link
              key={dot.item.id}
              to={itemPath(workspace, dot.item.number)}
              prefetch="intent"
              aria-label={`#${dot.item.number} ${dot.item.title}: ${hillLabel(dot.hill)}`}
              onMouseEnter={() => setHover(dot.item.number)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(dot.item.number)}
              onBlur={() => setHover(null)}
              className="outline-none"
            >
              <circle cx={dot.x} cy={dot.y} r={hover === dot.item.number ? 7 : 5.5} className="fill-accent stroke-surface transition-[r]" strokeWidth="2" />
            </Link>
          ))}
        </svg>
        {hovered && (
          <div
            className="pointer-events-none absolute z-10 max-w-56 -translate-x-1/2 -translate-y-full rounded-md border border-line-strong bg-raised px-2 py-1 text-xs shadow-lg"
            style={{ left: `${(hovered.x / 320) * 100}%`, top: `${(hovered.y / 120) * 100 - 6}%` }}
          >
            <span className="mr-1 font-mono text-faint">#{hovered.item.number}</span>
            <span className="line-clamp-2">{hovered.item.title}</span>
          </div>
        )}
      </div>
      <figcaption className="mt-1 grid grid-cols-4 gap-1 text-center">
        {HILL_STEPS.map((stage: Hill, step) => (
          <span key={stage} className="min-w-0" style={{ gridColumn: step + 1 }}>
            <span className="block truncate text-[0.6875rem] text-faint">{hillLabel(stage)}</span>
            <span className={cn("block font-mono text-sm tabular-nums", counts[stage] > 0 ? "text-fg" : "text-faint")}>{counts[stage]}</span>
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

/**
 * The work item page's Project: the project it is in, and for whoever may
 * triage it, a menu to put it in another (live ones) or take it out. It
 * posts `action=project` with the project's slug ("" for none).
 */
export function ProjectBox({
  projects,
  current,
  canEdit,
  workspace,
}: {
  projects: WorkProject[];
  current: WorkProjectRef | null | undefined;
  canEdit: boolean;
  workspace: string;
}) {
  const fetcher = useFetcher<{ error?: string } | null>();
  const [open, setOpen] = useState(false);
  const choose = (slug: string) => {
    setOpen(false);
    if (slug === (current?.slug ?? "")) return;
    fetcher.submit({ action: "project", project: slug }, { method: "post" });
  };
  const pending = fetcher.state !== "idle" ? String(fetcher.formData?.get("project") ?? "") : null;
  const shownSlug = pending ?? current?.slug ?? "";
  const shown: Pick<WorkProjectRef, "slug" | "name" | "color" | "icon"> | undefined =
    projects.find((project) => project.slug === shownSlug) ?? (current && current.slug === shownSlug ? current : undefined);
  const choices = projects.filter(isLive);
  const error = fetcher.state === "idle" ? fetcher.data?.error : undefined;
  return (
    <section>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Project</h3>
        {canEdit && (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button type="button" aria-label="Choose a project" variant="ghost" size="inline" className="p-1 text-faint">
                <Settings2 size={15} />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 p-0">
              <Command>
                <CommandInput placeholder="Find a project" />
                <CommandList>
                  <CommandEmpty>No project matches.</CommandEmpty>
                  {current && (
                    <CommandGroup>
                      <CommandItem value="none" onSelect={() => choose("")}>
                        <X />
                        Take it out of {current.name}
                      </CommandItem>
                    </CommandGroup>
                  )}
                  <CommandGroup heading="Projects">
                    {choices.map((project) => (
                      <CommandItem key={project.id} value={`${project.name} ${project.slug}`} onSelect={() => choose(project.slug)}>
                        <ProjectMark project={project} size={18} />
                        <span className="min-w-0 grow truncate">{project.name}</span>
                        {project.slug === current?.slug && <Check className="text-accent" />}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
              <Link to={projectsPath(workspace)} className="flex items-center gap-2 border-t border-line px-3 py-2 text-xs text-muted hover:text-fg">
                <FolderKanban size={13} />
                All projects
              </Link>
            </PopoverContent>
          </Popover>
        )}
      </div>
      <div className="mt-2">
        {shown ? (
          <Link to={projectPath(workspace, shown.slug)} className="group flex min-w-0 items-center gap-2 text-sm">
            <ProjectMark project={shown} size={20} />
            <span className="truncate group-hover:text-accent">{shown.name}</span>
          </Link>
        ) : (
          <p className="text-sm text-faint">None yet</p>
        )}
        {error && <p className="mt-1 text-xs text-danger">{error}</p>}
      </div>
    </section>
  );
}

/** The fields a project's create and edit forms share. */
function ProjectFields({ project, members }: { project?: WorkProject; members?: readonly string[] }) {
  const [color, setColor] = useState(project?.color ?? PROJECT_COLORS[0]!);
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-end gap-3">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Icon</span>
          <Input
            name="icon"
            defaultValue={project?.icon ?? ""}
            maxLength={8}
            placeholder="🧭"
            aria-label="Icon (an emoji)"
            className="w-14 text-center text-base"
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Name</span>
          <Input
            name="name"
            defaultValue={project?.name ?? ""}
            required
            maxLength={80}
            autoFocus
            autoComplete="off"
            data-1p-ignore
            placeholder="Work overhaul"
          />
        </label>
      </div>
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-muted">Summary</span>
        <Input name="summary" defaultValue={project?.summary ?? ""} maxLength={200} placeholder="What it is for, in a line" autoComplete="off" />
      </label>
      <fieldset>
        <legend className="mb-1.5 block text-xs font-medium text-muted">Color</legend>
        <input type="hidden" name="color" value={color} />
        <div className="flex flex-wrap gap-2">
          {PROJECT_COLORS.map((value) => (
            <button
              key={value}
              type="button"
              aria-label={`Color ${value}`}
              aria-pressed={color === value}
              onClick={() => setColor(value)}
              className={cn(
                "size-7 rounded-full outline-none ring-offset-2 ring-offset-surface transition-shadow focus-visible:ring-2 focus-visible:ring-accent max-sm:size-9",
                color === value && "ring-2 ring-fg/70",
              )}
              style={{ backgroundColor: `#${value}` }}
            />
          ))}
        </div>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">State</span>
          <SelectField
            name="state"
            defaultValue={project?.state ?? "active"}
            options={PROJECT_STATE_ORDER.map((state) => ({ value: state, label: STATE_LABELS[state] }))}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Lead</span>
          {members && members.length > 0 ? (
            <SelectField
              name="lead"
              defaultValue={project?.lead ?? ""}
              options={[{ value: "", label: project ? "Nobody" : "You" }, ...members.map((name) => ({ value: name, label: name }))]}
            />
          ) : (
            <Input name="lead" defaultValue={project?.lead ?? ""} placeholder={project ? "Nobody" : "You"} autoComplete="off" autoCapitalize="none" />
          )}
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Starts</span>
          <Input type="date" name="startOn" defaultValue={project?.startOn ?? ""} />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Target</span>
          <Input type="date" name="targetOn" defaultValue={project?.targetOn ?? ""} />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Appetite</span>
          <SelectField
            name="appetite"
            defaultValue={project?.appetite ?? ""}
            options={[
              { value: "", label: "Not said" },
              { value: "small", label: "Small: a few sessions" },
              { value: "medium", label: "Medium: a week or two" },
              { value: "large", label: "Large: a cycle or more" },
            ]}
          />
        </label>
      </div>
    </div>
  );
}

/**
 * Making a project: a dialog with its name, summary, color, state, lead,
 * dates and appetite. It posts `intent=create` to the projects page, and
 * goes to the new project's home once it is made.
 */
export function NewProjectDialog({
  workspace,
  open,
  onOpenChange,
  members,
}: {
  workspace: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  members?: readonly string[];
}) {
  const fetcher = useFetcher<ProjectResult>();
  const navigate = useNavigate();
  const made = fetcher.state === "idle" && fetcher.data?.intent === "create" && !fetcher.data.error ? fetcher.data.slug : undefined;
  useEffect(() => {
    if (made) {
      onOpenChange(false);
      navigate(projectPath(workspace, made));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [made]);
  const error = fetcher.state === "idle" && fetcher.data?.intent === "create" ? fetcher.data.error : undefined;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>A home for a body of work: its brief, its people, its work items and how it is going.</DialogDescription>
        </DialogHeader>
        <fetcher.Form method="post" action={projectsPath(workspace)} className="grid gap-5">
          <input type="hidden" name="intent" value="create" />
          <ProjectFields members={members} />
          {error && <ErrorText>{error}</ErrorText>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <SubmitButton fetcher={fetcher} pending="Creating…">
              <Plus size={15} />
              Create project
            </SubmitButton>
          </DialogFooter>
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}

/** Changing a project's name, summary, color, state, lead, dates and appetite, in a dialog. */
export function EditProjectDialog({
  project,
  members,
  open,
  onOpenChange,
}: {
  project: WorkProject;
  members: readonly string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const result = useActionData<ProjectResult>();
  const pending = usePending({ intent: "update" });
  const sent = useRef(false);
  const mine = result?.intent === "update";
  useEffect(() => {
    if (sent.current && !pending && mine && !result?.error) onOpenChange(false);
    sent.current = pending;
  }, [mine, result, pending, onOpenChange]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {project.name}</DialogTitle>
          <DialogDescription>Its name, color, state, lead, dates and appetite.</DialogDescription>
        </DialogHeader>
        <Form method="post" className="grid gap-5">
          <input type="hidden" name="intent" value="update" />
          <ProjectFields project={project} members={members} />
          {mine && result?.error && <ErrorText>{result.error}</ErrorText>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <SubmitButton match={{ intent: "update" }} pending="Saving…">
              Save project
            </SubmitButton>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A project's header, over each of its tabs: its mark and name, its state,
 * lead, dates and health (a menu for whoever may change it), New work item
 * in it, Edit and the archive; then its tabs, Overview and Items.
 */
export function ProjectHeader({
  project,
  workspace,
  tab,
  canEdit,
  canOpen,
  members,
  today,
}: {
  project: WorkProject;
  workspace: string;
  tab: "overview" | "items";
  canEdit: boolean;
  /** Whether the viewer may file a work item here. */
  canOpen: boolean;
  /** The workspace's people, for its lead. */
  members: readonly string[];
  today: Date;
}) {
  const [editing, setEditing] = useState(false);
  const archive = useFetcher<ProjectResult>();
  const dates = datesText(project, today);
  const left = timeLeft(project, today);
  const archived = project.archivedAt != null;
  const archiveError = archive.state === "idle" && archive.data?.error;
  return (
    <header className="mb-6">
      <nav aria-label="Breadcrumb" className="mb-3 text-xs text-muted">
        <Link to={projectsPath(workspace)} className="inline-flex items-center gap-1 hover:text-fg">
          <FolderKanban size={12} />
          Projects
        </Link>
      </nav>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <ProjectMark project={project} size={44} className="rounded-xl" />
        <div className="min-w-0 grow basis-64">
          <h1 className="text-2xl font-semibold tracking-tight wrap-break-word">{project.name}</h1>
          {project.summary && <p className="mt-0.5 text-sm text-muted">{project.summary}</p>}
          <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted">
            <StateBadge project={project} />
            <span className="inline-flex items-center gap-1.5">
              {project.lead ? (
                <>
                  <Avatar name={project.lead} size={18} />
                  <span>
                    <span className="text-faint">Lead</span> <span className="text-fg">{project.lead}</span>
                  </span>
                </>
              ) : (
                <span className="text-faint">No lead</span>
              )}
            </span>
            {dates && (
              <span className="inline-flex items-center gap-1.5">
                <CalendarClock size={14} className="text-faint" />
                {dates}
                {left && <span className={cn("text-xs", left.late ? "text-danger" : "text-faint")}>· {left.text}</span>}
              </span>
            )}
            {project.appetite && <span className="text-faint">Appetite {project.appetite}</span>}
            <HealthMenu health={project.health} canEdit={canEdit && !archived} />
          </div>
        </div>
        <div className="flex items-center gap-2 max-sm:w-full max-sm:*:grow">
          {canOpen && !archived && (
            <ButtonLink to={newItemPath(workspace, null, null, project.slug)} className="max-sm:h-10">
              <Plus size={15} />
              New work item
            </ButtonLink>
          )}
          {canEdit && (
            <>
              <Button type="button" variant="outline" onClick={() => setEditing(true)} className="max-sm:h-10">
                <Pencil size={14} />
                Edit
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="outline" size="icon" aria-label="More" className="max-sm:size-10 max-sm:grow-0">
                    <MoreHorizontal size={15} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuItem onSelect={() => archive.submit({ intent: archived ? "unarchive" : "archive" }, { method: "post" })}>
                    {archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                    {archived ? "Bring it back" : "Archive project"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </div>
      </div>
      {archiveError && <p className="mt-2 text-xs text-danger">{archiveError}</p>}
      {archived && (
        <p className="mt-3 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-muted">
          This project is archived: it is out of the lists and takes no new work items. Its work items keep it.
        </p>
      )}
      {canEdit && <EditProjectDialog project={project} members={members} open={editing} onOpenChange={setEditing} />}
      <div className="mt-5 border-b border-line">
        <NavTabs label={project.name}>
          <NavTab to={projectPath(workspace, project.slug)} current={tab === "overview"}>
            Overview
          </NavTab>
          <NavTab to={projectPath(workspace, project.slug, "items")} current={tab === "items"} count={project.openItems}>
            Items
          </NavTab>
        </NavTabs>
      </div>
    </header>
  );
}

/** Editing a project's brief in place: Markdown, saved with `intent=brief`. */
export function BriefForm({ brief, onDone }: { brief: string; onDone: () => void }) {
  const result = useActionData<ProjectResult>();
  const pending = usePending({ intent: "brief" });
  const sent = useRef(false);
  const mine = result?.intent === "brief";
  useEffect(() => {
    if (sent.current && !pending && mine && !result?.error) onDone();
    sent.current = pending;
  }, [mine, result, pending, onDone]);
  return (
    <Form method="post" className="grid gap-3">
      <input type="hidden" name="intent" value="brief" />
      <Textarea
        name="brief"
        defaultValue={brief}
        rows={14}
        maxLength={20000}
        autoFocus
        aria-label="Brief"
        className="font-mono text-[0.8125rem]"
        placeholder={"## Problem\n\nWhat is wrong, for whom.\n\n## Appetite\n\nHow much it is worth: six weeks.\n\n## Solution\n\n## Rabbit holes\n\n## No-gos"}
      />
      {mine && result?.error && <ErrorText>{result.error}</ErrorText>}
      <div className="flex flex-wrap justify-end gap-2 max-sm:*:grow">
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <SubmitButton match={{ intent: "brief" }} pending="Saving…">
          Save brief
        </SubmitButton>
      </div>
    </Form>
  );
}
