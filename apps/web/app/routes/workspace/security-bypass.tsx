import { Link, data, useFetcher, useSearchParams } from "react-router";

import type { BypassRequest } from "@g1t/contracts";

import type { Route } from "./+types/security-bypass";
import { page } from "../../lib/meta";
import { CARD, FilterSelect } from "../../components/security-suite";
import { WorkspaceSecurityHeading, WorkspaceSecurityTabs } from "../../components/workspace-security-tabs";
import { TimeAgo } from "../../components/ui";
import { Badge } from "../../components/ui/badge";
import { securitySuite } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Bypass requests · ${params.owner} · g1t` });
}

const STATES = new Set(["pending", "approved", "denied", "cancelled"]);

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const state = new URL(request.url).searchParams.get("state") ?? "pending";
  const [list, pending] = await Promise.all([
    securitySuite.bypassRequests(params.owner, viewer, STATES.has(state) ? state : null),
    securitySuite.bypassRequests(params.owner, viewer, "pending"),
  ]);
  return { requests: unwrap(list), pending: pending.ok ? pending.value.length : 0, me: viewer?.username ?? "" };
}

export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const decision = String(form.get("decision") ?? "");
  if (decision !== "approve" && decision !== "deny" && decision !== "cancel") return { ok: false, error: "Choose approve or deny." };
  const done = await securitySuite.reviewBypass(user, params.owner, String(form.get("id") ?? ""), decision, String(form.get("comment") ?? "").trim().slice(0, 500));
  return done.ok ? { ok: true } : { ok: false, error: done.error.message };
}

const STATE_TONE = { pending: "warn", approved: "accent", denied: "danger", cancelled: "neutral" } as const;

function Review({ request, mine }: { request: BypassRequest; mine: boolean }) {
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const busy = fetcher.state !== "idle";
  return (
    <fetcher.Form method="post" className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
      <input type="hidden" name="id" value={request.id} />
      {!mine && (
        <input
          name="comment"
          maxLength={500}
          placeholder="Comment (optional)"
          className="h-8 min-w-0 grow rounded-md border border-line bg-bg px-2.5 text-[0.8125rem] outline-none hover:border-line-strong focus:border-accent-dim"
        />
      )}
      <div className="flex gap-2">
        {mine ? (
          <button type="submit" name="decision" value="cancel" disabled={busy} className="rounded-md border border-line px-2.5 py-1 text-xs font-medium text-muted hover:text-fg disabled:opacity-50">
            Cancel request
          </button>
        ) : (
          <>
            <button type="submit" name="decision" value="approve" disabled={busy} className="rounded-md bg-fg px-3 py-1 text-xs font-medium text-bg hover:bg-white disabled:opacity-50">
              Approve
            </button>
            <button type="submit" name="decision" value="deny" disabled={busy} className="rounded-md border border-danger/40 px-3 py-1 text-xs font-medium text-danger hover:bg-danger/10 disabled:opacity-50">
              Deny
            </button>
          </>
        )}
      </div>
      {fetcher.data?.error && <span className="text-xs text-danger">{fetcher.data.error}</span>}
    </fetcher.Form>
  );
}

export default function BypassRequests({ loaderData, params }: Route.ComponentProps) {
  const { requests, pending, me } = loaderData;
  const [search, setSearch] = useSearchParams();
  const state = search.get("state") ?? "pending";
  return (
    <div>
      <WorkspaceSecurityHeading
        title="Bypass requests"
        about="With delegated bypass on, people who push a blocked secret ask to push it anyway, and the workspace's owners and the repository's admins decide. Each decision is recorded on the alert and in the audit log."
      />
      <WorkspaceSecurityTabs owner={params.owner} pending={pending} />
      <div className="mb-4">
        <FilterSelect
          label="State"
          value={STATES.has(state) ? state : "all"}
          options={[["pending", "Pending"], ["approved", "Approved"], ["denied", "Denied"], ["cancelled", "Cancelled"], ["all", "All"]]}
          onChange={(value) => setSearch(value === "pending" ? {} : { state: value }, { replace: true })}
        />
      </div>
      {requests.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-6 text-sm text-muted">
          No {state === "all" ? "" : `${state} `}requests. Delegated bypass is turned on in this workspace's Security settings.
        </p>
      ) : (
        <ul className="space-y-3">
          {requests.map((request) => (
            <li key={request.id} className={`${CARD} p-4`}>
              <div className="flex flex-wrap items-center gap-2">
                <Link to={`/${request.workspace}/${request.repo}/security/secret-scanning/${request.secretId}`} className="text-sm font-medium first-letter:uppercase hover:underline">
                  {request.label}
                </Link>
                <Badge tone={STATE_TONE[request.state]}>{request.state}</Badge>
                <span className="font-mono text-xs text-faint">
                  {request.repo} · {request.path}:{request.line}
                </span>
              </div>
              <p className="mt-1.5 text-sm text-muted">
                {request.requester} asked <TimeAgo at={request.createdAt} />: {request.reason.replaceAll("_", " ")}
                {request.comment && <> · “{request.comment}”</>}
              </p>
              {request.reviewer && (
                <p className="mt-1 text-xs text-faint">
                  {request.state} by {request.reviewer}
                  {request.reviewComment && <>: “{request.reviewComment}”</>}
                </p>
              )}
              {request.state === "pending" && <Review request={request} mine={request.requester.toLowerCase() === me.toLowerCase()} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
