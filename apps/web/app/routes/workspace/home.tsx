import { ArrowRight } from "lucide-react";
import { Suspense, useState } from "react";
import { Await, Form, Link, data, redirect, useNavigation } from "react-router";

import { hasCodeAccess } from "@g1t/contracts";

import type { Route } from "./+types/home";
import { AttentionList, Card, DayCard, DaySkeleton, RowsSkeleton, Sources, SpendCard, SpendSkeleton, StartHere } from "../../components/today";
import { G1tMark, isOrchestrator } from "../../components/orchestrator";
import { Skeleton } from "../../components/ui/skeleton";
import { channelPath } from "../../lib/chat";
import { sidebarOrNull } from "../../lib/chat.server";
import { readCookie } from "../../lib/mission";
import { loadMissionControl } from "../../lib/mission-control.server";
import { page } from "../../lib/meta";
import { chat, inbox, workspaceAgents } from "../../lib/services.server";
import { assertSameOrigin, requireUser, roleIn } from "../../lib/session.server";
import { type Attention, type DayWork, attention, daySentence, dayWork, shortDate, waitingSentence } from "../../lib/today";
import { loadCapped, loadCodeWork, loadSessions, loadSpend } from "../../lib/today.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Today · ${params.owner} · g1t` });
}

/** Unread notifications read for Needs attention. */
const NOTIFICATIONS_READ = 50;

/**
 * Today: the workspace's front page. A sentence about the day, how the
 * agents' work went, what needs you with the action right there, what the
 * day cost, and one place to start. Only the agents list (for Ask g1t) is
 * waited for; every section streams in on its own, and one whose service
 * does not answer says so. Definitions: lib/today.ts and the Today guide.
 */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  if (!roleIn(viewer, slug)) throw data(null, { status: 404 });
  const membership = viewer.workspaces?.find((m) => m.slug === slug) ?? null;
  const code = hasCodeAccess(membership);
  const now = Date.now();
  const tz = readCookie(request.headers.get("cookie"), "g1t_tz");

  const agentsP = workspaceAgents
    .list(slug, viewer)
    .then((result) => (result.ok ? result.value.filter((agent) => !agent.archived_at) : null))
    .catch(() => null);
  const codeWorkP = code ? loadCodeWork(viewer, slug, now).catch(() => null) : Promise.resolve("no_access" as const);
  const sessionsP = loadSessions(viewer, slug, now, tz).catch(() => null);
  const codeNeedsP = code
    ? loadMissionControl(viewer, request, slug)
        .then(({ value }) => value.needs)
        .catch(() => null)
    : Promise.resolve(null);
  const cappedP = loadCapped(viewer, slug).catch(() => null);
  const chatP = sidebarOrNull(slug, viewer);
  const notificationsP = inbox
    .list(viewer, { unread: true, limit: NOTIFICATIONS_READ })
    .then((result) => result.items)
    .catch(() => null);

  const day: Promise<DayWork | null> = Promise.all([codeWorkP, sessionsP])
    .then(([codeWork, sessions]) =>
      codeWork == null && sessions == null ? null : dayWork({ now, timeZone: tz, slug, code: codeWork, sessions }),
    )
    .catch(() => null);
  const waiting: Promise<Attention> = Promise.all([codeNeedsP, cappedP, agentsP, notificationsP, chatP]).then(
    ([codeNeeds, capped, agents, notifications, sidebar]) =>
      attention({
        slug,
        code,
        codeNeeds,
        capped: capped?.capped ?? null,
        agents,
        canManage: capped?.canManage ?? false,
        notifications,
        chat: sidebar?.entries ?? null,
      }),
  ).catch(() => ({ rows: [], start: null, missing: ["Code", "Agents", "Notifications", "Chat"] }));
  const spend = loadSpend(viewer, slug, now).catch(() => null);

  const agents = await agentsP;
  return {
    slug,
    code,
    now,
    date: shortDate(now, tz),
    orchestrator: agents?.some(isOrchestrator) ?? false,
    day,
    attention: waiting,
    /** The sentence under the heading needs both. */
    head: Promise.all([day, waiting]),
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
  const here = `/${slug}/-/today`;
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
        <button
          type="submit"
          disabled={!available || busy || !text.trim()}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 text-sm font-medium text-bg transition-colors hover:bg-accent-hover disabled:bg-line disabled:text-faint"
        >
          {busy ? "Sending…" : "Ask"}
          <ArrowRight size={14} />
        </button>
      </div>
      {error && <p className="px-4 pb-2.5 text-sm text-danger">{error}</p>}
    </Form>
  );
}

export default function Today({ loaderData, actionData }: Route.ComponentProps) {
  const { slug, now, date, orchestrator, day, attention: waiting, head, spend } = loaderData;
  return (
    <div className="mx-auto w-full max-w-[1040px] space-y-5 px-4 py-5 md:px-10 md:py-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-[1.75rem] leading-tight font-semibold tracking-tight">Today</h1>
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">
            <span className="text-fg-soft">{date}</span> ·{" "}
            <Suspense fallback={<Skeleton className="inline-block h-3.5 w-72 align-middle" />}>
              <Await resolve={head}>
                {([work, att]) => (
                  <>
                    {work ? daySentence(work) : "Today's agent work couldn't be read."} {waitingSentence(att.rows.length)}
                  </>
                )}
              </Await>
            </Suspense>
          </p>
        </div>
        <Suspense fallback={<ReviewButton count={null} />}>
          <Await resolve={waiting}>{(att) => <ReviewButton count={att.rows.length} />}</Await>
        </Suspense>
      </header>

      <AskG1t slug={slug} available={orchestrator} error={actionData?.error ?? null} />

      <Suspense fallback={<DaySkeleton />}>
        <Await resolve={day}>{(work) => <DayCard work={work} />}</Await>
      </Suspense>

      {/* Phones put the one place to start first; wide screens keep it beside the list. */}
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        <div className="lg:col-start-1 lg:row-span-2 lg:row-start-1">
          <Card title="Needs attention" link={{ label: "Notifications", to: "/notifications" }}>
            <Suspense fallback={<RowsSkeleton />}>
              <Await resolve={waiting}>{(att) => <AttentionList attention={att} />}</Await>
            </Suspense>
            <Suspense fallback={null}>
              <Await resolve={day}>{(work) => <Sources work={work} />}</Await>
            </Suspense>
          </Card>
        </div>
        <div className="order-first lg:order-none lg:col-start-2 lg:row-start-2">
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
        <div className="lg:col-start-2 lg:row-start-1">
          <Suspense
            fallback={
              <Card title="Spent today">
                <SpendSkeleton />
              </Card>
            }
          >
            <Await resolve={spend}>{(value) => <SpendCard spend={value} slug={slug} />}</Await>
          </Suspense>
        </div>
      </div>
    </div>
  );
}

/** What's waiting, one click away: loud while there is something, quiet when there isn't. */
function ReviewButton({ count }: { count: number | null }) {
  return (
    <Link
      to="/notifications"
      className={`inline-flex h-9 shrink-0 items-center gap-1.5 self-start rounded-lg px-3.5 text-sm font-medium transition-colors ${
        count ? "bg-accent text-bg hover:bg-accent-hover" : "border border-line text-fg/90 hover:border-line-strong hover:bg-raised"
      }`}
    >
      {count ? `Review ${count.toLocaleString("en-US")}` : "Notifications"}
      <ArrowRight size={14} />
    </Link>
  );
}
