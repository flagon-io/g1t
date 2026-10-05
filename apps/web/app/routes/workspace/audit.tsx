import { Download, Filter } from "lucide-react";
import { Form, Link, data } from "react-router";

import type { Route } from "./+types/audit";
import { page } from "../../lib/meta";
import { AuditTable } from "../../components/audit";
import { Button, ButtonLink, EmptyState, Field, Input } from "../../components/ui";
import { type AuditFilters, filterHref, parseFilters, toQuery } from "../../lib/audit";
import { auditPage, auditRetention } from "../../lib/audit.server";
import { repos } from "../../lib/services.server";
import { requireUser, roleIn } from "../../lib/session.server";

const PAGE_SIZE = 100;

/** Actions worth offering in the filter; any other can be typed. */
const COMMON_ACTIONS = [
  "git.push",
  "git.fetch",
  "create_issue",
  "add_comment",
  "record_session",
  "mark_pull_request_ready",
  "review_pull_request",
  "merge_pull_request",
  "remember",
  "message_agent",
];

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Audit log · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  const workspace = params.owner.toLowerCase();
  const role = roleIn(viewer, workspace);
  if (!role) throw data("Only members of this workspace can read its audit log.", { status: 404 });
  const filters = parseFilters(new URL(request.url).searchParams);
  const { visibility: _, ...query } = toQuery(workspace, { kind: "all" }, filters, PAGE_SIZE);
  const [found, projects, retention] = await Promise.all([
    auditPage(viewer, query),
    repos.list(viewer, { namespace: workspace }).catch(() => []),
    auditRetention(workspace),
  ]);
  return {
    workspace,
    role,
    filters,
    entries: found?.entries ?? [],
    next: found?.next ?? null,
    projects: projects.map((repo) => repo.name),
    retention,
  };
}

function FilterField({
  label,
  name,
  value,
  placeholder,
  list,
}: {
  label: string;
  name: keyof AuditFilters;
  value: string;
  placeholder?: string;
  list?: string;
}) {
  return (
    <Field label={label}>
      <Input name={name} defaultValue={value} placeholder={placeholder} list={list} />
    </Field>
  );
}

const SELECT =
  "w-full rounded-md border border-line bg-bg px-3 py-2 text-sm outline-none transition-colors hover:border-line-strong focus:border-accent-dim";

export default function WorkspaceAudit({ loaderData }: Route.ComponentProps) {
  const { workspace, role, filters, entries, next, projects, retention } = loaderData;
  const base = `/${workspace}/-/audit`;
  const filtered = Object.entries(filters).some(([key, value]) => key !== "before" && value);
  const exportHref = (format: "csv" | "json") => filterHref(`${base}/export`, { ...filters, before: "" }) + `${filtered ? "&" : "?"}format=${format}`;
  return (
    <div>
      <p className="max-w-3xl text-sm text-muted">
        Every action taken with an agent run's credentials, reads included, and every change people and
        workspace tokens make through the API, MCP and git: who did it, on whose behalf, with which
        credential, to what, and whether it was allowed. Refusals name the rule that refused them.
        {role === "owner"
          ? " As an owner you see the whole workspace."
          : " As a member you see what was done to the workspace's projects, and what was done by you or on your behalf."}
        {retention != null &&
          (retention >= 365
            ? ` The log goes back ${retention === 365 ? "a year" : `${retention} days`}, on the Team plan.`
            : ` The log goes back ${retention} days; the Team plan keeps a year.`)}
      </p>

      <Form method="get" className="mt-6 rounded-xl border border-line bg-surface p-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <FilterField label="Actor" name="actor" value={filters.actor} placeholder="A person, or whom an agent worked for" />
          <FilterField label="Agent" name="agent" value={filters.agent} placeholder="g1t-agent" />
          <FilterField label="Action" name="action" value={filters.action} placeholder="git.push" list="audit-actions" />
          <FilterField label="Project" name="project" value={filters.project} placeholder="Any" list="audit-projects" />
          <Field label="Outcome">
            <select name="outcome" defaultValue={filters.outcome} className={SELECT}>
              <option value="">Any</option>
              <option value="allowed">Allowed</option>
              <option value="denied">Denied</option>
            </select>
          </Field>
          <Field label="Who">
            <select name="kind" defaultValue={filters.kind} className={SELECT}>
              <option value="">Anyone</option>
              <option value="agent">Agents</option>
              <option value="person">People</option>
              <option value="workspace">Workspace tokens</option>
            </select>
          </Field>
          <Field label="From">
            <Input type="date" name="from" defaultValue={filters.from} />
          </Field>
          <Field label="To">
            <Input type="date" name="to" defaultValue={filters.to} />
          </Field>
        </div>
        {filters.run && <input type="hidden" name="run" value={filters.run} />}
        <datalist id="audit-actions">
          {COMMON_ACTIONS.map((action) => (
            <option key={action} value={action} />
          ))}
        </datalist>
        <datalist id="audit-projects">
          {projects.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button type="submit">
            <Filter size={14} />
            Filter
          </Button>
          {filtered && (
            <Link to={base} className="text-sm text-muted hover:text-fg">
              Clear filters
            </Link>
          )}
          {filters.run && (
            <span className="font-mono text-xs text-muted">
              Run {filters.run}
            </span>
          )}
          <span className="grow" />
          <ButtonLink variant="quiet" to={exportHref("csv")} reloadDocument>
            <Download size={14} />
            CSV
          </ButtonLink>
          <ButtonLink variant="quiet" to={exportHref("json")} reloadDocument>
            <Download size={14} />
            JSON
          </ButtonLink>
        </div>
      </Form>

      <div className="mt-6">
        {entries.length === 0 ? (
          <EmptyState title={filtered ? "Nothing matches these filters" : "Nothing recorded yet"}>
            {filtered
              ? "Try a wider time range, or clear the filters."
              : "Entries appear as agents work and as people change things through the API, MCP and git."}
          </EmptyState>
        ) : (
          <AuditTable entries={entries} base={base} />
        )}
      </div>

      {(next || filters.before) && (
        <div className="mt-4 flex gap-4 text-sm">
          {filters.before && (
            <Link to={filterHref(base, { ...filters, before: "" })} className="text-muted hover:text-fg">
              Newest
            </Link>
          )}
          {next && (
            <Link to={filterHref(base, filters, { before: next })} className="text-muted hover:text-fg">
              Older
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
