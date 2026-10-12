import { Suspense, useEffect } from "react";
import { Await, data } from "react-router";

import { hasCodeAccess } from "@g1t/contracts";

import type { Route } from "./+types/home";
import {
  Card,
  DecisionsCard,
  DeploysCard,
  LandedCard,
  NeedsList,
  PeopleCard,
  RowsSkeleton,
  RunningList,
  SpanSkeleton,
  SpendCard,
  SpendSkeleton,
  StartHere,
  WindowSwitch,
} from "../../components/home";
import { Skeleton } from "../../components/ui/skeleton";
import { sidebarOrNull } from "../../lib/chat.server";
import {
  type Attention,
  type Digest,
  attention,
  decisionsIn,
  deploysIn,
  digestOf,
  landed,
  landedDeploys,
  landedFromActivity,
  landedIn,
  parseWindow,
  running,
  runningDeploys,
  runningWorkflows,
  spanFor,
  spanSentence,
  waitingSentence,
} from "../../lib/home";
import {
  actorKeys,
  loadActivity,
  loadChatActivity,
  loadCodeWork,
  loadDeploys,
  loadLastVisit,
  loadMemories,
  loadNames,
  loadRepos,
  loadSpend,
  loadWorkflowRuns,
  reachFor,
  repoRefs,
} from "../../lib/home.server";
import { readCookie } from "../../lib/mission";
import { loadMissionControl } from "../../lib/mission-control.server";
import { page } from "../../lib/meta";
import { inbox } from "../../lib/services.server";
import { requireUser, roleIn } from "../../lib/session.server";
import { homePagePath } from "../../lib/workspace-nav";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Home · ${params.owner} · g1t` });
}

/** Unread notifications read for Needs you. */
const NOTIFICATIONS_READ = 50;

/**
 * Home: the workspace's front page. Where you're needed now, with no time
 * window; what happened since you were last here (or over the last 24
 * hours or 7 days, `?window=`): what people did, from the events
 * service's digest of the span and chat's, then what landed; what is
 * running; what the span cost. The last visit is kept by notify, per
 * person and workspace, and marked by the page once it has been looked
 * at (routes/workspace/home-seen.ts), so a refresh never wipes it. Only
 * the last visit (for the span) is waited for; every section streams in
 * on its own, and one whose service does not answer says so.
 * Definitions: lib/home.ts and the Home guide.
 */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  if (!roleIn(viewer, slug)) throw data(null, { status: 404 });
  const membership = viewer.workspaces?.find((m) => m.slug === slug) ?? null;
  const code = hasCodeAccess(membership);
  const now = Date.now();
  const tz = readCookie(request.headers.get("cookie"), "g1t_tz");
  const windowKey = parseWindow(new URL(request.url).searchParams.get("window"));

  // What needs you has no window: read at once, beside the last visit.
  const missionP = code ? loadMissionControl(viewer, request, slug).then(({ value }) => value).catch(() => null) : Promise.resolve(null);
  const chatP = sidebarOrNull(slug, viewer);
  const notificationsP = inbox
    .list(viewer, { unread: true, limit: NOTIFICATIONS_READ })
    .then((result) => result.items)
    .catch(() => null);
  const lastSeenP = windowKey === "last" ? loadLastVisit(viewer, slug).catch(() => undefined) : Promise.resolve(null);

  const waiting: Promise<Attention> = Promise.all([missionP, notificationsP, chatP])
    .then(([mission, notifications, sidebar]) =>
      attention({ slug, code, codeNeeds: mission?.needs ?? null, notifications, chat: sidebar?.entries ?? null }),
    )
    .catch(() => ({ rows: [], start: null, missing: ["Code", "Notifications", "Chat"] }));

  const span = spanFor(windowKey, now, await lastSeenP, tz);

  // What happened in the span: the repositories once, for every section that reads them.
  const reposP = code ? loadRepos(viewer, slug).catch(() => null) : Promise.resolve(null);
  const codeWorkP = code ? reposP.then((owned) => loadCodeWork(viewer, slug, reachFor(span), owned)).catch(() => null) : Promise.resolve("no_access" as const);
  const deploysP = code ? loadDeploys(viewer, slug, span.from).catch(() => null) : Promise.resolve(null);
  const memoriesP = code ? loadMemories(viewer, slug).catch(() => null) : Promise.resolve(null);
  const activityP = reposP.then((owned) => loadActivity(slug, span, owned)).catch(() => null);
  const chatActivityP = loadChatActivity(viewer, slug, span).catch(() => null);
  const namesP = Promise.all([activityP, chatActivityP, deploysP])
    .then(([activity, chatActivity, deploys]) => loadNames(actorKeys(activity, chatActivity, deploys)))
    .catch(() => ({}) as Record<string, string>);

  // What people did, from events and chat.
  const digest: Promise<Digest | null> = Promise.all([activityP, chatActivityP, namesP, reposP])
    .then(([activity, chatActivity, names, owned]) => digestOf({ slug, repos: repoRefs(owned), activity, chat: chatActivity, names, code }))
    .catch(() => null);
  const happened = Promise.all([codeWorkP, deploysP, memoriesP, activityP, namesP, reposP])
    .then(([codeWork, deploys, memories, activity, names, owned]) => {
      const deployRows = deploys ? deploysIn(deploys.projects, slug, span, names) : null;
      const merges = codeWork && codeWork !== "no_access" ? landedIn(codeWork.pulls, span) : null;
      return {
        // What landed: merges, direct pushes, releases and packages, production builds; null when nothing of Code could be read.
        landed: merges == null && activity == null ? null : landed([merges ?? [], landedFromActivity(activity, repoRefs(owned), names, slug), landedDeploys(deployRows ?? [])]),
        landedMissing: [...(code && merges == null ? ["Pull requests"] : []), ...(code && activity == null ? ["Pushes and releases"] : []), ...(code && deployRows == null ? ["Deployments"] : [])],
        deploys: deployRows,
        deploysComplete: deploys?.complete ?? true,
        decisions: decisionsIn(memories, slug, span),
      };
    })
    .catch(() => null);
  const workflowsP = code ? Promise.all([activityP, reposP]).then(([activity, owned]) => loadWorkflowRuns(viewer, activity, owned)).catch(() => null) : Promise.resolve(null);
  const runningNow = Promise.all([deploysP, workflowsP])
    .then(([deploys, workflows]) => ({
      rows: running([runningWorkflows(workflows?.projects ?? []), runningDeploys(deploys?.overview ?? [], slug)]),
      missing: [...(code && (!workflows || !workflows.complete) ? ["Workflows"] : []), ...(code && !deploys ? ["Deployments"] : [])],
    }))
    .catch(() => ({ rows: [], missing: ["Workflows", "Deployments"] }));
  const spend = loadSpend(viewer, slug, span).catch(() => null);

  return {
    slug,
    code,
    now,
    tz,
    span,
    digest,
    happened,
    attention: waiting,
    running: runningNow,
    /** The sentence under the heading needs the digest, what landed and what waits. */
    head: Promise.all([digest, happened, waiting]),
    spend,
  };
}

/** How long the page must have been in view before it counts as a visit. */
const SEEN_AFTER_MS = 5_000;

/**
 * Marks this visit once the page has been in view for a few seconds, with
 * the time it loaded: what happened after that shows next time. Never on
 * first paint, so a quick refresh keeps what was not looked at yet.
 */
function useMarkSeen(slug: string, loadedAt: number) {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    const mark = () => {
      if (done) return;
      done = true;
      void fetch(`${homePagePath(slug)}/seen`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ at: loadedAt }),
        keepalive: true,
      }).catch(() => undefined);
    };
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = document.visibilityState === "visible" ? setTimeout(mark, SEEN_AFTER_MS) : null;
    };
    arm();
    document.addEventListener("visibilitychange", arm);
    return () => {
      document.removeEventListener("visibilitychange", arm);
      if (timer) clearTimeout(timer);
    };
  }, [slug, loadedAt]);
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { slug, now, tz, span, digest, happened, attention: waiting, running: runningNow, head, spend } = loaderData;
  useMarkSeen(slug, now);
  return (
    <div className="mx-auto w-full max-w-[1040px] space-y-5 px-4 py-5 md:px-10 md:py-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-[1.75rem] leading-tight font-semibold tracking-tight">{span.key === "last" && span.note == null ? "Welcome back" : "Home"}</h1>
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">
            <Suspense fallback={<Skeleton className="inline-block h-3.5 w-72 align-middle" />}>
              <Await resolve={head}>
                {([digest, happened, att]) => (
                  <>
                    <span className="text-fg-soft">{waitingSentence(att.rows.length)}</span> {spanSentence(span, digest, happened?.landed?.length ?? null)}
                  </>
                )}
              </Await>
            </Suspense>
          </p>
        </div>
        <WindowSwitch span={span} />
      </header>

      {/* 1. Where you're needed now: no window, first and biggest. Start here beside it on wide screens, under it on phones. */}
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="lg:col-start-1 lg:row-start-1">
          <Card
            title="Where you're needed"
            hint="Everything waiting on you, however long ago it started"
            link={{ label: "Notifications", to: "/notifications" }}
          >
            <Suspense fallback={<RowsSkeleton rows={4} />}>
              <Await resolve={waiting}>{(att) => <NeedsList attention={att} now={now} />}</Await>
            </Suspense>
          </Card>
        </div>
        <div className="lg:col-start-2 lg:row-start-1">
          <Suspense
            fallback={
              <Card title="Start here">
                <RowsSkeleton rows={1} />
              </Card>
            }
          >
            <Await resolve={waiting}>{(att) => <StartHere attention={att} now={now} />}</Await>
          </Suspense>
        </div>
      </div>

      {/* 2. What happened in the span. */}
      <section aria-labelledby="since" className="space-y-4">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 pt-2">
          <h2 id="since" className="text-lg font-semibold tracking-tight text-fg">
            {span.key === "last" && span.note == null ? "Since you were last here" : span.words}
          </h2>
          <p className="text-sm text-muted">
            {span.key === "last" && span.note == null ? `${span.words} · ${span.length}` : spanNote(span.note)}
          </p>
        </div>
        <Suspense fallback={<SpanSkeleton />}>
          <Await resolve={digest}>{(value) => <PeopleCard digest={value} span={span} code={loaderData.code} />}</Await>
        </Suspense>
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <div className="space-y-5">
            <Suspense
              fallback={
                <Card title="Landed">
                  <RowsSkeleton rows={3} />
                </Card>
              }
            >
              <Await resolve={happened}>{(value) => <LandedCard landed={value?.landed ?? null} missing={value?.landedMissing ?? []} code={loaderData.code} now={now} tz={tz} />}</Await>
            </Suspense>
            <Suspense fallback={null}>
              <Await resolve={happened}>
                {(value) => <DeploysCard deploys={value?.deploys ?? null} complete={value?.deploysComplete ?? true} code={loaderData.code} now={now} tz={tz} />}
              </Await>
            </Suspense>
            <Suspense fallback={null}>
              <Await resolve={happened}>
                {(value) => <DecisionsCard decisions={value?.decisions ?? null} now={now} tz={tz} />}
              </Await>
            </Suspense>
          </div>
          <div className="space-y-5">
            <Suspense
              fallback={
                <Card title="Spent">
                  <SpendSkeleton />
                </Card>
              }
            >
              <Await resolve={spend}>{(value) => <SpendCard spend={value} slug={slug} span={span} />}</Await>
            </Suspense>
          </div>
        </div>
      </section>

      {/* 3. Running now. */}
      <Card title="Running now">
        <Suspense fallback={<RowsSkeleton rows={2} />}>
          <Await resolve={runningNow}>{(value) => <RunningList rows={value.rows} missing={value.missing} now={now} />}</Await>
        </Suspense>
      </Card>
    </div>
  );
}

function spanNote(note: "first" | "capped" | "unknown" | null): string {
  if (note === "first") return "Your first visit here, so this is the last 24 hours.";
  if (note === "capped") return "You were away longer than that; this is as far back as Home looks.";
  if (note === "unknown") return "Your last visit couldn't be read, so this is the last 24 hours.";
  return "";
}
