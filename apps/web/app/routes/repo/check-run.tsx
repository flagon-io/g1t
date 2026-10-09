import { AlertTriangle, ArrowUpRight, FileCode2, GitCommitHorizontal, Info, RotateCw, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { Form, Link, redirect } from "react-router";

import type { AnnotationLevel, CheckAnnotation, CommitCheckRun } from "@g1t/contracts";

import type { Route } from "./+types/check-run";
import { CheckStateIcon } from "../../components/commit-checks";
import { Markdown } from "../../components/markdown";
import { EmptyState, ErrorText, SubmitButton, TimeAgo } from "../../components/ui";
import { Hint } from "../../components/ui/hint";
import { accessTo, refusal } from "../../lib/access.server";
import { checkDetail, took } from "../../lib/commit-checks";
import { formatLineHash } from "../../lib/line-anchor";
import { page } from "../../lib/meta";
import { work } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, unwrap } from "../../lib/session.server";

export function meta({ loaderData, params, ...args }: Route.MetaArgs) {
  const name = loaderData?.run.name;
  return page(args, { title: `${name ? `${name} · ` : ""}Checks · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const path = { namespace: params.owner, name: params.repo };
  const [run, annotations, access] = await Promise.all([
    work.getCheckRun(path, params.id, viewer),
    work.checkRunAnnotations(path, params.id, viewer),
    accessTo(context, params),
  ]);
  const found = unwrap(run);
  // A g1t Actions job is shown where its run is, with its log.
  if (found.workflow) throw redirect(found.htmlUrl);
  return {
    run: found,
    annotations: annotations.ok ? annotations.value : [],
    // Pressing its buttons and asking for it again: Write and up.
    canReport: access.can.push,
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const repo = { namespace: params.owner, name: params.repo };
  const form = await request.formData();
  const refused = await refusal(context, params, "push");
  if (refused) return { error: refused };
  const intent = String(form.get("intent"));
  const done =
    intent === "rerequest"
      ? await work.rerequestCheckRun(user, repo, params.id)
      : await work.requestCheckAction(user, repo, params.id, String(form.get("identifier") ?? ""));
  if (!done.ok) return { error: done.error.message };
  return { notice: intent === "rerequest" ? "Asked for it to run again." : "Sent. The reporter takes it from here." };
}

const LEVEL: Record<AnnotationLevel, { icon: ReactNode; word: string }> = {
  failure: { icon: <XCircle size={15} className="mt-0.5 shrink-0 text-danger" />, word: "Failure" },
  warning: { icon: <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warn" />, word: "Warning" },
  notice: { icon: <Info size={15} className="mt-0.5 shrink-0 text-muted" />, word: "Notice" },
};

/** Annotations by file, in the order the files first came up. */
function byFile(annotations: CheckAnnotation[]): [string, CheckAnnotation[]][] {
  const files = new Map<string, CheckAnnotation[]>();
  for (const annotation of annotations) files.set(annotation.path, [...(files.get(annotation.path) ?? []), annotation]);
  return [...files];
}

function lines(annotation: CheckAnnotation): string {
  return annotation.startLine === annotation.endLine ? `Line ${annotation.startLine}` : `Lines ${annotation.startLine}–${annotation.endLine}`;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function Annotations({ run, annotations, base }: { run: CommitCheckRun; annotations: CheckAnnotation[]; base: string }) {
  const counts = (["failure", "warning", "notice"] as const)
    .map((level) => [level, annotations.filter((annotation) => annotation.annotationLevel === level).length] as const)
    .filter(([, count]) => count > 0);
  return (
    <section className="space-y-3">
      <h3 className="flex flex-wrap items-baseline gap-x-3 text-base font-semibold">
        Annotations
        <span className="text-sm font-normal text-muted">
          {counts.map(([level, count]) => `${count} ${LEVEL[level].word.toLowerCase()}${count === 1 ? "" : "s"}`).join(", ")}
        </span>
      </h3>
      {byFile(annotations).map(([path, list]) => (
        <div key={path} className="overflow-hidden rounded-xl border border-line">
          <p className="flex items-center gap-2 border-b border-line bg-surface px-4 py-2.5 text-sm">
            <FileCode2 size={15} className="shrink-0 text-faint" />
            <Link to={`${base}/blob/${run.headSha}/${encodePath(path)}`} className="min-w-0 truncate font-mono text-[0.8125rem] hover:text-accent hover:underline">
              {path}
            </Link>
          </p>
          <ul className="divide-y divide-line">
            {list.map((annotation, index) => (
              <li key={`${annotation.startLine}:${index}`} className="flex gap-3 px-4 py-3 text-sm">
                {LEVEL[annotation.annotationLevel].icon}
                <div className="min-w-0 grow">
                  <p className="flex flex-wrap items-baseline gap-x-2">
                    {annotation.title && <span className="font-medium">{annotation.title}</span>}
                    {annotation.startLine > 0 && (
                      <Link
                        to={`${base}/blob/${run.headSha}/${encodePath(path)}${formatLineHash({ start: annotation.startLine, end: annotation.endLine })}`}
                        className="font-mono text-xs text-muted hover:text-accent hover:underline"
                      >
                        {lines(annotation)}
                      </Link>
                    )}
                  </p>
                  <p className="mt-0.5 whitespace-pre-wrap text-fg-soft">{annotation.message}</p>
                  {annotation.rawDetails && (
                    <details className="mt-1.5">
                      <summary className="cursor-pointer text-xs text-muted hover:text-fg">Details</summary>
                      <pre className="mt-1.5 overflow-x-auto rounded-md bg-bg px-3 py-2 font-mono text-xs text-muted">{annotation.rawDetails}</pre>
                    </details>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

export default function CheckRunPage({ loaderData, actionData, params }: Route.ComponentProps) {
  const { run, annotations, canReport } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const state = run.status !== "completed" ? "pending" : run.conclusion === "success" ? "success" : (run.conclusion ?? "neutral");
  const shownState = state === "timed_out" || state === "action_required" || state === "failure" ? "failure" : state;
  const detail = checkDetail({
    kind: "check_run",
    id: run.id,
    name: run.name,
    state: shownState,
    description: null,
    detailsUrl: run.detailsUrl,
    url: null,
    app: run.app.name,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  });
  const { title, summary, text } = run.output;
  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-xl border border-line bg-surface">
        <div className="flex flex-wrap items-start gap-x-4 gap-y-3 p-4 sm:p-5">
          <span className="mt-1">
            <CheckStateIcon state={shownState} size={22} />
          </span>
          <div className="min-w-0 grow basis-64">
            <p className="text-xs text-faint">
              <Link to={`${base}/commit/${run.headSha}`} className="hover:text-fg">
                Checks
              </Link>{" "}
              · {run.app.name}
            </p>
            <h2 className="mt-1 text-xl font-semibold tracking-tight wrap-break-word">{run.name}</h2>
            <p className="mt-1 text-sm text-muted">
              {detail}
              {run.conclusion && run.conclusion !== "success" && run.conclusion !== "failure" && (
                <span className="text-faint"> · {run.conclusion.replace("_", " ")}</span>
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {run.detailsUrl && (
              <a
                href={run.detailsUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm text-fg/80 hover:border-line-strong hover:text-fg"
              >
                View on {run.app.name}
                <ArrowUpRight size={14} />
              </a>
            )}
            {canReport && (
              <Form method="post">
                <Hint label={`Ask ${run.app.name} to run it again`}>
                  <SubmitButton variant="quiet" name="intent" value="rerequest" pending="Asking…" className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm text-fg/80 hover:border-line-strong hover:text-fg disabled:opacity-50">
                    <RotateCw size={14} />
                    Re-run
                  </SubmitButton>
                </Hint>
              </Form>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line bg-bg/40 px-4 py-3 text-sm text-muted sm:px-5">
          <span className="flex items-center gap-1.5">
            <GitCommitHorizontal size={14} className="text-faint" />
            <Link to={`${base}/commit/${run.headSha}`} className="font-mono text-xs text-fg/80 hover:text-accent hover:underline">
              {run.headSha.slice(0, 7)}
            </Link>
          </span>
          {run.startedAt && (
            <span>
              Started <TimeAgo at={run.startedAt} />
            </span>
          )}
          {run.completedAt && took(run.startedAt, run.completedAt) && <span>Took {took(run.startedAt, run.completedAt)}</span>}
          {run.externalId && <span className="min-w-0 font-mono text-xs break-all text-faint">{run.externalId}</span>}
        </div>
        {run.actions.length > 0 && canReport && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3">
            {run.actions.map((action) => (
              <Form method="post" key={action.identifier}>
                <input type="hidden" name="intent" value="action" />
                <Hint label={action.description}>
                  <SubmitButton variant="quiet" name="identifier" value={action.identifier} pending="Sending…" className="rounded-md border border-line px-3 py-1.5 text-sm text-fg/80 hover:border-line-strong hover:text-fg disabled:opacity-50">
                    {action.label}
                  </SubmitButton>
                </Hint>
              </Form>
            ))}
          </div>
        )}
        {actionData && (
          <div className="border-t border-line px-5 py-2.5">
            {"error" in actionData ? <ErrorText>{actionData.error}</ErrorText> : <p className="text-sm text-success">{actionData.notice}</p>}
          </div>
        )}
      </section>

      {title || summary || text ? (
        <section className="rounded-xl border border-line p-4 sm:p-6">
          {title && <h3 className="mb-3 text-lg font-semibold">{title}</h3>}
          {summary && <Markdown source={summary} repo={{ namespace: params.owner, name: params.repo }} />}
          {text && (
            <div className={summary ? "mt-6 border-t border-line pt-6" : ""}>
              <Markdown source={text} repo={{ namespace: params.owner, name: params.repo }} />
            </div>
          )}
        </section>
      ) : (
        <EmptyState title={run.status === "completed" ? "No report" : "No report yet"}>
          {run.app.name} {run.status === "completed" ? "said nothing more about this run." : "has not said anything more yet."}
        </EmptyState>
      )}

      {annotations.length > 0 && <Annotations run={run} annotations={annotations} base={base} />}
    </div>
  );
}
