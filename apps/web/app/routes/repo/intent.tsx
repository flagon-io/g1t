import { env } from "cloudflare:workers";
import { Bot, GitCommitHorizontal, Play, Sparkles, Terminal } from "lucide-react";
import { useEffect } from "react";
import {
  Form,
  Link,
  redirect,
  useNavigation,
  useRevalidator,
} from "react-router";

import type { Route } from "./+types/intent";
import { Markdown } from "../../components/markdown";
import {
  Avatar,
  Button,
  CopyLine,
  EmptyState,
  ErrorText,
  Input,
  Status,
  Textarea,
  TimeAgo,
} from "../../components/ui";
import { work } from "../../lib/services.server";
import {
  assertSameOrigin,
  getViewer,
  requireUser,
  unwrap,
} from "../../lib/session.server";

const REFRESH_MS = 4000;

export function meta({ loaderData, params }: Route.MetaArgs) {
  const title = loaderData ? `${loaderData.intent.title} · ` : "";
  return [{ title: `${title}${params.owner}/${params.repo} · g1t` }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const detail = unwrap(
    await work.getIntent(
      { namespace: params.owner, name: params.repo },
      Number(params.number),
      viewer,
    ),
  );
  return {
    ...detail,
    viewer,
    agentModels: await env.RUNNER.models(viewer),
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const intentId = String(form.get("intentId") ?? "");

  if (form.get("action") === "run-hosted") {
    const result = await env.RUNNER.run(user, intentId, {
      count: Number(form.get("count")),
      instructions: String(form.get("instructions") ?? ""),
      model: String(form.get("model") ?? "") || undefined,
    });
    return result.ok ? null : { error: result.error.message };
  }
  if (form.get("action") === "withdraw") {
    const result = await work.withdrawIntent(user, intentId);
    return result.ok ? null : { error: result.error.message };
  }
  const result = await work.startAttempt(user, intentId, {
    agent: String(form.get("agent") ?? ""),
    runtime: "external",
  });
  if (!result.ok) return { error: result.error.message };
  throw redirect(
    `/${params.owner}/${params.repo}/attempts/${result.value.id}`,
  );
}

export default function IntentPage({
  loaderData,
  actionData,
  params,
}: Route.ComponentProps) {
  const { intent, attempts, viewer, agentModels } = loaderData;

  // Follow running attempts without a manual reload.
  const revalidator = useRevalidator();
  const navigation = useNavigation();
  const running = attempts.some((attempt) => attempt.status === "working");
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") revalidator.revalidate();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [running, revalidator]);
  const starting = navigation.formData?.get("action") === "run-hosted";
  const base = `/${params.owner}/${params.repo}`;
  const open = intent.status === "open";
  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_19rem]">
      <div className="min-w-0">
        <div className="flex items-start gap-3">
          <h2 className="grow text-2xl font-semibold tracking-tight text-balance">
            {intent.title}{" "}
            <span className="font-normal text-faint">#{intent.number}</span>
          </h2>
          <Status value={intent.status} />
        </div>
        <p className="mt-2 flex items-center gap-2 text-sm text-muted">
          <Avatar name={intent.author.username} size={18} />
          <span>
            <span className="font-medium text-fg">{intent.author.username}</span>{" "}
            opened this <TimeAgo at={intent.createdAt} />
          </span>
        </p>

        {intent.brief && (
          <div className="mt-6 rounded-xl border border-line bg-surface p-5">
            <Markdown source={intent.brief} />
          </div>
        )}

        <div className="mt-10 flex items-baseline justify-between">
          <h3 className="font-semibold tracking-tight">Attempts</h3>
          <p className="text-sm text-muted">
            {attempts.length === 0
              ? "None yet"
              : `${attempts.length} in the arena`}
          </p>
        </div>
        <div className="mt-3">
          {attempts.length === 0 ? (
            <EmptyState title="No agent has attempted this yet">
              Start an attempt here, or point an agent at intent{" "}
              <code className="font-mono">{intent.id}</code>.
            </EmptyState>
          ) : (
            // Each attempt is a lane hanging off a shared rail.
            <ol className="relative space-y-3 pl-6 before:absolute before:top-2 before:bottom-2 before:left-1.75 before:w-px before:bg-line">
              {attempts.map((attempt) => (
                <li key={attempt.id} className="relative">
                  <span
                    className={`absolute top-5 -left-6 size-3.75 rounded-full border-2 border-bg ${
                      attempt.status === "working"
                        ? "bg-accent"
                        : attempt.status === "submitted"
                          ? "bg-info"
                          : attempt.status === "shipped"
                            ? "bg-shipped"
                            : "bg-line-strong"
                    }`}
                  />
                  <Link
                    to={`${base}/attempts/${attempt.id}`}
                    className="block rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line-strong"
                  >
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="flex items-center gap-1.5 font-mono text-sm font-medium">
                        <Bot size={15} className="text-faint" />
                        {attempt.agent}
                      </span>
                      {attempt.runtime === "hosted" && (
                        <span className="rounded-full border border-line px-1.5 py-px text-[0.6875rem] text-faint">
                          hosted
                        </span>
                      )}
                      <span className="text-sm text-faint">
                        attempt {attempt.number}
                      </span>
                      <Status value={attempt.status} />
                      <span className="ml-auto flex items-center gap-3 text-xs text-faint">
                        <span className="flex items-center gap-1 font-mono">
                          <GitCommitHorizontal size={13} />
                          {attempt.headCommit?.slice(0, 7) ?? "no commits"}
                        </span>
                        <TimeAgo at={attempt.updatedAt} />
                      </span>
                    </div>
                    {attempt.summary && (
                      <p className="mt-2.5 line-clamp-2 text-sm text-muted">
                        {attempt.summary}
                      </p>
                    )}
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>

      <aside className="space-y-6">
        {intent.checks.length > 0 && (
          <section>
            <h3 className="text-sm font-medium">Acceptance checks</h3>
            <ul className="mt-2 space-y-1.5">
              {intent.checks.map((check) => (
                <li
                  key={check}
                  className="flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-xs"
                >
                  <Terminal size={13} className="shrink-0 text-faint" />
                  <span className="truncate">{check}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {open && agentModels.length > 0 && (
          <section className="rounded-xl border border-accent/30 bg-accent/5 p-4">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              <Sparkles size={15} className="text-accent" />
              Run g1t agents
            </h3>
            <p className="mt-1 text-xs text-muted">
              Each agent works in its own sandbox and its own fork, in
              parallel. Compare what they produce and ship the best.
            </p>
            <Form method="post" className="mt-3 space-y-2">
              <input type="hidden" name="intentId" value={intent.id} />
              <input type="hidden" name="action" value="run-hosted" />
              <label className="flex items-center justify-between gap-3 text-sm">
                <span className="text-muted">Agents</span>
                <select
                  name="count"
                  defaultValue="1"
                  className="rounded-md border border-line bg-bg px-2 py-1 text-sm"
                >
                  {[1, 2, 3, 4, 5].map((count) => (
                    <option key={count} value={count}>
                      {count}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center justify-between gap-3 text-sm">
                <span className="text-muted">Model</span>
                <select
                  name="model"
                  className="rounded-md border border-line bg-bg px-2 py-1 text-sm"
                >
                  {agentModels.map((model) => (
                    <option key={model.id} value={model.id} title={model.description}>
                      {model.label} · {model.modelName}
                    </option>
                  ))}
                </select>
              </label>
              <Textarea
                name="instructions"
                rows={2}
                placeholder="Extra guidance (optional)"
              />
              <div className="*:w-full">
                <Button variant="accent" type="submit" disabled={starting}>
                  <Play size={14} />
                  {starting ? "Starting sandboxes…" : "Run"}
                </Button>
              </div>
            </Form>
          </section>
        )}

        {open && (
          <section className="rounded-xl border border-line bg-surface p-4">
            <h3 className="text-sm font-medium">Bring your own agent</h3>
            <p className="mt-1 text-xs text-muted">
              With g1t connected to your agent, give it this intent id.
            </p>
            <div className="mt-3">
              <CopyLine text={intent.id} />
            </div>
            {viewer ? (
              <Form method="post" className="mt-4 space-y-2 border-t border-line pt-4">
                <input type="hidden" name="intentId" value={intent.id} />
                <p className="text-xs text-muted">
                  Or start an attempt yourself and get a fork to push to.
                </p>
                <Input name="agent" placeholder="Agent name, e.g. claude-code" maxLength={60} />
                <div className="*:w-full">
                  <Button type="submit">Start attempt</Button>
                </div>
              </Form>
            ) : (
              <p className="mt-4 border-t border-line pt-4 text-sm text-muted">
                <Link to="/login" className="text-fg underline underline-offset-4">
                  Sign in
                </Link>{" "}
                to start an attempt.
              </p>
            )}
            <ErrorText>{actionData?.error}</ErrorText>
          </section>
        )}

        {open && viewer?.id === intent.author.id && (
          <Form method="post">
            <input type="hidden" name="intentId" value={intent.id} />
            <input type="hidden" name="action" value="withdraw" />
            <Button variant="quiet" type="submit">
              Withdraw intent
            </Button>
          </Form>
        )}
      </aside>
    </div>
  );
}
