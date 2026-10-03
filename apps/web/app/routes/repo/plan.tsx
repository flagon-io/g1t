import { env } from "cloudflare:workers";
import { ArrowRight, FileCode2, Sparkles, Terminal } from "lucide-react";
import { useEffect } from "react";
import { Form, Link, data, useNavigation, useRevalidator } from "react-router";

import type { Route } from "./+types/plan";
import { Markdown } from "../../components/markdown";
import { Button, ErrorText, TimeAgo } from "../../components/ui";
import { Label } from "../../components/work";
import { work } from "../../lib/services.server";
import {
  assertSameOrigin,
  getViewer,
  requireUser,
  roleIn,
  unwrap,
} from "../../lib/session.server";

const REFRESH_MS = 4000;

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `Plan · ${params.owner}/${params.repo} · g1t` }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  // Members only; to anyone else the page does not exist.
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const path = { namespace: params.owner, name: params.repo };
  return { plan: unwrap(await work.getPlan(path, viewer, params.id)) };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const path = { namespace: params.owner, name: params.repo };
  const applied = await env.RUNNER.applyPlan(user, path, params.id, {
    assign: form.get("action") === "assign",
    keep: form.getAll("keep").map(Number),
  });
  return applied.ok ? null : { error: applied.error.message };
}

export default function PlanPage({ loaderData, actionData, params }: Route.ComponentProps) {
  const { plan } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const applying = useNavigation().state === "submitting";

  // The agent is still writing it.
  const revalidator = useRevalidator();
  const planning = plan.status === "planning";
  useEffect(() => {
    if (!planning) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") revalidator.revalidate();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [planning, revalidator]);

  const independent = plan.issues.filter((issue) => issue.dependsOn.length === 0).length;
  return (
    <div className="max-w-4xl">
      <p className="text-sm">
        <Link to={`${base}/plans`} className="text-muted hover:text-fg">
          Plans
        </Link>
      </p>
      <h2 className="mt-2 text-xl font-semibold tracking-tight">The outcome</h2>
      <div className="mt-3 rounded-xl border border-line bg-surface p-5 text-sm whitespace-pre-wrap">
        {plan.brief}
      </div>
      <p className="mt-2 text-xs text-faint">
        Asked for by {plan.author.username} <TimeAgo at={plan.createdAt} />
      </p>

      {planning && (
        <div className="mt-8 flex items-center gap-3 rounded-xl border border-accent/30 bg-accent/5 px-4 py-4 text-sm">
          <span className="size-2 animate-pulse rounded-full bg-accent" />
          <span>
            An agent is reading the repository and writing the plan. This takes a
            minute or two; the page fills in when it is done.
          </span>
        </div>
      )}
      {plan.status === "failed" && (
        <div className="mt-8 rounded-xl border border-danger/40 bg-danger/5 px-4 py-4 text-sm">
          <p className="font-medium">The plan could not be written</p>
          <p className="mt-1 text-muted">{plan.error}</p>
          <p className="mt-3">
            <Link to={`${base}/plans`} className="text-fg underline underline-offset-4">
              Try again
            </Link>
          </p>
        </div>
      )}

      {plan.issues.length > 0 && (
        <Form method="post" className="mt-8">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-xl font-semibold tracking-tight">
              {plan.status === "applied" ? "What was opened" : "The plan"}
            </h2>
            <p className="text-sm text-muted">
              {plan.issues.length} {plan.issues.length === 1 ? "issue" : "issues"},{" "}
              {independent} that can start at once
            </p>
          </div>
          {plan.summary && <p className="mt-2 text-sm text-muted">{plan.summary}</p>}

          <ol className="mt-5 space-y-3">
            {plan.issues.map((issue, index) => {
              const position = index + 1;
              return (
                <li
                  key={position}
                  className="flex gap-3 rounded-xl border border-line bg-surface p-4"
                >
                  {plan.status === "ready" ? (
                    <input
                      type="checkbox"
                      name="keep"
                      value={position}
                      defaultChecked
                      aria-label={`Open issue ${position}`}
                      className="mt-1.5 accent-accent"
                    />
                  ) : (
                    <span className="mt-0.5 w-5 shrink-0 text-center font-mono text-sm text-faint">
                      {position}
                    </span>
                  )}
                  <div className="min-w-0 grow">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      {issue.number != null ? (
                        <Link
                          to={`${base}/issues/${issue.number}`}
                          className="font-medium hover:underline"
                        >
                          {issue.title}{" "}
                          <span className="font-normal text-faint">#{issue.number}</span>
                        </Link>
                      ) : (
                        <span className="font-medium">
                          <span className="mr-1.5 font-mono text-sm font-normal text-faint">
                            {position}.
                          </span>
                          {issue.title}
                        </span>
                      )}
                      {issue.labels.map((name) => (
                        <Label key={name} name={name} />
                      ))}
                    </div>
                    <p className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
                      {issue.dependsOn.length === 0 ? (
                        <span className="text-accent">Starts at once</span>
                      ) : (
                        <span className="flex items-center gap-1">
                          <ArrowRight size={12} />
                          After{" "}
                          {issue.dependsOn
                            .map((earlier) => {
                              const number = plan.issues[earlier - 1]?.number;
                              return number != null ? `#${number}` : `${earlier}`;
                            })
                            .join(", ")}
                        </span>
                      )}
                      {issue.checks.map((check) => (
                        <span key={check} className="flex items-center gap-1 font-mono">
                          <Terminal size={12} />
                          {check}
                        </span>
                      ))}
                    </p>
                    {issue.files.length > 0 && (
                      <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-faint">
                        <FileCode2 size={12} />
                        {issue.files.map((file) => (
                          <span key={file}>{file}</span>
                        ))}
                      </p>
                    )}
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-faint hover:text-fg">
                        What the agent will be told
                      </summary>
                      <div className="mt-2 border-t border-line pt-3">
                        <Markdown source={issue.body} repo={{ namespace: params.owner, name: params.repo }} />
                      </div>
                    </details>
                  </div>
                </li>
              );
            })}
          </ol>

          {plan.status === "ready" && (
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Button variant="accent" type="submit" name="action" value="assign" disabled={applying}>
                <Sparkles size={15} />
                {applying ? "Opening issues…" : "Open these and assign g1t agents"}
              </Button>
              <Button variant="quiet" type="submit" name="action" value="open" disabled={applying}>
                Only open the issues
              </Button>
              <span className="text-xs text-muted">
                Untick any you do not want. Agents work on the independent ones at once
                and the rest follow as what they depend on merges.
              </span>
            </div>
          )}
          {plan.status === "applied" && (
            <p className="mt-6 text-sm text-muted">
              These are open. Follow them under{" "}
              <Link to={`${base}/issues`} className="text-fg underline underline-offset-4">
                Issues
              </Link>{" "}
              or in{" "}
              <Link to="/" className="text-fg underline underline-offset-4">
                mission control
              </Link>
              .
            </p>
          )}
          <div className="mt-3">
            <ErrorText>{actionData?.error}</ErrorText>
          </div>
        </Form>
      )}
    </div>
  );
}
