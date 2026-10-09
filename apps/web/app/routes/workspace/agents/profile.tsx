import { useState } from "react";
import { Form, data, redirect, useNavigation, useOutletContext } from "react-router";

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
  const form = await request.formData();
  // Archiving keeps the agent's history (runs, replies, spend) but takes it
  // out of chat and frees its handle. g1t itself can't be archived.
  if (form.get("intent") === "archive") {
    const archived = await workspaceAgents.archive(slug, params.handle.toLowerCase(), viewer).catch(() => null);
    if (!archived) return { errors: { form: "The agents service didn't answer. Try again in a moment." }, saved: false };
    if (!archived.ok) return { errors: { form: archived.error.message }, saved: false };
    throw redirect(`/${slug}/-/agents`);
  }
  const read = readAgentForm(form, { orchestrator: params.handle.toLowerCase() === "g1t" });
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
      {!isOrchestrator(agent) && <Archive name={agent.display_name} />}
    </>
  );
}

/** Retiring an agent: asked twice, since it leaves every channel at once. */
function Archive({ name }: { name: string }) {
  const [asking, setAsking] = useState(false);
  const busy = useNavigation().formData?.get("intent") === "archive";
  return (
    <section className="mt-12 border-t border-line pt-8 md:grid md:grid-cols-[14rem_1fr] md:gap-10">
      <div className="mb-4 md:mb-0">
        <h2 className="text-sm font-semibold text-fg">Archive</h2>
        <p className="mt-1 text-sm text-muted">Retire this agent. Only owners can.</p>
      </div>
      <div>
        <p className="text-sm text-muted">
          {name} stops answering, leaves every channel and DM, and its handle is free to use again. Its runs, replies and spend stay in
          the audit log and on Usage.
        </p>
        {asking ? (
          <Form method="post" className="mt-4 flex flex-wrap items-center gap-3">
            <input type="hidden" name="intent" value="archive" />
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg border border-danger/50 bg-danger/15 px-4 py-2 text-sm font-medium text-danger hover:bg-danger/25 disabled:opacity-60"
            >
              {busy ? "Archiving…" : `Archive ${name}`}
            </button>
            <button type="button" onClick={() => setAsking(false)} className="px-2 py-2 text-sm text-muted hover:text-fg">
              Keep {name}
            </button>
          </Form>
        ) : (
          <button
            type="button"
            onClick={() => setAsking(true)}
            className="mt-4 rounded-lg border border-line px-4 py-2 text-sm text-muted hover:border-danger/50 hover:text-danger"
          >
            Archive agent…
          </button>
        )}
      </div>
    </section>
  );
}
