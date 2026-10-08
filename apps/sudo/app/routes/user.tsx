import { ArrowLeft } from "lucide-react";
import { Form, Link, data, redirect } from "react-router";

import { ACCOUNT_RESTORE_DAYS, type AdminUser, WORKSPACE_RESTORE_DAYS, securityEventLabel } from "@g1t/contracts";

import type { Route } from "./+types/user";
import { Badge, Button, EmptyState, Field, Input, Notice, PageHeader, Section, When } from "~/components/ui";
import {
  type DeletedWithAccount,
  accountWentSummary,
  confirmsUsername,
  deletedWithAccount,
  soleOwnerNote,
  soleWorkspaceRefusal,
  soleWorkspacesRefusal,
  staffDeleteProblem,
  staffDeletionRefusal,
} from "~/lib/deleted-accounts";
import { confirmsPurge, daysLeft } from "~/lib/deleted-workspaces";
import { text } from "~/lib/forms";
import { accountsAdmin, identity } from "~/lib/services.server";
import { settle } from "~/lib/settle";
import { requireStaff } from "~/lib/staff";

export const meta: Route.MetaFunction = ({ params }) => [
  { title: `${params.username} · sudo` },
  { name: "robots", content: "noindex, nofollow" },
];

export async function loader({ params, request, context }: Route.LoaderArgs) {
  requireStaff(context);
  const result = await settle(accountsAdmin.user(params.username));
  if (result.ok && !result.value) throw data("No such account.", { status: 404 });
  const url = new URL(request.url);
  const done = url.searchParams.get("done");
  const slug = url.searchParams.get("slug") ?? "";
  // The workspaces staff deleted with it, each with its deletion while it
  // waits to be purged.
  const user = result.ok ? result.value : null;
  const went = user?.deleted?.went;
  let workspaces: DeletedWithAccount[] = [];
  let workspacesError: string | null = null;
  if (went && (went.deletedWorkspaces ?? []).length > 0) {
    const deleted = await settle(identity.deletedWorkspaces());
    workspaces = deletedWithAccount(went, deleted.ok ? deleted.value : []);
    workspacesError = deleted.ok ? null : deleted.error;
  }
  const messages: Record<string, string> = {
    deleted: "Deleted the account.",
    "deleted-with-workspaces": "Deleted the account and the workspaces it alone owned.",
    restored: "Restored the account.",
    "workspace-purged": `Purged ${slug}.`,
  };
  return {
    user,
    error: result.ok ? null : result.error,
    removed: url.searchParams.get("removed"),
    done: done ? (messages[done] ?? null) : null,
    workspaces,
    workspacesError,
    now: Date.now(),
  };
}

/**
 * Removes an address (the reason is required, recorded and shown to the
 * person), or deletes, restores or purges the account, or purges a
 * workspace deleted with it. Identity checks each again: protection, the
 * workspaces it owns alone and whether they can go, the typed username or
 * slug, the restore window.
 */
export async function action({ params, request, context }: Route.ActionArgs) {
  const staff = requireStaff(context);
  const form = await request.formData();
  const intent = text(form, "intent");
  const back = (done: string) => redirect(`/users/${encodeURIComponent(params.username)}?done=${done}`);
  if (intent === "delete-account") {
    const reason = text(form, "reason");
    const confirm = text(form, "confirm");
    const withWorkspaces = text(form, "with-workspaces") === "1";
    const problem = staffDeleteProblem({
      username: params.username,
      reason,
      confirm,
      withWorkspaces,
      acknowledged: text(form, "acknowledge") === "on",
    });
    if (problem) return data({ error: problem, account: true }, { status: 422 });
    const result = await accountsAdmin.deleteAccount(params.username, reason, confirm, staff.email, withWorkspaces);
    if (!result.ok) return data({ error: result.error.message, account: true }, { status: 422 });
    throw back(withWorkspaces ? "deleted-with-workspaces" : "deleted");
  }
  if (intent === "purge-workspace") {
    const id = text(form, "id");
    const slug = text(form, "slug");
    const confirm = text(form, "confirm");
    if (!confirmsPurge(slug, confirm)) return data({ error: `Type ${slug} to confirm.`, workspace: id }, { status: 422 });
    const result = await identity.purgeWorkspace(id, staff.email, confirm);
    if (!result.ok) return data({ error: result.error.message, workspace: id }, { status: 422 });
    throw redirect(`/users/${encodeURIComponent(params.username)}?done=workspace-purged&slug=${encodeURIComponent(slug)}`);
  }
  if (intent === "restore-account") {
    const result = await accountsAdmin.restoreAccount(text(form, "id"), staff.email);
    if (!result.ok) return data({ error: result.error.message, account: true }, { status: 422 });
    throw back("restored");
  }
  if (intent === "purge-account") {
    const confirm = text(form, "confirm");
    if (!confirmsUsername(params.username, confirm)) {
      return data({ error: `Type ${params.username} to confirm.`, account: true }, { status: 422 });
    }
    const result = await accountsAdmin.purgeAccount(text(form, "id"), staff.email, confirm);
    if (!result.ok) return data({ error: result.error.message, account: true }, { status: 422 });
    throw redirect(`/users/deleted?done=purged&username=${encodeURIComponent(params.username)}`);
  }
  const email = String(form.get("email") ?? "").trim();
  const reason = String(form.get("reason") ?? "").trim();
  if (!reason) return data({ error: "Say why. The person sees the reason in their security log.", email }, { status: 422 });
  const result = await accountsAdmin.removeEmail(params.username, email, reason, staff.email);
  if (!result.ok) return data({ error: result.error.message, email }, { status: 422 });
  throw redirect(`/users/${encodeURIComponent(params.username)}?removed=${encodeURIComponent(email)}`);
}

export default function User({ loaderData, actionData }: Route.ComponentProps) {
  const { user, error, removed, done, workspaces, workspacesError, now } = loaderData;
  const accountError = actionData && "account" in actionData ? actionData.error : null;
  const workspaceError = actionData && "workspace" in actionData ? { id: actionData.workspace, error: actionData.error } : null;
  if (!user) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-8 sm:py-10">
        <Notice tone="error">Could not load the account: {error}</Notice>
      </main>
    );
  }
  return (
    <main className="mx-auto max-w-4xl px-4 py-8 sm:py-10">
      <Link to="/workspaces" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} /> Workspaces
      </Link>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {user.username}
            {user.deleted && <Badge tone="danger">Deleted</Badge>}
            {user.deletion.protected && <Badge tone="info">Protected</Badge>}
          </span>
        }
        description={
          <>
            Account <span className="font-mono">{user.id}</span>, made <When at={user.createdAt} />.{" "}
            {user.privateEmail ? "Keeps its address private on commits." : "Shows its primary address on commits."}
          </>
        }
      />
      {removed && (
        <div className="mt-5">
          <Notice tone="ok">Removed {removed}. The person was told, with the reason.</Notice>
        </div>
      )}
      {done && (
        <div className="mt-5">
          <Notice tone="ok">{done}</Notice>
        </div>
      )}

      <Section
        id="emails"
        title="Email addresses"
        description="Remove an address someone else needs, or one that is compromised. Never the last confirmed one; removing the primary makes the oldest other confirmed address primary."
        className="mt-6"
      >
        <ul className="divide-y divide-line rounded-md border border-line">
          {user.emails.map((email) => (
            <li key={email.email} className="space-y-3 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-mono break-all">{email.email}</span>
                {email.primary && <Badge tone="lavender">Primary</Badge>}
                {email.backup && <Badge>Backup</Badge>}
                {email.verified ? <Badge tone="mint">Confirmed</Badge> : <Badge tone="warn">Unconfirmed</Badge>}
                <span className="text-xs text-faint">
                  added <When at={email.createdAt} />
                </span>
              </div>
              <Form method="post" className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <input type="hidden" name="email" value={email.email} />
                <div className="grow">
                  <Field label="Reason (the person sees it)">
                    <Input
                      name="reason"
                      required
                      maxLength={200}
                      placeholder="Another account needs this address"
                    />
                  </Field>
                </div>
                <Button variant="danger" type="submit">
                  Remove
                </Button>
              </Form>
              {actionData && "email" in actionData && actionData.email === email.email && actionData.error && <Notice tone="error">{actionData.error}</Notice>}
            </li>
          ))}
        </ul>
      </Section>

      <Section id="log" title="Security log" description="What happened to the account's addresses and password, newest first." className="mt-6">
        {user.log.length === 0 ? (
          <EmptyState title="Nothing yet" />
        ) : (
          <ul className="divide-y divide-line text-sm">
            {user.log.map((event, at) => (
              <li key={`${event.createdAt}:${at}`} className="flex flex-col gap-1 py-2 sm:flex-row sm:justify-between sm:gap-4">
                <span className="min-w-0 break-words">
                  {securityEventLabel(event)}
                  {event.staff && (
                    <span className="text-muted">
                      {" "}
                      · by {event.staff}
                      {event.reason ? `: ${event.reason}` : ""}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-xs text-faint">
                  <When at={event.createdAt} time />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <AccountSection
        user={user}
        error={accountError}
        workspaces={workspaces}
        workspacesError={workspacesError}
        workspaceError={workspaceError}
        now={now}
      />
    </main>
  );
}

/**
 * Deleting the account, or, once it is deleted, restoring or purging it
 * and the workspaces deleted with it. Every form is plain HTML: sudo ships
 * no JavaScript.
 */
function AccountSection({
  user,
  error,
  workspaces,
  workspacesError,
  workspaceError,
  now,
}: {
  user: AdminUser;
  error: string | null;
  workspaces: DeletedWithAccount[];
  workspacesError: string | null;
  workspaceError: { id: string; error: string } | null;
  now: number;
}) {
  const deleted = user.deleted;
  if (deleted) {
    const left = daysLeft(deleted.purgeAfter, now);
    return (
      <Section
        id="account"
        title="Deleted account"
        description={`Deleted ${deleted.went.staff ? `by ${deleted.went.staff}` : "by the person"}. Kept ${ACCOUNT_RESTORE_DAYS} days for a restore, then purged. Staff can purge it now.`}
        className="mt-6"
      >
        <div className="space-y-3 text-sm">
          <p className="flex flex-wrap items-center gap-2 text-muted">
            <span>
              Deleted <When at={deleted.deletedAt} time /> · purged <When at={deleted.purgeAfter} time />
            </span>
            {deleted.restorable ? (
              <Badge tone="warn">
                {left} day{left === 1 ? "" : "s"} left
              </Badge>
            ) : (
              <Badge tone="danger">Being purged</Badge>
            )}
          </p>
          {deleted.went.reason && <p className="text-muted">Reason: {deleted.went.reason}</p>}
          <p className="text-muted">Left: {accountWentSummary(deleted.went)}</p>
          {workspaces.length > 0 && (
            <DeletedWorkspaces workspaces={workspaces} error={workspacesError} workspaceError={workspaceError} now={now} />
          )}
          {error && <Notice tone="error">{error}</Notice>}
          <div className="flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-end sm:justify-between">
            <form method="post">
              <input type="hidden" name="intent" value="restore-account" />
              <input type="hidden" name="id" value={deleted.userId} />
              <Button type="submit" variant="lavender" disabled={!deleted.restorable}>
                Restore
              </Button>
            </form>
            {user.deletion.protected ? (
              <p className="text-muted">Protected: it can never be purged.</p>
            ) : (
              <form method="post" className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <input type="hidden" name="intent" value="purge-account" />
                <input type="hidden" name="id" value={deleted.userId} />
                <label className="grid gap-1 text-xs text-muted">
                  <span>
                    Type <span className="font-mono text-fg">{user.username}</span> to purge it now
                  </span>
                  <Input name="confirm" autoComplete="off" spellCheck={false} className="font-mono" />
                </label>
                <Button type="submit" variant="danger">
                  Purge now
                </Button>
              </form>
            )}
          </div>
        </div>
      </Section>
    );
  }
  const refusal = staffDeletionRefusal(user.deletion);
  const sole = user.deletion.sole_owner_of;
  const blocked = soleWorkspacesRefusal(user.deletion);
  return (
    <Section
      id="account"
      title="Delete account"
      description={`Signs it out everywhere, ends its tokens and keys, and takes it out of every workspace. Kept ${ACCOUNT_RESTORE_DAYS} days for a restore, then purged; its username is never given out again. Only when the person asks, for abuse, or for an account g1t no longer uses, with a reason.`}
      className="mt-6"
    >
      {refusal ? (
        <Notice tone="warn">{refusal}</Notice>
      ) : sole.length === 0 ? (
        <details className="rounded-md border border-danger/30 px-3 py-2" open={Boolean(error)}>
          <summary className="cursor-pointer text-sm text-danger">Delete this account</summary>
          <form method="post" className="mt-3 grid gap-3 sm:max-w-md">
            <input type="hidden" name="intent" value="delete-account" />
            <Field label="Reason (kept in sudo's audit log)">
              <Input name="reason" required maxLength={200} placeholder="The person asked from their primary address" />
            </Field>
            <Field label={`Type ${user.username} to confirm`}>
              <Input name="confirm" required autoComplete="off" spellCheck={false} className="font-mono" />
            </Field>
            {error && <Notice tone="error">{error}</Notice>}
            <div>
              <Button type="submit" variant="danger">
                Delete account
              </Button>
            </div>
          </form>
        </details>
      ) : (
        <div className="space-y-3 text-sm">
          <Notice tone="warn">{soleOwnerNote(user.deletion)}</Notice>
          <ul className="divide-y divide-line rounded-md border border-line">
            {sole.map((workspace) => {
              const why = soleWorkspaceRefusal(workspace);
              return (
                <li key={workspace.slug} className="space-y-1 px-4 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link to={`/workspaces/${workspace.slug}`} className="text-fg hover:underline">
                      {workspace.name} <span className="font-mono text-xs text-muted">{workspace.slug}</span>
                    </Link>
                    <span className="flex flex-wrap items-center gap-1.5 text-xs text-faint">
                      {workspace.protected && <Badge tone="info">Protected</Badge>}
                      {!workspace.protected && workspace.billing && <Badge tone="danger">Billing</Badge>}
                      {workspace.members} member{workspace.members === 1 ? "" : "s"}
                    </span>
                  </div>
                  {why && <p className="text-xs text-danger">{why}</p>}
                </li>
              );
            })}
          </ul>
          {blocked ? (
            <>
              <Notice tone="error">{blocked}</Notice>
              {error && <Notice tone="error">{error}</Notice>}
            </>
          ) : (
            <details className="rounded-md border border-danger/30 px-3 py-2" open={Boolean(error)}>
              <summary className="cursor-pointer text-sm text-danger">Delete account and the workspaces it alone owns</summary>
              <form method="post" className="mt-3 grid gap-3 sm:max-w-md">
                <input type="hidden" name="intent" value="delete-account" />
                <input type="hidden" name="with-workspaces" value="1" />
                <p className="text-muted">
                  Deletes {sole.map((workspace) => workspace.slug).join(", ")} first, each as its owner would (billing closes it, its
                  repositories go with it, kept {WORKSPACE_RESTORE_DAYS} days for a restore), then the account. If a workspace cannot go,
                  the account is not deleted.
                </p>
                <Field label="Reason (kept in sudo's audit log)">
                  <Input name="reason" required maxLength={200} placeholder="Retired test account" />
                </Field>
                <Field label={`Type ${user.username} to confirm`}>
                  <Input name="confirm" required autoComplete="off" spellCheck={false} className="font-mono" />
                </Field>
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" name="acknowledge" required className="mt-0.5 accent-[var(--g1t-accent)]" />
                  <span>
                    {sole.length === 1 ? (
                      <>
                        The workspace <span className="font-mono">{sole[0].slug}</span> is deleted too, with everything in it.
                      </>
                    ) : (
                      <>
                        The {sole.length} workspaces <span className="font-mono">{sole.map((workspace) => workspace.slug).join(", ")}</span> are
                        deleted too, with everything in them.
                      </>
                    )}
                  </span>
                </label>
                {error && <Notice tone="error">{error}</Notice>}
                <div>
                  <Button type="submit" variant="danger">
                    Delete account and {sole.length === 1 ? "its workspace" : `its ${sole.length} workspaces`}
                  </Button>
                </div>
              </form>
            </details>
          )}
        </div>
      )}
    </Section>
  );
}

/**
 * The workspaces staff deleted with the account: each waiting to be purged
 * can be purged now (identity purges only a workspace still deleted), or
 * restored from Deleted workspaces.
 */
function DeletedWorkspaces({
  workspaces,
  error,
  workspaceError,
  now,
}: {
  workspaces: DeletedWithAccount[];
  error: string | null;
  workspaceError: { id: string; error: string } | null;
  now: number;
}) {
  return (
    <div className="space-y-2 border-t border-line pt-4">
      <p className="text-fg">Workspaces deleted with it</p>
      <p className="text-muted">
        Purge them before the account if they should go now: once the account is purged, this page is gone (they stay on{" "}
        <Link to="/workspaces/deleted" className="text-fg hover:underline">
          Deleted workspaces
        </Link>
        ). To undo it all, restore the account first, then each workspace, so it comes back with its owner.
      </p>
      {error && <Notice tone="error">Could not load deleted workspaces: {error}</Notice>}
      <ul className="divide-y divide-line rounded-md border border-line">
        {workspaces.map((workspace) => {
          const waiting = workspace.deleted;
          const left = waiting ? daysLeft(waiting.purgeAfter, now) : 0;
          return (
            <li key={workspace.workspaceId} className="space-y-2 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono">{workspace.slug}</span>
                {waiting ? (
                  waiting.restorable ? (
                    <Badge tone="warn">
                      {left} day{left === 1 ? "" : "s"} left
                    </Badge>
                  ) : (
                    <Badge tone="danger">Being purged</Badge>
                  )
                ) : (
                  <Badge>Purged or restored</Badge>
                )}
              </div>
              {waiting &&
                (waiting.went.protected ? (
                  <p className="text-xs text-muted">Protected: it can never be purged.</p>
                ) : (
                  <form method="post" className="flex flex-col gap-2 sm:flex-row sm:items-end">
                    <input type="hidden" name="intent" value="purge-workspace" />
                    <input type="hidden" name="id" value={workspace.workspaceId} />
                    <input type="hidden" name="slug" value={workspace.slug} />
                    <label className="grid gap-1 text-xs text-muted">
                      <span>
                        Type <span className="font-mono text-fg">{workspace.slug}</span> to purge it now
                      </span>
                      <Input name="confirm" autoComplete="off" spellCheck={false} className="font-mono" />
                    </label>
                    <Button type="submit" variant="danger">
                      Purge now
                    </Button>
                  </form>
                ))}
              {workspaceError && workspaceError.id === workspace.workspaceId && <Notice tone="error">{workspaceError.error}</Notice>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
