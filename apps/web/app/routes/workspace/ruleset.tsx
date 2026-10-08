import { ArrowLeft } from "lucide-react";
import { Link, data, redirect } from "react-router";

import type { RulesetSpec } from "@g1t/contracts";

import type { Route } from "./+types/ruleset";
import { page } from "../../lib/meta";
import { EnforcementBadge, RulesetForm } from "../../components/rules";
import { newRuleset } from "../../lib/rules";
import { TimeAgo } from "../../components/ui";
import { work } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../lib/session.server";

export function meta({ params, loaderData, ...args }: Route.MetaArgs) {
  const name = loaderData?.existing?.name ?? "New ruleset";
  return page(args, { title: `${name} · Rules · ${params.owner} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const role = roleIn(viewer, params.owner);
  if (!role) throw data(null, { status: 404 });
  const editable = role === "owner";
  if (params.id === "new") {
    if (!editable) throw data("Only owners of the workspace can create its rulesets.", { status: 403 });
    return { existing: null, editable };
  }
  const found = await work.getRuleset({ workspace: params.owner }, params.id, viewer);
  if (!found.ok && found.error.code === "not_found") throw data(null, { status: 404 });
  return { existing: unwrap(found), editable };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const owner = { workspace: params.owner };
  const list = `/${params.owner}/-/rules`;
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

export default function WorkspaceRuleset({ loaderData, actionData, params }: Route.ComponentProps) {
  const { existing, editable } = loaderData;
  const list = `/${params.owner}/-/rules`;
  return (
    <div className="mx-auto max-w-4xl">
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
              Changed <TimeAgo at={existing.updated_at} /> by <span className="font-mono">{existing.updated_by}</span>.
            </>
          ) : (
            `Rules for the branches or tags of ${params.owner}'s repositories, all or some.`
          )}
        </p>
      </header>
      <RulesetForm
        key={existing?.id ?? "new"}
        initial={existing ?? newRuleset("workspace")}
        level="workspace"
        existing={existing ?? undefined}
        editable={editable}
        error={actionData && "error" in actionData ? actionData.error : null}
        backHref={list}
      />
    </div>
  );
}
