import { Bot, ChevronRight, Monitor, Plug, Server } from "lucide-react";
import { data, useFetcher, useOutletContext } from "react-router";

import type { AbilityLevel, AbilitySection, AgentConnector, McpServer, User, WorkspaceAgent, WorkspaceConnector } from "@g1t/contracts";
import { MAX_MCP_SERVERS, abilitiesSummary, autonomyOfLevel, findAbility, resolveAbilities, withSetting } from "@g1t/contracts/abilities";
import { CONNECTORS, connectorPath, connectorView } from "@g1t/contracts/connectors";
import { customizePath } from "@g1t/contracts/customize";

import type { Route } from "./+types/abilities";
import { AddMcpServerDialog, McpServerCount, SourceBlock } from "../../../components/agents/abilities";
import { agentsAction, answer, readOrNull } from "../../../components/agents/actions.server";
import type { ActionResult } from "../../../components/agents/dialogs";
import { ButtonLink } from "../../../components/ui";
import { Badge } from "../../../components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../../components/ui/collapsible";
import { connectedStates } from "../../../lib/connected.server";
import type { ConnectedState } from "../../../lib/connectors";
import { workspaceAgents } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

/**
 * The workspace's connectors that reach the agent (docs.g1t.sh/guides/customize/,
 * "Connectors"), and each as an MCP server of the agent's, so its tools are
 * abilities with levels like any server's: the service does the same for a
 * turn (abilitiesWithConnectors), with the connector's id, so the levels
 * set here are the ones it reads.
 */
async function reachingConnectors(slug: string, handle: string, viewer: User): Promise<{ connectors: AgentConnector[] | null; servers: McpServer[] }> {
  const [reach, all] = await Promise.all([readOrNull(workspaceAgents.agentConnectors(slug, handle, viewer)), readOrNull(workspaceAgents.connectors(slug, viewer))]);
  const byId = new Map((all ?? []).map((connector) => [connector.id, connector]));
  const servers = (reach ?? [])
    .filter((connector) => connector.via !== "agent-only")
    .map((connector) => byId.get(connector.id))
    .filter((connector): connector is WorkspaceConnector => connector != null)
    .map((c) => ({ id: c.id, name: c.name, url: c.url, tools: c.tools, added_by: c.added_by, added_at: c.added_at, checked_at: c.checked_at, problem: c.problem }));
  return { connectors: reach, servers };
}

/**
 * What the Abilities tab needs beside the agent: who the viewer is, what
 * the workspace has connected (by connector id), where each is set up
 * or managed, and the connectors that reach the agent.
 */
export async function loader({ params, context, request }: Route.LoaderArgs): Promise<{ isOwner: boolean; viewerId: string; connected: string[]; hrefs: Record<string, string | null>; connectors: AgentConnector[] | null; servers: McpServer[] }> {
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  const role = roleIn(viewer, slug);
  if (!role) throw data(null, { status: 404 });
  const [states, reaching] = await Promise.all([connectedStates(slug, viewer).catch(() => ({}) as Record<string, ConnectedState>), reachingConnectors(slug, params.handle.toLowerCase(), viewer)]);
  const hrefs: Record<string, string | null> = {};
  for (const connector of CONNECTORS) {
    const view = connectorView(connector, "workspace");
    hrefs[connector.id] = states[connector.id]?.manage ?? (view?.href ? connectorPath(view.href, slug) : null);
  }
  return { isOwner: role === "owner", viewerId: viewer.id, connected: Object.keys(states), hrefs, ...reaching };
}

/**
 * Changes a level or whose connection (a new version of the agent, like any
 * change), or adds, refreshes or removes a server only this agent has. The
 * agents service decides who may: owners a workspace agent, its member a
 * personal one, and only owners the servers and the workspace's connection.
 */
export async function action({ params, context, request }: Route.ActionArgs): Promise<ActionResult> {
  const { viewer, slug, isOwner, form } = await agentsAction(request, context, params.owner);
  const intent = String(form.get("intent") ?? "");
  const handle = params.handle.toLowerCase();
  if (intent === "mcp_add") return answer(intent, workspaceAgents.addMcpServer(slug, handle, viewer, { name: String(form.get("name") ?? ""), url: String(form.get("url") ?? "") }));
  if (intent === "mcp_remove") return answer(intent, workspaceAgents.removeMcpServer(slug, handle, viewer, String(form.get("server") ?? "")));
  if (intent === "mcp_refresh") return answer(intent, workspaceAgents.refreshMcpServer(slug, handle, viewer, String(form.get("server") ?? "")));
  if (intent !== "level" && intent !== "credentials") return { ok: false, intent, error: "Unknown request." };
  const [current, reaching] = await Promise.all([workspaceAgents.get(slug, handle, viewer).catch(() => null), reachingConnectors(slug, handle, viewer)]);
  if (!current) return { ok: false, intent, error: "The agents service didn't answer. Try again in a moment." };
  if (!current.ok) return { ok: false, intent, error: current.error.message };
  const agent = current.value;
  const id = String(form.get("ability") ?? "");
  const abilities = { ...agent.abilities, mcp_servers: [...(agent.abilities?.mcp_servers ?? []), ...reaching.servers] };
  const sections = resolveAbilities({ connectors: CONNECTORS, abilities, autonomy: agent.autonomy, connected: CONNECTORS.map((c) => c.id), personal: agent.scope === "personal" });
  const found = findAbility(sections, id);
  if (!found) return { ok: false, intent, error: "There is no such ability." };
  if (intent === "level") {
    const level = String(form.get("level") ?? "") as AbilityLevel;
    if (!found.ability.choices.includes(level)) return { ok: false, intent, error: `${found.ability.label} can't be set to that.` };
    if (found.ability.autonomy) return answer(intent, workspaceAgents.update(slug, handle, viewer, { autonomy: { [found.ability.autonomy.key]: autonomyOfLevel(found.ability.autonomy.key, level) } }));
    return answer(intent, workspaceAgents.update(slug, handle, viewer, { abilities: { settings: withSetting(agent.abilities, id, { level }).settings } }));
  }
  const credentials = String(form.get("credentials") ?? "");
  if (credentials !== "workspace" && credentials !== "asker") return { ok: false, intent, error: "Whose connection is the workspace's or the asker's." };
  // The workspace's connection is the owners' to give.
  if (credentials === "workspace" && !isOwner) return { ok: false, intent, error: "Only the workspace's owners let an agent act as the workspace's connection." };
  return answer(intent, workspaceAgents.update(slug, handle, viewer, { abilities: { settings: withSetting(agent.abilities, id, { credentials }).settings } }));
}

const ICONS = { g1t: Bot, computer: Monitor, integration: Plug, mcp: Server } as const;

/**
 * The agent's abilities, in groups: g1t's own (always on), its computer
 * (coming), each connected integration's actions with a level and whose
 * connection, and its connectors: the workspace's that reach it (given in
 * Customize to every agent, a team of its, or it) and the servers only it
 * has, which owners add here. A summary in plain words sits at the top.
 * Owners edit a workspace agent; a member their own personal one, within
 * what owners allow.
 */
export default function AbilitiesTab({ loaderData, params }: Route.ComponentProps) {
  const agent = useOutletContext<WorkspaceAgent>();
  const { isOwner, viewerId, connected, hrefs, connectors, servers } = loaderData;
  const fetcher = useFetcher<ActionResult>({ key: `abilities-${agent.id}` });
  const personal = agent.scope === "personal";
  const canEdit = personal ? agent.personal_owner_id === viewerId : isOwner;
  const own = agent.abilities?.mcp_servers ?? [];
  const sections: AbilitySection[] = resolveAbilities({ connectors: CONNECTORS, abilities: { ...agent.abilities, mcp_servers: [...own, ...servers] }, autonomy: agent.autonomy, connected, hrefs, personal });
  const error = fetcher.state === "idle" && fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;
  const slug = params.owner;
  const reach = new Map((connectors ?? []).map((connector) => [connector.id, connector]));
  return (
    <div className="space-y-10">
      <section aria-labelledby="summary" className="max-w-3xl">
        <h2 id="summary" className="sr-only">
          In short
        </h2>
        <p className="text-base leading-relaxed text-fg">{abilitiesSummary(sections)}</p>
        <p className="mt-2 text-sm text-muted">
          Each ability runs <strong className="font-medium text-fg">alone</strong>, <strong className="font-medium text-fg">alone when the person asked for it</strong>,{" "}
          <strong className="font-medium text-fg">after asking first</strong> (a card in chat, for the person it acts for or an owner), or <strong className="font-medium text-fg">never</strong>. Every choice is enforced
          in code, and a refusal names its rule in the transcript and the audit log.
          {canEdit ? " Each change is saved as a new version." : personal ? " Its member changes these." : " Owners change these."}
        </p>
      </section>
      {error && (
        <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      {sections.map((section) => {
        const Icon = ICONS[section.group];
        const mcp = section.group === "mcp";
        return (
          <section key={section.group} aria-labelledby={`group-${section.group}`} className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <div className="flex min-w-0 items-start gap-2.5">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
                  <Icon size={15} aria-hidden />
                </span>
                <div className="min-w-0">
                  <h2 id={`group-${section.group}`} className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                    {mcp ? "Connectors" : section.title}
                    {section.group === "computer" && section.sources.every((source) => source.abilities.every((ability) => ability.status === "coming")) && <Badge tone="neutral">Coming</Badge>}
                  </h2>
                  <p className="text-sm text-muted">
                    {mcp
                      ? "MCP servers the workspace connected in Customize and gave to every agent, a team it is on, or it; and servers only it has. Each tool is a row; a tool that doesn't say it only reads counts as a write."
                      : section.about}
                  </p>
                </div>
              </div>
              {mcp && (
                <ButtonLink to={customizePath("connectors", slug)} variant="outline" size="sm">
                  Customize
                  <ChevronRight size={13} />
                </ButtonLink>
              )}
            </div>
            {section.sources.length === 0 ? (
              <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
                {!mcp
                  ? "Nothing here yet."
                  : connectors === null
                    ? "Its connectors can't be read right now."
                    : isOwner
                      ? `None yet. Connect one in Customize and make it available to ${agent.display_name}, a team it is on, or every agent.`
                      : "None reach it yet. Owners connect them in Customize."}
              </p>
            ) : (
              <div className="space-y-3">
                {section.sources.map((source) => (
                  <SourceBlock key={source.id} section={section} source={source} agent={agent} canEdit={canEdit} isOwner={isOwner} slug={slug} fetcher={fetcher} connector={reach.get(source.id) ?? null} />
                ))}
              </div>
            )}
            {mcp && (
              <Collapsible>
                <CollapsibleTrigger>
                  <ChevronRight size={14} aria-hidden />
                  Only this agent
                  <McpServerCount servers={own} max={MAX_MCP_SERVERS} />
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-line px-4 py-3 text-sm text-muted">
                  <p className="max-w-xl">
                    A server that only {agent.display_name} has, by address. Connectors for the whole workspace, a team or several agents are added in Customize → Connectors, where they sign in once and are given out.
                  </p>
                  {isOwner && <AddMcpServerDialog agentName={agent.display_name} count={own.length} max={MAX_MCP_SERVERS} />}
                </CollapsibleContent>
              </Collapsible>
            )}
          </section>
        );
      })}
    </div>
  );
}
