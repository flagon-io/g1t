import { ArrowRight } from "lucide-react";
import { Suspense, lazy } from "react";
import { Await, Link, type ShouldRevalidateFunctionArgs, data } from "react-router";

import { type User, hasCodeAccess } from "@g1t/contracts";

import type { Route } from "./+types/code-overview";
import { page } from "../../lib/meta";
import { loadMissionControl } from "../../lib/mission-control.server";
import { billing, identity } from "../../lib/services.server";
import { requireUser, roleIn } from "../../lib/session.server";
import { usageFor } from "../../lib/workspace-usage.server";
import { settingsPath } from "../../lib/workspace-nav";
import { isFailed, part } from "../../lib/partial";
import { loadRepos } from "../../lib/home.server";
import { shapeGround } from "../../lib/ground";
import { providerQuarter, signalsRange } from "../../lib/signals";
import { loadGroups, loadSignalData } from "../../lib/signals.server";
import { Unavailable } from "../../components/boundary";
import { GroundSkeleton, GroundTruth } from "../../components/ground-truth";
import { UsageCard } from "../../components/usage-card";
import { Avatar } from "../../components/ui/avatar";
import { Badge } from "../../components/ui/badge";
import { Card } from "../../components/ui/card";
import { Skeleton, SkeletonCard, SkeletonLine, SkeletonStat } from "../../components/ui/skeleton";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Overview · Code · ${params.owner} · g1t` });
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  const out = new Headers();
  const timing = loaderHeaders.get("Server-Timing");
  if (timing) out.set("Server-Timing", timing);
  return out;
}

/** Most members listed before "and N more". */
const MAX_FACES = 10;

/**
 * The workspace's Overview, its data on one page: what needs you and what
 * landed, the week's numbers, activity, and a way to open a work item;
 * then the workspace's ground truth, from what its work says
 * (lib/signals.ts): the past week, the quarter's agent spend threaded to
 * the work it produced, what is moving and what is waiting team by team,
 * and quiet changes in who works where, streamed; then the month's usage
 * against its plan and who is in it. Each part is left out, or says so,
 * when its service does not answer.
 */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  const role = roleIn(viewer, slug);
  if (!role) throw data(null, { status: 404 });
  const membership = viewer.workspaces?.find((m) => m.slug === slug) ?? null;
  const ground = hasCodeAccess(membership) ? loadGround(viewer, slug, Date.now()).catch(() => null) : null;
  const [{ value, timing }, members, usage] = await Promise.all([
    loadMissionControl(viewer, request, params.owner),
    part(identity.listMembers(slug, viewer), "The member list"),
    usageFor(slug, viewer),
  ]);
  const workspace = {
    slug,
    role,
    ground,
    members: isFailed(members) ? members : members.ok ? members.value : null,
    usage,
  };
  return data({ ...value, glance: workspace }, { headers: { "Server-Timing": timing } });
}

/** Everything the work says, shaped for the page; null when the work service did not answer. */
async function loadGround(viewer: User, slug: string, now: number) {
  const owned = await loadRepos(viewer, slug).catch(() => null);
  if (!owned) return null;
  const [found, groups, providers] = await Promise.all([
    loadSignalData(viewer, slug, now, owned).catch(() => null),
    loadGroups(viewer, slug, owned).catch(() => null),
    // What the connected providers say was spent: beside the rest, never in the way of it.
    billing
      .providerCosts(slug, viewer, signalsRange(now).quarter)
      .then((result) => (result.ok ? result.value : null))
      .catch(() => null),
  ]);
  return found ? { ...shapeGround(found, groups, now), providers: providerQuarter(providers, found.range.quarter) } : null;
}

/**
 * Switching tabs, the sort or the activity list changes only the address:
 * everything is already loaded. Marking an inbox item read changes nothing
 * else here.
 */
export function shouldRevalidate({ currentUrl, nextUrl, formMethod, formAction, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (!formMethod && currentUrl.pathname === nextUrl.pathname && currentUrl.search !== nextUrl.search) return false;
  if (formAction === "/notifications") return false;
  return defaultShouldRevalidate;
}

/** Loaded once the browser is idle (components/shell.tsx), so the skeleton below is rarely seen. */
const MissionControl = lazy(() => import("../../components/mission-control"));

export default function CodeOverview({ loaderData }: Route.ComponentProps) {
  return (
    <Suspense fallback={<MissionControlSkeleton />}>
      <MissionControl loaderData={loaderData}>
        <AtAGlance glance={loaderData.glance} />
      </MissionControl>
    </Suspense>
  );
}

/** What the work says, then the month's usage and who is in the workspace. */
function AtAGlance({ glance }: { glance: Route.ComponentProps["loaderData"]["glance"] }) {
  const { slug, role, members, usage } = glance;
  const owner = role === "owner";
  const everyone = owner ? settingsPath(slug, "members") : `/${slug}/-/people`;
  return (
    <>
      {glance.ground && (
        <Suspense fallback={<GroundSkeleton />}>
          <Await resolve={glance.ground}>
            {(ground) => (ground ? <GroundTruth slug={slug} ground={ground} /> : <Unavailable what="What the work says" />)}
          </Await>
        </Suspense>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_21rem] xl:grid-cols-[minmax(0,1fr)_23rem]">
        {usage ? (
          <UsageCard slug={slug} glance={usage} owner={owner} />
        ) : (
          <Card asChild className="self-start p-5">
            <section>
              <h2 className="font-medium">Usage</h2>
              <p className="mt-1.5 text-sm text-muted">This month&apos;s usage isn&apos;t available right now.</p>
              <Link to={settingsPath(slug, "usage")} className="mt-3 inline-flex items-center gap-1 text-sm text-accent hover:underline">
                Open Usage <ArrowRight size={13} />
              </Link>
            </section>
          </Card>
        )}
        <Card asChild className="self-start p-5">
          <section>
            <div className="flex items-center justify-between">
              <h2 className="font-medium">Members{members && !isFailed(members) ? ` · ${members.length}` : ""}</h2>
              <Link to={everyone} className="text-xs text-muted hover:text-fg">
                {owner ? "Manage" : "See all"}
              </Link>
            </div>
            {isFailed(members) ? (
              <div className="mt-3">
                <Unavailable what={members.what} compact />
              </div>
            ) : members ? (
              <>
                <ul className="mt-3 space-y-2">
                  {members.slice(0, MAX_FACES).map((member) => (
                    <li key={member.username} className="flex items-center gap-2.5 text-sm">
                      <Avatar name={member.username} image={member.avatar} size={24} />
                      <Link to={`/u/${member.username}`} className="min-w-0 grow truncate hover:text-accent">
                        {member.name?.trim() || member.username}
                        {member.name?.trim() && <span className="ml-1.5 font-mono text-xs text-faint">{member.username}</span>}
                      </Link>
                      {member.role === "owner" && <Badge size="md">owner</Badge>}
                    </li>
                  ))}
                </ul>
                {members.length > MAX_FACES && <p className="mt-2 text-xs text-faint">and {members.length - MAX_FACES} more</p>}
              </>
            ) : (
              <p className="mt-3 text-sm text-muted">The member list isn&apos;t available right now.</p>
            )}
          </section>
        </Card>
      </div>
    </>
  );
}

/**
 * The Overview's outline while its code arrives, piece for piece as
 * components/mission-control.tsx lays it out: the title, the actions
 * under it, the stats, then the work list beside the week. Each
 * piece has the padding and line heights of the real one, so nothing moves
 * when it arrives.
 */
export function MissionControlSkeleton() {
  return (
    <main aria-busy="true" className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-6 sm:py-10">
      <span role="status" className="sr-only">
        Loading…
      </span>
      <header>
        <SkeletonLine className="w-72 max-w-full text-[1.75rem] leading-tight sm:text-[2rem]" barClassName="h-8" />
        {/* The date and the week's summary: one line wide, three on a phone. */}
        <div className="mt-1.5 text-sm">
          <SkeletonLine className="w-xl max-w-full" barClassName="h-3.5" />
          <SkeletonLine className="w-full sm:hidden" barClassName="h-3.5" />
          <SkeletonLine className="w-2/3 sm:hidden" barClassName="h-3.5" />
        </div>
      </header>
      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-9.5 w-28 rounded-md" />
        <Skeleton className="h-9.5 w-44 rounded-md" />
      </div>
      <Card tone="plain" className="grid grid-cols-2 gap-px overflow-hidden bg-line lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <SkeletonStat key={index} />
        ))}
      </Card>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_21rem] xl:grid-cols-[minmax(0,1fr)_23rem]">
        <Card className="self-start overflow-hidden">
          <div className="flex items-center gap-4 border-b border-line px-4 py-3 text-sm sm:px-5">
            <SkeletonLine className="w-24" />
            <SkeletonLine className="w-32" />
            <SkeletonLine className="hidden w-28 sm:flex" />
          </div>
          <div className="divide-y divide-line">
            {Array.from({ length: 5 }, (_, index) => (
              <div key={index}>
                <div className="flex items-center gap-3 px-4 py-3 sm:px-5">
                  <Skeleton className="size-8 shrink-0 rounded-md" />
                  <span className="min-w-0 grow">
                    <SkeletonLine className="text-sm" width={`${70 - ((index * 17) % 30)}%`} />
                    <SkeletonLine className="mt-0.5 text-xs" width={`${50 - ((index * 11) % 20)}%`} />
                  </span>
                  <Skeleton className="hidden h-4 w-24 shrink-0 sm:block" />
                </div>
                {/* The first row stands open, as the real list's does. */}
                {index === 0 && (
                  <div className="px-4 pb-4 sm:px-5 sm:pb-5">
                    <Skeleton className="h-68 rounded-xl" />
                    <Skeleton className="mt-3 h-8 w-44 rounded-md" />
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
        <div className="space-y-6">
          <SkeletonCard lines={0} className="h-80 p-5" />
          <SkeletonCard lines={6} className="p-5" />
        </div>
      </div>
    </main>
  );
}
