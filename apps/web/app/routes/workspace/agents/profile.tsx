import { data, redirect, useOutletContext } from "react-router";

import type { WorkspaceAgent } from "@g1t/contracts";

import type { Route } from "./+types/profile";
import { AgentForm } from "../../../components/agents-mode";
import { isOrchestrator } from "../../../components/orchestrator";
import { readAgentForm } from "../../../lib/agent-form";
import { identity, workspaceAgents } from "../../../lib/services.server";
import { assertSameOrigin, requireUser, roleIn } from "../../../lib/session.server";

/** The workspace's teams, to put the agent on one. */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  const teams = await identity.listTeams(viewer, params.owner).catch(() => null);
  return { teams: teams?.ok ? teams.value.map((team) => ({ slug: team.slug, name: team.name })) : [] };
}

/** Saving makes a new version; every run records which one it ran. */
export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  if (!roleIn(viewer, slug)) throw data(null, { status: 404 });
  const read = readAgentForm(await request.formData(), { orchestrator: params.handle.toLowerCase() === "g1t" });
  if (!read.ok) return { errors: read.errors, saved: false };
  const saved = await workspaceAgents.update(slug, params.handle.toLowerCase(), viewer, read.input).catch(() => null);
  if (!saved) return { errors: { form: "The agents service didn't answer. Try again in a moment." }, saved: false };
  if (!saved.ok) return { errors: { [saved.error.code === "conflict" ? "handle" : "form"]: saved.error.message }, saved: false };
  // A new handle is a new address.
  if (saved.value.handle !== params.handle.toLowerCase()) throw redirect(`/${slug}/-/agents/${saved.value.handle}/profile`);
  return { errors: undefined, saved: true };
}

export default function Profile({ loaderData, actionData }: Route.ComponentProps) {
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
      <AgentForm
        draft={agent}
        errors={errors}
        submit="Save changes"
        intent="update"
        formKey={`${agent.id}:${agent.version}`}
        locked={isOrchestrator(agent)}
        teams={loaderData.teams}
        seed={agent.avatar_seed || agent.id}
      />
    </>
  );
}
