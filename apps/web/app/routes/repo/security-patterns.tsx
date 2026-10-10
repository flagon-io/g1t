import { ArrowLeft } from "lucide-react";
import { Link, data, useNavigate } from "react-router";

import type { Route } from "./+types/security-patterns";
import { page } from "../../lib/meta";
import { ActivationPrompt, PatternEditor, SectionHeader, patternFields } from "../../components/security-suite";
import { securitySuite } from "../../lib/services.server";
import { assertSameOrigin, getViewer, managesSecurity, requireUser, unwrap } from "../../lib/session.server";
import { refusal, requireInsider } from "../../lib/access.server";
import { planPrice } from "../../lib/security-suite.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Custom pattern · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context) ?? requireUser(context, request);
  await requireInsider(context, params, "manage_integrations");
  const repo = { namespace: params.owner, name: params.repo };
  const id = new URL(request.url).searchParams.get("id");
  const [list, price] = await Promise.all([securitySuite.patterns(params.owner, repo, viewer), planPrice(params.owner, viewer)]);
  const patterns = unwrap(list);
  const pattern = id ? patterns.patterns.find((found) => found.id === id && found.scope === "repository") : null;
  if (id && !pattern) throw data("No such pattern.", { status: 404 });
  return { pattern: pattern ?? null, entitled: patterns.entitled, price, owner: managesSecurity(viewer, params.owner) };
}

export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const refused = await refusal(context, params, "manage_integrations");
  if (refused) return { ok: false, error: refused };
  const repo = { namespace: params.owner, name: params.repo };
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (intent === "save_pattern") {
    const saved = await securitySuite.savePattern(user, params.owner, repo, patternFields(form));
    return saved.ok ? { ok: true, saved: saved.value } : { ok: false, error: saved.error.message };
  }
  if (intent === "dry_run") {
    const fields = patternFields(form);
    const ran = await securitySuite.dryRun(user, params.owner, repo, fields);
    return ran.ok ? { ok: true, dryRun: ran.value } : { ok: false, error: ran.error.message };
  }
  if (intent === "delete_pattern") {
    const deleted = await securitySuite.deletePattern(user, params.owner, repo, String(form.get("id") ?? ""));
    return deleted.ok ? { ok: true } : { ok: false, error: deleted.error.message };
  }
  return { ok: false, error: "Unknown action." };
}

export default function PatternPage({ loaderData, params }: Route.ComponentProps) {
  const { pattern, entitled, price, owner } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const navigate = useNavigate();
  return (
    <div className="max-w-3xl space-y-6">
      <Link to={`${base}/security/secret-scanning#patterns`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} /> Secret scanning
      </Link>
      <SectionHeader
        title={pattern ? pattern.name : "New custom pattern"}
        about="A secret format of this repository's own. Published, push protection refuses pushes that add a match, and the history is scanned again for it."
      />
      {!entitled ? (
        <ActivationPrompt workspace={params.owner} feature="Custom patterns" monthlyCents={price} isOwner={owner} />
      ) : (
        <PatternEditor
          action={`${base}/security/secret-scanning/patterns`}
          onDone={pattern ? undefined : () => navigate(`${base}/security/secret-scanning#patterns`)}
          draft={{
            id: pattern?.id,
            name: pattern?.name ?? "",
            pattern: pattern?.pattern ?? "",
            before: pattern?.before ?? "",
            after: pattern?.after ?? "",
            testStrings: (pattern?.testStrings ?? []).join("\n"),
            published: pattern?.state === "published",
          }}
        />
      )}
    </div>
  );
}
