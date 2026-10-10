/**
 * An agent's abilities at work (docs.g1t.sh/guides/agent-abilities/): what
 * the workspace has connected, the agent's level for each ability
 * (@g1t/contracts abilities.ts), and the ports that carry a call out once
 * the tool box's gate allowed it: the integrations service, an MCP server,
 * and the cards in chat that ask first, offer to connect, or request
 * something from the owners.
 *
 * Asked first: the call is kept in `agent_ability_requests` with its
 * arguments and a card is posted. Whoever may allow it (the person the
 * agent acts for, or an owner) presses Allow, the call runs as them, and
 * the agent hears the result: a session reads it at its next step
 * (cards.ts). Every refusal names its rule in the transcript, through the
 * tool's result, and in the audit log, through `refused`.
 */
import { type Ability, type AbilitySection, type AbilitySource, type McpServer, type MessageCard, type ServiceBinding, type User, chatClient, identityClient, integrationsClient, newId, notifyClient } from "@g1t/contracts";

import { CONNECTORS, connectorPath, connectorView } from "../../../packages/contracts/src/connectors.ts";
import { findAbility, resolveAbilities } from "../../../packages/contracts/src/abilities.ts";
import { abilityCard, connectCard, requestCard } from "./card-views.ts";
export { abilitiesSection, saidText } from "./abilities-prompt.ts";
import type { Definition } from "./definition.ts";
import { callMcpTool } from "./mcp-client.ts";
import { type Row, isPersonal } from "./store.ts";
import type { AbilityPorts, OutsideDone, OutsideItem } from "./tools.ts";

export type AbilityEnv = {
  DB: D1Database;
  INTEGRATIONS: ServiceBinding;
  CHAT: ServiceBinding;
  IDENTITY: ServiceBinding;
  EVENTS: ServiceBinding;
  NOTIFY?: ServiceBinding;
  /** The site's address (https://g1t.sh), for links that leave g1t. */
  SITE_URL?: string;
};

/** A call waiting to be allowed, as kept. */
export type AbilityRequestRow = {
  id: string;
  agent_id: string;
  workspace_id: string;
  workspace: string;
  channel_id: string;
  message_id: string | null;
  session_id: string | null;
  ability: string;
  tool: string;
  input: string;
  summary: string;
  asked_by: string | null;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
  result: string | null;
  created_at: string;
  updated_at: string;
};

const iso = () => new Date().toISOString();

/** The site's address, without a trailing slash. */
export function siteUrl(env: { SITE_URL?: string }): string {
  return (env.SITE_URL ?? "").trim().replace(/\/+$/, "") || "https://g1t.sh";
}

/**
 * The connector ids the workspace has connected, as the integrations
 * service lists its connections to a member. Empty when it can't say.
 */
export async function connectedConnectors(env: Pick<AbilityEnv, "INTEGRATIONS">, workspace: string, viewer: User): Promise<string[]> {
  const listed = await integrationsClient(env.INTEGRATIONS)
    .list(workspace, viewer)
    .catch(() => null);
  if (!listed?.ok) return [];
  const providers = new Set(listed.value.map((connection) => connection.provider));
  return CONNECTORS.filter((connector) => connector.provider && providers.has(connector.provider)).map((connector) => connector.id);
}

/** The agent's abilities for a turn: resolved against what is connected. */
export async function abilitiesFor(env: Pick<AbilityEnv, "INTEGRATIONS">, input: { agent: Row; definition: Definition; workspace: string; asker: User }): Promise<AbilitySection[]> {
  const connected = await connectedConnectors(env, input.workspace, input.asker);
  return resolveAbilities({ connectors: CONNECTORS, abilities: input.definition.abilities, autonomy: input.definition.autonomy, connected, personal: isPersonal(input.agent) });
}

/** Where a request's card and a session's wait point: the Abilities tab. */
export function abilitiesPath(workspace: string, handle: string): string {
  return `/${workspace}/-/agents/${handle}/abilities`;
}

const item = (c: { provider: string; key: string; title: string; url: string; status: string | null; body: string }): OutsideItem => ({ provider: c.provider, key: c.key, title: c.title, url: c.url, status: c.status, body: c.body });

const outcome = <T, U>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }, map: (value: T) => U): OutsideDone<U> =>
  result.ok ? { ok: true, value: map(result.value) } : { ok: false, code: result.error.code, message: result.error.message };

/**
 * The ports for one turn. `postCard` posts where the agent is working (a
 * reply's conversation, a session's thread) and gives the message id.
 */
export function abilityPorts(
  env: AbilityEnv,
  input: {
    agent: Row;
    workspace: string;
    channel_id: string;
    session: { id: string; title: string } | null;
    asker: { id: string | null; username: string | null };
    postCard: (card: MessageCard) => Promise<string | null>;
  },
): AbilityPorts {
  const integrations = integrationsClient(env.INTEGRATIONS);
  const { agent, workspace } = input;
  const link = `${siteUrl(env)}/${workspace}/-/chat/${input.channel_id}`;
  return {
    lookup: async (asker, reference) => outcome(await integrations.resolve(workspace, asker, reference), item),
    import: async (asker, repo, reference) =>
      outcome(await integrations.import(asker, { namespace: repo.namespace, name: repo.name }, reference, false), (v) => ({ number: v.number, item: item(v.item), created: v.created })),
    act: async (asker, reference, action, text) => {
      const signed = `${text}\n\n— ${agent.display_name} (@${agent.handle}), a g1t agent, for @${asker.username}.`;
      const done = action === "resolve" ? await integrations.close(asker, workspace, reference, signed, link) : await integrations.comment(asker, workspace, reference, signed, link);
      return outcome(done, item);
    },
    // Personal connections to Linear, Jira and Sentry aren't available yet (connectors.ts says so), so nobody has one.
    askerConnected: async () => false,
    mcp: async (server, tool, args) => {
      const done = await callMcpTool(server.url, tool.name, args);
      return done.ok ? { ok: true, value: done.text } : { ok: false, code: "error", message: done.message };
    },
    async askFirst({ ability, source, tool, args, summary, note }) {
      const id = newId("abr");
      const now = iso();
      const row: AbilityRequestRow = {
        id,
        agent_id: agent.id,
        workspace_id: agent.workspace_id,
        workspace,
        channel_id: input.channel_id,
        message_id: null,
        session_id: input.session?.id ?? null,
        ability: ability.id,
        tool,
        input: JSON.stringify(args).slice(0, 20_000),
        summary: summary.slice(0, 300),
        asked_by: input.asker.id,
        status: "pending",
        decided_by: null,
        decided_at: null,
        result: null,
        created_at: now,
        updated_at: now,
      };
      await env.DB.prepare(
        `INSERT INTO agent_ability_requests (id, agent_id, workspace_id, workspace, channel_id, session_id, ability, tool, input, summary, asked_by, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
        .bind(id, row.agent_id, row.workspace_id, row.workspace, row.channel_id, row.session_id, row.ability, row.tool, row.input, row.summary, row.asked_by, now, now)
        .run();
      const messageId = await input.postCard(abilityCard(row, { agent: agent.display_name, asker: input.asker.username, rule: `${source.name}: ${ability.label}`, level: ability.level, note, body: bodyOf(args) }));
      if (!messageId) {
        await env.DB.prepare("UPDATE agent_ability_requests SET status = 'failed', result = ?, updated_at = ? WHERE id = ?").bind("The card couldn't be posted.", iso(), id).run();
        return null;
      }
      await env.DB.prepare("UPDATE agent_ability_requests SET message_id = ? WHERE id = ?").bind(messageId, id).run();
      return id;
    },
    async connect(source, ability) {
      const connector = CONNECTORS.find((c) => c.id === source.id);
      const view = connector ? connectorView(connector, "personal") : null;
      const href = view?.href ? connectorPath(view.href, workspace) : "/settings/integrations";
      const messageId = await input.postCard(connectCard({ connector: source.name, agent: agent.display_name, ability: ability.label, asker: input.asker.username, href }));
      return messageId !== null;
    },
    async request({ connector, ability, source, why }) {
      const found = connector ? CONNECTORS.find((c) => c.id === connector) : null;
      if (!ability && !found) return false;
      const card = requestCard({
        agent: { id: agent.id, handle: agent.handle, display_name: agent.display_name },
        workspace,
        connector: found ? { id: found.id, name: found.name, available: found.status === "available" && found.scopes.includes("workspace") } : null,
        ability: ability && source ? { id: ability.id, label: `${source.name}: ${ability.label}` } : null,
        why,
        status: "open",
        by: null,
      });
      return (await input.postCard(card)) !== null;
    },
    refused({ ability, source, rule, call }) {
      recordRefusal(env, { agent, workspace, asker: input.asker.username, rule, message: `Refused "${call}": ${source.name}: ${ability.label} is ${rule.split("=")[1] ?? ability.level}.` });
    },
  };
}

/** A card's preview of what a call would write: the text of a comment or note. */
function bodyOf(args: Record<string, unknown>): string | null {
  const text = typeof args.text === "string" ? args.text.trim() : "";
  return text ? text.slice(0, 900) : null;
}

/**
 * A refusal in the workspace's audit log, by the agent, naming the rule
 * (`integration:linear:comment=never`). Never fails the turn.
 */
export function recordRefusal(env: Pick<AbilityEnv, "EVENTS">, input: { agent: Row; workspace: string; asker: string | null; rule: string; message: string }): void {
  const entry = {
    actorKind: "agent",
    actor: input.agent.handle,
    actorId: input.agent.id,
    agent: input.agent.handle,
    onBehalfOf: input.asker,
    runId: null,
    runKind: null,
    credentialId: null,
    action: "ability_refused",
    // The audit log knows the surfaces people use; an agent acts through the site on their behalf.
    surface: "web",
    workspace: input.workspace.toLowerCase(),
    repo: null,
    number: null,
    gitRef: null,
    path: `agents/${input.agent.handle}`,
    outcome: "denied",
    rule: input.rule,
    result: "refused",
    message: input.message,
    requestId: `req_${crypto.randomUUID()}`,
  };
  env.EVENTS.fetch("https://service/rpc/audit_record", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ entries: [entry] }) })
    .then((response) => {
      if (!response.ok) throw new Error(`status ${response.status}`);
    })
    .catch((error: unknown) => console.error("agents: a refusal was not written to the audit log", String(error)));
}

/** An allowed or denied call in the audit log, by the person who decided. */
export function recordDecision(env: Pick<AbilityEnv, "EVENTS">, input: { by: User; agent: Row; workspace: string; request: AbilityRequestRow; allowed: boolean }): void {
  const entry = {
    actorKind: "person",
    actor: input.by.username,
    actorId: input.by.id,
    agent: input.agent.handle,
    onBehalfOf: null,
    runId: null,
    runKind: null,
    credentialId: null,
    action: input.allowed ? "ability_allowed" : "ability_denied",
    surface: "web",
    workspace: input.workspace.toLowerCase(),
    repo: null,
    number: null,
    gitRef: null,
    path: `agents/${input.agent.handle}`,
    outcome: "allowed",
    rule: `${input.request.ability}=ask`,
    result: "ok",
    message: `${input.allowed ? "Allowed" : "Denied"} @${input.agent.handle}: ${input.request.summary}`,
    requestId: `req_${crypto.randomUUID()}`,
  };
  env.EVENTS.fetch("https://service/rpc/audit_record", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ entries: [entry] }) })
    .then((response) => {
      if (!response.ok) throw new Error(`status ${response.status}`);
    })
    .catch((error: unknown) => console.error("agents: a decision was not written to the audit log", String(error)));
}

/** Pending requests of a session: what it waits on. */
export async function pendingRequests(db: D1Database, sessionId: string): Promise<AbilityRequestRow[]> {
  const { results } = await db.prepare("SELECT * FROM agent_ability_requests WHERE session_id = ? AND status = 'pending' ORDER BY created_at").bind(sessionId).all<AbilityRequestRow>();
  return results;
}

/**
 * Runs an allowed call as `by`, the person who allowed it, with the
 * agent's abilities as they are now (a server or a connection may have
 * gone since). What the agent is told.
 */
export async function runAllowed(env: AbilityEnv, request: AbilityRequestRow, agent: Row, definition: Definition, by: User): Promise<{ ok: boolean; message: string }> {
  const sections = await abilitiesFor(env, { agent, definition, workspace: request.workspace, asker: by });
  const found = findAbility(sections, request.ability);
  if (!found) return { ok: false, message: `The ability ${request.ability} is no longer there.` };
  if (!found.source.connected) return { ok: false, message: `${found.source.name} is no longer connected.` };
  if (found.ability.level === "never") return { ok: false, message: `${found.source.name}: ${found.ability.label} is Never now.` };
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(request.input) as Record<string, unknown>;
  } catch {
    return { ok: false, message: "The call's arguments couldn't be read." };
  }
  const ports = abilityPorts(env, { agent, workspace: request.workspace, channel_id: request.channel_id, session: null, asker: { id: by.id, username: by.username }, postCard: async () => null });
  const reference = String(args.reference ?? "").trim();
  try {
    switch (request.tool) {
      case "lookup_outside": {
        const done = await ports.lookup(by, reference);
        return done.ok ? { ok: true, message: `${done.value.key}: ${done.value.title}${done.value.status ? ` [${done.value.status}]` : ""}\n${done.value.url}\n\n${done.value.body}`.slice(0, 20_000) } : { ok: false, message: done.message };
      }
      case "import_outside": {
        const repo = String(args.repo ?? "").trim().toLowerCase();
        const [namespace, name] = repo.includes("/") ? repo.split("/") : [request.workspace, repo];
        if (!namespace || !name) return { ok: false, message: "The call named no repository." };
        const done = await ports.import(by, { id: "", namespace, name, isPrivate: true, defaultBranch: "main" }, reference);
        return done.ok ? { ok: true, message: `${done.value.created ? "Opened" : "Already imported as"} ${namespace}/${name}#${done.value.number} from ${done.value.item.key}.` } : { ok: false, message: done.message };
      }
      case "act_outside": {
        const action = args.action === "resolve" ? "resolve" : "comment";
        const done = await ports.act(by, reference, action, String(args.text ?? "").trim().slice(0, 8000));
        return done.ok ? { ok: true, message: `${action === "resolve" ? "Resolved" : "Commented on"} ${done.value.key} (${done.value.url}).` } : { ok: false, message: done.message };
      }
      default: {
        // An MCP tool: `<server>__<tool>`.
        const [, serverId, ...rest] = request.ability.split(":");
        const server = (definition.abilities.mcp_servers ?? []).find((s: McpServer) => s.id === serverId);
        const tool = server?.tools.find((t) => t.name === rest.join(":"));
        if (!server || !tool) return { ok: false, message: "That MCP tool is no longer there." };
        const done = await ports.mcp(server, tool, args);
        return done.ok ? { ok: true, message: done.value.slice(0, 20_000) } : { ok: false, message: done.message };
      }
    }
  } catch (error) {
    return { ok: false, message: `It failed: ${String(error).slice(0, 200)}` };
  }
}

/** Tells the owners (and whoever asked, for a request on their behalf) that a Request card was pressed. */
export async function tellOwnersOfRequest(env: AbilityEnv, input: { workspace: string; by: User; title: string; body: string; href: string; id: string }): Promise<void> {
  if (!env.NOTIFY) return;
  const members = await identityClient(env.IDENTITY)
    .listMembers(input.workspace, input.by)
    .catch(() => null);
  if (!members?.ok) return;
  const notify = notifyClient(env.NOTIFY);
  const owners = members.value.filter((member) => member.role === "owner").slice(0, 20);
  await Promise.all(
    owners.map((owner) =>
      notify
        .notify(
          { username: owner.username },
          {
            id: `ability-request:${input.id}:${owner.username}`,
            kind: "approval",
            workspace: input.workspace,
            title: input.title,
            body: input.body,
            href: input.href,
            actor: { kind: "user", id: input.by.id, name: input.by.username, avatar: input.by.avatar ?? null, avatar_seed: null },
            created_at: iso(),
          },
        )
        .catch(() => undefined),
    ),
  );
}

/** Posts a card in a conversation as the agent; its message id, or null. */
export async function postCardAsAgent(env: Pick<AbilityEnv, "CHAT">, workspace: string, channelId: string, agentId: string, card: MessageCard, threadRoot: string | null, askedBy: string | null): Promise<string | null> {
  const posted = await chatClient(env.CHAT)
    .postAsAgent(workspace, channelId, agentId, { body: "", card, thread_root: threadRoot, asked_by: askedBy })
    .catch(() => null);
  return posted?.ok ? posted.value.id : null;
}
