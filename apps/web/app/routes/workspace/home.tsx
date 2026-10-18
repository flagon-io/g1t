import { Suspense, useEffect, useState } from "react";
import { Await, data } from "react-router";

import { hasCodeAccess } from "@g1t/contracts";

import type { Route } from "./+types/home";
import {
  Card,
  LandedFeed,
  NeedsList,
  PeopleSummary,
  RowsSkeleton,
  RunningList,
  SettledCard,
  SpanSkeleton,
  SpendCard,
  SpendSkeleton,
  WindowSwitch,
} from "../../components/home";
import { HomeAsk, WhatChangedCard } from "../../components/home-ask";
import { DailySignal, DailySignalSkeleton, PulseSkeleton, PulseStrip } from "../../components/signals";
import { Skeleton } from "../../components/ui/skeleton";
import { sidebarOrNull } from "../../lib/chat.server";
import {
  type Attention,
  type Away,
  type Digest,
  attention,
  awayOf,
  deploysIn,
  digestOf,
  landed,
  landedDeploys,
  landedFromActivity,
  landedIn,
  parseWindow,
  pushRows,
  settledIn,
  withSessions,
  withShipped,
  running,
  runningDeploys,
  runningWorkflows,
  spanFor,
  within,
  spanSentence,
  waitingSentence,
} from "../../lib/home";
import {
  actorKeys,
  loadActivity,
  loadChatActivity,
  loadCodeWork,
  loadDeploys,
  loadDirectPushes,
  loadLastVisit,
  loadNames,
  loadPullSessions,
  loadRepos,
  loadSettled,
  loadShipped,
  loadSpend,
  loadWorkflowRuns,
  reachFor,
  repoRefs,
} from "../../lib/home.server";
import { HOME_WATCH_MAX, type HomeRepo } from "../../lib/home-live";
import { readCookie } from "../../lib/mission";
import { dailySignal, signalDate } from "../../lib/signals";
import { loadSignalData } from "../../lib/signals.server";
import { useHomeLive } from "../../lib/use-home-live";
import { guideIsFor, loadOnboarding } from "../../lib/onboarding.server";
import { GettingStartedButton, OnboardingOnPage } from "../../components/onboarding";
import { loadMissionControl } from "../../lib/mission-control.server";
import { page } from "../../lib/meta";
import { inbox } from "../../lib/services.server";
import { requireUser, roleIn } from "../../lib/session.server";
import { homePagePath } from "../../lib/workspace-nav";
import { Boundary } from "../../components/boundary";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Home · ${params.owner} · g1t` });
}

/** Unread notifications read for Needs you. */
const NOTIFICATIONS_READ = 50;

/**
 * Home: the workspace's front page. First the past week in four figures
 * and the daily signal: what the workspace's work says today, the finding
 * that matters most as the page's headline, each with its evidence
 * (lib/signals.ts), and under them a box that asks g1t about any of it
 * (components/home-ask: What changed summarizes the span on the page, and
 * Explain on each change that landed asks about it); then where you're
 * needed now, with no time window; what happened since you were last here (or over the last 24
 * hours or 7 days, `?window=`): what people did, from the events
 * service's digest of the span and chat's, then what landed; what is
 * running; what the span cost. The last visit is kept by notify, per
 * person and workspace, and marked by the page once it has been looked
 * at (routes/workspace/home-seen.ts), so a refresh never wipes it. Only
 * the last visit (for the span) is waited for; every section streams in
 * on its own, and one whose service does not answer says so.
 * The page refreshes itself as the workspace moves (lib/home-live.ts),
 * and what arrived since it last drew comes in rather than appears.
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
  const url = new URL(request.url);
  const windowKey = parseWindow(url.searchParams.get("window"));
  // Getting started, for an owner: streamed, and opened by itself until dismissed (`?setup` opens it anyway).
  const setupAsked = url.searchParams.has("setup");
  const onboarding = loadOnboarding(viewer, slug, !setupAsked).catch(() => null);

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
  const activityP = reposP.then((owned) => loadActivity(slug, span, owned)).catch(() => null);
  const chatActivityP = loadChatActivity(viewer, slug, span).catch(() => null);
  // Each push to a default branch, with the commits it brought: the projects the digest says were pushed to.
  const pushesP = code ? Promise.all([activityP, reposP]).then(([activity, owned]) => loadDirectPushes(viewer, activity, owned, span)).catch(() => null) : Promise.resolve(null);
  const namesP = Promise.all([activityP, chatActivityP, deploysP, pushesP])
    .then(([activity, chatActivity, deploys, pushes]) => loadNames([...actorKeys(activity, chatActivity, deploys), ...(pushes?.pushes ?? []).map((push) => push.actorKey)]))
    .catch(() => ({}) as Record<string, string>);

  // What people did, from events and chat.
  const digest: Promise<Digest | null> = Promise.all([activityP, chatActivityP, namesP, reposP])
    .then(([activity, chatActivity, names, owned]) => digestOf({ slug, repos: repoRefs(owned), activity, chat: chatActivity, names, code }))
    .catch(() => null);
  const happened = Promise.all([codeWorkP, deploysP, activityP, namesP, reposP, pushesP])
    .then(async ([codeWork, deploys, activity, names, owned, pushes]) => {
      const deployRows = deploys ? deploysIn(deploys.projects, slug, span, names) : null;
      const merges = codeWork && codeWork !== "no_access" ? landedIn(codeWork.pulls, span) : null;
      // Each push on its own where its project's pushes were read; the digest's one row a project elsewhere.
      const named = (key: string) => (key ? (names[key] ?? "someone") : "an import");
      const each = pushes ? pushRows(pushes.pushes.map((push) => ({ ...push, by: named(push.actorKey) })), pushes.history, span) : [];
      const fromActivity = landedFromActivity(activity, repoRefs(owned), names, slug).filter((row) => !(row.kind === "push" && pushes?.history[row.key.slice("push:".length)]));
      const all = merges == null && activity == null ? null : landed([merges ?? [], each, fromActivity]);
      // Whether each merge and push is live, and which pull requests a harness session made: read together.
      const [shipped, sessions] = all
        ? await Promise.all([
            loadShipped(viewer, slug, all).catch(() => null),
            codeWork && codeWork !== "no_access" ? loadPullSessions(viewer, codeWork.pulls.filter((pull) => pull.status === "merged" && within(pull.mergedAt, span))).catch(() => null) : null,
          ])
        : [null, null];
      // Production builds only where no merge or push already says it went live (or failed).
      const told = all ? withSessions(withShipped(all, shipped), sessions) : null;
      return {
        // What landed: merges, direct pushes, releases and packages, production builds; null when nothing of Code could be read.
        landed: told ? landed([told, landedDeploys(deployRows ?? [], told)]) : null,
        landedMissing: [
          ...(code && merges == null ? ["Pull requests"] : []),
          ...(code && activity == null ? ["Pushes and releases"] : []),
          ...(code && deployRows == null ? ["Deployments"] : []),
        ],
      };
    })
    .catch(() => null);
  // What g1t settled for you in the span, what shipped, and what still needs you.
  const settledP = loadSettled(viewer, span).catch(() => null);
  const away: Promise<Away | null> = Promise.all([settledP, happened, waiting])
    .then(([settled, value, att]) => (settled == null ? null : awayOf({ settled: settledIn(settled, slug, code, span), landed: value?.landed ?? null, needs: att.rows.length })))
    .catch(() => null);
  const workflowsP = code ? Promise.all([activityP, reposP]).then(([activity, owned]) => loadWorkflowRuns(viewer, activity, owned)).catch(() => null) : Promise.resolve(null);
  const runningNow = Promise.all([deploysP, workflowsP])
    .then(([deploys, workflows]) => ({
      rows: running([runningWorkflows(workflows?.projects ?? []), runningDeploys(deploys?.overview ?? [], slug)]),
      missing: [...(code && (!workflows || !workflows.complete) ? ["Workflows"] : []), ...(code && !deploys ? ["Deployments"] : [])],
    }))
    .catch(() => ({ rows: [], missing: ["Workflows", "Deployments"] }));
  const spend = loadSpend(viewer, slug, span).catch(() => null);
  // What the workspace's work says: the pulse and the findings, for members who see Code.
  const signal = code ? reposP.then((owned) => loadSignalData(viewer, slug, now, owned)).then((value) => (value ? dailySignal(value) : null)).catch(() => null) : null;
  // The projects the page watches, so it refreshes as they move (lib/home-live.ts).
  const watch: Promise<HomeRepo[]> = reposP
    .then((owned) => (owned ?? []).slice(0, HOME_WATCH_MAX).map((repo) => ({ id: repo.id, path: `${repo.namespace}/${repo.name}`, defaultBranch: repo.defaultBranch || null })))
    .catch(() => []);

  return {
    slug,
    code,
    now,
    tz,
    span,
    digest,
    happened,
    attention: waiting,
    away,
    running: runningNow,
    /** The sentence under the heading needs the digest, what landed and what waits. */
    head: Promise.all([digest, happened, waiting]),
    spend,
    signal,
    date: signalDate(now, tz),
    watch,
    onboarding,
    setupAsked,
    /** Whether Getting started is for the viewer (an owner), so Home offers it again once dismissed. */
    guide: guideIsFor(viewer, slug),
  };
}

/** The projects the page watches, once the loader has read them. */
function useWatched(watch: Promise<HomeRepo[]>): HomeRepo[] {
  const [repos, setRepos] = useState<HomeRepo[]>([]);
  useEffect(() => {
    let current = true;
    void watch.then((list) => {
      // A refresh reads them again: keep the same list while it is the same.
      if (current) setRepos((before) => (sameRepos(before, list) ? before : list));
    });
    return () => {
      current = false;
    };
  }, [watch]);
  return repos;
}

function sameRepos(a: HomeRepo[], b: HomeRepo[]): boolean {
  return a.length === b.length && a.every((repo, i) => repo.id === b[i]?.id && repo.defaultBranch === b[i]?.defaultBranch);
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
  const { slug, now, tz, span, digest, happened, attention: waiting, away, running: runningNow, head, spend, signal } = loaderData;
  useMarkSeen(slug, now);
  useHomeLive(slug, useWatched(loaderData.watch));
  return (
    <div className="mx-auto w-full max-w-260 space-y-5 px-4 py-5 md:px-10 md:py-8">
      <OnboardingOnPage slug={slug} view={loaderData.onboarding} asked={loaderData.setupAsked} />
      {loaderData.guide && (
        <div className="flex justify-end">
          <GettingStartedButton slug={slug} variant="soft" />
        </div>
      )}
      {/* 0. The past week, against the week before, for members who see Code. */}
      {signal && (
        <Suspense fallback={<PulseSkeleton />}>
          <Await resolve={signal}>
            {(value) =>
              value && (
                <Boundary what="The past week">
                  <PulseStrip tiles={value.tiles} />
                </Boundary>
              )
            }
          </Await>
        </Suspense>
      )}
      {/*
        Two columns on wide screens: what to do and what happened on the
        left, read top to bottom; what is going on now and what it costs on
        the right, kept in view. On a phone it is one column: Where you're
        needed, Running now, what happened, then Spent and Settled (the side
        column's cards join it, `contents`, each in its place by `order`).
      */}
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        {/* 1. Where you're needed now, with the one to start with on top: no window. */}
        <div className="order-1 space-y-5 lg:col-start-1 lg:row-start-1">
        {/* 1. The daily signal, then a box that asks g1t about any of it; the line under it is yours. */}
        {(() => {
          const line = (
            <Suspense fallback={<Skeleton className="inline-block h-3.5 w-72 align-middle" />}>
              <Await resolve={head}>
                {([digest, happened, att]) => (
                  <>
                    <span className="text-fg-soft">{waitingSentence(att.rows.length)}</span> {spanSentence(span, digest, happened?.landed?.length ?? null)}
                  </>
                )}
              </Await>
            </Suspense>
          );
          const ask = <HomeAsk span={span} compact />;
          // Without Code there is no work to read: the box leads, as it always has.
          if (!signal)
            return (
              <header className="space-y-3">
                <HomeAsk span={span} />
                <p className="mx-auto max-w-2xl text-center text-sm leading-relaxed text-muted">{line}</p>
              </header>
            );
          return (
            <Suspense fallback={<DailySignalSkeleton date={loaderData.date} />}>
              <Await resolve={signal}>
                {(value) => (
                  <Boundary what="The daily signal">
                    <DailySignal date={loaderData.date} view={value} line={line} footer={ask} />
                  </Boundary>
                )}
              </Await>
            </Suspense>
          );
        })()}
        <div id="needed" className="scroll-mt-4">
          <Card
            title="Where you're needed"
            hint="Everything waiting on you, however long ago it started"
            link={{ label: "Notifications", to: "/notifications" }}
          >
            <Suspense fallback={<RowsSkeleton rows={4} />}>
              {/* Each section's data says what did not answer; a section that fails to draw keeps that to itself. */}
              <Await resolve={waiting}>
                {(att) => (
                  <Boundary what="Where you're needed">
                    <NeedsList attention={att} now={now} />
                  </Boundary>
                )}
              </Await>
            </Suspense>
          </Card>
        </div>
        </div>

        {/* 2. Now: what is running, what it cost, what settled by itself. */}
        <aside aria-label="Now" className="contents lg:sticky lg:top-4 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:block lg:space-y-5">
          <Card title="Running now" className="order-2">
            <Suspense fallback={<RowsSkeleton rows={2} />}>
              <Await resolve={runningNow}>
                {(value) => (
                  <Boundary what="Running now">
                    <RunningList rows={value.rows} missing={value.missing} now={now} />
                  </Boundary>
                )}
              </Await>
            </Suspense>
          </Card>
          <div className="order-4">
            <Suspense
              fallback={
                <Card title="Spent">
                  <SpendSkeleton />
                </Card>
              }
            >
              <Await resolve={spend}>
                {(value) => (
                  <Boundary what="Spent">
                    <SpendCard spend={value} slug={slug} span={span} />
                  </Boundary>
                )}
              </Await>
            </Suspense>
          </div>
          <div className="order-5">
            <Suspense
              fallback={
                <Card title="Settled for you">
                  <RowsSkeleton rows={1} />
                </Card>
              }
            >
              <Await resolve={away}>
                {(value) => (
                  <Boundary what="Settled for you">
                    <SettledCard away={value} now={now} />
                  </Boundary>
                )}
              </Await>
            </Suspense>
          </div>
        </aside>

        {/* 3. What happened in the span: what changed in plain English first, then who did what, then what landed. */}
        <section aria-labelledby="since" className="order-3 rounded-2xl border border-line bg-surface lg:col-start-1 lg:row-start-2">
          <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 pt-4">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 id="since" className="text-base font-semibold tracking-tight text-fg">
                {span.key === "last" && span.note == null ? "Since you were last here" : span.words}
              </h2>
              <p className="text-xs text-muted">{span.key === "last" && span.note == null ? `${span.words} · ${span.length}` : spanNote(span.note)}</p>
            </div>
            <div className="sm:ml-auto">
              <WindowSwitch span={span} />
            </div>
          </header>
          {/* Summarize leads: the plain-English account is what most people come for. */}
          <div className="mt-4">
            <WhatChangedCard key={span.key} slug={slug} span={span} tz={tz} />
          </div>
          <div className="border-t border-line">
            <Suspense fallback={<SpanSkeleton />}>
              <Await resolve={digest}>
                {(value) => (
                  <Boundary what="Who did what">
                    <PeopleSummary digest={value} span={span} code={loaderData.code} />
                  </Boundary>
                )}
              </Await>
            </Suspense>
          </div>
          <Suspense
            fallback={
              <div className="border-t border-line pt-4">
                <RowsSkeleton rows={3} />
              </div>
            }
          >
            <Await resolve={happened}>
              {(value) => (
                <Boundary what="What landed">
                  <LandedFeed
                    landed={value?.landed ?? null}
                    missing={value?.landedMissing ?? []}
                    code={loaderData.code}
                    now={now}
                    tz={tz}
                    byDay={span.key === "7d"}
                    scope={span.key}
                  />
                </Boundary>
              )}
            </Await>
          </Suspense>
        </section>
      </div>
    </div>
  );
}

function spanNote(note: "first" | "capped" | "unknown" | null): string {
  if (note === "first") return "Your first visit here, so this is the last 24 hours.";
  if (note === "capped") return "You were away longer than that; this is as far back as Home looks.";
  if (note === "unknown") return "Your last visit couldn't be read, so this is the last 24 hours.";
  return "";
}
