import { Link, useFetcher } from "react-router";
import type { ReactNode } from "react";

import { CODE_SCANNING_GATES, type CodeScanningGate, type RepoSecuritySettings, type ReviewFailOn } from "@g1t/contracts";

import type { Route } from "./+types/security-settings";
import { page } from "../../lib/meta";
import { ActivationPrompt, CARD, SectionHeader } from "../../components/security-suite";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Hint } from "../../components/ui/hint";
import { SelectField } from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import { security, securitySuite } from "../../lib/services.server";
import { assertSameOrigin, getViewer, managesSecurity, requireUser, unwrap } from "../../lib/session.server";
import { refusal, requireInsider } from "../../lib/access.server";
import { whyNot } from "../../lib/access";
import { planPrice } from "../../lib/security-suite.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Security settings · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context) ?? requireUser(context, request);
  const { access } = await requireInsider(context, params, "push");
  const repo = { namespace: params.owner, name: params.repo };
  const [view, price] = await Promise.all([securitySuite.settings(repo, viewer), planPrice(params.owner, viewer)]);
  return { view: unwrap(view), price, can: access.can, owner: managesSecurity(viewer, params.owner) };
}

const GATES = new Set(CODE_SCANNING_GATES.map((gate) => gate.gate));
const FAIL_ON = new Set(["critical", "high", "medium", "low", "none"]);

/** The settings a form posts. */
export function settingsFrom(form: FormData): RepoSecuritySettings | string {
  const gate = String(form.get("codeScanningGate") ?? "");
  const failOn = String(form.get("reviewFailOn") ?? "");
  if (!GATES.has(gate as CodeScanningGate)) return "Choose when code scanning fails.";
  if (!FAIL_ON.has(failOn)) return "Choose when dependency review fails.";
  return {
    codeScanningGate: gate as CodeScanningGate,
    dependencyReview: form.get("dependencyReview") === "on",
    reviewFailOn: failOn as ReviewFailOn,
    reviewDenyLicenses: String(form.get("reviewDenyLicenses") ?? "")
      .split(/[\s,]+/)
      .map((id) => id.trim())
      .filter(Boolean)
      .slice(0, 50),
    reviewComment: form.get("reviewComment") === "on",
    historyAlerts: form.get("historyAlerts") === "on",
    privateVulnerabilityReporting: form.get("privateVulnerabilityReporting") === "on",
  };
}

export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const refused = await refusal(context, params, "manage_settings");
  if (refused) return { ok: false, error: refused };
  const form = await request.formData();
  const path = { namespace: params.owner, name: params.repo };
  // Security updates are a setting of their own, saved as the switch moves.
  if (form.get("intent") === "upkeep") {
    const set = await security.setUpkeep(user, path, form.get("enabled") === "true");
    return set.ok ? { ok: true } : { ok: false, error: set.error.message };
  }
  const settings = settingsFrom(form);
  if (typeof settings === "string") return { ok: false, error: settings };
  const saved = await securitySuite.setSettings(user, path, settings);
  return saved.ok ? { ok: true } : { ok: false, error: saved.error.message };
}

const SELECT = "w-full sm:w-72";

/** A setting that is on or off, with the words on what it does, as a card. */
function SettingSwitch({
  name,
  title,
  children,
  defaultChecked,
  disabled,
}: {
  name: string;
  title: string;
  children: ReactNode;
  defaultChecked: boolean;
  disabled: boolean;
}) {
  return (
    <label className={`${CARD} flex items-start justify-between gap-4 p-4 ${disabled ? "opacity-60" : ""}`}>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-1 block text-sm text-muted">{children}</span>
      </span>
      <Switch name={name} defaultChecked={defaultChecked} disabled={disabled} className="mt-0.5" />
    </label>
  );
}

export default function SecuritySettings({ loaderData, params }: Route.ComponentProps) {
  const { view, price, can, owner } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const { settings } = view;
  const disabled = !can.manage_settings || !view.entitled;
  // Free everywhere: switches that need no activation.
  const locked = !can.manage_settings;
  const upkeep = useFetcher<{ ok: boolean; error?: string }>();
  const upkeepOn = upkeep.formData ? upkeep.formData.get("enabled") === "true" : view.upkeep;
  return (
    <div className="max-w-3xl space-y-6">
      <SectionHeader
        title="Security settings"
        about="What this repository's security does on its own, and when the pull request checks its security suite reports fail. Require those checks in branch protection to block merges on them, for people and agents alike."
      />
      <section aria-labelledby="alerts-and-updates" className="space-y-3">
        <h3 id="alerts-and-updates" className="text-sm font-semibold">
          Alerts, updates and reporting
        </h3>
        <Card asChild className="flex items-start justify-between gap-4 p-4">
          <label>
            <span className="min-w-0">
              <span className="block text-sm font-medium">Security updates</span>
              <span className="mt-1 block text-sm text-muted">
                Open a pull request to upgrade each vulnerable dependency that has a fix. It lands through your branch's required checks. The same switch is on
                the Vulnerabilities page.
              </span>
              {upkeep.data?.error && <span className="mt-1 block text-xs text-danger">{upkeep.data.error}</span>}
            </span>
            <Hint label={whyNot(can, "manage_settings")} disabled={locked}>
              <Switch
                className="mt-0.5"
                checked={upkeepOn}
                disabled={upkeep.state !== "idle" || locked}
                onCheckedChange={(checked) => upkeep.submit({ intent: "upkeep", enabled: String(checked) }, { method: "post" })}
              />
            </Hint>
          </label>
        </Card>
      </section>
      {!view.entitled && <ActivationPrompt workspace={params.owner} feature="Code scanning and dependency review" monthlyCents={price} isOwner={owner} />}
      <fetcher.Form method="post" className="space-y-4">
        <fieldset disabled={locked} className="space-y-3">
          <legend className="sr-only">Alerts and reporting</legend>
          <SettingSwitch name="historyAlerts" title="Alerts for secrets in the history" defaultChecked={settings.historyAlerts} disabled={locked}>
            Secrets found in the history, and in pushes too large to scan first, open alerts and tell the workspace's owners and security managers. Off, they
            are still listed under Secret scanning but tell nobody. Push protection is always on: a push that adds a secret is refused either way.
          </SettingSwitch>
          <SettingSwitch
            name="privateVulnerabilityReporting"
            title="Private vulnerability reporting"
            defaultChecked={settings.privateVulnerabilityReporting}
            disabled={locked}
          >
            Anyone who can see this repository can report a vulnerability to its maintainers privately from its Security tab; on a public repository, without an
            account, with an email address. The owners and security managers are told at once.
          </SettingSwitch>
        </fieldset>
        <fieldset disabled={disabled} className={`${CARD} space-y-3 p-4 disabled:opacity-60`}>
          <legend className="sr-only">Code scanning</legend>
          <p className="text-sm font-medium">Code scanning results</p>
          <p className="text-sm text-muted">The Code scanning check fails when a pull request brings new results on the lines it changes at this level.</p>
          <SelectField
            name="codeScanningGate"
            defaultValue={settings.codeScanningGate}
            disabled={disabled}
            className={SELECT}
            aria-label="When code scanning fails"
            options={CODE_SCANNING_GATES.map((gate) => ({ value: gate.gate, label: gate.label }))}
          />
        </fieldset>
        <fieldset disabled={disabled} className={`${CARD} space-y-3 p-4 disabled:opacity-60`}>
          <legend className="sr-only">Dependency review</legend>
          <label className="flex items-start justify-between gap-4">
            <span>
              <span className="block text-sm font-medium">Dependency review</span>
              <span className="mt-1 block text-sm text-muted">
                Pull requests that change a lockfile get the Dependency review check, which fails when they add a package with a known vulnerability or a
                license you do not allow.
              </span>
            </span>
            <Switch name="dependencyReview" defaultChecked={settings.dependencyReview} className="mt-0.5" />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Fail on vulnerabilities of</span>
            <SelectField
              name="reviewFailOn"
              defaultValue={settings.reviewFailOn}
              disabled={disabled}
              className={SELECT}
              options={[
                { value: "critical", label: "Critical severity" },
                { value: "high", label: "High severity or higher" },
                { value: "medium", label: "Medium severity or higher" },
                { value: "low", label: "Any severity" },
                { value: "none", label: "Never fail on vulnerabilities" },
              ]}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Licenses not allowed (SPDX ids)</span>
            <input
              name="reviewDenyLicenses"
              defaultValue={settings.reviewDenyLicenses.join(", ")}
              placeholder="GPL-3.0-only, AGPL-3.0-only"
              className="h-9 w-full rounded-md border border-line bg-bg px-2.5 font-mono text-sm outline-none hover:border-line-strong focus:border-accent-dim"
            />
          </label>
          <label className="flex items-center justify-between gap-4">
            <span className="text-sm">Comment the review's summary on the pull request</span>
            <Switch name="reviewComment" defaultChecked={settings.reviewComment} />
          </label>
        </fieldset>
        <div className="flex flex-wrap items-center gap-3">
          <Hint label={whyNot(can, "manage_settings")} disabled={!can.manage_settings}>
            <Button type="submit" disabled={locked || fetcher.state !== "idle"}>
              {fetcher.state !== "idle" ? "Saving…" : "Save"}
            </Button>
          </Hint>
          <Link to={`${base}/settings/branches`} className="text-sm text-muted underline underline-offset-2 hover:text-fg">
            Require the checks in branch protection
          </Link>
          {fetcher.data?.ok && <span className="text-sm text-success">Saved.</span>}
          {fetcher.data?.error && <span className="text-sm text-danger">{fetcher.data.error}</span>}
        </div>
      </fetcher.Form>
      <p className="text-sm text-muted">
        Advisories and private reports are under{" "}
        <Link to={`${base}/security/advisories`} className="underline underline-offset-2 hover:text-fg">
          Advisories
        </Link>
        , and version updates on{" "}
        <Link to={`${base}/security/dependency-updates`} className="underline underline-offset-2 hover:text-fg">
          Dependency updates
        </Link>
        . Delegated bypass and validity checks are the workspace's, in{" "}
        <Link to={`/${params.owner}/-/settings/security`} className="underline underline-offset-2 hover:text-fg">
          its Security settings
        </Link>
        .
      </p>
    </div>
  );
}
