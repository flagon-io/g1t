import { ArrowDown, ArrowUp, GitBranch, GitPullRequest, Globe } from "lucide-react";
import { Link } from "react-router";

import type { Pull } from "@g1t/contracts";

import type { Drift } from "../lib/branches";
import { CheckBadge } from "./checks";
import { host } from "./deploy";
import { Avatar, TimeAgo } from "./ui";

export type ActiveBranch = {
  name: string;
  commit: { hash: string; message: string; author: string; at: string } | null;
  /** Null when the two histories were not read far enough to meet. */
  drift: Drift | null;
  pull: { number: number; title: string; checkStatus: Pull["checkStatus"]; draft: boolean } | null;
  preview: string | null;
};

/** Branches other than the default, newest first, with how far each has moved and what is open on it. */
export function ActiveBranches({ branches, base, main }: { branches: ActiveBranch[]; base: string; main: string }) {
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
                <Avatar name={branch.commit.author} size={13} />
                <span className="shrink-0">{branch.commit.author}</span>
                <span className="text-faint">·</span>
                <Link
                  to={`${base}/commit/${branch.commit.hash}`}
                  className="min-w-0 truncate hover:text-fg"
                  title={branch.commit.message}
                >
                  {branch.commit.message}
                </Link>
                <span className="shrink-0 text-faint">
                  · <TimeAgo at={branch.commit.at} />
                </span>
              </span>
            )}
          </span>
          <span className="ml-6.5 flex shrink-0 flex-wrap items-center gap-2 text-xs sm:ml-0">
            {branch.drift && (
              <span
                className="inline-flex items-center gap-1.5 rounded-md border border-line px-1.5 py-0.5 font-mono tabular-nums text-muted"
                title={`${branch.drift.ahead} ${branch.drift.ahead === 1 ? "commit" : "commits"} ahead of ${main}, ${branch.drift.behind} behind`}
              >
                <span className="inline-flex items-center gap-0.5">
                  <ArrowUp size={11} className={branch.drift.ahead > 0 ? "text-accent" : "text-faint"} />
                  {branch.drift.ahead}
                </span>
                <span className="inline-flex items-center gap-0.5">
                  <ArrowDown size={11} className={branch.drift.behind > 0 ? "text-warn" : "text-faint"} />
                  {branch.drift.behind}
                </span>
              </span>
            )}
            {branch.pull ? (
              <Link
                to={`${base}/pull/${branch.pull.number}`}
                className="inline-flex items-center gap-1.5 rounded-md border border-line px-1.5 py-0.5 text-muted hover:border-line-strong hover:text-fg"
                title={branch.pull.title}
              >
                <GitPullRequest size={12} className={branch.pull.draft ? "text-faint" : "text-accent"} />#{branch.pull.number}
                <CheckBadge status={branch.pull.checkStatus} />
              </Link>
            ) : branch.drift?.ahead === 0 ? (
              // Nothing here that the default branch lacks: no pull request to open.
              <span className="px-1.5 py-0.5 text-faint" title={`Every commit on ${branch.name} is already on ${main}.`}>
                Nothing to merge
              </span>
            ) : (
              <Link
                to={`${base}/pulls/new?branch=${encodeURIComponent(branch.name)}`}
                className="rounded-md px-1.5 py-0.5 text-faint hover:text-fg"
              >
                Open a pull request
              </Link>
            )}
            {branch.preview && (
              <a
                href={branch.preview}
                className="inline-flex max-w-48 items-center gap-1 truncate rounded-md border border-line px-1.5 py-0.5 text-muted hover:border-line-strong hover:text-fg"
                title={host(branch.preview)}
              >
                <Globe size={12} className="shrink-0 text-merged" />
                Preview
              </a>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
