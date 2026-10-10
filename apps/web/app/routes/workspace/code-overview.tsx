import { Suspense, lazy } from "react";
import { type ShouldRevalidateFunctionArgs, data } from "react-router";

import type { Route } from "./+types/code-overview";
import { page } from "../../lib/meta";
import { loadMissionControl } from "../../lib/mission-control.server";
import { requireUser, roleIn } from "../../lib/session.server";
import { Card } from "../../components/ui/card";
import { Skeleton, SkeletonCard, SkeletonLine, SkeletonStat } from "../../components/ui/skeleton";

export { action } from "../home";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Overview · Code · ${params.owner} · g1t` });
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  const out = new Headers();
  const timing = loaderHeaders.get("Server-Timing");
  if (timing) out.set("Server-Timing", timing);
  return out;
}

/**
 * Code's Overview: what was Mission control's code panels, for this
 * workspace. What needs you, what waits on agents and what landed, the
 * week's numbers, and the ways to start work.
 */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const { value, timing } = await loadMissionControl(viewer, request, params.owner);
  return data(value, { headers: { "Server-Timing": timing } });
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

export default function CodeOverview({ loaderData, actionData }: Route.ComponentProps) {
  return (
    <Suspense fallback={<MissionControlSkeleton />}>
      <MissionControl loaderData={loaderData} delegated={actionData ?? null} variant="code" />
    </Suspense>
  );
}

/**
 * Mission control's outline while its code arrives, piece for piece as
 * components/mission-control.tsx lays it out: the greeting, the Agent box,
 * the actions under it, the stats, then the work list beside the week. Each
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
          <SkeletonLine className="w-[36rem] max-w-full" barClassName="h-3.5" />
          <SkeletonLine className="w-full sm:hidden" barClassName="h-3.5" />
          <SkeletonLine className="w-2/3 sm:hidden" barClassName="h-3.5" />
        </div>
      </header>
      {/* The Agent box (components/ask-composer.tsx), then the actions under it. */}
      <div className="space-y-3">
        <Card>
          <SkeletonLine className="mx-4 mt-3 w-36 text-sm" />
          <div className="px-4 pt-3.5 pb-2 text-sm">
            <SkeletonLine className="w-[30rem] max-w-full" />
            <span className="block h-[1lh]" />
          </div>
          <div className="flex flex-wrap items-center gap-2 px-3 pb-3">
            <Skeleton className="h-8 w-[4.5rem] rounded-md" />
            <Skeleton className="h-8 w-[9.5rem] rounded-md" />
            <Skeleton className="size-8 rounded-md" />
            <Skeleton className="size-8 rounded-md" />
            <Skeleton className="ml-auto size-8 rounded-md" />
          </div>
        </Card>
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-[38px] w-60 rounded-md" />
          <Skeleton className="h-[38px] w-28 rounded-md" />
          <Skeleton className="h-[38px] w-44 rounded-md" />
        </div>
      </div>
      <Card tone="plain" className="grid grid-cols-2 gap-px overflow-hidden bg-line lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => (
          <SkeletonStat key={index} className={index === 4 ? "col-span-2 lg:col-span-1" : undefined} />
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
                    <Skeleton className="h-[17rem] rounded-xl" />
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
