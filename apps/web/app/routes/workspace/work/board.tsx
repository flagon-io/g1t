import { Bot, Columns3, GitMerge, Plus } from "lucide-react";
import { Link } from "react-router";

import { LIST_PAGE, type WorkItem, appetiteLetter } from "@g1t/contracts";

import type { Route } from "./+types/board";
import { HarnessMark, StateDot } from "../../../components/sessions";
import { ButtonLink, EmptyState } from "../../../components/ui";
import { Avatar } from "../../../components/ui/avatar";
import { Badge } from "../../../components/ui/badge";
import { Card } from "../../../components/ui/card";
import { Hint } from "../../../components/ui/hint";
import { ParentMark, RepoChips, SubItemsMark } from "../../../components/work-items";
import { ItemIcon } from "../../../components/work-icons";
import {
  type Board,
  type BoardCard,
  DONE_DAYS,
  ITEM_PAGES,
  ON_IT_READS,
  PULL_PAGES,
  type ReadPull,
  STAGES,
  STAGE_INFO,
  type Stage,
  boardItems,
  boardOf,
  cappedNotes,
  onItNotRead,
  planRest,
  planRestWords,
  pullRepos,
  pullsByItem,
  readPages,
  shownStage,
  upNextOf,
} from "../../../lib/board";
import { cn } from "../../../lib/cn";
import { page } from "../../../lib/meta";
import { isFailed, part } from "../../../lib/partial";
import { useRefreshWhile } from "../../../lib/refresh";
import { workPages } from "../../../lib/repo-live";
import { work } from "../../../lib/services.server";
import { getViewer, roleIn, unwrap } from "../../../lib/session.server";
import { onItemSessionTitle, runsIn, sessionHref } from "../../../lib/sessions";
import { useWorkspaceLive } from "../../../lib/use-repo-live";
import { itemPath, newItemPath, repoFilter, shortPath, workPath } from "../../../lib/work-items";
import { type WorkTrail, trailState } from "../../../lib/work-trail";

export function meta({ params, location, ...args }: Route.MetaArgs) {
  const repo = new URLSearchParams(location.search).get("repo");
  return page({ location, ...args }, { title: `Board${repo ? ` · ${repo}` : ""} · Work · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const workspace = params.owner.toLowerCase();
  const query = new URL(request.url).searchParams;
  const repoName = query.get("repo")?.trim() || null;
  const repo = repoName ? repoFilter(workspace, repoName) : null;
  const member = roleIn(viewer, workspace) != null;
  const now = Date.now();
  const since = new Date(now - DONE_DAYS * 86_400_000).toISOString();
  // Only what the stages need, never every open item: the plan's Now and the top of its Next (Up next),
  // the newest open items (where most work in progress is), and what a claim or a live session is on.
  const [plan, recent, closed, claims, live] = await Promise.all([
    part(work.getPlan(workspace, viewer, { repo: repo ?? undefined }), "The plan"),
    readPages((before) => work.listWorkItems(workspace, viewer, { state: "open", repo: repo ?? undefined, before }).then(unwrap), LIST_PAGE, ITEM_PAGES),
    part(work.listWorkItems(workspace, viewer, { state: "closed", repo: repo ?? undefined, closedSince: since }), "Done"),
    part(work.listClaims(workspace, viewer, { state: "active", repo: repo ?? undefined }), "Claims"),
    part(work.listWorkspaceSessions(workspace, viewer, { shown: "live", sessionsOnly: true, repo: repoName ?? undefined, limit: 200 }), "Live sessions"),
  ]);
  const sessions = isFailed(live) || !live.ok ? [] : live.value.sessions;
  const active = isFailed(claims) || !claims.ok ? [] : claims.value;
  const planned = isFailed(plan) || !plan.ok ? null : plan.value;
  const read = boardItems(planned?.now, planned?.next, recent.rows);
  // An older item someone is on: read on its own (one gone, or not the viewer's to see, is left out).
  const older = await Promise.all(
    onItNotRead(read, active, sessions, ON_IT_READS).map((number) =>
      work
        .getWorkItem(workspace, number, viewer)
        .then((found): WorkItem[] => (found.ok && found.value.item.state === "open" ? [found.value.item] : []))
        .catch((): WorkItem[] => []),
    ),
  );
  const open = boardItems(read, older.flat());
  // The open and recently merged pull requests in every repository an open item is linked to.
  const repos = pullRepos(open);
  const readPulls = (path: string, state: "open" | "closed") => {
    const [namespace = "", name = ""] = path.split("/");
    // Not found or refused is an answer: none the viewer can see there.
    const page = (before: number | undefined) =>
      work
        .listPulls({ namespace, name }, viewer, state, { before, mergedSince: state === "closed" ? since : undefined })
        .then((found) => (found.ok ? found.value : []));
    return part(readPages(page, LIST_PAGE, PULL_PAGES), `Pull requests in ${path}`);
  };
  const pulls = await Promise.all(repos.map((path) => Promise.all([readPulls(path, "open"), readPulls(path, "closed")])));
  const found: ReadPull[] = [];
  const unread: string[] = [];
  const capped: string[] = [];
  repos.forEach((path, index) => {
    const both = pulls[index]!;
    if (both.some(isFailed)) unread.push(path);
    for (const pulled of both) {
      if (isFailed(pulled)) continue;
      if (pulled.capped) capped.push(path);
      found.push(...pulled.rows.map((pull) => ({ ...pull, repo: path })));
    }
  });
  const done = isFailed(closed) || !closed.ok ? [] : closed.value;
  const board = boardOf([...open, ...done], { claims: active, sessions, pulls: pullsByItem(found), upNext: upNextOf(planned) }, now);
  return {
    workspace,
    member,
    signedIn: viewer != null,
    repo: repoName,
    board,
    stage: shownStage(query.get("stage"), board),
    // What of the plan is not on the board, for the line under it.
    rest: planRest(planned, board),
    // A part that could not be read: its items may be missing, or stand a column early, and the board says so.
    unavailable: [
      ...[plan, closed, claims, live].filter(isFailed).map((failed) => failed.what),
      ...(unread.length === 0 ? [] : [unread.length === 1 ? `Pull requests in ${unread[0]}` : `Pull requests in ${unread.length} repositories`]),
    ],
    // What was read only in part, said plainly rather than left out silently.
    capped: cappedNotes({ items: recent.capped ? recent.rows.length : null, done: done.length >= LIST_PAGE ? LIST_PAGE : null, pulls: [...new Set(capped)] }),
    live: sessions.length,
  };
}

/** Who is on a card: people's avatars, and the live sessions on it with what they run in. */
function OnIt({ card, workspace }: { card: BoardCard; workspace: string }) {
  const { people, sessions } = card.on;
  if (people.length === 0 && sessions.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      {people.length > 0 && (
        <Hint label={people.join(", ")}>
          <span className="flex -space-x-1.5">
            {people.slice(0, 3).map((name) => (
              <span key={name} className="rounded-full ring-2 ring-surface">
                <Avatar name={name} size={18} />
              </span>
            ))}
          </span>
        </Hint>
      )}
      {people.length > 3 && <span className="text-[0.6875rem] text-faint">+{people.length - 3}</span>}
      {sessions.slice(0, 2).map((session) => {
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
      {sessions.length > 2 && (
        <span className="inline-flex items-center gap-0.5 text-[0.6875rem] text-faint">
          <Bot size={11} />+{sessions.length - 2}
        </span>
      )}
    </div>
  );
}

/** Where a card stands in the plan, when it says something: urgent, in Now, and how much the work is worth. */
function PlanMarks({ item }: { item: WorkItem }) {
  if (item.state !== "open" || (!item.urgent && item.horizon !== "now" && !item.appetite)) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      {item.urgent && <Badge tone="danger">Urgent</Badge>}
      {item.horizon === "now" && <Badge tone="accent">Now</Badge>}
      {item.appetite && (
        <Hint label={`Appetite: ${item.appetite}`}>
          <Badge className="px-1.5">{appetiteLetter(item.appetite)}</Badge>
        </Hint>
      )}
    </span>
  );
}

function ItemCard({ card, workspace, trail }: { card: BoardCard; workspace: string; trail: WorkTrail }) {
  const { item } = card;
  const marks = item.state === "open" && (item.urgent || item.horizon === "now" || item.appetite);
  return (
    <li>
      <Card className="flex flex-col gap-2 p-3 transition-colors hover:border-line-strong">
        <Link
          to={itemPath(workspace, item.number)}
          state={trailState(trail)}
          prefetch="intent"
          className="flex min-w-0 items-start gap-2 text-sm font-medium hover:text-accent"
        >
          <span className="mt-0.5">
            <ItemIcon item={item} size={14} />
          </span>
          <span className="min-w-0 wrap-break-word">
            {item.title} <span className="font-normal text-faint">#{item.number}</span>
          </span>
        </Link>
        {(item.repos.length > 0 || card.merged > 0 || marks || item.parent != null || item.subItemProgress) && (
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <PlanMarks item={item} />
            <ParentMark parent={item.parent} workspace={workspace} />
            <SubItemsMark progress={item.subItemProgress} />
            <RepoChips repos={item.repos} workspace={workspace} />
            {card.merged > 0 && (
              <Hint label={`${card.merged === 1 ? "A pull request" : `${card.merged} pull requests`} for it merged in the last ${DONE_DAYS} days`}>
                <span className="inline-flex shrink-0 items-center gap-1 text-[0.6875rem] text-merged">
                  <GitMerge size={11} />
                  {card.merged} merged
                </span>
              </Hint>
            )}
          </div>
        )}
        <OnIt card={card} workspace={workspace} />
      </Card>
    </li>
  );
}

function Column({ stage, board, workspace }: { stage: Stage; board: Board; workspace: string }) {
  const cards = board[stage];
  // The board left to right, for J and K on each item's page.
  const trail = { numbers: STAGES.flatMap((one) => board[one].map((card) => card.item.number)), label: "Board", href: workPath(workspace, "board") };
  return (
    <section aria-label={STAGE_INFO[stage].label} className="flex min-w-0 flex-col">
      <h2 className="mb-2 flex items-center justify-between gap-2 px-1 text-xs font-medium text-muted">
        <Hint label={STAGE_INFO[stage].hint}>
          <span>{STAGE_INFO[stage].label}</span>
        </Hint>
        <span className="tabular-nums text-faint">{cards.length}</span>
      </h2>
      {cards.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-xs text-faint">Nothing here</p>
      ) : (
        <ol className="space-y-2">
          {cards.map((card) => (
            <ItemCard key={card.item.id} card={card} workspace={workspace} trail={trail} />
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * Work's Board: the workspace's work items as they move, in columns read
 * from what is so. On a phone, one column at a time, picked from a row of
 * stages that wraps rather than scrolling sideways.
 */
export default function BoardPage({ loaderData }: Route.ComponentProps) {
  const { workspace, board, stage, repo, member, signedIn, unavailable, capped, live, rest } = loaderData;
  const restWords = rest ? planRestWords(rest) : null;
  const planTo = workPath(workspace);
  const total = STAGES.reduce((sum, one) => sum + board[one].length, 0);
  const query = (more: Record<string, string>) => `?${new URLSearchParams({ ...(repo ? { repo } : {}), ...more }).toString()}`;
  useWorkspaceLive({ workspace, member, match: workPages.list() });
  // Sessions go idle (after 15 minutes) with no event to say so: looked at again each minute.
  useRefreshWhile(live > 0, 60_000);
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <Columns3 size={17} className="text-accent" />
            Board
            {repo && <span className="font-mono text-sm font-normal text-muted">{shortPath(repo, workspace)}</span>}
          </h1>
          <p className="mt-1 text-sm text-muted">
            Now and what is up next in the plan, then work items as they move: who is on each, what is in review, and what is landing where.
          </p>
        </div>
        {signedIn && (member || repo) && (
          <ButtonLink to={newItemPath(workspace, repo)} className="max-sm:h-10">
            <Plus size={15} />
            New work item
          </ButtonLink>
        )}
      </div>
      {unavailable.length > 0 && (
        <p className="mt-3 text-xs text-warn">
          {unavailable.join(", ")} could not be loaded just now, so this board is partial: some work items may be missing, or stand a column early.
        </p>
      )}
      {capped.length > 0 && <p className="mt-2 text-xs text-muted">{capped.join(" ")}</p>}

      {total === 0 ? (
        <div className="mt-5">
          <EmptyState title={repo ? `No work items linked to ${shortPath(repo, workspace)}` : "No work items yet"}>
            A work item moves across the board by itself: placed in Now or Next, claimed, a session on it, a pull request opened, landed in its repositories,
            closed.{" "}
            {restWords ? (
              <>
                The plan holds {restWords}.{" "}
                <Link to={planTo} className="text-fg underline underline-offset-4">
                  Open the plan
                </Link>
                .
              </>
            ) : (
              <>
                <Link to={workPath(workspace, "all")} className="text-fg underline underline-offset-4">
                  All work items
                </Link>
                .
              </>
            )}
          </EmptyState>
        </div>
      ) : (
        <>
          {/* A phone: the stages as a wrapping row, one column under it. */}
          <nav aria-label="Stages" className="mt-4 flex flex-wrap gap-1.5 md:hidden">
            {STAGES.map((one) => (
              <Link
                key={one}
                to={query({ stage: one })}
                replace
                preventScrollReset
                aria-current={stage === one ? "page" : undefined}
                className={cn(
                  "inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors",
                  stage === one ? "border-accent/50 bg-accent/10 font-medium text-fg" : "border-line text-muted active:bg-raised",
                )}
              >
                {STAGE_INFO[one].label}
                <span className="text-xs tabular-nums text-faint">{board[one].length}</span>
              </Link>
            ))}
          </nav>
          <div className="mt-4 md:hidden">
            <Column stage={stage} board={board} workspace={workspace} />
          </div>
          <div className="mt-5 hidden gap-3 md:grid md:grid-cols-5">
            {STAGES.map((one) => (
              <Column key={one} stage={one} board={board} workspace={workspace} />
            ))}
          </div>
          {restWords && (
            <p className="mt-5 text-sm text-muted">
              Everything not on the board is in the plan: {restWords}.{" "}
              <Link to={planTo} className="font-medium text-fg underline-offset-4 hover:underline">
                Open the plan
              </Link>
            </p>
          )}
        </>
      )}
    </div>
  );
}
