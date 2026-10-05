import { ChevronRight, Search } from "lucide-react";
import { Link } from "react-router";

import { ADMIN_WORKSPACES_LIMIT } from "@g1t/contracts";

import type { Route } from "./+types/workspaces";
import { Owners } from "~/components/billing";
import { Avatar, Badge, Button, EmptyState, ExposureBar, Stat, TermsBadge, TrustBadge, When } from "~/components/ui";
import { usd } from "~/lib/money";
import { admin, identity } from "~/lib/services.server";
import { requireStaff } from "~/lib/staff";
import { type WorkspaceRow, joinWorkspaces, matchesQuery } from "~/lib/workspaces";

export const meta: Route.MetaFunction = () => [{ title: "Workspaces · sudo" }, { name: "robots", content: "noindex, nofollow" }];

const FILTERS = {
  attention: { label: "Stopped or warning", test: (row: WorkspaceRow) => row.billing.limit != null && row.billing.limit.state !== "ok" },
  terms: { label: "Comped or custom", test: (row: WorkspaceRow) => row.billing.terms.kind !== "standard" },
  enterprise: { label: "On an enterprise", test: (row: WorkspaceRow) => row.billing.billedTo != null },
} as const;

type Filter = keyof typeof FILTERS;

const SEVERITY = { stopped: 0, warning: 1, ok: 2 } as const;

export async function loader({ request, context }: Route.LoaderArgs) {
  requireStaff(context);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  const show = url.searchParams.getAll("show").filter((value): value is Filter => value in FILTERS);

  const [found, accounts] = await Promise.all([identity.workspaces(q || undefined), admin.accounts()]);
  let workspaces = found;
  // A search for an enterprise's name finds the workspaces it pays for,
  // which identity knows nothing about.
  const lower = q.toLowerCase();
  const enterpriseMembers = new Set(
    q
      ? accounts
          .filter((row) => row.account.kind === "enterprise" && row.account.name.toLowerCase().includes(lower))
          .flatMap((row) => row.account.workspaces)
      : [],
  );
  if (enterpriseMembers.size > 0) {
    const listed = new Set(found.map((workspace) => workspace.slug));
    const extra = (await identity.workspaces()).filter((workspace) => enterpriseMembers.has(workspace.slug) && !listed.has(workspace.slug));
    workspaces = [...found, ...extra];
  }

  const all = joinWorkspaces(workspaces, accounts).filter((row) => matchesQuery(row, q));
  const rows = all
    .filter((row) => show.every((filter) => FILTERS[filter].test(row)))
    .sort(
      (a, b) =>
        SEVERITY[a.billing.limit?.state ?? "ok"] - SEVERITY[b.billing.limit?.state ?? "ok"] ||
        (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
    );

  // Money is summed over billing's accounts, so an enterprise is counted once.
  const sum = (pick: (row: (typeof accounts)[number]) => number) => accounts.reduce((total, row) => total + pick(row), 0);
  return {
    q,
    show,
    rows,
    total: all.length,
    capped: found.length >= ADMIN_WORKSPACES_LIMIT,
    totals: {
      charged: sum((row) => row.chargedMicros),
      cost: sum((row) => row.costMicros),
      paid: sum((row) => row.paidMicros),
      exposure: sum((row) => row.limit.exposureMicros),
      onEnterprise: all.filter((row) => row.billing.billedTo).length,
      stopped: accounts.filter((row) => row.limit.state === "stopped").length,
      warning: accounts.filter((row) => row.limit.state === "warning").length,
    },
  };
}

function workspaceHref(row: WorkspaceRow) {
  return `/workspaces/${encodeURIComponent(row.slug)}`;
}

export default function Workspaces({ loaderData }: Route.ComponentProps) {
  const { q, show, rows, total, capped, totals } = loaderData;
  const margin = totals.charged - totals.cost;
  const filtered = q !== "" || show.length > 0;

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:py-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Workspaces</h1>
        <p className="mt-1 text-sm text-muted">Every workspace, who owns it, and how it pays this month.</p>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Workspaces" value={String(total)} hint={`${totals.onEnterprise} billed to an enterprise`} />
        <Stat label="Charged this month" value={usd(totals.charged)} hint={`Cost to g1t ${usd(totals.cost)} · margin ${usd(margin)}`} tone={margin < 0 ? "danger" : undefined} />
        <Stat label="Unpaid usage this month" value={usd(totals.exposure)} hint={`Paid ever ${usd(totals.paid)}`} />
        <Stat
          label="Needs attention"
          value={`${totals.stopped} stopped`}
          hint={`${totals.warning} near the limit`}
          tone={totals.stopped > 0 ? "danger" : totals.warning > 0 ? "warn" : "mint"}
        />
      </div>

      <form method="get" action="/" role="search" className="mt-6 flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative grow">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Search by workspace, owner, email or enterprise"
            aria-label="Search workspaces"
            autoComplete="off"
            data-1p-ignore
            className="w-full rounded-md border border-line bg-bg py-2 pr-3 pl-8 text-sm outline-none transition-colors placeholder:text-faint hover:border-line-strong focus:border-merged/60"
          />
        </div>
        <fieldset className="flex flex-wrap items-center gap-2">
          <legend className="sr-only">Show only</legend>
          {(Object.keys(FILTERS) as Filter[]).map((key) => (
            <label
              key={key}
              className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-line px-3 py-1.5 text-xs text-muted transition-colors select-none hover:border-line-strong has-checked:border-merged/50 has-checked:bg-merged/10 has-checked:text-merged"
            >
              <input type="checkbox" name="show" value={key} defaultChecked={show.includes(key)} className="size-3.5" />
              {FILTERS[key].label}
            </label>
          ))}
          <Button type="submit" variant="quiet" className="py-1.5">
            Apply
          </Button>
          {filtered && (
            <Link to="/" className="px-1 text-xs text-muted underline-offset-4 hover:text-fg hover:underline">
              Clear
            </Link>
          )}
        </fieldset>
      </form>

      <p className="mt-4 text-xs text-faint">
        {rows.length === total ? `${total} workspaces` : `${rows.length} of ${total} workspaces`}
        {q && (
          <>
            {" "}
            matching <span className="font-mono text-muted">{q}</span>
          </>
        )}
        . Stopped and warning first, then newest.
        {capped && ` Only the newest ${ADMIN_WORKSPACES_LIMIT} are listed; search to find older ones.`}
      </p>

      {rows.length === 0 ? (
        <div className="mt-3">
          <EmptyState title={filtered ? "No workspaces match" : "No workspaces yet"}>
            {filtered ? "Try another search, or clear the filters." : "Workspaces appear here as people create them."}
          </EmptyState>
        </div>
      ) : (
        <>
          {/* Phones: one card per workspace. */}
          <ul className="mt-3 space-y-2 md:hidden">
            {rows.map((row) => (
              <li key={row.slug}>
                <Link to={workspaceHref(row)} className="block rounded-lg border border-line bg-surface p-4 transition-colors hover:border-line-strong">
                  <div className="flex items-start justify-between gap-3">
                    <WorkspaceName row={row} />
                    <ChevronRight size={16} className="mt-0.5 shrink-0 text-faint" />
                  </div>
                  <div className="mt-3 text-xs">
                    <Owners owners={row.owners} compact />
                  </div>
                  <div className="mt-3">
                    <Usage row={row} wide />
                  </div>
                  <dl className="tabular mt-3 grid grid-cols-3 gap-2 text-xs">
                    <Figure label="Charged" value={usd(row.billing.chargedMicros)} />
                    <Figure label="Cost to g1t" value={usd(row.billing.costMicros)} />
                    <Figure label="Members" value={row.memberCount == null ? "—" : String(row.memberCount)} />
                  </dl>
                </Link>
              </li>
            ))}
          </ul>

          {/* Wider screens: a table. */}
          <div className="mt-3 hidden overflow-x-auto rounded-lg border border-line md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-surface text-left text-xs text-muted">
                  <th className="px-4 py-2.5 font-medium">Workspace</th>
                  <th className="px-4 py-2.5 font-medium">Owners</th>
                  <th className="px-4 py-2.5 text-right font-medium">Members</th>
                  <th className="px-4 py-2.5 font-medium">Usage this month / limit</th>
                  <th className="px-4 py-2.5 text-right font-medium">Charged</th>
                  <th className="px-4 py-2.5 text-right font-medium">Cost to g1t</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.slug} className="border-b border-line align-top last:border-0 hover:bg-surface/60">
                    <td className="px-4 py-3">
                      <Link to={workspaceHref(row)} className="group block">
                        <WorkspaceName row={row} />
                      </Link>
                    </td>
                    <td className="max-w-56 px-4 py-3 text-sm">
                      <Owners owners={row.owners} compact />
                    </td>
                    <td className="tabular px-4 py-3 text-right text-muted">{row.memberCount ?? "—"}</td>
                    <td className="px-4 py-3">
                      <Usage row={row} />
                    </td>
                    <td className="tabular px-4 py-3 text-right">{usd(row.billing.chargedMicros)}</td>
                    <td className="tabular px-4 py-3 text-right text-muted">{usd(row.billing.costMicros)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}

function WorkspaceName({ row }: { row: WorkspaceRow }) {
  const { billing } = row;
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <span className="mt-0.5">
        <Avatar name={row.slug} size={22} />
      </span>
      <div className="min-w-0">
        <p className="truncate font-medium group-hover:underline group-hover:underline-offset-4">{row.name}</p>
        <p className="truncate text-xs text-faint">
          <span className="font-mono">{row.slug}</span>
          {row.createdAt && (
            <>
              {" · "}created <When at={row.createdAt} />
            </>
          )}
        </p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {billing.billedTo && <Badge tone="lavender">Billed to {billing.billedTo.name}</Badge>}
          <TermsBadge terms={billing.terms} />
          {billing.limit && billing.terms.kind !== "comped" && <TrustBadge trust={billing.limit.trust} />}
          {!row.known && <Badge tone="warn">Billing only</Badge>}
        </div>
      </div>
    </div>
  );
}

/** The limit bar; a workspace on an enterprise shares the enterprise's. */
function Usage({ row, wide = false }: { row: WorkspaceRow; wide?: boolean }) {
  const { limit, billedTo } = row.billing;
  if (!limit) return <p className="text-xs text-faint">No usage yet</p>;
  return (
    <div>
      <ExposureBar limit={limit} wide={wide} />
      {billedTo && <p className="mt-1 text-xs text-faint">via {billedTo.name}</p>}
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-faint">{label}</dt>
      <dd className="mt-0.5 text-fg-soft">{value}</dd>
    </div>
  );
}
