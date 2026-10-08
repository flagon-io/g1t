import { ChevronRight, FileSearch, KeyRound, Network, PackageSearch, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { Link, redirect } from "react-router";

import type { Route } from "./+types/security-overview";
import { page } from "../../lib/meta";
import { ScanSummary, SeverityBadge, SeverityCountsGrid } from "../../components/security";
import { CARD, SectionHeader } from "../../components/security-suite";
import { security, securitySuite } from "../../lib/services.server";
import { getViewer, requireUser, unwrap } from "../../lib/session.server";
import { requireInsider } from "../../lib/access.server";
import { legacySecurityTarget, severityCounts, total, worstVulnerabilities } from "../../lib/security-suite";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Security · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const base = `/${params.owner}/${params.repo}`;
  // Links from before the sections (git's push refusals among them).
  const moved = legacySecurityTarget(base, new URL(request.url).searchParams);
  if (moved) throw redirect(moved);
  const viewer = getViewer(context) ?? requireUser(context, request);
  await requireInsider(context, params, "push");
  const repo = { namespace: params.owner, name: params.repo };
  const [overview, code] = await Promise.all([security.overview(repo, viewer), securitySuite.codeScanning(repo, viewer)]);
  return { overview: unwrap(overview), code: code.ok ? code.value : null };
}

function Card({ to, icon, title, children, footer }: { to: string; icon: ReactNode; title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <Link to={to} className={`${CARD} group flex flex-col p-4 transition-colors hover:border-line-strong`}>
      <span className="flex items-center gap-2 text-sm font-medium">
        <span className="text-accent">{icon}</span>
        {title}
        <ChevronRight size={14} className="ml-auto text-faint group-hover:text-fg" />
      </span>
      <div className="mt-2 grow text-sm text-muted">{children}</div>
      {footer && <div className="mt-3 text-xs text-faint">{footer}</div>}
    </Link>
  );
}

export default function SecurityOverview({ loaderData, params }: Route.ComponentProps) {
  const { overview, code } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const secrets = overview.secretCounts;
  const codeOpen = code ? severityCounts(code.alerts) : null;
  // Open alerts of every kind, by severity.
  const counts = { ...overview.counts };
  if (codeOpen) for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] += codeOpen[key];
  const worst = worstVulnerabilities(overview.vulnerabilities, 3);
  const openVulns = overview.vulnerabilities.filter((vuln) => vuln.state === "open").length;
  return (
    <div className="max-w-5xl space-y-8">
      <SectionHeader
        title="Security"
        about="Pushes that add a secret are refused before they land, and the history is scanned. Code scanning reads your tools' SARIF results, every package the lockfiles resolve is checked for known vulnerabilities, and g1t can fix what it finds."
      />
      <div>
        <SeverityCountsGrid counts={counts} />
        <p className="mt-2 text-xs text-faint">
          Open alerts of every kind by severity. A secret in the history that looks real counts as critical; blocked pushes and
          likely test values do not.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Card to={`${base}/security/secret-scanning`} icon={<KeyRound size={15} />} title="Secret scanning" footer="Push protection is on for every push.">
          {secrets.open + secrets.blocked === 0 ? (
            <span className="inline-flex items-center gap-1.5 text-accent">
              <ShieldCheck size={14} /> No open secrets
            </span>
          ) : (
            <>
              <span className="font-medium text-fg">{secrets.open}</span> in the history to rotate,{" "}
              <span className="font-medium text-fg">{secrets.blocked}</span> stopped at a push
            </>
          )}
        </Card>
        <Card to={`${base}/security/code-scanning`} icon={<FileSearch size={15} />} title="Code scanning" footer={code?.analyses[0] ? `Last analysis by ${code.analyses[0].tool}` : undefined}>
          {!code || (code.analyses.length === 0 && code.alerts.length === 0) ? (
            "Not set up. Add a workflow that uploads SARIF, and results show here and on pull requests."
          ) : total(codeOpen!) === 0 ? (
            <span className="inline-flex items-center gap-1.5 text-accent">
              <ShieldCheck size={14} /> No open alerts
            </span>
          ) : (
            <>
              <span className="font-medium text-fg">{total(codeOpen!)}</span> open {total(codeOpen!) === 1 ? "alert" : "alerts"}
            </>
          )}
        </Card>
        <Card to={`${base}/security/vulnerabilities`} icon={<PackageSearch size={15} />} title="Vulnerabilities">
          {openVulns === 0 ? (
            <span className="inline-flex items-center gap-1.5 text-accent">
              <ShieldCheck size={14} /> No vulnerable dependencies
            </span>
          ) : (
            <ul className="space-y-1">
              {worst.map((vuln) => (
                <li key={vuln.id} className="flex items-center gap-2">
                  <SeverityBadge severity={vuln.severity} />
                  <span className="truncate font-mono text-xs text-fg-soft">
                    {vuln.package}@{vuln.version}
                  </span>
                </li>
              ))}
              {openVulns > worst.length && <li className="text-xs">and {openVulns - worst.length} more</li>}
            </ul>
          )}
        </Card>
        <Card to={`${base}/security/dependency-graph`} icon={<Network size={15} />} title="Dependency graph">
          {overview.scan.lockfiles.length === 0
            ? "No lockfiles found on the default branch."
            : `${overview.scan.lockfiles.length} ${overview.scan.lockfiles.length === 1 ? "lockfile" : "lockfiles"}, with an SPDX SBOM to download.`}
        </Card>
      </div>
      <ScanSummary scan={overview.scan} />
    </div>
  );
}
