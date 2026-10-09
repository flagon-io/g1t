/**
 * The agents service: a workspace's own agents (docs/WORKSPACE.md,
 * "Agents"). Their definitions and every version of them, the templates
 * they start from, each agent's desk, and their replies in chat.
 *
 * `@g1t`, the platform's own agent, is not one of these.
 *
 * Reached through service bindings: `POST /rpc/<method>`, with snake_case
 * JSON (@g1t/contracts workspace-agents.ts).
 */
import {
  type AgentDelivery,
  type NewWorkspaceAgent,
  type Result,
  type ServiceBinding,
  type User,
  type WorkspaceAgent,
  UNVERIFIED,
  awaitsConfirmation,
  fail,
  identityClient,
  newId,
  ok,
  openD1,
} from "@g1t/contracts";

import { MANAGE_REFUSAL, canManage, canSee } from "./access.ts";
import { type Definition, applyChanges } from "./definition.ts";
import type { Desk } from "./desk.ts";
import type { ReplyEnv } from "./reply.ts";
import { type Row, definitionOf, periods, selectAgents, toAgent } from "./store.ts";
import { TEMPLATES, TEMPLATE_IDS } from "./templates.ts";

export { Desk } from "./desk.ts";

type Env = ReplyEnv & {
  IDENTITY: ServiceBinding;
  /** The audit log. */
  EVENTS: ServiceBinding;
  DESKS: DurableObjectNamespace<Desk>;
};

/** Workspace ids by slug, kept a minute: every call names a workspace by slug. */
const workspaceIds = new Map<string, { id: string | null; until: number }>();

class Agents {
  private readonly env: Env;
  private readonly db: D1Database;
  private readonly defer: (work: Promise<unknown>) => void;

  // Plain fields, not parameter properties: Node's type stripping does not take those.
  constructor(env: Env, defer: (work: Promise<unknown>) => void) {
    this.env = env;
    this.db = env.DB;
    this.defer = defer;
  }

  private async workspaceId(slug: string): Promise<string | null> {
    const key = slug.toLowerCase();
    const kept = workspaceIds.get(key);
    if (kept && kept.until > Date.now()) return kept.id;
    const workspace = await identityClient(this.env.IDENTITY).getWorkspace(key);
    if (workspaceIds.size > 5_000) workspaceIds.clear();
    workspaceIds.set(key, { id: workspace?.id ?? null, until: Date.now() + 60_000 });
    return workspace?.id ?? null;
  }

  /** The workspace's id, if the viewer may see its agents. */
  private async seen(workspace: string, viewer: User | null): Promise<Result<string>> {
    if (!canSee(viewer, workspace)) return fail("not_found", "There is no such workspace.");
    const id = await this.workspaceId(workspace);
    return id ? ok(id) : fail("not_found", "There is no such workspace.");
  }

  /** The workspace's id, if the viewer may change its agents. */
  private async managed(workspace: string, viewer: User | null): Promise<Result<string>> {
    if (awaitsConfirmation(viewer)) return UNVERIFIED;
    const seen = await this.seen(workspace, viewer);
    if (!seen.ok) return seen;
    return canManage(viewer, workspace) ? seen : fail("forbidden", MANAGE_REFUSAL);
  }

  private async row(workspaceId: string, handle: unknown): Promise<Row | null> {
    if (typeof handle !== "string") return null;
    const now = new Date();
    return this.db
      .prepare(selectAgents("a.workspace_id = ?3 AND a.handle = ?4 AND a.archived_at IS NULL"))
      .bind(...periods(now), workspaceId, handle.trim().replace(/^@/, "").toLowerCase())
      .first<Row>();
  }

  private async handleTaken(workspaceId: string, handle: string, except: string | null): Promise<boolean> {
    const found = await this.db
      .prepare("SELECT id FROM agents WHERE workspace_id = ? AND handle = ? AND archived_at IS NULL")
      .bind(workspaceId, handle)
      .first<{ id: string }>();
    return !!found && found.id !== except;
  }

  async list(a: { workspace: string; viewer: User | null }): Promise<Result<WorkspaceAgent[]>> {
    const seen = await this.seen(a.workspace, a.viewer);
    if (!seen.ok) return seen;
    const now = new Date();
    const rows = await this.db
      .prepare(`${selectAgents("a.workspace_id = ?3 AND a.archived_at IS NULL")} ORDER BY a.handle`)
      .bind(...periods(now), seen.value)
      .all<Row>();
    return ok(rows.results.map((row) => toAgent(row, now)));
  }

  async get(a: { workspace: string; handle: string; viewer: User | null }): Promise<Result<WorkspaceAgent>> {
    const seen = await this.seen(a.workspace, a.viewer);
    if (!seen.ok) return seen;
    const row = await this.row(seen.value, a.handle);
    return row ? ok(toAgent(row, new Date())) : fail("not_found", `There is no agent called @${a.handle}.`);
  }

  /** Internal: agents by id, archived ones too, so old messages still show who wrote them. */
  async byIds(a: { ids: string[] }): Promise<WorkspaceAgent[]> {
    const ids = [...new Set((Array.isArray(a.ids) ? a.ids : []).filter((id) => typeof id === "string"))].slice(0, 100);
    if (!ids.length) return [];
    const now = new Date();
    const rows = await this.db
      .prepare(selectAgents(`a.id IN (${ids.map((_, i) => `?${i + 3}`).join(", ")})`))
      .bind(...periods(now), ...ids)
      .all<Row>();
    return rows.results.map((row) => toAgent(row, now));
  }

  async create(a: { workspace: string; viewer: User | null; input: NewWorkspaceAgent }): Promise<Result<WorkspaceAgent>> {
    const managed = await this.managed(a.workspace, a.viewer);
    if (!managed.ok) return managed;
    const checked = applyChanges(null, a.input, TEMPLATE_IDS);
    if (!checked.ok) return fail("invalid", checked.message);
    const definition = checked.value;
    if (await this.handleTaken(managed.value, definition.handle, null)) {
      return fail("conflict", `${a.workspace} already has an agent called @${definition.handle}.`);
    }
    const now = new Date().toISOString();
    const id = newId("agt");
    const by = a.viewer!.username;
    try {
      await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO agents (id, workspace_id, handle, display_name, avatar, role, instructions, personality_preset, personality,
               routing, budget, autonomy, capacity, template, version, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
          )
          .bind(...this.columns(id, managed.value, definition), by, now, now),
        this.versionStatement(id, 1, definition, by, now),
      ]);
    } catch (error) {
      if (String(error).includes("UNIQUE")) return fail("conflict", `${a.workspace} already has an agent called @${definition.handle}.`);
      throw error;
    }
    this.audit(a.viewer!, a.workspace, "create_agent", definition.handle, `Created @${definition.handle} (version 1)`);
    const row = await this.row(managed.value, definition.handle);
    return ok(toAgent(row!, new Date()));
  }

  async update(a: { workspace: string; handle: string; viewer: User | null; changes: Partial<NewWorkspaceAgent> }): Promise<Result<WorkspaceAgent>> {
    const managed = await this.managed(a.workspace, a.viewer);
    if (!managed.ok) return managed;
    const row = await this.row(managed.value, a.handle);
    if (!row) return fail("not_found", `There is no agent called @${a.handle}.`);
    const before = definitionOf(row);
    const checked = applyChanges(before, a.changes, TEMPLATE_IDS);
    if (!checked.ok) return fail("invalid", checked.message);
    const definition = checked.value;
    if (JSON.stringify(definition) === JSON.stringify(before)) return ok(toAgent(row, new Date()));
    if (definition.handle !== before.handle && (await this.handleTaken(managed.value, definition.handle, row.id))) {
      return fail("conflict", `${a.workspace} already has an agent called @${definition.handle}.`);
    }
    const now = new Date().toISOString();
    const version = row.version + 1;
    const by = a.viewer!.username;
    try {
      const [updated] = await this.db.batch([
        // Only from the version read: two owners saving at once never lose
        // one's change silently; the second is told to look again.
        this.db
          .prepare(
            `UPDATE agents SET handle = ?, display_name = ?, role = ?, instructions = ?, personality_preset = ?, personality = ?,
               routing = ?, budget = ?, autonomy = ?, capacity = ?, template = ?, version = ?, updated_at = ?
             WHERE id = ? AND version = ?`,
          )
          .bind(...this.columns(null, null, definition), version, now, row.id, row.version),
        this.db
          .prepare(
            `INSERT INTO agent_versions (agent_id, version, definition, changed_by, created_at)
             SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM agents WHERE id = ?1 AND version = ?2 AND updated_at = ?5)`,
          )
          .bind(row.id, version, JSON.stringify(definition), by, now),
      ]);
      if (!updated.meta.changes) return fail("conflict", `@${before.handle} was changed meanwhile. Reload it and try again.`);
    } catch (error) {
      if (String(error).includes("UNIQUE")) return fail("conflict", `${a.workspace} already has an agent called @${definition.handle}.`);
      throw error;
    }
    const renamed = definition.handle !== before.handle ? ` (was @${before.handle})` : "";
    this.audit(a.viewer!, a.workspace, "update_agent", definition.handle, `Changed @${definition.handle}${renamed} to version ${version}`);
    const saved = await this.row(managed.value, definition.handle);
    return ok(toAgent(saved!, new Date()));
  }

  async archive(a: { workspace: string; handle: string; viewer: User | null }): Promise<Result<null>> {
    const managed = await this.managed(a.workspace, a.viewer);
    if (!managed.ok) return managed;
    const row = await this.row(managed.value, a.handle);
    if (!row) return fail("not_found", `There is no agent called @${a.handle}.`);
    const now = new Date().toISOString();
    await this.db.prepare("UPDATE agents SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL").bind(now, now, row.id).run();
    this.audit(a.viewer!, a.workspace, "archive_agent", row.handle, `Archived @${row.handle}`);
    return ok(null);
  }

  /**
   * Hands a message to the agent's desk, which answers it in the
   * background. Returns as soon as the desk holds it.
   */
  async deliver(delivery: AgentDelivery): Promise<Result<null>> {
    const fields = ["workspace", "workspace_id", "channel_id", "agent_id", "message_id", "asked_by"] as const;
    if (!delivery || fields.some((field) => typeof delivery[field] !== "string" || !delivery[field])) {
      return fail("invalid", "A delivery names the workspace, channel, agent, message and who asked.");
    }
    if (delivery.channel_kind !== "channel" && delivery.channel_kind !== "dm") return fail("invalid", "channel_kind is channel or dm.");
    const desk = this.env.DESKS.get(this.env.DESKS.idFromName(delivery.agent_id));
    await desk.take({ ...delivery, hops: Math.max(0, Math.floor(Number(delivery.hops) || 0)), thread_root: delivery.thread_root ?? null });
    return ok(null);
  }

  /** A definition's columns, in the order the statements above take them. */
  private columns(id: string | null, workspaceId: string | null, d: Definition): (string | number | null)[] {
    const head = id && workspaceId ? [id, workspaceId] : [];
    return [
      ...head,
      d.handle,
      d.display_name,
      d.role,
      d.instructions,
      d.personality_preset,
      d.personality,
      JSON.stringify(d.routing),
      JSON.stringify(d.budget),
      JSON.stringify(d.autonomy),
      d.capacity,
      d.template,
    ];
  }

  private versionStatement(agentId: string, version: number, d: Definition, by: string, at: string): D1PreparedStatement {
    return this.db
      .prepare("INSERT INTO agent_versions (agent_id, version, definition, changed_by, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(agentId, version, JSON.stringify(d), by, at);
  }

  /**
   * Records a change to an agent in the workspace's audit log, after the
   * answer. Never fails the change: a log that cannot be written is logged.
   * The events service's audit contract speaks camelCase (Rust's
   * `NewAuditEntry`).
   */
  private audit(actor: User, workspace: string, action: string, handle: string, message: string): void {
    const kind = actor.kind === "workspace" ? "workspace" : actor.kind === "agent" ? "agent" : actor.kind === "system" ? "system" : "person";
    const entry = {
      actorKind: kind,
      actor: actor.username,
      actorId: actor.id,
      agent: null,
      onBehalfOf: null,
      runId: null,
      runKind: null,
      credentialId: null,
      action,
      surface: "web",
      workspace: workspace.toLowerCase(),
      repo: null,
      number: null,
      gitRef: null,
      path: `agents/${handle}`,
      outcome: "allowed",
      rule: "owner",
      result: "ok",
      message,
      requestId: `req_${crypto.randomUUID()}`,
    };
    this.defer(
      this.env.EVENTS.fetch("https://service/rpc/audit_record", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entries: [entry] }),
      })
        .then((response) => {
          if (!response.ok) throw new Error(`status ${response.status}`);
        })
        .catch((error: unknown) => console.error("agents: audit entry not recorded", action, handle, String(error))),
    );
  }
}

/** One RPC method's answer. */
async function answer(service: Agents, method: string, args: any): Promise<Response> {
  switch (method) {
    case "list":
      return Response.json(await service.list(args));
    case "get":
      return Response.json(await service.get(args));
    case "by_ids":
      return Response.json(await service.byIds(args));
    case "create":
      return Response.json(await service.create(args));
    case "update":
      return Response.json(await service.update(args));
    case "archive":
      return Response.json(await service.archive(args));
    case "templates":
      return Response.json(TEMPLATES);
    case "deliver":
      return Response.json(await service.deliver(args));
    default:
      return new Response("Unknown method\n", { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const match = new URL(request.url).pathname.match(/^\/rpc\/([a-z_]+)$/);
    if (request.method !== "POST" || !match) return new Response("Not found\n", { status: 404 });
    // A replica near the caller when it asks for one (@g1t/contracts d1.ts).
    const opened = openD1(env.DB, request);
    const service = new Agents(Object.create(env, { DB: { value: opened.db } }) as Env, (work) => ctx.waitUntil(work));
    const args = (await request.json().catch(() => ({}))) as any;
    return opened.finish(await answer(service, match[1], args));
  },
} satisfies ExportedHandler<Env>;
