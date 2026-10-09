/**
 * A workspace's own agents: named members with a job, a personality,
 * routing limits and a budget, kept by the agents service
 * (`services/agents`). `@g1t` is the platform's agent and is not one of
 * these. Plan: docs/WORKSPACE.md.
 *
 * Wire shapes are snake_case end to end.
 */
import type { ServiceBinding } from "./clients";
import type { Role, User } from "./identity";
import type { Result } from "./result";

// Model tiers (`ModelTier`, `MODEL_TIERS`) are integrations.ts's, the
// same ones runs are routed between.
import type { ModelTier } from "./integrations";

/** Voice presets; free text in `personality` refines them. */
export type PersonalityPreset = "crisp" | "friendly" | "socratic" | "terse";

export type AgentRouting = {
  /** Never route below this tier. Null: no floor. */
  floor: ModelTier | null;
  /** Never route above this tier. Null: no ceiling. */
  ceiling: ModelTier | null;
  /**
   * Where its model calls may go. Empty: anything the workspace allows.
   * `g1t`: g1t's hosted models. `workspace`: the workspace's own providers
   * (Integrations), whichever they are. Any other entry: one of the
   * workspace's own providers by integration id. Entries combine, so
   * `["g1t", "workspace"]` is both.
   */
  providers: string[];
  /** Advanced: a fixed `provider/model`, for own endpoints. Usually null. */
  pinned: string | null;
};

export type AgentBudget = {
  /** Monthly cap in micro-dollars. Null: only the workspace limit applies. */
  monthly_micros: number | null;
  daily_micros: number | null;
  /** Default cap for one task. */
  task_micros: number | null;
};

export type AgentAutonomy = {
  open_pull_requests: "alone" | "approval";
  merge: "alone" | "approval" | "never";
  deploy_production: "approval" | "never";
  edit_docs: "alone" | "suggest";
};

export type AgentStatus = "idle" | "working" | "waiting" | "out_of_budget" | "paused";

export type WorkspaceAgent = {
  id: string;
  workspace_id: string;
  /** Lowercase, unique in the workspace, never `g1t`. Mentioned as `@handle`. */
  handle: string;
  display_name: string;
  /** Uploaded avatar hash, or null for the generated mark. */
  avatar: string | null;
  /** One line: "Reviews every pull request in g1t". */
  role: string;
  /** The job: what it is responsible for and how it works. */
  instructions: string;
  personality_preset: PersonalityPreset;
  /** Free text refining the voice. Never changes what it may do. */
  personality: string;
  routing: AgentRouting;
  budget: AgentBudget;
  autonomy: AgentAutonomy;
  /** Tasks it works at once; more queue on its desk. */
  capacity: number;
  /** The template it was made from, if any. */
  template: string | null;
  version: number;
  status: AgentStatus;
  /** Spend this calendar month, in micro-dollars. */
  spent_month_micros: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

export type NewWorkspaceAgent = {
  handle: string;
  display_name: string;
  role: string;
  instructions: string;
  personality_preset?: PersonalityPreset;
  personality?: string;
  routing?: Partial<AgentRouting>;
  budget?: Partial<AgentBudget>;
  autonomy?: Partial<AgentAutonomy>;
  capacity?: number;
  template?: string | null;
};

export type AgentTemplate = {
  id: string;
  display_name: string;
  handle: string;
  role: string;
  instructions: string;
  personality_preset: PersonalityPreset;
  routing: AgentRouting;
};

/** What the chat service hands an agent: a message it should answer. */
export type AgentDelivery = {
  workspace: string;
  workspace_id: string;
  channel_id: string;
  channel_kind: "channel" | "dm";
  channel_name: string | null;
  agent_id: string;
  /** The message that woke it. */
  message_id: string;
  thread_root: string | null;
  /** Who asked: the person's user id. */
  asked_by: string;
  /** Agent-to-agent hops so far in this chain. */
  hops: number;
  /**
   * What the person who asked may do, from the viewer the chat service
   * already holds when the message is posted (`askerAccess`). An agent
   * never does more for someone than they could do themselves
   * (docs/WORKSPACE.md, "The whole company"). Absent from an older chat
   * service: the agent then treats the asker as unable to change code.
   */
  asker?: AskerAccess | null;
  /**
   * Where the conversation is: g1t's own chat, or later another chat app
   * the workspace connected (docs/WORKSPACE.md, "Working from another chat
   * app"). The agent reads and replies through that surface; its
   * definition, budget and replies are the same everywhere. Absent: `g1t`.
   */
  surface?: AgentSurface;
};

/** The chat surfaces an agent answers on. Only g1t's own today. */
export type AgentSurface = "g1t";

/** Who asked an agent, as far as its reply needs to know. */
export type AskerAccess = {
  username: string;
  /** Their role in the workspace; `outside` for someone who is not a member. */
  role: Role | "outside";
  /**
   * Whether they can change code in the workspace: Code is on for them
   * and they hold write access (or more) on at least one of its
   * repositories, through the base permission or a grant.
   */
  can_write: boolean;
};

const WRITING_ROLES = new Set(["write", "maintain", "admin"]);

/**
 * `user`'s access in `workspace`, for `AgentDelivery.asker`. Pure, with no
 * imports, so the chat service computes it from its viewer for free.
 */
export function askerAccess(user: User, workspace: string): AskerAccess {
  const slug = workspace.toLowerCase();
  const membership = user.workspaces?.find((m) => m.slug.toLowerCase() === slug);
  // Someone who uses only Chat, Docs and agents sees no repository at all.
  const code = membership?.code_access !== false;
  const base = membership ? membership.role === "owner" || WRITING_ROLES.has(membership.base_permission ?? "write") : false;
  const granted = (user.grants ?? []).some((grant) => grant.workspace.toLowerCase() === slug && WRITING_ROLES.has(grant.role));
  return {
    username: user.username,
    role: membership?.role ?? "outside",
    can_write: code && (base || granted),
  };
}

export type WorkspaceAgentsApi = {
  list(workspace: string, viewer: User): Promise<Result<WorkspaceAgent[]>>;
  get(workspace: string, handle: string, viewer: User): Promise<Result<WorkspaceAgent>>;
  /** Internal: by id, for the chat service resolving members. */
  byIds(ids: string[]): Promise<WorkspaceAgent[]>;
  create(workspace: string, viewer: User, input: NewWorkspaceAgent): Promise<Result<WorkspaceAgent>>;
  update(
    workspace: string,
    handle: string,
    viewer: User,
    changes: Partial<NewWorkspaceAgent>,
  ): Promise<Result<WorkspaceAgent>>;
  archive(workspace: string, handle: string, viewer: User): Promise<Result<null>>;
  templates(): Promise<AgentTemplate[]>;
  /** The chat service hands over a message for an agent to answer. Returns at once. */
  deliver(delivery: AgentDelivery): Promise<Result<null>>;
};

async function rpc<T>(service: ServiceBinding, method: string, args: object): Promise<T> {
  const response = await service.fetch(`https://service/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!response.ok) {
    throw new Error(`${method} failed with status ${response.status}`);
  }
  return (await response.json()) as T;
}

export function workspaceAgentsClient(service: ServiceBinding): WorkspaceAgentsApi {
  const call = <T>(method: string, args: object) => rpc<T>(service, method, args);
  return {
    list: (workspace, viewer) => call("list", { workspace, viewer }),
    get: (workspace, handle, viewer) => call("get", { workspace, handle, viewer }),
    byIds: (ids) => call("by_ids", { ids }),
    create: (workspace, viewer, input) => call("create", { workspace, viewer, input }),
    update: (workspace, handle, viewer, changes) => call("update", { workspace, handle, viewer, changes }),
    archive: (workspace, handle, viewer) => call("archive", { workspace, handle, viewer }),
    templates: () => call("templates", {}),
    deliver: (delivery) => call("deliver", delivery),
  };
}
