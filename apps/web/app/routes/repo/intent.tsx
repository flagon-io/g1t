import { env } from "cloudflare:workers";
import { Form, Link, redirect } from "react-router";

import type { Route } from "./+types/intent";
import { Button, ErrorText, Input, Status, TimeAgo } from "../../components/ui";
import {
  assertSameOrigin,
  getViewer,
  requireUser,
  unwrap,
} from "../../lib/session.server";

export function meta({ loaderData: data, params }: Route.MetaArgs) {
  const title = data ? `${data.intent.title} · ` : "";
  return [{ title: `${title}${params.owner}/${params.repo} · g1t` }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const detail = unwrap(
    await env.WORK.getIntent(
      { namespace: params.owner, name: params.repo },
      Number(params.number),
      viewer,
    ),
  );
  return { ...detail, viewer };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const intentId = String(form.get("intentId") ?? "");
  const base = `/${params.owner}/${params.repo}`;

  if (form.get("action") === "withdraw") {
    const result = await env.WORK.withdrawIntent(user, intentId);
    return result.ok ? null : { error: result.error.message };
  }
  const result = await env.WORK.startAttempt(user, intentId, {
    agent: String(form.get("agent") ?? ""),
    runtime: "external",
  });
  if (!result.ok) return { error: result.error.message };
  throw redirect(`${base}/attempts/${result.value.id}`);
}

export default function IntentPage({
  loaderData,
  actionData,
  params,
}: Route.ComponentProps) {
  const { intent, attempts, viewer } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const open = intent.status === "open";
  return (
    <div className="mt-6 grid gap-8 lg:grid-cols-[1fr_20rem]">
      <div className="min-w-0">
        <div className="flex items-start gap-3">
          <h2 className="grow text-2xl font-semibold tracking-tight">
            {intent.title}{" "}
            <span className="font-mono font-normal text-muted">
              #{intent.number}
            </span>
          </h2>
          <Status value={intent.status} />
        </div>
        <p className="mt-1 text-sm text-muted">
          Opened by {intent.author.username} <TimeAgo at={intent.createdAt} />
        </p>

        {intent.brief && (
          <p className="mt-6 whitespace-pre-wrap leading-relaxed">
            {intent.brief}
          </p>
        )}

        <h3 className="mt-10 text-sm font-medium text-muted">
          Attempts ({attempts.length})
        </h3>
        {attempts.length === 0 ? (
          <p className="mt-3 rounded-md border border-dashed border-line p-6 text-center text-sm text-muted">
            No agent has attempted this yet.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {attempts.map((attempt) => (
              <li key={attempt.id}>
                <Link
                  to={`${base}/attempts/${attempt.id}`}
                  className="block rounded-md border border-line px-4 py-3 hover:border-muted"
                >
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-sm text-muted">
                      {attempt.number}
                    </span>
                    <span className="font-mono text-sm">{attempt.agent}</span>
                    <Status value={attempt.status} />
                    <span className="ml-auto font-mono text-xs text-muted">
                      {attempt.headCommit?.slice(0, 7) ?? "no commits"} ·{" "}
                      <TimeAgo at={attempt.updatedAt} />
                    </span>
                  </div>
                  {attempt.summary && (
                    <p className="mt-2 line-clamp-2 text-sm text-muted">
                      {attempt.summary}
                    </p>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <aside className="space-y-6">
        {intent.checks.length > 0 && (
          <section>
            <h3 className="text-sm font-medium text-muted">Acceptance checks</h3>
            <ul className="mt-2 space-y-1 font-mono text-sm">
              {intent.checks.map((check) => (
                <li key={check} className="rounded bg-surface px-2 py-1">
                  {check}
                </li>
              ))}
            </ul>
          </section>
        )}
        {open && viewer && (
          <section>
            <h3 className="text-sm font-medium text-muted">Start an attempt</h3>
            <Form method="post" className="mt-2 space-y-2">
              <input type="hidden" name="intentId" value={intent.id} />
              <Input name="agent" placeholder="claude-code" maxLength={60} />
              <Button type="submit">Start attempt</Button>
            </Form>
            <p className="mt-2 text-xs text-muted">
              Creates a fork for the agent to push to.
            </p>
          </section>
        )}
        {open && !viewer && (
          <p className="text-sm text-muted">
            <Link to="/login" className="text-fg underline">
              Sign in
            </Link>{" "}
            to start an attempt.
          </p>
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
        <ErrorText>{actionData?.error}</ErrorText>
      </aside>
    </div>
  );
}
