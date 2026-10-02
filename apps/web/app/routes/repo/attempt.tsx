import { env } from "cloudflare:workers";
import { useEffect } from "react";
import { Form, Link, useRevalidator } from "react-router";

import type { SessionEntry } from "@g1t/contracts";

import type { Route } from "./+types/attempt";
import { Button, ErrorText, Status, Textarea, TimeAgo } from "../../components/ui";
import {
  assertSameOrigin,
  getViewer,
  requireUser,
  unwrap,
} from "../../lib/session.server";

const REFRESH_MS = 4000;

export function meta({ loaderData: data }: Route.MetaArgs) {
  return [{ title: data ? `Attempt ${data.attempt.number} · ${data.intent.title} · g1t` : "g1t" }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const [found, session] = await Promise.all([
    env.WORK.getAttempt(params.id, viewer),
    env.WORK.readSession(params.id, viewer),
  ]);
  return { ...unwrap(found), session: unwrap(session), viewer };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const result =
    form.get("action") === "abandon"
      ? await env.WORK.abandonAttempt(user, params.id)
      : await env.WORK.submitAttempt(
          user,
          params.id,
          String(form.get("summary") ?? ""),
        );
  return result.ok ? null : { error: result.error.message };
}

const KIND_LABEL: Record<SessionEntry["kind"], string> = {
  prompt: "Prompt",
  message: "Agent",
  tool_call: "Tool",
  tool_result: "Result",
  note: "Note",
};

function Entry({ entry }: { entry: SessionEntry }) {
  const isTool = entry.kind === "tool_call" || entry.kind === "tool_result";
  return (
    <li className="grid grid-cols-[4.5rem_1fr] gap-3 px-4 py-3">
      <span className="pt-0.5 text-xs text-muted">
        {KIND_LABEL[entry.kind]}
      </span>
      <div className="min-w-0">
        {entry.tool && (
          <p className="font-mono text-xs text-accent">{entry.tool}</p>
        )}
        <p
          className={`whitespace-pre-wrap break-words text-sm ${
            isTool ? "font-mono text-muted" : ""
          } ${entry.kind === "prompt" ? "font-medium" : ""}`}
        >
          {entry.text}
        </p>
        {entry.commit && (
          <p className="mt-1 font-mono text-xs text-muted">
            at {entry.commit.slice(0, 7)}
          </p>
        )}
      </div>
    </li>
  );
}

export default function AttemptPage({
  loaderData,
  actionData,
  params,
}: Route.ComponentProps) {
  const { attempt, intent, session, viewer } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const remote = `https://g1t.sh/${attempt.fork.namespace}/${attempt.fork.name}.git`;
  const mine = viewer?.id === attempt.startedBy.id;
  const active = attempt.status === "working" || attempt.status === "submitted";

  // Follow a running attempt without a manual reload.
  const revalidator = useRevalidator();
  const working = attempt.status === "working";
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") revalidator.revalidate();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [working, revalidator]);

  return (
    <div className="mt-6 grid gap-8 lg:grid-cols-[1fr_20rem]">
      <div className="min-w-0">
        <p className="text-sm text-muted">
          <Link to={`${base}/intents/${intent.number}`} className="hover:text-fg">
            {intent.title} #{intent.number}
          </Link>
        </p>
        <div className="mt-1 flex items-center gap-3">
          <h2 className="text-2xl font-semibold tracking-tight">
            Attempt {attempt.number}
          </h2>
          <span className="font-mono text-sm text-muted">{attempt.agent}</span>
          <Status value={attempt.status} />
        </div>
        <p className="mt-1 text-sm text-muted">
          Started by {attempt.startedBy.username}{" "}
          <TimeAgo at={attempt.createdAt} /> · head{" "}
          <span className="font-mono">
            {attempt.headCommit?.slice(0, 7) ?? "none yet"}
          </span>
        </p>

        {attempt.summary && (
          <p className="mt-6 whitespace-pre-wrap rounded-md border border-line bg-surface p-4 text-sm leading-relaxed">
            {attempt.summary}
          </p>
        )}

        <h3 className="mt-10 text-sm font-medium text-muted">Session</h3>
        {session.length === 0 ? (
          <p className="mt-3 rounded-md border border-dashed border-line p-6 text-center text-sm text-muted">
            Nothing recorded yet. The agent's prompts, messages and tool calls
            appear here as it works.
          </p>
        ) : (
          <ol className="mt-3 divide-y divide-line rounded-md border border-line">
            {session.map((entry) => (
              <Entry key={entry.seq} entry={entry} />
            ))}
          </ol>
        )}
      </div>

      <aside className="space-y-6">
        <section>
          <h3 className="text-sm font-medium text-muted">Working copy</h3>
          <pre className="mt-2 overflow-x-auto rounded-md border border-line bg-surface p-3 font-mono text-xs">
            git clone {remote}
          </pre>
          <p className="mt-2 text-xs text-muted">
            This fork belongs to the attempt. Pushes to it show up here.
          </p>
        </section>
        {mine && active && (
          <section>
            <h3 className="text-sm font-medium text-muted">
              {attempt.status === "submitted" ? "Update summary" : "Submit"}
            </h3>
            <Form method="post" className="mt-2 space-y-2">
              <Textarea
                name="summary"
                rows={4}
                placeholder="What changed and why"
                defaultValue={attempt.summary ?? ""}
              />
              <div className="flex gap-2">
                <Button type="submit">Submit attempt</Button>
                <Button variant="quiet" type="submit" name="action" value="abandon">
                  Abandon
                </Button>
              </div>
            </Form>
            <ErrorText>{actionData?.error}</ErrorText>
          </section>
        )}
      </aside>
    </div>
  );
}
