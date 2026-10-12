import { CircleDot, ExternalLink } from "lucide-react";
import { Form, Link, redirect } from "react-router";

import type { ErrorGroup } from "@g1t/contracts";

import type { Route } from "./+types/observability-errors";
import { FilterBar, ObservabilityHeader, useLoadingView } from "../../components/observability";
import { EmptyState, ErrorText, SubmitButton, TimeAgo } from "../../components/ui";
import { Badge } from "../../components/ui/badge";
import { Card } from "../../components/ui/card";
import { refusal } from "../../lib/access.server";
import { cn } from "../../lib/cn";
import { page } from "../../lib/meta";
import { count, errorIssue, viewHref } from "../../lib/observability";
import { observed, soft } from "../../lib/observability.server";
import { work } from "../../lib/services.server";
import { assertSameOrigin, requireUser } from "../../lib/session.server";

const STATES: ErrorGroup["state"][] = ["open", "resolved", "ignored"];

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Errors · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const { projectId, service, view, filter, access } = await observed(context, params, request);
  const stateParam = new URL(request.url).searchParams.get("state");
  const state = STATES.find((s) => s === stateParam) ?? "open";
  const [groups, facets] = await Promise.all([
    soft(service.errors({ project_id: projectId, ...filter, deployment_id: null, state }), "errors"),
    soft(service.facets({ project_id: projectId }), "facets"),
  ]);
  return { view, groups, facets, state, can: { triage: access.can.triage, issue: access.can.participate } };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const { projectId, service, repo } = await observed(context, params, request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const fingerprint = String(form.get("fingerprint") ?? "");
  if (intent === "resolved" || intent === "ignored" || intent === "open") {
    const refused = await refusal(context, params, "triage");
    if (refused) return { error: refused, fingerprint };
    await service.setError({ project_id: projectId, fingerprint, state: intent });
    return { notice: intent === "open" ? "Open again." : intent === "resolved" ? "Resolved. It opens again if it happens again." : "Ignored." };
  }
  if (intent === "issue") {
    const refused = await refusal(context, params, "participate");
    if (refused) return { error: refused, fingerprint };
    const group = (await service.errors({ project_id: projectId })).find((g) => g.fingerprint === fingerprint);
    if (!group) return { error: "That error is no longer kept.", fingerprint };
    const url = new URL(request.url);
    const { title, body } = errorIssue(group, `${url.origin}/${params.owner}/${params.repo}/observability`);
    const path = { namespace: repo.namespace, name: repo.name };
    const opened = await work.openIssue(user, path, { title, body, labels: ["bug"] });
    if (!opened.ok) return { error: opened.error.message, fingerprint };
    await service.setError({ project_id: projectId, fingerprint, issue_number: opened.value.number });
    throw redirect(`/${path.namespace}/${path.name}/issues/${opened.value.number}`);
  }
  return { error: "Unknown request.", fingerprint };
}

export default function Errors({ loaderData, actionData, params }: Route.ComponentProps) {
  const { view, groups, facets, state, can } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const path = `${base}/observability/errors`;
  const loading = useLoadingView();
  const failedOn = actionData && "fingerprint" in actionData ? actionData.fingerprint : null;

  return (
    <div className="mx-auto max-w-6xl">
      <ObservabilityHeader
        title="Errors"
        about="Exceptions, grouped: the same error thrown a thousand times is one row. Each can become an issue, carrying the stack and the request it came from."
      />
      <FilterBar path={path} view={view} environments={facets?.environments ?? []} services={facets?.services ?? []}>
        <nav className="flex rounded-md border border-line p-0.5 text-sm" aria-label="State">
          {STATES.map((s) => (
            <Link
              key={s}
              to={viewHref(path, view, { state: s === "open" ? null : s })}
              preventScrollReset
              aria-current={s === state ? "true" : undefined}
              className={cn("rounded px-2 py-0.5 text-xs capitalize", s === state ? "bg-raised text-fg" : "text-muted hover:text-fg")}
            >
              {s}
            </Link>
          ))}
        </nav>
      </FilterBar>
      <div className="mt-3 min-h-5">
        {actionData && "notice" in actionData && <p className="text-sm text-success">{actionData.notice}</p>}
      </div>

      <div className={cn("mt-2 transition-opacity", loading && "opacity-60")}>
        {!groups ? (
          <Card className="p-6 text-sm text-muted">Errors could not be loaded just now. Reload the page to try again.</Card>
        ) : groups.length === 0 ? (
          <EmptyState title={state === "open" ? "No open errors in this period" : `No ${state} errors in this period`}>
            Exceptions thrown by apps on g1t.page show here on their own; others arrive as OpenTelemetry exception events and log records.
          </EmptyState>
        ) : (
          <ul className="space-y-3">
            {groups.map((g) => (
              <li key={g.fingerprint} id={g.fingerprint}>
                <Card className="min-w-0 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm text-danger">{g.name}</span>
                        <Badge tone="neutral" className="font-mono">
                          {g.service || "app"}
                        </Badge>
                        {g.environment && <Badge tone="neutral">{g.environment}</Badge>}
                        {g.issue_number && (
                          <Link to={`${base}/issues/${g.issue_number}`} className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
                            <CircleDot size={12} />#{g.issue_number}
                          </Link>
                        )}
                      </p>
                      <p className="mt-1 text-sm wrap-break-word">{g.message}</p>
                      <p className="mt-1.5 text-xs text-faint tabular-nums">
                        <span className="text-fg">{count(g.count)}</span> time{g.count === 1 ? "" : "s"} · first <TimeAgo at={g.first_us / 1000} /> · last{" "}
                        <TimeAgo at={g.last_us / 1000} />
                        {g.first_deployment_id && (
                          <>
                            {" "}
                            · since{" "}
                            <Link to={`${base}/deployments/${g.first_deployment_id}`} className="font-mono hover:text-fg">
                              {g.first_deployment_id.slice(0, 12)}
                            </Link>
                          </>
                        )}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      {g.last_request_id && (
                        <Link to={`${base}/observability/requests/${g.last_request_id}`} className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
                          Latest request <ExternalLink size={11} />
                        </Link>
                      )}
                      {g.last_trace_id && (
                        <Link to={`${base}/observability/traces/${g.last_trace_id}`} className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
                          Trace <ExternalLink size={11} />
                        </Link>
                      )}
                    </div>
                  </div>
                  {g.stack && (
                    <details className="mt-3">
                      <summary className="cursor-pointer text-xs text-muted hover:text-fg">Stack</summary>
                      <pre className="mt-2 max-h-72 overflow-auto rounded-md border border-line bg-bg p-3 font-mono text-xs whitespace-pre">{g.stack}</pre>
                    </details>
                  )}
                  {(can.triage || (can.issue && !g.issue_number)) && (
                    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
                      {can.issue && !g.issue_number && (
                        <Form method="post" className="flex flex-wrap items-center gap-2">
                          <input type="hidden" name="fingerprint" value={g.fingerprint} />
                          <SubmitButton name="intent" value="issue" size="sm" variant="outline">
                            Make an issue
                          </SubmitButton>
                        </Form>
                      )}
                      {can.triage && (
                        <Form method="post" className="ml-auto flex gap-2">
                          <input type="hidden" name="fingerprint" value={g.fingerprint} />
                          {g.state !== "resolved" && (
                            <SubmitButton name="intent" value="resolved" size="sm" variant="ghost">
                              Resolve
                            </SubmitButton>
                          )}
                          {g.state !== "ignored" && (
                            <SubmitButton name="intent" value="ignored" size="sm" variant="ghost">
                              Ignore
                            </SubmitButton>
                          )}
                          {g.state !== "open" && (
                            <SubmitButton name="intent" value="open" size="sm" variant="ghost">
                              Open again
                            </SubmitButton>
                          )}
                        </Form>
                      )}
                    </div>
                  )}
                  {failedOn === g.fingerprint && <ErrorText>{actionData && "error" in actionData ? actionData.error : null}</ErrorText>}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
