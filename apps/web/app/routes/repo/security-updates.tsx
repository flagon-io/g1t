import { ExternalLink } from "lucide-react";

import type { Route } from "./+types/security-updates";
import { page } from "../../lib/meta";
import { DependencyUpdates } from "../../components/dependency-updates";
import { SectionHeader } from "../../components/security-suite";
import { DEPENDENCY_UPDATES_DOCS } from "../../lib/dependency-updates";
import { security } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, unwrap } from "../../lib/session.server";
import { refusal, requireInsider } from "../../lib/access.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Dependency updates · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context) ?? requireUser(context, request);
  // As the rest of the Security section: Write and up.
  const { access } = await requireInsider(context, params, "push");
  const overview = unwrap(await security.overview({ namespace: params.owner, name: params.repo }, viewer));
  return { updates: overview.versionUpdates, can: access.can };
}

export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  if (String(form.get("intent") ?? "") !== "check_updates") return { ok: false, error: "Unknown action." };
  // Checking for updates now takes Write, as pushing does.
  const refused = await refusal(context, params, "push");
  if (refused) return { ok: false, error: refused };
  const checked = await security.checkUpdates(user, { namespace: params.owner, name: params.repo }, String(form.get("entry") ?? ""));
  return checked.ok ? { ok: true } : { ok: false, error: checked.error.message };
}

/** The dependency update file g1t reads, each entry's schedule, and the pull requests it opened. */
export default function SecurityDependencyUpdates({ loaderData, params }: Route.ComponentProps) {
  const { updates, can } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  return (
    <div className="max-w-5xl space-y-6">
      <SectionHeader
        title="Dependency updates"
        about={
          <>
            Pull requests that keep dependencies current on a schedule, from a <code className="text-fg-soft">dependabot.yml</code>{" "}
            file (version 2) in <code className="text-fg-soft">.g1t/</code> or <code className="text-fg-soft">.github/</code>.
            Security updates follow the same file.
          </>
        }
        actions={
          <a
            href={DEPENDENCY_UPDATES_DOCS}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm hover:border-line-strong"
          >
            How to write the file
            <ExternalLink size={12} />
          </a>
        }
      />
      <DependencyUpdates state={updates} action={`${base}/security/dependency-updates`} base={base} canCheck={can.push} titled={false} />
    </div>
  );
}
