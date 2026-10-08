import { ChevronRight } from "lucide-react";
import { Link, data } from "react-router";

import { SEVERITIES, type SeverityCounts } from "@g1t/contracts";

import type { Route } from "./+types/security";
import { page } from "../../lib/meta";
import { SeverityCountsGrid, SeverityCountsInline } from "../../components/security";
import { ActivationPrompt, CARD, CoverageTable, TrendChart, countsLine } from "../../components/security-suite";
import { WorkspaceSecurityTabs } from "../../components/workspace-security-tabs";
import { TimeAgo } from "../../components/ui";
import { Badge } from "../../components/ui/badge";
import { repos, security, securitySuite } from "../../lib/services.server";
import { getViewer, managesSecurity, roleIn, unwrap } from "../../lib/session.server";
import { activationPrice } from "../../lib/security-suite.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Security · ${params.owner} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const [scanned, current, overview, requests, price] = await Promise.all([
    security.workspace(params.owner, viewer),
    repos.list(viewer, { namespace: params.owner.toLowerCase() }),
    securitySuite.overview(params.owner, viewer, 30),
    securitySuite.bypassRequests(params.owner, viewer, "pending"),
    activationPrice(params.owner, viewer),
  ]);
  // Only repositories that are still there: a deleted one's alerts stay
  // with it for its 30 days, but not on this page.
  const live = new Set(current.map((repo) => repo.id));
  // Whether each is private, from the repository itself: the security
  // service's own record of it can lag behind.
  const privacy = new Map(current.map((repo) => [repo.id, repo.isPrivate]));
  const projects = unwrap(scanned).filter((project) => live.has(project.repoId));
  const total = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0])) as SeverityCounts;
  for (const project of projects) {
    for (const severity of SEVERITIES) total[severity] += project.counts[severity];
  }
  // Most to fix first.
  projects.sort(
    (a, b) =>
      SEVERITIES.reduce((order, severity) => order || b.counts[severity] - a.counts[severity], 0) || a.name.localeCompare(b.name),
  );
  const full = overview.ok
    ? {
        ...overview.value,
        repos: overview.value.repos
          .filter((repo) => live.has(repo.repoId))
          .map((repo) => ({ ...repo, private: privacy.get(repo.repoId) ?? repo.private })),
      }
    : null;
  return {
    projects,
    total,
    overview: full,
    pending: requests.ok ? requests.value.length : 0,
    price,
    owner: managesSecurity(viewer, params.owner),
  };
}

const TYPE_LABEL: Record<string, string> = {
  secret_scanning: "Secrets",
  code_scanning: "Code scanning",
  vulnerability: "Vulnerabilities",
};

export default function WorkspaceSecurity({ loaderData, params }: Route.ComponentProps) {
  const { projects, total, overview, pending, price, owner } = loaderData;
  // The full overview counts private repositories with the activation; without it, a workspace
  // with private ones sees the free list of every repository's open alerts.
  const full = overview && (overview.activated || overview.privateHidden === 0);
  return (
    <div className="space-y-8">
      <WorkspaceSecurityTabs owner={params.owner} pending={pending} />
      {full && overview ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            {overview.totals.map((totals) => (
              <div key={totals.alertType} className={`${CARD} p-4`}>
                <p className="text-xs text-muted">{TYPE_LABEL[totals.alertType]}</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">
                  {totals.open.critical + totals.open.high + totals.open.medium + totals.open.low + totals.open.unknown}
                  <span className="ml-1.5 text-sm font-normal text-muted">open</span>
                </p>
                <p className="mt-1 text-xs text-muted">{countsLine(totals.open)}</p>
                <p className="mt-2 text-xs text-faint">
                  {totals.opened} opened · {totals.closed} closed in 30 days
                </p>
              </div>
            ))}
          </div>
          <TrendChart points={overview.trend} />
          <section className="space-y-3">
            <h2 className="text-base font-semibold tracking-tight">Repositories, most in need first</h2>
            <CoverageTable repos={overview.repos} owner={params.owner} />
          </section>
        </>
      ) : (
        <>
          <ActivationPrompt workspace={params.owner} feature="The security overview" monthlyCents={price} isOwner={owner} />
          <div>
            <SeverityCountsGrid counts={total} />
            <p className="mt-2 text-xs text-faint">
              Open alerts by severity. A secret in the history that looks real counts as critical; blocked pushes and likely test
              values do not.
            </p>
          </div>
          {projects.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line px-4 py-6 text-sm text-muted">
              No project has been scanned yet. Each one is scanned on its next push to its default branch, or when its Security
              page is first opened.
            </p>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
              {projects.map((project) => (
                <li key={project.repoId}>
                  <Link
                    to={`/${params.owner}/${project.name}/security`}
                    className="group flex flex-col gap-2 px-4 py-3 transition-colors hover:bg-raised/50 sm:flex-row sm:items-center"
                  >
                    <span className="min-w-0 grow">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm font-medium">{project.name}</span>
                        {!project.upkeep && <Badge>security updates off</Badge>}
                      </span>
                      <span className="mt-0.5 block text-xs text-faint">
                        {project.secrets} {project.secrets === 1 ? "secret" : "secrets"} · {project.vulnerabilities}{" "}
                        {project.vulnerabilities === 1 ? "vulnerability" : "vulnerabilities"}
                        {project.dependenciesScannedAt && (
                          <>
                            {" "}
                            · read <TimeAgo at={project.dependenciesScannedAt} />
                          </>
                        )}
                      </span>
                    </span>
                    <SeverityCountsInline counts={project.counts} />
                    <ChevronRight size={15} className="hidden shrink-0 text-faint group-hover:text-fg sm:block" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
