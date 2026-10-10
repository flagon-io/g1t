import { FileSearch } from "lucide-react";
import { Form, useNavigation, useSearchParams } from "react-router";

import type { AlertState, Severity } from "@g1t/contracts";

import type { Route } from "./+types/security-code";
import { page } from "../../lib/meta";
import { StateFilter } from "../../components/security";
import { ActivationPrompt, CARD, CodeAlertItem, FilterSelect, LIST, SectionHeader } from "../../components/security-suite";
import { TimeAgo } from "../../components/ui";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { securitySuite } from "../../lib/services.server";
import { getViewer, managesSecurity, requireUser, unwrap } from "../../lib/session.server";
import { requireInsider } from "../../lib/access.server";
import { planPrice } from "../../lib/security-suite.server";
import { codeFilters, countStates, keepCode } from "../../lib/security-suite";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Code scanning · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context) ?? requireUser(context, request);
  const { access } = await requireInsider(context, params, "security_alerts");
  const repo = { namespace: params.owner, name: params.repo };
  const [scanning, price] = await Promise.all([securitySuite.codeScanning(repo, viewer), planPrice(params.owner, viewer)]);
  return { scanning: unwrap(scanning), price, can: access.can, owner: managesSecurity(viewer, params.owner) };
}

const SEVERITY_OPTIONS: [string, string][] = [
  ["all", "Any severity"],
  ["critical", "Critical"],
  ["high", "High"],
  ["medium", "Medium"],
  ["low", "Low"],
];

export default function CodeScanning({ loaderData, params }: Route.ComponentProps) {
  const { scanning, price, can, owner } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const [search, setSearch] = useSearchParams();
  const navigation = useNavigation();
  const filters = codeFilters(search);
  const tools = [...new Set(scanning.alerts.map((alert) => alert.tool))].sort();
  const counts = countStates(scanning.alerts.filter((alert) => keepCode(alert, { ...filters, state: alert.state })));
  const shown = scanning.alerts.filter((alert) => keepCode(alert, filters));
  const set = (key: string, value: string | null) => {
    const next = new URLSearchParams(search);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearch(next, { replace: true, preventScrollReset: true });
  };
  const empty = scanning.alerts.length === 0 && scanning.analyses.length === 0;
  const settingUp = navigation.state !== "idle" && navigation.formAction?.endsWith("/code-scanning/setup");
  return (
    <div className="max-w-5xl space-y-8">
      <SectionHeader
        title="Code scanning"
        about="Results from your static analysis tools, uploaded as SARIF. On the default branch each problem is an alert, fixed when a later analysis no longer reports it. On a pull request, new results on the lines it changes become review comments and the Code scanning check."
        actions={
          scanning.entitled && can.manage_settings && !scanning.configured ? (
            <Form method="post" action={`${base}/security/code-scanning/setup`}>
              <Button type="submit" disabled={settingUp}>
                {settingUp ? "Opening a pull request…" : "Set up code scanning"}
              </Button>
            </Form>
          ) : null
        }
      />
      {!scanning.entitled ? (
        <ActivationPrompt workspace={params.owner} feature="Code scanning" monthlyCents={price} isOwner={owner} />
      ) : empty ? (
        <div className={`${CARD} px-6 py-10 text-center`}>
          <FileSearch size={22} className="mx-auto text-accent" />
          <p className="mt-2 font-medium">No analyses yet</p>
          <p className="mx-auto mt-1 max-w-xl text-sm text-muted">
            {scanning.configured
              ? "The code scanning workflow is on the default branch; its first run's results show here."
              : "Set up code scanning to open a pull request adding a workflow that scans each language the repository has (Bandit, gosec, ESLint, Clippy) and uploads the results, or upload SARIF from any tool with POST /repos/{owner}/{name}/code-scanning/sarifs."}
          </p>
        </div>
      ) : (
        <section className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <StateFilter counts={counts} value={filters.state} onChange={(state: AlertState) => set("state", state === "open" ? null : state)} />
            <div className="flex flex-wrap gap-2">
              <FilterSelect label="Severity" value={filters.severity ?? "all"} options={SEVERITY_OPTIONS} onChange={(value) => set("severity", value === "all" ? null : (value as Severity))} />
              <FilterSelect label="Tool" value={filters.tool ?? "all"} options={[["all", "Every tool"], ...tools.map((tool): [string, string] => [tool, tool])]} onChange={(value) => set("tool", value === "all" ? null : value)} />
            </div>
          </div>
          {shown.length === 0 ? (
            <Card asChild tone="plain" className="border-dashed px-4 py-6 text-sm text-muted">
              <p>No {filters.state} alerts match.</p>
            </Card>
          ) : (
            <ul className={LIST}>
              {shown.map((alert) => (
                <CodeAlertItem key={alert.id} alert={alert} base={base} />
              ))}
            </ul>
          )}
        </section>
      )}
      {scanning.analyses.length > 0 && (
        <section>
          <h3 className="text-base font-semibold tracking-tight">Recent analyses</h3>
          <div className={`${CARD} mt-2`}>
            <Table className="min-w-[36rem]">
              <TableHeader>
                <TableRow>
                  <TableHead className="px-4">Tool</TableHead>
                  <TableHead>Ref</TableHead>
                  <TableHead>Commit</TableHead>
                  <TableHead className="text-right">Results</TableHead>
                  <TableHead className="text-right">New</TableHead>
                  <TableHead className="text-right">Fixed</TableHead>
                  <TableHead>When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="tabular-nums">
                {scanning.analyses.slice(0, 15).map((analysis) => (
                  <TableRow key={analysis.id}>
                    <TableCell className="px-4">{analysis.tool}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {analysis.pull != null ? (
                        <a href={`${base}/security/pulls/${analysis.pull}`} className="hover:underline">
                          #{analysis.pull}
                        </a>
                      ) : (
                        analysis.gitRef.replace("refs/heads/", "")
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{analysis.commitSha.slice(0, 7)}</TableCell>
                    <TableCell className="text-right">{analysis.results}</TableCell>
                    <TableCell className="text-right">{analysis.newAlerts}</TableCell>
                    <TableCell className="text-right">{analysis.fixedAlerts}</TableCell>
                    <TableCell className="text-xs text-muted">
                      <TimeAgo at={analysis.createdAt} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}
    </div>
  );
}
