import { data, redirect, useOutletContext } from "react-router";

import type { WorkspaceAgent } from "@g1t/contracts";

import type { Route } from "./+types/profile";
import { AgentForm } from "../../../components/agents-mode";
import { readAgentForm } from "../../../lib/agent-form";
import { workspaceAgents } from "../../../lib/services.server";
import { assertSameOrigin, requireUser, roleIn } from "../../../lib/session.server";

/** Saving makes a new version; every run records which one it ran. */
export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  if (!roleIn(viewer, slug)) throw data(null, { status: 404 });
  const read = readAgentForm(await request.formData());
  if (!read.ok) return { errors: read.errors, saved: false };
  const saved = await workspaceAgents.update(slug, params.handle.toLowerCase(), viewer, read.input).catch(() => null);
  if (!saved) return { errors: { form: "The agents service didn't answer. Try again in a moment." }, saved: false };
  if (!saved.ok) return { errors: { [saved.error.code === "conflict" ? "handle" : "form"]: saved.error.message }, saved: false };
  // A new handle is a new address.
  if (saved.value.handle !== params.handle.toLowerCase()) throw redirect(`/${slug}/-/agents/${saved.value.handle}/profile`);
  return { errors: undefined, saved: true };
}

export default function Profile({ actionData }: Route.ComponentProps) {
  const agent = useOutletContext<WorkspaceAgent>();
  const errors = actionData?.errors as Record<string, string> | undefined;
  return (
    <>
      {actionData?.saved && (
        <p role="status" className="mb-6 rounded-lg border border-success/30 bg-success/10 px-4 py-2.5 text-sm text-success">
          Saved as version {agent.version}.
        </p>
      )}
      {errors?.form && <p className="mb-6 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">{errors.form}</p>}
      <AgentForm draft={agent} errors={errors} submit="Save changes" intent="update" formKey={`${agent.id}:${agent.version}`} />
    </>
  );
}
