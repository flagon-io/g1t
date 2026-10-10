import { data, useFetcher } from "react-router";

import type { Route } from "./+types/security-settings";
import { page } from "../../lib/meta";
import { ActivationPrompt, CARD } from "../../components/security-suite";
import { WorkspaceSecurityHeading, WorkspaceSecurityTabs } from "../../components/workspace-security-tabs";
import { Switch } from "../../components/ui/switch";
import { securitySuite } from "../../lib/services.server";
import { assertSameOrigin, getViewer, managesSecurity, requireUser, roleIn, unwrap } from "../../lib/session.server";
import { planPrice } from "../../lib/security-suite.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Security settings · ${params.owner} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const role = roleIn(viewer, params.owner);
  if (!role) throw data(null, { status: 404 });
  const [view, price] = await Promise.all([securitySuite.workspaceSettings(params.owner, viewer), planPrice(params.owner, viewer)]);
  return { view: unwrap(view), price, owner: managesSecurity(viewer, params.owner) };
}

export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const saved = await securitySuite.setWorkspaceSettings(user, params.owner, {
    delegatedBypass: form.get("delegatedBypass") === "on",
    validityChecks: form.get("validityChecks") === "on",
  });
  return saved.ok ? { ok: true } : { ok: false, error: saved.error.message };
}

function Row({ name, title, about, checked, disabled }: { name: string; title: string; about: string; checked: boolean; disabled: boolean }) {
  return (
    <label className={`${CARD} flex items-start justify-between gap-4 p-4 ${disabled ? "opacity-60" : ""}`}>
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-1 block text-sm text-muted">{about}</span>
      </span>
      <Switch name={name} defaultChecked={checked} disabled={disabled} className="mt-0.5" />
    </label>
  );
}

export default function WorkspaceSecuritySettings({ loaderData, params }: Route.ComponentProps) {
  const { view, price, owner } = loaderData;
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const disabled = !owner;
  return (
    <div>
      <WorkspaceSecurityHeading title="Security settings" about="How push protection treats bypasses, and whether g1t asks secrets' issuers if they still work, in every repository of the workspace." />
      <WorkspaceSecurityTabs owner={params.owner} />
      {!view.activated && (
        <div className="mb-4">
          <ActivationPrompt workspace={params.owner} feature="Delegated bypass and validity checks" monthlyCents={price} isOwner={owner} />
        </div>
      )}
      <fetcher.Form method="post" className="space-y-3">
        <Row
          name="delegatedBypass"
          title="Delegated bypass"
          about="Someone who pushes a blocked secret asks to push it anyway, and an owner or the repository's admins approve or deny the request, told in their notifications. Off: they bypass it themselves, with a reason."
          checked={view.settings.delegatedBypass}
          disabled={disabled}
        />
        <Row
          name="validityChecks"
          title="Validity checks"
          about="Ask each secret's issuer whether it still works (GitHub, GitLab, Stripe, Slack, npm, OpenAI, Anthropic and SendGrid tokens), weekly and on request, and mark the alert active or inactive. The check is the issuer's own read-only call, over HTTPS; the secret goes nowhere else."
          checked={view.settings.validityChecks}
          disabled={disabled}
        />
        <div className="flex items-center gap-3 pt-1">
          <button type="submit" disabled={disabled || fetcher.state !== "idle"} className="rounded-md bg-fg px-3.5 py-2 text-sm font-medium text-bg hover:bg-fg-hover disabled:opacity-50">
            {fetcher.state !== "idle" ? "Saving…" : "Save"}
          </button>
          {!owner && <span className="text-sm text-muted">Only an owner can change these.</span>}
          {fetcher.data?.ok && <span className="text-sm text-success">Saved.</span>}
          {fetcher.data?.error && <span className="text-sm text-danger">{fetcher.data.error}</span>}
        </div>
      </fetcher.Form>
      <p className="mt-4 text-xs text-faint">On private repositories both come with the g1t plan; on public ones they are free.</p>
    </div>
  );
}
