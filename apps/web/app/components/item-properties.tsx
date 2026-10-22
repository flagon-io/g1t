/**
 * A work item's properties, in the panel at the right of its page: each a
 * row with its value, and for whoever may change it, a fuzzy picker that
 * opens from the row or from its key (A, P, Y, H, M, L, B), driven from the
 * keyboard alone. Each posts to the page's action (routes/workspace/work/
 * item.tsx); a multi-choice picker (assignees, labels, blocked by) saves
 * when it closes, as Linear's do.
 */
import {
  Ban,
  Check,
  CircleDashed,
  CircleDot,
  CircleSlash,
  Coins,
  FolderKanban,
  GitMerge,
  Milestone as MilestoneIcon,
  Plus,
  Sparkles,
  Tag,
  Timer,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Link, useFetcher } from "react-router";

import {
  APPETITES,
  HORIZONS,
  type Horizon,
  type ItemRepo,
  type CycleChoice,
  type Cycles,
  type Label,
  type Milestone,
  type MilestoneRef,
  type Progress,
  type WorkItem,
  type WorkProject,
  type WorkProjectRef,
  appetiteLetter,
  horizonLabel,
} from "@g1t/contracts";

import { cn } from "../lib/cn";
import { cycleDays, cycleName, cyclePath, dayText, daysLeftText } from "../lib/cycles";
import { matchLabels, tidyLabelName } from "../lib/labels";
import { APPETITE_HINTS, HORIZON_HINTS, acceptForm, budgetText, canAccept, planPath, suggestionText } from "../lib/plan";
import { isLive, projectPath, projectsPath } from "../lib/projects";
import {
  type ItemChoice,
  type ItemCommand,
  type ItemStage,
  budgetOf,
  keyFor,
  planSummary,
  sameSet,
  toggled,
  typedNumber,
  typedUsername,
} from "../lib/work-item-page";
import { ROLE_LABELS, itemPath, shortPath, workPath } from "../lib/work-items";
import { Unavailable } from "./boundary";
import { LabelChip, Swatch } from "./labels";
import { HillMark, StandingText } from "./plan";
import { ProjectMark } from "./projects";
import { Avatar } from "./ui/avatar";
import { Badge } from "./ui/badge";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "./ui/command";
import { Hint } from "./ui/hint";
import { Kbd } from "./ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { ItemIcon } from "./work-icons";
import { RoleBadge } from "./work-items";

// --- The row and its picker ---------------------------------------------------

/** One property: its name at the left, its value at the right. */
export function PropertyRow({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("grid grid-cols-[5.75rem_minmax(0,1fr)] items-start gap-x-2", className)}>
      <span className="pt-1.75 text-xs text-muted">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** A key's hint at the end of a property's button: shown on hover and focus, never to a finger. */
function KeyHint({ command }: { command: ItemCommand }) {
  return (
    <Kbd className="ml-auto shrink-0 px-1 text-[0.625rem] text-faint opacity-0 transition-opacity group-hover/prop:opacity-100 group-focus-visible/prop:opacity-100 pointer-coarse:hidden">
      {keyFor(command)}
    </Kbd>
  );
}

/** What a property's value looks like when it is empty. */
function Empty({ children }: { children: ReactNode }) {
  return <span className="text-faint">{children}</span>;
}

const VALUE = "flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-sm";

/**
 * A property someone may change: a button showing its value that opens its
 * picker, from a click, a tap, Enter, or its key.
 */
export function PickerProperty({
  label,
  command,
  open,
  onOpenChange,
  value,
  children,
  footer,
  width = "w-72",
  error,
}: {
  label: string;
  command?: ItemCommand;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: ReactNode;
  children: ReactNode;
  /** Under the list: a link to where the choices are managed. */
  footer?: ReactNode;
  width?: string;
  error?: string | null;
}) {
  return (
    <PropertyRow label={label}>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`${label}: change`}
            aria-keyshortcuts={command ? keyFor(command).replace(" ", "+") : undefined}
            className={cn(
              VALUE,
              "group/prop -mx-0 transition-colors outline-none hover:bg-raised focus-visible:ring-2 focus-visible:ring-accent data-[state=open]:bg-raised max-lg:min-h-10",
            )}
          >
            <span className="flex min-w-0 grow flex-wrap items-center gap-1.5">{value}</span>
            {command && <KeyHint command={command} />}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className={cn(width, "p-0")}>
          {children}
          {footer && <div className="border-t border-line px-3 py-2 text-xs text-muted">{footer}</div>}
        </PopoverContent>
      </Popover>
      {error && <p className="mt-1 px-2 text-xs text-danger">{error}</p>}
    </PropertyRow>
  );
}

/** A property shown, not changed. */
export function ReadOnlyProperty({ label, children }: { label: string; children: ReactNode }) {
  return (
    <PropertyRow label={label}>
      <div className={cn(VALUE, "flex-wrap gap-1.5")}>{children}</div>
    </PropertyRow>
  );
}

/** A tick where a choice is chosen, holding its place where it is not. */
function Tick({ on }: { on: boolean }) {
  return <span className="flex size-4 shrink-0 items-center justify-center">{on && <Check className="text-accent!" />}</span>;
}

/** The keys a multi-choice picker takes, under its list. */
function MultiHint() {
  return (
    <span className="flex items-center gap-1.5 pointer-coarse:hidden">
      <Kbd>Enter</Kbd> picks, <Kbd>Esc</Kbd> saves
    </span>
  );
}

/** A fetcher's refusal, once it has come back. */
function refusal(fetcher: { state: string; data?: { error?: string | null } | null }): string | null {
  return fetcher.state === "idle" ? (fetcher.data?.error ?? null) : null;
}

type Toggle = { open: boolean; onOpenChange: (open: boolean) => void };

// --- Stage ---------------------------------------------------------------------

const STAGE_ICON: Record<ItemStage["stage"], ReactNode> = {
  next: <CircleDashed size={14} className="shrink-0 text-faint" />,
  progress: <CircleDot size={14} className="shrink-0 text-warn" />,
  review: <CircleDot size={14} className="shrink-0 text-info" />,
  landing: <GitMerge size={14} className="shrink-0 text-accent" />,
  done: <Check size={14} className="shrink-0 text-merged" />,
  closed: <CircleSlash size={14} className="shrink-0 text-faint" />,
};

/** Where it stands, read from what is so, and why: nobody sets it. */
export function StageProperty({ stage }: { stage: ItemStage }) {
  return (
    <PropertyRow label="Stage">
      <div className="px-2 py-1">
        <span className="flex items-center gap-2 text-sm font-medium">
          {STAGE_ICON[stage.stage]}
          {stage.label}
        </span>
        <span className="mt-0.5 block text-xs text-muted">{stage.why}</span>
      </div>
    </PropertyRow>
  );
}

// --- Assignees ----------------------------------------------------------------

/**
 * Assignees (A): the workspace's people, you first, anyone typed by
 * username, and g1t, which takes it on in a session on the workspace's
 * Claude when it can start one.
 */
export function AssigneeProperty({
  assignees,
  members,
  viewer,
  canEdit,
  canAssignG1t,
  ...toggle
}: Toggle & {
  assignees: string[];
  /** The workspace's people; null when they could not be read. */
  members: string[] | null;
  viewer: string | null;
  canEdit: boolean;
  /** Hosted sessions are set up: g1t can be assigned. */
  canAssignG1t: boolean;
}) {
  const fetcher = useFetcher<{ error?: string } | null>();
  const [picked, setPicked] = useState(assignees);
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (!toggle.open) setPicked(assignees);
  }, [assignees, toggle.open]);
  const shown = fetcher.state !== "idle" ? picked : assignees;
  const value =
    shown.length === 0 ? (
      <Empty>Nobody</Empty>
    ) : (
      shown.map((name) => (
        <span key={name} className="inline-flex min-w-0 items-center gap-1.5">
          <Avatar name={name} size={18} agent={name === "g1t"} />
          <span className="truncate">{name}</span>
        </span>
      ))
    );
  if (!canEdit) return <ReadOnlyProperty label="Assignees">{value}</ReadOnlyProperty>;
  const people = [...new Set([...(members ?? []), ...picked.filter((name) => name !== "g1t")])].filter((name) => name !== viewer && name !== "g1t");
  const typed = typedUsername(query);
  const offerTyped = typed != null && typed !== viewer && typed !== "g1t" && !people.includes(typed);
  const save = (next: string[]) => {
    if (sameSet(next, assignees)) return;
    const form = new FormData();
    form.set("action", "assign");
    for (const name of next) form.append("assignee", name);
    fetcher.submit(form, { method: "post" });
  };
  return (
    <PickerProperty
      label="Assignees"
      command="assignee"
      value={value}
      open={toggle.open}
      onOpenChange={(next) => {
        toggle.onOpenChange(next);
        if (!next) {
          setQuery("");
          save(picked);
        }
      }}
      footer={<MultiHint />}
      error={refusal(fetcher)}
    >
      <Command>
        <CommandInput value={query} onValueChange={setQuery} placeholder="Assign to…" />
        <CommandList>
          <CommandEmpty>Nobody matches. Type a username.</CommandEmpty>
          {members == null && (
            <div className="px-2 py-1.5">
              <Unavailable what="The workspace's people" compact />
            </div>
          )}
          {viewer && (
            <CommandGroup>
              <CommandItem value={`me ${viewer}`} onSelect={() => setPicked((now) => toggled(now, viewer))}>
                <Tick on={picked.includes(viewer)} />
                <Avatar name={viewer} size={18} />
                <span className="truncate">{viewer}</span>
                <span className="ml-auto text-xs text-faint">you</span>
              </CommandItem>
            </CommandGroup>
          )}
          {people.length > 0 && (
            <CommandGroup heading="People">
              {people.map((name) => (
                <CommandItem key={name} value={name} onSelect={() => setPicked((now) => toggled(now, name))}>
                  <Tick on={picked.includes(name)} />
                  <Avatar name={name} size={18} />
                  <span className="truncate">{name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {offerTyped && (
            <CommandGroup heading="Someone else">
              <CommandItem
                value={`typed ${typed}`}
                onSelect={() => {
                  setPicked((now) => toggled(now, typed));
                  setQuery("");
                }}
              >
                <Plus />
                Assign <span className="font-medium">@{typed}</span>
              </CommandItem>
            </CommandGroup>
          )}
          {(canAssignG1t || picked.includes("g1t")) && (
            <CommandGroup heading="Agents">
              <CommandItem value="g1t agent hosted" onSelect={() => setPicked((now) => toggled(now, "g1t"))}>
                <Tick on={picked.includes("g1t")} />
                <Avatar name="g1t" size={18} agent system />
                <span className="min-w-0">
                  <span className="block">g1t</span>
                  <span className="block text-xs text-faint">Takes it on in a session on the workspace&apos;s Claude</span>
                </span>
              </CommandItem>
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </PickerProperty>
  );
}

// --- Project ------------------------------------------------------------------

/** Project (P): one of the workspace's live projects, or none. */
export function ProjectProperty({
  projects,
  current,
  canEdit,
  workspace,
  ...toggle
}: Toggle & { projects: WorkProject[] | null; current: WorkProjectRef | null | undefined; canEdit: boolean; workspace: string }) {
  const fetcher = useFetcher<{ error?: string } | null>();
  const pending = fetcher.state !== "idle" ? String(fetcher.formData?.get("project") ?? "") : null;
  const shownSlug = pending ?? current?.slug ?? "";
  const shown: Pick<WorkProjectRef, "slug" | "name" | "color" | "icon"> | undefined =
    projects?.find((project) => project.slug === shownSlug) ?? (current && current.slug === shownSlug ? current : undefined);
  const value = shown ? (
    <span className="inline-flex min-w-0 items-center gap-2">
      <ProjectMark project={shown} size={18} />
      <span className="truncate">{shown.name}</span>
    </span>
  ) : (
    <Empty>None</Empty>
  );
  if (!canEdit) {
    return (
      <ReadOnlyProperty label="Project">
        {shown ? (
          <Link to={projectPath(workspace, shown.slug)} className="inline-flex min-w-0 items-center gap-2 hover:text-accent">
            {value}
          </Link>
        ) : (
          value
        )}
      </ReadOnlyProperty>
    );
  }
  const choose = (slug: string) => {
    toggle.onOpenChange(false);
    if (slug !== (current?.slug ?? "")) fetcher.submit({ action: "project", project: slug }, { method: "post" });
  };
  return (
    <PickerProperty
      label="Project"
      command="project"
      value={value}
      {...toggle}
      error={refusal(fetcher)}
      footer={
        <span className="flex items-center justify-between gap-2">
          <Link to={projectsPath(workspace)} className="inline-flex items-center gap-1.5 hover:text-fg">
            <FolderKanban size={13} />
            All projects
          </Link>
          {shown && (
            <Link to={projectPath(workspace, shown.slug)} className="hover:text-fg">
              Open {shown.name}
            </Link>
          )}
        </span>
      }
    >
      <Command>
        <CommandInput placeholder="Move to a project…" />
        <CommandList>
          <CommandEmpty>No project matches.</CommandEmpty>
          {projects == null && (
            <div className="px-2 py-1.5">
              <Unavailable what="Projects" compact />
            </div>
          )}
          {current && (
            <CommandGroup>
              <CommandItem value="none no project" onSelect={() => choose("")}>
                <X />
                No project
              </CommandItem>
            </CommandGroup>
          )}
          <CommandGroup heading="Projects">
            {(projects ?? []).filter(isLive).map((project) => (
              <CommandItem key={project.id} value={`${project.name} ${project.slug}`} onSelect={() => choose(project.slug)}>
                <ProjectMark project={project} size={18} />
                <span className="min-w-0 grow truncate">{project.name}</span>
                {project.slug === current?.slug && <Check className="text-accent!" />}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </PickerProperty>
  );
}

// --- Cycle --------------------------------------------------------------------

/**
 * Cycle (Y), while the workspace has cycles on: the current cycle (which
 * is Now), the coming one (it waits in Next until this one closes), or
 * neither. Shift Y moves it to the coming one without the picker.
 */
export function CycleProperty({
  item,
  cycles,
  canEdit,
  workspace,
  today,
  ...toggle
}: Toggle & {
  item: Pick<WorkItem, "cycle" | "horizon" | "state">;
  cycles: Pick<Cycles, "current" | "next">;
  canEdit: boolean;
  workspace: string;
  today: string;
}) {
  const fetcher = useFetcher<{ error?: string } | null>({ key: "item-cycle" });
  const current = cycles.current;
  const coming = cycles.next;
  if (!current) return null;
  const asked = fetcher.state !== "idle" ? (fetcher.formData?.get("cycle") as CycleChoice | null) : null;
  const shown: CycleChoice =
    asked ?? (item.cycle === current.number && item.horizon === "now" ? "current" : coming && item.cycle === coming.number ? "next" : "none");
  const value =
    shown === "current" ? (
      <span className="inline-flex min-w-0 items-center gap-2">
        <Timer size={14} className="shrink-0 text-accent" />
        <span className="shrink-0">{cycleName(current)}</span>
        <span className="truncate text-xs text-faint">{daysLeftText(current, today)}</span>
      </span>
    ) : shown === "next" && coming ? (
      <span className="inline-flex min-w-0 items-center gap-2">
        <Timer size={14} className="shrink-0 text-faint" />
        <span className="shrink-0">{cycleName(coming)}</span>
        <span className="truncate text-xs text-faint">planned</span>
      </span>
    ) : item.cycle != null && item.state === "closed" ? (
      <span className="truncate">Cycle {item.cycle}</span>
    ) : (
      <Empty>None</Empty>
    );
  if (!canEdit || item.state !== "open") {
    return (
      <ReadOnlyProperty label="Cycle">
        {item.cycle != null ? (
          <Link
            to={cyclePath(workspace, item.cycle === current.number ? undefined : item.cycle)}
            className="inline-flex min-w-0 items-center gap-2 hover:text-accent"
          >
            {value}
          </Link>
        ) : (
          value
        )}
      </ReadOnlyProperty>
    );
  }
  const choose = (choice: CycleChoice) => {
    toggle.onOpenChange(false);
    if (choice !== shown) fetcher.submit({ action: "cycle", cycle: choice }, { method: "post" });
  };
  return (
    <PickerProperty
      label="Cycle"
      command="cycle"
      value={value}
      {...toggle}
      error={refusal(fetcher)}
      footer={
        <span className="flex items-center justify-between gap-2">
          <Link to={cyclePath(workspace)} className="inline-flex items-center gap-1.5 hover:text-fg">
            <Timer size={13} />
            Open {cycleName(current)}
          </Link>
          <span className="flex items-center gap-1 pointer-coarse:hidden">
            <Kbd>Shift Y</Kbd> next cycle
          </span>
        </span>
      }
    >
      <Command>
        <CommandInput placeholder="Move to a cycle…" />
        <CommandList>
          <CommandEmpty>No cycle matches.</CommandEmpty>
          <CommandGroup heading="Cycles">
            <CommandItem value={`current this now ${cycleName(current)}`} onSelect={() => choose("current")}>
              <Tick on={shown === "current"} />
              <span className="min-w-0 grow">
                <span className="block">{cycleName(current)}</span>
                <span className="block text-xs text-faint">
                  Now · {cycleDays(current)} · {daysLeftText(current, today)}
                </span>
              </span>
            </CommandItem>
            {coming && (
              <CommandItem value={`next coming ${cycleName(coming)}`} onSelect={() => choose("next")}>
                <Tick on={shown === "next"} />
                <span className="min-w-0 grow">
                  <span className="block">{cycleName(coming)}</span>
                  <span className="block text-xs text-faint">Waits in Next · from {dayText(coming.startsOn)}</span>
                </span>
              </CommandItem>
            )}
          </CommandGroup>
          {shown !== "none" && (
            <CommandGroup>
              <CommandItem value="none no cycle out" onSelect={() => choose("none")}>
                <X />
                No cycle
                <span className="ml-auto text-xs text-faint">back to Next</span>
              </CommandItem>
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </PickerProperty>
  );
}

// --- Plan ---------------------------------------------------------------------

/**
 * Plan (H): its horizon, its appetite, urgent, and a budget for an agent,
 * typed as dollars. In Triage, g1t's suggestion with Accept; in Now, how it
 * stands as the plan reads it.
 */
export function PlanProperty({
  item,
  workspace,
  canEdit,
  canNow,
  progress,
  ...toggle
}: Toggle & {
  item: Pick<WorkItem, "horizon" | "appetite" | "budgetUsd" | "urgent" | "state" | "suggestion">;
  workspace: string;
  canEdit: boolean;
  /** May move it into or out of Now, and make it urgent. */
  canNow: boolean;
  progress?: Progress | null;
}) {
  const fetcher = useFetcher<{ error?: string } | null>();
  const [query, setQuery] = useState("");
  // While saving, what was asked for.
  const posted = fetcher.state !== "idle" ? fetcher.formData : null;
  const horizon = (posted?.get("urgent") === "1" ? "now" : (posted?.get("horizon") as Horizon | null)) ?? item.horizon;
  const appetite = posted?.has("appetite") ? (posted.get("appetite") === "none" ? null : (posted.get("appetite") as WorkItem["appetite"])) : item.appetite;
  const urgent = posted?.has("urgent") ? posted.get("urgent") === "1" : item.urgent;
  const budget = posted?.has("budget") ? (String(posted.get("budget")) === "" ? null : Number(posted.get("budget"))) : item.budgetUsd;
  const shown = { horizon, appetite, urgent, budgetUsd: budget };
  const suggestion = item.horizon === "triage" && horizon === "triage" && item.state === "open" ? (item.suggestion ?? null) : null;
  const standing = item.horizon === "now" && horizon === "now" && item.state === "open" ? (progress ?? null) : null;
  const editable = canEdit && item.state === "open";
  const lockedInNow = horizon === "now" && !canNow;
  const post = (fields: Record<string, string>, close = true) => {
    fetcher.submit({ action: "plan", ...fields }, { method: "post" });
    if (close) {
      setQuery("");
      toggle.onOpenChange(false);
    }
  };
  const typedBudget = budgetOf(query);
  const value = (
    <>
      {urgent && <Badge tone="danger">Urgent</Badge>}
      <span>{planSummary({ ...shown, urgent: false }, horizonLabel)}</span>
    </>
  );
  const extra = (
    <>
      {suggestion && (
        <div className="mt-1 space-y-1 rounded-md border border-accent/20 bg-accent/5 px-2.5 py-2 text-xs">
          <p className="flex items-center gap-1.5 font-medium text-fg">
            <Sparkles size={12} className="shrink-0 text-accent" aria-hidden />
            Suggested: {suggestionText(suggestion)}
          </p>
          {suggestion.duplicateOf != null && (
            <p className="text-muted">
              Looks like{" "}
              <Link to={itemPath(workspace, suggestion.duplicateOf)} className="font-mono text-fg hover:underline">
                #{suggestion.duplicateOf}
              </Link>
            </p>
          )}
          <p className="text-muted">{suggestion.why}</p>
        </div>
      )}
      {standing && (
        <div className="mt-1 space-y-1 px-2">
          <span className="flex items-center gap-2 text-xs text-muted">
            <HillMark hill={standing.hill} label />
          </span>
          <StandingText standing={standing} className="text-xs" />
        </div>
      )}
    </>
  );
  if (!editable) {
    return (
      <div>
        <ReadOnlyProperty label="Plan">{value}</ReadOnlyProperty>
        {extra}
      </div>
    );
  }
  return (
    <div>
      <PickerProperty
        label="Plan"
        command="plan"
        value={value}
        open={toggle.open}
        onOpenChange={(next) => {
          toggle.onOpenChange(next);
          if (!next) setQuery("");
        }}
        width="w-80"
        error={refusal(fetcher)}
        footer={
          <span className="flex items-center justify-between gap-2">
            <Link to={planPath(workspace)} className="hover:text-fg">
              Open the plan
            </Link>
            <span className="pointer-coarse:hidden">Type a number for a budget</span>
          </span>
        }
      >
        <Command>
          <CommandInput value={query} onValueChange={setQuery} placeholder="Horizon, appetite or a budget…" />
          <CommandList className="max-h-80">
            <CommandEmpty>Nothing matches. Type a budget in dollars, such as 5.</CommandEmpty>
            {suggestion && canAccept(suggestion, canNow) && (
              <CommandGroup heading="Suggested">
                <CommandItem value={`accept suggestion ${suggestionText(suggestion)}`} onSelect={() => post(acceptForm(suggestion))}>
                  <Sparkles />
                  Accept: {suggestionText(suggestion)}
                </CommandItem>
              </CommandGroup>
            )}
            {typedBudget !== undefined && (
              <CommandGroup heading="Budget">
                <CommandItem value={`budget ${query}`} onSelect={() => post({ budget: typedBudget == null ? "" : String(typedBudget) })}>
                  <Coins />
                  {typedBudget == null ? "No budget" : `Budget ${budgetText(typedBudget)}`}
                </CommandItem>
              </CommandGroup>
            )}
            <CommandGroup heading="Horizon">
              {HORIZONS.map((one) => (
                <CommandItem
                  key={one}
                  value={`horizon ${horizonLabel(one)}`}
                  disabled={one === horizon || (one === "now" && !canNow) || lockedInNow}
                  onSelect={() => post({ horizon: one })}
                >
                  <Tick on={one === horizon} />
                  <span className="min-w-0 grow">
                    <span className="block">{horizonLabel(one)}</span>
                    <span className="block text-xs text-faint">{HORIZON_HINTS[one]}</span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandGroup heading="Appetite">
              {APPETITES.map((one) => (
                <CommandItem key={one} value={`appetite ${one} ${appetiteLetter(one)}`} onSelect={() => post({ appetite: one === appetite ? "none" : one })}>
                  <Tick on={one === appetite} />
                  <Badge className="w-5 justify-center px-0 font-mono">{appetiteLetter(one)}</Badge>
                  <span className="min-w-0 truncate text-xs text-muted">{APPETITE_HINTS[one]}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandGroup heading="More">
              <CommandItem value="urgent first in now" disabled={!canNow} onSelect={() => post({ urgent: urgent ? "0" : "1" })}>
                <Tick on={urgent} />
                <span className="min-w-0 grow">
                  <span className="block">Urgent</span>
                  <span className="block text-xs text-faint">First in Now, until it closes</span>
                </span>
              </CommandItem>
              {budget != null && (
                <CommandItem value="clear budget none" onSelect={() => post({ budget: "" })}>
                  <X />
                  Clear the {budgetText(budget)} budget
                </CommandItem>
              )}
            </CommandGroup>
            {lockedInNow && <p className="px-2 py-1.5 text-xs text-faint">Moving it out of Now takes the right to manage milestones.</p>}
          </CommandList>
        </Command>
      </PickerProperty>
      {extra}
    </div>
  );
}

// --- Milestone ----------------------------------------------------------------

/** Milestone (M): one of the workspace's open milestones, or none. */
export function MilestoneProperty({
  milestones,
  current,
  canEdit,
  workspace,
  ...toggle
}: Toggle & { milestones: Milestone[] | null; current: MilestoneRef | null | undefined; canEdit: boolean; workspace: string }) {
  const fetcher = useFetcher<{ error?: string } | null>();
  const pending = fetcher.state !== "idle" ? Number(fetcher.formData?.get("milestone") ?? 0) : null;
  const shownNumber = pending ?? current?.number ?? 0;
  const shown = milestones?.find((milestone) => milestone.number === shownNumber);
  const title = shown?.title ?? (shownNumber === current?.number ? current?.title : undefined);
  const value =
    shownNumber && title ? (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <MilestoneIcon size={14} className="shrink-0 text-faint" />
        <span className="truncate">{title}</span>
      </span>
    ) : (
      <Empty>None</Empty>
    );
  if (!canEdit) {
    return (
      <ReadOnlyProperty label="Milestone">
        {shownNumber && title ? (
          <Link to={workPath(workspace, `milestones/${shownNumber}`)} className="min-w-0 hover:text-accent">
            {value}
          </Link>
        ) : (
          value
        )}
      </ReadOnlyProperty>
    );
  }
  const choose = (number: number) => {
    toggle.onOpenChange(false);
    if (number !== (current?.number ?? 0)) fetcher.submit({ action: "milestone", milestone: String(number) }, { method: "post" });
  };
  return (
    <PickerProperty
      label="Milestone"
      command="milestone"
      value={value}
      {...toggle}
      error={refusal(fetcher)}
      footer={
        <span className="flex items-center justify-between gap-2">
          <Link to={workPath(workspace, "milestones")} className="inline-flex items-center gap-1.5 hover:text-fg">
            <MilestoneIcon size={13} />
            All milestones
          </Link>
          {shownNumber > 0 && title && (
            <Link to={workPath(workspace, `milestones/${shownNumber}`)} className="hover:text-fg">
              Open it
            </Link>
          )}
        </span>
      }
    >
      <Command>
        <CommandInput placeholder="Move to a milestone…" />
        <CommandList>
          <CommandEmpty>No milestone matches.</CommandEmpty>
          {milestones == null && (
            <div className="px-2 py-1.5">
              <Unavailable what="Milestones" compact />
            </div>
          )}
          {current && (
            <CommandGroup>
              <CommandItem value="none no milestone" onSelect={() => choose(0)}>
                <X />
                No milestone
              </CommandItem>
            </CommandGroup>
          )}
          <CommandGroup heading="Open">
            {(milestones ?? [])
              .filter((milestone) => milestone.state === "open")
              .map((milestone) => (
                <CommandItem key={milestone.number} value={`${milestone.title} ${milestone.number}`} onSelect={() => choose(milestone.number)}>
                  <Tick on={milestone.number === current?.number} />
                  <span className="min-w-0 grow truncate">{milestone.title}</span>
                  {milestone.dueOn && <span className="text-xs text-faint">{milestone.dueOn}</span>}
                </CommandItem>
              ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </PickerProperty>
  );
}

// --- Labels -------------------------------------------------------------------

/** Labels (L): tick the workspace's labels on and off, find one, or make one. */
export function LabelsProperty({
  labels,
  chosen,
  canEdit,
  canCreate,
  manageUrl,
  ...toggle
}: Toggle & {
  /** The workspace's labels; null when they could not be read. */
  labels: Label[] | null;
  chosen: string[];
  canEdit: boolean;
  canCreate: boolean;
  manageUrl?: string;
}) {
  const fetcher = useFetcher<{ error?: string } | null>();
  const [picked, setPicked] = useState(chosen);
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (!toggle.open) setPicked(chosen);
  }, [chosen, toggle.open]);
  const colors = useMemo(() => new Map((labels ?? []).map((label) => [label.name, label.color])), [labels]);
  const shown = fetcher.state !== "idle" ? picked : chosen;
  const value = shown.length === 0 ? <Empty>None</Empty> : shown.map((name) => <LabelChip key={name} name={name} color={colors.get(name)} />);
  if (!canEdit) return <ReadOnlyProperty label="Labels">{value}</ReadOnlyProperty>;
  const typed = tidyLabelName(query);
  const offerNew = canCreate && typed !== "" && !colors.has(typed) && !picked.includes(typed);
  const save = (next: string[]) => {
    if (sameSet(next, chosen)) return;
    const form = new FormData();
    form.set("action", "labels");
    for (const name of next) form.append("label", name);
    fetcher.submit(form, { method: "post" });
  };
  return (
    <PickerProperty
      label="Labels"
      command="labels"
      value={value}
      open={toggle.open}
      onOpenChange={(next) => {
        toggle.onOpenChange(next);
        if (!next) {
          setQuery("");
          save(picked);
        }
      }}
      error={refusal(fetcher)}
      footer={
        <span className="flex items-center justify-between gap-2">
          {manageUrl ? (
            <Link to={manageUrl} className="inline-flex items-center gap-1.5 hover:text-fg">
              <Tag size={13} />
              Edit labels
            </Link>
          ) : (
            <span />
          )}
          <MultiHint />
        </span>
      }
    >
      <Command shouldFilter={false}>
        <CommandInput value={query} onValueChange={setQuery} placeholder={canCreate ? "Find or make a label…" : "Find a label…"} />
        <CommandList>
          {!offerNew && <CommandEmpty>No label matches.</CommandEmpty>}
          {labels == null && (
            <div className="px-2 py-1.5">
              <Unavailable what="Labels" compact />
            </div>
          )}
          <CommandGroup heading="Labels">
            {matchLabels(labels ?? [], query).map((label) => (
              <CommandItem key={label.name} value={label.name} onSelect={() => setPicked((now) => toggled(now, label.name))}>
                <Tick on={picked.includes(label.name)} />
                <Swatch color={label.color} />
                <span className="min-w-0 grow">
                  <span className="block truncate">{label.name}</span>
                  {label.description && <span className="block truncate text-xs text-faint">{label.description}</span>}
                </span>
              </CommandItem>
            ))}
            {picked
              .filter((name) => !colors.has(name) && name.includes(typed))
              .map((name) => (
                <CommandItem key={name} value={`new:${name}`} onSelect={() => setPicked((now) => toggled(now, name))}>
                  <Tick on />
                  <Swatch />
                  <span className="grow truncate">{name}</span>
                  <span className="text-xs text-faint">new</span>
                </CommandItem>
              ))}
          </CommandGroup>
          {offerNew && (
            <CommandGroup heading="New label">
              <CommandItem
                value={`create:${typed}`}
                onSelect={() => {
                  setPicked((now) => toggled(now, typed));
                  setQuery("");
                }}
              >
                <Plus />
                <span className="truncate">
                  Create <span className="font-medium">{typed}</span>
                </span>
              </CommandItem>
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </PickerProperty>
  );
}

// --- Work items to choose from ------------------------------------------------

/**
 * The workspace's work items for a picker, read once it opens and again as
 * someone types (routes/workspace/work/items-json.ts): null until they come,
 * or when they could not be read (`failed`).
 */
export function useItemChoices(workspace: string, open: boolean, query: string): { items: ItemChoice[] | null; failed: boolean; loading: boolean } {
  const fetcher = useFetcher<{ items: ItemChoice[] | null }>();
  const q = query.trim();
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => fetcher.load(`${workPath(workspace, "items.json")}${q ? `?q=${encodeURIComponent(q)}` : ""}`), q ? 200 : 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load when it opens and as the query changes
  }, [open, q, workspace]);
  const items = fetcher.data?.items;
  return { items: items ?? null, failed: fetcher.data != null && items === null, loading: fetcher.state !== "idle" };
}

/** A work item as a picker's choice. */
function ItemChoiceLine({ item, on }: { item: Pick<ItemChoice, "number" | "title" | "state">; on?: boolean }) {
  return (
    <>
      {on !== undefined && <Tick on={on} />}
      <ItemIcon item={{ state: item.state, reason: null }} size={14} />
      <span className="min-w-0 grow truncate">{item.title}</span>
      <span className="shrink-0 font-mono text-xs text-faint">#{item.number}</span>
    </>
  );
}

/** A work item a picker could not name: one typed by number, or one the viewer cannot see. */
function unnamed(number: number): ItemChoice {
  return { number, title: `Work item #${number}`, state: "open" };
}

// --- Blocked by ---------------------------------------------------------------

/** Blocked by (B): the work items that have to land first, ticked on and off; what waits on it, under them. */
export function BlockedByProperty({
  workspace,
  number,
  blockedBy,
  blockers,
  blocks,
  canEdit,
  itemOpen,
  ...toggle
}: Toggle & {
  workspace: string;
  /** This work item's number, which it cannot wait on. */
  number: number;
  blockedBy: number[];
  /** What is known of each: its title and state, and where it stands. */
  blockers: { number: number; title: string; state: "open" | "closed"; detail?: string }[];
  /** The work items waiting on it. */
  blocks: { number: number; title: string; state: "open" | "closed" }[];
  /** Whether the work item is open: it waits on nothing once closed. */
  itemOpen: boolean;
  canEdit: boolean;
}) {
  const fetcher = useFetcher<{ error?: string } | null>();
  const [picked, setPicked] = useState(blockedBy);
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (!toggle.open) setPicked(blockedBy);
  }, [blockedBy, toggle.open]);
  const choices = useItemChoices(workspace, toggle.open, query);
  const known = new Map<number, ItemChoice>(blockers.map((one) => [one.number, { number: one.number, title: one.title, state: one.state }]));
  for (const one of choices.items ?? []) if (!known.has(one.number)) known.set(one.number, one);
  const shown = fetcher.state !== "idle" ? picked : blockedBy;
  const waiting = blockers.filter((one) => one.state === "open" && shown.includes(one.number)).length;
  const value =
    shown.length === 0 ? (
      <Empty>Nothing</Empty>
    ) : (
      shown.map((n) => {
        const one = known.get(n) ?? unnamed(n);
        return (
          <span key={n} className="inline-flex min-w-0 items-center gap-1">
            <ItemIcon item={{ state: one.state, reason: null }} size={13} />
            <span className="font-mono text-xs">#{n}</span>
          </span>
        );
      })
    );
  const under = (
    <>
      {shown.length > 0 && itemOpen && (
        <p className={cn("mt-0.5 px-2 text-xs", waiting > 0 ? "text-warn" : "text-muted")}>
          {waiting > 0 ? `${waiting} still open: ${waiting === 1 ? "it has" : "they have"} to land first` : "Everything it waits on has landed"}
        </p>
      )}
      {blocks.length > 0 && (
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 px-2 text-xs text-muted">
          <Ban size={12} className="shrink-0" />
          Blocks{" "}
          {blocks.map((one, index) => (
            <span key={one.number}>
              <Hint label={one.title}>
                <Link to={itemPath(workspace, one.number)} className="font-mono text-fg hover:text-accent">
                  #{one.number}
                </Link>
              </Hint>
              {index < blocks.length - 1 && ","}
            </span>
          ))}
        </p>
      )}
    </>
  );
  if (!canEdit) {
    return (
      <div>
        <ReadOnlyProperty label="Blocked by">
          {shown.length === 0
            ? value
            : shown.map((n) => (
                <Link key={n} to={itemPath(workspace, n)} className="inline-flex items-center gap-1 hover:text-accent">
                  <ItemIcon item={{ state: (known.get(n) ?? unnamed(n)).state, reason: null }} size={13} />
                  <span className="font-mono text-xs">#{n}</span>
                </Link>
              ))}
        </ReadOnlyProperty>
        {under}
      </div>
    );
  }
  const typed = typedNumber(query);
  const listed = [...picked.map((n) => known.get(n) ?? unnamed(n)), ...[...known.values()].filter((one) => !picked.includes(one.number))].filter(
    (one) => one.number !== number,
  );
  const save = (next: number[]) => {
    if (sameSet(next, blockedBy)) return;
    fetcher.submit({ action: "blocked-by", blocked_by: next.map((n) => `#${n}`).join(", ") }, { method: "post" });
  };
  return (
    <div>
      <PickerProperty
        label="Blocked by"
        command="blocked"
        value={value}
        open={toggle.open}
        onOpenChange={(next) => {
          toggle.onOpenChange(next);
          if (!next) {
            setQuery("");
            save(picked);
          }
        }}
        width="w-80"
        error={refusal(fetcher)}
        footer={<MultiHint />}
      >
        <Command shouldFilter={false}>
          <CommandInput value={query} onValueChange={setQuery} placeholder="Find a work item, or type #12…" />
          <CommandList>
            {choices.failed && (
              <div className="px-2 py-1.5">
                <Unavailable what="Work items" compact />
              </div>
            )}
            {typed != null && typed !== number && !known.has(typed) && (
              <CommandGroup>
                <CommandItem value={`typed ${typed}`} onSelect={() => setPicked((now) => toggled(now, typed))}>
                  <Tick on={picked.includes(typed)} />
                  <span>
                    Blocked by <span className="font-mono">#{typed}</span>
                  </span>
                </CommandItem>
              </CommandGroup>
            )}
            <CommandGroup heading={choices.loading && !choices.items ? "Loading…" : "Work items"}>
              {listed
                .filter((one) => matches(one, query))
                .slice(0, 60)
                .map((one) => (
                  <CommandItem key={one.number} value={String(one.number)} onSelect={() => setPicked((now) => toggled(now, one.number))}>
                    <ItemChoiceLine item={one} on={picked.includes(one.number)} />
                  </CommandItem>
                ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PickerProperty>
      {under}
    </div>
  );
}

/** Whether a work item matches what is typed: every word in its title, or its number. */
export function matches(item: { number: number; title: string }, query: string): boolean {
  const words = query.trim().toLowerCase().replace(/^#/, "").split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const title = item.title.toLowerCase();
  return words.every((word) => title.includes(word) || String(item.number).startsWith(word));
}

/**
 * Moving it under another work item (the ⋯ menu's Move): a picker of the
 * workspace's work items, with taking it out of its parent first.
 */
export function ParentPicker({
  workspace,
  number,
  parent,
  ...toggle
}: Toggle & {
  workspace: string;
  number: number;
  parent: { number: number; title?: string } | null;
}) {
  const fetcher = useFetcher<{ error?: string } | null>();
  const [query, setQuery] = useState("");
  const choices = useItemChoices(workspace, toggle.open, query);
  const typed = typedNumber(query);
  const listed = (choices.items ?? []).filter((one) => one.number !== number && one.number !== parent?.number && matches(one, query));
  const choose = (to: number | null) => {
    toggle.onOpenChange(false);
    setQuery("");
    fetcher.submit({ action: "parent", parent: to ? `#${to}` : "" }, { method: "post" });
  };
  return (
    <Popover open={toggle.open} onOpenChange={toggle.onOpenChange}>
      {/* Anchored to the page's header, where the menu that opens it is. */}
      <PopoverTrigger asChild>
        <span aria-hidden className="absolute top-full right-0 size-0" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <Command shouldFilter={false}>
          <CommandInput value={query} onValueChange={setQuery} placeholder="Make it a sub-item of…" />
          <CommandList>
            {choices.failed && (
              <div className="px-2 py-1.5">
                <Unavailable what="Work items" compact />
              </div>
            )}
            {parent && (
              <CommandGroup>
                <CommandItem value="none" onSelect={() => choose(null)}>
                  <X />
                  Take it out of #{parent.number}
                </CommandItem>
              </CommandGroup>
            )}
            {typed != null && typed !== number && !listed.some((one) => one.number === typed) && (
              <CommandGroup>
                <CommandItem value={`typed ${typed}`} onSelect={() => choose(typed)}>
                  Sub-item of <span className="font-mono">#{typed}</span>
                </CommandItem>
              </CommandGroup>
            )}
            <CommandGroup heading={choices.loading && !choices.items ? "Loading…" : "Work items"}>
              {listed.slice(0, 60).map((one) => (
                <CommandItem key={one.number} value={String(one.number)} onSelect={() => choose(one.number)}>
                  <ItemChoiceLine item={one} />
                </CommandItem>
              ))}
            </CommandGroup>
            {!choices.loading && listed.length === 0 && typed == null && <CommandEmpty>No work item matches.</CommandEmpty>}
          </CommandList>
        </Command>
        {refusal(fetcher) && <p className="border-t border-line px-3 py-2 text-xs text-danger">{refusal(fetcher)}</p>}
      </PopoverContent>
    </Popover>
  );
}

// --- Repositories ---------------------------------------------------------------

/**
 * Repos: the repositories it is linked to, each in its role, with whether
 * it landed there; for Triage and up, a picker to link another as a target
 * (or as touched) and to unlink one (never its origin).
 */
export function ReposProperty({
  workspace,
  repos,
  choices,
  canEdit,
  ...toggle
}: Toggle & {
  workspace: string;
  repos: ItemRepo[];
  /** The workspace's repositories by name; null when they could not be read. */
  choices: string[] | null;
  canEdit: boolean;
}) {
  const fetcher = useFetcher<{ error?: string } | null>();
  const value =
    repos.length === 0 ? (
      <Empty>None</Empty>
    ) : (
      <span className="flex min-w-0 flex-col gap-1">
        {repos.map((repo) => (
          <span key={repo.repoId} className="flex min-w-0 items-center gap-1.5">
            <span className={cn("min-w-0 truncate font-mono text-xs", repo.deleted && "text-muted line-through")}>{shortPath(repo.path, workspace)}</span>
            <RoleBadge role={repo.role} />
            {repo.landed ? (
              <Hint label={`Landed in ${repo.path}`}>
                <Check size={12} className="shrink-0 text-merged" aria-label="Landed" />
              </Hint>
            ) : repo.role === "target" ? (
              <Hint label="Still to land here">
                <CircleDashed size={12} className="shrink-0 text-warn" aria-label="Still to land" />
              </Hint>
            ) : null}
          </span>
        ))}
      </span>
    );
  if (!canEdit) return <ReadOnlyProperty label="Repos">{value}</ReadOnlyProperty>;
  const linked = repos.map((repo) => repo.path.toLowerCase());
  const unlinked = (choices ?? []).filter((name) => !linked.includes(`${workspace}/${name}`.toLowerCase()));
  const post = (fields: Record<string, string>) => {
    toggle.onOpenChange(false);
    fetcher.submit(fields, { method: "post" });
  };
  return (
    <PickerProperty label="Repos" value={value} {...toggle} width="w-80" error={refusal(fetcher)}>
      <Command>
        <CommandInput placeholder="Link or unlink a repository…" />
        <CommandList>
          <CommandEmpty>No repository matches.</CommandEmpty>
          {choices == null && (
            <div className="px-2 py-1.5">
              <Unavailable what="The workspace's repositories" compact />
            </div>
          )}
          {unlinked.length > 0 && (
            <CommandGroup heading="Link as a target: it closes once each target has landed">
              {unlinked.map((name) => (
                <CommandItem key={name} value={`target ${name}`} onSelect={() => post({ action: "link", repo: name, role: "target" })}>
                  <Plus />
                  <span className="min-w-0 grow truncate font-mono text-xs">{name}</span>
                  <span className="text-xs text-faint">{ROLE_LABELS.target}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {unlinked.length > 0 && (
            <CommandGroup heading="Link as touched: reached, not needed to land">
              {unlinked.map((name) => (
                <CommandItem key={name} value={`touched ${name}`} onSelect={() => post({ action: "link", repo: name, role: "touched" })}>
                  <Plus />
                  <span className="min-w-0 grow truncate font-mono text-xs">{name}</span>
                  <span className="text-xs text-faint">{ROLE_LABELS.touched}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {repos.some((repo) => repo.role !== "origin" && repo.path) && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Unlink">
                {repos
                  .filter((repo) => repo.role !== "origin" && repo.path)
                  .map((repo) => (
                    <CommandItem key={repo.repoId} value={`unlink ${repo.path}`} onSelect={() => post({ action: "unlink", repo: repo.path })}>
                      <X />
                      <span className="min-w-0 grow truncate font-mono text-xs">{shortPath(repo.path, workspace)}</span>
                      <span className="text-xs text-faint">{ROLE_LABELS[repo.role]}</span>
                    </CommandItem>
                  ))}
              </CommandGroup>
            </>
          )}
        </CommandList>
      </Command>
    </PickerProperty>
  );
}

// --- Agent ----------------------------------------------------------------------

/**
 * Agent (D): who is working on it now (a live session, or the agent behind
 * its newest pull request), and Start an agent for a member, which opens
 * the page's Start agent dialog.
 */
export function AgentProperty({
  live,
  agent,
  onStart,
}: {
  /** Its live sessions, newest first: who, from which harness, and where each stands. */
  live: { id: string; who: string; harness: string | null; state: "active" | "idle"; href: string }[];
  /** The agent behind its newest pull request still in progress, such as `g1t`. */
  agent: string | null;
  /** Opens Start agent; absent for who may not start one. */
  onStart?: () => void;
}) {
  const value =
    live.length > 0 ? (
      <span className="flex min-w-0 flex-col gap-1">
        {live.slice(0, 3).map((session) => (
          <span key={session.id} className="flex min-w-0 items-center gap-1.5">
            <span className={cn("size-2 shrink-0 rounded-full", session.state === "active" ? "bg-success" : "bg-warn")} />
            <span className="shrink-0">{session.who}</span>
            <span className="min-w-0 truncate text-xs text-faint">
              {session.harness ? `${session.harness} · ` : ""}
              {session.state === "active" ? "working" : "idle"}
            </span>
          </span>
        ))}
        {live.length > 3 && <span className="text-xs text-faint">{live.length - 3} more</span>}
      </span>
    ) : agent ? (
      <span className="inline-flex items-center gap-1.5">
        <Avatar name={agent} size={18} agent />
        {agent}
      </span>
    ) : (
      <Empty>{onStart ? "Start an agent" : "None"}</Empty>
    );
  if (!onStart) return <ReadOnlyProperty label="Agent">{value}</ReadOnlyProperty>;
  return (
    <PropertyRow label="Agent">
      <button
        type="button"
        onClick={onStart}
        aria-keyshortcuts="D"
        aria-label="Agent: start one"
        className={cn(VALUE, "group/prop transition-colors outline-none hover:bg-raised focus-visible:ring-2 focus-visible:ring-accent max-lg:min-h-10")}
      >
        <span className="flex min-w-0 grow flex-wrap items-center gap-1.5">{value}</span>
        <KeyHint command="agent" />
      </button>
    </PropertyRow>
  );
}
