import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { Link } from "react-router";

import { ADMIN_WORKSPACES_LIMIT } from "@g1t/contracts";

import type { Route } from "./+types/workspaces";
import { Owners } from "~/components/billing";
import { Avatar, Badge, Button, EmptyState, ExposureBar, Stat, TermsBadge, TrustBadge, When } from "~/components/ui";
import { usd } from "~/lib/money";
import { admin, identity } from "~/lib/services.server";
import { requireStaff } from "~/lib/staff";
import { fullDiscount } from "~/lib/terms";
import { PAGE_SIZE, type WorkspaceRow, joinWorkspaces, paginate } from "~/lib/workspaces";

export const meta: Route.MetaFunction = () => [{ title: "Workspaces · sudo" }, { name: "robots", content: "noindex, nofollow" }];

const FILTERS = {
  attention: { label: "Stopped or warning", test: (row: WorkspaceRow) => row.billing.limit != null && row.billing.limit.state !== "ok" },
  terms: { label: "A discount or custom terms", test: (row: WorkspaceRow) => row.billing.terms.kind !== "standard" },
  enterprise: { label: "On an enterprise", test: (row: WorkspaceRow) => row.billing.billedTo != null },
} as const;

type Filter = keyof typeof FILTERS;

export async function loader({ request, context }: Route.LoaderArgs) {
  requireStaff(context);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  const show = url.searchParams.getAll("show").filter((value): value is Filter => value in FILTERS);

  let workspaces = await identity.workspaces(q || undefined);
  const capped = workspaces.length >= ADMIN_WORKSPACES_LIMIT;
  // A search for an enterprise's name also finds the workspaces it pays
  // for, which identity knows nothing about.
  if (q) {
    const lower = q.toLowerCase();
    const members = new Set(
      (await admin.accounts(q))
        .filter((row) => row.account.kind === "enterprise" && row.account.name.toLowerCase().includes(lower))
        .flatMap((row) => row.account.workspaces),
    );
    const listed = new Set(workspaces.map((workspace) => workspace.slug));
    if ([...members].some((slug) => !listed.has(slug))) {
      const extra = (await identity.workspaces()).filter((workspace) => members.has(workspace.slug) && !listed.has(workspace.slug));
      workspaces = [...workspaces, ...extra];
    }
  }

  // Billing's figures for exactly this page's workspaces.
  const { page, pages, items } = paginate(workspaces, url.searchParams.get("page"));
  const accounts = items.length > 0 ? await admin.accountsFor(items.map((workspace) => workspace.slug)) : [];
  const onPage = joinWorkspaces(items, accounts);
  const rows = onPage.filter((row) => show.every((filter) => FILTERS[filter].test(row)));

  // This page's own figures: a workspace on an enterprise counts its share.
  const sum = (pick: (row: WorkspaceRow) => number) => onPage.reduce((total, row) => total + pick(row), 0);
  return {
    q,
    show,
    rows,
    page,
    pages,
    onPage: onPage.length,
    total: workspaces.length,
    capped,
    totals: {
      charged: sum((row) => row.billing.chargedMicros),
      cost: sum((row) => row.billing.costMicros),
      onEnterprise: onPage.filter((row) => row.billing.billedTo).length,
      stopped: onPage.filter((row) => row.billing.limit?.state === "stopped").length,
      warning: onPage.filter((row) => row.billing.limit?.state === "warning").length,
    },
  };
}

/** A link to another page of the list, keeping the search and filters. */
function pageHref(q: string, show: string[], page: number) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  for (const filter of show) params.append("show", filter);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/workspaces?${query}` : "/workspaces";
}

function workspaceHref(row: WorkspaceRow) {
  return `/workspaces/${encodeURIComponent(row.slug)}`;
}

export default function Workspaces({ loaderData }: Route.ComponentProps) {
  const { q, show, rows, page, pages, onPage, total, capped, totals } = loaderData;
  const scope = pages > 1 ? "this page" : null;
  const margin = totals.charged - totals.cost;
  const filtered = q !== "" || show.length > 0;

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:py-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Workspaces</h1>
          <p className="mt-1 text-sm text-muted">Every workspace, who owns it, and how it pays this month.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            to="/workspaces/deleted"
            className="rounded-md border border-line px-3 py-1.5 text-sm text-muted hover:border-line-strong hover:text-fg"
          >
            Deleted workspaces
          </Link>
          <Link
            to="/users/deleted"
            className="rounded-md border border-line px-3 py-1.5 text-sm text-muted hover:border-line-strong hover:text-fg"
          >
            Deleted accounts
          </Link>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label={q ? "Workspaces found" : "Workspaces"}
          value={`${total}${capped ? "+" : ""}`}
          hint={`${totals.onEnterprise} on ${scope ?? "the list"} billed to an enterprise`}
        />
        <Stat label={scope ? "Charged this month, this page" : "Charged this month"} value={usd(totals.charged)} hint={`Margin ${usd(margin)}`} tone={margin < 0 ? "danger" : undefined} />
        <Stat label={scope ? "Cost to g1t, this page" : "Cost to g1t"} value={usd(totals.cost)} hint="What their usage cost g1t" />
        <Stat
          label={scope ? "Needs attention, this page" : "Needs attention"}
          value={`${totals.stopped} stopped`}
          hint={`${totals.warning} near the limit`}
          tone={totals.stopped > 0 ? "danger" : totals.warning > 0 ? "warn" : "mint"}
        />
      </div>

      <form method="get" action="/workspaces" role="search" className="mt-6 flex flex-col gap-3 lg:flex-row lg:items-center">
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
            className="w-full rounded-md border border-line bg-bg py-2 pr-3 pl-8 text-sm outline-none transition-colors placeholder:text-faint hover:border-line-strong focus:border-accent/60"
          />
        </div>
        <fieldset className="flex flex-wrap items-center gap-2">
          <legend className="sr-only">Show only</legend>
          {(Object.keys(FILTERS) as Filter[]).map((key) => (
            <label
              key={key}
              className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-line px-3 py-1.5 text-xs text-muted transition-colors select-none hover:border-line-strong has-checked:border-accent/50 has-checked:bg-accent/10 has-checked:text-accent"
            >
              <input type="checkbox" name="show" value={key} defaultChecked={show.includes(key)} className="size-3.5" />
              {FILTERS[key].label}
            </label>
          ))}
          <Button type="submit" variant="quiet" className="py-1.5">
            Apply
          </Button>
          {filtered && (
            <Link to="/workspaces" className="px-1 text-xs text-muted underline-offset-4 hover:text-fg hover:underline">
              Clear
            </Link>
          )}
        </fieldset>
      </form>

      <p className="mt-4 text-xs text-faint">
        {total} workspace{total === 1 ? "" : "s"}
        {q && (
          <>
            {" "}
            matching <span className="font-mono text-muted">{q}</span>
          </>
        )}
        , newest first{pages > 1 && `, ${PAGE_SIZE} a page`}.
        {show.length > 0 && pages > 1 && ` Filters apply to this page: ${rows.length} of its ${onPage} match.`}
        {capped && ` Only the newest ${ADMIN_WORKSPACES_LIMIT} are listed; search to find older ones.`}
      </p>

      {rows.length === 0 ? (
        <div className="mt-3">
          <EmptyState title={filtered ? (pages > 1 ? "None on this page match" : "No workspaces match") : "No workspaces yet"}>
            {filtered
              ? pages > 1
                ? "Filters apply one page at a time. Try the next page, another search, or clear the filters."
                : "Try another search, or clear the filters."
              : "Workspaces appear here as people create them."}
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

      {pages > 1 && (
        <nav aria-label="Pages" className="mt-4 flex items-center justify-between gap-3 text-sm">
          {page > 1 ? (
            <Link to={pageHref(q, show, page - 1)} className="inline-flex items-center gap-1 rounded-md border border-line px-3 py-1.5 text-muted hover:border-line-strong hover:text-fg">
              <ChevronLeft size={14} />
              Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="text-xs text-faint">
            Page {page} of {pages}
          </span>
          {page < pages ? (
            <Link to={pageHref(q, show, page + 1)} className="inline-flex items-center gap-1 rounded-md border border-line px-3 py-1.5 text-muted hover:border-line-strong hover:text-fg">
              Next
              <ChevronRight size={14} />
            </Link>
          ) : (
            <span />
          )}
        </nav>
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
          {billing.limit && !fullDiscount(billing.terms) && <TrustBadge trust={billing.limit.trust} />}
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
