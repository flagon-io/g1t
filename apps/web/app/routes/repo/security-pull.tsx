import { ArrowLeft, CircleAlert, CircleCheck } from "lucide-react";
import { Link } from "react-router";

import type { Route } from "./+types/security-pull";
import { page } from "../../lib/meta";
import { SeverityBadge } from "../../components/security";
import { CARD, LIST, SectionHeader, shortRule } from "../../components/security-suite";
import { Badge } from "../../components/ui/badge";
import { securitySuite } from "../../lib/services.server";
import { getViewer, requireUser, unwrap } from "../../lib/session.server";
import { requireInsider } from "../../lib/access.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Security checks · #${params.number} · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context) ?? requireUser(context, request);
  await requireInsider(context, params, "push");
  const repo = { namespace: params.owner, name: params.repo };
  return { scanning: unwrap(await securitySuite.pullScanning(repo, Number(params.number) || 0, viewer)) };
}

function Verdict({ passed, text }: { passed: boolean; text: string }) {
  return (
    <p className={`flex items-center gap-1.5 text-sm ${passed ? "text-accent" : "text-danger"}`}>
      {passed ? <CircleCheck size={15} /> : <CircleAlert size={15} />}
      {text}
    </p>
  );
}

/** What the Code scanning and Dependency review checks found on a pull request: the page their statuses link to. */
export default function PullSecurity({ loaderData, params }: Route.ComponentProps) {
  const { scanning } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const onLines = scanning.results.filter((result) => result.new && result.onChangedLine);
  const others = scanning.results.filter((result) => !(result.new && result.onChangedLine));
  return (
    <div className="max-w-4xl space-y-8">
      <Link to={`${base}/pull/${params.number}`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} /> Pull request #{params.number}
      </Link>
      <SectionHeader
        title={`Security checks for #${params.number}`}
        about={`What code scanning and dependency review found on this pull request${scanning.commit ? ` at ${scanning.commit.slice(0, 7)}` : ""}. Require the checks in branch protection to block merges on them.`}
      />
      <section className="space-y-3">
        <h3 className="text-base font-semibold tracking-tight">Code scanning</h3>
        {scanning.codeStatus ? (
          <Verdict passed={scanning.codeStatus === "success"} text={scanning.codeDescription ?? ""} />
        ) : (
          <p className="text-sm text-muted">No code scanning results for this pull request yet.</p>
        )}
        {onLines.length > 0 && (
          <ul className={LIST}>
            {onLines.map((result, at) => (
              <li key={at} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{shortRule(result.ruleId)}</span>
                  <SeverityBadge severity={result.severity} />
                  {result.failing && <Badge tone="danger">Fails the check</Badge>}
                  <span className="text-xs text-faint">{result.tool}</span>
                </div>
                <p className="mt-1 text-xs text-muted">{result.message}</p>
                {result.path && (
                  <p className="mt-1 font-mono text-xs text-fg-soft">
                    {result.path}
                    {result.line ? `:${result.line}` : ""}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
        {others.length > 0 && (
          <p className="text-xs text-faint">
            {others.length} other {others.length === 1 ? "result" : "results"}: already open on the default branch, or on lines this pull request does not change.
          </p>
        )}
      </section>
      <section className="space-y-3">
        <h3 className="text-base font-semibold tracking-tight">Dependency review</h3>
        {!scanning.review ? (
          <p className="text-sm text-muted">Not reviewed yet: it runs when a pull request opens and each time its head moves.</p>
        ) : (
          <>
            <Verdict passed={scanning.review.passed} text={scanning.review.headline} />
            {scanning.review.changes.length > 0 && (
              <div className={`${CARD} overflow-x-auto`}>
                <table className="w-full min-w-[36rem] text-sm">
                  <thead className="text-left text-xs text-muted">
                    <tr className="border-b border-line">
                      <th className="px-4 py-2 font-medium">Change</th>
                      <th className="px-3 py-2 font-medium">Package</th>
                      <th className="px-3 py-2 font-medium">License</th>
                      <th className="px-3 py-2 font-medium">Vulnerabilities</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scanning.review.changes.map((change) => (
                      <tr key={`${change.changeType}:${change.manifest}:${change.name}@${change.version}`} className="border-b border-line last:border-0">
                        <td className="px-4 py-2 text-xs">{change.changeType === "added" ? "Added" : "Removed"}</td>
                        <td className="px-3 py-2 font-mono text-xs">
                          {change.name}@{change.version}
                        </td>
                        <td className={`px-3 py-2 text-xs ${change.deniedLicense ? "text-danger" : "text-muted"}`}>{change.license ?? "—"}</td>
                        <td className="px-3 py-2 text-xs">
                          {change.vulnerabilities.length === 0 ? (
                            <span className="text-faint">none known</span>
                          ) : (
                            change.vulnerabilities.map((vuln) => (
                              <a key={vuln.osvId} href={vuln.url} className="mr-2 inline-flex items-center gap-1 hover:underline" rel="noreferrer">
                                <SeverityBadge severity={vuln.severity} /> {vuln.advisory}
                              </a>
                            ))
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
