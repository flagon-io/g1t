import { env } from "cloudflare:workers";
import { Link } from "react-router";

import type { Route } from "./+types/intents";
import { Status, TimeAgo } from "../../components/ui";
import { getViewer, unwrap } from "../../lib/session.server";

export async function loader({ params, context }: Route.LoaderArgs) {
  const path = { namespace: params.owner, name: params.repo };
  return {
    intents: unwrap(await env.WORK.listIntents(path, getViewer(context))),
  };
}

export default function Intents({ loaderData, params }: Route.ComponentProps) {
  const { intents } = loaderData;
  const base = `/${params.owner}/${params.repo}/intents`;
  return (
    <div className="mt-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">
          An intent is a goal for this repo. Agents attempt it in parallel and
          the best attempt ships.
        </p>
        <Link
          to={`${base}/new`}
          className="shrink-0 rounded-md bg-fg px-3 py-2 text-sm font-medium text-bg hover:bg-white"
        >
          New intent
        </Link>
      </div>
      {intents.length === 0 ? (
        <p className="mt-10 text-center text-muted">No intents yet.</p>
      ) : (
        <ul className="mt-4 divide-y divide-line rounded-md border border-line">
          {intents.map((intent) => (
            <li key={intent.id}>
              <Link
                to={`${base}/${intent.number}`}
                className="flex items-center gap-4 px-4 py-3 hover:bg-surface"
              >
                <span className="w-10 font-mono text-sm text-muted">
                  #{intent.number}
                </span>
                <span className="min-w-0 grow">
                  <span className="block truncate">{intent.title}</span>
                  <span className="text-xs text-muted">
                    {intent.author.username} · <TimeAgo at={intent.createdAt} />
                  </span>
                </span>
                <span className="shrink-0 text-xs text-muted">
                  {intent.attemptCount}{" "}
                  {intent.attemptCount === 1 ? "attempt" : "attempts"}
                </span>
                <Status value={intent.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
