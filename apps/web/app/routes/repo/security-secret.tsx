import { ArrowLeft, RefreshCw } from "lucide-react";
import { Link, useFetcher } from "react-router";

import { SECRET_DISMISS_REASONS, dismissLabel, type DismissReason } from "@g1t/contracts";

import type { Route } from "./+types/security-secret";
import { page } from "../../lib/meta";
import { DismissDialog, ReopenButton } from "../../components/security";
import { BypassForm, CARD, FixWithG1t } from "../../components/security-suite";
import { TimeAgo } from "../../components/ui";
import { Badge } from "../../components/ui/badge";
import { security, securitySuite } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, unwrap } from "../../lib/session.server";
import { refusal, requireInsider } from "../../lib/access.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Secret alert · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  // Git's refusal links here; someone signed out signs in first.
  const viewer = getViewer(context) ?? requireUser(context, request);
  const { access } = await requireInsider(context, params, "security_alerts");
  const repo = { namespace: params.owner, name: params.repo };
  const [detail, settings] = await Promise.all([securitySuite.secretAlert(repo, params.id, viewer), securitySuite.settings(repo, viewer)]);
  return { detail: unwrap(detail), settings: settings.ok ? settings.value : null, can: access.can };
}

const REASONS = new Set(["false_positive", "used_in_tests", "revoked", "wont_fix"]);
const BYPASS = new Set(["false_positive", "used_in_tests", "will_fix_later"]);

export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const repo = { namespace: params.owner, name: params.repo };
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const id = params.id;
  const comment = String(form.get("comment") ?? "").trim().slice(0, 500);
  const capability = intent === "dismiss" || intent === "reopen" ? "security_alerts" : intent === "fix" ? "run" : "security_alerts";
  const refused = await refusal(context, params, capability);
  if (refused) return { ok: false, error: refused };
  if (intent === "dismiss") {
    const reason = String(form.get("reason") ?? "");
    if (!REASONS.has(reason)) return { ok: false, error: "Choose a reason." };
    const done = await security.dismiss(user, repo, id, reason as DismissReason, comment);
    return done.ok ? { ok: true } : { ok: false, error: done.error.message };
  }
  if (intent === "reopen") {
    const done = await security.reopen(user, repo, id);
    return done.ok ? { ok: true } : { ok: false, error: done.error.message };
  }
  if (intent === "bypass") {
    const reason = String(form.get("reason") ?? "");
    if (!BYPASS.has(reason)) return { ok: false, error: "Choose a reason." };
    const done = await securitySuite.bypass(user, repo, id, reason as "false_positive", comment);
    return done.ok ? { ok: true, requested: Boolean(done.value.request) } : { ok: false, error: done.error.message };
  }
  if (intent === "validity") {
    const done = await securitySuite.checkValidity(user, repo, id);
    return done.ok ? { ok: true } : { ok: false, error: done.error.message };
  }
  if (intent === "fix") {
    const done = await securitySuite.fixAlert(user, repo, id);
    return done.ok ? { ok: true, issue: done.value.issue, message: done.value.message } : { ok: false, error: done.error.message };
  }
  return { ok: false, error: "Unknown action." };
}

const VALIDITY: Record<string, { label: string; tone: "danger" | "neutral" | "info"; about: string }> = {
  active: { label: "Active", tone: "danger", about: "Its issuer says it still works: rotate it." },
  inactive: { label: "Inactive", tone: "neutral", about: "Its issuer refused it: revoked, expired or never real." },
  unknown: { label: "Unknown", tone: "info", about: "Its issuer could not say, or it never landed and cannot be read again." },
  unsupported: { label: "No check", tone: "neutral", about: "There is no safe way to ask this kind of secret's issuer." },
};

function ValidityCheck({ action, checkable, enabled }: { action: string; checkable: boolean; enabled: boolean }) {
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  if (!checkable) return <p className="text-xs text-muted">This kind of secret has no safe check with its issuer.</p>;
  if (!enabled) return <p className="text-xs text-muted">Validity checks are off for this workspace. An owner can turn them on in its Security settings.</p>;
  return (
    <span className="flex flex-col gap-1">
      <button
        type="button"
        disabled={fetcher.state !== "idle"}
        onClick={() => fetcher.submit({ intent: "validity" }, { method: "post", action })}
        className="inline-flex w-fit items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-xs font-medium text-muted hover:border-line-strong hover:text-fg disabled:opacity-50"
      >
        <RefreshCw size={12} className={fetcher.state !== "idle" ? "animate-spin" : ""} />
        {fetcher.state !== "idle" ? "Asking…" : "Check with its issuer"}
      </button>
      {fetcher.data?.error && <span className="text-xs text-danger">{fetcher.data.error}</span>}
    </span>
  );
}

export default function SecretAlert({ loaderData, params }: Route.ComponentProps) {
  const { detail, settings, can } = loaderData;
  const { secret } = detail;
  const base = `/${params.owner}/${params.repo}`;
  const action = `${base}/security/secret-scanning/${secret.id}`;
  const landed = secret.status !== "blocked";
  const validity = VALIDITY[secret.validity ?? "unknown"];
  const pending = detail.requests.find((request) => request.state === "pending");
  return (
    <div className="max-w-4xl space-y-6">
      <Link to={`${base}/security/secret-scanning`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} /> Secret scanning
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight first-letter:uppercase">{secret.label}</h2>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
            <Badge tone={secret.state === "open" ? (secret.status === "blocked" ? "warn" : "danger") : "neutral"}>
              {secret.status === "blocked" ? "Blocked at a push" : secret.state === "open" ? "Open" : secret.state === "fixed" ? "Revoked" : "Dismissed"}
            </Badge>
            {secret.dismissedReason && <Badge>{dismissLabel(secret.dismissedReason)}</Badge>}
            {secret.bypass && <Badge tone="warn">Bypassed</Badge>}
            <span className="font-mono text-xs">{secret.preview}</span>
          </p>
        </div>
        {can.manage_integrations && (
          <div className="flex items-center gap-2">
            {landed && secret.state === "open" && can.run && <FixWithG1t id={secret.id} action={action} issue={null} base={base} />}
            {secret.state === "open" ? (
              <DismissDialog id={secret.id} title={`Dismiss ${secret.label}`} detail={`${secret.path}:${secret.line} · ${secret.preview}`} reasons={SECRET_DISMISS_REASONS} action={action} />
            ) : (
              <ReopenButton id={secret.id} action={action} />
            )}
          </div>
        )}
      </div>

      {secret.status === "blocked" && !secret.bypass && (detail.canBypass || detail.canRequestBypass) && (
        <section className={`${CARD} p-4`}>
          <h3 className="text-sm font-semibold">{detail.canRequestBypass ? "Ask to push it anyway" : "Push it anyway"}</h3>
          <p className="mt-1 mb-3 text-sm text-muted">
            {detail.canRequestBypass
              ? "This workspace asks an owner or the repository's admins to approve each bypass. They are told in their notifications."
              : "Take it out of the commit and push again if you can. If it has to go through, say why."}
          </p>
          {pending ? (
            <p className="text-sm text-muted">
              {pending.requester} asked <TimeAgo at={pending.createdAt} /> ({pending.reason.replaceAll("_", " ")}). Waiting for a review.
            </p>
          ) : (
            <BypassForm id={secret.id} action={action} request={detail.canRequestBypass} />
          )}
        </section>
      )}

      <section className={`${CARD} grid gap-4 p-4 sm:grid-cols-2`}>
        <div>
          <h3 className="text-xs font-medium text-muted">Validity</h3>
          <p className="mt-1 flex items-center gap-2 text-sm">
            <Badge tone={validity.tone}>{validity.label}</Badge>
            {secret.validityCheckedAt && (
              <span className="text-xs text-faint">
                asked <TimeAgo at={secret.validityCheckedAt} />
              </span>
            )}
          </p>
          <p className="mt-1 text-xs text-muted">{validity.about}</p>
          <div className="mt-2">
            <ValidityCheck action={action} checkable={detail.checkable && landed} enabled={Boolean(settings?.workspace.validityChecks && settings.entitled)} />
          </div>
        </div>
        <div>
          <h3 className="text-xs font-medium text-muted">Found</h3>
          <p className="mt-1 text-sm">
            {secret.source === "push" ? "In a push" : "In the history"}
            {secret.foundBy && <> by {secret.foundBy}</>}, <TimeAgo at={secret.foundAt} />
          </p>
          {secret.bypass && (
            <p className="mt-2 text-sm text-muted">
              Bypassed by {secret.bypass.by} <TimeAgo at={secret.bypass.at} />: {secret.bypass.reason.replaceAll("_", " ")}
              {secret.bypass.approvedBy && <>, approved by {secret.bypass.approvedBy}</>}
              {secret.bypass.comment && <> · “{secret.bypass.comment}”</>}
            </p>
          )}
        </div>
      </section>

      <section>
        <h3 className="text-base font-semibold tracking-tight">Locations</h3>
        <ul className={`${CARD} mt-2 divide-y divide-line`}>
          {(detail.locations.length ? detail.locations : [{ path: secret.path, line: secret.line, commit: secret.commit, source: secret.source, foundAt: secret.foundAt }]).map((location) => (
            <li key={`${location.commit}:${location.path}:${location.line}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
              {landed ? (
                <Link to={`${base}/blob/${location.commit}/${location.path}#L${location.line}`} className="font-mono text-xs hover:underline">
                  {location.path}:{location.line}
                </Link>
              ) : (
                <span className="font-mono text-xs">
                  {location.path}:{location.line}
                </span>
              )}
              <span className="font-mono text-xs text-faint">{location.commit.slice(0, 7)}</span>
              <span className="text-xs text-faint">{location.source === "push" ? "push" : "history"}</span>
            </li>
          ))}
        </ul>
      </section>

      {(detail.activity.length > 0 || detail.requests.length > 0) && (
        <section>
          <h3 className="text-base font-semibold tracking-tight">Activity</h3>
          <ul className="mt-2 space-y-1.5 text-sm text-muted">
            {detail.requests.map((request) => (
              <li key={request.id}>
                {request.requester} asked to bypass ({request.reason.replaceAll("_", " ")}) <TimeAgo at={request.createdAt} />
                {request.state !== "pending" && (
                  <>
                    {" "}· {request.state}
                    {request.reviewer && <> by {request.reviewer}</>}
                  </>
                )}
              </li>
            ))}
            {detail.activity.map((entry) => (
              <li key={entry.id}>
                {entry.actor ?? "g1t"} {entry.action.replaceAll("_", " ")}
                {entry.reason && <> ({dismissLabel(entry.reason)})</>}
                {entry.comment && <> · “{entry.comment}”</>} <TimeAgo at={entry.at} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
