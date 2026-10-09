/**
 * A commit's checks at a glance: a mark beside the commit (a check when
 * every check passed, a cross when one failed, an amber dot while any is
 * running) that opens the list of them, each with how it went and a link
 * to its details. Every reporter's checks are listed alike: workflow jobs,
 * check runs and statuses from integrations and deployments.
 *
 * Loaders pass the page's checks as one promise (lib/commit-checks.server.ts);
 * each badge shows a placeholder until it settles.
 */
import { Ban, Check, CircleDashed, X } from "lucide-react";
import { Suspense } from "react";
import { Await, Link } from "react-router";

import type { CheckItem, CommitChecks } from "@g1t/contracts";

import { useAddresses } from "../lib/addresses";
import { cn } from "../lib/cn";
import { checkDetail, checksHeadline, checksTally, detailsLink } from "../lib/commit-checks";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Skeleton } from "./ui/skeleton";

/** A page's commits' checks by SHA, as loaders return them: on their way, read, or not to be had. */
export type ChecksSource = Promise<Record<string, CommitChecks> | null> | Record<string, CommitChecks> | null | undefined;

/** One check's state as an icon. */
export function CheckStateIcon({ state, size = 16 }: { state: CheckItem["state"] | CommitChecks["state"]; size?: number }) {
  switch (state) {
    case "success":
      return (
        <span className="inline-flex shrink-0 rounded-full bg-success/15 p-0.5 text-success" aria-label="Successful">
          <Check size={size - 4} strokeWidth={3} />
        </span>
      );
    case "failure":
      return (
        <span className="inline-flex shrink-0 rounded-full bg-danger/15 p-0.5 text-danger" aria-label="Failing">
          <X size={size - 4} strokeWidth={3} />
        </span>
      );
    case "pending":
      return (
        <span className="inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }} aria-label="In progress">
          <span className="size-2 rounded-full bg-warn motion-safe:animate-pulse" />
        </span>
      );
    case "cancelled":
      return <Ban size={size} className="shrink-0 text-faint" aria-label="Cancelled" />;
    default:
      return <CircleDashed size={size} className="shrink-0 text-faint" aria-label="Skipped" />;
  }
}

/** The mark itself: what all of a commit's checks add up to. */
function Mark({ state }: { state: CommitChecks["state"] }) {
  if (state === "success") return <Check size={15} strokeWidth={2.75} className="text-success" />;
  if (state === "failure") return <X size={15} strokeWidth={2.75} className="text-danger" />;
  return <span className="size-2 rounded-full bg-warn" />;
}

function CheckRow({ item }: { item: CheckItem }) {
  const site = useAddresses().site;
  const link = detailsLink(item, site);
  const detail = checkDetail(item);
  return (
    <li className="flex items-center gap-2.5 px-4 py-2">
      <CheckStateIcon state={item.state} size={16} />
      <p className="min-w-0 grow truncate text-[0.8125rem]">
        <span className="font-medium text-fg">{item.name}</span> <span className="text-muted">{detail}</span>
      </p>
      {link &&
        (link.external ? (
          <a href={link.href} target="_blank" rel="noreferrer" className="shrink-0 text-xs font-medium text-accent hover:underline">
            Details
          </a>
        ) : (
          <Link to={link.href} className="shrink-0 text-xs font-medium text-accent hover:underline">
            Details
          </Link>
        ))}
    </li>
  );
}

/** The list a commit's mark opens. */
export function ChecksList({ checks, className }: { checks: CommitChecks; className?: string }) {
  return (
    <div className={className}>
      <div className="flex items-start gap-3 border-b border-line px-4 py-3">
        <span className="mt-0.5">
          <CheckStateIcon state={checks.state} size={20} />
        </span>
        <div className="min-w-0">
          <p className="font-semibold text-fg">{checksHeadline(checks)}</p>
          <p className="text-xs text-muted">{checksTally(checks)}</p>
        </div>
      </div>
      <ul className="max-h-80 divide-y divide-line overflow-y-auto">
        {checks.checks.map((item) => (
          <CheckRow key={`${item.kind}:${item.id ?? item.name}`} item={item} />
        ))}
      </ul>
    </div>
  );
}

/** A commit's mark, opening its checks; nothing when nothing reported on it. */
export function CommitChecksMark({ checks, className }: { checks: CommitChecks | null | undefined; className?: string }) {
  if (!checks || checks.state === "none" || checks.total === 0) return null;
  const headline = checksHeadline(checks);
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`${headline}: ${checksTally(checks)}`}
        className={cn(
          "relative z-10 inline-flex size-6 shrink-0 pointer-coarse:size-8 animate-fade-in items-center justify-center rounded-md transition-colors hover:bg-raised data-[state=open]:bg-raised",
          className,
        )}
      >
        <Mark state={checks.state} />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[28rem] p-0">
        <ChecksList checks={checks} />
      </PopoverContent>
    </Popover>
  );
}

/** Holds a mark's place while the page's checks are read. */
export function CommitChecksPlaceholder({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cn("inline-flex size-6 shrink-0 items-center justify-center", className)}>
      <Skeleton className="size-3.5 rounded-full" />
    </span>
  );
}

/**
 * The mark for commit `sha` from a page's checks: a placeholder while they
 * are on their way, then the mark, or nothing.
 */
export function CommitChecksBadge({ checks, sha, className }: { checks: ChecksSource; sha: string; className?: string }) {
  if (!checks) return null;
  if (!(checks instanceof Promise)) return <CommitChecksMark checks={checks[sha]} className={className} />;
  return (
    <Suspense fallback={<CommitChecksPlaceholder className={className} />}>
      <Await resolve={checks} errorElement={null}>
        {(found) => <CommitChecksMark checks={found?.[sha]} className={className} />}
      </Await>
    </Suspense>
  );
}
