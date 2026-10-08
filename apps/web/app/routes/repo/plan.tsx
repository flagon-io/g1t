import { env } from "cloudflare:workers";
import type { G1tEvent } from "@g1t/contracts";
import { ArrowRight, CircleCheck, FileCode2, Sparkles } from "lucide-react";
import { Form, Link, data } from "react-router";

import type { Route } from "./+types/plan";
import { refusal, requireRepo } from "../../lib/access.server";
import { whyNot } from "../../lib/access";
import { page } from "../../lib/meta";
import { Markdown } from "../../components/markdown";
import { Activity, Exchanges } from "../../components/activity";
import { Outcome } from "../../components/outcome";
import { ErrorText, SubmitButton, TimeAgo, usePending } from "../../components/ui";
import { Checkbox } from "../../components/ui/checkbox";
import { Hint } from "../../components/ui/hint";
import { Label } from "../../components/work";
import { billing, events, identity, work } from "../../lib/services.server";
import {
  assertSameOrigin,
  getViewer,
  requireUser,
  unwrap,
} from "../../lib/session.server";
import { useRefreshWhile } from "../../lib/refresh";


export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Plan · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  // Anyone who can read the repository: a public one's to anyone, a private one's to people with a role.
  const { access } = await requireRepo(context, params, "read");
  const path = { namespace: params.owner, name: params.repo };
  const [plan, ledger] = await Promise.all([
    work.getPlan(path, viewer, params.id),
    billing.ledger(params.owner, viewer),
  ]);
  const found = unwrap(plan);
  // What the agents working on this outcome have cost so far.
  const pulls = new Set(found.progress.flatMap((item) => (item.pull != null ? [item.pull] : [])));
  const repo = `${params.owner}/${params.repo}`;
  const costMicros = ledger.ok
    ? ledger.value
        .filter((entry) => entry.kind === "usage" && entry.repo === repo && entry.number != null && pulls.has(entry.number))
        .reduce((sum, entry) => sum - entry.amountMicros, 0)
    : null;
  // What happened across the outcome's issues and pull requests.
  let activity: G1tEvent[] = [];
  if (found.status === "applied" && found.progress.length > 0) {
    const numbers = new Set([
      ...found.progress.map((item) => item.number),
      ...found.progress.flatMap((item) => (item.pull != null ? [item.pull] : [])),
    ]);
    const since = found.finishedAt ?? found.createdAt;
    const recent = await events.list({ repoId: found.repoId, limit: 200 }).catch(() => []);
    activity = recent
      .filter((event) => event.time >= since)
      .filter((event) => {
        const data = event.data as { number?: number; issue?: number };
        // Issues an agent filed while working on this outcome belong to it too.
        if (event.type === "issue.opened" && event.actor === "usr_g1t_agent") return true;
        return (data.number != null && numbers.has(data.number)) || (data.issue != null && numbers.has(data.issue));
      })
      .slice(0, 40);
    // Events name accounts by id; show names.
    const named = await identity
      .usernames([...new Set(activity.flatMap((event) => (event.actor ? [event.actor] : [])))])
      .catch(() => ({}) as Record<string, string>);
    const known: Record<string, string> = { ...named, usr_g1t_agent: "g1t", g1t_policy: "g1t" };
    activity = activity.map((event) => ({ ...event, actor: event.actor ? (known[event.actor] ?? event.actor) : null }));
  }
  return { plan: found, costMicros, activity, can: access.can };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const path = { namespace: params.owner, name: params.repo };
  // Opening the issues and putting agents on them: Write and up.
  const refused = await refusal(context, params, "run");
  if (refused) return { error: refused };
  const applied = await env.RUNNER.applyPlan(user, path, params.id, {
    assign: form.get("action") === "assign",
    keep: form.getAll("keep").map(Number),
  });
  return applied.ok ? null : { error: applied.error.message };
}

export default function PlanPage({ loaderData, actionData, params }: Route.ComponentProps) {
  const { plan, costMicros, activity } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  // Either way of applying it, so the other button waits too.
  const applying = usePending();

  // The agent is still writing it.
  const planning = plan.status === "planning";
  // Planning, or agents still converging what was applied.
  const moving =
    planning || plan.progress.some((item) => item.state !== "landed" && item.state !== "closed");
  useRefreshWhile(moving);
  const converging = plan.status === "applied" && plan.progress.length > 0;

  const independent = plan.issues.filter((issue) => issue.dependsOn.length === 0).length;
  return (
    <div className={converging ? "" : "max-w-4xl"}>
      <p className="text-sm">
        <Link to={`${base}/plans`} className="text-muted hover:text-fg">
          Plans
        </Link>
      </p>
      <h2 className="mt-2 text-xl font-semibold tracking-tight">The outcome</h2>
      <div className="mt-3 rounded-xl border border-line bg-surface p-5 text-sm">
        <Markdown source={plan.brief} repo={{ namespace: params.owner, name: params.repo }} />
      </div>
      <p className="mt-2 text-xs text-faint">
        Asked for by {plan.author.username} <TimeAgo at={plan.createdAt} />
      </p>

      {converging && (
        <section className="mt-8">
          <Outcome plan={plan} base={base} costMicros={costMicros} />
          {plan.exchanges.length > 0 && (
            <div className="mt-10">
              <h3 className="font-mono text-[0.6875rem] tracking-[0.2em] text-faint uppercase">Agents talking</h3>
              <div className="mt-3 max-w-3xl">
                <Exchanges exchanges={plan.exchanges} base={base} />
              </div>
            </div>
          )}
          {activity.length > 0 && (
            <div className="mt-10">
              <h3 className="font-mono text-[0.6875rem] tracking-[0.2em] text-faint uppercase">What happened</h3>
              <div className="mt-3 max-w-3xl">
                <Activity events={activity} base={base} />
              </div>
            </div>
          )}
        </section>
      )}

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
                    <Checkbox
                      name="keep"
                      value={String(position)}
                      defaultChecked
                      aria-label={`Open issue ${position}`}
                      className="mt-1"
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
                      {(issue.done ?? []).map((point) => (
                        <span key={point} className="flex items-center gap-1">
                          <CircleCheck size={12} />
                          {point}
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
              <Hint label={whyNot(loaderData.can, "run")} disabled={!loaderData.can.run}>
                <SubmitButton variant="accent" name="action" value="assign" pending="Opening issues…" disabled={applying || !loaderData.can.run}>
                  <Sparkles size={15} />
                  Open these and assign g1t
                </SubmitButton>
              </Hint>
              <Hint label={whyNot(loaderData.can, "run")} disabled={!loaderData.can.run}>
                <SubmitButton variant="quiet" name="action" value="open" pending="Opening issues…" disabled={applying || !loaderData.can.run}>
                  Only open the issues
                </SubmitButton>
              </Hint>
              <span className="text-xs text-muted">
                Untick any you do not want. Agents work on the independent ones at once
                and the rest follow as what they depend on merges.
              </span>
            </div>
          )}
          {plan.status === "applied" && !moving && (
            <p className="mt-6 text-sm text-muted">Everything in this plan has landed.</p>
          )}
          {plan.status === "applied" && moving && (
            <p className="mt-6 text-sm text-muted">
              Some are still open. Follow them under{" "}
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
