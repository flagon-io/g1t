import {
  Bot,
  ChevronRight,
  FileDiff,
  GitCommitHorizontal,
  MessagesSquare,
  Rocket,
  StickyNote,
  User,
  Wrench,
} from "lucide-react";
import { useEffect } from "react";
import { Form, Link, useRevalidator } from "react-router";

import type { Comparison, SessionEntry } from "@g1t/contracts";

import type { Route } from "./+types/attempt";
import { DiffView } from "../../components/diff-view";
import { Markdown } from "../../components/markdown";
import {
  Button,
  CopyLine,
  EmptyState,
  ErrorText,
  Status,
  Textarea,
  TimeAgo,
} from "../../components/ui";
import { repos, work } from "../../lib/services.server";
import {
  assertSameOrigin,
  getViewer,
  requireUser,
  unwrap,
} from "../../lib/session.server";

const REFRESH_MS = 4000;
const EMPTY_COMPARISON: Comparison = { base: null, head: "", files: [], truncated: false };

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    {
      title: loaderData
        ? `Attempt ${loaderData.attempt.number} · ${loaderData.intent.title} · g1t`
        : "g1t",
    },
  ];
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const [found, session] = await Promise.all([
    work.getAttempt(params.id, viewer),
    work.readSession(params.id, viewer),
  ]);
  const detail = unwrap(found);
  const repo = await repos.getById(detail.attempt.repoId, viewer);
  const showChanges = new URL(request.url).searchParams.get("tab") === "changes";
  const comparison = showChanges
    ? await repos.compare(
        detail.attempt.forkRepoId,
        viewer,
        detail.attempt.landedBase,
      )
    : null;
  return {
    ...detail,
    // Null on the session tab; an empty comparison if it could not be made.
    comparison: comparison && (comparison.ok ? comparison.value : EMPTY_COMPARISON),
    session: unwrap(session),
    viewer,
    // Only the repository's owner can land an attempt.
    canShip: repo.ok && repo.value.ownerId === viewer?.id,
    defaultBranch: repo.ok ? repo.value.defaultBranch : "main",
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const action = form.get("action");
  const result =
    action === "ship"
      ? await work.shipAttempt(user, params.id)
      : action === "abandon"
        ? await work.abandonAttempt(user, params.id)
        : await work.submitAttempt(
            user,
            params.id,
            String(form.get("summary") ?? ""),
          );
  return result.ok ? null : { error: result.error.message };
}

/** One step of the session, on the timeline's rail. */
function TabLink({
  to,
  active,
  children,
}: {
  to: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      preventScrollReset
      className={
        "-mb-px flex items-center gap-2 border-b-2 px-1 pb-2.5 text-sm transition-colors " +
        (active
          ? "border-accent font-medium text-fg"
          : "border-transparent text-muted hover:text-fg")
      }
    >
      {children}
    </Link>
  );
}

function Entry({ entry, agent }: { entry: SessionEntry; agent: string }) {
  const isTool = entry.kind === "tool_call" || entry.kind === "tool_result";
  const Icon =
    entry.kind === "prompt"
      ? User
      : entry.kind === "note"
        ? StickyNote
        : isTool
          ? Wrench
          : Bot;
  return (
    <li className="relative pl-10">
      <span
        className={`absolute top-0.5 left-0 flex size-7 items-center justify-center rounded-full border bg-bg ${
          entry.kind === "prompt"
            ? "border-accent/50 text-accent"
            : "border-line text-faint"
        }`}
      >
        <Icon size={14} />
      </span>
      {isTool ? (
        <details className="group rounded-lg border border-line bg-surface">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-sm">
            <ChevronRight
              size={14}
              className="text-faint transition-transform group-open:rotate-90"
            />
            <span className="font-mono text-xs text-accent">
              {entry.tool ?? "tool"}
            </span>
            <span className="truncate font-mono text-xs text-muted">
              {entry.kind === "tool_result" ? "→ " : ""}
              {entry.text.split("\n")[0]}
            </span>
          </summary>
          <pre className="overflow-x-auto border-t border-line p-3 font-mono text-xs whitespace-pre-wrap text-muted">
            {entry.text}
          </pre>
        </details>
      ) : (
        <div>
          <p className="text-xs font-medium text-faint">
            {entry.kind === "prompt"
              ? "Prompt"
              : entry.kind === "note"
                ? "Note"
                : agent}
          </p>
          {entry.kind === "message" ? (
            <div className="mt-1">
              <Markdown source={entry.text} />
            </div>
          ) : (
            <p
              className={`mt-1 text-[0.9375rem] leading-relaxed wrap-break-word whitespace-pre-wrap ${
                entry.kind === "prompt" ? "font-medium" : ""
              }`}
            >
              {entry.text}
            </p>
          )}
        </div>
      )}
      {entry.commit && (
        <p className="mt-1.5 flex items-center gap-1 font-mono text-xs text-faint">
          <GitCommitHorizontal size={12} />
          {entry.commit.slice(0, 7)}
        </p>
      )}
    </li>
  );
}

export default function AttemptPage({
  loaderData,
  actionData,
  params,
}: Route.ComponentProps) {
  const { attempt, intent, session, viewer, canShip, defaultBranch, comparison } =
    loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const here = base + "/attempts/" + attempt.id;
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
    <div className="grid gap-8 lg:grid-cols-[1fr_19rem]">
      <div className="min-w-0">
        <p className="text-sm text-muted">
          <Link
            to={`${base}/intents/${intent.number}`}
            className="hover:text-fg hover:underline"
          >
            {intent.title} <span className="text-faint">#{intent.number}</span>
          </Link>
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h2 className="text-2xl font-semibold tracking-tight">
            Attempt {attempt.number}
          </h2>
          <span className="flex items-center gap-1.5 font-mono text-sm text-muted">
            <Bot size={15} />
            {attempt.agent}
          </span>
          <Status value={attempt.status} />
        </div>
        <p className="mt-2 text-sm text-muted">
          Started by{" "}
          <span className="font-medium text-fg">{attempt.startedBy.username}</span>{" "}
          <TimeAgo at={attempt.createdAt} />
        </p>

        {attempt.summary && (
          <section className="mt-6 rounded-xl border border-line bg-surface p-5">
            <h3 className="text-xs font-medium tracking-wide text-faint uppercase">
              Summary
            </h3>
            <div className="mt-2">
              <Markdown source={attempt.summary} />
            </div>
          </section>
        )}

        <nav className="mt-10 flex gap-6 border-b border-line">
          <TabLink to={here} active={!comparison}>
            <MessagesSquare size={15} />
            Session
          </TabLink>
          <TabLink to={here + "?tab=changes"} active={Boolean(comparison)}>
            <FileDiff size={15} />
            Changes
          </TabLink>
        </nav>
        <div className="mt-5">
          {comparison ? (
            <DiffView comparison={comparison} />
          ) : session.length === 0 ? (
            <EmptyState title="Nothing recorded yet">
              The agent's prompts, reasoning and tool calls appear here as it
              works.
            </EmptyState>
          ) : (
            <ol className="relative space-y-5 before:absolute before:top-2 before:bottom-2 before:left-3.25 before:w-px before:bg-line">
              {session.map((entry) => (
                <Entry key={entry.seq} entry={entry} agent={attempt.agent} />
              ))}
            </ol>
          )}
        </div>
      </div>

      <aside className="space-y-6">
        {canShip && active && intent.status === "open" && (
          <section className="rounded-xl border border-accent/30 bg-accent/5 p-4">
            <h3 className="text-sm font-medium">Ship this attempt</h3>
            <p className="mt-1 text-xs text-muted">
              Lands its commits on {defaultBranch} and closes the intent.
            </p>
            <Form method="post" className="mt-3 *:w-full">
              <Button variant="accent" type="submit" name="action" value="ship">
                <Rocket size={15} />
                Ship to {defaultBranch}
              </Button>
            </Form>
            {!(mine && active) && <ErrorText>{actionData?.error}</ErrorText>}
          </section>
        )}
        <section>
          <h3 className="text-sm font-medium">Working copy</h3>
          <p className="mt-1 text-xs text-muted">
            This fork belongs to the attempt. Pushes to it show up here.
          </p>
          <div className="mt-2">
            <CopyLine text={`git clone ${remote}`} />
          </div>
          <p className="mt-3 flex items-center gap-1.5 font-mono text-xs text-faint">
            <GitCommitHorizontal size={13} />
            {attempt.headCommit?.slice(0, 12) ?? "no commits pushed yet"}
          </p>
        </section>

        {mine && active && (
          <section className="rounded-xl border border-line bg-surface p-4">
            <h3 className="text-sm font-medium">
              {attempt.status === "submitted" ? "Update summary" : "Submit"}
            </h3>
            <Form method="post" className="mt-3 space-y-2">
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
