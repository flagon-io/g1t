import { Link, data, useNavigation } from "react-router";

import { RUN_KINDS } from "@g1t/contracts";

import type { Route } from "./+types/settings-guardrails";
import { GuardrailsForm } from "../../components/guardrails";
import { RepoSettingsTabs } from "../../components/repo-settings-tabs";
import { settingsFromForm } from "../../lib/guardrails";
import { page } from "../../lib/meta";
import { guardrails } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Guardrails · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  // Members only; to anyone else the page does not exist.
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const view = await guardrails.getGuardrails(viewer, params.owner, { namespace: params.owner, name: params.repo });
  return { view: unwrap(view) };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const current = await guardrails.getGuardrails(user, params.owner);
  if (!current.ok) return { saved: false, error: current.error.message };
  const settings = settingsFromForm(form, {
    registries: current.value.registries.map((registry) => registry.id),
    rules: current.value.rules.map((rule) => rule.id),
    kinds: RUN_KINDS,
  });
  const saved = await guardrails.updateGuardrails(user, params.owner, { namespace: params.owner, name: params.repo }, settings);
  return saved.ok ? { saved: true, error: null } : { saved: false, error: saved.error.message };
}

export default function RepoGuardrails({ loaderData, actionData, params }: Route.ComponentProps) {
  const saving = useNavigation().state === "submitting";
  const base = `/${params.owner}/${params.repo}`;
  return (
    <>
      <RepoSettingsTabs base={base} />
      <p className="mb-8 max-w-3xl text-sm text-muted">
        What g1t's agents, checks and merge queue may do in this project's sandboxes. Anything left as the
        workspace's follows the{" "}
        <Link to={`/${params.owner}/-/guardrails`} className="text-fg underline-offset-2 hover:underline">
          workspace's defaults
        </Link>
        . Changes apply to runs that start after you save.
      </p>
      <GuardrailsForm
        view={loaderData.view}
        level="project"
        editable
        saving={saving}
        saved={actionData?.saved ?? false}
        error={actionData?.error}
      />
    </>
  );
}
