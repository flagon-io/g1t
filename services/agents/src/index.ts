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
  type AgentProposal,
  type AgentRedraft,
  type DraftReply,
  MAX_PERSONAL_AGENTS,
  type AgentDelivery,
  type CardActionResult,
  type G1tEvent,
  type ExtensionInstall,
  type InstallRequest,
  type InstallRequests,
  type AgentEffortCosts,
  type AgentRecommendation,
  type AgentRecommendations,
  type NewWorkspaceAgent,
  type Result,
  type ServiceBinding,
  type User,
  type WorkspaceAgent,
  UNVERIFIED,
  askerAccess,
  awaitsConfirmation,
  chatClient,
  cleanRequestNote,
  extensionById,
  fail,
  identityClient,
  newId,
  notifyClient,
  ok,
  openD1,
} from "@g1t/contracts";

import { MANAGE_REFUSAL, NOT_YOURS_REFUSAL, canArchive, canChange, canManage, canSee, canSeeAgent, creatableScope } from "./access.ts";
import { DRAFT_OUTPUT_TOKENS, draftSystem, jsonIn, proposalFrom, redraftFrom, redraftSystem, startingBudget, trySystem, tryTurns, wordsOf } from "./builder.ts";
import { callBuilder } from "./builder-call.ts";
import { type Definition, applyChanges } from "./definition.ts";
import { builtinChanges } from "./orchestrator.ts";
import type { Desk } from "./desk.ts";
import type { ReplyEnv } from "./reply.ts";
import { ensureBuiltin } from "./builtin.ts";
import { type Row, definitionOf, insertAgent, isPersonal, periods, selectAgents, toAgent, updateAgent, versionStatement } from "./store.ts";
import { TEMPLATES, TEMPLATE_IDS } from "./templates.ts";
import { readPolicy } from "./policy.ts";
import { runDue } from "./routines.ts";
import { onEvents } from "./triggers.ts";
import { cardAction } from "./cards.ts";
import { type SessionEnv, sweep } from "./sessions.ts";
import { EFFORT_NAMES, checkDue, effortCostsOf, markResolved, outcomesSince, readRecommendations, recommendationRow, sinceWindow, toRecommendation } from "./recommend.ts";
import { effortOf } from "./routing.ts";
import * as views from "./views.ts";
import { monthKey } from "./budget.ts";
import * as extensions from "./extensions.ts";
import { type Answered, type Person, answerLine, findListing, listRequests, listingPath, openRequest, requestsPath, resolveListing, resolveRequest } from "./installs.ts";

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
      audit: (action, handle, message) => this.audit(viewer!, workspace, action, handle, message),
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

  /**
   * The workspace's agents, and personal agents when asked for: `mine`, the
   * viewer's own; `all`, every member's for an owner.
   */
  async list(a: { workspace: string; viewer: User | null; personal?: unknown }): Promise<Result<WorkspaceAgent[]>> {
    const seen = await this.seen(a.workspace, a.viewer);
    if (!seen.ok) return seen;
    const now = new Date();
    await this.ensureBuiltin(seen.value);
    const all = a.personal === "all" && canManage(a.viewer, a.workspace);
    const mine = (a.personal === "mine" || a.personal === "all") && (a.viewer?.kind ?? "user") === "user" ? (a.viewer?.id ?? "") : "";
    const rows = await this.db
      .prepare(
        `${selectAgents(
          `a.workspace_id = ?3 AND a.archived_at IS NULL AND (a.scope = 'workspace'${all ? " OR a.scope = 'personal'" : mine ? " OR (a.scope = 'personal' AND a.owner_id = ?4)" : ""})`,
        )} ORDER BY a.builtin DESC, a.handle`,
      )
      .bind(...periods(now), seen.value, ...(mine && !all ? [mine] : []))
      .all<Row>();
    return ok(rows.results.map((row) => toAgent(row, now)));
  }

  async get(a: { workspace: string; handle: string; viewer: User | null }): Promise<Result<WorkspaceAgent>> {
    const seen = await this.seen(a.workspace, a.viewer);
    if (!seen.ok) return seen;
    await this.ensureBuiltin(seen.value);
    const row = await this.row(seen.value, a.handle);
    // Another member's personal agent is theirs: it isn't there for anyone else but owners.
    return row && canSeeAgent(a.viewer, a.workspace, row) ? ok(toAgent(row, new Date())) : fail("not_found", `There is no agent called @${a.handle}.`);
  }

  /** The agent by handle, if the viewer may see it. */
  private async visible(workspace: string, viewer: User | null, handle: unknown): Promise<Result<{ workspaceId: string; row: Row }>> {
    if (awaitsConfirmation(viewer)) return UNVERIFIED;
    const seen = await this.seen(workspace, viewer);
    if (!seen.ok) return seen;
    const row = await this.row(seen.value, handle);
    if (!row || !canSeeAgent(viewer, workspace, row)) return fail("not_found", `There is no agent called @${String(handle ?? "")}.`);
    return ok({ workspaceId: seen.value, row });
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

  /**
   * Who may create an agent, and of which scope: the workspace's id and
   * policy, and the scope it gets (access.ts `creatableScope`).
   */
  private async creatable(workspace: string, viewer: User | null, asked: unknown): Promise<Result<{ workspaceId: string; scope: "workspace" | "personal"; policy: Awaited<ReturnType<typeof readPolicy>> }>> {
    if (awaitsConfirmation(viewer)) return UNVERIFIED;
    const seen = await this.seen(workspace, viewer);
    if (!seen.ok) return seen;
    const policy = await readPolicy(this.db, seen.value, monthKey(new Date()));
    const scope = creatableScope(viewer, workspace, asked, policy.members_create_agents);
    if (!scope.ok) return fail("forbidden", scope.message);
    return ok({ workspaceId: seen.value, scope: scope.scope, policy });
  }

  async create(a: { workspace: string; viewer: User | null; input: NewWorkspaceAgent }): Promise<Result<WorkspaceAgent>> {
    const allowed = await this.creatable(a.workspace, a.viewer, a.input?.scope);
    if (!allowed.ok) return allowed;
    const { workspaceId, scope, policy } = allowed.value;
    const personal = scope === "personal";
    const viewer = a.viewer!;
    if (personal) {
      const count = await this.db
        .prepare("SELECT COUNT(*) AS n FROM agents WHERE workspace_id = ? AND owner_id = ? AND scope = 'personal' AND archived_at IS NULL")
        .bind(workspaceId, viewer.id)
        .first<{ n: number }>();
      if ((count?.n ?? 0) >= MAX_PERSONAL_AGENTS) {
        return fail("invalid", `You have ${MAX_PERSONAL_AGENTS} personal agents here, the most one person keeps. Archive one to make another.`);
      }
    }
    // A new agent starts with a budget, unless one was given: a member's own
    // $20 a month and $2 a session, or the workspace's default for its agents.
    const given = a.input?.budget ?? {};
    const start = startingBudget(scope, policy.default_agent_monthly_micros);
    const budget = {
      monthly_micros: given.monthly_micros !== undefined ? given.monthly_micros : start.monthly_micros,
      daily_micros: given.daily_micros !== undefined ? given.daily_micros : start.daily_micros,
      task_micros: given.task_micros !== undefined ? given.task_micros : start.task_micros,
    };
    const { scope: _scope, ...rest } = a.input ?? ({} as NewWorkspaceAgent);
    // A personal agent is on no team: teams are shared, and it answers only its member.
    const input = { ...rest, budget, ...(personal ? { team: null } : {}) };
    const checked = applyChanges(null, input, TEMPLATE_IDS);
    if (!checked.ok) return fail("invalid", checked.message);
    const definition = checked.value;
    const team = await this.teamExists(a.workspace, viewer, definition.team);
    if (!team.ok) return team;
    if (await this.handleTaken(workspaceId, definition.handle, null)) {
      return fail("conflict", `${a.workspace} already has an agent called @${definition.handle}.`);
    }
    const now = new Date().toISOString();
    const id = newId("agt");
    const by = viewer.username;
    const owned: Record<string, string> = personal ? { scope: "personal", owner_id: viewer.id, owner_username: viewer.username.toLowerCase() } : {};
    try {
      await this.db.batch([
        insertAgent(this.db, id, workspaceId, definition, { version: 1, created_by: by, created_at: now, updated_at: now, ...owned }),
        this.versionStatement(id, 1, definition, by, now),
      ]);
    } catch (error) {
      if (String(error).includes("UNIQUE")) return fail("conflict", `${a.workspace} already has an agent called @${definition.handle}.`);
      throw error;
    }
    this.audit(viewer, a.workspace, "create_agent", definition.handle, `Created ${personal ? "the personal agent " : ""}@${definition.handle} (version 1)`, "agents", personal ? "member" : "owner");
    this.defer(this.hello(a.workspace, workspaceId, id, viewer));
    const row = await this.row(workspaceId, definition.handle);
    return ok(toAgent(row!, new Date()));
  }

  // ── The builder: describe it, try it, change it in words (./builder.ts) ──

  /** Drafts a whole agent from a description, charged to the viewer. Nothing is saved. */
  async draft(a: { workspace: string; viewer: User | null; description: unknown; scope?: unknown }): Promise<Result<AgentProposal>> {
    const allowed = await this.creatable(a?.workspace ?? "", a?.viewer ?? null, a?.scope);
    if (!allowed.ok) return allowed;
    const words = wordsOf(a.description, "description");
    if (!words.ok) return fail("invalid", words.message);
    const { workspaceId, scope, policy } = allowed.value;
    const slug = a.workspace.toLowerCase();
    const [answer, handles] = await Promise.all([
      callBuilder(this.env, {
        slug,
        workspaceId,
        viewer: a.viewer!,
        system: draftSystem(slug, scope),
        messages: [{ role: "user", content: `What the agent should do:\n\n${words.value}` }],
        maxOutput: DRAFT_OUTPUT_TOKENS,
      }),
      this.db.prepare("SELECT handle FROM agents WHERE workspace_id = ? AND archived_at IS NULL").bind(workspaceId).all<{ handle: string }>(),
    ]);
    if (!answer.ok) return fail(answer.code, answer.message);
    const proposal = proposalFrom(jsonIn(answer.text), {
      scope,
      taken: new Set(handles.results.map((row) => row.handle)),
      budget: startingBudget(scope, policy.default_agent_monthly_micros),
    });
    if (!proposal.ok) return fail("invalid", proposal.message);
    return ok({ ...proposal.value, charged_micros: answer.charged });
  }

  /** Try it: the unsaved definition answers the conversation so far. Charged to the viewer; nothing is saved. */
  async tryDraft(a: { workspace: string; viewer: User | null; definition: unknown; messages: unknown }): Promise<Result<DraftReply>> {
    const given = (a?.definition ?? {}) as NewWorkspaceAgent;
    const allowed = await this.creatable(a?.workspace ?? "", a?.viewer ?? null, given?.scope);
    if (!allowed.ok) return allowed;
    const { scope: _scope, ...rest } = given;
    // A handle someone has already taken is no reason not to try it.
    const checked = applyChanges(null, { ...rest, handle: rest.handle || "preview" }, TEMPLATE_IDS);
    if (!checked.ok) return fail("invalid", checked.message);
    const turns = tryTurns(a.messages);
    if (!turns.ok) return fail("invalid", turns.message);
    const viewer = a.viewer!;
    const answer = await callBuilder(this.env, {
      slug: a.workspace.toLowerCase(),
      workspaceId: allowed.value.workspaceId,
      viewer,
      system: trySystem({ workspace: a.workspace.toLowerCase(), definition: checked.value, asker: { username: viewer.username, display_name: viewer.display_username ?? null } }),
      messages: turns.value,
      routing: { floor: checked.value.routing.floor, ceiling: checked.value.routing.ceiling },
    });
    if (!answer.ok) return fail(answer.code, answer.message);
    return ok({ text: answer.text, charged_micros: answer.charged });
  }

  /** Drafts changes from a request in words, for whoever may change the agent. Saved only through `update`. */
  async redraft(a: { workspace: string; handle: string; viewer: User | null; request: unknown }): Promise<Result<AgentRedraft>> {
    const found = await this.visible(a?.workspace ?? "", a?.viewer ?? null, a?.handle);
    if (!found.ok) return found;
    const { workspaceId, row } = found.value;
    if (!canChange(a.viewer, a.workspace, row)) return fail("forbidden", isPersonal(row) ? NOT_YOURS_REFUSAL : MANAGE_REFUSAL);
    const words = wordsOf(a.request, "request");
    if (!words.ok) return fail("invalid", words.message);
    const before = definitionOf(row);
    const slug = a.workspace.toLowerCase();
    const answer = await callBuilder(this.env, {
      slug,
      workspaceId,
      viewer: a.viewer!,
      system: redraftSystem(slug, before, !!row.builtin),
      messages: [{ role: "user", content: `The change to make to @${row.handle}:\n\n${words.value}` }],
      maxOutput: DRAFT_OUTPUT_TOKENS,
    });
    if (!answer.ok) return fail(answer.code, answer.message);
    const drafted = redraftFrom(jsonIn(answer.text), before, !!row.builtin);
    if (!drafted.ok) return fail("invalid", drafted.message);
    return ok({ ...drafted.value, from_version: row.version, charged_micros: answer.charged });
  }

  /**
   * Owners make a personal agent a workspace agent: a new workspace agent
   * with the same handle, definition and every version, and one more
   * version saying so; the personal one is archived in the same step, its
   * memory and direct messages kept with it (owners can't read a member's
   * memory to choose from it, so none is carried).
   */
  async promote(a: { workspace: string; handle: string; viewer: User | null }): Promise<Result<WorkspaceAgent>> {
    const managed = await this.managed(a?.workspace ?? "", a?.viewer ?? null);
    if (!managed.ok) return managed.error.code === "forbidden" ? fail("forbidden", "Only the workspace's owners promote personal agents.") : managed;
    const row = await this.row(managed.value, a.handle);
    if (!row) return fail("not_found", `There is no agent called @${a.handle}.`);
    if (!isPersonal(row)) return fail("invalid", `@${row.handle} is already a workspace agent.`);
    const versions = await this.db
      .prepare("SELECT version, definition, changed_by, created_at FROM agent_versions WHERE agent_id = ? ORDER BY version")
      .bind(row.id)
      .all<{ version: number; definition: string; changed_by: string; created_at: string }>();
    const definition = definitionOf(row);
    const now = new Date().toISOString();
    const id = newId("agt");
    const version = row.version + 1;
    const by = a.viewer!.username;
    try {
      const [archived] = await this.db.batch([
        // Archived first, from the version read, so the handle is free for the new one in the same step.
        this.db.prepare("UPDATE agents SET archived_at = ?, updated_at = ? WHERE id = ? AND version = ? AND archived_at IS NULL").bind(now, now, row.id, row.version),
        insertAgent(this.db, id, managed.value, definition, { version, created_by: row.created_by, created_at: now, updated_at: now }),
        ...versions.results.map((v) =>
          this.db.prepare("INSERT INTO agent_versions (agent_id, version, definition, changed_by, created_at) VALUES (?, ?, ?, ?, ?)").bind(id, v.version, v.definition, v.changed_by, v.created_at),
        ),
        this.versionStatement(id, version, definition, by, now),
      ]);
      if (!archived.meta.changes) throw new Error("changed meanwhile");
    } catch (error) {
      console.error("agents: a promotion failed", row.id, String(error));
      return fail("conflict", `@${row.handle} was changed meanwhile. Reload it and try again.`);
    }
    this.audit(a.viewer!, a.workspace, "promote_agent", row.handle, `Promoted @${row.owner_username ?? "a member"}'s personal agent @${row.handle} to a workspace agent (version ${version})`);
    const saved = await this.row(managed.value, row.handle);
    return ok(toAgent(saved!, new Date()));
  }

  // ── The Marketplace's install requests (./installs.ts) ─────────────────

  /** Requests as the viewer sees them: every one for an owner, their own for anyone else. */
  async installRequests(a: { workspace: string; viewer: User | null }): Promise<Result<InstallRequests>> {
    if (a?.viewer && awaitsConfirmation(a.viewer)) return UNVERIFIED;
    const seen = await this.seen(a?.workspace ?? "", a?.viewer ?? null);
    if (!seen.ok) return seen;
    const owner = canManage(a.viewer, a.workspace);
    const requests = await listRequests(this.db, seen.value, a.viewer!, owner);
    return ok({ requests, can_resolve: owner });
  }

  /** A member asks the owners to add something; each owner is notified. */
  async requestInstall(a: { workspace: string; viewer: User | null; listing: unknown; note?: unknown }): Promise<Result<InstallRequest>> {
    if (a?.viewer && awaitsConfirmation(a.viewer)) return UNVERIFIED;
    const seen = await this.seen(a?.workspace ?? "", a?.viewer ?? null);
    if (!seen.ok) return seen;
    const viewer = a.viewer!;
    if ((viewer.kind ?? "user") !== "user") return fail("forbidden", "Only people ask the workspace's owners to add things.");
    if (canManage(viewer, a.workspace)) return fail("invalid", "You're an owner of this workspace: add it yourself.");
    const listing = findListing(a.listing);
    if (!listing) return fail("not_found", "That isn't something a workspace can add yet.");
    const opened = await openRequest(this.db, seen.value, newId("ins"), listing, viewer, cleanRequestNote(a.note));
    if (!opened.ok) return opened;
    const slug = a.workspace.toLowerCase();
    this.audit(viewer, slug, "request_install", listing.ref, `Asked the owners to add ${listing.name}`, "marketplace");
    this.defer(this.tellOwners(slug, viewer, opened.value));
    return opened;
  }

  /** An owner adds or turns down a request; whoever asked is told. */
  async resolveInstallRequest(a: { workspace: string; viewer: User | null; id: unknown; status: unknown }): Promise<Result<InstallRequest>> {
    const managed = await this.managed(a?.workspace ?? "", a?.viewer ?? null);
    if (!managed.ok) {
      return managed.error.code === "forbidden" ? fail("forbidden", "Only the workspace's owners answer requests.") : managed;
    }
    if (a.status !== "done" && a.status !== "declined") return fail("invalid", "Answer a request with done or declined.");
    const answered = await resolveRequest(this.db, managed.value, String(a.id ?? ""), a.status, a.viewer!);
    if (!answered.ok) return answered;
    const slug = a.workspace.toLowerCase();
    const { request } = answered.value;
    this.audit(a.viewer!, slug, "answer_install_request", request.listing, `${request.status === "done" ? "Added" : "Turned down"} ${request.name} for @${request.requested_by}`, "marketplace");
    this.defer(this.tellRequester(slug, a.viewer!, answered.value));
    return ok(request);
  }

  // ── Extensions installed in the workspace (./extensions.ts) ──────────────

  /** The workspace's installs; any member sees them. */
  async extensionInstalls(a: { workspace: string; viewer: User | null }): Promise<Result<ExtensionInstall[]>> {
    if (a?.viewer && awaitsConfirmation(a.viewer)) return UNVERIFIED;
    const seen = await this.seen(a?.workspace ?? "", a?.viewer ?? null);
    if (!seen.ok) return seen;
    return ok(await extensions.listInstalls(this.db, seen.value));
  }

  /** Owners install a published extension; whoever asked for it is told. */
  async installExtension(a: { workspace: string; viewer: User | null; extension: unknown }): Promise<Result<ExtensionInstall>> {
    const managed = await this.managed(a?.workspace ?? "", a?.viewer ?? null);
    if (!managed.ok) return managed.error.code === "forbidden" ? fail("forbidden", "Only the workspace's owners install extensions.") : managed;
    const installed = await extensions.install(this.db, extensionById, managed.value, newId("ins"), String(a.extension ?? ""), a.viewer!.username);
    if (!installed.ok) return installed;
    const slug = a.workspace.toLowerCase();
    this.audit(a.viewer!, slug, "install_extension", installed.value.listing, `Installed ${installed.value.listing} ${installed.value.version}`, "marketplace");
    this.defer(this.answerListing(slug, managed.value, installed.value.listing, a.viewer!));
    return installed;
  }

  /** Owners switch an install on or off. */
  async setExtensionEnabled(a: { workspace: string; viewer: User | null; listing: unknown; enabled: unknown }): Promise<Result<ExtensionInstall>> {
    const managed = await this.managed(a?.workspace ?? "", a?.viewer ?? null);
    if (!managed.ok) return managed;
    const listing = String(a.listing ?? "");
    if (!extensions.extensionIdOf(listing)) return fail("invalid", "Name an extension as extension:<id>.");
    const changed = await extensions.setEnabled(this.db, managed.value, listing, a.enabled === true, a.viewer!.username);
    if (changed.ok) this.audit(a.viewer!, a.workspace, a.enabled === true ? "enable_extension" : "disable_extension", listing, `${a.enabled === true ? "Switched on" : "Switched off"} ${listing}`, "marketplace");
    return changed;
  }

  /** Owners cap what an install spends a month. */
  async setExtensionBudget(a: { workspace: string; viewer: User | null; listing: unknown; monthly_micros: unknown }): Promise<Result<ExtensionInstall>> {
    const managed = await this.managed(a?.workspace ?? "", a?.viewer ?? null);
    if (!managed.ok) return managed;
    const listing = String(a.listing ?? "");
    const micros = a.monthly_micros == null ? null : Number(a.monthly_micros);
    const changed = await extensions.setBudget(this.db, managed.value, listing, micros);
    if (changed.ok) this.audit(a.viewer!, a.workspace, "set_extension_budget", listing, `Set ${listing}'s monthly budget`, "marketplace");
    return changed;
  }

  /** Owners remove an install. */
  async uninstallExtension(a: { workspace: string; viewer: User | null; listing: unknown }): Promise<Result<null>> {
    const managed = await this.managed(a?.workspace ?? "", a?.viewer ?? null);
    if (!managed.ok) return managed;
    const listing = String(a.listing ?? "");
    const removed = await extensions.uninstall(this.db, managed.value, listing, a.viewer!.username);
    if (removed.ok) this.audit(a.viewer!, a.workspace, "uninstall_extension", listing, `Uninstalled ${listing}`, "marketplace");
    return removed;
  }

  /** Marks every open request for `listing` added, and tells each person who asked. */
  private async answerListing(slug: string, workspaceId: string, listing: string, by: User): Promise<void> {
    try {
      const answered = await resolveListing(this.db, workspaceId, listing, by as Person);
      await Promise.all(answered.map((one) => this.tellRequester(slug.toLowerCase(), by, one)));
    } catch (error) {
      console.error("agents: requests for a listing were not answered", listing, String(error));
    }
  }

  /** Every owner hears of a new request (at most 20 of them). */
  private async tellOwners(slug: string, asker: User, request: InstallRequest): Promise<void> {
    if (!this.env.NOTIFY) return;
    try {
      const members = await identityClient(this.env.IDENTITY).listMembers(slug, asker);
      if (!members.ok) throw new Error(members.error.message);
      const owners = members.value.filter((member) => member.role === "owner").slice(0, 20);
      const notify = notifyClient(this.env.NOTIFY);
      await Promise.all(
        owners.map((owner) =>
          notify
            .notify(
              { username: owner.username },
              {
                id: `install-request:${request.id}:${owner.username}`,
                kind: "approval",
                workspace: slug,
                title: `@${asker.username} asks you to add ${request.name}`,
                body: request.note ?? (request.kind === "extension" ? "An extension. Install it, or turn the request down." : "An integration. Connect it, or turn the request down."),
                href: requestsPath(slug),
                actor: { kind: "user", id: asker.id, name: asker.username, avatar: asker.avatar ?? null, avatar_seed: null },
                created_at: new Date().toISOString(),
              },
            )
            .catch(() => undefined),
        ),
      );
    } catch (error) {
      console.error("agents: owners were not told of an install request", request.id, String(error));
    }
  }

  /** The person who asked hears their request was answered. */
  private async tellRequester(slug: string, by: User, answered: Answered): Promise<void> {
    if (!this.env.NOTIFY) return;
    const { request } = answered;
    const line = answerLine(request, `@${by.username}`);
    await notifyClient(this.env.NOTIFY)
      .notify(
        { user_id: answered.requested_by_id },
        {
          id: `install-answer:${request.id}`,
          kind: "inbox",
          workspace: slug,
          title: line.title,
          body: line.body,
          href: request.status === "done" ? listingPath(slug, request.listing) : requestsPath(slug),
          actor: { kind: "user", id: by.id, name: by.username, avatar: by.avatar ?? null, avatar_seed: null },
          created_at: new Date().toISOString(),
        },
      )
      .catch((error: unknown) => console.error("agents: a requester was not told", request.id, String(error)));
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
    const found = await this.visible(a.workspace, a.viewer, a.handle);
    if (!found.ok) return found;
    const { row } = found.value;
    // Owners change the workspace's agents; a member changes their own personal one.
    if (!canChange(a.viewer, a.workspace, row)) return fail("forbidden", isPersonal(row) ? NOT_YOURS_REFUSAL : MANAGE_REFUSAL);
    const workspaceId = found.value.workspaceId;
    const before = definitionOf(row);
    const { scope: _scope, ...asked } = (a.changes ?? {}) as Partial<NewWorkspaceAgent>;
    // The built-in @g1t keeps who it is and its job; the rest is the workspace's.
    // A personal agent stays on no team.
    const allowed = row.builtin
      ? builtinChanges(before, asked)
      : { ok: true as const, value: isPersonal(row) && asked.team !== undefined ? { ...asked, team: null } : asked };
    if (!allowed.ok) return fail("invalid", allowed.message);
    const checked = applyChanges(before, allowed.value, TEMPLATE_IDS, { builtin: !!row.builtin });
    if (!checked.ok) return fail("invalid", checked.message);
    const definition = checked.value;
    if (JSON.stringify(definition) === JSON.stringify(before)) return ok(toAgent(row, new Date()));
    if (definition.team !== before.team) {
      const team = await this.teamExists(a.workspace, a.viewer!, definition.team);
      if (!team.ok) return team;
    }
    if (definition.handle !== before.handle && (await this.handleTaken(workspaceId, definition.handle, row.id))) {
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
    this.audit(a.viewer!, a.workspace, "update_agent", definition.handle, `Changed @${definition.handle}${renamed} to version ${version}`, "agents", isPersonal(row) ? "member" : "owner");
    const saved = await this.row(workspaceId, definition.handle);
    return ok(toAgent(saved!, new Date()));
  }

  /** What each effort level has cost one agent, from its own finished sessions. */
  async effortCosts(a: { workspace: string; handle: string; viewer: User | null }): Promise<Result<AgentEffortCosts>> {
    if (a?.viewer && awaitsConfirmation(a.viewer)) return UNVERIFIED;
    const seen = await this.seen(a?.workspace ?? "", a?.viewer ?? null);
    if (!seen.ok) return seen;
    const row = await this.row(seen.value, a.handle);
    if (!row) return fail("not_found", `There is no agent called @${a.handle}.`);
    const outcomes = await outcomesSince(this.db, seen.value, sinceWindow(), row.id);
    return ok(effortCostsOf(row.handle, effortOf(definitionOf(row).routing), outcomes.get(row.id) ?? []));
  }

  /** Ways to spend less, checked against past work: every agent's, or one's. */
  async recommendations(a: { workspace: string; viewer: User | null; handle?: string | null }): Promise<Result<AgentRecommendations>> {
    if (a?.viewer && awaitsConfirmation(a.viewer)) return UNVERIFIED;
    const seen = await this.seen(a?.workspace ?? "", a?.viewer ?? null);
    if (!seen.ok) return seen;
    let agentId: string | null = null;
    if (a.handle) {
      const row = await this.row(seen.value, a.handle);
      if (!row) return fail("not_found", `There is no agent called @${a.handle}.`);
      agentId = row.id;
    }
    return ok(await readRecommendations(this.db, seen.value, agentId));
  }

  /**
   * Owners apply a suggestion (the agent's effort changes as a new version
   * of it, and the audit log says so) or dismiss it. Only an open one, and
   * only while the agent's setting is still the one it was made for.
   */
  async resolveRecommendation(a: { workspace: string; viewer: User | null; id: string; action: string }): Promise<Result<AgentRecommendation>> {
    const managed = await this.managed(a?.workspace ?? "", a?.viewer ?? null);
    if (!managed.ok) return managed;
    if (a.action !== "apply" && a.action !== "dismiss") return fail("invalid", "Apply or dismiss.");
    const found = await recommendationRow(this.db, managed.value, String(a.id ?? ""));
    if (!found) return fail("not_found", "There is no such suggestion.");
    if (found.status !== "open") return fail("conflict", "This suggestion was already decided, or is no longer current.");
    const by = a.viewer!.username;
    if (a.action === "dismiss") {
      if (!(await markResolved(this.db, found.id, "dismissed", by))) return fail("conflict", "This suggestion was decided meanwhile.");
      this.audit(a.viewer!, a.workspace, "dismiss_recommendation", found.handle ?? found.agent_id, `Dismissed "${found.title}"`);
    } else {
      const agent = await this.row(managed.value, found.handle);
      if (!agent || agent.id !== found.agent_id) return fail("not_found", "That agent is gone.");
      if (effortOf(definitionOf(agent).routing) !== found.from_effort) {
        await this.db.prepare("UPDATE agent_recommendations SET status = 'stale' WHERE id = ? AND status = 'open'").bind(found.id).run();
        return fail("conflict", `@${agent.handle}'s effort was changed since this was suggested. The next check looks again.`);
      }
      // Claimed first, so two owners pressing Apply change the agent once.
      if (!(await markResolved(this.db, found.id, "applied", by))) return fail("conflict", "This suggestion was decided meanwhile.");
      const changed = await this.update({ workspace: a.workspace, handle: agent.handle, viewer: a.viewer, changes: { routing: { effort: found.to_effort as never } } });
      if (!changed.ok) {
        await this.db.prepare("UPDATE agent_recommendations SET status = 'open', resolved_by = NULL, resolved_at = NULL WHERE id = ?").bind(found.id).run();
        return changed;
      }
      this.audit(
        a.viewer!,
        a.workspace,
        "apply_recommendation",
        agent.handle,
        `Applied "${found.title}": @${agent.handle}'s effort from ${EFFORT_NAMES[found.from_effort as keyof typeof EFFORT_NAMES] ?? found.from_effort} to ${EFFORT_NAMES[found.to_effort as keyof typeof EFFORT_NAMES] ?? found.to_effort}`,
      );
    }
    const after = await recommendationRow(this.db, managed.value, found.id);
    return ok(toRecommendation(after!));
  }

  async archive(a: { workspace: string; handle: string; viewer: User | null }): Promise<Result<null>> {
    const found = await this.visible(a.workspace, a.viewer, a.handle);
    if (!found.ok) return found;
    const { row } = found.value;
    // Owners archive any agent; a member their own personal one.
    if (!canArchive(a.viewer, a.workspace, row)) return fail("forbidden", MANAGE_REFUSAL);
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
  private audit(
    actor: User,
    workspace: string,
    action: string,
    handle: string,
    message: string,
    area: "agents" | "marketplace" = "agents",
    rule: "owner" | "member" | null = null,
  ): void {
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
      path: `${area}/${handle}`,
      outcome: "allowed",
      rule: rule ?? (area === "marketplace" && action === "request_install" ? "member" : "owner"),
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
    case "draft":
      return Response.json(await service.draft(args));
    case "try_draft":
      return Response.json(await service.tryDraft(args));
    case "redraft":
      return Response.json(await service.redraft(args));
    case "promote":
      return Response.json(await service.promote(args));
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
    case "team_context":
      return Response.json(await service.view(args, (ctx) => views.teamContext(ctx, args.handle)));
    case "activity":
      return Response.json(await service.view(args, (ctx) => views.activity(ctx, args.handle)));
    case "versions":
      return Response.json(await service.view(args, (ctx) => views.versions(ctx, args.handle)));
    case "card_action":
      return Response.json(await service.cardAction(args));
    case "policy":
      return Response.json(await service.view(args, (ctx) => views.policy(ctx)));
    case "install_requests":
      return Response.json(await service.installRequests(args));
    case "request_install":
      return Response.json(await service.requestInstall(args));
    case "resolve_install_request":
      return Response.json(await service.resolveInstallRequest(args));
    case "extension_installs":
      return Response.json(await service.extensionInstalls(args));
    case "install_extension":
      return Response.json(await service.installExtension(args));
    case "set_extension_enabled":
      return Response.json(await service.setExtensionEnabled(args));
    case "set_extension_budget":
      return Response.json(await service.setExtensionBudget(args));
    case "uninstall_extension":
      return Response.json(await service.uninstallExtension(args));
    case "effort_costs":
      return Response.json(await service.effortCosts(args));
    case "recommendations":
      return Response.json(await service.recommendations(args));
    case "resolve_recommendation":
      return Response.json(await service.resolveRecommendation(args));
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

  /** Every few minutes: routines that are due, session steps a desk lost, and once an hour the spend check. */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const sessions = env as unknown as SessionEnv;
    ctx.waitUntil(
      Promise.all([
        runDue(sessions).catch((error: unknown) => console.error("agents: routines did not run", String(error))),
        sweep(sessions).catch((error: unknown) => console.error("agents: the session sweep failed", String(error))),
        // Spend less, keep quality: each workspace checked weekly (src/recommend.ts).
        checkDue(env.DB).catch((error: unknown) => console.error("agents: the spend check failed", String(error))),
      ]),
    );
  },
} satisfies ExportedHandler<Env>;
