import { Building2, ChevronRight, Search } from "lucide-react";
import { Link } from "react-router";

import type { AccountSummary } from "@g1t/contracts";

import type { Route } from "./+types/accounts";
import {
  Avatar,
  Button,
  ButtonLink,
  EmptyState,
  ExposureBar,
  KindBadge,
  Stat,
  TermsBadge,
  TrustBadge,
} from "~/components/ui";
import { usd } from "~/lib/money";
import { admin } from "~/lib/services.server";
import { requireStaff } from "~/lib/staff";

export const meta: Route.MetaFunction = () => [{ title: "Accounts · sudo" }, { name: "robots", content: "noindex, nofollow" }];

const FILTERS = {
  attention: { label: "Stopped or warning", test: (row: AccountSummary) => row.limit.state !== "ok" },
  terms: { label: "Comped or custom", test: (row: AccountSummary) => row.account.terms.kind !== "standard" },
  enterprise: { label: "Enterprises", test: (row: AccountSummary) => row.account.kind === "enterprise" },
} as const;

type Filter = keyof typeof FILTERS;

const SEVERITY = { stopped: 0, warning: 1, ok: 2 } as const;

export async function loader({ request, context }: Route.LoaderArgs) {
  requireStaff(context);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  const show = url.searchParams.getAll("show").filter((value): value is Filter => value in FILTERS);

  const all = await admin.accounts(q || undefined);
  const rows = all
    .filter((row) => show.every((filter) => FILTERS[filter].test(row)))
    .sort(
      (a, b) =>
        SEVERITY[a.limit.state] - SEVERITY[b.limit.state] ||
        b.limit.exposureMicros - a.limit.exposureMicros ||
        a.account.name.localeCompare(b.account.name),
    );

  const sum = (pick: (row: AccountSummary) => number) => all.reduce((total, row) => total + pick(row), 0);
  return {
    q,
    show,
    rows,
    total: all.length,
    totals: {
      charged: sum((row) => row.chargedMicros),
      cost: sum((row) => row.costMicros),
      paid: sum((row) => row.paidMicros),
      exposure: sum((row) => row.limit.exposureMicros),
      stopped: all.filter((row) => row.limit.state === "stopped").length,
      warning: all.filter((row) => row.limit.state === "warning").length,
    },
  };
}

function accountHref(row: AccountSummary) {
  return `/accounts/${encodeURIComponent(row.account.id)}`;
}

export default function Accounts({ loaderData }: Route.ComponentProps) {
  const { q, show, rows, total, totals } = loaderData;
  const margin = totals.charged - totals.cost;
  const filtered = q !== "" || show.length > 0;

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Accounts</h1>
          <p className="mt-1 text-sm text-muted">Every account that pays, and where it stands this month.</p>
        </div>
        <ButtonLink to="/enterprises/new" variant="lavender">
          <Building2 size={15} />
          New enterprise
        </ButtonLink>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Charged this month" value={usd(totals.charged)} hint={`${total} account${total === 1 ? "" : "s"}`} />
        <Stat label="Cost to g1t" value={usd(totals.cost)} hint={`Margin ${usd(margin)}`} tone={margin < 0 ? "danger" : undefined} />
        <Stat label="Unpaid exposure" value={usd(totals.exposure)} hint={`Paid ever ${usd(totals.paid)}`} />
        <Stat
          label="Needs attention"
          value={`${totals.stopped} stopped`}
          hint={`${totals.warning} near the ceiling`}
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
            placeholder="Search by workspace, account id or enterprise"
            aria-label="Search accounts"
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
        {rows.length === total ? `${total} accounts` : `${rows.length} of ${total} accounts`}
        {q && (
          <>
            {" "}
            matching <span className="font-mono text-muted">{q}</span>
          </>
        )}
        . Stopped and warning first, then by exposure.
      </p>

      {rows.length === 0 ? (
        <div className="mt-3">
          <EmptyState title={filtered ? "No accounts match" : "No accounts yet"}>
            {filtered ? "Try another search, or clear the filters." : "Accounts appear once a workspace exists."}
          </EmptyState>
        </div>
      ) : (
        <>
          {/* Phones: one card per account. */}
          <ul className="mt-3 space-y-2 md:hidden">
            {rows.map((row) => (
              <li key={row.account.id}>
                <Link to={accountHref(row)} className="block rounded-lg border border-line bg-surface p-4 transition-colors hover:border-line-strong">
                  <div className="flex items-start justify-between gap-3">
                    <AccountName row={row} />
                    <ChevronRight size={16} className="mt-0.5 shrink-0 text-faint" />
                  </div>
                  <div className="mt-3">
                    <ExposureBar limit={row.limit} wide />
                  </div>
                  <dl className="tabular mt-3 grid grid-cols-3 gap-2 text-xs">
                    <Figure label="Charged" value={usd(row.chargedMicros)} />
                    <Figure label="Cost" value={usd(row.costMicros)} />
                    <Figure label="Paid ever" value={usd(row.paidMicros)} />
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
                  <th className="px-4 py-2.5 font-medium">Account</th>
                  <th className="px-4 py-2.5 font-medium">Trust</th>
                  <th className="px-4 py-2.5 font-medium">Exposure / ceiling</th>
                  <th className="px-4 py-2.5 text-right font-medium">Charged</th>
                  <th className="px-4 py-2.5 text-right font-medium">Cost to g1t</th>
                  <th className="px-4 py-2.5 text-right font-medium">Paid ever</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.account.id} className="border-b border-line last:border-0 hover:bg-surface/60">
                    <td className="px-4 py-3">
                      <Link to={accountHref(row)} className="group block">
                        <AccountName row={row} />
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <TrustBadge trust={row.limit.trust} />
                    </td>
                    <td className="px-4 py-3">
                      <ExposureBar limit={row.limit} />
                    </td>
                    <td className="tabular px-4 py-3 text-right">{usd(row.chargedMicros)}</td>
                    <td className="tabular px-4 py-3 text-right text-muted">{usd(row.costMicros)}</td>
                    <td className="tabular px-4 py-3 text-right text-muted">{usd(row.paidMicros)}</td>
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

function AccountName({ row }: { row: AccountSummary }) {
  const { account } = row;
  const members = account.workspaces.length;
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <span className="mt-0.5">
        <Avatar name={account.name} size={22} />
      </span>
      <div className="min-w-0">
        <p className="truncate font-medium group-hover:underline group-hover:underline-offset-4">{account.name}</p>
        <p className="truncate font-mono text-xs text-faint">
          {account.id}
          {account.kind === "enterprise" && ` · ${members} workspace${members === 1 ? "" : "s"}`}
        </p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <KindBadge kind={account.kind} />
          <TermsBadge terms={account.terms} />
          <span className="md:hidden">
            <TrustBadge trust={row.limit.trust} />
          </span>
        </div>
      </div>
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
