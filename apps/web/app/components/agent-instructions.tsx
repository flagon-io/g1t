import { FileText, ScrollText, ShieldCheck } from "lucide-react";
import { Link } from "react-router";

import type { RepoInstructions } from "@g1t/contracts";

import { Idle } from "./agents";
import { TimeAgo } from "./ui";

const ROLE: Record<RepoInstructions["files"][number]["role"], string> = {
  root: "Every run",
  directory: "Runs that touch this directory",
  review: "Reviews",
};

/**
 * The files every g1t agent run in a project reads as the repository's
 * instructions, as they are on its default branch: which, what they say,
 * when they last changed, and where to change them.
 */
export function AgentInstructions({ instructions, base }: { instructions: RepoInstructions; base: string }) {
  const { branch, files, limits } = instructions;
  return (
    <section className="mt-10">
      <div className="flex items-baseline justify-between">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <ScrollText size={15} className="text-muted" />
          Instructions
        </h3>
        <span className="text-xs text-muted">
          {files.length === 0 ? "None yet" : `${files.length} ${files.length === 1 ? "file" : "files"} on ${branch}`}
        </span>
      </div>
      <p className="mt-1.5 max-w-2xl text-sm text-muted">
        Every agent run here reads the repository's <code className="font-mono text-xs">AGENTS.md</code> and{" "}
        <code className="font-mono text-xs">CLAUDE.md</code> from {branch}: the ones at the root, and the nearest
        ones above the files its task touches. Reviews also read{" "}
        <code className="font-mono text-xs">.g1t/review.md</code>. Each file is cut at{" "}
        {limits.fileChars.toLocaleString()} characters, and all of them at {limits.totalChars.toLocaleString()}.
      </p>
      <p className="mt-2 flex max-w-2xl items-start gap-2 text-xs text-faint">
        <ShieldCheck size={13} className="mt-px shrink-0" />
        Only {branch} and the repository's own branches are followed. A pull request from a fork that changes these
        files is reviewed as a change, never followed as instructions.
      </p>
      {files.length === 0 ? (
        <div className="mt-3">
          <Idle>
            No instructions yet. Commit an AGENTS.md to {branch} with how to build, test and work in this repository,
            and every agent run reads it.
          </Idle>
        </div>
      ) : (
        <ul className="mt-3 space-y-3">
          {files.map((file) => (
            <li key={file.path} className="rounded-xl border border-line bg-surface">
              <details>
                <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
                  <FileText size={14} className="text-muted" />
                  <span className="font-mono font-medium">{file.path}</span>
                  <span className="rounded-full bg-raised px-2 py-px text-xs text-muted">{ROLE[file.role]}</span>
                  {file.truncated && <span className="text-xs text-warn">Longer than agents are given</span>}
                  <span className="ml-auto flex items-center gap-2 text-xs text-faint">
                    {file.lastChanged && (
                      <>
                        <Link
                          to={`${base}/commit/${file.lastChanged.commit}`}
                          className="font-mono hover:text-fg"
                          title={file.lastChanged.message}
                        >
                          {file.lastChanged.commit.slice(0, 7)}
                        </Link>
                        <span>by {file.lastChanged.author}</span>
                        <TimeAgo at={file.lastChanged.at} />
                      </>
                    )}
                    <Link to={`${base}/blob/${encodeURIComponent(branch)}/${file.path}`} className="text-muted hover:text-fg">
                      Open in code
                    </Link>
                  </span>
                </summary>
                <pre className="max-h-96 overflow-auto border-t border-line px-4 py-3 font-mono text-xs whitespace-pre-wrap text-muted">
                  {file.text || "(empty)"}
                </pre>
              </details>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-faint">
        To change them, edit the files in the repository and merge the change into {branch}. Agents read the new version
        from their next run.
      </p>
    </section>
  );
}
