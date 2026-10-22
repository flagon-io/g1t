/**
 * A work item's Work: everything being done for it, in one section. Each
 * repository it is linked to in its role, with its pull requests (state,
 * checks, place in the merge queue) and whether the work landed there;
 * who has claimed it; its sessions, each linked to its page in Chat; a
 * merge-queue failure that still stands; and the repositories it may also
 * need. It replaces the item page's Repositories and its session panel.
 */
import { Activity, Check, CircleDashed, GitCommitHorizontal, GitMerge, Lightbulb, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Form, Link } from "react-router";

import type { Claim, Decision, ItemRepo, Pull, Resolution, SuggestedTarget, WorkPull, WorkSession } from "@g1t/contracts";

import { type PullHref, type SessionNode, sessionTree } from "../lib/coordination";
import { sessionsPath, shortPath } from "../lib/work-items";
import { Unavailable } from "./boundary";
import { CheckBadge } from "./checks";
import { ClaimLine, IntegrationFailure, type SessionBase, SessionTreeList } from "./coordination";
import { CopyLine, SubmitButton } from "./ui";
import { Alert } from "./ui/alert";
import { Card } from "./ui/card";
import { Hint } from "./ui/hint";
import { ChangeSize, PullIcon } from "./work";
import { RoleBadge } from "./work-items";

/** What became of a pull request, in a few words. */
export function outcome(pull: { status: Pull["status"] } & Partial<Pick<Pull, "mergedBy" | "supersededBy">>): string {
  if (pull.status === "merged") return pull.mergedBy ? `Merged by ${pull.mergedBy}` : "Merged";
  if (pull.supersededBy != null) return `Closed · #${pull.supersededBy} was merged instead`;
  if (pull.status === "closed") return "Closed without merging";
  if (pull.status === "draft") return "Draft · in progress";
  return "Ready for review";
}

/** One of a repository's pull requests for the item, as a line under the repository. */
function RepoPullLine({ repo, pull, full }: { repo: string; pull: WorkPull; full?: Pull }) {
  const merged = pull.status === "merged";
  return (
    <li>
      <Link
        to={`/${repo}/pull/${pull.number}`}
        prefetch="intent"
        className={`flex min-w-0 items-start gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-raised ${pull.status === "closed" ? "opacity-70" : ""}`}
      >
        <span className="mt-0.5">
          <PullIcon status={pull.status} size={15} />
        </span>
        <span className="min-w-0 grow">
          <span className="block text-sm font-medium wrap-break-word">
            {pull.title} <span className="font-normal text-faint">#{pull.number}</span>
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            <span className={merged ? "font-medium text-merged" : ""}>
              {outcome({ status: pull.status, mergedBy: full?.mergedBy, supersededBy: full?.supersededBy })}
            </span>
            <span>· {pull.author.username}</span>
            {full && <ChangeSize files={full.files} />}
            <CheckBadge status={pull.checkStatus} />
            {pull.queue && <span>· in the merge queue, {pull.queue.position === 1 ? "next" : `#${pull.queue.position}`}</span>}
          </span>
        </span>
      </Link>
    </li>
  );
}

/**
 * One repository the item is linked to: its path and role, whether what
 * closes the item has landed there (or, for a target, that it is still
 * missing), and its pull requests for it.
 */
function RepoRow({ repo, pulls, full, workspace }: { repo: ItemRepo; pulls: WorkPull[]; full: Map<string, Pull>; workspace: string }) {
  const missing = repo.role === "target" && !repo.landed;
  return (
    <li className="px-3 py-3 sm:px-4">
      <div className="flex min-w-0 items-center gap-2">
        {repo.path && repo.deleted ? (
          // Deleted, and restorable until it is purged: its name, nothing to open.
          <Hint label={`${repo.path} was deleted. It can be restored until it is purged.`}>
            <span className="min-w-0 truncate font-mono text-sm text-muted">
              {repo.path} <span className="font-sans text-xs text-faint">deleted</span>
            </span>
          </Hint>
        ) : repo.path ? (
          <Link to={`/${repo.path}`} className="min-w-0 truncate font-mono text-sm font-medium hover:text-accent">
            {shortPath(repo.path, workspace)}
          </Link>
        ) : (
          // Deleted before work items: nothing to link to, and no name kept.
          <span className="min-w-0 truncate text-sm text-muted">A deleted repository</span>
        )}
        <RoleBadge role={repo.role} />
        {repo.legacyNumber != null && (
          <Hint
            label={
              repo.path
                ? `It was ${repo.path}#${repo.legacyNumber} before work items, and that still leads here.`
                : `It was #${repo.legacyNumber} there before work items.`
            }
          >
            <span className="shrink-0 text-xs text-faint">was #{repo.legacyNumber}</span>
          </Hint>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {repo.landed ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-merged">
              <Check size={13} />
              Landed
            </span>
          ) : missing ? (
            <span className="inline-flex items-center gap-1 text-xs text-warn">
              <CircleDashed size={13} />
              Still to land
            </span>
          ) : null}
        </span>
      </div>
      {pulls.length > 0 ? (
        <ul className="mt-1.5 -mx-2 space-y-0.5">
          {pulls.map((pull) => (
            <RepoPullLine key={pull.number} repo={repo.path} pull={pull} full={full.get(`${repo.repoId}#${pull.number}`)} />
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-xs text-faint">{repo.role === "touched" ? "Touched by a commit." : "No pull request for it here yet."}</p>
      )}
    </li>
  );
}

/** What resolved it in each repository it landed in. */
function Landings({ resolutions }: { resolutions: Resolution[] }) {
  return (
    <ul className="space-y-1.5">
      {resolutions.map((landed, index) => (
        <li key={`${landed.repo}-${landed.pull ?? landed.commit ?? index}`}>
          <Link
            to={landed.pull != null ? `/${landed.repo}/pull/${landed.pull}` : `/${landed.repo}/commit/${landed.commit ?? ""}`}
            className="flex items-start gap-2.5 rounded-lg border border-merged/40 bg-merged/5 px-3 py-2 text-sm transition-colors hover:border-merged/70"
          >
            {landed.pull != null ? (
              <GitMerge size={16} className="mt-0.5 shrink-0 text-merged" />
            ) : (
              <GitCommitHorizontal size={16} className="mt-0.5 shrink-0 text-merged" />
            )}
            <span className="min-w-0">
              Landed in <span className="font-mono font-medium">{landed.repo}</span> by{" "}
              {landed.pull != null ? (
                <span className="font-medium">#{landed.pull}</span>
              ) : (
                <span className="font-mono font-medium">{landed.commit?.slice(0, 7)}</span>
              )}
              {landed.pushedBy && <span className="text-muted">, pushed by {landed.pushedBy}</span>}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** A repository the work may also belong in, with why, and Add as target. */
function SuggestionLine({ suggestion, workspace, canLink }: { suggestion: SuggestedTarget; workspace: string; canLink: boolean }) {
  return (
    <li className="flex items-start gap-3 px-3 py-2.5 sm:px-4">
      <Lightbulb size={15} className="mt-0.5 shrink-0 text-faint" />
      <span className="min-w-0 grow">
        <Link to={`/${suggestion.path}`} className="font-mono text-sm font-medium hover:text-accent">
          {shortPath(suggestion.path, workspace)}
        </Link>
        <span className="mt-0.5 block text-xs text-muted">{suggestion.why}</span>
      </span>
      {canLink && (
        <Form method="post" className="shrink-0">
          <input type="hidden" name="action" value="link" />
          <input type="hidden" name="repo" value={suggestion.path} />
          <input type="hidden" name="role" value="target" />
          <SubmitButton variant="outline" size="sm" match={{ action: "link", repo: suggestion.path }} pending="Adding…" className="max-sm:h-10">
            Add as target
          </SubmitButton>
        </Form>
      )}
    </li>
  );
}

/** A part of Work, under its small heading. */
function Part({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="mt-4">
      <div className="mb-1.5 flex min-h-6 items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted">{title}</h3>
        {aside}
      </div>
      {children}
    </div>
  );
}

/** How many of its sessions show before the rest are a link to Chat's Sessions. */
const SESSIONS_SHOWN = 5;

export function ItemWorkSection({
  workspace,
  number,
  open,
  repoRows,
  pulls,
  resolutions,
  missing,
  suggestions,
  canLink,
  workFailed,
  claims,
  ended,
  now,
  sessions,
  sessionsFailed,
  base,
  failure,
  fixed,
  failureBase,
  pullHref,
}: {
  workspace: string;
  number: number;
  open: boolean;
  /** Each repository with its pull requests for the item. */
  repoRows: { repo: ItemRepo; pulls: WorkPull[] }[];
  /** The item's own pull requests, for their size and who merged them. */
  pulls: Pull[];
  resolutions: Resolution[];
  /** The targets it has not landed in yet. */
  missing: string[];
  suggestions: SuggestedTarget[];
  canLink: boolean;
  /** Its work context could not be read: pull requests show from the item alone. */
  workFailed: boolean;
  claims: Claim[];
  ended: Claim[];
  now: number;
  /** Its sessions with their subagents. */
  sessions: WorkSession[];
  sessionsFailed: boolean;
  base: SessionBase;
  failure: Decision | null;
  fixed?: Decision | null;
  failureBase: string;
  pullHref: PullHref;
}) {
  const full = new Map(pulls.map((pull) => [`${pull.repoId}#${pull.number}`, pull]));
  const trees: SessionNode[] = sessionTree(sessions);
  const shown = trees.slice(0, SESSIONS_SHOWN);
  const nobody = claims.length === 0 && ended.length === 0;
  return (
    <section aria-labelledby="work" className="mt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="work" className="flex items-center gap-2 font-semibold tracking-tight">
          <Activity size={15} className="text-accent" />
          Work
        </h2>
        {missing.length > 0 && open && (
          <p className="text-sm text-muted">
            {missing.length} {missing.length === 1 ? "target" : "targets"} still to land
          </p>
        )}
      </div>

      {resolutions.length > 0 && (
        <div className="mt-3">
          <Landings resolutions={resolutions} />
        </div>
      )}

      {failure && <IntegrationFailure className="mt-3" failure={failure} base={failureBase} pullHref={pullHref} fixed={fixed} />}

      <Part title="Repositories and pull requests">
        {workFailed && (
          <div className="mb-2">
            <Unavailable what="Each repository's pull requests" compact />
          </div>
        )}
        {repoRows.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line px-3 py-3 text-sm text-muted">
            No repository yet: it was filed in the workspace itself. Link the repositories it should land in from Repos, and it closes once each of them has.
          </p>
        ) : (
          <Card asChild divided>
            <ul>
              {repoRows.map(({ repo, pulls: repoPulls }) => (
                <RepoRow key={repo.repoId} repo={repo} pulls={repoPulls} full={full} workspace={workspace} />
              ))}
            </ul>
          </Card>
        )}
        {pulls.length === 0 && open && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted">
            <span>Nobody has opened a pull request for it yet. Point your own agent at</span>
            <span className="min-w-0 max-w-full">
              <CopyLine text={`${workspace}#${number}`} />
            </span>
          </div>
        )}
      </Part>

      {suggestions.length > 0 && open && (
        <Part title="It may also need">
          <Card asChild divided>
            <ul>
              {suggestions.map((suggestion) => (
                <SuggestionLine key={suggestion.repoId} suggestion={suggestion} workspace={workspace} canLink={canLink} />
              ))}
            </ul>
          </Card>
        </Part>
      )}

      <div className="grid gap-x-6 md:grid-cols-2">
        <Part title="On it">
          {workFailed ? (
            <Unavailable what="Who is on it" compact />
          ) : nobody ? (
            <p className="text-xs text-muted">
              {open ? (
                <>
                  Nobody has claimed it. Press <kbd className="font-mono text-fg-soft">I</kbd> to claim it, or run{" "}
                  <code className="font-mono text-fg-soft">g1t work claim {number}</code>.
                </>
              ) : (
                "Nobody is working on it."
              )}
            </p>
          ) : (
            <div className="space-y-3">
              {[...claims, ...ended.slice(0, 3)].map((claim) => (
                <ClaimLine key={claim.id} claim={claim} now={now} />
              ))}
              {claims.length > 1 && (
                <Alert tone="warn" className="flex items-start gap-1.5 px-2.5 py-1.5 text-xs">
                  <TriangleAlert size={13} className="mt-0.5 shrink-0 text-warn" />
                  {claims.length} claims stand on it: they may be doing the same work.
                </Alert>
              )}
            </div>
          )}
        </Part>
        <Part
          title="Sessions"
          aside={
            trees.length > 0 ? (
              <Link to={sessionsPath(workspace, { state: "recent", item: String(number) })} className="text-xs text-faint hover:text-fg">
                In Chat
              </Link>
            ) : undefined
          }
        >
          {sessionsFailed && (
            <div className="mb-2">
              <Unavailable what="Its sessions" compact />
            </div>
          )}
          {shown.length === 0 ? (
            <p className="text-xs text-muted">None yet. Start an agent (D), or run one of your own on it.</p>
          ) : (
            <SessionTreeList nodes={shown} base={base} showBranch={false} />
          )}
          {trees.length > shown.length && (
            <p className="mt-2 text-xs text-muted">
              <Link to={sessionsPath(workspace, { state: "recent", item: String(number) })} className="hover:text-fg hover:underline">
                {trees.length - shown.length} more in Chat&apos;s Sessions
              </Link>
            </p>
          )}
        </Part>
      </div>
    </section>
  );
}
