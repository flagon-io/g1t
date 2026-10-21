import { Check, CheckCircle2, ChevronRight, Inbox, ListOrdered, ListTree, Plus } from "lucide-react";
import { type DragEvent, useEffect, useMemo, useState } from "react";
import { Link, redirect, useFetcher } from "react-router";

import type { PlanGroup, WorkItem } from "@g1t/contracts";

import type { Route } from "./+types/plan";
import { CapBar, PlanRow, PlanRowMenu, type RowDrag } from "../../../components/plan";
import { ButtonLink, TimeAgo } from "../../../components/ui";
import { Alert } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../../components/ui/collapsible";
import { cn } from "../../../lib/cn";
import { page } from "../../../lib/meta";
import { isFailed, part } from "../../../lib/partial";
import {
  type Move,
  type OnIt,
  type PlanView,
  applyMove,
  blockersToRead,
  capState,
  dropPosition,
  groupSubItems,
  listRedirect,
  moreText,
  moveForm,
  moveFrom,
  onItems,
  planInput,
  planOptions,
  planOptionsPath,
  progressOf,
  quietLine,
  setAsideLine,
  setAsidePath,
  triageLine,
  triagePath,
  waitingOn,
} from "../../../lib/plan";
import { useRefreshWhile } from "../../../lib/refresh";
import { workPages } from "../../../lib/repo-live";
import { work } from "../../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../../lib/session.server";
import { useWorkspaceLive } from "../../../lib/use-repo-live";
import { canItem } from "../../../lib/work-access";
import { itemPath, newItemPath, shortPath, workPath } from "../../../lib/work-items";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Plan · Work · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const workspace = params.owner.toLowerCase();
  const query = new URL(request.url).searchParams;
  // `-/work` with the list's filters is an old link to the list.
  const moved = listRedirect(workspace, query);
  if (moved) throw redirect(moved);
  const { all, group } = planOptions(query);
  const member = roleIn(viewer, workspace) != null;
  // The plan is what the page is; who is on each item is a part each.
  const [plan, claims, live] = await Promise.all([
    work.getPlan(workspace, viewer, { all }),
    part(work.listClaims(workspace, viewer, { state: "active" }), "Claims"),
    part(work.listWorkspaceSessions(workspace, viewer, { shown: "live", sessionsOnly: true, limit: 200 }), "Live sessions"),
  ]);
  const { workspace: _, ...shown } = unwrap(plan);
  const rows = [...shown.now, ...shown.next];
  // What each waits on: the open ones in the plan are known; the rest are looked up, a few at most.
  const open = new Set(rows.map((item) => item.number));
  const looked = await Promise.all(
    blockersToRead(rows, open).map((number) =>
      work
        .getWorkItem(workspace, number, viewer)
        .then((found) => (found.ok && found.value.item.state === "closed" ? number : null))
        .catch(() => null),
    ),
  );
  const sessions = isFailed(live) || !live.ok ? [] : live.value.sessions;
  return {
    workspace,
    member,
    signedIn: viewer != null,
    all,
    group,
    plan: shown,
    triageTotal: shown.triageTotal,
    on: onItems(rows, isFailed(claims) || !claims.ok ? [] : claims.value, sessions),
    closedBlockers: looked.filter((number): number is number => number != null),
    // Anyone with Triage places work and ranks Next and Later; Now takes
    // the right to manage milestones, which the work service checks again.
    canPlan: canItem(viewer, workspace, null, "triage"),
    canNow: canItem(viewer, workspace, null, "manage_labels"),
    canOpen: viewer != null && member,
    unavailable: [claims, live].filter(isFailed).map((failed) => failed.what),
    live: sessions.length,
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const workspace = params.owner.toLowerCase();
  const form = await request.formData();
  const number = Number(form.get("number"));
  if (!Number.isInteger(number) || number < 1) return { error: "Choose a work item to move.", number: null };
  const input = planInput(form);
  if (typeof input === "string") return { error: input, number };
  const result = await work.planWorkItem(user, workspace, number, input);
  return result.ok ? { error: null, number } : { error: result.error.message, number };
}

/** A list a row can be dropped into. */
type Lane = "now" | "next" | "later";

type Dragging = { item: WorkItem; from: Lane };
type Over = { lane: Lane; index: number };

/**
 * Work's Plan: Now, what the workspace has taken on, against its cap;
 * Next, ranked, the top taken first; Later, grouped by repository; and how
 * many are set aside. Rows move by dragging within and between Now and
 * Next (and onto Later), or from each row's menu, which is how a keyboard
 * or a phone moves them.
 */
export default function PlanPage({ loaderData }: Route.ComponentProps) {
  const { workspace, member, canPlan, canNow, on, all, group } = loaderData;
  const options = { all, group };
  const fetcher = useFetcher<typeof action>();
  useWorkspaceLive({ workspace, member, match: workPages.list() });
  // Sessions go idle (after 15 minutes) with no event to say so: looked at again each minute.
  useRefreshWhile(loaderData.live > 0, 60_000);

  // What a move from a Later group brings with it, to show it where it lands before the answer.
  const [carried, setCarried] = useState<WorkItem | null>(null);
  const pending = fetcher.formData ? moveFrom(fetcher.formData) : null;
  const plan: PlanView = pending ? applyMove(loaderData.plan, pending, carried?.number === pending.number ? carried : undefined) : loaderData.plan;
  const closed = useMemo(() => new Set(loaderData.closedBlockers), [loaderData.closedBlockers]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) setError(fetcher.data.error);
  }, [fetcher.state, fetcher.data]);

  const submit = (move: Move, item?: WorkItem) => {
    setError(null);
    setCarried(item ?? null);
    fetcher.submit(moveForm(move), { method: "post" });
  };

  // Dragging: what is held, and the gap it would land in.
  const [dragging, setDragging] = useState<Dragging | null>(null);
  const [over, setOver] = useState<Over | null>(null);
  const lists: Record<"now" | "next", number[]> = { now: plan.now.map((item) => item.number), next: plan.next.map((item) => item.number) };
  const accepts = (lane: Lane) => {
    if (!dragging) return false;
    // Into or out of Now, or within it, takes the right to manage milestones.
    if ((lane === "now" || dragging.from === "now") && !canNow) return false;
    return !(lane === "later" && dragging.from === "later");
  };
  const drop = (lane: Lane, index: number) => {
    const held = dragging;
    setDragging(null);
    setOver(null);
    if (!held || !accepts(lane)) return;
    if (lane === "later") {
      submit({ number: held.item.number, horizon: "later" }, held.item);
      return;
    }
    const position = dropPosition(lists[lane], index, held.item.number);
    if (!position) return;
    submit({ number: held.item.number, horizon: lane, ...position }, held.item);
  };
  const rowDrag = (lane: Lane, item: WorkItem, index: number): RowDrag | undefined => {
    // Grouped, rows are not in the plan's order, so a drop could not say where it lands: the menu still moves them.
    if (!canPlan || group) return undefined;
    const draggable = item.horizon !== "now" || canNow;
    return {
      draggable,
      dragging: dragging?.item.number === item.number,
      edge:
        over?.lane === lane && lane !== "later"
          ? over.index === index
            ? "above"
            : over.index === index + 1 && index === lists[lane].length - 1
              ? "below"
              : null
          : null,
      onDragStart: (event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", `#${item.number}`);
        setDragging({ item, from: lane });
      },
      onDragEnd: () => {
        setDragging(null);
        setOver(null);
      },
      onDragOver: (event) => {
        if (!accepts(lane)) return;
        event.preventDefault();
        event.stopPropagation();
        if (lane === "later") return setOver({ lane, index: 0 });
        const box = event.currentTarget.getBoundingClientRect();
        const at = index + (event.clientY > box.top + box.height / 2 ? 1 : 0);
        if (over?.lane !== lane || over.index !== at) setOver({ lane, index: at });
      },
      onDrop: (event) => {
        event.preventDefault();
        event.stopPropagation();
        drop(lane, over?.lane === lane ? over.index : index);
      },
    };
  };
  const laneDrop = (lane: Lane) => ({
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!accepts(lane)) return;
      event.preventDefault();
      const end = lane === "later" ? 0 : lists[lane].length;
      if (over?.lane !== lane) setOver({ lane, index: end });
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null) && over?.lane === lane) setOver(null);
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      drop(lane, over?.lane === lane ? over.index : lane === "later" ? 0 : lists[lane].length);
    },
  });

  const cap = capState(plan.now.length, loaderData.plan.nowCap);
  // How each in Now stands, and the week: read with the plan, and left as they are while a move is on its way.
  const { landed, triageWaiting, setAsideRecent } = loaderData.plan;
  const progress = useMemo(() => progressOf(loaderData.plan.progress), [loaderData.plan.progress]);
  const quiet = quietLine(loaderData.plan.progress.filter((one) => one.quiet).length);
  const letGo = setAsideLine(setAsideRecent);
  const nextMore = moreText(plan.next.length, plan.nextTotal);
  // A horizon's rows, each sub-item under its parent when the plan groups them; each keeps its rank.
  const rows = (items: WorkItem[]) => (group ? groupSubItems(items) : items.map((item, index) => ({ item, depth: 0, index })));
  const row = (lane: "now" | "next", item: WorkItem, index: number, rank: number, depth = 0) => (
    <PlanRow
      depth={depth}
      key={item.id}
      item={item}
      rank={rank}
      workspace={workspace}
      on={on[item.number] as OnIt | undefined}
      waiting={waitingOn(item, closed)}
      drag={rowDrag(lane, item, index)}
      menu={canPlan ? <PlanRowMenu item={item} list={lists[lane]} canNow={canNow} onMove={(move) => submit(move, item)} /> : undefined}
      progress={lane === "now" ? progress[item.number] : undefined}
    />
  );

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <ListOrdered size={17} className="text-accent" />
            Plan
          </h1>
          <p className="mt-1 text-sm text-muted">
            Now is what the workspace has taken on. Next is ranked, and the top is taken first. Later is wanted, and waits.
            {!canPlan && loaderData.signedIn && " You can read the plan; placing work takes the Triage role."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Remembered in the address, as Show all is. */}
          <Link
            to={planOptionsPath(workspace, options, { group: !group })}
            replace
            preventScrollReset
            aria-current={group ? "true" : undefined}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm transition-colors max-sm:h-10",
              group ? "border-accent/50 bg-accent/10 text-fg" : "border-line text-muted hover:bg-surface hover:text-fg",
            )}
          >
            {group ? <Check size={14} className="text-accent" /> : <ListTree size={14} />}
            Group sub-items
          </Link>
          {loaderData.canOpen && (
            <ButtonLink to={newItemPath(workspace)} className="max-sm:h-10">
              <Plus size={15} />
              New work item
            </ButtonLink>
          )}
        </div>
      </div>

      {loaderData.unavailable.length > 0 && (
        <p className="mt-3 text-xs text-warn">{loaderData.unavailable.join(" and ")} could not be loaded just now, so who is on each item may be missing.</p>
      )}
      {error && (
        <Alert role="alert" className="mt-3 flex items-start justify-between gap-3">
          <span>{error}</span>
          <Button variant="ghost" size="xs" onClick={() => setError(null)} className="-my-1 text-danger">
            Dismiss
          </Button>
        </Alert>
      )}
      {plan.triageTotal > 0 && (
        <Link
          to={triagePath(workspace)}
          className="mt-4 flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm text-muted transition-colors hover:border-line-strong hover:text-fg"
        >
          <Inbox size={15} className="shrink-0 text-accent" />
          <span className="min-w-0 grow">{triageLine(plan.triageTotal, Math.min(triageWaiting, plan.triageTotal))}</span>
          <ChevronRight size={15} className="shrink-0" />
        </Link>
      )}

      <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card className="min-w-0 self-start">
          <section
            aria-labelledby="plan-now"
            {...laneDrop("now")}
            className={cn("rounded-t-xl", over?.lane === "now" && plan.now.length === 0 && "bg-accent/5")}
          >
            <header className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 pt-3 pb-2">
              <h2 id="plan-now" className="text-sm font-semibold">
                Now
              </h2>
              <span className="text-xs text-faint">what the workspace is on</span>
              <span className="ml-auto">
                <CapBar cap={cap} />
              </span>
            </header>
            {cap.over && <p className="px-4 pb-2 text-xs text-warn">Now is past its cap of {cap.cap}. Finish something, or move one back to Next.</p>}
            {plan.now.length === 0 ? (
              <p className="mx-4 mb-3 rounded-lg border border-dashed border-line px-3 py-4 text-center text-xs text-faint">
                {canNow ? "Nothing in Now. Move what you're taking on from Next." : "Nothing in Now yet."}
              </p>
            ) : (
              <ol className="px-2 pb-2">{rows(plan.now).map(({ item, index, depth }) => row("now", item, index, index + 1, depth))}</ol>
            )}
          </section>
          <section
            aria-labelledby="plan-next"
            {...laneDrop("next")}
            className={cn("border-t border-line", over?.lane === "next" && plan.next.length === 0 && "bg-accent/5")}
          >
            <header className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 pt-3 pb-2">
              <h2 id="plan-next" className="text-sm font-semibold">
                Next
              </h2>
              <span className="text-xs text-faint">{canPlan && !group && <span className="max-sm:hidden">drag to rank · </span>}the top is taken first</span>
              <span className="ml-auto font-mono text-xs tabular-nums text-faint">{plan.nextTotal}</span>
            </header>
            {plan.next.length === 0 ? (
              <p className="mx-4 mb-3 rounded-lg border border-dashed border-line px-3 py-4 text-center text-xs text-faint">
                {canPlan ? "Nothing in Next. Place work here from Triage or Later, in the order it should be taken." : "Nothing in Next yet."}
              </p>
            ) : (
              <ol className="px-2 pb-2">{rows(plan.next).map(({ item, index, depth }) => row("next", item, index, plan.now.length + index + 1, depth))}</ol>
            )}
            {nextMore && !all && (
              <div className="px-4 pb-3">
                <ButtonLink
                  to={planOptionsPath(workspace, options, { all: true })}
                  variant="outline"
                  size="sm"
                  className="w-full border-dashed"
                  preventScrollReset
                >
                  Show all {plan.nextTotal.toLocaleString("en-US")}
                </ButtonLink>
              </div>
            )}
            {all && plan.nextTotal > 10 && (
              <div className="px-4 pb-3">
                <ButtonLink to={planOptionsPath(workspace, options, { all: false })} variant="ghost" size="sm" className="w-full" preventScrollReset>
                  Show the top 10
                </ButtonLink>
              </div>
            )}
          </section>
        </Card>

        <div className="grid min-w-0 content-start gap-4">
          <Card asChild className="min-w-0">
            <section aria-labelledby="plan-week">
              <header className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 pt-3 pb-2">
                <h2 id="plan-week" className="text-sm font-semibold">
                  This week
                </h2>
                <span className="text-xs text-faint">what landed from Now</span>
              </header>
              {landed.length === 0 ? (
                <p className="px-4 pb-2 text-xs text-faint">Nothing has landed from Now in the last 7 days.</p>
              ) : (
                <ul className="px-2 pb-1">
                  {landed.map((item) => (
                    <li key={item.id}>
                      <Link
                        to={itemPath(workspace, item.number)}
                        prefetch="intent"
                        className="flex min-w-0 items-baseline gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-raised/60 hover:text-accent"
                      >
                        <CheckCircle2 size={13} className="shrink-0 translate-y-0.5 text-success" aria-hidden />
                        <span className="min-w-0 grow truncate">
                          <span className="mr-1.5 font-mono text-xs text-faint">#{item.number}</span>
                          {item.title}
                        </span>
                        {item.closedAt && (
                          <span className="shrink-0 text-xs text-faint">
                            <TimeAgo at={item.closedAt} />
                          </span>
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              {(quiet || letGo) && (
                <div className="space-y-1 border-t border-line px-4 py-2.5 text-xs text-muted">
                  {quiet && <p>{quiet}</p>}
                  {letGo && (
                    <p>
                      <Link to={setAsidePath(workspace)} className="hover:text-fg">
                        {letGo}
                      </Link>
                      .
                    </p>
                  )}
                </div>
              )}
              {!quiet && !letGo && <div className="pb-2" />}
            </section>
          </Card>
          <Card asChild className={cn("min-w-0", over?.lane === "later" && "border-accent/60 bg-accent/5")}>
            <section aria-labelledby="plan-later" {...laneDrop("later")}>
              <header className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 pt-3 pb-2">
                <h2 id="plan-later" className="text-sm font-semibold">
                  Later
                </h2>
                <span className="text-xs text-faint">by repository</span>
                <span className="ml-auto font-mono text-xs tabular-nums text-faint">{plan.laterTotal}</span>
              </header>
              {plan.later.length === 0 ? (
                <p className="mx-4 mb-3 rounded-lg border border-dashed border-line px-3 py-4 text-center text-xs text-faint">
                  {canPlan ? "Nothing in Later. Drop what you want but won't take soon here." : "Nothing in Later."}
                </p>
              ) : (
                <ul className="px-2 pb-2">
                  {plan.later.map((later) => (
                    <LaterGroup
                      key={later.repo ?? ""}
                      group={later}
                      workspace={workspace}
                      canPlan={canPlan}
                      canNow={canNow}
                      grouped={group}
                      hidden={pending?.number ?? null}
                      onMove={submit}
                      onDrag={(item) => setDragging(item ? { item, from: "later" } : null)}
                    />
                  ))}
                </ul>
              )}
            </section>
          </Card>
          <Card className="flex items-center gap-3 px-4 py-3">
            <h2 className="text-sm font-semibold">Set aside</h2>
            {plan.setAsideTotal > 0 ? (
              <Link to={setAsidePath(workspace)} className="ml-auto text-sm text-muted hover:text-fg">
                {plan.setAsideTotal.toLocaleString("en-US")} <span className="text-faint">in All items</span>
              </Link>
            ) : (
              <span className="ml-auto text-sm text-faint">None</span>
            )}
          </Card>
          <p className="px-1 text-xs text-faint">
            Set aside keeps what nobody means to do soon out of every view but search. Nothing is deleted: move one back from its page.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * One repository's Later, collapsed to its count; opened, its items (at
 * most 100), read when it opens, each with its menu, and draggable to Now
 * or Next.
 */
function LaterGroup({
  group,
  workspace,
  canPlan,
  canNow,
  grouped,
  hidden,
  onMove,
  onDrag,
}: {
  group: PlanGroup;
  workspace: string;
  canPlan: boolean;
  canNow: boolean;
  /** Each sub-item under its parent, when both are in this group. */
  grouped: boolean;
  /** One being moved just now, left out until the plan says where it went. */
  hidden: number | null;
  onMove: (move: Move, item: WorkItem) => void;
  onDrag: (item: WorkItem | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const fetcher = useFetcher<{ items: WorkItem[]; more: boolean } | { error: string }>();
  const url = `${workPath(workspace, "plan/later")}?${new URLSearchParams({ repo: group.repo ?? "" }).toString()}`;
  // Read when it opens, and again when its count changes while it is open.
  useEffect(() => {
    if (open) fetcher.load(url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, url, group.count]);
  const data = fetcher.data;
  const items = data && "items" in data ? data.items.filter((item) => item.number !== hidden) : null;
  const name = group.repo ? shortPath(group.repo, workspace) : "Filed in the workspace";
  return (
    <li>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-raised/60">
          <ChevronRight size={14} className="shrink-0" />
          <span className={cn("min-w-0 grow truncate", group.repo ? "font-mono text-[0.8125rem]" : "text-sm")}>{name}</span>
          <span className="font-mono text-xs tabular-nums text-faint">{group.count}</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {items == null ? (
            data && "error" in data ? (
              <p className="px-3 py-2 text-xs text-danger">{data.error}</p>
            ) : (
              <p className="px-3 py-2 text-xs text-faint">Loading…</p>
            )
          ) : items.length === 0 ? (
            <p className="px-3 py-2 text-xs text-faint">Nothing here now.</p>
          ) : (
            <ul className="pl-4">
              {(grouped ? groupSubItems(items) : items.map((item) => ({ item, depth: 0 }))).map(({ item, depth }) => (
                <PlanRow
                  key={item.id}
                  item={item}
                  depth={depth}
                  rank={null}
                  workspace={workspace}
                  on={undefined}
                  waiting={[]}
                  drag={
                    canPlan
                      ? {
                          draggable: true,
                          dragging: false,
                          edge: null,
                          onDragStart: (event) => {
                            event.dataTransfer.effectAllowed = "move";
                            event.dataTransfer.setData("text/plain", `#${item.number}`);
                            onDrag(item);
                          },
                          onDragEnd: () => onDrag(null),
                          onDragOver: () => {},
                          onDrop: () => {},
                        }
                      : undefined
                  }
                  menu={canPlan ? <PlanRowMenu item={item} list={null} canNow={canNow} onMove={(move) => onMove(move, item)} /> : undefined}
                />
              ))}
            </ul>
          )}
          {data && "more" in data && data.more && (
            <p className="px-3 pb-2 text-xs text-faint">Showing the first 100 of {group.count.toLocaleString("en-US")}.</p>
          )}
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}
