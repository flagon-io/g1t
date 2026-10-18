/**
 * Above a fork's files: where it came from, a way to bring in what landed
 * there since (Sync fork, posting to routes/repo/sync-fork.ts), and a way
 * to offer the branch back as a pull request to the parent (Contribute).
 */
import { GitFork, GitPullRequest, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Link, useFetcher } from "react-router";

import type { SyncedFork } from "@g1t/contracts";

import { cloneUrl, useAddresses } from "../lib/addresses";
import type { SyncOutcome } from "../routes/repo/sync-fork";
import { ButtonLink, CopyLine, ErrorText, SubmitButton } from "./ui";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

/** Where a fork came from, as lib/forks.server.ts reads it. */
export type ForkSource = {
  namespace: string;
  name: string;
  /** The parent's default branch, which the fork's default branch follows. */
  defaultBranch: string;
  /** The fork's own default branch. */
  forkDefault: string;
};

/** The parent's branch a fork's `branch` follows: its default for the fork's default, the same name otherwise. */
export function upstreamBranch(source: ForkSource, branch: string): string {
  return branch === source.forkDefault ? source.defaultBranch : branch;
}

function commits(n: number): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? "commit" : "commits"}`;
}

export function ForkBar({
  base,
  branch,
  parent,
  canPush,
}: {
  /** The fork's address, `/<namespace>/<name>`. */
  base: string;
  /** The fork's branch shown. */
  branch: string;
  parent: ForkSource;
  /** Whether the viewer may push to the fork, and so sync it and offer its branch back. */
  canPush: boolean;
}) {
  const fetcher = useFetcher<SyncOutcome>({ key: `sync-fork:${base}:${branch}` });
  const [open, setOpen] = useState(false);
  const upstream = `${parent.namespace}/${parent.name}`;
  const parentBranch = upstreamBranch(parent, branch);
  const upstreamRef = `${upstream}:${parentBranch}`;
  const head = `${base.slice(1)}:${branch}`;
  const contribute = `/${upstream}/pulls/new?head=${encodeURIComponent(head)}&base=${encodeURIComponent(parentBranch)}`;
  const done = fetcher.state === "idle" ? fetcher.data : undefined;
  return (
    <div className="mb-4 space-y-3">
      <Card className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 text-sm">
        <GitFork size={15} className="shrink-0 text-faint" />
        <p className="min-w-0 grow text-muted">
          <span className="font-mono text-fg/80">{branch}</span> follows{" "}
          <Link to={`/${upstream}/tree/${encodeURIComponent(parentBranch)}`} className="font-mono text-fg/80 hover:text-accent hover:underline">
            {upstreamRef}
          </Link>
        </p>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {canPush && (
            <ButtonLink variant="outline" size="sm" to={contribute}>
              <GitPullRequest size={14} />
              Contribute
            </ButtonLink>
          )}
          {canPush && (
            <Popover open={open} onOpenChange={setOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm">
                  <RefreshCw size={14} />
                  Sync fork
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-80">
                <fetcher.Form method="post" action={`${base}/sync-fork`} onSubmit={() => setOpen(false)} className="space-y-3">
                  <input type="hidden" name="branch" value={branch} />
                  <p className="font-medium">Bring in {upstreamRef}</p>
                  <p className="text-muted">
                    Commits on <span className="font-mono">{upstreamRef}</span> that <span className="font-mono">{branch}</span> lacks come in. When it has none
                    of its own, it moves up to match; when it has some, they are kept and a merge commit joins the two. If both changed the same lines, nothing
                    changes and you are told which files.
                  </p>
                  <SubmitButton size="sm" variant="accent" fetcher={fetcher} pending="Syncing…" className="w-full">
                    Update branch
                  </SubmitButton>
                </fetcher.Form>
              </PopoverContent>
            </Popover>
          )}
        </div>
      </Card>
      {fetcher.state !== "idle" && (
        <p role="status" className="text-sm text-muted">
          Bringing in {upstreamRef}…
        </p>
      )}
      {done?.error && <ErrorText>{done.error}</ErrorText>}
      {done?.synced && <SyncResult synced={done.synced} upstream={upstream} upstreamRef={upstreamRef} contribute={contribute} />}
    </div>
  );
}

/** What syncing did, said in place. */
function SyncResult({ synced, upstream, upstreamRef, contribute }: { synced: SyncedFork; upstream: string; upstreamRef: string; contribute: string }) {
  const remote = cloneUrl(useAddresses(), upstream);
  switch (synced.status) {
    case "up_to_date":
      return (
        <Alert role="status" tone="info">
          Already up to date with <span className="font-mono">{upstreamRef}</span>.
          {synced.ahead > 0 && (
            <>
              {" "}
              {synced.branch} has {commits(synced.ahead)} of its own.
            </>
          )}
        </Alert>
      );
    case "fast_forwarded":
      return (
        <Alert role="status" tone="success">
          Updated: {synced.branch} moved up {commits(synced.behind)} to match <span className="font-mono">{upstreamRef}</span>.
        </Alert>
      );
    case "merged":
      return (
        <Alert role="status" tone="success">
          Updated: {commits(synced.behind)} from <span className="font-mono">{upstreamRef}</span> merged into {synced.branch} with a merge commit. Its own{" "}
          {commits(synced.ahead)} are kept.
        </Alert>
      );
    case "conflicted":
      return (
        <Alert role="alert" tone="warn" className="space-y-2 py-3">
          <p>
            Not updated: {synced.branch} and <span className="font-mono">{upstreamRef}</span> both changed{" "}
            {synced.conflicts.length === 1 ? "this file" : "these files"}, so nothing was changed.
          </p>
          {synced.conflicts.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 font-mono text-xs">
              {synced.conflicts.map((file) => (
                <li key={file}>{file}</li>
              ))}
            </ul>
          )}
          <p className="text-muted">
            Merge it in your working copy and push, or{" "}
            <Link to={contribute} className="text-accent hover:underline">
              open a pull request
            </Link>{" "}
            and resolve it there.
          </p>
          <div className="space-y-1.5">
            <CopyLine prompt text={`git remote add upstream ${remote}`} />
            <CopyLine prompt text={`git pull upstream ${upstreamRef.slice(upstream.length + 1)}`} />
          </div>
        </Alert>
      );
  }
}
