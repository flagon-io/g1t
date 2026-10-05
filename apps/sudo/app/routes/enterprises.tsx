import { Building2, ChevronRight } from "lucide-react";
import { Link } from "react-router";

import type { AdminOwner } from "@g1t/contracts";

import type { Route } from "./+types/enterprises";
import { Avatar, ButtonLink, EmptyState, ExposureBar, Stat, StateBadge, TermsBadge, When } from "~/components/ui";
import { usd } from "~/lib/money";
import { admin, identity } from "~/lib/services.server";
import { requireStaff } from "~/lib/staff";

export const meta: Route.MetaFunction = () => [{ title: "Enterprises · sudo" }, { name: "robots", content: "noindex, nofollow" }];

export async function loader({ context }: Route.LoaderArgs) {
  requireStaff(context);
  const [accounts, workspaces] = await Promise.all([admin.accounts(), identity.workspaces()]);
  const owners = new Map<string, AdminOwner[]>(workspaces.map((workspace) => [workspace.slug, workspace.owners]));
  const enterprises = accounts
    .filter((row) => row.account.kind === "enterprise")
    .sort((a, b) => a.account.name.localeCompare(b.account.name))
    .map((row) => ({
      ...row,
      members: row.account.workspaces.map((slug) => ({ slug, owners: owners.get(slug) ?? [] })),
    }));
  const sum = (pick: (row: (typeof enterprises)[number]) => number) => enterprises.reduce((total, row) => total + pick(row), 0);
  return {
    enterprises,
    totals: {
      charged: sum((row) => row.chargedMicros),
      cost: sum((row) => row.costMicros),
      workspaces: sum((row) => row.account.workspaces.length),
    },
  };
}

export default function Enterprises({ loaderData }: Route.ComponentProps) {
  const { enterprises, totals } = loaderData;
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Enterprises</h1>
          <p className="mt-1 text-sm text-muted">Each pays for several workspaces: one bill, one limit, one set of terms.</p>
        </div>
        <ButtonLink to="/enterprises/new" variant="lavender">
          <Building2 size={15} />
          New enterprise
        </ButtonLink>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat label="Enterprises" value={String(enterprises.length)} hint={`Paying for ${totals.workspaces} workspace${totals.workspaces === 1 ? "" : "s"}`} />
        <Stat label="Charged this month" value={usd(totals.charged)} />
        <Stat label="Cost to g1t" value={usd(totals.cost)} hint={`Margin ${usd(totals.charged - totals.cost)}`} tone={totals.charged < totals.cost ? "danger" : undefined} />
      </div>

      {enterprises.length === 0 ? (
        <div className="mt-6">
          <EmptyState title="No enterprises yet">Create one to bill several workspaces together.</EmptyState>
        </div>
      ) : (
        <ul className="mt-6 space-y-3">
          {enterprises.map((row) => (
            <li key={row.account.id}>
              <Link
                to={`/enterprises/${encodeURIComponent(row.account.id)}`}
                className="group grid gap-4 rounded-lg border border-line bg-surface p-4 transition-colors hover:border-line-strong md:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,1fr)] md:items-start"
              >
                <div className="flex min-w-0 items-start gap-2.5">
                  <Avatar name={row.account.name} size={28} />
                  <div className="min-w-0">
                    <p className="truncate font-medium group-hover:underline group-hover:underline-offset-4">{row.account.name}</p>
                    <p className="truncate text-xs text-faint">
                      Since <When at={row.account.createdAt} />
                      <span className="font-mono"> · {row.account.id}</span>
                    </p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      <TermsBadge terms={row.account.terms} />
                      <StateBadge state={row.limit.state} />
                    </div>
                  </div>
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted">
                    {row.members.length} workspace{row.members.length === 1 ? "" : "s"}
                  </p>
                  <ul className="mt-1 space-y-0.5 text-sm">
                    {row.members.slice(0, 5).map((member) => (
                      <li key={member.slug} className="truncate">
                        <span className="font-mono">{member.slug}</span>
                        {member.owners.length > 0 && (
                          <span className="text-xs text-faint"> · {member.owners.map((owner) => owner.username).join(", ")}</span>
                        )}
                      </li>
                    ))}
                    {row.members.length > 5 && <li className="text-xs text-faint">and {row.members.length - 5} more</li>}
                  </ul>
                </div>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 grow">
                    <ExposureBar limit={row.limit} wide />
                    <p className="tabular mt-2 text-xs text-faint">
                      Charged {usd(row.chargedMicros)} · cost {usd(row.costMicros)}
                    </p>
                  </div>
                  <ChevronRight size={16} className="mt-0.5 shrink-0 text-faint" />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
