import { RefreshCw, ShieldCheck } from "lucide-react";
import { useFetcher, useSearchParams } from "react-router";

import type { AlertState, DismissReason } from "@g1t/contracts";

import type { Route } from "./+types/security";
import { page } from "../../lib/meta";
import {
  type PullInfo,
  ScanSummary,
  SeverityCountsGrid,
  StateFilter,
  type UpgradeFix,
  VulnerabilityList,
} from "../../components/security";
import { Hint } from "../../components/ui/hint";
import { Switch } from "../../components/ui/switch";
import { security, work } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, unwrap } from "../../lib/session.server";
import { refusal, requireInsider } from "../../lib/access.server";
import { whyNot } from "../../lib/access";
import { alertCapability, countByState, parseAlertState } from "../../lib/security-alerts";
import { severityCounts } from "../../lib/security-suite";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Vulnerabilities · ${params.owner}/${params.repo} · g1t` });
}

/** Upgrade issues and security update pull requests looked up per page, at most. */
const MAX_FIXES = 30;

export async function loader({ params, context, request }: Route.LoaderArgs) {
  // Git's refusal links here; someone signed out signs in first.
  const viewer = getViewer(context) ?? requireUser(context, request);
  // Findings are for people who can push, public project or not: Write and up.
  const { access } = await requireInsider(context, params, "security_alerts");
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
  // (Maintain); an alert is dismissed or reopened with Write, or by a
  // security manager of the workspace.
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

export default function ProjectSecurity({ loaderData, params }: Route.ComponentProps) {
  const { overview, fixes, pulls, can } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const action = `${base}/security/vulnerabilities`;
  const [search, setSearch] = useSearchParams();
  const rescan = useFetcher<{ ok: boolean; error?: string }>();
  const upkeep = useFetcher<{ ok: boolean; error?: string }>();
  const upkeepOn = upkeep.formData ? upkeep.formData.get("enabled") === "true" : overview.upkeep;
  const vulnCounts = countByState(overview.vulnerabilities);
  // A link to one alert shows it wherever it stands.
  const focus = search.get("finding");
  const focused = focus ? overview.vulnerabilities.find((vuln) => vuln.id === focus) : undefined;
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
            Vulnerabilities
          </h2>
          <p className="mt-1.5 max-w-2xl text-sm text-muted">
            Every package the lockfiles resolve is checked for known vulnerabilities, on every push to the default branch and
            daily. With security updates on, g1t opens a pull request to upgrade each one that has a fix.
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
        <SeverityCountsGrid counts={severityCounts(overview.vulnerabilities)} />
        <p className="mt-2 text-xs text-faint">Open vulnerability alerts by severity.</p>
      </div>

      <div className="mt-4">
        <ScanSummary scan={overview.scan} />
      </div>

      <div className="mt-8">
        <div>
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
        </div>
      </div>

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
            <Hint label={whyNot(can, "manage_settings")} disabled={!can.manage_settings}>
              <Switch
                className="mt-0.5"
                checked={upkeepOn}
                disabled={upkeep.state !== "idle" || !can.manage_settings}
                onCheckedChange={(checked) => upkeep.submit({ intent: "upkeep", enabled: String(checked) }, { method: "post", action })}
              />
            </Hint>
          </label>
        </div>
      </section>
    </div>
  );
}
