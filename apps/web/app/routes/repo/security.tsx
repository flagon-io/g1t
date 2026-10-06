import { RefreshCw, ShieldCheck } from "lucide-react";
import { data, useFetcher, useSearchParams } from "react-router";

import type { SecretDecision } from "@g1t/contracts";

import type { Route } from "./+types/security";
import { page } from "../../lib/meta";
import { ScanSummary, SecretsList, SeverityCountsGrid, type UpgradeFix, VulnerabilityList } from "../../components/security";
import { Switch } from "../../components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { security, work } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, unwrap } from "../../lib/session.server";
import { refusal, requireInsider } from "../../lib/access.server";
import { whyNot } from "../../lib/access";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Security · ${params.owner}/${params.repo} · g1t` });
}

/** Upgrade issues looked up per page, at most. */
const MAX_FIXES = 30;

export async function loader({ params, context, request }: Route.LoaderArgs) {
  // Git's refusal links here; someone signed out signs in first.
  const viewer = getViewer(context) ?? requireUser(context, request);
  // Findings are for people who can push, public project or not: Write and up.
  const { access } = await requireInsider(context, params, "push");
  const repo = { namespace: params.owner, name: params.repo };
  const overview = unwrap(await security.overview(repo, viewer));
  const numbers = [...new Set(overview.vulnerabilities.map((vuln) => vuln.issue).filter((n): n is number => n != null))].slice(
    0,
    MAX_FIXES,
  );
  const details = await Promise.all(numbers.map((number) => work.getIssue(repo, number, viewer).catch(() => null)));
  const fixes: Record<number, UpgradeFix> = {};
  for (const found of details) {
    if (!found?.ok) continue;
    const { issue, pulls } = found.value;
    const latest = pulls.at(-1) ?? null;
    fixes[issue.number] = {
      number: issue.number,
      state: issue.state,
      resolvedBy: issue.resolvedBy,
      pull: latest ? { number: latest.number, status: latest.status, agent: latest.runtime === "hosted" ? latest.agent : null } : null,
    };
  }
  return { overview, fixes, can: access.can };
}

export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const repo = { namespace: params.owner, name: params.repo };
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  // Scanning spends compute (Write); upkeep is a setting (Maintain); allowing
  // or resolving a finding is for Admins, who manage the repository's secrets.
  const refused = await refusal(context, params, intent === "rescan" ? "run" : intent === "upkeep" ? "manage_settings" : "manage_integrations");
  if (refused) return { ok: false, error: refused };
  if (intent === "decide") {
    const decision = String(form.get("decision") ?? "") as SecretDecision;
    const decided = await security.decideSecret(user, repo, String(form.get("id") ?? ""), decision, String(form.get("reason") ?? ""));
    return decided.ok ? { ok: true } : { ok: false, error: decided.error.message };
  }
  if (intent === "rescan") {
    const scanned = await security.rescan(user, repo);
    return scanned.ok ? { ok: true } : { ok: false, error: scanned.error.message };
  }
  if (intent === "upkeep") {
    const set = await security.setUpkeep(user, repo, form.get("enabled") === "true");
    return set.ok ? { ok: true } : { ok: false, error: set.error.message };
  }
  return { ok: false, error: "Unknown action." };
}

export default function ProjectSecurity({ loaderData, params }: Route.ComponentProps) {
  const { overview, fixes, can } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const action = `${base}/security`;
  const [search, setSearch] = useSearchParams();
  const rescan = useFetcher<{ ok: boolean; error?: string }>();
  const upkeep = useFetcher<{ ok: boolean; error?: string }>();
  const upkeepOn = upkeep.formData ? upkeep.formData.get("enabled") === "true" : overview.upkeep;
  const openSecrets = overview.secrets.filter((secret) => secret.status === "open" || secret.status === "blocked").length;
  const openVulns = overview.vulnerabilities.filter((vuln) => vuln.status === "open").length;
  const focus = search.get("finding");
  const tab = search.get("tab") ?? (focus || (openSecrets > 0 && openVulns === 0) ? "secrets" : openVulns > 0 ? "dependencies" : "secrets");
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
            lockfiles resolve is checked for known vulnerabilities, and each one with a fix becomes an upgrade issue a g1t
            agent lands through checks, review and the merge queue.
          </p>
        </div>
        {can.run && <rescan.Form method="post" action={action}>
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
        </rescan.Form>}
      </div>

      <div className="mt-6">
        <SeverityCountsGrid counts={overview.counts} />
        <p className="mt-2 text-xs text-faint">Open vulnerabilities by severity. A secret that is open or blocked counts as critical.</p>
      </div>

      <div className="mt-4">
        <ScanSummary scan={overview.scan} />
      </div>

      <label className="mt-6 flex cursor-pointer items-start justify-between gap-4 rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line-strong">
        <span className="min-w-0">
          <span className="block text-sm font-medium">Upkeep agents</span>
          <span className="mt-1 block text-sm text-muted">
            Open an upgrade issue for each vulnerable package with a fix, and put a g1t agent on it. Off, findings are still
            listed here, and nothing is opened for them.
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

      <Tabs
        value={tab}
        onValueChange={(value) => {
          const next = new URLSearchParams(search);
          next.set("tab", value);
          next.delete("finding");
          setSearch(next, { replace: true, preventScrollReset: true });
        }}
        className="mt-8"
      >
        <TabsList>
          <TabsTrigger value="secrets">Secrets{openSecrets > 0 ? ` · ${openSecrets}` : ""}</TabsTrigger>
          <TabsTrigger value="dependencies">Dependencies{openVulns > 0 ? ` · ${openVulns}` : ""}</TabsTrigger>
        </TabsList>
        <TabsContent value="secrets">
          <SecretsList secrets={overview.secrets} base={base} action={action} focus={focus} decide={can.manage_integrations} />
          <p className="mt-3 text-xs text-faint">
            Not a real secret, such as a test fixture? Add <code>g1t:allow-secret</code> in a comment on its line, or allow it
            here. Allowing is recorded with your name and reason.
          </p>
        </TabsContent>
        <TabsContent value="dependencies">
          <VulnerabilityList vulnerabilities={overview.vulnerabilities} fixes={fixes} base={base} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
