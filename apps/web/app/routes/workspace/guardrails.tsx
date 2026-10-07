import { data } from "react-router";

import { RUN_KINDS } from "@g1t/contracts";

import type { Route } from "./+types/guardrails";
import { GuardrailsForm } from "../../components/guardrails";
import { usePending } from "../../components/ui";
import { settingsFromForm } from "../../lib/guardrails";
import { page } from "../../lib/meta";
import { guardrails } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Guardrails · ${params.owner} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const role = roleIn(viewer, params.owner);
  if (!role) throw data(null, { status: 404 });
  const view = await guardrails.getGuardrails(viewer, params.owner);
  return { view: unwrap(view), owner: role === "owner" };
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
  const saved = await guardrails.updateGuardrails(user, params.owner, null, settings);
  return saved.ok ? { saved: true, error: null } : { saved: false, error: saved.error.message };
}

export default function WorkspaceGuardrails({ loaderData, actionData }: Route.ComponentProps) {
  // Until the saved settings are back on the page, not just until the post is answered.
  const saving = usePending();
  return (
    <GuardrailsForm
      view={loaderData.view}
      level="workspace"
      editable={loaderData.owner}
      saving={saving}
      saved={actionData?.saved ?? false}
      error={actionData?.error}
    />
  );
}
