/**
 * CODEOWNERS on the site: a file's problems listed like a linter's, and on
 * a pull request, who owns what it changes and whose approval it still
 * needs. Teams are named `@workspace/team` and link to their pages.
 */
import { CircleCheck, CircleDashed, CircleSlash, FileWarning, Hourglass, ShieldCheck, Users } from "lucide-react";
import { Link } from "react-router";

import {
  CODEOWNERS_ERROR_LABELS,
  CODEOWNERS_LOCATIONS,
  type CodeownersError,
  type CodeownersReport,
  type OwnerReview,
  type PullCodeOwners,
} from "@g1t/contracts";

import { Badge } from "./ui/badge";
import { Card } from "./ui/card";
import { Skeleton } from "./ui/skeleton";
import { UserCard } from "./user-card";

/** The guide to the file. */
export const CODEOWNERS_DOCS = "https://docs.g1t.sh/guides/codeowners/";

/** Where a file at `path` on `ref` is shown, optionally at a line. */
export function blobHref(base: string, ref: string, path: string, line?: number): string {
  return `${base}/blob/${encodeURIComponent(ref)}/${path}${line ? `#L${line}` : ""}`;
}

/** A team's page, from `workspace/slug` (with or without the `@`). */
export function teamHref(handle: string): string {
  const [workspace, slug] = handle.replace(/^@/, "").split("/");
  return `/${workspace}/-/teams/${slug}`;
}

/** An owner as written: a person, a team, or an email address, linked where it can be. */
export function OwnerLink({ owner }: { owner: string }) {
  const name = owner.replace(/^@/, "");
  const className = "font-mono text-xs text-fg-soft hover:text-accent hover:underline";
  if (owner.startsWith("@") && name.includes("/")) {
    return (
      <Link to={teamHref(name)} className={className}>
        {owner}
      </Link>
    );
  }
  if (owner.startsWith("@") && /^[a-z0-9-]{1,39}$/i.test(name) && name !== "g1t") {
    return (
      <UserCard username={name.toLowerCase()}>
        <Link to={`/u/${name.toLowerCase()}`} className={className}>
          {owner}
        </Link>
      </UserCard>
    );
  }
  return <span className="font-mono text-xs text-fg-soft">{owner}</span>;
}

/** A team asked to review: `@workspace/team`, linking to its page. */
export function TeamReviewer({ team }: { team: string }) {
  return (
    <li className="flex items-center gap-2 px-1">
      <span className="flex size-5 shrink-0 items-center justify-center rounded bg-raised text-muted ring-1 ring-line">
        <Users size={12} />
      </span>
      <Link to={teamHref(team)} className="grow truncate font-mono text-xs hover:text-accent hover:underline">
        @{team}
      </Link>
      <span className="text-xs text-faint">Review requested</span>
    </li>
  );
}

/** A file's problems, one row each: the line, what kind, the token at fault, and why. */
export function CodeownersErrorList({ errors, lineHref }: { errors: CodeownersError[]; lineHref: (line: number) => string | null }) {
  return (
    <ul className="divide-y divide-line">
      {errors.map((error, index) => {
        const href = error.line > 0 ? lineHref(error.line) : null;
        return (
          <li key={`${error.line}-${index}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
            <span className="w-14 shrink-0 font-mono text-xs text-faint">
              {error.line === 0 ? (
                "File"
              ) : href ? (
                <Link to={href} className="hover:text-accent hover:underline">
                  Line {error.line}
                </Link>
              ) : (
                `Line ${error.line}`
              )}
            </span>
            <Badge tone="danger">{CODEOWNERS_ERROR_LABELS[error.kind] ?? error.kind}</Badge>
            {error.token && <code className="min-w-0 truncate font-mono text-xs text-fg">{error.token}</code>}
            <span className="min-w-0 basis-full text-muted sm:pl-17">{error.message}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** The file a branch's code owners come from, and what is wrong with it: Settings → Branches and merging. */
export function CodeownersReportPanel({ report, base, branch }: { report: CodeownersReport | null; base: string; branch: string }) {
  if (!report) {
    return (
      <Card asChild className="p-4 text-sm text-muted">
        <p>
          The CODEOWNERS file could not be read just now. Reload the page to try again.
        </p>
      </Card>
    );
  }
  if (!report.path) {
    return (
      <Card tone="plain" className="border-dashed p-4 text-sm">
        <p className="font-medium">No CODEOWNERS file</p>
        <p className="mt-1 text-muted">
          g1t looks on {branch} for the first of these, and asks the owners it names to review changes to their files:
        </p>
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {CODEOWNERS_LOCATIONS.map((location) => (
            <li key={location}>
              <code className="rounded border border-line bg-bg px-1.5 py-0.5 font-mono text-xs">{location}</code>
            </li>
          ))}
        </ul>
        <p className="mt-3">
          <a href={CODEOWNERS_DOCS} className="text-accent hover:underline">
            How to write one
          </a>
        </p>
      </Card>
    );
  }
  const path = report.path;
  const errors = report.errors.length;
  return (
    <Card tone="plain" className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-surface px-4 py-3 text-sm">
        {errors > 0 ? (
          <FileWarning size={16} className="shrink-0 text-danger" />
        ) : (
          <ShieldCheck size={16} className="shrink-0 text-success" />
        )}
        <Link to={blobHref(base, branch, path)} className="font-mono text-sm hover:text-accent hover:underline">
          {path}
        </Link>
        <span className="text-xs text-muted">
          {report.rules === 1 ? "1 rule" : `${report.rules} rules`}
          {report.sections.length > 0 &&
            ` · ${report.sections.length === 1 ? "1 section" : `${report.sections.length} sections`}`}
        </span>
        <span className={`ml-auto text-xs ${errors > 0 ? "text-danger" : "text-muted"}`}>
          {errors === 0 ? "No errors" : errors === 1 ? "1 error" : `${errors} errors`}
        </span>
      </div>
      {errors > 0 && (
        <div className="border-t border-line">
          <CodeownersErrorList errors={report.errors} lineHref={(line) => blobHref(base, branch, path, line)} />
        </div>
      )}
    </Card>
  );
}

/** The panel's shape while the file is read. */
export function CodeownersReportSkeleton() {
  return (
    <Card aria-busy="true" className="flex items-center gap-3 px-4 py-3">
      <Skeleton className="size-4 rounded-full" />
      <Skeleton className="h-3 w-36" />
      <Skeleton className="h-3 w-20" />
      <Skeleton className="ml-auto h-3 w-14" />
    </Card>
  );
}

/** Above a CODEOWNERS file: what is wrong with it, or that nothing is. */
export function CodeownersFileErrors({ report, path, base }: { report: CodeownersReport; path: string; base: string }) {
  // Not read at this ref (a commit, say): nothing to say about it.
  if (!report.path) return null;
  // Another location comes first on this branch, so this file is not read.
  if (report.path !== path) {
    return (
      <p className="mb-4 flex items-center gap-2 text-sm text-muted">
        <CircleDashed size={15} className="shrink-0 text-faint" />
        <span>
          Not in use: g1t reads{" "}
          <Link to={blobHref(base, report.ref, report.path)} className="font-mono text-fg hover:underline">
            {report.path}
          </Link>{" "}
          on this branch, which comes first.
        </span>
      </p>
    );
  }
  const errors = report.errors.length;
  if (errors === 0) {
    return (
      <p className="mb-4 flex items-center gap-2 text-sm text-muted" role="status">
        <CircleCheck size={15} className="shrink-0 text-success" />
        No errors in this CODEOWNERS file.
      </p>
    );
  }
  return (
    <section className="mb-4 overflow-hidden rounded-xl border border-danger/40" aria-label="CODEOWNERS errors">
      <p className="flex items-center gap-2 border-b border-danger/30 bg-danger/5 px-4 py-2.5 text-sm font-medium">
        <FileWarning size={15} className="shrink-0 text-danger" />
        {errors === 1 ? "1 error" : `${errors} errors`} in this CODEOWNERS file
        <a href={CODEOWNERS_DOCS} className="ml-auto text-xs font-normal text-muted hover:text-fg hover:underline">
          Syntax
        </a>
      </p>
      <CodeownersErrorList errors={report.errors} lineHref={(line) => `#L${line}`} />
    </section>
  );
}

/** Where one rule's review stands, in a few words. */
function ReviewStatus({ review }: { review: OwnerReview }) {
  const names = (list: string[]) => list.join(", ");
  if (review.changes_requested_by.length > 0) {
    return (
      <span className="flex items-center gap-1 text-xs text-danger">
        <CircleSlash size={13} className="shrink-0" /> Changes requested by {names(review.changes_requested_by)}
      </span>
    );
  }
  if (review.satisfied && review.approved_by.length > 0) {
    return (
      <span className="flex items-center gap-1 text-xs text-success">
        <CircleCheck size={13} className="shrink-0" /> Approved by {names(review.approved_by)}
      </span>
    );
  }
  if (review.optional) {
    return <span className="text-xs text-faint">Optional</span>;
  }
  if (review.satisfied) {
    return (
      <span className="flex items-center gap-1 text-xs text-success">
        <CircleCheck size={13} className="shrink-0" /> Approved
      </span>
    );
  }
  const more = Math.max(review.required - review.approved_by.length, 1);
  return (
    <span className="flex items-center gap-1 text-xs text-warn">
      <Hourglass size={13} className="shrink-0" />
      Waiting for {more} more {more === 1 ? "approval" : "approvals"}
      {review.approved_by.length > 0 && <span className="text-faint">· approved by {names(review.approved_by)}</span>}
    </span>
  );
}

/** One rule: its section, pattern and line, its owners, the files it covers, and where its review stands. */
function OwnerReviewRow({ review, fileHref }: { review: OwnerReview; fileHref: (line: number) => string }) {
  const many = review.files.length > 3;
  const files = (
    <ul className="mt-1 space-y-0.5">
      {review.files.map((file) => (
        <li key={file} className="truncate font-mono text-xs text-muted">
          {file}
        </li>
      ))}
    </ul>
  );
  return (
    <li className="px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {review.section && <Badge>{review.section}</Badge>}
        <code className="font-mono text-xs text-fg">{review.pattern}</code>
        <Link to={fileHref(review.line)} className="font-mono text-xs text-faint hover:text-accent hover:underline">
          line {review.line}
        </Link>
        <span className="ml-auto">
          <ReviewStatus review={review} />
        </span>
      </div>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
        <span>Owners</span>
        {review.owners.length === 0 ? (
          <span className="text-faint">none</span>
        ) : (
          review.owners.map((owner) => <OwnerLink key={owner} owner={owner} />)
        )}
      </p>
      {many ? (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-faint hover:text-fg">{review.files.length} files</summary>
          {files}
        </details>
      ) : (
        files
      )}
    </li>
  );
}

/**
 * Who owns what a pull request changes: each rule that matched, its
 * owners and files, and whose approval it still needs.
 */
export function PullCodeOwnersPanel({
  owners,
  base,
  branch,
  errorsHref,
}: {
  owners: PullCodeOwners;
  base: string;
  /** The branch it merges into, where the file is read. */
  branch: string;
  /** Where the file's errors are listed. */
  errorsHref: string;
}) {
  const fileHref = (line: number) => blobHref(base, branch, owners.path, line);
  return (
    <Card asChild tone="plain" className="overflow-hidden">
      <section aria-label="Code owners">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface px-4 py-2.5 text-sm">
          <span className="flex items-center gap-2 font-medium">
            <ShieldCheck size={15} className="shrink-0 text-faint" />
            Code owners
          </span>
          <Link to={blobHref(base, branch, owners.path)} className="font-mono text-xs text-muted hover:text-fg hover:underline">
            {owners.path}
          </Link>
          <span className="ml-auto flex items-center gap-2">
            {owners.errors > 0 && (
              <Link to={errorsHref} className="text-xs text-danger hover:underline">
                {owners.errors === 1 ? "1 error" : `${owners.errors} errors`} in the file
              </Link>
            )}
            {owners.required ? <Badge tone="warn">Approval required</Badge> : <Badge>Approval not required</Badge>}
          </span>
        </div>
        {owners.reviews.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted">No rule in the file covers what this changes.</p>
        ) : (
          <ul className="divide-y divide-line">
            {owners.reviews.map((review) => (
              <OwnerReviewRow key={`${review.section ?? ""}:${review.line}`} review={review} fileHref={fileHref} />
            ))}
          </ul>
        )}
      </section>
    </Card>
  );
}
