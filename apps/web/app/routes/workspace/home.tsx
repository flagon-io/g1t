import { Suspense, useEffect, useState } from "react";
import { Await, data } from "react-router";

import { type WorkspaceSession, hasCodeAccess } from "@g1t/contracts";

import type { Route } from "./+types/home";
import {
  Card,
  LandedFeed,
  LiveSessions,
  NeedsList,
  PeopleSummary,
  RowsSkeleton,
  RunningList,
  SettledCard,
  SpanSkeleton,
  SpendCard,
  SpendSkeleton,
  YourSpendLink,
  WindowSwitch,
} from "../../components/home";
import { HomeAsk, WhatChangedCard } from "../../components/home-ask";
import { HomeWeek, HomeWeekSkeleton } from "../../components/home-week";
import { GroundSkeleton, GroundTruth } from "../../components/ground-truth";
import { MembersCard } from "../../components/members-card";
import { UsageCard } from "../../components/usage-card";
import { HeldSuspense, Skeleton } from "../../components/ui/skeleton";
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
  nowRows,
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
import { inTime } from "../../lib/stream-deadline";
import { dailySignal, providerQuarter, signalsRange } from "../../lib/signals";
import { loadGroups, loadSignalData } from "../../lib/signals.server";
import { shapeGround } from "../../lib/ground";
import { isFailed, part } from "../../lib/partial";
import { usageFor } from "../../lib/workspace-usage.server";
import { useHomeLive } from "../../lib/use-home-live";
import { guideIsFor, loadOnboarding } from "../../lib/onboarding.server";
import { GettingStartedButton, OnboardingOnPage } from "../../components/onboarding";
import { loadMissionControl } from "../../lib/mission-control.server";
import { page } from "../../lib/meta";
import { billing, identity, inbox, work } from "../../lib/services.server";
import { managesBilling, requireUser, roleIn } from "../../lib/session.server";
import { canItem } from "../../lib/work-access";
import { Boundary } from "../../components/boundary";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Home · ${params.owner} · g1t` });
}

/** Unread notifications read for Your move. */
const NOTIFICATIONS_READ = 50;
/** Live sessions read for Live. */
const LIVE_READ = 12;

/**
 * Home: the workspace's front page. First the box that asks g1t
 * (components/home-ask: What changed summarizes the span on the page, and
 * Explain on each change that landed asks about it). Then Your move:
 * everything waiting on you, with no time window, your own work in the
 * plan's Now among it, and with nothing waiting the work item to take
 * next as Start here; beside it Live: the agents
 * at work, workflow runs and builds going now. Then the week's work
 * (components/home-week, lib/signals.ts): four figures, the last two weeks
 * day by day, and what is worth a look, each with its evidence and pinned
 * to its day where it has one. Then what happened since you were last
 * here (or over the last 24 hours or 7 days, `?window=`): what people
 * did, from the events service's digest of the span and chat's, then what
 * landed; beside it what the span cost and what settled by itself. The last visit is kept by notify, per
 * person and workspace, and marked by the page once it has been looked
 * at (routes/workspace/home-seen.ts), so a refresh never wipes it. Then
 * the workspace itself, for every member: what is moving and waiting team
 * by team and the quiet changes in who works where (lib/ground.ts), the
 * month's usage against its plan, and who is in it. Dollars (what the span
 * cost, the quarter's spend threaded to the work, usage) are only for
 * those who look after billing: owners and billing managers. Only
 * the last visit (for the span) is waited for; every section streams in
 * on its own, and one whose service does not answer says so.
 * The page refreshes itself as the workspace moves (lib/home-live.ts),
 * and what arrived since it last drew comes in rather than appears.
 * Definitions: lib/home.ts and the Home guide.
 */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  const role = roleIn(viewer, slug);
  if (!role) throw data(null, { status: 404 });
  const money = managesBilling(viewer, slug);
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
  const missionP = code
    ? loadMissionControl(viewer, request, slug)
        .then(({ value }) => value)
        .catch(() => null)
    : Promise.resolve(null);
  const chatP = sidebarOrNull(slug, viewer);
  const notificationsP = inbox
    .list(viewer, { unread: true, limit: NOTIFICATIONS_READ })
    .then((result) => result.items)
    .catch(() => null);
  const lastSeenP = windowKey === "last" ? loadLastVisit(viewer, slug).catch(() => undefined) : Promise.resolve(null);

  // Your own work in the plan's Now, and the work item to take next for when nothing else waits on you.
  // Whoever plans (the Triage role or higher) reads the plan instead of
  // the list: its Now is the same, and it says how many have waited in
  // Triage over a week, which they are asked to place.
  const plans = canItem(viewer, slug, null, "triage");
  const planP = plans
    ? work
        .getPlan(slug, viewer)
        .then((plan) => (plan.ok ? plan.value : null))
        .catch(() => null)
    : Promise.resolve(null);
  const nowItemsP = plans
    ? planP.then((plan) => plan?.now ?? null)
    : work
        .listWorkItems(slug, viewer, { horizon: "now" })
        .then((now) => (now.ok ? now.value : null))
        .catch(() => null);
  const nowP = Promise.all([nowItemsP, work.listClaims(slug, viewer, { state: "active" })])
    .then(([now, claims]) => (now && claims.ok ? nowRows(now, claims.value, viewer.username) : null))
    .catch(() => null);
  const triageWaitingP = planP.then((plan) => (plans ? (plan?.triageWaiting ?? null) : undefined));
  const nextP = work
    .nextWorkItem(slug, viewer)
    .then((result) => (result.ok && result.value ? { item: result.value, viewer: viewer.username } : null))
    .catch(() => null);
  const waiting: Promise<Attention> = Promise.all([missionP, notificationsP, chatP, nowP, nextP, triageWaitingP])
    .then(([mission, notifications, sidebar, now, next, triageWaiting]) =>
      attention({ slug, code, codeNeeds: mission?.needs ?? null, notifications, chat: sidebar?.entries ?? null, now, triageWaiting, next }),
    )
    .catch(() => ({ rows: [], start: null, missing: ["Code", "Notifications", "Chat", "Work"] }));

  const span = spanFor(windowKey, now, await lastSeenP, tz);

  // What happened in the span: the repositories once, for every section that reads them.
  const reposP = code ? loadRepos(viewer, slug).catch(() => null) : Promise.resolve(null);
  const codeWorkP = code ? reposP.then((owned) => loadCodeWork(viewer, slug, reachFor(span), owned)).catch(() => null) : Promise.resolve("no_access" as const);
  const deploysP = code ? loadDeploys(viewer, slug, span.from).catch(() => null) : Promise.resolve(null);
  const activityP = reposP.then((owned) => loadActivity(slug, span, owned)).catch(() => null);
  const chatActivityP = loadChatActivity(viewer, slug, span).catch(() => null);
  // Each push to a default branch, with the commits it brought: the projects the digest says were pushed to.
  const pushesP = code
    ? Promise.all([activityP, reposP])
        .then(([activity, owned]) => loadDirectPushes(viewer, activity, owned, span))
        .catch(() => null)
    : Promise.resolve(null);
  const namesP = Promise.all([activityP, chatActivityP, deploysP, pushesP])
    .then(([activity, chatActivity, deploys, pushes]) =>
      loadNames([...actorKeys(activity, chatActivity, deploys), ...(pushes?.pushes ?? []).map((push) => push.actorKey)]),
    )
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
      const each = pushes
        ? pushRows(
            pushes.pushes.map((push) => ({ ...push, by: named(push.actorKey) })),
            pushes.history,
            span,
          )
        : [];
      const fromActivity = landedFromActivity(activity, repoRefs(owned), names, slug).filter(
        (row) => !(row.kind === "push" && pushes?.history[row.key.slice("push:".length)]),
      );
      const all = merges == null && activity == null ? null : landed([merges ?? [], each, fromActivity]);
      // Whether each merge and push is live, and which pull requests a harness session made: read together.
      const [shipped, sessions] = all
        ? await Promise.all([
            loadShipped(viewer, slug, all).catch(() => null),
            codeWork && codeWork !== "no_access"
              ? loadPullSessions(
                  viewer,
                  codeWork.pulls.filter((pull) => pull.status === "merged" && within(pull.mergedAt, span)),
                ).catch(() => null)
              : null,
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
    .then(([settled, value, att]) =>
      settled == null ? null : awayOf({ settled: settledIn(settled, slug, code, span), landed: value?.landed ?? null, needs: att.rows.length }),
    )
    .catch(() => null);
  const workflowsP = code
    ? Promise.all([activityP, reposP])
        .then(([activity, owned]) => loadWorkflowRuns(viewer, activity, owned))
        .catch(() => null)
    : Promise.resolve(null);
  const runningNow = Promise.all([deploysP, workflowsP])
    .then(([deploys, workflows]) => ({
      rows: running([runningWorkflows(workflows?.projects ?? []), runningDeploys(deploys?.overview ?? [], slug)]),
      missing: [...(code && (!workflows || !workflows.complete) ? ["Workflows"] : []), ...(code && !deploys ? ["Deployments"] : [])],
    }))
    .catch(() => ({ rows: [], missing: ["Workflows", "Deployments"] }));
  // The agents at work now: harness and hosted sessions that are live.
  const live: Promise<WorkspaceSession[] | null> = code
    ? work
        .listWorkspaceSessions(slug, viewer, { shown: "live", sessionsOnly: true, limit: LIVE_READ })
        .then((result) => (result.ok ? result.value.sessions : null))
        .catch(() => null)
    : Promise.resolve([]);
  const spend = money ? loadSpend(viewer, slug, span).catch(() => null) : null;
  // What the workspace's work says, for members who see Code: read once, for
  // the week (the pulse and the findings) and for the workspace's ground truth.
  const signalData = code ? reposP.then((owned) => loadSignalData(viewer, slug, now, owned)).catch(() => null) : null;
  // Its spend (a tile and a finding) is in dollars: only for billing.
  const signal = signalData
    ? signalData
        .then((value) => (value ? dailySignal(value) : null))
        .then((value) =>
          value && !money
            ? { ...value, tiles: value.tiles.filter((tile) => tile.key !== "spend"), findings: value.findings.filter((finding) => finding.key !== "spend") }
            : value,
        )
        .catch(() => null)
    : null;
  const ground = signalData
    ? Promise.all([
        signalData,
        reposP.then((owned) => (owned ? loadGroups(viewer, slug, owned) : null)).catch(() => null),
        // What the connected providers say was spent: only where dollars are shown.
        money
          ? billing
              .providerCosts(slug, viewer, signalsRange(now).quarter)
              .then((result) => (result.ok ? result.value : null))
              .catch(() => null)
          : null,
      ])
        .then(([found, groups, providers]) =>
          found ? { ...shapeGround(found, groups, now), providers: providerQuarter(providers, found.range.quarter) } : null,
        )
        .catch(() => null)
    : null;
  // Who is in the workspace, for everyone; the month's usage against the plan, in dollars.
  const members = part(identity.listMembers(slug, viewer), "The member list")
    .then((result) => (isFailed(result) ? result : result.ok ? result.value : null))
    .catch(() => null);
  const usage = money ? usageFor(slug, viewer).catch(() => null) : null;
  // The projects the page watches, so it refreshes as they move (lib/home-live.ts).
  const watch: Promise<HomeRepo[]> = reposP
    .then((owned) =>
      (owned ?? [])
        .slice(0, HOME_WATCH_MAX)
        .map((repo) => ({ id: repo.id, path: `${repo.namespace}/${repo.name}`, defaultBranch: repo.defaultBranch || null })),
    )
    .catch(() => []);

  // Each section settles before the page's stream closes (lib/stream-deadline.ts):
  // one still waiting on a slow service shows as unavailable, as a failed one
  // does, rather than failing the page.
  const unread = { rows: [], start: null, missing: ["Code", "Notifications", "Chat", "Work"] } satisfies Attention;
  const notRunning = { rows: [], missing: ["Workflows", "Deployments"] };
  return {
    slug,
    code,
    owner: role === "owner",
    money,
    now,
    tz,
    span,
    digest: inTime(digest, null),
    happened: inTime(happened, null),
    attention: inTime(waiting, unread),
    away: inTime(away, null),
    /**
     * Live's agents, and its runs and builds. Joined here, not while drawing:
     * a promise made on each render is new each time, so `<Await>` suspends
     * again on every render, and no router update commits while Home is shown.
     */
    live: Promise.all([inTime(live, null), inTime(runningNow, notRunning)]),
    /** The sentence about the span needs the digest and what landed. */
    head: Promise.all([inTime(digest, null), inTime(happened, null)]),
    spend: spend && inTime(spend, null),
    signal: signal && inTime(signal, null),
    ground: ground && inTime(ground, null),
    members: inTime(members, null),
    usage: usage && inTime(usage, null),
    watch: inTime(watch, []),
    onboarding: inTime(onboarding, null),
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
      void fetch(`/${slug}/-/home/seen`, {
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

/** Home's page, from its loader's data. */
export default function Home({ loaderData }: Route.ComponentProps) {
  return <HomePage key={loaderData.slug} data={loaderData} />;
}

/**
 * Home itself, taking its data as a prop. Keyed by the workspace above, so
 * nothing of the last one is held over after switching.
 */
export function HomePage({ data: loaderData }: { data: Route.ComponentProps["loaderData"] }) {
  const { slug, now, tz, span, digest, happened, attention: waiting, away, live, head, spend, signal } = loaderData;
  useMarkSeen(slug, now);
  useHomeLive(slug, useWatched(loaderData.watch));
  return (
    <div className="mx-auto w-full max-w-360 space-y-5 px-4 py-5 md:px-10 md:py-8">
      <OnboardingOnPage slug={slug} view={loaderData.onboarding} asked={loaderData.setupAsked} />
      {loaderData.guide && (
        <div className="flex justify-end">
          <GettingStartedButton slug={slug} variant="soft" />
        </div>
      )}
      {/* 0. The box that asks g1t leads the page, above everything it can be asked about. */}
      <HomeAsk span={span} />
      {/*
        What needs you and what is going on now, side by side; on a phone,
        one after the other. Then the week's work, then what happened since
        you were last here beside what it cost.
      */}
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-[minmax(0,1fr)_24rem]">
        {/* 1. Your move: everything waiting on you, the one to start with on top, with no time window. */}
        <div id="needed" className="scroll-mt-4">
          <HeldSuspense
            id={`home:${slug}:needed`}
            fallback={
              <Card title="Your move">
                <RowsSkeleton rows={4} />
              </Card>
            }
          >
            {/* Each section's data says what did not answer; a section that fails to draw keeps that to itself. */}
            <Await resolve={waiting}>
              {(att) => (
                <Card title="Your move" hint={waitingSentence(att.rows.length)} link={{ label: "Notifications", to: "/notifications" }}>
                  <Boundary what="Your move">
                    <NeedsList attention={att} now={now} />
                  </Boundary>
                </Card>
              )}
            </Await>
          </HeldSuspense>
        </div>

        {/* 2. Live: agents at work, then workflow runs and builds, as they go. */}
        <Card title="Live" hint="Agents, runs and builds going now">
          <HeldSuspense id={`home:${slug}:live`} fallback={<RowsSkeleton rows={2} />}>
            <Await resolve={live}>
              {([sessions, value]) => (
                <Boundary what="Live">
                  <LiveSessions sessions={sessions} slug={slug} now={now} />
                  <RunningList rows={value.rows} missing={value.missing} now={now} sessions={sessions?.length ?? 0} />
                </Boundary>
              )}
            </Await>
          </HeldSuspense>
        </Card>
      </div>

      {/* 3. The week's work, for members who see Code: its figures, its days, and what is worth a look. */}
      {signal && (
        <HeldSuspense id={`home:${slug}:week`} fallback={<HomeWeekSkeleton />}>
          <Await resolve={signal}>
            {(value) => (
              <Boundary what="This week">
                <HomeWeek view={value} />
              </Boundary>
            )}
          </Await>
        </HeldSuspense>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-[minmax(0,1fr)_24rem]">
        {/* 4. What happened in the span: in a sentence, then in plain English, then who did what, then what landed. */}
        <section aria-labelledby="since" className="rounded-2xl border border-line bg-surface">
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
          <p className="px-5 pt-2 text-sm text-muted">
            <Suspense fallback={<Skeleton className="inline-block h-3.5 w-72 align-middle" />}>
              <Await resolve={head}>{([digest, happened]) => spanSentence(span, digest, happened?.landed?.length ?? null)}</Await>
            </Suspense>
          </p>
          {/* Summarize leads: the plain-English account is what most people come for. */}
          <div className="mt-4">
            <WhatChangedCard key={span.key} slug={slug} span={span} tz={tz} />
          </div>
          <div className="border-t border-line">
            <HeldSuspense id={`home:${slug}:${span.key}:people`} fallback={<SpanSkeleton />}>
              <Await resolve={digest}>
                {(value) => (
                  <Boundary what="Who did what">
                    <PeopleSummary digest={value} span={span} code={loaderData.code} />
                  </Boundary>
                )}
              </Await>
            </HeldSuspense>
          </div>
          <HeldSuspense
            id={`home:${slug}:${span.key}:landed`}
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
          </HeldSuspense>
        </section>

        {/* 5. What the span cost (for billing), and what settled by itself: kept in view beside it. */}
        <aside aria-label="Cost and settled" className="space-y-5 lg:sticky lg:top-4">
          {spend && (
            <HeldSuspense
              id={`home:${slug}:${span.key}:spent`}
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
            </HeldSuspense>
          )}
          {/* What your own agent sessions cost: for everyone, not only billing. */}
          <YourSpendLink slug={slug} />
          <HeldSuspense
            id={`home:${slug}:settled`}
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
          </HeldSuspense>
        </aside>
      </div>

      {/* 6. The workspace: what is moving and waiting team by team, and the quiet changes; spend for billing. Drawn as Home's cards. */}
      {loaderData.ground && (
        <HeldSuspense id={`home:${slug}:ground`} fallback={<GroundSkeleton />}>
          <Await resolve={loaderData.ground}>
            {(value) =>
              value && (
                <Boundary what="What the work says">
                  <GroundTruth slug={slug} ground={value} pulse={false} money={loaderData.money} compact />
                </Boundary>
              )
            }
          </Await>
        </HeldSuspense>
      )}

      {/* 7. The workspace at a glance: who is in it, and the month's usage against its plan (for billing). */}
      <div className={`grid grid-cols-[minmax(0,1fr)] items-start gap-5 ${loaderData.usage ? "lg:grid-cols-[minmax(0,1fr)_24rem]" : "lg:grid-cols-2"}`}>
        {loaderData.usage && (
          <HeldSuspense id={`home:${slug}:usage`} fallback={<Skeleton className="h-48 rounded-2xl" />}>
            <Await resolve={loaderData.usage}>
              {(value) =>
                value ? (
                  <Boundary what="Usage">
                    <UsageCard slug={slug} glance={value} owner />
                  </Boundary>
                ) : null
              }
            </Await>
          </HeldSuspense>
        )}
        <HeldSuspense id={`home:${slug}:members`} fallback={<Skeleton className="h-48 rounded-2xl" />}>
          <Await resolve={loaderData.members}>{(value) => <MembersCard slug={slug} owner={loaderData.owner} members={value} />}</Await>
        </HeldSuspense>
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
