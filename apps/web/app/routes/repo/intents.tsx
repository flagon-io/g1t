import { CircleDot, GitMerge, Plus, XCircle } from "lucide-react";
import { Link } from "react-router";

import type { Intent } from "@g1t/contracts";

import type { Route } from "./+types/intents";
import { ButtonLink, EmptyState, TimeAgo } from "../../components/ui";
import { work } from "../../lib/services.server";
import { getViewer, unwrap } from "../../lib/session.server";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `Intents · ${params.owner}/${params.repo} · g1t` }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const path = { namespace: params.owner, name: params.repo };
  return {
    intents: unwrap(await work.listIntents(path, getViewer(context))),
  };
}

function StatusIcon({ status }: { status: Intent["status"] }) {
  if (status === "shipped") return <GitMerge size={16} className="text-shipped" />;
  if (status === "withdrawn") return <XCircle size={16} className="text-faint" />;
  return <CircleDot size={16} className="text-accent" />;
}

export default function Intents({ loaderData, params }: Route.ComponentProps) {
  const { intents } = loaderData;
  const base = `/${params.owner}/${params.repo}/intents`;
  const open = intents.filter((intent) => intent.status === "open").length;
  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted">
          <span className="font-medium text-fg">{open} open</span>
          <span className="mx-2 text-faint">·</span>
          {intents.length - open} closed
        </p>
        <ButtonLink to={`${base}/new`}>
          <Plus size={15} />
          New intent
        </ButtonLink>
      </div>
      <div className="mt-4">
        {intents.length === 0 ? (
          <EmptyState title="No intents yet">
            An intent is a goal for this repository. Agents attempt it in
            parallel, each in its own fork.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {intents.map((intent) => (
              <li key={intent.id}>
                <Link
                  to={`${base}/${intent.number}`}
                  className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface"
                >
                  <StatusIcon status={intent.status} />
                  <span className="min-w-0 grow">
                    <span className="block truncate font-medium">
                      {intent.title}
                    </span>
                    <span className="text-xs text-faint">
                      #{intent.number} opened <TimeAgo at={intent.createdAt} /> by{" "}
                      {intent.author.username}
                    </span>
                  </span>
                  {/* One dot per attempt: the lanes at a glance. */}
                  <span className="flex shrink-0 items-center gap-1" aria-hidden="true">
                    {Array.from({ length: Math.min(intent.attemptCount, 12) }, (_, i) => (
                      <span key={i} className="size-1.5 rounded-full bg-accent-dim" />
                    ))}
                  </span>
                  <span className="w-20 shrink-0 text-right text-xs text-muted">
                    {intent.attemptCount}{" "}
                    {intent.attemptCount === 1 ? "attempt" : "attempts"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
