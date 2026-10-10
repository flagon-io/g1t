/**
 * A workspace's own agents: named members with a job, a personality,
 * routing limits and a budget, kept by the agents service
 * (`services/agents`). Every workspace also has `@g1t`, its built-in
 * orchestrator, kept the same way (`builtin`).
 *
 * Wire shapes are snake_case end to end.
 */
import type { ServiceBinding } from "./clients";
import type { Role, User } from "./identity";
import type { Result } from "./result";
import type { CardActionResult } from "./chat";

// Model tiers (`ModelTier`, `MODEL_TIERS`) are integrations.ts's, the
// same ones runs are routed between.
import type { ModelTier } from "./integrations";
import type { ExtensionInstall, InstallRequest, InstallRequestStatus, InstallRequests } from "./marketplace";

/** The built-in orchestrator's handle; nobody else's agent may take it. */
export const BUILTIN_AGENT_HANDLE = "g1t";

/** The built-in orchestrator's template id: not one a workspace can adopt. */
export const ORCHESTRATOR_TEMPLATE = "orchestrator";

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
  /**
   * What its generated avatar is drawn from: a little pixel creature, the
   * same for the same seed everywhere. Set from the handle when it is
   * made; changing it gives the agent a new face.
   */
  avatar_seed: string;
  /**
   * One line, as lists show it: "QA Engineer on the QA team". Made from
   * the title and team (or department) when not written.
   */
  role: string;
  /**
   * Agents are hired into roles, not tasks: a title, a team, and broad
   * responsibilities.
   */
  title: string;
  /** The team it is on, by slug, from the workspace's teams; null for none. */
  team: string | null;
  /** A label for where it works when it is on no team: "QA", "Sales". */
  department: string;
  /** What it is responsible for: 2 to 8 short duties, or none yet. */
  responsibilities: string[];
  /**
   * Specialised help it will use inside its own work. Never members, never
   * wider than their agent. Stored now; they run with tasks and sessions.
   */
  subagents: SubagentDef[];
  /**
   * Its required reading: Docs spaces (by id) it checks first, every time
   * it answers or works. It still reads only what the person it acts for,
   * and everyone reading its answer, can read.
   */
  reading: string[];
  /**
   * g1t's foundational skills turned off for it, by id (./skills.ts):
   * every one is on unless named here. Off takes the skill's playbook out of
   * its instructions; its tools stay as they are.
   */
  skills_off: string[];
  /**
   * Who it works with: `internal`, the workspace's own people (back
   * office), or `customers` (front office). Only `internal` for now.
   */
  faces: AgentFaces;
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
  /**
   * The workspace's built-in orchestrator, `@g1t`: every workspace has one,
   * made the first time its agents are asked for. It cannot be archived,
   * and its handle, name, role and job are fixed; its `instructions` are
   * added to that job. Listed first.
   */
  builtin: boolean;
  version: number;
  status: AgentStatus;
  /** Spend this calendar month, in micro-dollars. */
  spent_month_micros: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

/**
 * Back office or front office (docs.g1t.sh/guides/agents/, "Back office
 * and front office"). Customer-facing agents are not available yet.
 */
export type AgentFaces = "internal" | "customers";

/**
 * A subagent: help an agent keeps for its own work, such as Margo's
 * `flake-hunter`. Its routing limits sit within its agent's: a floor below
 * the agent's is raised to it, a ceiling above is lowered to it.
 */
export type SubagentDef = {
  /** Lowercase letters, digits and hyphens: `flake-hunter`. Unique on the agent. */
  name: string;
  /** One line: what it is for. */
  description: string;
  instructions: string;
  routing: { floor: ModelTier | null; ceiling: ModelTier | null };
  /** How many of it may run at once inside one task, 1 to 8. */
  max_parallel: number;
};

export type NewWorkspaceAgent = {
  handle: string;
  display_name: string;
  /** Left out or empty: made from the title and team. */
  role?: string;
  title?: string;
  team?: string | null;
  department?: string;
  responsibilities?: string[];
  subagents?: SubagentDef[];
  /** Docs spaces (by id) it reads first; at most 10. */
  reading?: string[];
  /** Foundational skills to turn off, by id (./skills.ts). */
  skills_off?: string[];
  /** Only `internal` for now; `customers` is refused. */
  faces?: AgentFaces;
  instructions: string;
  personality_preset?: PersonalityPreset;
  personality?: string;
  routing?: Partial<AgentRouting>;
  budget?: Partial<AgentBudget>;
  autonomy?: Partial<AgentAutonomy>;
  capacity?: number;
  template?: string | null;
  /** Its avatar's seed; left out, the handle. */
  avatar_seed?: string;
};

/**
 * A role to hire an agent into, by department. Agents get names, not job
 * titles ("Margo", the QA Engineer).
 */
export type AgentTemplate = {
  id: string;
  /** The name it suggests first. */
  display_name: string;
  handle: string;
  /** Other names that suit it, for the form's shuffle. Each is also a valid handle, lowercased. */
  name_ideas: string[];
  role: string;
  title: string;
  department: string;
  responsibilities: string[];
  subagents: SubagentDef[];
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
   * never does more for someone than they could do themselves. Absent
   * from an older chat service: the agent then treats the asker as unable
   * to change code.
   */
  asker?: AskerAccess | null;
  /**
   * The agents that handled this request before this one, by id, oldest
   * first; the last sent the work here. An agent never hands back or
   * consults the one that sent it work, and the hop limit counts every
   * hand-off and consult along the chain. Absent: none (a person asked).
   */
  chain?: string[];
  /**
   * Where the conversation is: g1t's own chat, or later another chat app
   * the workspace connected. The agent reads and replies through that
   * surface; its definition, budget and replies are the same everywhere.
   * Absent: `g1t`.
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

/**
 * A session: one bounded piece of work an agent took on
 * (docs.g1t.sh/guides/agent-sessions/). A conversation with an agent is
 * not a session: talking stays cheap and quick, and when a request needs
 * real work the agent spins off a session for it, with its own context, transcript, budget and live card in
 * the conversation. Sessions start other sessions (one of the agent's
 * subagents, or a colleague brought in), and everything a tree of sessions
 * spends is charged to the agent at its root, so a chain never escapes the
 * budget that started it.
 */
export type AgentSessionKind =
  /** Spun off from a conversation: someone asked for work. */
  | "chat"
  /** A routine's run. */
  | "routine"
  /** A colleague brought in by another session. */
  | "helper"
  /** One of the agent's own subagents, inside another session. */
  | "subagent";

export type AgentSessionStatus =
  | "queued"
  | "working"
  /** Waiting on sessions it started. */
  | "waiting"
  /** Stopped at its spend cap: someone who may raise it decides. */
  | "needs_approval"
  | "done"
  | "failed"
  | "stopped";

/** The statuses of a session that is not over. */
export const SESSION_LIVE: readonly AgentSessionStatus[] = ["queued", "working", "waiting", "needs_approval"];

export type AgentSession = {
  id: string;
  workspace_id: string;
  agent_id: string;
  /** The agent's handle, name and face, for lists. */
  agent_handle: string;
  agent_name: string;
  agent_avatar_seed: string;
  /** The subagent running it, by name, when kind is `subagent`. */
  subagent: string | null;
  kind: AgentSessionKind;
  /** The session that started it, and the root of its tree. */
  parent_id: string | null;
  root_id: string;
  /** Whose budget pays for it: the agent at the root of its tree. */
  payer_agent_id: string;
  title: string;
  goal: string;
  status: AgentSessionStatus;
  /** Why it is waiting, stopped or failed, in a line. */
  status_note: string | null;
  /** What it found or did, once done: its report. */
  summary: string | null;
  /** Where it reports: the conversation it was started from. */
  channel_id: string;
  channel_kind: "channel" | "dm";
  channel_name: string | null;
  /** Its live card in that conversation; its updates go in the card's thread. */
  card_message_id: string | null;
  asked_by: string | null;
  asked_by_username: string | null;
  routine_id: string | null;
  steps: number;
  tool_calls: number;
  input_tokens: number;
  output_tokens: number;
  /**
   * At list price, what it counts against budgets: the model at the
   * provider's price with billing's model margin, plus g1t's agent rate on
   * every token. A root session's includes everything its tree spent.
   */
  charged_micros: number;
  /** What its own steps' model answers cost at the provider's price, its tree's not included. */
  cost_micros: number;
  /** The most it may spend before someone approves more. */
  cap_micros: number | null;
  model: string | null;
  /** What it produced: issues filed, sessions started. */
  outputs: SessionOutput[];
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  /**
   * False when the viewer is not among the people of the conversation it
   * came from: they see that it ran and what it cost, never its title,
   * goal, report or transcript.
   */
  visible: boolean;
};

export type SessionOutput =
  | { kind: "issue"; repo: string; number: number; title: string }
  | { kind: "session"; id: string; agent_handle: string; title: string }
  | { kind: "memory"; id: string; body: string };

/** One entry of a session's transcript, as its page shows it. */
export type SessionEvent = {
  seq: number;
  kind: "goal" | "text" | "tool" | "steer" | "update" | "child" | "result" | "note";
  /** Who: the agent's handle, a person's username (steering), or null for g1t's notes. */
  by: string | null;
  body: string;
  /** For `tool`: the tool, and whether it read, was withheld, refused or failed. */
  tool: string | null;
  outcome: string | null;
  created_at: string;
};

export type AgentSessionDetail = {
  session: AgentSession;
  events: SessionEvent[];
  /** Every session in its tree, root first. */
  tree: AgentSession[];
  /** Whether the viewer may stop it, steer it, or approve more spend. */
  can_stop: boolean;
  can_steer: boolean;
  can_approve: boolean;
};

/**
 * What an agent remembers (docs.g1t.sh/guides/agent-memory/). Every fact
 * carries where it came from, and its scope decides, in code, where it may
 * be recalled and who may see it:
 *
 * - `workspace`: anywhere in the workspace. Owners write these, or an agent
 *   from a public channel, which every member can read already.
 * - `channel`: only in that channel and its threads.
 * - `person`: only in a direct message with that one person.
 */
export type AgentMemoryScope = "workspace" | "channel" | "person";

export type AgentMemory = {
  id: string;
  agent_id: string;
  scope: AgentMemoryScope;
  /** The channel's id or the person's user id; empty for `workspace`. */
  scope_ref: string;
  /** The channel's name or the person's username, for display. */
  scope_label: string | null;
  body: string;
  source_kind: "message" | "session" | "person";
  /** A message id, a session id, or the username of who wrote it. */
  source_ref: string | null;
  source_label: string | null;
  /** The channel the source is in, for a link. */
  source_channel_id: string | null;
  created_by: string;
  created_by_kind: "agent" | "user";
  pinned: boolean;
  created_at: string;
  updated_at: string;
};

/** When a routine runs, in UTC. */
export type RoutineSchedule = {
  every: "hour" | "day" | "weekday" | "week";
  /** Minute of the hour, 0 to 59. */
  minute: number;
  /** Hour of the day (UTC), 0 to 23; not used for `hour`. */
  hour: number;
  /** Day of the week for `week`, 0 (Sunday) to 6. */
  weekday: number;
};

/**
 * Things that happen in the workspace a routine can run on
 * (docs.g1t.sh/guides/agent-routines/). Each run is one session about the one
 * thing that happened, in a repository its sponsor can read.
 */
export const ROUTINE_EVENTS = [
  { key: "pull_ready", label: "A pull request is ready for review", hint: "Opened ready, or moved out of draft." },
  { key: "pull_merged", label: "A pull request is merged", hint: "On any branch it targets." },
  { key: "checks_failed", label: "Checks fail on a pull request", hint: "Its required checks failed or errored." },
  { key: "issue_opened", label: "An issue is opened", hint: "By a person or an agent." },
  { key: "deploy_failed", label: "A deploy fails", hint: "A production or preview deploy." },
] as const;

export type RoutineEvent = (typeof ROUTINE_EVENTS)[number]["key"];

/**
 * A routine: work an agent does on a schedule or when something happens, such as Sam's Monday digest
 * of support themes. Each run is a session posted in the routine's channel,
 * paid from the agent's budget, and run with the access of the person who
 * set it up (its sponsor), never more.
 */
export type AgentRoutine = {
  id: string;
  agent_id: string;
  name: string;
  instructions: string;
  /** When it runs on a clock; null when it runs only on events. */
  schedule: RoutineSchedule | null;
  /** What it runs on; empty when it runs only on its schedule. */
  events: RoutineEvent[];
  /** Which repositories its events come from, by `workspace/name`; empty: every one its sponsor can read. */
  repos: string[];
  channel_id: string;
  channel_name: string | null;
  sponsor: string;
  sponsor_username: string | null;
  enabled: boolean;
  /** Why g1t paused it, when it did. */
  paused_note: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  last_session_id: string | null;
  runs: number;
  created_at: string;
  updated_at: string;
};

/** A routine suggested from an agent's responsibilities, for an owner to add in one step. */
export type RoutineSuggestion = { responsibility: string; routine: Omit<NewRoutine, "channel_id"> };

export type NewRoutine = {
  name: string;
  instructions: string;
  /** A schedule, events, or both; at least one. */
  schedule: RoutineSchedule | null;
  events?: RoutineEvent[];
  repos?: string[];
  /** A channel the agent is in, by id. */
  channel_id: string;
  enabled?: boolean;
};

/**
 * The workspace's say over all its agents together, set by owners: one
 * monthly budget across every agent, the budget a new agent starts with,
 * and the cap a session starts with. The workspace's spend limit and AI
 * credit (billing) sit above all of it.
 */
export type AgentPolicy = {
  /** Every agent's spend together in a month. Null: only the workspace's spend limit. */
  monthly_micros: number | null;
  /** The monthly budget a new agent gets. Null: none. */
  default_agent_monthly_micros: number | null;
  /** The cap one session starts with, unless its agent's per-task cap is lower. */
  default_session_micros: number;
  /**
   * What the agents working for one person (their replies and sessions,
   * asked for by that person) may spend together in a month, unless the
   * person has a budget of their own. Null: no budget per person.
   */
  person_monthly_micros: number | null;
};

/** One person's budget: what agents working for them may spend in a month, and what they have. */
export type PersonBudget = {
  username: string;
  /** The budget that applies: their own, or the workspace's per-person default. Null: none. */
  monthly_micros: number | null;
  /** Whether it is their own, set by an owner, rather than the default. */
  own: boolean;
  /** What agents spent for them this month (UTC). */
  spent_micros: number;
};

/** Budgets per person: the default, and each person who has one of their own or has spent this month. */
export type PersonBudgets = {
  period: string;
  default_micros: number | null;
  /** Owners see everyone; anyone else sees only themselves. Most spent first. */
  people: PersonBudget[];
};

export type SpendSlice = { key: string; label: string; micros: number; count: number };

/** Which days a breakdown covers: this month (the default), last month, or the last 7 or 30 days, in UTC. */
export type SpendPeriod = "month" | "last_month" | "7d" | "30d";

/** Where an agent's (or every agent's) spend went over a period. */
export type AgentSpendBreakdown = {
  /** `YYYY-MM` for a month; for a span of days, the month it ends in. */
  period: string;
  /** The span asked for, and its first and last day (`YYYY-MM-DD`, both included). */
  span: SpendPeriod;
  from: string;
  until: string;
  /** The one person it is about (work asked for by them), or null for everyone's. */
  person: string | null;
  total_micros: number;
  /** Chat replies, sessions, routines, helping colleagues. */
  by_kind: SpendSlice[];
  by_model: SpendSlice[];
  /** Who asked: the work done for each person. */
  by_person: SpendSlice[];
  by_agent: SpendSlice[];
  by_team: SpendSlice[];
  /**
   * Where it was asked: a channel by id (labelled `#name`), direct
   * messages together (`dm`), and channels the viewer can't read together
   * (`private`).
   */
  by_channel: SpendSlice[];
  /** The costliest sessions in the period. */
  top_sessions: AgentSession[];
  /** Spend by day in the period. */
  days: { day: string; micros: number }[];
};

/** Agents mode's front page. */
export type AgentsOverview = {
  policy: AgentPolicy;
  /** Every agent's spend this month, against the policy's budget. */
  spent_month_micros: number;
  /** The highest alert this month: 75, 90 or 100 (% of the workspace's agent budget). */
  alert: number | null;
  agents: WorkspaceAgent[];
  /** Live sessions, counted by agent id, for the roster. */
  live_by_agent: Record<string, number>;
  /** Sessions live now that the viewer can see. */
  live: AgentSession[];
  /** Sessions waiting on the viewer: spend they may approve. */
  waiting_on_you: AgentSession[];
  /** Recently finished sessions the viewer can see. */
  recent: AgentSession[];
  /** The next routines to run on a schedule. */
  upcoming: (AgentRoutine & { agent_handle: string; agent_name: string })[];
  spend: AgentSpendBreakdown;
  can_manage: boolean;
};

/** One thing an agent did, for its Activity tab. */
export type AgentActivity = {
  id: string;
  kind: "reply" | "session";
  status: string;
  channel_id: string;
  channel_name: string | null;
  /** The session's title; null for a reply or one the viewer can't see. */
  title: string | null;
  asked_by_username: string | null;
  model: string | null;
  tools: number;
  charged_micros: number;
  created_at: string;
  visible: boolean;
  /** For a reply, the message it posted; for a session, its id. */
  ref: string | null;
};

export type AgentVersion = { version: number; changed_by: string; created_at: string; definition: Partial<NewWorkspaceAgent> };

/** A card action, as chat hands it to agents. */
export type AgentCardAction = {
  workspace: string;
  channel_id: string;
  message_id: string;
  viewer: User;
  card: { kind: string; ref: string | null };
  action_id: string;
  input: string | null;
};

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
  /**
   * Internal: the workspace's built-in `@g1t` agent, made if it does not
   * exist yet. The chat service asks for it when someone mentions @g1t in
   * a channel it is not in yet.
   */
  builtin(workspace: string, workspaceId: string): Promise<Result<WorkspaceAgent>>;
  /** The chat service hands over a message for an agent to answer. Returns at once. */
  deliver(delivery: AgentDelivery): Promise<Result<null>>;
  overview(workspace: string, viewer: User): Promise<Result<AgentsOverview>>;
  sessions(
    workspace: string,
    viewer: User,
    filter?: { handle?: string | null; status?: "live" | "done" | null; limit?: number | null },
  ): Promise<Result<AgentSession[]>>;
  session(workspace: string, id: string, viewer: User): Promise<Result<AgentSessionDetail>>;
  /** Stops a session and every session under it. */
  stopSession(workspace: string, id: string, viewer: User): Promise<Result<AgentSession>>;
  /** Raises a stopped session's cap and lets it go on. Owners only. */
  approveSession(workspace: string, id: string, viewer: User, capMicros: number): Promise<Result<AgentSession>>;
  /** A person's message to a session, running or finished: it reads it and goes on. */
  steerSession(workspace: string, id: string, viewer: User, body: string): Promise<Result<AgentSession>>;
  memories(workspace: string, handle: string, viewer: User): Promise<Result<AgentMemory[]>>;
  remember(
    workspace: string,
    handle: string,
    viewer: User,
    input: { body: string; scope: AgentMemoryScope; scope_ref?: string | null },
  ): Promise<Result<AgentMemory>>;
  updateMemory(
    workspace: string,
    handle: string,
    viewer: User,
    id: string,
    changes: { body?: string; pinned?: boolean },
  ): Promise<Result<AgentMemory>>;
  forget(workspace: string, handle: string, viewer: User, id: string): Promise<Result<null>>;
  routines(workspace: string, handle: string, viewer: User): Promise<Result<{ routines: AgentRoutine[]; suggestions: RoutineSuggestion[] }>>;
  saveRoutine(workspace: string, handle: string, viewer: User, input: NewRoutine, id?: string | null): Promise<Result<AgentRoutine>>;
  deleteRoutine(workspace: string, handle: string, viewer: User, id: string): Promise<Result<null>>;
  /** Runs a routine now, as a session. */
  runRoutine(workspace: string, handle: string, viewer: User, id: string): Promise<Result<AgentSession>>;
  /**
   * Where the spend went: one agent's, or every agent's; this month unless
   * `period` says otherwise; for everyone, or only the work one `person`
   * (by username) asked for.
   */
  spend(workspace: string, viewer: User, handle?: string | null, options?: { period?: SpendPeriod | null; person?: string | null }): Promise<Result<AgentSpendBreakdown>>;
  /** Budgets per person this month: owners see everyone's, anyone else their own. */
  personBudgets(workspace: string, viewer: User): Promise<Result<PersonBudgets>>;
  /**
   * Gives one person a monthly budget of their own (`monthly_micros`; 0 for
   * no budget at all), or with null puts them back on the default. Owners only.
   */
  setPersonBudget(workspace: string, viewer: User, username: string, monthlyMicros: number | null): Promise<Result<PersonBudgets>>;
  activity(workspace: string, handle: string, viewer: User): Promise<Result<AgentActivity[]>>;
  versions(workspace: string, handle: string, viewer: User): Promise<Result<AgentVersion[]>>;
  /**
   * Internal, from chat: a person pressed an action on one of agents'
   * cards. Agents checks they may, acts, and updates the card.
   */
  cardAction(input: AgentCardAction): Promise<Result<CardActionResult>>;
  policy(workspace: string, viewer: User): Promise<Result<AgentPolicy>>;
  setPolicy(workspace: string, viewer: User, policy: Partial<AgentPolicy>): Promise<Result<AgentPolicy>>;
  /**
   * The Marketplace's install requests (./marketplace.ts): every one in the
   * workspace for an owner, a member's own for anyone else.
   */
  installRequests(workspace: string, viewer: User): Promise<Result<InstallRequests>>;
  /**
   * A member asks the workspace's owners to add a listing
   * (`extension:<id>` or `integration:<connector>`), and every owner is
   * notified. Owners add
   * things themselves, so they don't ask. Asking again while a request for
   * the same listing is open is a conflict.
   */
  requestInstall(workspace: string, viewer: User, listing: string, note?: string | null): Promise<Result<InstallRequest>>;
  /** An owner marks a request added (`done`) or turns it down (`declined`); whoever asked is told. */
  resolveInstallRequest(workspace: string, viewer: User, id: string, status: Exclude<InstallRequestStatus, "open">): Promise<Result<InstallRequest>>;
  /** The extensions installed in the workspace; any member sees them. */
  extensionInstalls(workspace: string, viewer: User): Promise<Result<ExtensionInstall[]>>;
  /** Owners install a published extension at its current version; open requests for it are answered. */
  installExtension(workspace: string, viewer: User, extension: string): Promise<Result<ExtensionInstall>>;
  /** Owners switch an install on or off: off is the kill switch. */
  setExtensionEnabled(workspace: string, viewer: User, listing: string, enabled: boolean): Promise<Result<ExtensionInstall>>;
  /** Owners cap what an install spends a month; null leaves it to the workspace's limit. */
  setExtensionBudget(workspace: string, viewer: User, listing: string, monthlyMicros: number | null): Promise<Result<ExtensionInstall>>;
  uninstallExtension(workspace: string, viewer: User, listing: string): Promise<Result<null>>;
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
    builtin: (workspace, workspaceId) => call("builtin", { workspace, workspace_id: workspaceId }),
    deliver: (delivery) => call("deliver", delivery),
    overview: (workspace, viewer) => call("overview", { workspace, viewer }),
    sessions: (workspace, viewer, filter) => call("sessions", { workspace, viewer, ...(filter ?? {}) }),
    session: (workspace, id, viewer) => call("session", { workspace, id, viewer }),
    stopSession: (workspace, id, viewer) => call("stop_session", { workspace, id, viewer }),
    approveSession: (workspace, id, viewer, capMicros) => call("approve_session", { workspace, id, viewer, cap_micros: capMicros }),
    steerSession: (workspace, id, viewer, body) => call("steer_session", { workspace, id, viewer, body }),
    memories: (workspace, handle, viewer) => call("memories", { workspace, handle, viewer }),
    remember: (workspace, handle, viewer, input) => call("remember", { workspace, handle, viewer, input }),
    updateMemory: (workspace, handle, viewer, id, changes) => call("update_memory", { workspace, handle, viewer, id, changes }),
    forget: (workspace, handle, viewer, id) => call("forget", { workspace, handle, viewer, id }),
    routines: (workspace, handle, viewer) => call("routines", { workspace, handle, viewer }),
    saveRoutine: (workspace, handle, viewer, input, id) => call("save_routine", { workspace, handle, viewer, input, id: id ?? null }),
    deleteRoutine: (workspace, handle, viewer, id) => call("delete_routine", { workspace, handle, viewer, id }),
    runRoutine: (workspace, handle, viewer, id) => call("run_routine", { workspace, handle, viewer, id }),
    spend: (workspace, viewer, handle, options) =>
      call("spend", { workspace, viewer, handle: handle ?? null, period: options?.period ?? null, person: options?.person ?? null }),
    personBudgets: (workspace, viewer) => call("person_budgets", { workspace, viewer }),
    setPersonBudget: (workspace, viewer, username, monthlyMicros) =>
      call("set_person_budget", { workspace, viewer, username, monthly_micros: monthlyMicros }),
    activity: (workspace, handle, viewer) => call("activity", { workspace, handle, viewer }),
    versions: (workspace, handle, viewer) => call("versions", { workspace, handle, viewer }),
    cardAction: (input) => call("card_action", input),
    policy: (workspace, viewer) => call("policy", { workspace, viewer }),
    setPolicy: (workspace, viewer, policy) => call("set_policy", { workspace, viewer, policy }),
    installRequests: (workspace, viewer) => call("install_requests", { workspace, viewer }),
    requestInstall: (workspace, viewer, listing, note) => call("request_install", { workspace, viewer, listing, note: note ?? null }),
    resolveInstallRequest: (workspace, viewer, id, status) => call("resolve_install_request", { workspace, viewer, id, status }),
    extensionInstalls: (workspace, viewer) => call("extension_installs", { workspace, viewer }),
    installExtension: (workspace, viewer, extension) => call("install_extension", { workspace, viewer, extension }),
    setExtensionEnabled: (workspace, viewer, listing, enabled) => call("set_extension_enabled", { workspace, viewer, listing, enabled }),
    setExtensionBudget: (workspace, viewer, listing, monthlyMicros) => call("set_extension_budget", { workspace, viewer, listing, monthly_micros: monthlyMicros }),
    uninstallExtension: (workspace, viewer, listing) => call("uninstall_extension", { workspace, viewer, listing }),
  };
}
