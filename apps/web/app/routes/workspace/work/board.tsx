import { Bot, Columns3, GitMerge, Plus } from "lucide-react";
import { Link } from "react-router";

import { LIST_PAGE } from "@g1t/contracts";

import type { Route } from "./+types/board";
import { HarnessMark, StateDot } from "../../../components/sessions";
import { ButtonLink, EmptyState } from "../../../components/ui";
import { Avatar } from "../../../components/ui/avatar";
import { Card } from "../../../components/ui/card";
import { Hint } from "../../../components/ui/hint";
import { RepoChips } from "../../../components/work-items";
import { ItemIcon } from "../../../components/work-icons";
import {
  type Board,
  type BoardCard,
  DONE_DAYS,
  ITEM_PAGES,
  PULL_PAGES,
  type ReadPull,
  STAGES,
  STAGE_INFO,
  type Stage,
  boardOf,
  cappedNotes,
  pullRepos,
  pullsByItem,
  readPages,
  shownStage,
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
  // The open work items are what the board is, every page of them; what says where each stands, a part each.
  const [open, closed, claims, live] = await Promise.all([
    readPages((before) => work.listWorkItems(workspace, viewer, { state: "open", repo: repo ?? undefined, before }).then(unwrap), LIST_PAGE, ITEM_PAGES),
    part(work.listWorkItems(workspace, viewer, { state: "closed", repo: repo ?? undefined, closedSince: since }), "Done"),
    part(work.listClaims(workspace, viewer, { state: "active", repo: repo ?? undefined }), "Claims"),
    part(work.listWorkspaceSessions(workspace, viewer, { shown: "live", sessionsOnly: true, repo: repoName ?? undefined, limit: 200 }), "Live sessions"),
  ]);
  const sessions = isFailed(live) || !live.ok ? [] : live.value.sessions;
  // The open and recently merged pull requests in every repository an open item is linked to.
  const repos = pullRepos(open.rows);
  const read = (path: string, state: "open" | "closed") => {
    const [namespace = "", name = ""] = path.split("/");
    // Not found or refused is an answer: none the viewer can see there.
    const page = (before: number | undefined) =>
      work
        .listPulls({ namespace, name }, viewer, state, { before, mergedSince: state === "closed" ? since : undefined })
        .then((found) => (found.ok ? found.value : []));
    return part(readPages(page, LIST_PAGE, PULL_PAGES), `Pull requests in ${path}`);
  };
  const pulls = await Promise.all(repos.map((path) => Promise.all([read(path, "open"), read(path, "closed")])));
  const readPulls: ReadPull[] = [];
  const unread: string[] = [];
  const capped: string[] = [];
  repos.forEach((path, index) => {
    const both = pulls[index]!;
    if (both.some(isFailed)) unread.push(path);
    for (const found of both) {
      if (isFailed(found)) continue;
      if (found.capped) capped.push(path);
      readPulls.push(...found.rows.map((pull) => ({ ...pull, repo: path })));
    }
  });
  const done = isFailed(closed) || !closed.ok ? [] : closed.value;
  const board = boardOf([...open.rows, ...done], { claims: isFailed(claims) || !claims.ok ? [] : claims.value, sessions, pulls: pullsByItem(readPulls) }, now);
  return {
    workspace,
    member,
    signedIn: viewer != null,
    repo: repoName,
    board,
    stage: shownStage(query.get("stage"), board),
    // A part that could not be read: its items may be missing, or stand a column early, and the board says so.
    unavailable: [
      ...[closed, claims, live].filter(isFailed).map((failed) => failed.what),
      ...(unread.length === 0 ? [] : [unread.length === 1 ? `Pull requests in ${unread[0]}` : `Pull requests in ${unread.length} repositories`]),
    ],
    // What was read only in part, said plainly rather than left out silently.
    capped: cappedNotes({ items: open.capped ? open.rows.length : null, done: done.length >= LIST_PAGE ? LIST_PAGE : null, pulls: [...new Set(capped)] }),
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

function ItemCard({ card, workspace }: { card: BoardCard; workspace: string }) {
  const { item } = card;
  return (
    <li>
      <Card className="flex flex-col gap-2 p-3 transition-colors hover:border-line-strong">
        <Link to={itemPath(workspace, item.number)} prefetch="intent" className="flex min-w-0 items-start gap-2 text-sm font-medium hover:text-accent">
          <span className="mt-0.5">
            <ItemIcon item={item} size={14} />
          </span>
          <span className="min-w-0 wrap-break-word">
            {item.title} <span className="font-normal text-faint">#{item.number}</span>
          </span>
        </Link>
        {(item.repos.length > 0 || card.merged > 0) && (
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
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
            <ItemCard key={card.item.id} card={card} workspace={workspace} />
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
  const { workspace, board, stage, repo, member, signedIn, unavailable, capped, live } = loaderData;
  const total = STAGES.reduce((sum, one) => sum + board[one].length, 0);
  const query = (more: Record<string, string>) => `?${new URLSearchParams({ ...(repo ? { repo } : {}), ...more }).toString()}`;
  useWorkspaceLive({ workspace, member, match: workPages.list() });
  // Sessions go idle and end with no event to say so.
  useRefreshWhile(live > 0, 30_000);
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <Columns3 size={17} className="text-accent" />
            Board
            {repo && <span className="font-mono text-sm font-normal text-muted">{shortPath(repo, workspace)}</span>}
          </h1>
          <p className="mt-1 text-sm text-muted">Work items as they move: who is on each, what is in review, and what is landing where.</p>
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
            A work item moves across the board by itself: claimed, a session on it, a pull request opened, landed in its repositories, closed.{" "}
            <Link to={workPath(workspace)} className="text-fg underline underline-offset-4">
              The Work list
            </Link>
            .
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
        </>
      )}
    </div>
  );
}
