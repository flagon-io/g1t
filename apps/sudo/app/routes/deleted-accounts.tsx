import { ArrowLeft } from "lucide-react";
import { Link, data, redirect } from "react-router";

import { ACCOUNT_RESTORE_DAYS, type DeletedAccount } from "@g1t/contracts";

import type { Route } from "./+types/deleted-accounts";
import { Badge, Button, EmptyState, Input, Notice, PageHeader, When } from "~/components/ui";
import { accountWentSummary, confirmsUsername } from "~/lib/deleted-accounts";
import { daysLeft } from "~/lib/deleted-workspaces";
import { text } from "~/lib/forms";
import { accountsAdmin } from "~/lib/services.server";
import { settle } from "~/lib/settle";
import { requireStaff } from "~/lib/staff";

export const meta: Route.MetaFunction = () => [
  { title: "Deleted accounts · sudo" },
  { name: "robots", content: "noindex, nofollow" },
];

export async function loader({ request, context }: Route.LoaderArgs) {
  requireStaff(context);
  const url = new URL(request.url);
  const deleted = await settle(accountsAdmin.deletedAccounts());
  const done = url.searchParams.get("done");
  const username = url.searchParams.get("username") ?? "";
  return {
    accounts: deleted.ok ? deleted.value : [],
    error: deleted.ok ? null : deleted.error,
    done: done === "restored" ? `Restored ${username}.` : done === "purged" ? `Purged ${username}.` : null,
    now: Date.now(),
  };
}

/**
 * Restoring and purging. Identity checks the window, the typed username
 * and protection again, and records each in sudo's audit log naming the
 * staff member.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const staff = requireStaff(context);
  const form = await request.formData();
  const id = text(form, "id");
  const username = text(form, "username");
  const back = (done: string) => redirect(`/users/deleted?done=${done}&username=${encodeURIComponent(username)}`);
  switch (text(form, "intent")) {
    case "restore": {
      const result = await accountsAdmin.restoreAccount(id, staff.email);
      if (!result.ok) return data({ error: result.error.message, id }, { status: 422 });
      throw back("restored");
    }
    case "purge": {
      const confirm = text(form, "confirm");
      if (!confirmsUsername(username, confirm)) return data({ error: `Type ${username} to confirm.`, id }, { status: 422 });
      const result = await accountsAdmin.purgeAccount(id, staff.email, confirm);
      if (!result.ok) return data({ error: result.error.message, id }, { status: 422 });
      throw back("purged");
    }
  }
  return data({ error: "Unknown action.", id }, { status: 400 });
}

export default function DeletedAccounts({ loaderData, actionData }: Route.ComponentProps) {
  const { accounts, error, done, now } = loaderData;
  const errorFor = (id: string) => (actionData && "id" in actionData && actionData.id === id ? actionData.error : null);
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:py-10">
      <Link to="/workspaces" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} />
        Workspaces
      </Link>
      <div className="mt-4">
        <PageHeader
          title="Deleted accounts"
          description={`Accounts deleted by the person or by staff. Each is kept for ${ACCOUNT_RESTORE_DAYS} days: restore one the person asks back, after checking they own one of its addresses. Then it is purged for good, and its username is never given out again.`}
        />
      </div>
      <div className="mt-6 space-y-3">
        {done && <Notice tone="ok">{done}</Notice>}
        {error && <Notice tone="error">Identity did not answer: {error}</Notice>}
      </div>
      {accounts.length === 0 ? (
        <div className="mt-6">
          <EmptyState title="No deleted accounts">Accounts appear here when they are deleted, until they are purged.</EmptyState>
        </div>
      ) : (
        <ul className="mt-6 space-y-3">
          {accounts.map((account) => (
            <DeletedRow key={account.userId} account={account} now={now} error={errorFor(account.userId)} />
          ))}
        </ul>
      )}
    </main>
  );
}

function DeletedRow({ account, now, error }: { account: DeletedAccount; now: number; error: string | null }) {
  const left = daysLeft(account.purgeAfter, now);
  return (
    <li className="rounded-lg border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">
            <Link to={`/users/${account.username}`} className="font-mono hover:underline">
              {account.username}
            </Link>
          </p>
          <p className="mt-1 text-sm text-muted">
            Deleted by <span className="text-fg-soft">{account.went.staff ?? "the person"}</span>{" "}
            <When at={account.deletedAt} time />
            {" · "}purged <When at={account.purgeAfter} time />
          </p>
          {account.went.reason && <p className="mt-1 text-sm text-muted">Reason: {account.went.reason}</p>}
          <p className="mt-1 text-sm text-muted">Left: {accountWentSummary(account.went)}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {account.restorable ? (
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
          <input type="hidden" name="id" value={account.userId} />
          <input type="hidden" name="username" value={account.username} />
          <Button type="submit" variant="lavender" disabled={!account.restorable}>
            Restore
          </Button>
        </form>
        <form method="post" className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <input type="hidden" name="intent" value="purge" />
          <input type="hidden" name="id" value={account.userId} />
          <input type="hidden" name="username" value={account.username} />
          <label className="grid gap-1 text-xs text-muted">
            <span>
              Type <span className="font-mono text-fg">{account.username}</span> to purge it now
            </span>
            <Input name="confirm" autoComplete="off" spellCheck={false} className="font-mono" aria-label={`Type ${account.username} to purge it now`} />
          </label>
          <Button type="submit" variant="danger">
            Purge now
          </Button>
        </form>
      </div>
    </li>
  );
}
