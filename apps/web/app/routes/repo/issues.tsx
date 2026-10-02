import { GitPullRequest, MessageSquare, Plus, X } from "lucide-react";
import { Link } from "react-router";

import type { Route } from "./+types/issues";
import { ButtonLink, EmptyState, TimeAgo } from "../../components/ui";
import { IssueIcon, Label, StateTabs } from "../../components/work";
import { work } from "../../lib/services.server";
import { getViewer, unwrap } from "../../lib/session.server";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `Issues · ${params.owner}/${params.repo} · g1t` }];
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const path = { namespace: params.owner, name: params.repo };
  const query = new URL(request.url).searchParams;
  const state = query.get("state") === "closed" ? "closed" : "open";
  const label = query.get("label") ?? "";
  const [issues, labels] = await Promise.all([
    work.listIssues(path, viewer, { state, label: label || undefined }),
    work.listLabels(path, viewer),
  ]);
  return { issues: unwrap(issues), labels: unwrap(labels), state, label } as const;
}

export default function Issues({ loaderData, params }: Route.ComponentProps) {
  const { issues, labels, state, label } = loaderData;
  const repo = `/${params.owner}/${params.repo}`;
  const base = `${repo}/issues`;
  const stateQuery = state === "closed" ? "state=closed" : "";
  return (
    <div>
      <StateTabs
        to={base}
        state={state}
        query={label ? `label=${encodeURIComponent(label)}` : ""}
        action={
          <ButtonLink to={`${base}/new`}>
            <Plus size={15} />
            New issue
          </ButtonLink>
        }
      />
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {labels.map((name) => {
          const active = name === label;
          const query = [stateQuery, active ? "" : `label=${encodeURIComponent(name)}`]
            .filter(Boolean)
            .join("&");
          return (
            <Link
              key={name}
              to={`${base}?${query}`}
              className={`flex items-center gap-1 rounded-full transition-opacity ${
                label && !active ? "opacity-45 hover:opacity-100" : ""
              }`}
            >
              <Label name={name} />
              {active && <X size={12} className="text-muted" />}
            </Link>
          );
        })}
      </div>
      <div className="mt-4">
        {issues.length === 0 ? (
          <EmptyState
            title={
              label
                ? `No ${state} issues labelled ${label}`
                : state === "open"
                  ? "No open issues"
                  : "No closed issues"
            }
          >
            An issue says what should change: a bug, a feature, a question.
            Agents and people open pull requests against it.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {issues.map((issue) => (
              <li key={issue.id}>
                <Link
                  to={`${base}/${issue.number}`}
                  className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-surface"
                >
                  <span className="mt-0.5">
                    <IssueIcon issue={issue} />
                  </span>
                  <span className="min-w-0 grow">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-medium">{issue.title}</span>
                      {issue.labels.map((name) => (
                        <Label key={name} name={name} />
                      ))}
                    </span>
                    <span className="mt-0.5 block text-xs text-faint">
                      #{issue.number} opened <TimeAgo at={issue.createdAt} /> by{" "}
                      {issue.author.username}
                      {issue.resolvedBy != null && (
                        <span className="text-merged"> · resolved by #{issue.resolvedBy}</span>
                      )}
                    </span>
                  </span>
                  <span className="mt-0.5 flex shrink-0 items-center gap-3 text-xs text-muted">
                    {issue.pullCount > 0 && (
                      <span
                        className="flex items-center gap-1"
                        title={`${issue.pullCount} pull ${issue.pullCount === 1 ? "request" : "requests"}`}
                      >
                        <GitPullRequest size={13} />
                        {issue.pullCount}
                      </span>
                    )}
                    {issue.commentCount > 0 && (
                      <span className="flex items-center gap-1">
                        <MessageSquare size={13} />
                        {issue.commentCount}
                      </span>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
