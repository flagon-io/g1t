import {
  ArrowUpRight,
  CircleDot,
  GitCommitHorizontal,
  GitPullRequest,
  MessagesSquare,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { Link, useFetcher } from "react-router";

import type { Blame, Commit } from "@g1t/contracts";

import type { loader as whyLoader } from "../routes/repo/why";
import { repoAt } from "../lib/markdown-plugins";
import { Markdown } from "./markdown";
import { Avatar, TimeAgo } from "./ui";
import { Skeleton } from "./ui/skeleton";

/**
 * A file with, beside each run of lines, the commit that last changed it.
 * Picking a line opens why it is the way it is: the commit, the pull
 * request and issue it came from, and what the agent was thinking.
 */
export function BlameView({
  base,
  path,
  lines,
  html,
  blame,
}: {
  base: string;
  path: string;
  lines: string[];
  /** Highlighted HTML per line, when the language is known. */
  html: string[] | null;
  blame: Blame;
}) {
  const commits = useMemo(
    () => new Map<string, Commit>(blame.commits.map((commit) => [commit.hash, commit])),
    [blame.commits],
  );
  // Newer commits are brighter: rank them by when they were written.
  const age = useMemo(() => {
    const sorted = [...blame.commits].sort((a, b) => b.authoredAt.localeCompare(a.authoredAt));
    const rank = new Map(sorted.map((commit, index) => [commit.hash, index]));
    return (hash: string) => 1 - (rank.get(hash) ?? 0) / Math.max(sorted.length, 1);
  }, [blame.commits]);
  // The run of lines picked, and the line clicked, under which the
  // explanation opens.
  const [picked, setPicked] = useState<{ commit: string; start: number; end: number; line: number } | null>(
    null,
  );
  const [hovered, setHovered] = useState<string | null>(null);
  const why = useFetcher<typeof whyLoader>();

  useEffect(() => {
    if (!picked) return;
    why.load(`${base}/why/${picked.commit}?path=${encodeURIComponent(path)}`);
    // `why` changes identity as it loads; the pick is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked?.commit, base, path]);

  // A line named in the address is picked on arrival: `#L12`.
  useEffect(() => {
    const match = /^#L(\d+)$/.exec(window.location.hash);
    if (!match) return;
    const line = Number(match[1]);
    const range = blame.ranges.find((r) => r.start <= line && line <= r.end);
    if (range) {
      setPicked({ ...range, line });
      document.getElementById(`L${line}`)?.scrollIntoView({ block: "center" });
    }
  }, [blame.ranges]);

  const pick = (start: number, end: number, commit: string, line: number) => {
    // Clicking the open line again closes it.
    if (picked?.line === line) {
      close();
      return;
    }
    setPicked({ commit, start, end, line });
    window.history.replaceState(null, "", `#L${line}`);
  };
  const close = () => {
    setPicked(null);
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  };

  return (
    <div>
      <p className="flex items-center gap-2 border-b border-line px-4 py-2 text-xs text-muted">
        <Sparkles size={13} className="text-merged" />
        Pick any line to see why it is the way it is: the commit, the pull request and issue it
        came from, and what the agent was thinking.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse font-mono text-[0.8125rem] leading-6">
          <tbody>
            {blame.ranges.map((range) => {
              const commit = commits.get(range.commit);
              const selected = picked?.commit === range.commit;
              const lit = hovered === range.commit;
              const bright = age(range.commit);
              const rows = [];
              for (let line = range.start; line <= range.end; line++) {
                const first = line === range.start;
                rows.push(
                  <tr
                    key={line}
                    id={`L${line}`}
                    onMouseEnter={() => setHovered(range.commit)}
                    onMouseLeave={() => setHovered(null)}
                    onClick={() => pick(range.start, range.end, range.commit, line)}
                    className={`cursor-pointer transition-colors ${
                      selected ? "bg-accent/[0.07]" : lit ? "bg-raised/50" : ""
                    } ${first ? "border-t border-line" : ""}`}
                  >
                    <td className="w-72 max-w-72 border-r border-line px-3 align-top font-sans">
                      {first && commit && (
                        <span className="flex items-center gap-2 py-0.5 text-xs">
                          <Avatar name={commit.author.name} size={16} />
                          <span className={`min-w-0 grow truncate ${selected ? "text-fg" : "text-muted"}`}>
                            {commit.message.split("\n")[0]}
                          </span>
                          <span className="shrink-0 text-faint">
                            <TimeAgo at={commit.authoredAt} />
                          </span>
                        </span>
                      )}
                    </td>
                    <td className="w-1 p-0" aria-hidden="true">
                      <span
                        className="block h-6 w-0.5 bg-accent"
                        style={{ opacity: 0.15 + bright * 0.85 }}
                      />
                    </td>
                    <td className="w-12 px-2 text-right text-faint select-none">{line}</td>
                    <td className="pr-4 pl-2 whitespace-pre">
                      {html?.[line - 1] != null ? (
                        <span dangerouslySetInnerHTML={{ __html: html[line - 1] || " " }} />
                      ) : (
                        lines[line - 1] || " "
                      )}
                    </td>
                  </tr>,
                );
                // The explanation opens right under the line clicked.
                if (picked?.line === line) {
                  rows.push(
                    <tr key={`why-${line}`}>
                      <td colSpan={4} className="border-y border-line bg-bg/60 px-3 py-3 font-sans whitespace-normal md:pl-80">
                        <div className="max-w-2xl overflow-hidden rounded-xl border border-merged/30 bg-surface shadow-xl shadow-black/40">
                          <WhyPanel
                            base={base}
                            picked={picked}
                            loading={why.state === "loading"}
                            data={why.data}
                            onClose={close}
                          />
                        </div>
                      </td>
                    </tr>,
                  );
                }
              }
              return <Fragment key={range.start}>{rows}</Fragment>;
            })}
          </tbody>
        </table>
        {blame.partial && (
          <p className="border-t border-line px-4 py-2 text-xs text-faint">
            This file's history is long; its oldest lines are credited to the oldest commit read.
          </p>
        )}
      </div>
    </div>
  );
}

type WhyData = Awaited<ReturnType<typeof whyLoader>>;

function WhyPanel({
  base,
  picked,
  loading,
  data,
  onClose,
}: {
  base: string;
  picked: { commit: string; start: number; end: number; line: number };
  loading: boolean;
  data: WhyData | undefined;
  onClose: () => void;
}) {
  const current = data && data.commit.hash === picked.commit ? data : null;
  return (
    <div>
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <Sparkles size={15} className="text-merged" />
        <span className="grow text-sm font-medium">
          Why line{picked.start === picked.end ? ` ${picked.start}` : `s ${picked.start}–${picked.end}`}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded p-1 text-faint hover:bg-raised hover:text-fg"
        >
          <X size={14} />
        </button>
      </header>
      {!current ? (
        <div className="space-y-3 p-4" aria-busy={loading}>
          {[70, 90, 55].map((width) => (
            <Skeleton key={width} className="h-3" style={{ width: `${width}%` }} />
          ))}
        </div>
      ) : (
        <div className="divide-y divide-line text-sm">
          <section className="p-4">
            <p className="flex items-center gap-1.5 text-xs text-faint">
              <GitCommitHorizontal size={13} />
              Last changed in
            </p>
            <Link
              to={`${base}/commit/${current.commit.hash}`}
              className="mt-1.5 block font-medium hover:text-accent"
            >
              {current.commit.message.split("\n")[0]}
            </Link>
            <p className="mt-1.5 flex items-center gap-2 text-xs text-muted">
              <Avatar name={current.commit.author.name} size={14} />
              {current.commit.author.name} · <TimeAgo at={current.commit.authoredAt} /> ·{" "}
              <span className="font-mono">{current.commit.hash.slice(0, 7)}</span>
            </p>
          </section>

          {current.pull ? (
            <section className="p-4">
              <p className="flex items-center gap-1.5 text-xs text-faint">
                <GitPullRequest size={13} />
                Arrived in
              </p>
              <Link
                to={`${base}/pull/${current.pull.number}`}
                className="mt-1.5 block font-medium hover:text-accent"
              >
                {current.pull.title} <span className="font-normal text-faint">#{current.pull.number}</span>
              </Link>
              <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                {current.pull.runtime === "hosted" ? (
                  <>
                    <span className="flex items-center gap-1 text-merged">
                      <Sparkles size={11} />
                      written by {current.pull.agent}
                    </span>
                    {current.pull.requestedBy && <span>for {current.pull.requestedBy}</span>}
                  </>
                ) : (
                  <span>by {current.pull.author} with {current.pull.agent}</span>
                )}
                {current.pull.mergedBy && <span>· merged by {current.pull.mergedBy}</span>}
              </p>
            </section>
          ) : (
            <section className="p-4 text-xs text-muted">
              Pushed straight to the branch, not through a pull request, so there is no
              conversation behind it.
            </section>
          )}

          {current.issue && (
            <section className="p-4">
              <p className="flex items-center gap-1.5 text-xs text-faint">
                <CircleDot size={13} />
                What was asked for
              </p>
              <Link
                to={`${base}/issues/${current.issue.number}`}
                className="mt-1.5 block font-medium hover:text-accent"
              >
                {current.issue.title} <span className="font-normal text-faint">#{current.issue.number}</span>
              </Link>
              {current.issue.body && (
                <div className="mt-2 max-h-48 overflow-hidden text-muted [&_*]:text-[0.8125rem]! [&_*]:leading-5! mask-[linear-gradient(to_bottom,black_70%,transparent)]">
                  <Markdown source={current.issue.body} repo={repoAt(base)} />
                </div>
              )}
            </section>
          )}

          {current.steps.length > 0 && current.pull && (
            <section className="p-4">
              <p className="flex items-center gap-1.5 text-xs text-faint">
                <MessagesSquare size={13} />
                In the agent's words
              </p>
              {current.steps
                .filter((step) => step.kind === "message")
                .map((step) => (
                  <blockquote
                    key={step.seq}
                    className="mt-3 border-l-2 border-merged/50 pl-3 text-[0.8125rem] whitespace-pre-line text-fg/90"
                  >
                    {step.text}
                  </blockquote>
                ))}
              {current.steps.some((step) => step.kind === "tool_call") && (
                <details className="group mt-3">
                  <summary className="cursor-pointer text-xs text-muted hover:text-fg">
                    What it ran ({current.steps.filter((step) => step.kind === "tool_call").length})
                  </summary>
                  <ol className="mt-2 space-y-1.5">
                    {current.steps
                      .filter((step) => step.kind === "tool_call")
                      .map((step) => (
                        <li key={step.seq} className="flex items-start gap-1.5 font-mono text-xs text-muted">
                          <Terminal size={12} className="mt-0.5 shrink-0" />
                          <span className="line-clamp-2 break-all">
                            <span className="text-fg">{step.tool}</span> {step.text.split("\n")[0]}
                          </span>
                        </li>
                      ))}
                  </ol>
                </details>
              )}
              <Link
                to={`${base}/pull/${current.pull.number}?tab=session`}
                className="mt-4 inline-flex items-center gap-1 text-xs text-accent hover:underline"
              >
                The whole session
                <ArrowUpRight size={12} />
              </Link>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
