import { ArrowLeft } from "lucide-react";
import { Form, Link, data, redirect } from "react-router";

import { ACCOUNT_RESTORE_DAYS, type AdminUser, securityEventLabel } from "@g1t/contracts";

import type { Route } from "./+types/user";
import { Badge, Button, EmptyState, Field, Input, Notice, PageHeader, Section, When } from "~/components/ui";
import { accountWentSummary, confirmsUsername, staffDeletionRefusal } from "~/lib/deleted-accounts";
import { daysLeft } from "~/lib/deleted-workspaces";
import { text } from "~/lib/forms";
import { accountsAdmin } from "~/lib/services.server";
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
  return {
    user: result.ok ? result.value : null,
    error: result.ok ? null : result.error,
    removed: url.searchParams.get("removed"),
    done: done === "deleted" ? "Deleted the account." : done === "restored" ? "Restored the account." : null,
    now: Date.now(),
  };
}

/**
 * Removes an address (the reason is required, recorded and shown to the
 * person), or deletes, restores or purges the account. Identity checks
 * each again: protection, the workspaces it owns alone, the typed
 * username, the restore window.
 */
export async function action({ params, request, context }: Route.ActionArgs) {
  const staff = requireStaff(context);
  const form = await request.formData();
  const intent = text(form, "intent");
  const back = (done: string) => redirect(`/users/${encodeURIComponent(params.username)}?done=${done}`);
  if (intent === "delete-account") {
    const reason = text(form, "reason");
    const confirm = text(form, "confirm");
    if (!reason) return data({ error: "Say why the account is being deleted.", account: true }, { status: 422 });
    if (!confirmsUsername(params.username, confirm)) {
      return data({ error: `Type ${params.username} to confirm.`, account: true }, { status: 422 });
    }
    const result = await accountsAdmin.deleteAccount(params.username, reason, confirm, staff.email);
    if (!result.ok) return data({ error: result.error.message, account: true }, { status: 422 });
    throw back("deleted");
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
  const { user, error, removed, done, now } = loaderData;
  const accountError = actionData && "account" in actionData ? actionData.error : null;
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

      <AccountSection user={user} error={accountError} now={now} />
    </main>
  );
}

/**
 * Deleting the account, or, once it is deleted, restoring or purging it.
 * Every form is plain HTML: sudo ships no JavaScript.
 */
function AccountSection({ user, error, now }: { user: AdminUser; error: string | null; now: number }) {
  const deleted = user.deleted;
  if (deleted) {
    const left = daysLeft(deleted.purgeAfter, now);
    return (
      <Section
        id="account"
        title="Deleted account"
        description={`Deleted ${deleted.went.staff ? `by ${deleted.went.staff}` : "by the person"}. Kept ${ACCOUNT_RESTORE_DAYS} days for a restore, then purged.`}
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
  return (
    <Section
      id="account"
      title="Delete account"
      description={`Signs it out everywhere, ends its tokens and keys, and takes it out of every workspace. Kept ${ACCOUNT_RESTORE_DAYS} days for a restore, then purged; its username is never given out again. Only when the person asks, or for abuse, with a reason.`}
      className="mt-6"
    >
      {refusal ? (
        <div className="space-y-3 text-sm">
          <Notice tone="warn">{refusal}</Notice>
          {user.deletion.sole_owner_of.length > 0 && (
            <ul className="divide-y divide-line rounded-md border border-line">
              {user.deletion.sole_owner_of.map((workspace) => (
                <li key={workspace.slug} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
                  <Link to={`/workspaces/${workspace.slug}`} className="text-fg hover:underline">
                    {workspace.name} <span className="font-mono text-xs text-muted">{workspace.slug}</span>
                  </Link>
                  <span className="text-xs text-faint">
                    {workspace.members} member{workspace.members === 1 ? "" : "s"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
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
      )}
    </Section>
  );
}
