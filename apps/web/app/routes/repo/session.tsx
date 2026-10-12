import { ArrowLeft } from "lucide-react";
import { Link, useSearchParams } from "react-router";

import type { Route } from "./+types/session";
import { page } from "../../lib/meta";
import { Avatar } from "../../components/ui/avatar";
import { Button } from "../../components/ui/button";
import { SessionEntries } from "../../components/session-entries";
import { agents } from "../../lib/services.server";
import { getViewer, unwrap } from "../../lib/session.server";

export function meta({ loaderData, params, ...args }: Route.MetaArgs) {
  return page(args, {
    title: `Session of #${params.number}${loaderData ? ` ${loaderData.session.pull.title}` : ""} · ${params.owner}/${params.repo} · g1t`,
  });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const session = await agents.getSession(viewer, { namespace: params.owner, name: params.repo }, Number(params.number));
  return { session: unwrap(session) };
}

export default function SessionPage({ loaderData, params }: Route.ComponentProps) {
  const { session } = loaderData;
  const { pull, entries } = session;
  const base = `/${params.owner}/${params.repo}`;
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
      </p>

      <section className="mt-8">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-medium">What happened</h3>
          <Button
            type="button"
            onClick={() => setSearch(quiet ? { results: "1" } : {}, { replace: true, preventScrollReset: true })}
            variant="link"
            size="inline"
            className="text-xs text-muted hover:text-fg font-normal"
          >
            {quiet ? "Show tool results" : "Hide tool results"}
          </Button>
        </div>
        {shown.length === 0 ? (
          <p className="mt-3 text-sm text-muted">Nothing recorded yet.</p>
        ) : (
          <div className="mt-3">
            <SessionEntries entries={shown} />
          </div>
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
