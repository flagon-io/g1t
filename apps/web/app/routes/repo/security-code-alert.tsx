import { ArrowLeft, ExternalLink } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { Link } from "react-router";

import { CODE_DISMISS_REASONS, type DismissReason, dismissLabel } from "@g1t/contracts";

import type { Route } from "./+types/security-code-alert";
import { page } from "../../lib/meta";
import { DismissDialog, ReopenButton, SeverityBadge } from "../../components/security";
import { CARD, FixWithG1t, shortRule } from "../../components/security-suite";
import { TimeAgo } from "../../components/ui";
import { Badge } from "../../components/ui/badge";
import { securitySuite } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, unwrap } from "../../lib/session.server";
import { refusal, requireInsider } from "../../lib/access.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Code scanning alert #${params.number} · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context) ?? requireUser(context, request);
  const { access } = await requireInsider(context, params, "security_alerts");
  const repo = { namespace: params.owner, name: params.repo };
  return { detail: unwrap(await securitySuite.codeAlert(repo, Number(params.number) || 0, viewer)), can: access.can };
}

const REASONS = new Set(["false_positive", "wont_fix", "used_in_tests"]);

export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const repo = { namespace: params.owner, name: params.repo };
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const refused = await refusal(context, params, intent === "fix" ? "run" : "security_alerts");
  if (refused) return { ok: false, error: refused };
  const number = Number(params.number) || 0;
  if (intent === "dismiss") {
    const reason = String(form.get("reason") ?? "");
    if (!REASONS.has(reason)) return { ok: false, error: "Choose a reason." };
    const done = await securitySuite.setCodeAlertState(user, repo, number, "dismissed", reason as DismissReason, String(form.get("comment") ?? "").trim().slice(0, 500));
    return done.ok ? { ok: true } : { ok: false, error: done.error.message };
  }
  if (intent === "reopen") {
    const done = await securitySuite.setCodeAlertState(user, repo, number, "open", null, "");
    return done.ok ? { ok: true } : { ok: false, error: done.error.message };
  }
  if (intent === "fix") {
    const done = await securitySuite.fixAlert(user, repo, String(form.get("id") ?? ""));
    return done.ok ? { ok: true, issue: done.value.issue, message: done.value.message } : { ok: false, error: done.error.message };
  }
  return { ok: false, error: "Unknown action." };
}

export default function CodeAlertPage({ loaderData, params }: Route.ComponentProps) {
  const { detail, can } = loaderData;
  const { alert } = detail;
  const base = `/${params.owner}/${params.repo}`;
  const action = `${base}/security/code-scanning/${alert.number}`;
  const where = alert.path ? `${alert.path}${alert.startLine ? `:${alert.startLine}` : ""}` : null;
  return (
    <div className="max-w-4xl space-y-6">
      <Link to={`${base}/security/code-scanning`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} /> Code scanning
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight break-words">{alert.ruleName && alert.ruleName !== alert.ruleId ? alert.ruleName : shortRule(alert.ruleId)}</h2>
          <p className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-muted">
            <span>#{alert.number}</span>
            <SeverityBadge severity={alert.severity} />
            <Badge tone={alert.state === "open" ? "warn" : "neutral"}>{alert.state === "open" ? "Open" : alert.state === "fixed" ? "Fixed" : "Dismissed"}</Badge>
            {alert.dismissedReason && <Badge>{dismissLabel(alert.dismissedReason)}</Badge>}
            <span>{alert.tool}</span>
          </p>
        </div>
        {can.push && (
          <div className="flex items-center gap-2">
            {alert.state === "open" && can.run && <FixWithG1t id={alert.id} action={action} issue={alert.issue} base={base} />}
            {alert.state === "open" ? (
              <DismissDialog id={alert.id} title={`Dismiss alert #${alert.number}`} detail={`${where ?? alert.ruleId}`} reasons={CODE_DISMISS_REASONS} action={action} />
            ) : alert.state === "dismissed" ? (
              <ReopenButton id={alert.id} action={action} />
            ) : null}
          </div>
        )}
      </div>

      <section className={`${CARD} p-4`}>
        <p className="text-sm">{alert.message}</p>
        {where && (
          <p className="mt-2 font-mono text-xs">
            <Link to={`${base}/blob/${alert.lastCommit}/${alert.path}#L${alert.startLine ?? 1}`} className="text-fg-soft hover:underline">
              {where}
            </Link>
            <span className="text-faint"> at {alert.lastCommit.slice(0, 7)}</span>
          </p>
        )}
        <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-faint">
          <span className="font-mono break-all">{alert.ruleId}</span>
          <span>
            first found <TimeAgo at={alert.createdAt} />
          </span>
          {alert.fixedAt && (
            <span>
              fixed <TimeAgo at={alert.fixedAt} />
            </span>
          )}
          {alert.tags.length > 0 && <span>{alert.tags.slice(0, 6).join(", ")}</span>}
        </p>
        {alert.dismissedBy && (
          <p className="mt-2 text-sm text-muted">
            Dismissed by {alert.dismissedBy}
            {alert.dismissedComment && <>: “{alert.dismissedComment}”</>}
          </p>
        )}
      </section>

      {(alert.help || alert.ruleDescription) && (
        <section>
          <h3 className="text-base font-semibold tracking-tight">About this rule</h3>
          <div className="prose-g1t mt-2 text-sm text-muted [&_a]:underline [&_p]:mt-2">
            <ReactMarkdown>{alert.help ?? alert.ruleDescription ?? ""}</ReactMarkdown>
          </div>
          {alert.helpUri && (
            <a href={alert.helpUri} className="mt-2 inline-flex items-center gap-1 text-sm text-muted hover:text-fg" rel="noreferrer">
              The rule's documentation <ExternalLink size={12} />
            </a>
          )}
        </section>
      )}

      {detail.analyses.length > 0 && (
        <section>
          <h3 className="text-base font-semibold tracking-tight">Reported by</h3>
          <ul className={`${CARD} mt-2 divide-y divide-line`}>
            {detail.analyses.map((analysis) => (
              <li key={analysis.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                <span>{analysis.tool}</span>
                <span className="font-mono text-xs text-muted">
                  {analysis.pull != null ? `pull request #${analysis.pull}` : analysis.gitRef.replace("refs/heads/", "")} · {analysis.commitSha.slice(0, 7)}
                </span>
                <span className="text-xs text-faint">
                  <TimeAgo at={analysis.createdAt} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
