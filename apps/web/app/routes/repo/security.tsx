import { RefreshCw, ShieldCheck } from "lucide-react";
import { useFetcher, useSearchParams } from "react-router";

import type { AlertState, DismissReason } from "@g1t/contracts";

import type { Route } from "./+types/security";
import { page } from "../../lib/meta";
import {
  type PullInfo,
  ScanSummary,
  SecretsList,
  SeverityCountsGrid,
  StateFilter,
  type UpgradeFix,
  VersionUpdatesCard,
  VulnerabilityList,
} from "../../components/security";
import { Switch } from "../../components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { security, work } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, unwrap } from "../../lib/session.server";
import { refusal, requireInsider } from "../../lib/access.server";
import { whyNot } from "../../lib/access";
import { alertCapability, countByState, parseAlertState, tabOf } from "../../lib/security-alerts";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Security · ${params.owner}/${params.repo} · g1t` });
}

/** Upgrade issues and security update pull requests looked up per page, at most. */
const MAX_FIXES = 30;

export async function loader({ params, context, request }: Route.LoaderArgs) {
  // Git's refusal links here; someone signed out signs in first.
  const viewer = getViewer(context) ?? requireUser(context, request);
  // Findings are for people who can push, public project or not: Write and up.
  const { access } = await requireInsider(context, params, "push");
  const repo = { namespace: params.owner, name: params.repo };
  const overview = unwrap(await security.overview(repo, viewer));
  const unique = (numbers: (number | null | undefined)[]) =>
    [...new Set(numbers.filter((n): n is number => n != null))].slice(0, MAX_FIXES);
  // Security updates' pull requests, for their live status.
  const pullNumbers = unique(overview.vulnerabilities.map((vuln) => vuln.update?.pull));
  // Older upgrade issues, from before g1t opened pull requests itself.
  const issueNumbers = unique(overview.vulnerabilities.filter((vuln) => !vuln.update).map((vuln) => vuln.issue));
  const [pullDetails, issueDetails] = await Promise.all([
    Promise.all(pullNumbers.map((number) => work.getPull(repo, number, viewer).catch(() => null))),
    Promise.all(issueNumbers.map((number) => work.getIssue(repo, number, viewer).catch(() => null))),
  ]);
  const pulls: Record<number, PullInfo> = {};
  for (const found of pullDetails) {
    if (!found?.ok) continue;
    const { pull } = found.value;
    pulls[pull.number] = { number: pull.number, status: pull.status, title: pull.title };
  }
  const fixes: Record<number, UpgradeFix> = {};
  for (const found of issueDetails) {
    if (!found?.ok) continue;
    const { issue, pulls: issuePulls } = found.value;
    const latest = issuePulls.at(-1) ?? null;
    fixes[issue.number] = {
      number: issue.number,
      state: issue.state,
      resolvedBy: issue.resolvedBy,
      pull: latest ? { number: latest.number, status: latest.status, agent: latest.runtime === "hosted" ? latest.agent : null } : null,
    };
  }
  return { overview, fixes, pulls, can: access.can };
}

const DISMISS_REASONS = new Set<string>([
  "false_positive",
  "used_in_tests",
  "revoked",
  "wont_fix",
  "fix_started",
  "no_bandwidth",
  "tolerable_risk",
  "inaccurate",
  "not_used",
]);

export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const repo = { namespace: params.owner, name: params.repo };
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const id = String(form.get("id") ?? "");
  // Scanning spends compute (Write); security updates are a setting
  // (Maintain); a secret alert is dismissed or reopened by Admins, who
  // manage the repository's secrets, and a dependency alert by Write.
  const capability =
    intent === "rescan" ? "run" : intent === "upkeep" ? "manage_settings" : intent === "dismiss" || intent === "reopen" ? alertCapability(id) : null;
  if (!capability) return { ok: false, error: "Unknown action." };
  const refused = await refusal(context, params, capability);
  if (refused) return { ok: false, error: refused };
  if (intent === "dismiss") {
    const reason = String(form.get("reason") ?? "");
    if (!DISMISS_REASONS.has(reason)) return { ok: false, error: "Choose a reason." };
    const comment = String(form.get("comment") ?? "").trim().slice(0, 500);
    const dismissed = await security.dismiss(user, repo, id, reason as DismissReason, comment);
    return dismissed.ok ? { ok: true } : { ok: false, error: dismissed.error.message };
  }
  if (intent === "reopen") {
    const reopened = await security.reopen(user, repo, id);
    return reopened.ok ? { ok: true } : { ok: false, error: reopened.error.message };
  }
  if (intent === "rescan") {
    const scanned = await security.rescan(user, repo);
    return scanned.ok ? { ok: true } : { ok: false, error: scanned.error.message };
  }
  const set = await security.setUpkeep(user, repo, form.get("enabled") === "true");
  return set.ok ? { ok: true } : { ok: false, error: set.error.message };
}

function Count({ n }: { n: number }) {
  return n > 0 ? <span className="ml-1.5 rounded-full bg-line px-1.5 py-px text-[0.6875rem] tabular-nums">{n}</span> : null;
}

export default function ProjectSecurity({ loaderData, params }: Route.ComponentProps) {
  const { overview, fixes, pulls, can } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const action = `${base}/security`;
  const [search, setSearch] = useSearchParams();
  const rescan = useFetcher<{ ok: boolean; error?: string }>();
  const upkeep = useFetcher<{ ok: boolean; error?: string }>();
  const upkeepOn = upkeep.formData ? upkeep.formData.get("enabled") === "true" : overview.upkeep;
  const secretCounts = countByState(overview.secrets);
  const vulnCounts = countByState(overview.vulnerabilities);
  // A link to one alert (git's push refusal sends one) shows it wherever it stands.
  const focus = search.get("finding");
  const focused = focus
    ? (overview.secrets.find((secret) => secret.id === focus) ?? overview.vulnerabilities.find((vuln) => vuln.id === focus))
    : undefined;
  const tab =
    search.get("tab") ??
    (focus ? tabOf(focus) : secretCounts.open > 0 && vulnCounts.open === 0 ? "secrets" : vulnCounts.open > 0 ? "dependencies" : "secrets");
  const state: AlertState = search.get("state") ? parseAlertState(search.get("state")) : (focused?.state ?? "open");
  const navigate = (change: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(search);
    change(next);
    next.delete("finding");
    setSearch(next, { replace: true, preventScrollReset: true });
  };
  const setState = (value: AlertState) =>
    navigate((next) => (value === "open" ? next.delete("state") : next.set("state", value)));
  return (
    <div className="max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <ShieldCheck size={19} className="text-accent" />
            Security
          </h2>
          <p className="mt-1.5 max-w-2xl text-sm text-muted">
            Pushes that add a secret are refused before they land, and the history is scanned once. Every package the
            lockfiles resolve is checked for known vulnerabilities, and with security updates on, g1t opens a pull request to
            upgrade each one that has a fix.
          </p>
        </div>
        {can.run && (
          <rescan.Form method="post" action={action}>
            <input type="hidden" name="intent" value="rescan" />
            <button
              type="submit"
              disabled={rescan.state !== "idle"}
              className="inline-flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-sm text-fg/80 transition-colors hover:border-line-strong hover:bg-surface hover:text-fg disabled:opacity-50"
            >
              <RefreshCw size={14} className={rescan.state !== "idle" ? "animate-spin" : ""} />
              {rescan.state !== "idle" ? "Scanning…" : "Re-scan now"}
            </button>
            {rescan.data?.error && <p className="mt-1.5 text-xs text-danger">{rescan.data.error}</p>}
          </rescan.Form>
        )}
      </div>

      <div className="mt-6">
        <SeverityCountsGrid counts={overview.counts} />
        <p className="mt-2 text-xs text-faint">
          Open alerts by severity. A secret in the history that looks real counts as critical; blocked pushes and likely test
          values do not.
        </p>
      </div>

      <div className="mt-4">
        <ScanSummary scan={overview.scan} />
      </div>

      <Tabs value={tab} onValueChange={(value) => navigate((next) => next.set("tab", value))} className="mt-8">
        <TabsList>
          <TabsTrigger value="secrets">
            Secrets
            <Count n={secretCounts.open} />
          </TabsTrigger>
          <TabsTrigger value="dependencies">
            Dependencies
            <Count n={vulnCounts.open} />
          </TabsTrigger>
        </TabsList>
        <TabsContent value="secrets" className="mt-4">
          <StateFilter counts={secretCounts} value={state} onChange={setState} />
          <div className="mt-3">
            <SecretsList
              secrets={overview.secrets.filter((secret) => secret.state === state)}
              state={state}
              activity={overview.activity}
              base={base}
              action={action}
              focus={focus}
              canDismiss={can.manage_integrations}
            />
          </div>
          <p className="mt-3 text-xs text-faint">
            Not a real secret, such as a test fixture? Add <code>g1t:allow-secret</code> in a comment on its line, or dismiss the
            alert here. Dismissing takes the Admin role and is recorded with your name and reason.
          </p>
        </TabsContent>
        <TabsContent value="dependencies" className="mt-4">
          <StateFilter counts={vulnCounts} value={state} onChange={setState} />
          <div className="mt-3">
            <VulnerabilityList
              vulnerabilities={overview.vulnerabilities.filter((vuln) => vuln.state === state)}
              state={state}
              activity={overview.activity}
              fixes={fixes}
              pulls={pulls}
              upkeep={overview.upkeep}
              base={base}
              action={action}
              focus={focus}
              canDismiss={can.push}
            />
          </div>
        </TabsContent>
      </Tabs>

      <section className="mt-10" aria-labelledby="security-settings">
        <h3 id="security-settings" className="text-base font-semibold tracking-tight">
          Settings
        </h3>
        <div className="mt-3 space-y-3">
          <label className="flex cursor-pointer items-start justify-between gap-4 rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line-strong">
            <span className="min-w-0">
              <span className="block text-sm font-medium">Security updates</span>
              <span className="mt-1 block text-sm text-muted">
                Open a pull request to upgrade each vulnerable dependency that has a fix. It lands through your branch's
                required checks.
              </span>
              {upkeep.data?.error && <span className="mt-1 block text-xs text-danger">{upkeep.data.error}</span>}
            </span>
            <Switch
              className="mt-0.5"
              checked={upkeepOn}
              disabled={upkeep.state !== "idle" || !can.manage_settings}
              title={whyNot(can, "manage_settings")}
              onCheckedChange={(checked) => upkeep.submit({ intent: "upkeep", enabled: String(checked) }, { method: "post", action })}
            />
          </label>
          <VersionUpdatesCard state={overview.versionUpdates} />
        </div>
      </section>
    </div>
  );
}
