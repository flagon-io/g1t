import { History, Loader2 } from "lucide-react";
import { Form, Link, useSubmit } from "react-router";

import { type PullStatus, RUN_KINDS, RUN_KIND_LABEL, type RunKind } from "@g1t/contracts";

import type { Route } from "./+types/sessions";
import { page } from "../../lib/meta";
import { KindLabel, formatCost, useLiveRefresh } from "../../components/agents";
import { EmptyState, TimeAgo } from "../../components/ui";
import { Avatar } from "../../components/ui/avatar";
import { Card } from "../../components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { agents } from "../../lib/services.server";
import { getViewer, unwrap } from "../../lib/session.server";

const OUTCOMES: Record<PullStatus, string> = {
  draft: "In progress",
  open: "Ready for review",
  merged: "Merged",
  closed: "Closed",
};

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Sessions · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const query = new URL(request.url).searchParams;
  const kind = query.get("kind") as RunKind | null;
  const outcome = query.get("outcome") as PullStatus | null;
  const number = Number(String(query.get("pr") ?? "").replace("#", ""));
  const filter = {
    kind: kind && RUN_KINDS.includes(kind) ? kind : undefined,
    outcome: outcome && outcome in OUTCOMES ? outcome : undefined,
    number: number > 0 ? number : undefined,
  };
  const sessions = await agents.listSessions(viewer, { namespace: params.owner, name: params.repo }, filter);
  return { sessions: unwrap(sessions), filter };
}

export default function Sessions({ loaderData, params }: Route.ComponentProps) {
  const { sessions, filter } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const submit = useSubmit();
  useLiveRefresh(sessions.some((session) => session.active));
  const filtered = filter.kind || filter.outcome || filter.number;
  return (
    <div className="max-w-4xl">
      <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
        <History size={19} className="text-accent" />
        Sessions
      </h2>
      <p className="mt-1.5 max-w-2xl text-sm text-muted">
        Every recorded session on this project: the prompt an agent was given, what it said, the
        tools it ran and what came back, for each pull request. g1t records its own as it
        works; your own agents record theirs with record_session.
      </p>

      {/* Each choice applies at once; the number applies on Enter. */}
      <Form method="get" className="mt-6 flex flex-wrap items-center gap-2">
        <div className="w-44">
          <Select
            name="kind"
            defaultValue={filter.kind ?? "any"}
            onValueChange={(value) => submit({ ...current(filter), kind: value === "any" ? "" : value }, { method: "get" })}
          >
            <SelectTrigger size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any kind of run</SelectItem>
              {RUN_KINDS.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {RUN_KIND_LABEL[kind]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-44">
          <Select
            name="outcome"
            defaultValue={filter.outcome ?? "any"}
            onValueChange={(value) => submit({ ...current(filter), outcome: value === "any" ? "" : value }, { method: "get" })}
          >
            <SelectTrigger size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any outcome</SelectItem>
              {(Object.keys(OUTCOMES) as PullStatus[]).map((status) => (
                <SelectItem key={status} value={status}>
                  {OUTCOMES[status]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <input
          name="pr"
          defaultValue={filter.number ?? ""}
          placeholder="#"
          inputMode="numeric"
          autoComplete="off"
          data-1p-ignore
          aria-label="Pull request number"
          className="h-8 w-24 rounded-md border border-line bg-bg px-2.5 text-[0.8125rem] outline-none placeholder:text-faint focus:border-accent-dim"
        />
        {filtered && (
          <Link to={`${base}/sessions`} className="text-xs text-muted hover:text-fg">
            Clear
          </Link>
        )}
      </Form>

      {sessions.length === 0 ? (
        <div className="mt-6">
          <EmptyState title={filtered ? "No session matches" : "No sessions yet"}>
            {filtered
              ? "Try another kind of run or outcome."
              : "A session is recorded when an agent works on a pull request here."}
          </EmptyState>
        </div>
      ) : (
        <Card asChild divided className="mt-6">
          <ul>
            {sessions.map((session) => (
              <li key={session.number} className="px-4 py-3.5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <Avatar name={session.agent} size={18} />
                  <Link to={`${base}/sessions/${session.number}`} prefetch="intent" className="min-w-0 grow font-medium hover:text-accent">
                    {session.title} <span className="font-normal text-faint">#{session.number}</span>
                  </Link>
                  {session.active && (
                    <span className="inline-flex items-center gap-1 text-xs text-accent">
                      <Loader2 size={11} className="animate-spin" />
                      at work
                    </span>
                  )}
                  <span className="text-xs text-muted">{OUTCOMES[session.status]}</span>
                </div>
                {session.prompt && <p className="mt-1.5 line-clamp-1 text-sm text-muted">{session.prompt}</p>}
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted">
                  {session.kinds.map((kind) => (
                    <KindLabel key={kind} kind={kind} />
                  ))}
                  <span>{session.entries} entries</span>
                  <span>{session.tools} tool calls</span>
                  {session.runs > 0 && <span>{session.runs} {session.runs === 1 ? "run" : "runs"}</span>}
                  {formatCost(session.costUsd) && <span>{formatCost(session.costUsd)}</span>}
                  <span className="grow" />
                  <span>
                    <TimeAgo at={session.lastAt} />
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/** The filters as they stand, for changing one of them. */
function current(filter: { kind?: string; outcome?: string; number?: number }): Record<string, string> {
  return {
    kind: filter.kind ?? "",
    outcome: filter.outcome ?? "",
    pr: filter.number ? String(filter.number) : "",
  };
}
