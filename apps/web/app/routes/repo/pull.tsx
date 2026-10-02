import {
  Bot,
  ChevronRight,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  MessageSquare,
  MessagesSquare,
  StickyNote,
  User,
  Wrench,
} from "lucide-react";
import { useEffect } from "react";
import { Form, Link, redirect, useRevalidator } from "react-router";

import { type Comparison, type SessionEntry, pullComparison } from "@g1t/contracts";

import type { Route } from "./+types/pull";
import { DiffView } from "../../components/diff-view";
import { Markdown } from "../../components/markdown";
import {
  Avatar,
  Button,
  CopyLine,
  EmptyState,
  ErrorText,
  Textarea,
  TimeAgo,
} from "../../components/ui";
import { Comments, IssueIcon, PullState } from "../../components/work";
import { repos, work } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser } from "../../lib/session.server";

const REFRESH_MS = 4000;
const EMPTY_COMPARISON: Comparison = { base: null, head: "", files: [], truncated: false };
const TABS = ["conversation", "session", "changes"] as const;
type Tab = (typeof TABS)[number];

export function meta({ loaderData, params }: Route.MetaArgs) {
  const title = loaderData
    ? `${loaderData.pull.title} · Pull request #${loaderData.pull.number} · `
    : "";
  return [{ title: `${title}${params.owner}/${params.repo} · g1t` }];
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const path = { namespace: params.owner, name: params.repo };
  const number = Number(params.number);
  const asked = new URL(request.url).searchParams.get("tab");
  const tab: Tab = TABS.find((name) => name === asked) ?? "conversation";

  const [found, repo] = await Promise.all([
    work.getPull(path, number, viewer),
    repos.get(path, viewer),
  ]);
  if (!found.ok) {
    // Issues and pull requests share numbers; this one may be an issue.
    const issue = await work.getIssue(path, number, viewer);
    if (issue.ok) throw redirect(`/${params.owner}/${params.repo}/issues/${number}`);
    throw new Response("Pull request not found.", { status: 404 });
  }
  const { pull } = found.value;
  const range = pullComparison(pull);
  const [session, comparison] = await Promise.all([
    tab === "session" ? work.readSession(path, number, viewer) : null,
    tab === "changes"
      ? repos.compare(range.repoId, viewer, range.base, range.head)
      : null,
  ]);
  const member = (viewer?.workspaces ?? []).some(
    (membership) => membership.slug === params.owner,
  );
  return {
    ...found.value,
    tab,
    session: session?.ok ? session.value : [],
    // An empty comparison if it could not be made.
    comparison: comparison && (comparison.ok ? comparison.value : EMPTY_COMPARISON),
    viewer,
    // Members of the repository's workspace can merge.
    canMerge: member,
    canManage: member || viewer?.id === pull.author.id,
    defaultBranch: repo.ok ? repo.value.defaultBranch : "main",
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const path = { namespace: params.owner, name: params.repo };
  const number = Number(params.number);
  const action = form.get("action");
  const result =
    action === "merge"
      ? await work.mergePull(user, path, number, form.get("keepIssueOpen") === "on")
      : action === "close"
        ? await work.closePull(user, path, number)
        : action === "comment"
          ? await work.addComment(user, path, number, String(form.get("body") ?? ""))
          : await work.readyPull(user, path, number, String(form.get("summary") ?? ""));
  return result.ok ? null : { error: result.error.message, action };
}

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

/** One step of the session, on the timeline's rail. */
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

export default function PullPage({ loaderData, actionData, params }: Route.ComponentProps) {
  const {
    pull,
    issue,
    comments,
    tab,
    session,
    comparison,
    viewer,
    canMerge,
    canManage,
    defaultBranch,
  } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const here = `${base}/pull/${pull.number}`;
  const remote = pull.fork
    ? `https://g1t.sh/${pull.fork.namespace}/${pull.fork.name}.git`
    : `https://g1t.sh/${params.owner}/${params.repo}.git`;
  const active = pull.status === "draft" || pull.status === "open";

  // Follow an agent at work without a manual reload.
  const revalidator = useRevalidator();
  const working = pull.status === "draft";
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
        <h2 className="text-2xl font-semibold tracking-tight text-balance">
          {pull.title} <span className="font-normal text-faint">#{pull.number}</span>
        </h2>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted">
          <PullState status={pull.status} />
          <span className="flex items-center gap-2">
            <Avatar name={pull.author.username} size={18} />
            <span>
              <span className="font-medium text-fg">{pull.author.username}</span>{" "}
              {pull.status === "merged" ? "merged" : "wants to merge"}
              {pull.branch && (
                <>
                  {" "}
                  <span className="font-mono text-fg">{pull.branch}</span>
                </>
              )}{" "}
              into <span className="font-mono text-fg">{defaultBranch}</span>
            </span>
          </span>
          {/* A pull request from a branch was made by its author, not an agent. */}
          {!pull.branch && (
            <span className="flex items-center gap-1.5 font-mono text-xs">
              <Bot size={14} />
              {pull.agent}
              {pull.runtime === "hosted" && <span className="text-faint">on g1t</span>}
            </span>
          )}
        </div>

        {issue && (
          <Link
            to={`${base}/issues/${issue.number}`}
            className="mt-4 flex items-center gap-2.5 rounded-xl border border-line bg-surface px-4 py-2.5 text-sm transition-colors hover:border-line-strong"
          >
            <IssueIcon issue={issue} />
            <span className="text-muted">
              {pull.status === "merged" && issue.resolvedBy === pull.number
                ? "Resolved"
                : "For issue"}
            </span>
            <span className="truncate font-medium">{issue.title}</span>
            <span className="text-faint">#{issue.number}</span>
            {issue.pullCount > 1 && (
              <span className="ml-auto shrink-0 text-xs text-faint">
                1 of {issue.pullCount} pull requests
              </span>
            )}
          </Link>
        )}

        {pull.status === "merged" && (
          <p className="mt-4 flex items-center gap-2.5 rounded-xl border border-merged/40 bg-merged/5 px-4 py-2.5 text-sm">
            <GitMerge size={16} className="shrink-0 text-merged" />
            <span>
              Merged into <span className="font-mono">{defaultBranch}</span> by{" "}
              <span className="font-medium">{pull.mergedBy}</span>{" "}
              {pull.mergedAt && <TimeAgo at={pull.mergedAt} />}
              {pull.headCommit && (
                <span className="font-mono text-muted"> · {pull.headCommit.slice(0, 7)}</span>
              )}
            </span>
          </p>
        )}
        {pull.supersededBy != null && (
          <p className="mt-4 rounded-xl border border-line bg-surface px-4 py-2.5 text-sm text-muted">
            Closed because{" "}
            <Link
              to={`${base}/pull/${pull.supersededBy}`}
              className="font-medium text-fg hover:underline"
            >
              #{pull.supersededBy}
            </Link>{" "}
            was merged for this issue instead.
          </p>
        )}

        <nav className="mt-8 flex gap-6 border-b border-line">
          <TabLink to={here} active={tab === "conversation"}>
            <MessageSquare size={15} />
            Conversation
          </TabLink>
          <TabLink to={here + "?tab=session"} active={tab === "session"}>
            <MessagesSquare size={15} />
            Session
          </TabLink>
          <TabLink to={here + "?tab=changes"} active={tab === "changes"}>
            <FileDiff size={15} />
            Changes
          </TabLink>
        </nav>
        <div className="mt-5">
          {comparison ? (
            <DiffView comparison={comparison} />
          ) : tab === "session" ? (
            session.length === 0 ? (
              <EmptyState title="Nothing recorded yet">
                The agent's prompts, reasoning and tool calls appear here as it
                works.
              </EmptyState>
            ) : (
              <ol className="relative space-y-5 before:absolute before:top-2 before:bottom-2 before:left-3.25 before:w-px before:bg-line">
                {session.map((entry) => (
                  <Entry key={entry.seq} entry={entry} agent={pull.agent} />
                ))}
              </ol>
            )
          ) : (
            <div className="space-y-4">
              {pull.body ? (
                <section className="rounded-xl border border-line bg-surface p-5">
                  <Markdown source={pull.body} />
                </section>
              ) : (
                <p className="rounded-xl border border-dashed border-line px-5 py-4 text-sm text-muted">
                  {working
                    ? "No description yet. It is written when the pull request is marked ready for review."
                    : "No description."}
                </p>
              )}
              <Comments comments={comments} canComment={Boolean(viewer)} />
              {actionData?.action === "comment" && <ErrorText>{actionData.error}</ErrorText>}
            </div>
          )}
        </div>
      </div>

      <aside className="space-y-6">
        {canMerge && pull.status === "open" && (
          <section className="rounded-xl border border-accent/30 bg-accent/5 p-4">
            <h3 className="text-sm font-medium">Merge this pull request</h3>
            <p className="mt-1 text-xs text-muted">
              Lands its commits on {defaultBranch}.
              {issue?.state === "open" &&
                ` Closes issue #${issue.number}, and any other pull requests still open for it.`}
            </p>
            <Form method="post" className="mt-3 space-y-3">
              {issue?.state === "open" && (
                <label className="flex items-start gap-2 text-xs text-muted">
                  <input type="checkbox" name="keepIssueOpen" className="mt-0.5 accent-accent" />
                  <span>
                    Keep #{issue.number} open. This is only part of the work.
                  </span>
                </label>
              )}
              <div className="*:w-full">
                <Button variant="accent" type="submit" name="action" value="merge">
                  <GitMerge size={15} />
                  Merge into {defaultBranch}
                </Button>
              </div>
            </Form>
            {actionData?.action === "merge" && <ErrorText>{actionData.error}</ErrorText>}
          </section>
        )}

        {canManage && active && (
          <section className="rounded-xl border border-line bg-surface p-4">
            <h3 className="text-sm font-medium">
              {pull.status === "draft" ? "Ready for review" : "Update description"}
            </h3>
            <Form method="post" className="mt-3 space-y-2">
              <Textarea
                name="summary"
                rows={4}
                placeholder="What changed and why"
                defaultValue={pull.body ?? ""}
              />
              <div className="flex flex-wrap gap-2">
                <Button type="submit">
                  {pull.status === "draft" ? "Mark ready" : "Save"}
                </Button>
                <Button variant="quiet" type="submit" name="action" value="close">
                  Close pull request
                </Button>
              </div>
            </Form>
            {actionData && actionData.action !== "merge" && actionData.action !== "comment" && (
              <ErrorText>{actionData.error}</ErrorText>
            )}
          </section>
        )}

        <section>
          <h3 className="text-sm font-medium">Working copy</h3>
          {pull.branch ? (
            <>
              <p className="mt-1 flex items-center gap-1.5 text-xs text-muted">
                <GitBranch size={13} />
                Branch <span className="font-mono text-fg">{pull.branch}</span> of this
                repository. Pushes to it show up here.
              </p>
              <div className="mt-2">
                <CopyLine text={`git clone -b ${pull.branch} ${remote}`} />
              </div>
            </>
          ) : (
            <>
              <p className="mt-1 text-xs text-muted">
                This fork belongs to the pull request. Pushes to it show up here.
              </p>
              <div className="mt-2">
                <CopyLine text={`git clone ${remote}`} />
              </div>
            </>
          )}
          <p className="mt-3 flex items-center gap-1.5 font-mono text-xs text-faint">
            <GitCommitHorizontal size={13} />
            {pull.headCommit?.slice(0, 12) ?? "no commits pushed yet"}
          </p>
        </section>
      </aside>
    </div>
  );
}
