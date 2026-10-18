/**
 * Work items, drawn: a row of the Work list that reads on a phone, an
 * item's repositories as chips, and the Work list's filters as menus on a
 * computer and as a sheet that rises from the bottom on a phone. Where
 * Work's pages are, and the filters, are worked out in lib/work-items.ts.
 */
import { Check, GitPullRequest, MessageSquare, Milestone as MilestoneIcon, SlidersHorizontal, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link } from "react-router";

import type { ItemRepo, Label, LinkRole, Milestone, WorkItem } from "@g1t/contracts";

import { FilterMenu, LabelChip, Swatch } from "./labels";
import { BottomSheet } from "./mobile";
import { TimeAgo } from "./ui";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Hint } from "./ui/hint";
import { AssigneeStack } from "./work";
import { ItemIcon } from "./work-icons";
import { cn } from "../lib/cn";
import type { LabelColors } from "../lib/labels";
import {
  LINK_ROLES,
  ROLE_LABELS,
  type WorkFilters,
  filterCount,
  filtered,
  itemPath,
  repoChips,
  shortPath,
  workListPath,
} from "../lib/work-items";

/** How a repository is linked, as a quiet word beside its name. */
export function RoleBadge({ role }: { role: LinkRole }) {
  return <Badge tone={role === "target" ? "accent" : "neutral"}>{ROLE_LABELS[role]}</Badge>;
}

/**
 * An item's repositories in a row: the first two (its origin first), then
 * "+2" for the rest, so a row fits a phone. Each says how it is linked on
 * hover, and a landed one is marked.
 */
export function RepoChips({ repos, workspace, max = 2, className }: { repos: ItemRepo[]; workspace: string; max?: number; className?: string }) {
  if (repos.length === 0) return null;
  const { shown, more } = repoChips(repos, max);
  const rest = repos.slice(shown.length).map((repo) => shortPath(repo.path, workspace)).join(", ");
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1", className)}>
      {shown.map((repo) => (
        <Hint key={repo.repoId} label={`${repo.path || "A deleted repository"}: ${ROLE_LABELS[repo.role].toLowerCase()}${repo.landed ? ", landed" : ""}`}>
          <span
            className={cn(
              "inline-flex max-w-32 min-w-0 items-center gap-1 rounded-md border px-1.5 py-px font-mono text-[0.6875rem] leading-4",
              repo.landed ? "border-merged/40 text-merged" : repo.role === "target" ? "border-line-strong text-fg-soft" : "border-line text-muted",
            )}
          >
            {repo.landed && <Check size={10} className="shrink-0" />}
            <span className="truncate">{shortPath(repo.path, workspace)}</span>
          </span>
        </Hint>
      ))}
      {more > 0 && (
        <Hint label={rest}>
          <span className="shrink-0 rounded-md border border-line px-1 py-px text-[0.6875rem] leading-4 text-muted">+{more}</span>
        </Hint>
      )}
    </span>
  );
}

/**
 * One row of the Work list: its state, title and labels, then its number,
 * who opened it and when, its repositories and milestone; its assignees,
 * pull requests and comments at the end. On a phone the meta wraps under
 * the title and the counts sit with it, so nothing scrolls sideways.
 */
export function WorkItemRow({ item, colors }: { item: WorkItem; colors: LabelColors }) {
  return (
    <li className="transition-colors hover:bg-surface">
      <Link prefetch="intent" to={itemPath(item.workspace, item.number)} className="flex min-w-0 items-start gap-3 px-4 py-3">
        <span className="mt-0.5">
          <ItemIcon item={item} />
        </span>
        <span className="min-w-0 grow">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 font-medium wrap-break-word">{item.title}</span>
            {item.labels.map((name) => (
              <LabelChip key={name} name={name} color={colors[name]} />
            ))}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-faint">
            <span className="whitespace-nowrap">
              #{item.number} · <TimeAgo at={item.state === "closed" && item.closedAt ? item.closedAt : item.createdAt} />
            </span>
            <span className="hidden whitespace-nowrap sm:inline">
              {item.state === "closed" ? "closed" : "opened"} by {item.author.username}
            </span>
            <RepoChips repos={item.repos} workspace={item.workspace} />
            {item.milestone && (
              <span className="inline-flex min-w-0 items-center gap-1">
                <MilestoneIcon size={11} className="shrink-0" />
                <span className="max-w-36 truncate">{item.milestone.title}</span>
              </span>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-3 text-muted sm:hidden">
              <Counts item={item} />
            </span>
          </span>
        </span>
        <span className="mt-0.5 hidden shrink-0 items-center gap-3 text-xs text-muted sm:flex">
          <AssigneeStack people={item.assignees} />
          <Counts item={item} />
        </span>
      </Link>
    </li>
  );
}

function Counts({ item }: { item: WorkItem }) {
  return (
    <>
      {item.pullCount > 0 && (
        <span className="flex items-center gap-1" aria-label={`${item.pullCount} pull ${item.pullCount === 1 ? "request" : "requests"}`}>
          <GitPullRequest size={13} />
          {item.pullCount}
        </span>
      )}
      {item.commentCount > 0 && (
        <span className="flex items-center gap-1" aria-label={`${item.commentCount} ${item.commentCount === 1 ? "comment" : "comments"}`}>
          <MessageSquare size={13} />
          {item.commentCount}
        </span>
      )}
    </>
  );
}

/** What the Work list's filters offer: each may have failed to load, and says so in its menu. */
export type FilterChoices = {
  repos: string[] | null;
  labels: Label[] | null;
  milestones: Milestone[] | null;
  /** The workspace's people, for a member; null when there are none to offer. */
  people: string[] | null;
  /** The viewer, for "Assigned to you". */
  me: string | null;
};

/**
 * The Work list's filters: on a computer, a menu each (repository, its
 * role, label, milestone, assignee); on a phone, one Filters button that
 * says how many are on and opens them as a sheet from the bottom, within
 * reach of a thumb. Each choice is a link, so the address keeps them.
 */
export function WorkFiltersBar({ workspace, filters, choices }: { workspace: string; filters: WorkFilters; choices: FilterChoices }) {
  const [open, setOpen] = useState(false);
  const to = (change: Partial<WorkFilters>) => workListPath(workspace, filters, change);
  const milestoneTitle = choices.milestones?.find((m) => m.number === filters.milestone)?.title ?? (filters.milestone ? `#${filters.milestone}` : null);
  const count = filterCount(filters);
  const clear = workListPath(workspace, { state: filters.state });
  const assigneeLabel = filters.assignee === "@me" || filters.assignee === choices.me ? "You" : filters.assignee;
  return (
    <>
      <div className="hidden flex-wrap items-center gap-2 sm:flex">
        <FilterMenu
          label="Repository"
          active={filters.repo ? shortPath(filters.repo, workspace) : undefined}
          clearTo={filters.repo ? to({ repo: "", role: null }) : undefined}
          searchPlaceholder="Filter repositories"
          emptyText={choices.repos ? "No repository matches." : "Repositories could not be loaded just now."}
          options={(choices.repos ?? []).map((name) => ({
            key: name,
            to: to({ repo: name }),
            keywords: name,
            selected: shortPath(filters.repo, workspace) === name,
            label: <span className="truncate font-mono text-[0.8125rem]">{name}</span>,
          }))}
        />
        {filters.repo && (
          <FilterMenu
            label="Role"
            active={filters.role ? ROLE_LABELS[filters.role] : undefined}
            clearTo={filters.role ? to({ role: null }) : undefined}
            searchPlaceholder="Filter roles"
            emptyText="No role matches."
            options={LINK_ROLES.map((role) => ({
              key: role,
              to: to({ role }),
              keywords: role,
              selected: filters.role === role,
              label: <span>{ROLE_LABELS[role]}</span>,
            }))}
          />
        )}
        <FilterMenu
          label="Label"
          active={filters.label || undefined}
          clearTo={filters.label ? to({ label: "" }) : undefined}
          searchPlaceholder="Filter labels"
          emptyText={choices.labels ? "No label matches." : "Labels could not be loaded just now."}
          options={(choices.labels ?? []).map((label) => ({
            key: label.name,
            to: to({ label: label.name }),
            keywords: `${label.name} ${label.description}`,
            selected: label.name === filters.label,
            label: (
              <>
                <Swatch color={label.color} />
                <span className="truncate">{label.name}</span>
              </>
            ),
          }))}
        />
        <FilterMenu
          label="Milestone"
          active={milestoneTitle ?? undefined}
          clearTo={filters.milestone ? to({ milestone: null }) : undefined}
          searchPlaceholder="Filter milestones"
          emptyText={choices.milestones ? "No open milestone matches." : "Milestones could not be loaded just now."}
          options={(choices.milestones ?? []).map((milestone) => ({
            key: String(milestone.number),
            to: to({ milestone: milestone.number }),
            keywords: `${milestone.title} ${milestone.number}`,
            selected: milestone.number === filters.milestone,
            label: <span className="truncate">{milestone.title}</span>,
          }))}
        />
        {(choices.people || choices.me) && (
          <FilterMenu
            label="Assignee"
            active={assigneeLabel || undefined}
            clearTo={filters.assignee ? to({ assignee: "" }) : undefined}
            searchPlaceholder="Filter people"
            emptyText="Nobody matches."
            options={assigneeOptions(choices).map((name) => ({
              key: name,
              to: to({ assignee: name }),
              keywords: name,
              selected: name === filters.assignee,
              label: <span className="truncate">{name === choices.me ? `${name} (you)` : name}</span>,
            }))}
          />
        )}
        {filtered(filters) && (
          <Link to={clear} className="text-xs text-muted hover:text-fg">
            Clear filters
          </Link>
        )}
      </div>

      <div className="flex items-center gap-2 sm:hidden">
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} aria-haspopup="dialog" className="h-10 gap-2 px-3.5">
          <SlidersHorizontal size={15} />
          Filters
          {count > 0 && <span className="rounded-full bg-accent px-1.5 text-[0.6875rem] leading-4.5 font-bold text-bg tabular-nums">{count}</span>}
        </Button>
        {filters.repo && (
          <span className="min-w-0 truncate font-mono text-xs text-muted">
            {shortPath(filters.repo, workspace)}
            {filters.role && ` · ${ROLE_LABELS[filters.role].toLowerCase()}`}
          </span>
        )}
      </div>
      <BottomSheet open={open} onOpenChange={setOpen} title="Filters">
        <div className="flex items-center justify-between px-3 pt-1 pb-2">
          <h2 className="text-base font-semibold">Filters</h2>
          {count > 0 && (
            <Link to={clear} onClick={() => setOpen(false)} className="inline-flex h-10 items-center gap-1 px-2 text-sm text-muted active:text-fg">
              <X size={14} />
              Clear all
            </Link>
          )}
        </div>
        <SheetChoices
          title="Repository"
          failed={choices.repos == null}
          onPick={() => setOpen(false)}
          choices={[
            { key: "any", label: "Any repository", to: to({ repo: "", role: null }), on: !filters.repo },
            ...(choices.repos ?? []).map((name) => ({
              key: name,
              label: <span className="font-mono text-sm">{name}</span>,
              to: to({ repo: name }),
              on: shortPath(filters.repo, workspace) === name,
            })),
          ]}
        />
        {filters.repo && (
          <SheetChoices
            title="Linked as"
            onPick={() => setOpen(false)}
            choices={[
              { key: "any", label: "Any role", to: to({ role: null }), on: !filters.role },
              ...LINK_ROLES.map((role) => ({ key: role, label: ROLE_LABELS[role], to: to({ role }), on: filters.role === role })),
            ]}
          />
        )}
        <SheetChoices
          title="Label"
          failed={choices.labels == null}
          onPick={() => setOpen(false)}
          choices={[
            { key: "any", label: "Any label", to: to({ label: "" }), on: !filters.label },
            ...(choices.labels ?? []).map((label) => ({
              key: label.name,
              label: (
                <span className="inline-flex items-center gap-2">
                  <Swatch color={label.color} />
                  {label.name}
                </span>
              ),
              to: to({ label: label.name }),
              on: label.name === filters.label,
            })),
          ]}
        />
        <SheetChoices
          title="Milestone"
          failed={choices.milestones == null}
          onPick={() => setOpen(false)}
          choices={[
            { key: "any", label: "Any milestone", to: to({ milestone: null }), on: !filters.milestone },
            ...(choices.milestones ?? []).map((milestone) => ({
              key: String(milestone.number),
              label: milestone.title,
              to: to({ milestone: milestone.number }),
              on: milestone.number === filters.milestone,
            })),
          ]}
        />
        {(choices.people || choices.me) && (
          <SheetChoices
            title="Assignee"
            onPick={() => setOpen(false)}
            choices={[
              { key: "any", label: "Anyone", to: to({ assignee: "" }), on: !filters.assignee },
              ...assigneeOptions(choices).map((name) => ({
                key: name,
                label: name === choices.me ? `${name} (you)` : name,
                to: to({ assignee: name }),
                on: name === filters.assignee,
              })),
            ]}
          />
        )}
      </BottomSheet>
    </>
  );
}

/** The people an item can be filtered by assignee: the viewer first, then everyone else in the workspace. */
function assigneeOptions(choices: FilterChoices): string[] {
  const others = (choices.people ?? []).filter((name) => name !== choices.me);
  return choices.me ? [choices.me, ...others] : others;
}

/** One filter in the phone's sheet: a heading and its choices, 48px rows, the one on ticked. */
export function SheetChoices({
  title,
  choices,
  failed = false,
  onPick,
}: {
  title: string;
  choices: { key: string; label: ReactNode; to: string; on: boolean }[];
  failed?: boolean;
  onPick: () => void;
}) {
  return (
    <section className="border-t border-line pt-2 pb-1">
      <h3 className="px-3 pt-1 pb-1 text-xs font-medium text-faint">{title}</h3>
      {failed && <p className="px-3 pb-2 text-xs text-muted">{title === "Repository" ? "Repositories" : `${title}s`} could not be loaded just now.</p>}
      <ul>
        {choices.map((choice) => (
          <li key={choice.key}>
            <Link
              to={choice.to}
              onClick={onPick}
              aria-current={choice.on ? "true" : undefined}
              className={cn(
                "flex h-12 w-full items-center gap-3 rounded-md px-3 text-[0.9375rem] transition-colors active:bg-raised",
                choice.on ? "font-medium text-fg" : "text-fg-soft",
              )}
            >
              <span className="flex w-5 shrink-0 justify-center">{choice.on && <Check size={16} className="text-accent" />}</span>
              <span className="min-w-0 grow truncate">{choice.label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
