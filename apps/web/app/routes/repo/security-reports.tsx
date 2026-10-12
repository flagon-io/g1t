/**
 * The vulnerability reports people sent this repository's maintainers
 * privately: new ones first, each accepted (which drafts an advisory from
 * it) or declined by an Admin or a security manager. Those who see
 * findings read them; a reporter never sees another's.
 */
import { useFetcher, useSearchParams } from "react-router";

import type { ReportState, VulnerabilityReport } from "@g1t/contracts";

import type { Route } from "./+types/security-reports";
import { page } from "../../lib/meta";
import { Markdown } from "../../components/markdown";
import { SeverityBadge } from "../../components/security";
import { FilterSelect, SectionHeader } from "../../components/security-suite";
import { ButtonLink, EmptyState, TimeAgo } from "../../components/ui";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Hint } from "../../components/ui/hint";
import { Input } from "../../components/ui/input";
import { advisories } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, unwrap } from "../../lib/session.server";
import { refusal, requireInsider } from "../../lib/access.server";
import { whyNot } from "../../lib/access";
import { REPORT_STATES, REPORT_STATE_LABEL, REPORT_STATE_TONE, parseReportState } from "../../lib/advisories";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Vulnerability reports · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context) ?? requireUser(context, request);
  const { access } = await requireInsider(context, params, "security_alerts");
  const path = { namespace: params.owner, name: params.repo };
  const [reports, settings] = await Promise.all([advisories.reports(path, viewer), advisories.reportSettings(path, viewer)]);
  return { reports: unwrap(reports), reporting: settings.ok && settings.value.privateVulnerabilityReporting, can: access.can };
}

export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const refused = await refusal(context, params, "manage_security");
  if (refused) return { ok: false, error: refused };
  const form = await request.formData();
  const decision = String(form.get("decision") ?? "");
  if (decision !== "accept" && decision !== "decline") return { ok: false, error: "Nothing to do." };
  const reviewed = await advisories.review(user, { namespace: params.owner, name: params.repo }, String(form.get("id") ?? ""), decision, String(form.get("note") ?? "").slice(0, 1000));
  if (!reviewed.ok) return { ok: false, error: reviewed.error.message };
  return { ok: true, advisory: reviewed.value.advisory?.g1tsaId ?? null };
}

function ReportCard({ report, base, canReview, action }: { report: VulnerabilityReport; base: string; canReview: boolean; action: string }) {
  const fetcher = useFetcher<{ ok: boolean; error?: string; advisory?: string | null }>();
  const working = fetcher.state !== "idle";
  return (
    <Card asChild>
      <article className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          {report.severity && <SeverityBadge severity={report.severity} />}
          <h3 className="min-w-0 text-sm font-medium">{report.title}</h3>
          <Badge tone={REPORT_STATE_TONE[report.state]}>{REPORT_STATE_LABEL[report.state]}</Badge>
        </div>
        <p className="text-xs text-muted">
          From {report.reporter ?? report.reporterEmail ?? "someone"}, <TimeAgo at={report.createdAt} />
          {report.reviewedBy && report.reviewedAt && (
            <>
              {" · "}
              {report.state} by {report.reviewedBy} <TimeAgo at={report.reviewedAt} />
            </>
          )}
          {report.reviewNote && <> · {report.reviewNote}</>}
        </p>
        <Markdown source={report.description} />
        {report.state === "new" && canReview ? (
          <fetcher.Form method="post" action={action} className="flex flex-wrap items-center gap-2 pt-1">
            <input type="hidden" name="id" value={report.id} />
            <Input name="note" placeholder="A note for the record (optional)" maxLength={1000} className="h-8 w-full sm:w-72" />
            <Button type="submit" name="decision" value="accept" size="sm" disabled={working}>
              {working ? "…" : "Accept as a draft advisory"}
            </Button>
            <Button type="submit" name="decision" value="decline" size="sm" variant="outline" disabled={working}>
              Decline
            </Button>
            {fetcher.data?.error && <span className="text-xs text-danger">{fetcher.data.error}</span>}
          </fetcher.Form>
        ) : report.state === "new" ? (
          <Hint label={whyNot(null, "manage_security")} disabled>
            <Button size="sm" disabled>
              Accept as a draft advisory
            </Button>
          </Hint>
        ) : report.advisoryId ? (
          <ButtonLink to={`${base}/security/advisories/${report.advisoryId}`} variant="outline" size="sm">
            Open the advisory
          </ButtonLink>
        ) : null}
      </article>
    </Card>
  );
}

export default function SecurityReports({ loaderData, params }: Route.ComponentProps) {
  const { reports, reporting, can } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const [search, setSearch] = useSearchParams();
  const state: ReportState | null = parseReportState(search.get("state"));
  const shown = state ? reports.filter((report) => report.state === state) : reports;
  return (
    <div className="max-w-4xl space-y-6">
      <SectionHeader
        title="Vulnerability reports"
        about={
          reporting
            ? "What people told this repository's maintainers privately. Accept a report to draft an advisory from it, in the reporter's words and crediting them; decline what is not a vulnerability. Reporters never see this list."
            : "Private vulnerability reporting is off for this repository: nobody can send a new report. Turn it on from the Security overview. Reports already sent are here."
        }
        actions={
          <ButtonLink to={`${base}/security/advisories`} variant="outline" size="sm" prefetch="intent">
            Advisories
          </ButtonLink>
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <FilterSelect
          label="State"
          value={state ?? "all"}
          options={[["all", "Any state"], ...REPORT_STATES.map((each): [string, string] => [each, REPORT_STATE_LABEL[each]])]}
          onChange={(value) => {
            const next = new URLSearchParams(search);
            if (value !== "all") next.set("state", value);
            else next.delete("state");
            setSearch(next, { replace: true, preventScrollReset: true });
          }}
        />
      </div>
      {shown.length === 0 ? (
        <EmptyState title={state ? `No ${REPORT_STATE_LABEL[state].toLowerCase()} reports` : "No reports"}>
          {reporting ? "Nobody has reported a vulnerability privately yet." : "Nothing was reported while private reporting was on."}
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {shown.map((report) => (
            <ReportCard key={report.id} report={report} base={base} canReview={Boolean(can.manage_security)} action={`${base}/security/reports`} />
          ))}
        </div>
      )}
    </div>
  );
}
