import { ArrowLeft, Lock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, data, redirect, useFetcher, useSearchParams } from "react-router";

import type { AgentProposal, AgentTemplate, DraftTurn } from "@g1t/contracts";

import type { Route } from "./+types/new";
import { AgentForm, TemplateGallery } from "../../../components/agents-mode";
import { type BuilderAnswer, CreateDraft, DescribeBox, ProposalCard, TryChat } from "../../../components/agents/builder";
import { type BuilderDefinition, readDefinition } from "../../../lib/agent-builder";
import { type AgentDraft, BLANK_DRAFT, cleanHandle, readAgentForm, readTeams } from "../../../lib/agent-form";
import { channelPath } from "../../../lib/chat";
import { page } from "../../../lib/meta";
import { chat, docs, identity, workspaceAgents } from "../../../lib/services.server";
import { assertSameOrigin, requireUser, roleIn } from "../../../lib/session.server";
import { Alert } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `New agent · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  const role = roleIn(viewer, params.owner);
  if (!role) throw data(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  const [templates, teams, spaces, policy] = await Promise.all([
    workspaceAgents.templates().catch(() => null),
    identity.listTeams(viewer, params.owner).catch(() => null),
    readingSpaces(slug, viewer),
    workspaceAgents.policy(slug, viewer).catch(() => null),
  ]);
  const owner = role === "owner";
  // Members make personal agents unless an owner turned that off; owners always may.
  const membersMay = policy?.ok ? policy.value.members_create_agents : true;
  return {
    templates,
    owner,
    mayCreate: owner || membersMay,
    // The teams the viewer may add a new agent to: owners any, a maintainer theirs.
    joinable: teams?.ok ? teams.value.filter((team) => team.can_manage).map((team) => ({ slug: team.slug, name: team.name })) : [],
    spaces,
  };
}

/** The Docs spaces the viewer can read, for an agent's required reading; none when Docs can't say. */
async function readingSpaces(slug: string, viewer: Parameters<typeof docs.sidebar>[1]): Promise<{ id: string; name: string; kind: string }[]> {
  const sidebar = await docs.sidebar(slug, viewer).catch(() => null);
  return sidebar?.ok ? sidebar.value.spaces.filter((space) => !space.archived_at).map((space) => ({ id: space.id, name: space.name, kind: space.kind })) : [];
}

const NO_ANSWER = "The agents service didn't answer. Try again in a moment.";

/**
 * Drafting from a description and trying the draft answer here; creating
 * makes the agent, then opens a direct message with it: talking to it is
 * how work starts. If chat does not answer, its page instead.
 */
export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  if (!roleIn(viewer, slug)) throw data(null, { status: 404 });
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (intent === "draft") {
    const scope = form.get("scope") === "personal" ? "personal" : form.get("scope") === "workspace" ? "workspace" : null;
    const drafted = await workspaceAgents.draft(slug, viewer, { description: String(form.get("description") ?? ""), scope }).catch(() => null);
    if (!drafted) return { intent, ok: false, error: NO_ANSWER } satisfies BuilderAnswer;
    return (drafted.ok ? { intent, ok: true, proposal: drafted.value } : { intent, ok: false, error: drafted.error.message }) satisfies BuilderAnswer;
  }
  if (intent === "try") {
    const definition = readDefinition(form.get("definition"));
    let messages: DraftTurn[] = [];
    try {
      messages = JSON.parse(String(form.get("messages") ?? "[]")) as DraftTurn[];
    } catch {
      messages = [];
    }
    if (!definition) return { intent, ok: false, error: "The draft couldn't be read. Reload and try again." } satisfies BuilderAnswer;
    const answered = await workspaceAgents.tryDraft(slug, viewer, { definition, messages }).catch(() => null);
    if (!answered) return { intent, ok: false, error: NO_ANSWER } satisfies BuilderAnswer;
    return (answered.ok ? { intent, ok: true, ...answered.value } : { intent, ok: false, error: answered.error.message }) satisfies BuilderAnswer;
  }
  let input;
  if (intent === "create_draft") {
    const definition = readDefinition(form.get("definition"));
    if (!definition) return { errors: { form: "The draft couldn't be read. Reload and try again." } };
    input = { ...definition, handle: cleanHandle(definition.handle || definition.display_name) };
  } else {
    const read = readAgentForm(form);
    if (!read.ok) return { errors: read.errors };
    input = read.input;
  }
  // Its teams: memberships, added as it is made; a personal agent joins none.
  const made = await workspaceAgents.create(slug, viewer, input, { teams: input.scope === "personal" ? [] : readTeams(form) }).catch(() => null);
  if (!made) return { errors: { form: NO_ANSWER } };
  if (!made.ok) {
    const field = made.error.code === "conflict" ? "handle" : "form";
    return { errors: { [field]: made.error.message } };
  }
  const dm = await chat.openDm(slug, viewer, [{ kind: "agent", id: made.value.id }]).catch(() => null);
  throw redirect(dm?.ok ? channelPath(slug, dm.value) : `/${slug}/-/agents/${made.value.handle}`);
}

/** A template's suggested names (`name_ideas`), when the agents service sends them. */
function ideasOf(template: AgentTemplate | undefined): string[] {
  if (!template) return [];
  return [template.display_name, ...(template.name_ideas ?? []).filter((name) => name !== template.display_name)];
}

function draftFrom(template: AgentTemplate): AgentDraft {
  // A name to enjoy first, its handle after it; the template's own name when it has none.
  const name = ideasOf(template)[0] ?? template.display_name;
  return {
    ...BLANK_DRAFT,
    handle: cleanHandle(name),
    display_name: name,
    title: template.title,
    responsibilities: template.responsibilities,
    subagents: template.subagents,
    role: template.role,
    instructions: template.instructions,
    personality_preset: template.personality_preset,
    routing: template.routing,
    template: template.id,
  };
}

/** The drafted agent as the full form takes it. */
function formDraft(d: BuilderDefinition): AgentDraft {
  return {
    ...BLANK_DRAFT,
    handle: d.handle,
    display_name: d.display_name,
    title: d.title ?? "",
    responsibilities: d.responsibilities ?? [],
    instructions: d.instructions,
    personality_preset: d.personality_preset ?? "crisp",
    personality: d.personality ?? "",
    routing: { floor: d.routing?.floor ?? null, ceiling: d.routing?.ceiling ?? null, providers: [], pinned: null },
    budget: { monthly_micros: d.budget?.monthly_micros ?? null, daily_micros: d.budget?.daily_micros ?? null, task_micros: d.budget?.task_micros ?? null },
  };
}

export default function NewAgent({ loaderData, actionData, params }: Route.ComponentProps) {
  const [search, setSearch] = useSearchParams();
  const chosen = search.get("template");
  const { owner, mayCreate } = loaderData;
  const templates = loaderData.templates ?? [];
  const template = templates.find((t) => t.id === chosen);
  const errors = actionData && "errors" in actionData ? actionData.errors : undefined;
  const drafter = useFetcher<BuilderAnswer>({ key: "agent-draft" });
  const [proposal, setProposal] = useState<AgentProposal | null>(null);
  const [definition, setDefinition] = useState<BuilderDefinition | null>(null);
  const [full, setFull] = useState(false);
  // "Add to teams" on the drafted card: memberships, posted with Create.
  const [joining, setJoining] = useState<string[]>([]);
  const handled = useRef<unknown>(null);
  useEffect(() => {
    if (drafter.state !== "idle" || !drafter.data || handled.current === drafter.data) return;
    handled.current = drafter.data;
    if (drafter.data.ok && drafter.data.intent === "draft") {
      setProposal(drafter.data.proposal);
      setDefinition({ ...drafter.data.proposal.definition, avatar_seed: drafter.data.proposal.definition.handle });
      setFull(false);
    }
  }, [drafter.state, drafter.data]);

  // A role, or every field from nothing: the form, as before.
  const formFrom = template ? draftFrom(template) : chosen === "blank" ? BLANK_DRAFT : full && definition ? formDraft(definition) : null;
  const personal = full && definition ? definition.scope === "personal" : !owner;
  const back = (
    <Link to={`/${params.owner}/-/agents`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
      <ArrowLeft size={14} />
      Agents
    </Link>
  );

  if (formFrom) {
    return (
      <div className="pb-4">
        {back}
        <header className="mt-4 mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">New agent</h1>
          <p className="mt-1.5 max-w-2xl text-sm text-muted">
            {personal ? "Your personal agent: only you can talk to it, and it spends from your budget. " : ""}Every field, as you'll find it on its profile later.{" "}
            <Button
              type="button"
              onClick={() => {
                setFull(false);
                setSearch({}, { preventScrollReset: true, replace: true });
              }}
              variant="link"
              size="inline"
              className="text-fg underline-offset-2 font-normal"
            >
              {definition ? "Back to the draft" : "Describe it instead"}
            </Button>
            .
          </p>
        </header>
        {!full && <TemplateGallery templates={templates} chosen={chosen} onChoose={(id) => setSearch(id ? { template: id } : {}, { preventScrollReset: true, replace: true })} />}
        <div className={full ? "" : "mt-10 border-t border-line pt-10"}>
          {errors?.form && (
            <Alert asChild className="mb-6 px-4 py-3">
              <p>{errors.form}</p>
            </Alert>
          )}
          <AgentForm
            draft={formFrom}
            errors={errors}
            submit="Create agent"
            intent="create"
            formKey={full ? `draft:${definition?.handle}` : (chosen ?? "blank")}
            nameIdeas={full && proposal ? [proposal.definition.display_name, ...proposal.name_ideas] : ideasOf(template)}
            joinable={loaderData.joinable}
            personal={personal}
            spaces={loaderData.spaces}
            seed={full ? definition?.avatar_seed : undefined}
            hidden={{
              scope: full && definition ? definition.scope : owner ? "workspace" : "personal",
              ...(full && definition ? { skills_off: (definition.skills_off ?? []).join(","), avatar_seed: definition.avatar_seed ?? "" } : {}),
            }}
          />
        </div>
      </div>
    );
  }

  if (proposal && definition) {
    return (
      <div className="pb-4">
        {back}
        <header className="mt-4 mb-6 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">Meet {definition.display_name || "your agent"}</h1>
            <p className="mt-1.5 max-w-2xl text-sm text-muted">
              Drafted from what you described. Change anything, try it in the test chat, and create it when it's right.{" "}
              {definition.scope === "personal" && (
                <span className="inline-flex items-center gap-1">
                  <Lock size={12} />
                  Only you will be able to talk to it.
                </span>
              )}
            </p>
          </div>
          <Button
            type="button"
            onClick={() => {
              setProposal(null);
              setDefinition(null);
            }}
            variant="link"
            size="inline"
            className="text-sm text-muted hover:text-fg font-normal"
          >
            Describe it again
          </Button>
        </header>
        {errors?.form && (
          <Alert asChild className="mb-6 px-4 py-3">
            <p>{errors.form}</p>
          </Alert>
        )}
        {errors?.handle && (
          <Alert asChild className="mb-6 px-4 py-3">
            <p>{errors.handle}</p>
          </Alert>
        )}
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
          <div className="min-w-0 space-y-4">
            <ProposalCard
              slug={params.owner.toLowerCase()}
              owner={owner}
              proposal={proposal}
              value={definition}
              onChange={setDefinition}
              joinable={loaderData.joinable}
              teams={joining}
              onTeams={setJoining}
            />
            <CreateDraft definition={definition} teams={definition.scope === "personal" ? [] : joining} onEditAll={() => setFull(true)} />
          </div>
          <div className="lg:sticky lg:top-4 lg:h-[calc(100dvh-13rem)] lg:self-start">
            <TryChat definition={definition} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pb-4">
      {back}
      <div className="mx-auto mt-8 max-w-2xl sm:mt-14">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">What should this agent do?</h1>
        <p className="mt-2 text-sm text-muted">Describe the job in a sentence or a paragraph. g1t drafts the whole agent for you to change, try and create.</p>
        {!mayCreate && (
          <Card asChild radius="lg" className="mt-5 px-4 py-3 text-sm text-muted">
            <p>
              This workspace's owners have turned off personal agents, so only owners create agents here. Ask an owner in chat if you'd like one.
            </p>
          </Card>
        )}
        {loaderData.templates == null && <p className="mt-5 rounded-lg border border-line bg-surface px-4 py-3 text-sm text-muted">Roles to start from aren't available right now; the agents service didn't answer.</p>}
        <div className="mt-6">
          <DescribeBox slug={params.owner.toLowerCase()} owner={owner} mayCreate={mayCreate} templates={templates} fetcher={drafter} />
        </div>
      </div>
    </div>
  );
}
