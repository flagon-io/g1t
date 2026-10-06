import { ArrowLeft } from "lucide-react";
import { Link, data, redirect } from "react-router";

import { WORKSPACE_RESTORE_DAYS, type DeletedWorkspace } from "@g1t/contracts";

import type { Route } from "./+types/deleted-workspaces";
import { Badge, Button, EmptyState, Input, Notice, PageHeader, When } from "~/components/ui";
import { confirmsPurge, daysLeft, wentSummary } from "~/lib/deleted-workspaces";
import { text } from "~/lib/forms";
import { identity } from "~/lib/services.server";
import { settle } from "~/lib/settle";
import { requireStaff } from "~/lib/staff";

export const meta: Route.MetaFunction = () => [
  { title: "Deleted workspaces · sudo" },
  { name: "robots", content: "noindex, nofollow" },
];

export async function loader({ request, context }: Route.LoaderArgs) {
  requireStaff(context);
  const url = new URL(request.url);
  const deleted = await settle(identity.deletedWorkspaces());
  const done = url.searchParams.get("done");
  const slug = url.searchParams.get("slug") ?? "";
  return {
    workspaces: deleted.ok ? deleted.value : [],
    error: deleted.ok ? null : deleted.error,
    done: done === "restored" ? `Restored ${slug}.` : done === "purged" ? `Purged ${slug}.` : null,
    now: Date.now(),
  };
}

/**
 * Restoring and purging. Identity checks the window, the typed slug and
 * protection again, and records each in the workspace's audit log and in
 * sudo's, naming the staff member.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const staff = requireStaff(context);
  const form = await request.formData();
  const id = text(form, "id");
  const slug = text(form, "slug");
  const back = (done: string) => redirect(`/workspaces/deleted?done=${done}&slug=${encodeURIComponent(slug)}`);
  switch (text(form, "intent")) {
    case "restore": {
      const result = await identity.restoreWorkspace(id, staff.email);
      if (!result.ok) return data({ error: result.error.message, id }, { status: 422 });
      throw back("restored");
    }
    case "purge": {
      const confirm = text(form, "confirm");
      if (!confirmsPurge(slug, confirm)) return data({ error: `Type ${slug} to confirm.`, id }, { status: 422 });
      const result = await identity.purgeWorkspace(id, staff.email, confirm);
      if (!result.ok) return data({ error: result.error.message, id }, { status: 422 });
      throw back("purged");
    }
  }
  return data({ error: "Unknown action.", id }, { status: 400 });
}

export default function DeletedWorkspaces({ loaderData, actionData }: Route.ComponentProps) {
  const { workspaces, error, done, now } = loaderData;
  const errorFor = (id: string) => (actionData && "id" in actionData && actionData.id === id ? actionData.error : null);
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:py-10">
      <Link to="/workspaces" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} />
        Workspaces
      </Link>
      <div className="mt-4">
        <PageHeader
          title="Deleted workspaces"
          description={`Workspaces their owners deleted, with everything in them. Each is kept for ${WORKSPACE_RESTORE_DAYS} days: restore one an owner asks back, as after a deletion they did not mean or did not make. Then it is purged for good.`}
        />
      </div>
      <div className="mt-6 space-y-3">
        {done && <Notice tone="ok">{done}</Notice>}
        {error && <Notice tone="error">Identity did not answer: {error}</Notice>}
      </div>
      {workspaces.length === 0 ? (
        <div className="mt-6">
          <EmptyState title="No deleted workspaces">Workspaces appear here when an owner deletes one, until they are purged.</EmptyState>
        </div>
      ) : (
        <ul className="mt-6 space-y-3">
          {workspaces.map((workspace) => (
            <DeletedRow key={workspace.workspaceId} workspace={workspace} now={now} error={errorFor(workspace.workspaceId)} />
          ))}
        </ul>
      )}
    </main>
  );
}

function DeletedRow({ workspace, now, error }: { workspace: DeletedWorkspace; now: number; error: string | null }) {
  const left = daysLeft(workspace.purgeAfter, now);
  return (
    <li className="rounded-lg border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">
            {workspace.name} <span className="font-mono text-sm text-muted">{workspace.slug}</span>
          </p>
          <p className="mt-1 text-sm text-muted">
            Deleted by <span className="text-fg-soft">{workspace.deletedBy || "an owner"}</span> <When at={workspace.deletedAt} time />
            {" · "}purged <When at={workspace.purgeAfter} time />
          </p>
          <p className="mt-1 text-sm text-muted">Went with it: {wentSummary(workspace.went)}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {workspace.went.protected && <Badge tone="info">Protected</Badge>}
          {workspace.restorable ? (
            <Badge tone="warn">
              {left} day{left === 1 ? "" : "s"} left
            </Badge>
          ) : (
            <Badge tone="danger">Being purged</Badge>
          )}
        </div>
      </div>
      {error && (
        <div className="mt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-end sm:justify-between">
        <form method="post">
          <input type="hidden" name="intent" value="restore" />
          <input type="hidden" name="id" value={workspace.workspaceId} />
          <input type="hidden" name="slug" value={workspace.slug} />
          <Button type="submit" variant="lavender" disabled={!workspace.restorable}>
            Restore
          </Button>
        </form>
        {workspace.went.protected ? (
          <p className="text-sm text-muted">Protected: it can never be purged.</p>
        ) : (
          <form method="post" className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <input type="hidden" name="intent" value="purge" />
            <input type="hidden" name="id" value={workspace.workspaceId} />
            <input type="hidden" name="slug" value={workspace.slug} />
            <label className="grid gap-1 text-xs text-muted">
              <span>
                Type <span className="font-mono text-fg">{workspace.slug}</span> to purge it now
              </span>
              <Input name="confirm" autoComplete="off" spellCheck={false} className="font-mono" aria-label={`Type ${workspace.slug} to purge it now`} />
            </label>
            <Button type="submit" variant="danger">
              Purge now
            </Button>
          </form>
        )}
      </div>
    </li>
  );
}
