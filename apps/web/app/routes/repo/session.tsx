import { ArrowLeft, MessageSquare, StickyNote, Terminal, Wrench } from "lucide-react";
import { Link, useSearchParams } from "react-router";

import type { SessionEntry } from "@g1t/contracts";

import type { Route } from "./+types/session";
import { page } from "../../lib/meta";
import { RunCard, formatCost, useLiveRefresh } from "../../components/agents";
import { Avatar, TimeAgo } from "../../components/ui";
import { agents } from "../../lib/services.server";
import { getViewer, roleIn, unwrap } from "../../lib/session.server";

export function meta({ loaderData, params, ...args }: Route.MetaArgs) {
  return page(args, {
    title: `Session of #${params.number}${loaderData ? ` ${loaderData.session.pull.title}` : ""} · ${params.owner}/${params.repo} · g1t`,
  });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const session = await agents.getSession(viewer, { namespace: params.owner, name: params.repo }, Number(params.number));
  return { session: unwrap(session), member: roleIn(viewer, params.owner) != null };
}

function Entry({ entry }: { entry: SessionEntry }) {
  const at = (
    <span className="shrink-0 text-xs text-faint">
      <TimeAgo at={entry.at} />
    </span>
  );
  if (entry.kind === "prompt") {
    return (
      <li className="px-4 py-3">
        <details>
          <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium">
            <Terminal size={14} className="text-merged" />
            <span className="grow">Prompt</span>
            {at}
          </summary>
          <pre className="mt-2 max-h-96 overflow-auto rounded-lg bg-bg p-3 text-xs whitespace-pre-wrap text-muted">{entry.text}</pre>
        </details>
      </li>
    );
  }
  if (entry.kind === "message") {
    return (
      <li className="flex gap-2.5 px-4 py-3 text-sm">
        <MessageSquare size={14} className="mt-0.5 shrink-0 text-faint" />
        <p className="min-w-0 grow whitespace-pre-wrap">{entry.text}</p>
        {at}
      </li>
    );
  }
  if (entry.kind === "tool_call") {
    return (
      <li className="flex gap-2.5 px-4 py-2 text-xs">
        <Wrench size={13} className="mt-0.5 shrink-0 text-faint" />
        <span className="shrink-0 font-medium text-muted">{entry.tool}</span>
        <code className="min-w-0 grow truncate font-mono text-fg/85" title={entry.text}>
          {entry.text}
        </code>
      </li>
    );
  }
  if (entry.kind === "tool_result") {
    return (
      <li className="px-4 py-1.5 pl-10">
        <details>
          <summary className="cursor-pointer text-xs text-faint">Result</summary>
          <pre className="mt-1.5 max-h-72 overflow-auto rounded-lg bg-bg p-3 text-xs text-muted">{entry.text}</pre>
        </details>
      </li>
    );
  }
  return (
    <li className="flex gap-2.5 px-4 py-2.5 text-xs text-muted">
      <StickyNote size={13} className="mt-0.5 shrink-0 text-faint" />
      <span className="min-w-0 grow">{entry.text}</span>
      {at}
    </li>
  );
}

export default function SessionPage({ loaderData, params }: Route.ComponentProps) {
  const { session, member } = loaderData;
  const { pull, entries, runs } = session;
  const base = `/${params.owner}/${params.repo}`;
  const live = runs.some((run) => run.status === "queued" || run.status === "running");
  useLiveRefresh(live);
  const [search, setSearch] = useSearchParams();
  const quiet = search.get("results") !== "1";
  const shown = quiet ? entries.filter((entry) => entry.kind !== "tool_result") : entries;
  const tools = entries.filter((entry) => entry.kind === "tool_call").length;
  return (
    <div className="max-w-4xl">
      <Link to={`${base}/sessions`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} />
        Sessions
      </Link>
      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Avatar name={pull.agent} size={22} />
        <h2 className="min-w-0 grow text-lg font-semibold tracking-tight">
          <Link to={`${base}/pull/${pull.number}`} className="hover:text-accent">
            {pull.title} <span className="font-normal text-faint">#{pull.number}</span>
          </Link>
        </h2>
      </div>
      <p className="mt-1.5 text-sm text-muted">
        {pull.agent} · {pull.status} · {entries.length} entries · {tools} tool calls
        {formatCost(session.costUsd) && ` · ${formatCost(session.costUsd)} over ${runs.length} ${runs.length === 1 ? "run" : "runs"}`}
      </p>

      {runs.length > 0 && (
        <section className="mt-8">
          <h3 className="text-sm font-medium">Runs</h3>
          <ul className="mt-3 space-y-3">
            {runs.map((run) => (
              <RunCard key={run.id} run={run} member={member} />
            ))}
          </ul>
        </section>
      )}

      <section className="mt-8">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-medium">What happened</h3>
          <button
            type="button"
            onClick={() => setSearch(quiet ? { results: "1" } : {}, { replace: true, preventScrollReset: true })}
            className="text-xs text-muted hover:text-fg"
          >
            {quiet ? "Show tool results" : "Hide tool results"}
          </button>
        </div>
        {shown.length === 0 ? (
          <p className="mt-3 text-sm text-muted">Nothing recorded yet.</p>
        ) : (
          <ol className="mt-3 divide-y divide-line rounded-xl border border-line bg-surface">
            {shown.map((entry) => (
              <Entry key={entry.seq} entry={entry} />
            ))}
          </ol>
        )}
        {entries.length >= 2000 && (
          <p className="mt-3 text-xs text-muted">
            The first 2000 entries. The rest are in the API's read_session, page by page.
          </p>
        )}
      </section>
    </div>
  );
}
