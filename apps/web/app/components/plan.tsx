import { ArrowDown, ArrowUp, ArrowUpToLine, Bot, CornerDownRight, GripVertical, MoreHorizontal } from "lucide-react";
import type { DragEvent, ReactNode } from "react";
import { Link } from "react-router";

import { type Appetite, type Horizon, type WorkItem, appetiteLetter, horizonLabel } from "@g1t/contracts";

import { HarnessMark, StateDot } from "./sessions";
import { RepoChips } from "./work-items";
import { Avatar } from "./ui/avatar";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Hint } from "./ui/hint";
import { Progress } from "./ui/progress";
import { cn } from "../lib/cn";
import { APPETITE_HINTS, type CapState, type Move, type OnIt, type Position, menuHorizons, moveDown, moveUp, waitingLabel } from "../lib/plan";
import { onItemSessionTitle, runsIn, sessionHref } from "../lib/sessions";
import { itemPath } from "../lib/work-items";

/** A work item's appetite as its letter in a small square, with what it means on hover. */
export function AppetiteChip({ appetite }: { appetite: Appetite }) {
  return (
    <Hint label={APPETITE_HINTS[appetite]}>
      <Badge shape="tag" className="size-5 justify-center p-0 font-mono" aria-label={APPETITE_HINTS[appetite]}>
        {appetiteLetter(appetite)}
      </Badge>
    </Hint>
  );
}

/** Who is on a work item: people's avatars, and the live sessions on it with what they run in, as the board shows them. */
export function OnItLine({ on, workspace }: { on: OnIt | undefined; workspace: string }) {
  if (!on || (on.people.length === 0 && on.sessions.length === 0)) return null;
  const { people, sessions } = on;
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      {people.length > 0 && (
        <Hint label={people.join(", ")}>
          <span className="flex -space-x-1.5">
            {people.slice(0, 3).map((name) => (
              <span key={name} className="rounded-full ring-2 ring-surface">
                <Avatar name={name} size={16} />
              </span>
            ))}
          </span>
        </Hint>
      )}
      {people.length > 3 && <span className="text-[0.6875rem] text-faint">+{people.length - 3}</span>}
      {sessions.slice(0, 1).map((session) => {
        const to = sessionHref(workspace, session);
        const label = (
          <span className="inline-flex min-w-0 items-center gap-1 text-[0.6875rem] text-muted">
            <StateDot state={session.state} />
            <HarnessMark session={session} size={11} />
            <span className="truncate">{session.actor ?? runsIn(session)}</span>
          </span>
        );
        return (
          <Hint key={session.id} label={`${onItemSessionTitle(session)} · ${runsIn(session)}`}>
            {to ? (
              <Link to={to} className="min-w-0 hover:text-fg">
                {label}
              </Link>
            ) : (
              label
            )}
          </Hint>
        );
      })}
      {sessions.length > 1 && (
        <span className="inline-flex items-center gap-0.5 text-[0.6875rem] text-faint">
          <Bot size={11} />+{sessions.length - 1}
        </span>
      )}
    </span>
  );
}

/** Now's count against its cap, and a bar that turns to the warning color past it. */
export function CapBar({ cap }: { cap: CapState }) {
  return (
    <div className="flex items-center gap-2">
      <Progress
        value={cap.share * 100}
        aria-label={`${cap.count} of ${cap.cap} in Now`}
        className="h-1 w-16 sm:w-24"
        indicatorClassName={cap.over ? "bg-warn" : undefined}
      />
      <span className={cn("font-mono text-xs tabular-nums", cap.over ? "text-warn" : "text-faint")}>
        {cap.count} of {cap.cap}
      </span>
    </div>
  );
}

/**
 * A row's menu: the keyboard's and a phone's way to make every move a drag
 * makes. Up, down and to the top within the list it is in (`list`, the
 * numbers shown, when it is ranked there), then to each other horizon.
 */
export function PlanRowMenu({
  item,
  list,
  canNow,
  onMove,
}: {
  item: WorkItem;
  /** The ranked list it is in, as shown, top first; null where it is not ranked (Later). */
  list: readonly number[] | null;
  canNow: boolean;
  onMove: (move: Move) => void;
}) {
  const rankable = list != null && (item.horizon !== "now" || canNow);
  const move = (position: Position | null, horizon: Horizon = item.horizon) => position && onMove({ number: item.number, horizon, ...position });
  const up = list ? moveUp(list, item.number) : null;
  const down = list ? moveDown(list, item.number) : null;
  const elsewhere = menuHorizons(item.horizon, canNow);
  if (!rankable && elsewhere.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={`Move #${item.number}`} className="text-faint max-sm:size-9">
          <MoreHorizontal size={15} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {rankable && (
          <>
            <DropdownMenuItem disabled={!up} onSelect={() => move(up)}>
              <ArrowUp />
              Move up
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!down} onSelect={() => move(down)}>
              <ArrowDown />
              Move down
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!up} onSelect={() => move({ top: true })}>
              <ArrowUpToLine />
              Move to top
            </DropdownMenuItem>
            {elsewhere.length > 0 && <DropdownMenuSeparator />}
          </>
        )}
        {elsewhere.length > 0 && <DropdownMenuLabel>Move to</DropdownMenuLabel>}
        {elsewhere.map((horizon) => (
          <DropdownMenuItem key={horizon} onSelect={() => move({}, horizon)}>
            <CornerDownRight />
            {horizonLabel(horizon)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** What a row needs to be dragged and dropped on; none for a viewer who cannot move it. */
export type RowDrag = {
  onDragStart: (event: DragEvent<HTMLLIElement>) => void;
  onDragEnd: () => void;
  onDragOver: (event: DragEvent<HTMLLIElement>) => void;
  onDrop: (event: DragEvent<HTMLLIElement>) => void;
  /** Where a drop would land, drawn as a line: above this row or below it. */
  edge: "above" | "below" | null;
  dragging: boolean;
  draggable: boolean;
};

/**
 * One work item in the plan: its place (`rank`), urgent first, its number
 * and title, its repositories, what it waits on, who is on it, its
 * appetite, and its menu.
 */
export function PlanRow({
  item,
  rank,
  workspace,
  on,
  waiting,
  drag,
  menu,
}: {
  item: WorkItem;
  rank: number | null;
  workspace: string;
  on: OnIt | undefined;
  /** Open work items it is blocked by. */
  waiting: readonly number[];
  drag?: RowDrag;
  menu?: ReactNode;
}) {
  return (
    <li
      draggable={drag?.draggable || undefined}
      onDragStart={drag?.onDragStart}
      onDragEnd={drag?.onDragEnd}
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}
      className={cn(
        "group relative grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-2 transition-colors hover:bg-raised/60",
        drag?.dragging && "opacity-40",
        drag?.edge === "above" && "shadow-[inset_0_2px_0_0_var(--color-accent)]",
        drag?.edge === "below" && "shadow-[inset_0_-2px_0_0_var(--color-accent)]",
      )}
    >
      <span className="relative flex justify-end font-mono text-xs tabular-nums text-faint">
        {drag?.draggable && (
          <GripVertical
            size={14}
            aria-hidden
            className="absolute top-1/2 -left-1 hidden -translate-y-1/2 cursor-grab text-faint opacity-0 group-hover:opacity-100 sm:block"
          />
        )}
        {rank ?? ""}
      </span>
      <div className="min-w-0">
        {/* One line on a computer; two on a phone, where the title has less room. */}
        <Link
          to={itemPath(workspace, item.number)}
          prefetch="intent"
          className="line-clamp-2 min-w-0 text-sm font-medium wrap-break-word hover:text-accent sm:line-clamp-1"
        >
          {item.urgent && (
            <Badge tone="danger" className="mr-1.5 align-[1px]">
              Urgent
            </Badge>
          )}
          <span className="mr-1.5 font-mono text-xs font-normal text-faint">#{item.number}</span>
          {item.title}
        </Link>
        {(item.repos.length > 0 || waiting.length > 0 || (on && (on.people.length > 0 || on.sessions.length > 0))) && (
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-faint">
            <RepoChips repos={item.repos} workspace={workspace} max={1} />
            {waiting.length > 0 && (
              <Badge tone="warn" className="max-w-full">
                <span className="truncate">{waitingLabel(waiting)}</span>
              </Badge>
            )}
            <OnItLine on={on} workspace={workspace} />
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {item.appetite && <AppetiteChip appetite={item.appetite} />}
        {menu}
      </div>
    </li>
  );
}
