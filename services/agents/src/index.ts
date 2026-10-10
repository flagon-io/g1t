/**
 * The agents service: a workspace's own agents
 * (docs.g1t.sh/guides/agents/). Their definitions and every version of
 * them, the templates they start from, each agent's desk, and their replies
 * in chat.
 *
 * `@g1t`, the platform's own agent, is not one of these.
 *
 * Reached through service bindings: `POST /rpc/<method>`, with snake_case
 * JSON (@g1t/contracts workspace-agents.ts).
 */
import {
  type AgentCardAction,
  type AgentDelivery,
  type CardActionResult,
  type G1tEvent,
  type NewWorkspaceAgent,
  type Result,
  type ServiceBinding,
  type User,
  type WorkspaceAgent,
  UNVERIFIED,
  askerAccess,
  awaitsConfirmation,
  chatClient,
  fail,
  identityClient,
  newId,
  ok,
  openD1,
} from "@g1t/contracts";

import { MANAGE_REFUSAL, canManage, canSee } from "./access.ts";
import { type Definition, applyChanges } from "./definition.ts";
import { builtinChanges } from "./orchestrator.ts";
import type { Desk } from "./desk.ts";
import type { ReplyEnv } from "./reply.ts";
import { ensureBuiltin } from "./builtin.ts";
import { type Row, definitionOf, insertAgent, periods, selectAgents, toAgent, updateAgent, versionStatement } from "./store.ts";
import { TEMPLATES, TEMPLATE_IDS } from "./templates.ts";
import { readPolicy } from "./policy.ts";
import { runDue } from "./routines.ts";
import { onEvents } from "./triggers.ts";
import { cardAction } from "./cards.ts";
import { type SessionEnv, sweep } from "./sessions.ts";
import * as views from "./views.ts";
import { monthKey } from "./budget.ts";

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

  /** Internal, from chat: a person pressed an action on one of agents' cards. */
  async cardAction(a: AgentCardAction): Promise<Result<CardActionResult>> {
    if (a?.viewer && awaitsConfirmation(a.viewer)) return UNVERIFIED;
    if (!a?.viewer || !canSee(a.viewer, a.workspace ?? "")) return fail("not_found", "No such card.");
    return cardAction(this.env as unknown as SessionEnv, a);
  }

  /** What the views need: the workspace, the viewer, and whether they own it. */
  private async context(workspace: string, viewer: User | null): Promise<Result<views.ViewContext>> {
    if (viewer && awaitsConfirmation(viewer)) return UNVERIFIED;
    const seen = await this.seen(workspace, viewer);
    if (!seen.ok) return seen;
    return ok({
      env: this.env as unknown as SessionEnv,
      db: this.db,
      slug: workspace.toLowerCase(),
      workspaceId: seen.value,
      viewer: viewer!,
      owner: canManage(viewer, workspace),
    });
  }

  /** Runs `view` with the context, or answers why it can't. */
  async view<T>(a: { workspace: string; viewer: User | null }, view: (ctx: views.ViewContext) => Promise<Result<T>>): Promise<Result<T>> {
    const ctx = await this.context(a?.workspace ?? "", a?.viewer ?? null);
    if (!ctx.ok) return ctx;
    return view(ctx.value);
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

  /** Whether `team` (a slug, or none) is one of the workspace's teams, as the person changing the agent sees them. */
  private async teamExists(workspace: string, viewer: User, team: string | null): Promise<Result<null>> {
    if (!team) return ok(null);
    const found = await identityClient(this.env.IDENTITY)
      .getTeam(viewer, workspace.toLowerCase(), team)
      .catch(() => null);
    return found?.ok ? ok(null) : fail("invalid", `${workspace} has no team called ${team}.`);
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
    await this.ensureBuiltin(seen.value);
    const rows = await this.db
      .prepare(`${selectAgents("a.workspace_id = ?3 AND a.archived_at IS NULL")} ORDER BY a.builtin DESC, a.handle`)
      .bind(...periods(now), seen.value)
      .all<Row>();
    return ok(rows.results.map((row) => toAgent(row, now)));
  }

  async get(a: { workspace: string; handle: string; viewer: User | null }): Promise<Result<WorkspaceAgent>> {
    const seen = await this.seen(a.workspace, a.viewer);
    if (!seen.ok) return seen;
    await this.ensureBuiltin(seen.value);
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
    // A new agent starts with the workspace's default monthly budget, unless one was given.
    const policy = await readPolicy(this.db, managed.value, monthKey(new Date()));
    const input =
      policy.default_agent_monthly_micros && a.input?.budget?.monthly_micros === undefined
        ? { ...a.input, budget: { ...(a.input?.budget ?? {}), monthly_micros: policy.default_agent_monthly_micros } }
        : a.input;
    const checked = applyChanges(null, input, TEMPLATE_IDS);
    if (!checked.ok) return fail("invalid", checked.message);
    const definition = checked.value;
    const team = await this.teamExists(a.workspace, a.viewer!, definition.team);
    if (!team.ok) return team;
    if (await this.handleTaken(managed.value, definition.handle, null)) {
      return fail("conflict", `${a.workspace} already has an agent called @${definition.handle}.`);
    }
    const now = new Date().toISOString();
    const id = newId("agt");
    const by = a.viewer!.username;
    try {
      await this.db.batch([
        insertAgent(this.db, id, managed.value, definition, { version: 1, created_by: by, created_at: now, updated_at: now }),
        this.versionStatement(id, 1, definition, by, now),
      ]);
    } catch (error) {
      if (String(error).includes("UNIQUE")) return fail("conflict", `${a.workspace} already has an agent called @${definition.handle}.`);
      throw error;
    }
    this.audit(a.viewer!, a.workspace, "create_agent", definition.handle, `Created @${definition.handle} (version 1)`);
    this.defer(this.hello(a.workspace, managed.value, id, a.viewer!));
    const row = await this.row(managed.value, definition.handle);
    return ok(toAgent(row!, new Date()));
  }

  /**
   * A new agent's first words: the DM with the person who made it is
   * opened, and the agent says hello there in its own voice, as a reply
   * billed like any other (a fixed hello when no model can be used).
   * After the answer; a failure only logs.
   */
  private async hello(workspace: string, workspaceId: string, agentId: string, creator: User): Promise<void> {
    if ((creator.kind ?? "user") !== "user") return;
    try {
      const dm = await chatClient(this.env.CHAT).openDm(workspace, creator, [{ kind: "agent", id: agentId }]);
      if (!dm.ok) throw new Error(dm.error.message);
      const desk = this.env.DESKS.get(this.env.DESKS.idFromName(agentId));
      await desk.take({
        workspace,
        workspace_id: workspaceId,
        channel_id: dm.value.id,
        channel_kind: "dm",
        channel_name: null,
        agent_id: agentId,
        // One hello per agent, however often this runs.
        message_id: `hello:${agentId}`,
        thread_root: null,
        asked_by: creator.id,
        hops: 0,
        asker: askerAccess(creator, workspace),
        hello: true,
      });
    } catch (error) {
      console.error("agents: a new agent's hello was not sent", agentId, String(error));
    }
  }

  async update(a: { workspace: string; handle: string; viewer: User | null; changes: Partial<NewWorkspaceAgent> }): Promise<Result<WorkspaceAgent>> {
    const managed = await this.managed(a.workspace, a.viewer);
    if (!managed.ok) return managed;
    const row = await this.row(managed.value, a.handle);
    if (!row) return fail("not_found", `There is no agent called @${a.handle}.`);
    const before = definitionOf(row);
    // The built-in @g1t keeps who it is and its job; the rest is the workspace's.
    const allowed = row.builtin ? builtinChanges(before, a.changes) : { ok: true as const, value: a.changes };
    if (!allowed.ok) return fail("invalid", allowed.message);
    const checked = applyChanges(before, allowed.value, TEMPLATE_IDS, { builtin: !!row.builtin });
    if (!checked.ok) return fail("invalid", checked.message);
    const definition = checked.value;
    if (JSON.stringify(definition) === JSON.stringify(before)) return ok(toAgent(row, new Date()));
    if (definition.team !== before.team) {
      const team = await this.teamExists(a.workspace, a.viewer!, definition.team);
      if (!team.ok) return team;
    }
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
        updateAgent(this.db, row.id, row.version, definition, { version, updated_at: now }),
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
    if (row.builtin) return fail("invalid", "@g1t is every workspace's orchestrator and can't be archived. You can set its budget to limit it.");
    const now = new Date().toISOString();
    await this.db.prepare("UPDATE agents SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL").bind(now, now, row.id).run();
    this.audit(a.viewer!, a.workspace, "archive_agent", row.handle, `Archived @${row.handle}`);
    return ok(null);
  }

  /**
   * Makes the workspace's built-in @g1t if it does not exist yet: an
   * ordinary agent row, marked builtin, at version 1. Safe to call on
   * every request; once seen, an isolate does not write again.
   */
  private async ensureBuiltin(workspaceId: string): Promise<void> {
    await ensureBuiltin(this.db, workspaceId);
  }

  /** Internal: the workspace's @g1t, made if need be, for the chat service. */
  async builtin(a: { workspace: string; workspace_id: string }): Promise<Result<WorkspaceAgent>> {
    if (typeof a?.workspace_id !== "string" || !a.workspace_id) return fail("invalid", "Name the workspace by id.");
    await this.ensureBuiltin(a.workspace_id);
    const now = new Date();
    const row = await this.db
      .prepare(selectAgents("a.workspace_id = ?3 AND a.builtin = 1"))
      .bind(...periods(now), a.workspace_id)
      .first<Row>();
    return row ? ok(toAgent(row, now)) : fail("not_found", "This workspace's @g1t could not be made.");
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
    await this.ensureBuiltin(delivery.workspace_id);
    const desk = this.env.DESKS.get(this.env.DESKS.idFromName(delivery.agent_id));
    await desk.take({ ...delivery, hops: Math.max(0, Math.floor(Number(delivery.hops) || 0)), thread_root: delivery.thread_root ?? null });
    return ok(null);
  }

  private versionStatement(agentId: string, version: number, d: Definition, by: string, at: string): D1PreparedStatement {
    return versionStatement(this.db, agentId, version, d, by, at);
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
    case "builtin":
      return Response.json(await service.builtin(args));
    case "templates":
      return Response.json(TEMPLATES);
    case "deliver":
      return Response.json(await service.deliver(args));
    case "overview":
      return Response.json(await service.view(args, (ctx) => views.overview(ctx)));
    case "sessions":
      return Response.json(await service.view(args, (ctx) => views.listSessions(ctx, args)));
    case "session":
      return Response.json(await service.view(args, (ctx) => views.sessionDetail(ctx, args.id)));
    case "stop_session":
      return Response.json(await service.view(args, (ctx) => views.stopSession(ctx, args.id)));
    case "approve_session":
      return Response.json(await service.view(args, (ctx) => views.approveSession(ctx, args.id, args.cap_micros)));
    case "steer_session":
      return Response.json(await service.view(args, (ctx) => views.steerSession(ctx, args.id, args.body)));
    case "memories":
      return Response.json(await service.view(args, (ctx) => views.memories(ctx, args.handle)));
    case "remember":
      return Response.json(await service.view(args, (ctx) => views.remember(ctx, args.handle, args.input)));
    case "update_memory":
      return Response.json(await service.view(args, (ctx) => views.updateMemory(ctx, args.handle, args.id, args.changes)));
    case "forget":
      return Response.json(await service.view(args, (ctx) => views.forget(ctx, args.handle, args.id)));
    case "routines":
      return Response.json(await service.view(args, (ctx) => views.routines(ctx, args.handle)));
    case "save_routine":
      return Response.json(await service.view(args, (ctx) => views.saveRoutine(ctx, args.handle, args.input, args.id ?? null)));
    case "delete_routine":
      return Response.json(await service.view(args, (ctx) => views.deleteRoutine(ctx, args.handle, args.id)));
    case "run_routine":
      return Response.json(await service.view(args, (ctx) => views.runRoutineNow(ctx, args.handle, args.id)));
    case "spend":
      return Response.json(await service.view(args, (ctx) => views.spend(ctx, args.handle ?? null, { period: args.period, person: args.person })));
    case "person_budgets":
      return Response.json(await service.view(args, (ctx) => views.personBudgetsView(ctx)));
    case "set_person_budget":
      return Response.json(await service.view(args, (ctx) => views.setPersonBudget(ctx, args.username, args.monthly_micros)));
    case "activity":
      return Response.json(await service.view(args, (ctx) => views.activity(ctx, args.handle)));
    case "versions":
      return Response.json(await service.view(args, (ctx) => views.versions(ctx, args.handle)));
    case "card_action":
      return Response.json(await service.cardAction(args));
    case "policy":
      return Response.json(await service.view(args, (ctx) => views.policy(ctx)));
    case "set_policy":
      return Response.json(await service.view(args, (ctx) => views.setPolicy(ctx, args.policy)));
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

  /** Events routines run on, from the events service (SUBSCRIBER_AGENTS). */
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    await onEvents(env as unknown as SessionEnv, batch.messages.map((message) => message.body as G1tEvent));
    batch.ackAll();
  },

  /** Every few minutes: routines that are due, and session steps a desk lost. */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const sessions = env as unknown as SessionEnv;
    ctx.waitUntil(
      Promise.all([
        runDue(sessions).catch((error: unknown) => console.error("agents: routines did not run", String(error))),
        sweep(sessions).catch((error: unknown) => console.error("agents: the session sweep failed", String(error))),
      ]),
    );
  },
} satisfies ExportedHandler<Env>;
