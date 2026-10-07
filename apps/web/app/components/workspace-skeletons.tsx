/**
 * The shapes of a workspace's tabs while they load: the same layout as
 * the real thing, so nothing moves when it arrives (components/ui/skeleton.tsx).
 */
import type { WorkspaceTabKey } from "../lib/workspace-nav";
import { Skeleton, SkeletonRows, SkeletonText } from "./ui/skeleton";

/** A project card, as the Overview and the Projects grid show them. */
export function ProjectCardSkeleton() {
  return (
    <li aria-hidden="true" className="flex flex-col rounded-2xl border border-line bg-surface p-5">
      <div className="flex items-start gap-3">
        <Skeleton className="size-9 shrink-0 rounded-lg" />
        <div className="grow space-y-2 pt-1">
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-3 w-48" />
        </div>
      </div>
      <div className="mt-8 flex gap-4 border-t border-line pt-3">
        <Skeleton className="h-3 w-12" />
        <Skeleton className="h-3 w-8" />
        <Skeleton className="h-3 w-8" />
      </div>
    </li>
  );
}

/** The Projects page's rows. */
export function ProjectRowsSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div aria-hidden="true" className="overflow-hidden rounded-xl border border-line bg-surface">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-3 border-b border-line px-4 py-3.5 last:border-b-0">
          <Skeleton className="size-8 shrink-0 rounded-md" />
          <div className="grow space-y-2">
            <Skeleton className="h-3.5" style={{ width: `${30 + ((index * 13) % 25)}%` }} />
            <Skeleton className="h-3" style={{ width: `${45 + ((index * 7) % 30)}%` }} />
          </div>
          <Skeleton className="hidden h-3 w-16 sm:block" />
          <Skeleton className="size-8 shrink-0 rounded-md" />
        </div>
      ))}
    </div>
  );
}

/** The Projects page: its search and filters, then rows. */
export function ProjectsSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading projects" className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-9 w-full rounded-md sm:w-72" />
        <Skeleton className="h-9 w-28 rounded-md" />
        <Skeleton className="h-9 w-28 rounded-md" />
        <Skeleton className="h-9 w-36 rounded-md" />
      </div>
      <ProjectRowsSkeleton />
    </div>
  );
}

/** The Overview: pinned cards, then recent ones beside the aside. */
export function OverviewSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="grid gap-10 lg:grid-cols-[1fr_18rem]">
      <div className="space-y-10">
        <div>
          <Skeleton className="h-3.5 w-20" />
          <ul className="mt-3 grid gap-4 sm:grid-cols-2">
            {Array.from({ length: 4 }, (_, index) => (
              <ProjectCardSkeleton key={index} />
            ))}
          </ul>
        </div>
        <div>
          <Skeleton className="h-3.5 w-28" />
          <SkeletonRows rows={4} className="mt-3 rounded-xl border border-line bg-surface" />
        </div>
      </div>
      <div className="space-y-4">
        <Skeleton className="h-40 rounded-xl" />
        <SkeletonText lines={4} />
      </div>
    </div>
  );
}

/** Whichever tab is on its way. */
export function WorkspaceTabSkeleton({ tab }: { tab: WorkspaceTabKey }) {
  if (tab === "overview") return <OverviewSkeleton />;
  if (tab === "projects") return <ProjectsSkeleton />;
  return (
    <div aria-busy="true" aria-label="Loading" className="space-y-4">
      <Skeleton className="h-3.5 w-2/3 max-w-xl" />
      <SkeletonRows rows={6} className="rounded-xl border border-line bg-surface" />
    </div>
  );
}
