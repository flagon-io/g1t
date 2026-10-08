import { ArrowDown, ArrowUp, GitBranch, GitPullRequest, Globe } from "lucide-react";
import { Link } from "react-router";

import type { Pull } from "@g1t/contracts";

import type { Drift } from "../lib/branches";
import type { CommitPerson } from "../lib/commit-people";
import { CommitAvatars, CommitNames } from "./commit-person";
import { CheckBadge } from "./checks";
import { type ChecksSource, CommitChecksBadge } from "./commit-checks";
import { host } from "./deploy";
import { TimeAgo } from "./ui";
import { Hint } from "./ui/hint";

function drift({ ahead, behind }: Drift, main: string): string {
  return `${ahead} ${ahead === 1 ? "commit" : "commits"} ahead of ${main}, ${behind} behind`;
}

export type ActiveBranch = {
  name: string;
  commit: { hash: string; message: string; author: CommitPerson; coAuthors: CommitPerson[]; at: string } | null;
  /** Null when the two histories were not read far enough to meet. */
  drift: Drift | null;
  pull: { number: number; title: string; checkStatus: Pull["checkStatus"]; draft: boolean } | null;
  preview: string | null;
};

/** Branches other than the default, newest first, with how far each has moved, its head's checks and what is open on it. */
export function ActiveBranches({
  branches,
  base,
  main,
  checks,
}: {
  branches: ActiveBranch[];
  base: string;
  main: string;
  /** The checks on each branch's head, streamed in. */
  checks?: ChecksSource;
}) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
      {branches.map((branch) => (
        <li key={branch.name} className="flex flex-wrap items-start gap-x-3 gap-y-1.5 px-4 py-3">
          <GitBranch size={15} className="mt-0.5 shrink-0 text-faint" />
          <span className="min-w-0 grow basis-48">
            <Link
              to={`${base}/tree/${encodeURIComponent(branch.name)}`}
              className="block truncate font-mono text-[0.8125rem] font-medium hover:text-accent"
            >
              {branch.name}
            </Link>
            {branch.commit && (
              <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted">
                <CommitAvatars commit={branch.commit} size={14} max={2} />
                <span className="shrink-0">
                  <CommitNames commit={branch.commit} className="hover:text-fg" />
                </span>
                <span className="text-faint">·</span>
                <Hint label={branch.commit.message}>
                  <Link to={`${base}/commit/${branch.commit.hash}`} className="min-w-0 truncate hover:text-fg">
                    {branch.commit.message}
                  </Link>
                </Hint>
                <CommitChecksBadge checks={checks} sha={branch.commit.hash} className="size-5" />
                <span className="shrink-0 text-faint">
                  · <TimeAgo at={branch.commit.at} />
                </span>
              </span>
            )}
          </span>
          <span className="ml-6.5 flex shrink-0 flex-wrap items-center gap-2 text-xs sm:ml-0">
            {branch.drift && (
              <Hint label={drift(branch.drift, main)}>
                <span className="inline-flex items-center gap-1.5 rounded-md border border-line px-1.5 py-0.5 font-mono tabular-nums text-muted">
                  <span className="sr-only">{drift(branch.drift, main)}</span>
                  <span className="inline-flex items-center gap-0.5" aria-hidden>
                    <ArrowUp size={11} className={branch.drift.ahead > 0 ? "text-success" : "text-faint"} />
                    {branch.drift.ahead}
                  </span>
                  <span className="inline-flex items-center gap-0.5" aria-hidden>
                    <ArrowDown size={11} className={branch.drift.behind > 0 ? "text-warn" : "text-faint"} />
                    {branch.drift.behind}
                  </span>
                </span>
              </Hint>
            )}
            {branch.pull ? (
              <Hint label={branch.pull.title}>
                <Link
                  to={`${base}/pull/${branch.pull.number}`}
                  className="inline-flex items-center gap-1.5 rounded-md border border-line px-1.5 py-0.5 text-muted hover:border-line-strong hover:text-fg"
                >
                  <GitPullRequest size={12} className={branch.pull.draft ? "text-faint" : "text-success"} />#{branch.pull.number}
                  <span className="sr-only">{branch.pull.title}</span>
                  <CheckBadge status={branch.pull.checkStatus} />
                </Link>
              </Hint>
            ) : branch.drift?.ahead === 0 ? (
              // Nothing here that the default branch lacks: no pull request to open.
              <Hint label={`Every commit on ${branch.name} is already on ${main}.`}>
                <span className="px-1.5 py-0.5 text-faint">Nothing to merge</span>
              </Hint>
            ) : (
              <Link
                to={`${base}/pulls/new?branch=${encodeURIComponent(branch.name)}`}
                className="rounded-md px-1.5 py-0.5 text-faint hover:text-fg"
              >
                Open a pull request
              </Link>
            )}
            {branch.preview && (
              <Hint label={host(branch.preview)}>
                <a
                  href={branch.preview}
                  className="inline-flex max-w-48 items-center gap-1 truncate rounded-md border border-line px-1.5 py-0.5 text-muted hover:border-line-strong hover:text-fg"
                >
                  <Globe size={12} className="shrink-0 text-accent" />
                  Preview
                </a>
              </Hint>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
