import { Link, data, useOutletContext, useSearchParams } from "react-router";

import type { AgentSession, WorkspaceAgent } from "@g1t/contracts";

import type { Route } from "./+types/sessions";
import { MessageAgent } from "./agent";
import { AgentAvatar } from "../../../components/agent-avatar";
import { readOrNull } from "../../../components/agents/actions.server";
import { isLive, sessionRows } from "../../../components/agents/format";
import { Quiet, SessionRow } from "../../../components/agents/parts";
import { isOrchestrator } from "../../../components/orchestrator";
import { cn } from "../../../lib/cn";
import { useRefreshWhile } from "../../../lib/refresh";
import { workspaceAgents } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

type Filter = "all" | "live" | "done";

/** The agent's sessions, newest first; `?status=live` or `done` narrows them. */
export async function loader({ params, context, request }: Route.LoaderArgs): Promise<{ sessions: AgentSession[] | null; filter: Filter }> {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const asked = new URL(request.url).searchParams.get("status");
  const filter: Filter = asked === "live" || asked === "done" ? asked : "all";
  const sessions = await readOrNull(
    workspaceAgents.sessions(params.owner.toLowerCase(), viewer, { handle: params.handle.toLowerCase(), status: filter === "all" ? null : filter, limit: 100 }),
  );
  return { sessions, filter };
}

/** An empty list, in the agent's own voice. */
const EMPTY: Record<string, string> = {
  crisp: "No sessions yet. Ask me for something that takes real work and I'll start one.",
  friendly: "Nothing on my plate yet! Ask me for something bigger than a quick answer and I'll get going.",
  socratic: "Nothing here yet. What would you like me to dig into first?",
  terse: "No sessions. Send work.",
};

/**
 * Every session the agent is working on or has worked on: live first, then
 * finished, each child under the session that started it.
 */
export default function Sessions({ loaderData, params }: Route.ComponentProps) {
  const agent = useOutletContext<WorkspaceAgent>();
  const { sessions, filter } = loaderData;
  const [search] = useSearchParams();
  const live = (sessions ?? []).filter((s) => isLive(s.status));
  const done = (sessions ?? []).filter((s) => !isLive(s.status));
  useRefreshWhile(live.length > 0);
  const tab = (value: Filter, label: string) => {
    const next = new URLSearchParams(search);
    if (value === "all") next.delete("status");
    else next.set("status", value);
    const query = next.toString();
    return (
      <Link
        key={value}
        to={query ? `?${query}` : "."}
        preventScrollReset
        aria-current={filter === value ? "true" : undefined}
        className={cn("rounded px-2.5 py-1 text-[0.8125rem]", filter === value ? "bg-raised text-fg" : "text-muted hover:text-fg")}
      >
        {label}
      </Link>
    );
  };
  if (!sessions) {
    return <Quiet title="Sessions can't be shown right now">The agents service didn&apos;t answer. Reload in a moment.</Quiet>;
  }
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">
          A conversation with {agent.display_name} stays quick. When a request needs real work, it spins off a session with its own budget and a live card in the
          conversation. Sessions can bring in colleagues or subagents; all of it is paid from the session that started it.
        </p>
        <nav aria-label="Which sessions" className="flex rounded-md border border-line p-0.5">
          {tab("all", "All")}
          {tab("live", "Live")}
          {tab("done", "Done")}
        </nav>
      </div>

      {sessions.length === 0 ? (
        filter === "all" ? (
          <div className="rounded-2xl border border-dashed border-line bg-surface/40 px-6 py-14 text-center">
            <span className="mx-auto flex justify-center">
              <AgentAvatar agent={{ ...agent, builtin: isOrchestrator(agent) }} size={52} />
            </span>
            <h2 className="mt-4 text-base font-semibold">No sessions yet</h2>
            <blockquote className="mx-auto mt-3 max-w-md text-[0.9375rem] text-fg-soft">
              &ldquo;{EMPTY[agent.personality_preset] ?? EMPTY.crisp}&rdquo;
              <footer className="mt-1 text-xs text-faint">{agent.display_name}</footer>
            </blockquote>
            <div className="mt-6 flex justify-center">
              <MessageAgent slug={params.owner} agent={agent} variant="accent" />
            </div>
            <p className="mt-4 text-xs text-faint">
              Works up to {agent.capacity} {agent.capacity === 1 ? "session" : "sessions"} at once; more wait in line.
            </p>
          </div>
        ) : (
          <Quiet title={filter === "live" ? "Nothing live" : "Nothing finished yet"}>
            {filter === "live" ? `${agent.display_name} isn't working on a session right now.` : "Finished sessions stay here with their transcripts and reports."}
          </Quiet>
        )
      ) : (
        <>
          {live.length > 0 && <SessionGroup title="Live" slug={params.owner} sessions={live} />}
          {done.length > 0 && <SessionGroup title={filter === "done" ? "Done" : "Past"} slug={params.owner} sessions={done} />}
        </>
      )}
    </div>
  );
}

function SessionGroup({ title, slug, sessions }: { title: string; slug: string; sessions: AgentSession[] }) {
  return (
    <section>
      <h2 className="text-sm font-medium">
        {title} <span className="text-faint">{sessions.length}</span>
      </h2>
      <ul className="mt-3 divide-y divide-line/60 overflow-hidden rounded-xl border border-line bg-surface">
        {sessionRows(sessions).map(({ session, depth }) => (
          <SessionRow key={session.id} slug={slug} session={session} depth={depth} />
        ))}
      </ul>
    </section>
  );
}
