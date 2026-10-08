import { ArrowLeft } from "lucide-react";
import { Link, data, redirect } from "react-router";

import type { RulesetSpec } from "@g1t/contracts";

import type { Route } from "./+types/settings-ruleset";
import { page } from "../../lib/meta";
import { EnforcementBadge, RulesetForm } from "../../components/rules";
import { newRuleset } from "../../lib/rules";
import { TimeAgo } from "../../components/ui";
import { work } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, unwrap } from "../../lib/session.server";
import { requireCapability, requireInsider } from "../../lib/access.server";

export function meta({ params, loaderData, ...args }: Route.MetaArgs) {
  const name = loaderData?.existing?.name ?? "New ruleset";
  return page(args, { title: `${name} · Rules · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const { repo, access } = await requireInsider(context, params, "manage_protection");
  const path = { namespace: params.owner, name: params.repo };
  const seen = await work.seenChecks(path, viewer).catch(() => null);
  const base = {
    seen: seen?.ok ? seen.value : [],
    editable: access.can.manage_protection && !repo.archivedAt,
    repository: `${repo.namespace}/${repo.name}`,
  };
  if (params.id === "new") return { ...base, existing: null };
  const found = await work.getRuleset({ repo: path }, params.id, viewer);
  if (!found.ok && found.error.code === "not_found") throw data(null, { status: 404 });
  const existing = unwrap(found);
  // A workspace's ruleset is changed in the workspace's settings.
  if (existing.level === "workspace") throw redirect(`/${params.owner}/-/rules/${existing.id}`);
  return { ...base, existing };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  await requireCapability(context, params, "manage_protection");
  const form = await request.formData();
  const owner = { repo: { namespace: params.owner, name: params.repo } };
  const list = `/${params.owner}/${params.repo}/settings/rules`;
  if (form.get("intent") === "delete" && params.id !== "new") {
    const deleted = await work.deleteRuleset(user, owner, params.id);
    return deleted.ok ? redirect(list) : { error: deleted.error.message };
  }
  let ruleset: RulesetSpec;
  try {
    ruleset = JSON.parse(String(form.get("ruleset") ?? "")) as RulesetSpec;
  } catch {
    return { error: "The ruleset could not be read. Reload the page and try again." };
  }
  const saved = await work.saveRuleset(user, owner, ruleset, params.id === "new" ? undefined : params.id);
  return saved.ok ? redirect(list) : { error: saved.error.message };
}

export default function RepoRuleset({ loaderData, actionData, params }: Route.ComponentProps) {
  const { existing, seen, editable, repository } = loaderData;
  const list = `/${params.owner}/${params.repo}/settings/rules`;
  return (
    <div className="max-w-4xl">
      <header className="mb-6 border-b border-line pb-5">
        <Link to={list} className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
          <ArrowLeft size={14} /> Rules
        </Link>
        <h1 className="flex flex-wrap items-center gap-2 text-lg font-semibold tracking-tight">
          {existing ? existing.name : "New ruleset"}
          {existing && <EnforcementBadge enforcement={existing.enforcement} />}
        </h1>
        <p className="mt-1 text-sm text-muted">
          {existing ? (
            <>
              Changed <TimeAgo at={existing.updated_at} /> by <span className="font-mono">{existing.updated_by}</span>. Created by{" "}
              <span className="font-mono">{existing.created_by}</span>.
            </>
          ) : (
            "What may happen to this repository's branches or tags, and what a pull request needs before it merges."
          )}
        </p>
      </header>
      <RulesetForm
        key={existing?.id ?? "new"}
        initial={existing ?? newRuleset("repository")}
        level="repository"
        existing={existing ?? undefined}
        seen={seen}
        editable={editable}
        error={actionData && "error" in actionData ? actionData.error : null}
        backHref={list}
        repositoryLabel={repository}
      />
    </div>
  );
}
