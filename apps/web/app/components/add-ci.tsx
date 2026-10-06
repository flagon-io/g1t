/**
 * What a repository with no checks shows where checks would be: that
 * nothing proves a change works, and a button that opens a pull request
 * adding a starter workflow for the stack g1t finds (routes/repo/add-ci.ts).
 */
import { FlaskConical, LoaderCircle, Plus } from "lucide-react";
import { useFetcher } from "react-router";

import { Button, ErrorText } from "./ui";

export function AddCiPrompt({
  owner,
  repo,
  canAdd,
  compact = false,
}: {
  owner: string;
  repo: string;
  /** Whether the viewer may push: who may open the pull request. */
  canAdd: boolean;
  /** Fits a row of the merge box rather than a page. */
  compact?: boolean;
}) {
  const fetcher = useFetcher<{ error?: string }>();
  const adding = fetcher.state !== "idle";
  return (
    <div className={compact ? "flex gap-3 px-4 py-3" : "flex gap-3 rounded-xl border border-dashed border-line-strong bg-surface p-4"}>
      <FlaskConical size={16} className="mt-0.5 shrink-0 text-warn" />
      <div className="min-w-0 grow">
        <p className="text-sm font-medium">This repository has no checks</p>
        <p className="mt-0.5 text-sm text-muted">
          Nothing runs on its pull requests, so neither people nor agents can prove a change works before it merges.
          Add a workflow in <code className="text-fg">.g1t/workflows</code>, then require it on the default branch.
        </p>
        {canAdd && (
          <fetcher.Form method="post" action={`/${owner}/${repo}/add-ci`} className="mt-3 flex flex-wrap items-center gap-3">
            <Button variant="primary" type="submit" disabled={adding}>
              {adding ? <LoaderCircle size={14} className="animate-spin" /> : <Plus size={14} />}
              {adding ? "Opening a pull request…" : "Add CI"}
            </Button>
            <span className="text-xs text-faint">
              Opens a pull request with a starter workflow for the stack g1t finds. You can change it before merging.
            </span>
          </fetcher.Form>
        )}
        {fetcher.data?.error && (
          <div className="mt-2">
            <ErrorText>{fetcher.data.error}</ErrorText>
          </div>
        )}
      </div>
    </div>
  );
}
