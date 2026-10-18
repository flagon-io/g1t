/**
 * One security advisory: what it says, what is affected and what fixes it,
 * who found it. Admins (and security managers) publish a draft, withdraw a
 * published one, or edit it; anyone who can see the repository reads a
 * published one.
 */
import { useFetcher } from "react-router";

import type { Route } from "./+types/security-advisory";
import { page } from "../../lib/meta";
import { Markdown } from "../../components/markdown";
import { SeverityBadge } from "../../components/security";
import { SectionHeader } from "../../components/security-suite";
import { ButtonLink, TimeAgo } from "../../components/ui";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { advisories } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, unwrap } from "../../lib/session.server";
import { refusal, requireRepo } from "../../lib/access.server";
import { STATE_LABEL, STATE_TONE, advisoryStanding } from "../../lib/advisories";

export function meta({ loaderData, params, ...args }: Route.MetaArgs) {
  return page(args, { title: `${loaderData?.advisory.title ?? "Advisory"} · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const { access } = await requireRepo(context, params, "read");
  const path = { namespace: params.owner, name: params.repo };
  const advisory = unwrap(await advisories.get(path, params.id, viewer));
  return { advisory, canManage: Boolean(access.can.manage_settings) };
}

/** Publishing and withdrawing: Admin, or a security manager. */
export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const refused = await refusal(context, params, "manage_security");
  if (refused) return { ok: false, error: refused };
  const form = await request.formData();
  const state = String(form.get("state") ?? "");
  if (state !== "published" && state !== "withdrawn") return { ok: false, error: "Nothing to do." };
  const changed = await advisories.setState(user, { namespace: params.owner, name: params.repo }, params.id, state);
  return changed.ok ? { ok: true } : { ok: false, error: changed.error.message };
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:gap-4">
      <dt className="shrink-0 text-xs font-medium text-muted sm:w-40 sm:pt-0.5">{label}</dt>
      <dd className="min-w-0 text-sm wrap-break-word">{children}</dd>
    </div>
  );
}

export default function SecurityAdvisory({ loaderData, params }: Route.ComponentProps) {
  const { advisory, canManage } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const standing = advisoryStanding(advisory);
  const working = fetcher.state !== "idle";
  return (
    <div className="max-w-5xl space-y-6">
      <SectionHeader
        title={advisory.title}
        about={
          <span className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={advisory.severity} />
            <Badge tone={STATE_TONE[advisory.state]}>{STATE_LABEL[advisory.state]}</Badge>
            <span className="font-mono text-xs">{advisory.g1tsaId}</span>
            {advisory.cveId && <span className="font-mono text-xs">{advisory.cveId}</span>}
            <span>
              {standing.verb}
              {standing.at && (
                <>
                  {" "}
                  <TimeAgo at={standing.at} />
                </>
              )}
            </span>
          </span>
        }
        actions={
          canManage ? (
            <fetcher.Form method="post" className="flex flex-wrap items-center gap-2">
              <ButtonLink to={`${base}/security/advisories/${advisory.g1tsaId}/edit`} variant="outline" size="sm">
                Edit
              </ButtonLink>
              {advisory.state === "published" ? (
                <Button type="submit" name="state" value="withdrawn" variant="outline" size="sm" disabled={working}>
                  {working ? "Withdrawing…" : "Withdraw"}
                </Button>
              ) : (
                <Button type="submit" name="state" value="published" size="sm" disabled={working || !advisory.description.trim()}>
                  {working ? "Publishing…" : advisory.state === "withdrawn" ? "Publish again" : "Publish"}
                </Button>
              )}
            </fetcher.Form>
          ) : null
        }
      />
      {fetcher.data?.error && <p className="text-sm text-danger">{fetcher.data.error}</p>}
      {canManage && advisory.state === "draft" && (
        <p className="text-sm text-muted">
          A draft is seen by this repository's maintainers only.{" "}
          {advisory.description.trim() ? "Publish it when it is ready." : "Describe the vulnerability before publishing it."}
        </p>
      )}
      <Card asChild divided>
        <dl>
          {(advisory.package || advisory.ecosystem) && (
            <Fact label="Affected package">
              <span className="font-mono">{advisory.package ?? "—"}</span>
              {advisory.ecosystem && <span className="text-muted"> ({advisory.ecosystem})</span>}
            </Fact>
          )}
          {advisory.affectedVersions && (
            <Fact label="Affected versions">
              <span className="font-mono">{advisory.affectedVersions}</span>
            </Fact>
          )}
          {advisory.patchedVersions && (
            <Fact label="Patched versions">
              <span className="font-mono">{advisory.patchedVersions}</span>
            </Fact>
          )}
          {(advisory.cvssScore != null || advisory.cvssVector) && (
            <Fact label="CVSS">
              {advisory.cvssScore != null && <span className="font-medium">{advisory.cvssScore.toFixed(1)}</span>}
              {advisory.cvssVector && <span className="ml-2 font-mono text-xs text-muted">{advisory.cvssVector}</span>}
            </Fact>
          )}
          {advisory.credits.length > 0 && <Fact label="Credits">{advisory.credits.join(", ")}</Fact>}
          <Fact label="Written by">
            {advisory.createdBy}, <TimeAgo at={advisory.createdAt} />
          </Fact>
        </dl>
      </Card>
      <section aria-labelledby="advisory-description">
        <h3 id="advisory-description" className="sr-only">
          Description
        </h3>
        {advisory.description.trim() ? (
          <Card className="p-4">
            <Markdown source={advisory.description} repo={{ namespace: params.owner, name: params.repo }} />
          </Card>
        ) : (
          <p className="text-sm text-muted">No description yet.</p>
        )}
      </section>
    </div>
  );
}
