import { ArrowRight } from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { Await, Form, Link, data, redirect, useNavigation } from "react-router";

import { hasCodeAccess } from "@g1t/contracts";

import type { Route } from "./+types/home";
import {
  Card,
  DecisionsCard,
  DeploysCard,
  LandedCard,
  NeedsList,
  PeopleAgentsCard,
  RowsSkeleton,
  RunningList,
  Sources,
  SpanSkeleton,
  SpendCard,
  SpendSkeleton,
  StartHere,
  WindowSwitch,
} from "../../components/home";
import { G1tMark, isOrchestrator } from "../../components/orchestrator";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { channelPath } from "../../lib/chat";
import { sidebarOrNull } from "../../lib/chat.server";
import {
  type Attention,
  type Digest,
  type SpanWork,
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
  runningChanges,
  runningDeploys,
  runningSessions,
  runningWorkflows,
  spanFor,
  spanSentence,
  spanWork,
  waitingSentence,
} from "../../lib/home";
import {
  actorKeys,
  loadActivity,
  loadAgentsOverview,
  loadChatActivity,
  loadCodeWork,
  loadDeploys,
  loadInstallRequests,
  loadLastVisit,
  loadMemories,
  loadNames,
  loadRepos,
  loadSessions,
  loadSpend,
  loadWorkflowRuns,
  reachFor,
  repoRefs,
} from "../../lib/home.server";
import { readCookie } from "../../lib/mission";
import { loadMissionControl } from "../../lib/mission-control.server";
import { page } from "../../lib/meta";
import { chat, inbox, workspaceAgents } from "../../lib/services.server";
import { assertSameOrigin, requireUser, roleIn } from "../../lib/session.server";
import { homePagePath } from "../../lib/workspace-nav";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Home · ${params.owner} · g1t` });
}

/** Unread notifications read for Needs you. */
const NOTIFICATIONS_READ = 50;

/**
 * Home: the workspace's front page. Where you're needed now, with no time
 * window; what happened since you were last here (or over the last 24
 * hours or 7 days, `?window=`): what people did and what agents did, from
 * the events service's digest of the span, chat's, and the agents' tasks,
 * then what landed; what is running; what the span cost; and one place to
 * start. The last visit is kept by notify, per person and
 * workspace, and marked by the page once it has been looked at
 * (routes/workspace/home-seen.ts), so a refresh never wipes it. Only the
 * agents list (for Ask g1t) and the last visit (for the span) are waited
 * for; every section streams in on its own, and one whose service does
 * not answer says so. Definitions: lib/home.ts and the Home guide.
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
  const agentsP = workspaceAgents
    .list(slug, viewer)
    .then((result) => (result.ok ? result.value.filter((agent) => !agent.archived_at) : null))
    .catch(() => null);
  const overviewP = loadAgentsOverview(viewer, slug).catch(() => null);
  const missionP = code ? loadMissionControl(viewer, request, slug).then(({ value }) => value).catch(() => null) : Promise.resolve(null);
  const requestsP = loadInstallRequests(viewer, slug).catch(() => null);
  const chatP = sidebarOrNull(slug, viewer);
  const notificationsP = inbox
    .list(viewer, { unread: true, limit: NOTIFICATIONS_READ })
    .then((result) => result.items)
    .catch(() => null);
  const lastSeenP = windowKey === "last" ? loadLastVisit(viewer, slug).catch(() => undefined) : Promise.resolve(null);

  const waiting: Promise<Attention> = Promise.all([missionP, overviewP, agentsP, requestsP, notificationsP, chatP])
    .then(([mission, overview, agents, requests, notifications, sidebar]) => {
      const capped = overview?.waiting_on_you ?? null;
      const latestCap = Math.max(0, ...(capped ?? []).map((session) => Date.parse(session.updated_at)));
      const monthStart = Date.parse(`${new Date(now).toISOString().slice(0, 7)}-01T00:00:00Z`);
      return attention({
        slug,
        code,
        codeNeeds: mission?.needs ?? null,
        capped,
        agents,
        canManage: overview?.can_manage ?? false,
        limit: overview?.can_manage ? { alert: overview.alert, spentMicros: overview.spent_month_micros, since: latestCap || monthStart } : null,
        requests: requests?.can_resolve ? requests.requests : null,
        notifications,
        chat: sidebar?.entries ?? null,
      });
    })
    .catch(() => ({ rows: [], start: null, missing: ["Code", "Agents", "Notifications", "Chat"] }));

  const span = spanFor(windowKey, now, await lastSeenP, tz);

  // What happened in the span: the repositories once, for every section that reads them.
  const reposP = code ? loadRepos(viewer, slug).catch(() => null) : Promise.resolve(null);
  const codeWorkP = code ? reposP.then((owned) => loadCodeWork(viewer, slug, reachFor(span), owned)).catch(() => null) : Promise.resolve("no_access" as const);
  const sessionsP = loadSessions(viewer, slug, span.from).catch(() => null);
  const deploysP = code ? loadDeploys(viewer, slug, span.from).catch(() => null) : Promise.resolve(null);
  const memoriesP = code ? loadMemories(viewer, slug).catch(() => null) : Promise.resolve(null);
  const activityP = reposP.then((owned) => loadActivity(slug, span, owned)).catch(() => null);
  const chatActivityP = loadChatActivity(viewer, slug, span).catch(() => null);
  const namesP = Promise.all([activityP, chatActivityP, agentsP])
    .then(([activity, chatActivity, agents]) => loadNames(actorKeys(activity, chatActivity), agents))
    .catch(() => ({}) as Record<string, string>);

  const work: Promise<SpanWork | null> = Promise.all([codeWorkP, sessionsP])
    .then(([codeWork, sessions]) => (codeWork == null && sessions == null ? null : spanWork({ span, slug, code: codeWork, sessions })))
    .catch(() => null);
  // People and agents: what each did, from events, chat and the agents' tasks.
  const digest: Promise<Digest | null> = Promise.all([activityP, chatActivityP, namesP, work, reposP])
    .then(([activity, chatActivity, names, spanWork, owned]) => digestOf({ slug, repos: repoRefs(owned), activity, chat: chatActivity, names, work: spanWork, code }))
    .catch(() => null);
  const happened = Promise.all([codeWorkP, deploysP, memoriesP, requestsP, activityP, namesP, reposP])
    .then(([codeWork, deploys, memories, requests, activity, names, owned]) => {
      const deployRows = deploys ? deploysIn(deploys.projects, slug, span) : null;
      const merges = codeWork && codeWork !== "no_access" ? landedIn(codeWork.pulls, span) : null;
      return {
        // What landed: merges, direct pushes, releases and packages, production builds; null when nothing of Code could be read.
        landed: merges == null && activity == null ? null : landed([merges ?? [], landedFromActivity(activity, repoRefs(owned), names, slug), landedDeploys(deployRows ?? [])]),
        landedMissing: [...(code && merges == null ? ["Pull requests"] : []), ...(code && activity == null ? ["Pushes and releases"] : []), ...(code && deployRows == null ? ["Deployments"] : [])],
        deploys: deployRows,
        deploysComplete: deploys?.complete ?? true,
        decisions: decisionsIn({ memories, requests: requests?.requests ?? null }, slug, span),
        decisionsRead: { memories: !code || memories != null, requests: requests != null },
      };
    })
    .catch(() => null);
  const workflowsP = code ? Promise.all([activityP, reposP]).then(([activity, owned]) => loadWorkflowRuns(viewer, activity, owned)).catch(() => null) : Promise.resolve(null);
  const runningNow = Promise.all([sessionsP, missionP, deploysP, workflowsP])
    .then(([sessions, mission, deploys, workflows]) => ({
      rows: running([
        runningSessions(sessions?.sessions ?? [], slug),
        runningChanges(mission?.waiting ?? []),
        runningWorkflows(workflows?.projects ?? []),
        runningDeploys(deploys?.overview ?? [], slug),
      ]),
      missing: [
        ...(sessions ? [] : ["Agents"]),
        ...(code && !mission ? ["Code"] : []),
        ...(code && (!workflows || !workflows.complete) ? ["Workflows"] : []),
        ...(code && !deploys ? ["Deployments"] : []),
      ],
    }))
    .catch(() => ({ rows: [], missing: ["Agents"] }));
  const spend = loadSpend(viewer, slug, span).catch(() => null);

  const agents = await agentsP;
  return {
    slug,
    code,
    now,
    tz,
    span,
    orchestrator: agents?.some(isOrchestrator) ?? false,
    /** The agents' faces, for the Agents column. */
    faces: (agents ?? []).map(({ id, handle, display_name, avatar, avatar_seed, builtin }) => ({ id, handle, display_name, avatar, avatar_seed, builtin })),
    work,
    /** The People and Agents card needs both the digest and the agents' tasks. */
    since: Promise.all([digest, work]),
    happened,
    attention: waiting,
    running: runningNow,
    /** The sentence under the heading needs the digest, what landed and what waits. */
    head: Promise.all([digest, happened, waiting]),
    spend,
  };
}

/**
 * Ask g1t: the direct message with the workspace's orchestrator, opened or
 * made, with what was asked posted in it; then that conversation.
 */
export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  if (!roleIn(viewer, slug)) throw data(null, { status: 404 });
  const form = await request.formData();
  const body = String(form.get("body") ?? "").trim();
  if (!body) return { error: "Write what you need." };
  const listed = await workspaceAgents.list(slug, viewer).catch(() => null);
  const g1t = listed?.ok ? listed.value.find(isOrchestrator) : null;
  if (!g1t) return { error: "g1t isn't reachable right now. Try again in a moment." };
  const dm = await chat.openDm(slug, viewer, [{ kind: "agent", id: g1t.id }]).catch(() => null);
  if (!dm?.ok) return { error: dm ? dm.error.message : "Chat didn't answer. Try again in a moment." };
  const posted = await chat.post(slug, dm.value.id, viewer, { body }).catch(() => null);
  if (!posted?.ok) return { error: posted ? posted.error.message : "Your message didn't send. Try again." };
  throw redirect(channelPath(slug, dm.value));
}

/** Ask g1t, as one bar: Enter sends; Shift+Enter is a new line. Chat is one click away. */
function AskG1t({ slug, available, error }: { slug: string; available: boolean; error: string | null }) {
  const navigation = useNavigation();
  const here = homePagePath(slug);
  const busy = navigation.state !== "idle" && navigation.formAction === here;
  const [text, setText] = useState("");
  return (
    <Form method="post" action={here} className="rounded-2xl border border-line-strong bg-surface transition-colors focus-within:border-accent/40">
      <div className="flex items-start gap-3 px-3 py-2.5 sm:px-4">
        <span className="mt-1 shrink-0">
          <G1tMark size={20} />
        </span>
        <textarea
          name="body"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (text.trim()) event.currentTarget.form?.requestSubmit();
            }
          }}
          rows={1}
          disabled={!available}
          aria-label="Ask g1t"
          placeholder={available ? "Ask g1t for anything…" : "g1t isn't reachable right now."}
          className="field-sizing-content block max-h-40 min-h-7 w-full grow resize-none bg-transparent py-1 text-[0.9375rem] leading-relaxed text-fg outline-none placeholder:text-faint disabled:cursor-not-allowed"
        />
        <Button
          type="submit"
          disabled={!available || busy || !text.trim()}
          variant="accent"
          size="sm"
          className="rounded-lg px-3 text-sm disabled:bg-line disabled:text-faint disabled:opacity-100"
        >
          {busy ? "Sending…" : "Ask"}
          <ArrowRight size={14} />
        </Button>
      </div>
      {error && <p className="px-4 pb-2.5 text-sm text-danger">{error}</p>}
    </Form>
  );
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

export default function Home({ loaderData, actionData }: Route.ComponentProps) {
  const { slug, now, tz, span, orchestrator, faces, work, since, happened, attention: waiting, running: runningNow, head, spend } = loaderData;
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

      <AskG1t slug={slug} available={orchestrator} error={actionData?.error ?? null} />

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
          <Await resolve={since}>{([value, spanWork]) => <PeopleAgentsCard digest={value} work={spanWork} span={span} faces={faces} code={loaderData.code} />}</Await>
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
                {(value) => <DecisionsCard decisions={value?.decisions ?? null} read={value?.decisionsRead ?? null} now={now} tz={tz} />}
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
            <Suspense fallback={null}>
              <Await resolve={work}>{(value) => <Sources work={value} />}</Await>
            </Suspense>
          </div>
        </div>
      </section>

      {/* 3. Running now. */}
      <Card title="Running now" link={{ label: "Agents", to: `/${slug}/-/agents` }}>
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
