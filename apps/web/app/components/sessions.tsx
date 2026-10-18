/**
 * Sessions across a workspace, drawn: a live session's card (who, in what,
 * where, on which work item and pull request, how lately), a row for one
 * that ended, the "cooking now" strip over Work, and Sessions' filters as
 * menus on a computer and a sheet on a phone. What each says is worked
 * out in lib/sessions.ts.
 */
import { Bot, ChevronRight, Cpu, GitBranch, ScrollText, SlidersHorizontal, Terminal, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link } from "react-router";
import { siClaude, siCursor, siGithubcopilot } from "simple-icons";

import type { Harness, PullStatus, SessionKind, SessionState, WorkspaceSession } from "@g1t/contracts";

import { FilterMenu } from "./labels";
import { BottomSheet } from "./mobile";
import { TimeAgo } from "./ui";
import { Avatar } from "./ui/avatar";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Hint } from "./ui/hint";
import { SheetChoices } from "./work-items";
import { ItemIcon, PullIcon } from "./work-icons";
import { cn } from "../lib/cn";
import { HARNESS_NAMES, SESSION_STATES } from "../lib/coordination";
import { KIND_NAMES, type SessionsFilters, narrowed, repoName, runsIn, sessionCost, sessionHref, sessionsQuery, workspaceSessionTitle } from "../lib/sessions";
import { itemPath, sessionsPath } from "../lib/work-items";

const BRANDS: Partial<Record<Harness, { path: string; title: string }>> = {
  claude_code: siClaude,
  claude_managed_agents: siClaude,
  cursor: siCursor,
  copilot: siGithubcopilot,
};

/** What a session runs in, as a mark: the harness's own, g1t's agent's, or a recorded one's. */
export function HarnessMark({ session, size = 14 }: { session: Pick<WorkspaceSession, "kind" | "harness">; size?: number }) {
  const brand = session.harness ? BRANDS[session.harness] : undefined;
  if (brand) {
    return (
      <svg role="img" aria-label={brand.title} viewBox="0 0 24 24" width={size} height={size} className="shrink-0 fill-current text-fg-soft">
        <path d={brand.path} />
      </svg>
    );
  }
  if (session.kind === "agent") return <Cpu size={size} className="shrink-0 text-accent" aria-label="g1t's agent" />;
  if (session.kind === "recorded") return <ScrollText size={size} className="shrink-0 text-faint" aria-label="Recorded" />;
  if (session.harness === "codex") return <Terminal size={size} className="shrink-0 text-fg-soft" aria-label="Codex" />;
  return <Bot size={size} className="shrink-0 text-fg-soft" aria-label="Harness" />;
}

const DOT: Record<SessionState, string> = { active: "bg-success", idle: "bg-warn", ended: "bg-line-strong" };

/** A session's state as a dot: green and breathing while it goes, amber when idle, grey once ended. */
export function StateDot({ state }: { state: SessionState }) {
  return (
    <Hint label={SESSION_STATES[state].hint}>
      <span className="relative flex size-2.5 shrink-0" aria-label={SESSION_STATES[state].label}>
        {state === "active" && <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-50 motion-reduce:hidden" />}
        <span className={cn("relative inline-flex size-2.5 rounded-full", DOT[state])} />
      </span>
    </Hint>
  );
}

/** The work item a session is on, as a chip. */
function ItemChip({ workspace, number, title }: { workspace: string; number: number; title: string | null }) {
  return (
    <Link to={itemPath(workspace, number)} prefetch="intent" className="min-w-0 max-w-full">
      <Badge size="md" className="max-w-full hover:border-line-strong hover:text-fg">
        <ItemIcon item={{ state: "open", reason: null }} size={12} />
        <span className="truncate">
          {title ?? "Work item"} <span className="text-faint">#{number}</span>
        </span>
      </Badge>
    </Link>
  );
}

/** The pull request a session is on, as a chip. */
function PullChip({ repo, number, title, status }: { repo: string; number: number; title: string | null; status: PullStatus | null }) {
  return (
    <Link to={`/${repo}/pull/${number}`} prefetch="intent" className="min-w-0 max-w-full">
      <Badge size="md" className="max-w-full hover:border-line-strong hover:text-fg">
        <PullIcon status={status ?? "open"} size={12} />
        <span className="truncate">
          {title ?? "Pull request"} <span className="text-faint">#{number}</span>
        </span>
      </Badge>
    </Link>
  );
}

/** A session's title, linked where it opens. */
function TitleLink({ session, workspace, className }: { session: WorkspaceSession; workspace: string; className?: string }) {
  const to = sessionHref(workspace, session);
  const title = workspaceSessionTitle(session);
  if (!to) return <span className={className}>{title}</span>;
  return (
    <Link to={to} prefetch="intent" className={cn("hover:text-accent", className)}>
      {title}
    </Link>
  );
}

/** Where it is: the repository, and its branch. */
function Where({ session, workspace }: { session: WorkspaceSession; workspace: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1 font-mono text-xs text-muted">
      <Link to={`/${session.repo}`} className="shrink-0 hover:text-fg">
        {repoName(session.repo, workspace)}
      </Link>
      {session.branch && (
        <>
          <GitBranch size={11} className="shrink-0 text-faint" />
          <span className="truncate">{session.branch}</span>
        </>
      )}
    </span>
  );
}

/** What a harness session cost, quietly, when it reported usage. */
function Cost({ session }: { session: WorkspaceSession }) {
  const cost = sessionCost(session.session);
  if (!cost) return null;
  return (
    <Hint label="Estimated from the tokens its transcript recorded, at Anthropic's list price. Its subagents count on their own sessions.">
      <span className="text-xs text-faint tabular-nums">{cost}</span>
    </Hint>
  );
}

/**
 * A live session: its state, what it is called, who runs it and in what,
 * where, the work item and pull request it is on, its subagents and when
 * it was last heard from. Reads at 375px: everything wraps, nothing scrolls.
 */
export function SessionCard({ session, workspace }: { session: WorkspaceSession; workspace: string }) {
  return (
    <li>
      <Card className="flex h-full flex-col gap-2.5 p-4">
        <div className="flex items-start gap-2.5">
          <span className="mt-1.5">
            <StateDot state={session.state} />
          </span>
          <TitleLink session={session} workspace={workspace} className="min-w-0 grow font-medium wrap-break-word" />
          <span className="mt-0.5 shrink-0 text-xs text-faint">
            <TimeAgo at={session.lastActivityAt} />
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted">
          {session.actor && (
            <Link to={`/u/${session.actor}`} className="flex items-center gap-1.5 hover:text-fg">
              <Avatar name={session.actor} size={18} agent={session.kind !== "recorded"} />
              <span className="font-medium text-fg-soft">{session.actor}</span>
            </Link>
          )}
          <span className="flex items-center gap-1.5">
            <HarnessMark session={session} />
            {runsIn(session)}
          </span>
          <Where session={session} workspace={workspace} />
        </div>
        {session.step && <p className="line-clamp-1 text-xs text-muted">{session.step}</p>}
        <Cost session={session} />
        {(session.item != null || session.pull != null || session.subagents > 0) && (
          <div className="flex flex-wrap items-center gap-2">
            {session.item != null && <ItemChip workspace={workspace} number={session.item} title={session.itemTitle} />}
            {session.pull != null && <PullChip repo={session.repo} number={session.pull} title={session.pullTitle} status={session.pullStatus} />}
            {session.subagents > 0 && (
              <Badge size="md" tone="accent">
                <Bot size={11} />
                {session.subagents} {session.subagents === 1 ? "subagent" : "subagents"}
              </Badge>
            )}
          </div>
        )}
      </Card>
    </li>
  );
}

/** A session in a list of many: one line on a computer, two on a phone. */
export function SessionRow({ session, workspace }: { session: WorkspaceSession; workspace: string }) {
  return (
    <li className="flex items-start gap-3 px-4 py-3 text-sm">
      <span className="mt-1.5">
        <StateDot state={session.state} />
      </span>
      <div className="min-w-0 grow">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <TitleLink session={session} workspace={workspace} className="min-w-0 font-medium wrap-break-word" />
          {session.item != null && (
            <Link to={itemPath(workspace, session.item)} className="text-xs text-faint hover:text-fg">
              #{session.item}
            </Link>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          {session.actor && <span className="font-medium text-fg-soft">{session.actor}</span>}
          <span className="flex items-center gap-1">
            <HarnessMark session={session} size={12} />
            {runsIn(session)}
          </span>
          <Where session={session} workspace={workspace} />
          {session.subagents > 0 && <span>{session.subagents} subagents</span>}
          <Cost session={session} />
        </div>
      </div>
      <span className="shrink-0 text-xs text-faint">
        <TimeAgo at={session.lastActivityAt} />
      </span>
    </li>
  );
}

/**
 * What is cooking now, over Work's list: the live sessions on its work
 * items, a few of them, and the way to all of Sessions.
 */
export function CookingStrip({ sessions, workspace, total, repo }: { sessions: WorkspaceSession[]; workspace: string; total: number; repo?: string | null }) {
  const all = sessionsPath(workspace, { repo });
  return (
    <section aria-label="Cooking now" className="mb-5">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <StateDot state={total > 0 ? "active" : "ended"} />
          Cooking now
          {total > 0 && <span className="font-normal text-muted tabular-nums">{total}</span>}
        </h2>
        <Link to={all} className="inline-flex items-center gap-0.5 text-xs text-muted hover:text-fg">
          Sessions
          <ChevronRight size={13} />
        </Link>
      </div>
      {sessions.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-4 py-3 text-sm text-muted">
          Nothing is running right now. Sessions people and agents start on these work items show here as they go.
        </p>
      ) : (
        <ol className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {sessions.map((session, index) => (
            // A phone shows three; Sessions has the rest.
            <li key={session.id} className={cn("min-w-0", index >= 3 && "max-sm:hidden")}>
              <div className="flex h-full items-start gap-2.5 rounded-lg border border-line bg-surface px-3 py-2.5">
                <span className="mt-1.5">
                  <StateDot state={session.state} />
                </span>
                <div className="min-w-0 grow">
                  <TitleLink session={session} workspace={workspace} className="line-clamp-1 text-sm font-medium" />
                  <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted">
                    <HarnessMark session={session} size={12} />
                    <span className="truncate">
                      {session.actor ?? runsIn(session)}
                      {session.item != null && ` · #${session.item}`} · {repoName(session.repo, workspace)}
                    </span>
                  </p>
                </div>
                <span className="shrink-0 text-[0.6875rem] text-faint">
                  <TimeAgo at={session.lastActivityAt} />
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** The two views of Sessions: what is live now, and every session. */
export function SessionsViews({ workspace, filters }: { workspace: string; filters: SessionsFilters }) {
  const tab = (state: SessionsFilters["state"], label: string) => (
    <Link
      to={`${sessionsPath(workspace)}${sessionsQuery({ ...filters, state })}`}
      aria-current={filters.state === state ? "page" : undefined}
      className={cn(
        "inline-flex h-full items-center rounded-[5px] px-2.5 text-sm transition-colors",
        filters.state === state ? "bg-raised font-medium text-fg" : "text-muted hover:text-fg",
      )}
    >
      {label}
    </Link>
  );
  return (
    <Card tone="plain" radius="lg" className="flex h-8 gap-0.5 rounded-md p-0.5 max-sm:h-10">
      {tab("live", "Live now")}
      {tab("recent", "Every session")}
    </Card>
  );
}

const HARNESSES = Object.keys(HARNESS_NAMES) as Harness[];
const KINDS = Object.keys(KIND_NAMES) as SessionKind[];

/** Sessions' filters: a menu each on a computer, one sheet on a phone. Each choice is a link. */
export function SessionsFiltersBar({ workspace, filters, repos, people, me }: { workspace: string; filters: SessionsFilters; repos: string[]; people: string[]; me: string | null }) {
  const [open, setOpen] = useState(false);
  const to = (change: Partial<SessionsFilters>) => `${sessionsPath(workspace)}${sessionsQuery({ ...filters, ...change })}`;
  const count = [filters.repo, filters.person, filters.harness, filters.kind, filters.item].filter(Boolean).length;
  const clear = to({ repo: null, person: null, harness: null, kind: null, item: null });
  // A work item's own sessions (`?item=12`, from its page): said, with the way back to all of them.
  const onItem = filters.item ? (
    <Link to={to({ item: null })} className="inline-flex h-8 items-center gap-1 rounded-md border border-line px-2.5 text-xs text-fg-soft hover:text-fg" aria-label={`On #${filters.item}: show sessions on every work item`}>
      On #{filters.item}
      <X size={12} />
    </Link>
  ) : null;
  const everyone = me ? [me, ...people.filter((name) => name !== me)] : people;
  const menus: { title: string; active: string | null; any: string; field: keyof SessionsFilters; options: { key: string; label: ReactNode }[] }[] = [
    { title: "Repository", active: filters.repo, any: "Any repository", field: "repo", options: repos.map((name) => ({ key: name, label: <span className="font-mono text-[0.8125rem]">{name}</span> })) },
    { title: "Person", active: filters.person, any: "Anyone", field: "person", options: everyone.map((name) => ({ key: name, label: name === me ? `${name} (you)` : name })) },
    { title: "Harness", active: filters.harness ? HARNESS_NAMES[filters.harness] : null, any: "Any harness", field: "harness", options: HARNESSES.map((key) => ({ key, label: HARNESS_NAMES[key] })) },
    { title: "Kind", active: filters.kind ? KIND_NAMES[filters.kind] : null, any: "Every kind", field: "kind", options: KINDS.map((key) => ({ key, label: KIND_NAMES[key] })) },
  ];
  return (
    <>
      <div className="hidden flex-wrap items-center gap-2 sm:flex">
        {onItem}
        {menus.map((menu) => (
          <FilterMenu
            key={menu.title}
            label={menu.title}
            active={menu.active ?? undefined}
            clearTo={menu.active ? to({ [menu.field]: null }) : undefined}
            searchPlaceholder={`Filter ${menu.title.toLowerCase()}`}
            emptyText="Nothing matches."
            options={menu.options.map((option) => ({
              key: option.key,
              to: to({ [menu.field]: option.key }),
              keywords: option.key,
              selected: filters[menu.field] === option.key,
              label: <span className="truncate">{option.label}</span>,
            }))}
          />
        ))}
        {narrowed(filters) && (
          <Link to={clear} className="text-xs text-muted hover:text-fg">
            Clear filters
          </Link>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-2 sm:hidden">
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} aria-haspopup="dialog" className="h-10 gap-2 px-3.5">
          <SlidersHorizontal size={15} />
          Filters
          {count > 0 && <span className="rounded-full bg-accent px-1.5 text-[0.6875rem] leading-4.5 font-bold text-bg tabular-nums">{count}</span>}
        </Button>
        {onItem}
        {filters.repo && <span className="min-w-0 truncate font-mono text-xs text-muted">{filters.repo}</span>}
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
        {menus.map((menu) => (
          <SheetChoices
            key={menu.title}
            title={menu.title}
            onPick={() => setOpen(false)}
            choices={[
              { key: "any", label: menu.any, to: to({ [menu.field]: null }), on: !filters[menu.field] },
              ...menu.options.map((option) => ({ key: option.key, label: option.label, to: to({ [menu.field]: option.key }), on: filters[menu.field] === option.key })),
            ]}
          />
        ))}
      </BottomSheet>
    </>
  );
}
