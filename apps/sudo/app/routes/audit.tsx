import { ChevronRight, UserRound } from "lucide-react";
import { Link } from "react-router";

import type { AdminAction } from "@g1t/contracts";

import type { Route } from "./+types/audit";
import { Button, EmptyState, Input, Notice, PageHeader, Select, When } from "~/components/ui";
import {
  AUDIT_ACTIONS,
  AUDIT_PAGE,
  accountName,
  accountPath,
  actionLabel,
  auditHref,
  olderBefore,
  parseAction,
  parseBefore,
  parseBy,
} from "~/lib/ledgers";
import { admin } from "~/lib/services.server";
import { settle } from "~/lib/settle";
import { requireStaff } from "~/lib/staff";

export const meta: Route.MetaFunction = () => [{ title: "Audit log · sudo" }, { name: "robots", content: "noindex, nofollow" }];

export async function loader({ request, context }: Route.LoaderArgs) {
  const staff = requireStaff(context);
  const url = new URL(request.url);
  const by = parseBy(url.searchParams.get("by"));
  const action = parseAction(url.searchParams.get("action"));
  const before = parseBefore(url.searchParams.get("before"));
  // Enterprises' names, so a line about one reads as its name, not its id.
  const [result, accounts] = await Promise.all([
    settle(admin.audit({ by: by ?? undefined, action: action ?? undefined, before: before ?? undefined })),
    settle(admin.accounts()),
  ]);
  const names = Object.fromEntries(
    (accounts.ok ? accounts.value : []).filter((row) => row.account.kind === "enterprise").map((row) => [row.account.id, row.account.name]),
  );
  const actions = result.ok ? result.value : [];
  return {
    me: staff.email,
    by,
    action,
    before,
    actions,
    names,
    older: olderBefore(actions),
    error: result.ok ? null : result.error,
  };
}

/** Where a change came from: Stripe's lines are about Stripe, not a person. */
function isStripe(entry: AdminAction) {
  return entry.action === "stripe" || entry.action === "webhook" || entry.by === "stripe";
}

export default function Audit({ loaderData }: Route.ComponentProps) {
  const { me, by, action, before, actions, names, older, error } = loaderData;
  const nameMap = new Map(Object.entries(names));
  const filtered = by != null || action != null;

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:py-10">
      <PageHeader
        title="Audit log"
        description="Every change made in sudo, and what Stripe told billing, newest first, across every customer. Each names who made it."
      />

      <form method="get" action="/audit" className="mt-6 flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input name="by" type="search" defaultValue={by ?? ""} placeholder="Staff email, such as you@g1t.sh" aria-label="Made by" className="font-mono text-xs sm:w-72" />
        <Select name="action" defaultValue={action ?? ""} aria-label="Kind of change" className="sm:w-60">
          <option value="">Every kind of change</option>
          {Object.entries(AUDIT_ACTIONS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
        <div className="flex items-center gap-2">
          <Button type="submit" variant="quiet" className="py-2">
            Apply
          </Button>
          <Link to={auditHref({ by: me })} className="px-1 text-xs text-muted underline-offset-4 hover:text-fg hover:underline">
            Mine
          </Link>
          {filtered && (
            <Link to="/audit" className="px-1 text-xs text-muted underline-offset-4 hover:text-fg hover:underline">
              Clear
            </Link>
          )}
        </div>
      </form>

      {before && (
        <p className="mt-4 text-xs text-faint">
          Changes before <When at={before} time />.{" "}
          <Link to={auditHref({ by, action })} className="text-merged hover:underline">
            Back to the newest
          </Link>
        </p>
      )}

      {error ? (
        <div className="mt-4">
          <Notice tone="warn">Billing did not answer for the audit log: {error}</Notice>
        </div>
      ) : actions.length === 0 ? (
        <div className="mt-4">
          <EmptyState title={filtered || before ? "No changes match" : "No changes yet"}>
            {filtered ? "Try another staff email or kind of change, or clear the filters." : "Changes appear here as staff make them."}
          </EmptyState>
        </div>
      ) : (
        <ol className="mt-4 divide-y divide-line rounded-lg border border-line bg-surface">
          {actions.map((entry) => {
            const path = accountPath(entry.account);
            const stripe = isStripe(entry);
            return (
              <li key={entry.id} className="flex flex-col gap-1.5 px-4 py-3 sm:flex-row sm:items-start sm:gap-4 sm:px-5">
                <p className="shrink-0 text-xs whitespace-nowrap text-faint sm:w-44 sm:pt-0.5">
                  <When at={entry.createdAt} time />
                </p>
                <div className="min-w-0 grow">
                  <p className="flex flex-wrap items-center gap-x-2 text-sm">
                    <span className={`font-medium ${stripe ? "text-info" : "text-merged"}`}>{actionLabel(entry.action)}</span>
                    {path && (
                      <Link to={path} className="inline-flex items-center gap-0.5 text-fg-soft hover:text-fg hover:underline hover:underline-offset-4">
                        <span className={entry.account.startsWith("ws_") ? "font-mono text-xs" : ""}>{accountName(entry.account, nameMap)}</span>
                        <ChevronRight size={12} className="text-faint" />
                      </Link>
                    )}
                  </p>
                  {entry.detail && <p className="mt-0.5 text-sm break-words text-muted">{entry.detail}</p>}
                </div>
                <p className="flex shrink-0 items-center gap-1 text-xs text-faint sm:w-56 sm:justify-end sm:pt-0.5">
                  {stripe && entry.by === "stripe" ? (
                    "Stripe"
                  ) : (
                    <Link to={auditHref({ by: entry.by, action })} title={`Every change by ${entry.by}`} className="inline-flex min-w-0 items-center gap-1 hover:text-fg">
                      <UserRound size={11} className="shrink-0" />
                      <span className="truncate font-mono">{entry.by.toLowerCase() === me.toLowerCase() ? "you" : entry.by}</span>
                    </Link>
                  )}
                </p>
              </li>
            );
          })}
        </ol>
      )}

      {(older || actions.length > 0) && !error && (
        <nav aria-label="Pages" className="mt-4 flex items-center justify-between gap-3 text-sm">
          <span className="text-xs text-faint">
            {actions.length} change{actions.length === 1 ? "" : "s"}
            {older ? `, ${AUDIT_PAGE} a page` : ""}
          </span>
          {older && (
            <Link
              to={auditHref({ by, action, before: older })}
              className="inline-flex items-center gap-1 rounded-md border border-line px-3 py-1.5 text-muted hover:border-line-strong hover:text-fg"
            >
              Older
              <ChevronRight size={14} />
            </Link>
          )}
        </nav>
      )}
    </main>
  );
}
