import { Box, Lock, Search, Settings } from "lucide-react";
import { useMemo, useState } from "react";
import { Form, Link, data, useNavigation, useSearchParams, type ShouldRevalidateFunctionArgs } from "react-router";

import { RESTORE_DAYS } from "@g1t/contracts";

import type { Route } from "./+types/repositories";
import { page } from "../../lib/meta";
import { ConfirmDialog } from "../../components/repo-lifecycle";
import { Button, EmptyState, ErrorText, TimeAgo, notACredential } from "../../components/ui";
import { Badge } from "../../components/ui/badge";
import { Checkbox } from "../../components/ui/checkbox";
import {
  type BulkResult,
  REPO_FILTERS,
  daysUntil,
  filterCounts,
  filterRepos,
  longDate,
  parseFilter,
  summariseBulk,
} from "../../lib/repo-lifecycle";
import { repos } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Repositories · ${params.owner} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const role = roleIn(viewer, params.owner);
  // Members only; to anyone else the page does not exist.
  if (!role) throw data(null, { status: 404 });
  const owner = role === "owner";
  const [list, deleted] = await Promise.all([
    repos.list(viewer, { namespace: params.owner, memberOnly: true }),
    owner ? repos.deleted(viewer, params.owner) : Promise.resolve([]),
  ]);
  return { repos: list, deleted, owner, slug: params.owner.toLowerCase() };
}

/** Filtering and searching change only the address: the list is already here. */
export function shouldRevalidate({ currentUrl, nextUrl, formMethod, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (!formMethod && currentUrl.pathname === nextUrl.pathname) return false;
  return defaultShouldRevalidate;
}

type Outcome = { intent: string; message: string | null; failures: string[]; error: string | null; name?: string };

export async function action({ request, params, context }: Route.ActionArgs): Promise<Outcome> {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const namespace = params.owner;
  const name = String(form.get("name") ?? "").trim();
  const full = `${namespace}/${name}`;

  if (intent === "archive" || intent === "unarchive") {
    // One at a time, so one refusal does not stop the rest; each says why.
    const names = [...new Set(form.getAll("repo").map(String).filter(Boolean))];
    const results: BulkResult[] = [];
    for (const repo of names) {
      const done = await repos.archive(user, { namespace, name: repo }, intent === "archive");
      results.push(done.ok ? { name: repo, ok: true } : { name: repo, ok: false, error: done.error.message });
    }
    const summary = summariseBulk(results, intent === "archive" ? "archived" : "unarchived");
    return { intent, message: summary.message, failures: summary.failures, error: null };
  }
  if (intent === "restore") {
    const restored = await repos.restore(user, { namespace, name });
    return restored.ok
      ? { intent, name, message: `Restored ${full}. It is back where it was.`, failures: [], error: null }
      : { intent, name, message: null, failures: [], error: restored.error.message };
  }
  if (intent === "purge") {
    const purged = await repos.purge(user, { namespace, name }, String(form.get("confirm") ?? "").trim());
    return purged.ok
      ? { intent, name, message: `Deleted ${full} for good. Its name is free again.`, failures: [], error: null }
      : { intent, name, message: null, failures: [], error: purged.error.message };
  }
  return { intent, message: null, failures: [], error: "Nothing to do." };
}

export default function WorkspaceRepositories({ loaderData, actionData }: Route.ComponentProps) {
  const { repos: list, deleted, owner, slug } = loaderData;
  const [params, setParams] = useSearchParams();
  const filter = parseFilter(params.get("filter"));
  const query = params.get("q") ?? "";
  const shown = useMemo(() => filterRepos(list, filter, query), [list, filter, query]);
  const counts = useMemo(() => filterCounts(list), [list]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const navigation = useNavigation();
  const bulk = navigation.state !== "idle" ? String(navigation.formData?.get("intent") ?? "") : "";
  const justDeleted = params.get("deleted");

  // What is selected and still shown: hidden rows are never acted on.
  const picked = shown.filter((repo) => selected.has(repo.name));
  const all = shown.length > 0 && picked.length === shown.length;
  const toggle = (name: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  const update = (changes: Record<string, string | null>) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("deleted");
        for (const [key, value] of Object.entries(changes)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
  const bulkResult = actionData && (actionData.intent === "archive" || actionData.intent === "unarchive") ? actionData : null;
  const rowResult = actionData && (actionData.intent === "restore" || actionData.intent === "purge") ? actionData : null;

  return (
    <div className="space-y-10">
      {justDeleted && !actionData && (
        <p role="status" className="rounded-lg border border-accent/30 bg-accent/5 px-4 py-2.5 text-sm">
          Deleted <span className="font-mono">{slug}/{justDeleted}</span>. You can restore it below for {RESTORE_DAYS} days.
        </p>
      )}
      {rowResult?.message && (
        <p role="status" className="rounded-lg border border-accent/30 bg-accent/5 px-4 py-2.5 text-sm">
          {rowResult.message}
        </p>
      )}

      <section aria-label="Repositories" className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <nav aria-label="Filter" className="flex flex-wrap gap-1">
            {REPO_FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                aria-pressed={filter === f.value}
                onClick={() => update({ filter: f.value === "all" ? null : f.value })}
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm transition-colors ${
                  filter === f.value ? "bg-raised font-medium text-fg" : "text-muted hover:bg-raised/60 hover:text-fg"
                }`}
              >
                {f.label}
                <span className="text-xs text-faint">{counts[f.value]}</span>
              </button>
            ))}
          </nav>
          <label className="relative block sm:w-64">
            <span className="sr-only">Find a repository</span>
            <Search size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
            <input
              type="search"
              value={query}
              onChange={(event) => update({ q: event.target.value || null })}
              placeholder="Find a repository"
              {...notACredential()}
              className="w-full rounded-md border border-line bg-bg py-1.5 pr-3 pl-8 text-sm outline-none transition-colors placeholder:text-faint hover:border-line-strong focus:border-accent-dim"
            />
          </label>
        </div>

        {owner && shown.length > 0 && (
          <Form method="post" className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2">
            {picked.map((repo) => (
              <input key={repo.name} type="hidden" name="repo" value={repo.name} />
            ))}
            <label className="flex items-center gap-2 text-sm text-muted">
              <Checkbox
                checked={all ? true : picked.length > 0 ? "indeterminate" : false}
                onCheckedChange={(on) =>
                  setSelected(on === true && !all ? new Set(shown.map((r) => r.name)) : new Set())
                }
                aria-label="Select every repository shown"
              />
              {picked.length > 0 ? `${picked.length} selected` : "Select"}
            </label>
            <div className="ml-auto flex gap-2">
              <Button
                type="submit"
                name="intent"
                value="archive"
                variant="quiet"
                disabled={picked.length === 0 || bulk !== ""}
              >
                {bulk === "archive" ? "Archiving…" : "Archive"}
              </Button>
              <Button
                type="submit"
                name="intent"
                value="unarchive"
                variant="quiet"
                disabled={picked.length === 0 || bulk !== ""}
              >
                {bulk === "unarchive" ? "Unarchiving…" : "Unarchive"}
              </Button>
            </div>
          </Form>
        )}
        {bulkResult && (
          <div role="status" className="space-y-1">
            {bulkResult.message && <p className="text-sm text-muted">{bulkResult.message}</p>}
            {bulkResult.failures.map((line) => (
              <ErrorText key={line}>{line}</ErrorText>
            ))}
          </div>
        )}

        {list.length === 0 ? (
          <EmptyState title="No repositories yet">
            A repository is made with each new project, or the first time you push to a new address in {slug}.
          </EmptyState>
        ) : shown.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-sm text-muted">
            No repositories match.{" "}
            <button type="button" className="text-accent hover:underline" onClick={() => update({ filter: null, q: null })}>
              Show them all
            </button>
          </p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {shown.map((repo) => {
              const base = `/${repo.namespace}/${repo.name}`;
              return (
                <li key={repo.id} className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-surface/60">
                  {owner && (
                    <Checkbox
                      className="mt-1"
                      checked={selected.has(repo.name)}
                      onCheckedChange={(on) => toggle(repo.name, on === true)}
                      aria-label={`Select ${repo.name}`}
                    />
                  )}
                  <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-raised text-muted ring-1 ring-line">
                    {repo.isPrivate ? <Lock size={13} /> : <Box size={13} />}
                  </span>
                  <div className="min-w-0 grow">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <Link to={base} prefetch="intent" className="truncate font-mono text-sm font-medium hover:underline">
                        {repo.name}
                      </Link>
                      <Badge>{repo.isPrivate ? "private" : "public"}</Badge>
                      {repo.archivedAt && <Badge tone="warn">archived</Badge>}
                    </div>
                    {repo.description && <p className="mt-0.5 line-clamp-2 text-sm text-muted">{repo.description}</p>}
                    <p className="mt-1 text-xs text-faint">
                      {repo.archivedAt ? (
                        <>
                          Archived <TimeAgo at={repo.archivedAt} />
                        </>
                      ) : (
                        <>
                          Created <TimeAgo at={repo.createdAt} />
                        </>
                      )}
                    </p>
                  </div>
                  <Link
                    to={`${base}/settings/repository`}
                    className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted transition-colors hover:bg-raised hover:text-fg"
                    aria-label={`Settings for ${repo.name}`}
                  >
                    <Settings size={13} />
                    <span className="hidden sm:inline">Settings</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {owner && (
        <section aria-labelledby="recently-deleted" className="space-y-3">
          <div>
            <h2 id="recently-deleted" className="font-medium">
              Recently deleted
            </h2>
            <p className="mt-1 text-sm text-muted">
              Deleted repositories can be restored as they were for {RESTORE_DAYS} days, then they are removed for good.
              Their names stay taken until then. Only owners see this list.
            </p>
          </div>
          {deleted.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-faint">
              Nothing has been deleted in the last {RESTORE_DAYS} days.
            </p>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
              {deleted.map((repo) => {
                const full = `${repo.namespace}/${repo.name}`;
                const restoring =
                  navigation.state !== "idle" &&
                  navigation.formData?.get("intent") === "restore" &&
                  navigation.formData?.get("name") === repo.name;
                const left = daysUntil(repo.purgeAfter);
                return (
                  <li key={repo.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
                    <div className="min-w-0 grow">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="truncate font-mono text-sm font-medium text-muted">
                          {repo.name}
                        </span>
                        <Badge>{repo.isPrivate ? "private" : "public"}</Badge>
                      </div>
                      <p className="mt-1 text-xs text-faint">
                        Deleted by <span className="font-mono text-muted">{repo.deletedBy}</span>{" "}
                        <TimeAgo at={repo.deletedAt} /> · removed for good on {longDate(repo.purgeAfter)}
                        {left <= 7 && ` (${left === 0 ? "today" : left === 1 ? "in a day" : `in ${left} days`})`}
                      </p>
                      {rowResult?.name === repo.name && <ErrorText>{rowResult.error}</ErrorText>}
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Form method="post">
                        <input type="hidden" name="intent" value="restore" />
                        <input type="hidden" name="name" value={repo.name} />
                        <Button type="submit" variant="quiet" disabled={restoring}>
                          {restoring ? "Restoring…" : "Restore"}
                        </Button>
                      </Form>
                      <ConfirmDialog
                        intent="purge"
                        fields={{ name: repo.name }}
                        title={`Delete ${full} permanently?`}
                        description="This cannot be undone."
                        confirm={full}
                        submit="Delete permanently"
                        busy="Deleting…"
                        error={rowResult?.intent === "purge" && rowResult.name === repo.name ? rowResult.error : null}
                        trigger={(open) => (
                          <Button type="button" variant="danger" onClick={open}>
                            Delete permanently
                          </Button>
                        )}
                      >
                        <li>It is removed for good now, its git data with it. It cannot be restored after this.</li>
                        <li>
                          Its name is free at once: a new repository can be made at{" "}
                          <span className="font-mono text-fg">g1t.sh/{full}</span>.
                        </li>
                      </ConfirmDialog>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
