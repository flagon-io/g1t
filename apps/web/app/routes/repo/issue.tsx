import { env } from "cloudflare:workers";
import { Bot, GitCommitHorizontal, GitMerge, Play, Sparkles, Terminal } from "lucide-react";
import { useEffect } from "react";
import { Form, Link, redirect, useNavigation, useRevalidator } from "react-router";

import type { Pull } from "@g1t/contracts";

import type { Route } from "./+types/issue";
import { Markdown } from "../../components/markdown";
import {
  Avatar,
  Button,
  CopyLine,
  EmptyState,
  ErrorText,
  Input,
  Textarea,
  TimeAgo,
} from "../../components/ui";
import { Comments, IssueState, Label, PullIcon } from "../../components/work";
import { work } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser } from "../../lib/session.server";

const REFRESH_MS = 4000;

export function meta({ loaderData, params }: Route.MetaArgs) {
  const title = loaderData ? `${loaderData.issue.title} · Issue #${loaderData.issue.number} · ` : "";
  return [{ title: `${title}${params.owner}/${params.repo} · g1t` }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const path = { namespace: params.owner, name: params.repo };
  const number = Number(params.number);
  const found = await work.getIssue(path, number, viewer);
  if (!found.ok) {
    // Issues and pull requests share numbers; this one may be a pull request.
    const pull = await work.getPull(path, number, viewer);
    if (pull.ok) throw redirect(`/${params.owner}/${params.repo}/pull/${number}`);
    throw new Response("Issue not found.", { status: 404 });
  }
  const [labels, agentModels] = await Promise.all([
    work.listLabels(path, viewer),
    env.RUNNER.models(viewer),
  ]);
  const { issue } = found.value;
  return {
    ...found.value,
    viewer,
    labels: labels.ok ? labels.value : [],
    agentModels,
    // The author and members of the workspace can change an issue.
    canManage:
      viewer != null &&
      (viewer.id === issue.author.id ||
        (viewer.workspaces ?? []).some((membership) => membership.slug === params.owner)),
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const path = { namespace: params.owner, name: params.repo };
  const number = Number(params.number);

  switch (form.get("action")) {
    case "run-hosted": {
      const result = await env.RUNNER.run(user, path, number, {
        count: Number(form.get("count")),
        instructions: String(form.get("instructions") ?? ""),
        model: String(form.get("model") ?? "") || undefined,
      });
      return result.ok ? null : { error: result.error.message };
    }
    case "open-pull": {
      const result = await work.openPull(user, path, {
        issue: number,
        agent: String(form.get("agent") ?? ""),
        runtime: "external",
      });
      if (!result.ok) return { error: result.error.message };
      throw redirect(`/${params.owner}/${params.repo}/pull/${result.value.number}`);
    }
    case "comment": {
      const result = await work.addComment(user, path, number, String(form.get("body") ?? ""));
      return result.ok ? null : { error: result.error.message };
    }
    case "labels": {
      const result = await work.updateIssue(user, path, number, {
        labels: [
          ...form.getAll("label").map(String),
          ...String(form.get("labels") ?? "").split(","),
        ],
      });
      return result.ok ? null : { error: result.error.message };
    }
    case "reopen": {
      const result = await work.reopenIssue(user, path, number);
      return result.ok ? null : { error: result.error.message };
    }
    default: {
      const result = await work.closeIssue(
        user,
        path,
        number,
        form.get("action") === "close-not-planned" ? "not_planned" : "completed",
      );
      return result.ok ? null : { error: result.error.message };
    }
  }
}

/** What became of a pull request, in a few words. */
function outcome(pull: Pull): string {
  if (pull.status === "merged") return `Merged by ${pull.mergedBy ?? "someone"}`;
  if (pull.supersededBy != null) return `Closed · #${pull.supersededBy} was merged instead`;
  if (pull.status === "closed") return "Closed without merging";
  if (pull.status === "draft") return "Draft · in progress";
  return "Ready for review";
}

function PullRow({ pull, base }: { pull: Pull; base: string }) {
  const merged = pull.status === "merged";
  return (
    <li>
      <Link
        to={`${base}/pull/${pull.number}`}
        className={`block rounded-xl border p-4 transition-colors ${
          merged
            ? "border-merged/40 bg-merged/5 hover:border-merged/70"
            : "border-line bg-surface hover:border-line-strong"
        } ${pull.status === "closed" ? "opacity-70" : ""}`}
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <PullIcon status={pull.status} />
          <span className="font-medium">
            {pull.title} <span className="font-normal text-faint">#{pull.number}</span>
          </span>
          {pull.status === "draft" && (
            <span className="size-1.5 animate-pulse rounded-full bg-accent" />
          )}
          <span className="ml-auto flex items-center gap-3 text-xs text-faint">
            <span className="flex items-center gap-1 font-mono">
              <GitCommitHorizontal size={13} />
              {pull.headCommit?.slice(0, 7) ?? "no commits"}
            </span>
            <TimeAgo at={pull.updatedAt} />
          </span>
        </div>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
          <span className={merged ? "font-medium text-merged" : ""}>{outcome(pull)}</span>
          <span className="text-faint">·</span>
          <span className="flex items-center gap-1 font-mono">
            <Bot size={12} />
            {pull.agent}
          </span>
          {pull.runtime === "hosted" && <span className="text-faint">on g1t</span>}
          <span className="text-faint">· opened by {pull.author.username}</span>
        </p>
        {pull.body && <p className="mt-2 line-clamp-2 text-sm text-muted">{pull.body}</p>}
      </Link>
    </li>
  );
}

export default function IssuePage({ loaderData, actionData, params }: Route.ComponentProps) {
  const { issue, pulls, comments, viewer, labels, agentModels, canManage } = loaderData;

  // Follow agents at work without a manual reload.
  const revalidator = useRevalidator();
  const navigation = useNavigation();
  const running = pulls.some((pull) => pull.status === "draft");
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") revalidator.revalidate();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [running, revalidator]);

  const starting = navigation.formData?.get("action") === "run-hosted";
  const base = `/${params.owner}/${params.repo}`;
  const open = issue.state === "open";
  const reference = `${params.owner}/${params.repo}#${issue.number}`;
  const resolver = pulls.find((pull) => pull.number === issue.resolvedBy);
  // The merged pull request first, then the ones still in play, then the rest.
  const rank = { merged: 0, open: 1, draft: 2, closed: 3 } as const;
  const ordered = [...pulls].sort(
    (a, b) => rank[a.status] - rank[b.status] || a.number - b.number,
  );

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_19rem]">
      <div className="min-w-0">
        <h2 className="text-2xl font-semibold tracking-tight text-balance">
          {issue.title} <span className="font-normal text-faint">#{issue.number}</span>
        </h2>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted">
          <IssueState issue={issue} />
          <span className="flex items-center gap-2">
            <Avatar name={issue.author.username} size={18} />
            <span>
              <span className="font-medium text-fg">{issue.author.username}</span> opened this{" "}
              <TimeAgo at={issue.createdAt} />
            </span>
          </span>
          {issue.labels.map((name) => (
            <Label key={name} name={name} />
          ))}
        </div>

        {issue.resolvedBy != null && (
          <Link
            to={`${base}/pull/${issue.resolvedBy}`}
            className="mt-5 flex items-center gap-3 rounded-xl border border-merged/40 bg-merged/5 px-4 py-3 text-sm transition-colors hover:border-merged/70"
          >
            <GitMerge size={18} className="shrink-0 text-merged" />
            <span>
              Resolved by{" "}
              <span className="font-medium">
                {resolver?.title ?? "pull request"} #{issue.resolvedBy}
              </span>
              {resolver?.mergedBy && (
                <span className="text-muted">
                  , merged by {resolver.mergedBy}{" "}
                  {resolver.mergedAt && <TimeAgo at={resolver.mergedAt} />}
                </span>
              )}
            </span>
          </Link>
        )}

        {issue.body && (
          <div className="mt-5 rounded-xl border border-line bg-surface p-5">
            <Markdown source={issue.body} />
          </div>
        )}

        <div className="mt-10 flex items-baseline justify-between">
          <h3 className="font-semibold tracking-tight">Pull requests</h3>
          <p className="text-sm text-muted">
            {pulls.length === 0
              ? "None yet"
              : `${pulls.length} for this issue${
                  pulls.some((pull) => pull.status === "merged") ? "" : ", none merged"
                }`}
          </p>
        </div>
        <div className="mt-3">
          {pulls.length === 0 ? (
            <EmptyState title="Nobody has worked on this yet">
              Put g1t agents on it, or point your own agent at{" "}
              <code className="font-mono">{reference}</code>.
            </EmptyState>
          ) : (
            <ol className="space-y-3">
              {ordered.map((pull) => (
                <PullRow key={pull.id} pull={pull} base={base} />
              ))}
            </ol>
          )}
        </div>

        <h3 className="mt-10 font-semibold tracking-tight">Discussion</h3>
        <div className="mt-3">
          <Comments comments={comments} canComment={Boolean(viewer)} />
        </div>
        <div className="mt-2">
          <ErrorText>{actionData?.error}</ErrorText>
        </div>
      </div>

      <aside className="space-y-6">
        {open && agentModels.length > 0 && (
          <section className="rounded-xl border border-accent/30 bg-accent/5 p-4">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              <Sparkles size={15} className="text-accent" />
              Assign g1t agents
            </h3>
            <p className="mt-1 text-xs text-muted">
              Each agent opens its own pull request for this issue and works in
              its own sandbox, in parallel. Merge the one you want.
            </p>
            <Form method="post" className="mt-3 space-y-2">
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
              <Textarea name="instructions" rows={2} placeholder="Extra guidance (optional)" />
              <div className="*:w-full">
                <Button variant="accent" type="submit" disabled={starting}>
                  <Play size={14} />
                  {starting ? "Starting sandboxes…" : "Start"}
                </Button>
              </div>
            </Form>
          </section>
        )}

        {open && (
          <section className="rounded-xl border border-line bg-surface p-4">
            <h3 className="text-sm font-medium">Bring your own agent</h3>
            <p className="mt-1 text-xs text-muted">
              With g1t connected to your agent, ask it to work on this issue.
            </p>
            <div className="mt-3">
              <CopyLine text={reference} />
            </div>
            {viewer ? (
              <Form method="post" className="mt-4 space-y-2 border-t border-line pt-4">
                <input type="hidden" name="action" value="open-pull" />
                <p className="text-xs text-muted">
                  Or open a draft pull request yourself and get a fork to push to.
                </p>
                <Input name="agent" placeholder="Who is working, e.g. claude-code" maxLength={60} />
                <div className="*:w-full">
                  <Button type="submit">Open pull request</Button>
                </div>
                <p className="text-xs text-muted">
                  Already pushed a branch?{" "}
                  <Link
                    to={`${base}/pulls/new?issue=${issue.number}`}
                    className="text-fg underline underline-offset-4"
                  >
                    Open a pull request from it
                  </Link>
                  .
                </p>
              </Form>
            ) : (
              <p className="mt-4 border-t border-line pt-4 text-sm text-muted">
                <Link to="/login" className="text-fg underline underline-offset-4">
                  Sign in
                </Link>{" "}
                to open a pull request.
              </p>
            )}
          </section>
        )}

        {issue.checks.length > 0 && (
          <section>
            <h3 className="text-sm font-medium">Acceptance checks</h3>
            <ul className="mt-2 space-y-1.5">
              {issue.checks.map((check) => (
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

        {canManage && (
          <details className="group">
            <summary className="cursor-pointer list-none text-sm font-medium">
              Labels <span className="text-xs font-normal text-faint group-open:hidden">Edit</span>
            </summary>
            <Form method="post" className="mt-3 space-y-3" key={issue.labels.join()}>
              <input type="hidden" name="action" value="labels" />
              <div className="flex flex-wrap gap-x-3 gap-y-2">
                {labels.map((name) => (
                  <label key={name} className="flex cursor-pointer items-center gap-1.5">
                    <input
                      type="checkbox"
                      name="label"
                      value={name}
                      defaultChecked={issue.labels.includes(name)}
                      className="accent-accent"
                    />
                    <Label name={name} />
                  </label>
                ))}
              </div>
              <Input name="labels" placeholder="New labels, comma separated" />
              <Button variant="quiet" type="submit">
                Save labels
              </Button>
            </Form>
          </details>
        )}

        {canManage && (
          <Form method="post" className="flex flex-wrap gap-2 border-t border-line pt-5">
            {open ? (
              <>
                <Button variant="quiet" type="submit" name="action" value="close-completed">
                  Close issue
                </Button>
                <Button variant="quiet" type="submit" name="action" value="close-not-planned">
                  Close as not planned
                </Button>
              </>
            ) : (
              <Button variant="quiet" type="submit" name="action" value="reopen">
                Reopen issue
              </Button>
            )}
          </Form>
        )}
      </aside>
    </div>
  );
}
