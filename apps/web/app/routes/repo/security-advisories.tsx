/**
 * A repository's security advisories: what its maintainers say about
 * vulnerabilities in what it ships. Anyone who can see the repository sees
 * the published ones; those who see its findings see drafts and withdrawn
 * ones too, and Admins (and security managers) write new ones. The reports
 * people sent privately are a page beside this one, for those who see findings.
 */
import { Link, useSearchParams } from "react-router";

import type { Advisory, AdvisoryState } from "@g1t/contracts";

import type { Route } from "./+types/security-advisories";
import { page } from "../../lib/meta";
import { SeverityBadge } from "../../components/security";
import { FilterSelect, SectionHeader } from "../../components/security-suite";
import { ButtonLink, EmptyState, TimeAgo } from "../../components/ui";
import { Badge } from "../../components/ui/badge";
import { Card } from "../../components/ui/card";
import { advisories } from "../../lib/services.server";
import { getViewer, unwrap } from "../../lib/session.server";
import { requireRepo } from "../../lib/access.server";
import { orElse, part } from "../../lib/partial";
import { ADVISORY_STATES, STATE_LABEL, STATE_TONE, advisoryStanding, parseAdvisoryState } from "../../lib/advisories";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Security advisories · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const { access } = await requireRepo(context, params, "read");
  const path = { namespace: params.owner, name: params.repo };
  const insider = Boolean(access.insider && access.can.security_alerts);
  // How many reports are new is only a count on the Reports link, which
  // goes without it when it cannot be read: the Reports page has them all.
  const [list, reports] = await Promise.all([
    advisories.list(path, viewer),
    insider ? part(advisories.reports(path, viewer, "new"), "New reports").then((found) => orElse(found, null)) : Promise.resolve(null),
  ]);
  return {
    advisories: unwrap(list),
    insider,
    canManage: Boolean(access.can.manage_settings),
    newReports: reports?.ok ? reports.value.length : 0,
  };
}

function AdvisoryRow({ advisory, base, insider }: { advisory: Advisory; base: string; insider: boolean }) {
  const standing = advisoryStanding(advisory);
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 grow">
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge severity={advisory.severity} />
          <Link to={`${base}/security/advisories/${advisory.g1tsaId}`} className="min-w-0 truncate text-sm font-medium hover:underline">
            {advisory.title}
          </Link>
          {insider && advisory.state !== "published" && <Badge tone={STATE_TONE[advisory.state]}>{STATE_LABEL[advisory.state]}</Badge>}
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted">
          <span className="font-mono">{advisory.g1tsaId}</span>
          {advisory.cveId && <span className="font-mono">{advisory.cveId}</span>}
          {advisory.package && (
            <span>
              {advisory.package}
              {advisory.affectedVersions ? ` ${advisory.affectedVersions}` : ""}
            </span>
          )}
          <span>
            {standing.verb}
            {standing.at && (
              <>
                {" "}
                <TimeAgo at={standing.at} />
              </>
            )}
          </span>
        </p>
      </div>
    </li>
  );
}

export default function SecurityAdvisories({ loaderData, params }: Route.ComponentProps) {
  const { advisories: list, insider, canManage, newReports } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const [search, setSearch] = useSearchParams();
  const state: AdvisoryState | null = insider ? parseAdvisoryState(search.get("state")) : null;
  const shown = state ? list.filter((advisory) => advisory.state === state) : list;
  return (
    <div className="max-w-5xl space-y-6">
      <SectionHeader
        title="Security advisories"
        about={
          insider
            ? "What this repository tells people who depend on it about vulnerabilities in what it ships. A draft is yours until you publish it; a published advisory is visible to anyone who can see the repository, and can be withdrawn."
            : "What this repository's maintainers have published about vulnerabilities in what it ships, and what to do about each."
        }
        actions={
          <>
            {insider && (
              <ButtonLink to={`${base}/security/reports`} variant="outline" size="sm" prefetch="intent">
                {newReports > 0 ? `Reports (${newReports} new)` : "Reports"}
              </ButtonLink>
            )}
            {canManage && (
              <ButtonLink to={`${base}/security/advisories/new`} size="sm" prefetch="intent">
                New advisory
              </ButtonLink>
            )}
          </>
        }
      />
      {insider && (
        <div className="flex flex-wrap items-center gap-2">
          <FilterSelect
            label="State"
            value={state ?? "all"}
            options={[["all", "Any state"], ...ADVISORY_STATES.map((each): [string, string] => [each, STATE_LABEL[each]])]}
            onChange={(value) => {
              const next = new URLSearchParams(search);
              if (value !== "all") next.set("state", value);
              else next.delete("state");
              setSearch(next, { replace: true, preventScrollReset: true });
            }}
          />
        </div>
      )}
      {shown.length === 0 ? (
        <EmptyState title={state ? `No ${STATE_LABEL[state].toLowerCase()} advisories` : "No advisories"}>
          {canManage
            ? "Draft one when this repository has a vulnerability to tell people about."
            : "The maintainers have not published any security advisories."}
        </EmptyState>
      ) : (
        <Card asChild divided>
          <ul>
            {shown.map((advisory) => (
              <AdvisoryRow key={advisory.id} advisory={advisory} base={base} insider={insider} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
