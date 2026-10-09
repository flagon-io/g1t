import { ArrowLeft } from "lucide-react";
import { Link, data, redirect, useSearchParams } from "react-router";

import type { AgentTemplate } from "@g1t/contracts";

import type { Route } from "./+types/new";
import { AgentForm, TemplateGallery } from "../../../components/agents-mode";
import { type AgentDraft, BLANK_DRAFT, readAgentForm } from "../../../lib/agent-form";
import { channelPath } from "../../../lib/chat";
import { page } from "../../../lib/meta";
import { chat, workspaceAgents } from "../../../lib/services.server";
import { assertSameOrigin, requireUser, roleIn } from "../../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `New agent · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const templates = await workspaceAgents.templates().catch(() => null);
  return { templates };
}

/**
 * Makes the agent, then opens a direct message with it: talking to it is
 * how work starts. If chat does not answer, its page instead.
 */
export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  if (!roleIn(viewer, slug)) throw data(null, { status: 404 });
  const read = readAgentForm(await request.formData());
  if (!read.ok) return { errors: read.errors };
  const made = await workspaceAgents.create(slug, viewer, read.input).catch(() => null);
  if (!made) return { errors: { form: "The agents service didn't answer. Try again in a moment." } };
  if (!made.ok) {
    const field = made.error.code === "conflict" ? "handle" : "form";
    return { errors: { [field]: made.error.message } };
  }
  const dm = await chat.openDm(slug, viewer, [{ kind: "agent", id: made.value.id }]).catch(() => null);
  throw redirect(dm?.ok ? channelPath(slug, dm.value) : `/${slug}/-/agents/${made.value.handle}`);
}

function draftFrom(template: AgentTemplate): AgentDraft {
  return {
    ...BLANK_DRAFT,
    handle: template.handle,
    display_name: template.display_name,
    role: template.role,
    instructions: template.instructions,
    personality_preset: template.personality_preset,
    routing: template.routing,
    template: template.id,
  };
}

export default function NewAgent({ loaderData, actionData, params }: Route.ComponentProps) {
  const [search, setSearch] = useSearchParams();
  const chosen = search.get("template");
  const templates = loaderData.templates ?? [];
  const template = templates.find((t) => t.id === chosen);
  const draft = template ? draftFrom(template) : chosen === "blank" ? BLANK_DRAFT : null;
  const errors = actionData?.errors;
  return (
    <div className="pb-4">
      <Link to={`/${params.owner}/-/agents`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} />
        Agents
      </Link>
      <header className="mt-4 mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">New agent</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-muted">
          A teammate with a name, a job, a voice and a budget. Start from one of g1t's roles and make it yours, or from nothing. Once it's made, you'll be in a direct message with it.
        </p>
      </header>
      {loaderData.templates == null && (
        <p className="mb-6 rounded-lg border border-line bg-surface px-4 py-3 text-sm text-muted">
          Templates aren't available right now; the agents service didn't answer. You can still start from a blank agent.
        </p>
      )}
      <TemplateGallery
        templates={templates}
        chosen={chosen}
        onChoose={(id) => setSearch(id ? { template: id } : {}, { preventScrollReset: true, replace: true })}
      />
      {draft ? (
        <div className="mt-10 border-t border-line pt-10">
          {errors?.form && <p className="mb-6 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">{errors.form}</p>}
          <AgentForm draft={draft} errors={errors} submit="Create agent" intent="create" formKey={chosen ?? "blank"} />
        </div>
      ) : (
        <p className="mt-6 text-sm text-faint">Choose a starting point to see its settings.</p>
      )}
    </div>
  );
}
