import { ChevronRight, ShieldCheck } from "lucide-react";
import { Link, data } from "react-router";

import { SEVERITIES, type SeverityCounts } from "@g1t/contracts";

import type { Route } from "./+types/security";
import { page } from "../../lib/meta";
import { SeverityCountsGrid, SeverityCountsInline } from "../../components/security";
import { TimeAgo } from "../../components/ui";
import { Badge } from "../../components/ui/badge";
import { security } from "../../lib/services.server";
import { getViewer, roleIn, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Security · ${params.owner} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const projects = unwrap(await security.workspace(params.owner, viewer));
  const total = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0])) as SeverityCounts;
  for (const project of projects) {
    for (const severity of SEVERITIES) total[severity] += project.counts[severity];
  }
  // Most to fix first.
  projects.sort(
    (a, b) =>
      SEVERITIES.reduce((order, severity) => order || b.counts[severity] - a.counts[severity], 0) || a.name.localeCompare(b.name),
  );
  return { projects, total };
}

export default function WorkspaceSecurity({ loaderData, params }: Route.ComponentProps) {
  const { projects, total } = loaderData;
  return (
    <div className="space-y-6">
      <div>
        <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <ShieldCheck size={19} className="text-accent" />
          Security across projects
        </h2>
        <p className="mt-1.5 max-w-2xl text-sm text-muted">
          Open alerts in every project of {params.owner}: secrets found in pushes and history, and vulnerable
          dependencies. Each project's Security page has the details and the security update g1t opened for each.
        </p>
      </div>
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
    </div>
  );
}
