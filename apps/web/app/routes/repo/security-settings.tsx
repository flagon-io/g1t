import { Link, useFetcher } from "react-router";

import { CODE_SCANNING_GATES, type CodeScanningGate, type RepoSecuritySettings, type ReviewFailOn } from "@g1t/contracts";

import type { Route } from "./+types/security-settings";
import { page } from "../../lib/meta";
import { ActivationPrompt, CARD, SectionHeader } from "../../components/security-suite";
import { Switch } from "../../components/ui/switch";
import { securitySuite } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../lib/session.server";
import { refusal, requireInsider } from "../../lib/access.server";
import { whyNot } from "../../lib/access";
import { activationPrice } from "../../lib/security-suite.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Security settings · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context) ?? requireUser(context, request);
  const { access } = await requireInsider(context, params, "push");
  const repo = { namespace: params.owner, name: params.repo };
  const [view, price] = await Promise.all([securitySuite.settings(repo, viewer), activationPrice(params.owner, viewer)]);
  return { view: unwrap(view), price, can: access.can, owner: roleIn(viewer, params.owner) === "owner" };
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
  };
}

export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const refused = await refusal(context, params, "manage_settings");
  if (refused) return { ok: false, error: refused };
  const settings = settingsFrom(await request.formData());
  if (typeof settings === "string") return { ok: false, error: settings };
  const saved = await securitySuite.setSettings(user, { namespace: params.owner, name: params.repo }, settings);
  return saved.ok ? { ok: true } : { ok: false, error: saved.error.message };
}

const SELECT = "h-9 w-full rounded-md border border-line bg-bg px-2.5 text-sm text-fg outline-none hover:border-line-strong focus:border-accent-dim sm:w-72";

export default function SecuritySettings({ loaderData, params }: Route.ComponentProps) {
  const { view, price, can, owner } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const { settings } = view;
  const disabled = !can.manage_settings || !view.entitled;
  return (
    <div className="max-w-3xl space-y-6">
      <SectionHeader
        title="Security settings"
        about="When the pull request checks this repository's security suite reports fail. Require them in branch protection to block merges on them, for people and agents alike."
      />
      {!view.entitled && <ActivationPrompt workspace={params.owner} feature="Code scanning and dependency review" monthlyCents={price} isOwner={owner} />}
      <fetcher.Form method="post" className="space-y-4">
        <fieldset disabled={disabled} className={`${CARD} space-y-3 p-4 disabled:opacity-60`}>
          <legend className="sr-only">Code scanning</legend>
          <p className="text-sm font-medium">Code scanning results</p>
          <p className="text-sm text-muted">The Code scanning check fails when a pull request brings new results on the lines it changes at this level.</p>
          <select name="codeScanningGate" defaultValue={settings.codeScanningGate} className={SELECT} aria-label="When code scanning fails">
            {CODE_SCANNING_GATES.map((gate) => (
              <option key={gate.gate} value={gate.gate}>
                {gate.label}
              </option>
            ))}
          </select>
        </fieldset>
        <fieldset disabled={disabled} className={`${CARD} space-y-3 p-4 disabled:opacity-60`}>
          <legend className="sr-only">Dependency review</legend>
          <label className="flex items-start justify-between gap-4">
            <span>
              <span className="block text-sm font-medium">Dependency review</span>
              <span className="mt-1 block text-sm text-muted">
                Pull requests that change a lockfile get the Dependency review check, which fails when they add a package with a
                known vulnerability or a license you do not allow.
              </span>
            </span>
            <Switch name="dependencyReview" defaultChecked={settings.dependencyReview} className="mt-0.5" />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Fail on vulnerabilities of</span>
            <select name="reviewFailOn" defaultValue={settings.reviewFailOn} className={SELECT}>
              <option value="critical">Critical severity</option>
              <option value="high">High severity or higher</option>
              <option value="medium">Medium severity or higher</option>
              <option value="low">Any severity</option>
              <option value="none">Never fail on vulnerabilities</option>
            </select>
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
          <button
            type="submit"
            disabled={disabled || fetcher.state !== "idle"}
            title={whyNot(can, "manage_settings")}
            className="rounded-md bg-fg px-3.5 py-2 text-sm font-medium text-bg hover:bg-white disabled:opacity-50"
          >
            {fetcher.state !== "idle" ? "Saving…" : "Save"}
          </button>
          <Link to={`${base}/settings/branches`} className="text-sm text-muted underline underline-offset-2 hover:text-fg">
            Require the checks in branch protection
          </Link>
          {fetcher.data?.ok && <span className="text-sm text-accent">Saved.</span>}
          {fetcher.data?.error && <span className="text-sm text-danger">{fetcher.data.error}</span>}
        </div>
      </fetcher.Form>
      <p className="text-sm text-muted">
        Security updates are on the{" "}
        <Link to={`${base}/security/vulnerabilities`} className="underline underline-offset-2 hover:text-fg">
          Vulnerabilities
        </Link>{" "}
        page, and version updates on{" "}
        <Link to={`${base}/security/dependency-updates`} className="underline underline-offset-2 hover:text-fg">
          Dependency updates
        </Link>
        . Delegated bypass and validity checks are the workspace's, in{" "}
        <Link to={`/${params.owner}/-/security/settings`} className="underline underline-offset-2 hover:text-fg">
          its Security settings
        </Link>
        .
      </p>
    </div>
  );
}
