/**
 * A repository's Security overview: one row per feature, each with its
 * status, a line on what it does and the one thing to do about it, in the
 * groups of the Security page (policy, findings, reporting); the open
 * alerts by severity and the scan's state below. Anyone who can see a
 * public repository but has no role on it sees the public face instead:
 * the policy, the published advisories and, when it is on, the way to
 * report a vulnerability privately.
 */
import { ShieldCheck } from "lucide-react";
import { Form, Link, redirect, useFetcher, useNavigation } from "react-router";

import type { Advisory } from "@g1t/contracts";

import type { Route } from "./+types/security-overview";
import { page } from "../../lib/meta";
import { ScanSummary, SeverityBadge, SeverityCountsGrid } from "../../components/security";
import { SectionHeader } from "../../components/security-suite";
import { ButtonLink, EmptyState, TimeAgo } from "../../components/ui";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Hint } from "../../components/ui/hint";
import { Switch } from "../../components/ui/switch";
import { advisories, repos, security, securitySuite } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, unwrap } from "../../lib/session.server";
import { refusal, requireRepo } from "../../lib/access.server";
import { whyNot } from "../../lib/access";
import { legacySecurityTarget, severityCounts } from "../../lib/security-suite";
import { type OverviewRow, POLICY_PATHS, STATUS_LABEL, STATUS_TONE, overviewRows, rowsIn } from "../../lib/security-overview";
import { SEVERITY_LABEL } from "../../lib/advisories";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Security · ${params.owner}/${params.repo} · g1t` });
}

/** The security policy on the default branch, if any: the first of the places it may be. */
async function policyPath(path: { namespace: string; name: string }, viewer: ReturnType<typeof getViewer>, defaultBranch: string): Promise<string | null> {
  const found = await Promise.all(POLICY_PATHS.map((file) => repos.blob(path, viewer, defaultBranch, file).catch(() => null)));
  return POLICY_PATHS.find((_, at) => found[at]?.ok) ?? null;
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const base = `/${params.owner}/${params.repo}`;
  // Links from before the sections (git's push refusals among them).
  const moved = legacySecurityTarget(base, new URL(request.url).searchParams);
  if (moved) throw redirect(moved);
  const viewer = getViewer(context);
  const { repo, access } = await requireRepo(context, params, "read");
  const path = { namespace: params.owner, name: params.repo };
  if (!access.insider || !access.can.security_alerts) {
    // The public face: for anyone who can see the repository.
    const [policy, published, reporting] = await Promise.all([
      policyPath(path, viewer, repo.defaultBranch),
      advisories.list(path, viewer, "published"),
      advisories.reportSettings(path, viewer),
    ]);
    return {
      kind: "public" as const,
      policy,
      advisories: published.ok ? published.value : [],
      reporting: reporting.ok && reporting.value.privateVulnerabilityReporting,
      signedIn: Boolean(viewer),
    };
  }
  const [overview, code, view, policy, published, reports] = await Promise.all([
    security.overview(path, viewer),
    securitySuite.codeScanning(path, viewer),
    securitySuite.settings(path, viewer),
    policyPath(path, viewer, repo.defaultBranch),
    advisories.list(path, viewer, "published"),
    advisories.reports(path, viewer, "new"),
  ]);
  const settings = unwrap(view);
  return {
    kind: "insider" as const,
    overview: unwrap(overview),
    code: code.ok ? code.value : null,
    rows: overviewRows({
      base,
      policyPath: policy,
      reporting: settings.settings.privateVulnerabilityReporting,
      advisories: published.ok ? published.value.length : 0,
      upkeep: settings.upkeep,
      codeScanning: { configured: code.ok ? code.value.configured : false, analyses: code.ok ? code.value.analyses.length : 0, entitled: settings.entitled },
      historyAlerts: settings.settings.historyAlerts,
      canManage: Boolean(access.can.manage_settings),
      canPush: Boolean(access.can.push),
    }),
    newReports: reports.ok ? reports.value.length : 0,
    can: access.can,
  };
}

/** The switches on the overview: security updates, and private vulnerability reporting. */
export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const refused = await refusal(context, params, "manage_settings");
  if (refused) return { ok: false, error: refused };
  const path = { namespace: params.owner, name: params.repo };
  const form = await request.formData();
  const on = form.get("enabled") === "true";
  switch (String(form.get("intent") ?? "")) {
    case "upkeep": {
      const set = await security.setUpkeep(user, path, on);
      return set.ok ? { ok: true } : { ok: false, error: set.error.message };
    }
    case "reporting": {
      const current = await securitySuite.settings(path, user);
      if (!current.ok) return { ok: false, error: current.error.message };
      const saved = await securitySuite.setSettings(user, path, { ...current.value.settings, privateVulnerabilityReporting: on });
      return saved.ok ? { ok: true } : { ok: false, error: saved.error.message };
    }
    default:
      return { ok: false, error: "Unknown action." };
  }
}

function RowAction({ row, action, canManage }: { row: OverviewRow; action: string; canManage: boolean }) {
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const navigation = useNavigation();
  const what = row.action;
  if (!what) return null;
  if (what.kind === "link") {
    return (
      <ButtonLink to={what.to} variant="outline" size="sm" prefetch="intent">
        {what.label}
      </ButtonLink>
    );
  }
  if (what.kind === "post") {
    const working = navigation.state !== "idle" && navigation.formAction === what.action;
    return (
      <Form method="post" action={what.action}>
        <Button type="submit" size="sm" disabled={working}>
          {working ? what.pending : what.label}
        </Button>
      </Form>
    );
  }
  const on = fetcher.formData ? fetcher.formData.get("enabled") === "true" : what.on;
  return (
    <div className="flex flex-col items-end gap-1">
      <Hint label={canManage ? undefined : whyNot(null, "manage_settings")} disabled={!canManage}>
        <Switch
          aria-label={what.label}
          checked={on}
          disabled={!canManage || fetcher.state !== "idle"}
          onCheckedChange={(checked) => fetcher.submit({ intent: what.intent, enabled: String(checked) }, { method: "post", action })}
        />
      </Hint>
      {fetcher.data?.error && <span className="text-xs text-danger">{fetcher.data.error}</span>}
    </div>
  );
}

function FeatureRows({ title, rows, action, canManage }: { title: string; rows: OverviewRow[]; action: string; canManage: boolean }) {
  return (
    <section aria-labelledby={`rows-${title}`} className="space-y-2">
      <h3 id={`rows-${title}`} className="text-sm font-semibold">
        {title}
      </h3>
      <Card asChild divided>
        <ul>
          {rows.map((row) => (
            <li key={row.key} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:gap-6">
              <div className="min-w-0 grow">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{row.title}</span>
                  <Hint label={row.hint}>
                    <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</Badge>
                  </Hint>
                </div>
                <p className="mt-1 text-sm text-muted">{row.about}</p>
              </div>
              <div className="shrink-0 sm:text-right">
                <RowAction row={row} action={action} canManage={canManage} />
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

function AdvisoryLine({ advisory, base }: { advisory: Advisory; base: string }) {
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <SeverityBadge severity={advisory.severity} />
      <Link to={`${base}/security/advisories/${advisory.g1tsaId}`} className="min-w-0 grow truncate text-sm font-medium hover:underline">
        {advisory.title}
      </Link>
      <span className="shrink-0 font-mono text-xs text-faint">{advisory.g1tsaId}</span>
      {advisory.publishedAt && (
        <span className="hidden shrink-0 text-xs text-muted sm:inline">
          <TimeAgo at={advisory.publishedAt} />
        </span>
      )}
    </li>
  );
}

export default function SecurityOverview({ loaderData, params }: Route.ComponentProps) {
  const base = `/${params.owner}/${params.repo}`;
  if (loaderData.kind === "public") {
    const { policy, advisories: published, reporting, signedIn } = loaderData;
    return (
      <div className="max-w-5xl space-y-8">
        <SectionHeader
          title="Security"
          about="How to report a vulnerability in this repository, and what its maintainers have published about vulnerabilities in what it ships."
          actions={
            reporting ? (
              <ButtonLink to={`${base}/security/report`} prefetch="intent">
                Report a vulnerability
              </ButtonLink>
            ) : null
          }
        />
        <Card asChild divided>
          <ul>
            <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:gap-6">
              <div className="min-w-0 grow">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">Security policy</span>
                  <Badge tone={policy ? "success" : "neutral"}>{policy ? "Published" : "None yet"}</Badge>
                </div>
                <p className="mt-1 text-sm text-muted">
                  {policy ? `${policy} says how to report a vulnerability and which versions are supported.` : "This repository has not published a security policy."}
                </p>
              </div>
              {policy && (
                <ButtonLink to={`${base}/blob/HEAD/${policy}`} variant="outline" size="sm">
                  View policy
                </ButtonLink>
              )}
            </li>
            <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:gap-6">
              <div className="min-w-0 grow">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">Private vulnerability reporting</span>
                  <Badge tone={reporting ? "success" : "neutral"}>{reporting ? "Enabled" : "Disabled"}</Badge>
                </div>
                <p className="mt-1 text-sm text-muted">
                  {reporting
                    ? signedIn
                      ? "Tell the maintainers privately, under your name. Only they see the report."
                      : "Tell the maintainers privately. You can report without an account; leave an email so they can answer you."
                    : "This repository does not take private reports here. Its security policy, if any, says how to reach the maintainers."}
                </p>
              </div>
            </li>
          </ul>
        </Card>
        <section aria-labelledby="public-advisories" className="space-y-2">
          <div className="flex items-center justify-between gap-4">
            <h3 id="public-advisories" className="text-sm font-semibold">
              Security advisories
            </h3>
            {published.length > 0 && (
              <Link to={`${base}/security/advisories`} className="text-sm text-muted underline underline-offset-2 hover:text-fg">
                All advisories
              </Link>
            )}
          </div>
          {published.length === 0 ? (
            <EmptyState title="No published advisories">The maintainers have not published any security advisories for this repository.</EmptyState>
          ) : (
            <Card asChild divided>
              <ul>
                {published.slice(0, 5).map((advisory) => (
                  <AdvisoryLine key={advisory.id} advisory={advisory} base={base} />
                ))}
              </ul>
            </Card>
          )}
        </section>
      </div>
    );
  }
  const { overview, code, rows, newReports, can } = loaderData;
  const codeOpen = code ? severityCounts(code.alerts) : null;
  // Open alerts of every kind, by severity.
  const counts = { ...overview.counts };
  if (codeOpen) for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] += codeOpen[key];
  const action = `${base}/security`;
  const canManage = Boolean(can.manage_settings);
  return (
    <div className="max-w-5xl space-y-8">
      <SectionHeader
        title="Security"
        about="What keeps this repository safe, and where each part stands. Pushes that add a secret are refused before they land, every package the lockfiles resolve is checked for known vulnerabilities, code scanning reads your tools' results, and the maintainers publish advisories and take private reports."
        actions={
          newReports > 0 ? (
            <ButtonLink to={`${base}/security/reports`} variant="outline" size="sm" prefetch="intent">
              {newReports === 1 ? "1 new vulnerability report" : `${newReports} new vulnerability reports`}
            </ButtonLink>
          ) : null
        }
      />
      <FeatureRows title="Policy" rows={rowsIn(rows, "policy")} action={action} canManage={canManage} />
      <FeatureRows title="Findings" rows={rowsIn(rows, "findings")} action={action} canManage={canManage} />
      <FeatureRows title="Reporting" rows={rowsIn(rows, "reporting")} action={action} canManage={canManage} />
      <section aria-labelledby="open-alerts" className="space-y-3">
        <h3 id="open-alerts" className="flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck size={15} className="text-accent" />
          Open alerts
        </h3>
        <SeverityCountsGrid counts={counts} />
        <p className="text-xs text-faint">
          Open alerts of every kind by severity ({SEVERITY_LABEL.critical.toLowerCase()} to {SEVERITY_LABEL.low.toLowerCase()}). A secret in the history
          that looks real counts as critical; blocked pushes and likely test values do not.
        </p>
        <ScanSummary scan={overview.scan} />
      </section>
    </div>
  );
}
