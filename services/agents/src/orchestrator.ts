/**
 * `@g1t`, every workspace's built-in orchestrator (docs/WORKSPACE.md, "g1t,
 * the orchestrator"). Pure, so it is tested on its own.
 *
 * It is an agent row like any other, marked builtin, so it is billed,
 * gated, routed and audited the same way. What sets it apart is here:
 * the fields nobody may change, the job it always has, the roster of
 * specialists it is given, and the rails on how it delegates.
 */
import type { AgentStatus, ModelTier, NewWorkspaceAgent } from "@g1t/contracts";

import { BUILTIN_AGENT_HANDLE, ORCHESTRATOR_TEMPLATE } from "../../../packages/contracts/src/workspace-agents.ts";
import { type Checked, type Definition, DEFAULT_AUTONOMY, DEFAULT_BUDGET, DEFAULT_CAPACITY, DEFAULT_ROUTING } from "./definition.ts";

export const BUILTIN_ROLE = "Your orchestrator: delegates to the team's agents, or does the work itself";

/** What a new workspace's @g1t starts as. `instructions` are the workspace's additions, none at first. */
export function builtinDefinition(): Definition {
  return {
    handle: BUILTIN_AGENT_HANDLE,
    display_name: "g1t",
    role: BUILTIN_ROLE,
    instructions: "",
    personality_preset: "friendly",
    personality: "",
    routing: DEFAULT_ROUTING,
    budget: DEFAULT_BUDGET,
    autonomy: DEFAULT_AUTONOMY,
    capacity: DEFAULT_CAPACITY,
    template: ORCHESTRATOR_TEMPLATE,
    avatar_seed: BUILTIN_AGENT_HANDLE,
    title: "Orchestrator",
    team: null,
    department: "",
    responsibilities: [],
    subagents: [],
    faces: "internal",
    reading: [],
  };
}

/** What nobody may change on the built-in agent: who it is and what its job is. */
export const PROTECTED: (keyof NewWorkspaceAgent)[] = [
  "handle",
  "display_name",
  "role",
  "title",
  "team",
  "department",
  "responsibilities",
  "subagents",
  "template",
  "faces",
];

/**
 * `changes` to the built-in agent with its fixed fields taken out, whatever
 * they say: a profile form sends every field (an empty title, no
 * responsibilities), and only the editable ones apply.
 */
export function builtinChanges(_current: Definition, changes: Partial<NewWorkspaceAgent>): Checked<Partial<NewWorkspaceAgent>> {
  if (!changes || typeof changes !== "object") return { ok: false, message: "Send the agent's fields." };
  const rest: Partial<NewWorkspaceAgent> = { ...changes };
  for (const key of PROTECTED) delete rest[key];
  return { ok: true, value: rest };
}

/** One specialist as @g1t sees it. */
export type Specialist = {
  handle: string;
  display_name: string;
  role: string;
  title?: string;
  team?: string | null;
  department?: string;
  responsibilities?: string[];
  status: AgentStatus;
  spent_month_micros: number;
  /** The monthly cap, or null for none. */
  monthly_micros: number | null;
};

const STATUS_WORDS: Record<AgentStatus, string> = {
  idle: "idle",
  working: "working",
  waiting: "waiting on someone",
  out_of_budget: "out of budget",
  paused: "paused",
};

const dollars = (micros: number) => `$${(Math.max(0, micros) / 1_000_000).toFixed(2)}`;

/** Where a specialist sits: "QA Engineer on the qa team", "QA Engineer, QA", or its role. */
function placeLine(agent: Specialist): string {
  const title = agent.title?.trim();
  if (!title) return agent.role.replace(/\.$/, "");
  if (agent.team) return `${title} on the ${agent.team} team`;
  return agent.department?.trim() ? `${title}, ${agent.department.trim()}` : title;
}

/**
 * The roster, one line per specialist, so g1t can route "QA should look"
 * to the right one: `- @margo (Margo): QA Engineer, QA. Does: review pull
 * requests; write test plans. idle; $1.20 of $20.00 this month.`
 */
export function rosterLines(specialists: Specialist[]): string {
  if (!specialists.length) return "There are no specialists in this workspace yet.";
  return specialists
    .map((agent) => {
      const name = agent.display_name && agent.display_name.toLowerCase() !== agent.handle ? ` (${agent.display_name})` : "";
      const spend = agent.monthly_micros ? `${dollars(agent.spent_month_micros)} of ${dollars(agent.monthly_micros)}` : `${dollars(agent.spent_month_micros)}, no cap`;
      const duties = agent.responsibilities?.length ? ` Does: ${agent.responsibilities.map((d) => d.replace(/\.$/, "")).join("; ")}.` : "";
      return `- @${agent.handle}${name}: ${placeLine(agent)}.${duties} ${STATUS_WORDS[agent.status] ?? agent.status}; ${spend} this month.`;
    })
    .join("\n");
}

/** The most specialists one of @g1t's messages may hand work to. */
export const MAX_DELEGATES = 2;

/** @g1t's job: fixed, whatever the workspace adds. */
export function orchestratorInstructions(specialists: Specialist[], extra: string): string {
  const available = specialists.filter((agent) => agent.status !== "out_of_budget" && agent.status !== "paused");
  const job = [
    "You are the workspace's orchestrator. People come to you when they don't know who should do something. You either answer, hand the work to the right specialist, or do it yourself.",
    "",
    "### The team",
    "",
    rosterLines(specialists),
    "",
    "### How you decide",
    "",
    "1. **Answer directly** when it is a question, a summary or a quick judgment you can give from this conversation.",
    "2. **Delegate** when a specialist's role fits the work. @mention them in this thread with a crisp brief: what is wanted, why, what done looks like, and any constraint (who asked, deadlines, what not to touch). One short message; no preamble.",
    "3. **Do it yourself, or suggest a specialist,** when nobody fits. Say so plainly, offer to take it on yourself, and if this kind of work will recur, suggest setting one up (for example: \"Want me to set up a release manager for this?\").",
    "",
    "### Rules for delegating",
    "",
    `- Mention at most ${MAX_DELEGATES} specialists in one message. Split bigger work into steps and hand off the next step when the first is done.`,
    "- Never delegate in a loop: don't hand work back to a specialist who handed it to you, don't hand the same work to the same specialist twice in a thread, and never mention yourself.",
    "- Don't delegate to a specialist who is out of budget or paused; say they are unavailable and why.",
    "- Delegating is only an @mention in the thread: the person can see every hand-off, and the asker's access still limits what any agent does for them.",
    "- When a specialist answers in a thread you delegated into, you only speak again if someone mentions you.",
    "- When asked what everyone is working on, answer from the team list above.",
    available.length ? "" : "\nNo specialist is available right now, so do the work yourself or suggest creating one.",
  ].join("\n");
  const added = extra.trim();
  return added ? `${job}\n\n### Added by this workspace\n\n${added}` : job;
}

/** How long a thread is before @g1t's delegation call is worth a larger model. */
export const LONG_THREAD = 6;

/**
 * Where @g1t's reply starts: the small tier, or the large one for a
 * delegation decision in a long thread (more than `LONG_THREAD` messages,
 * with specialists to choose from). Its floor and ceiling apply after.
 */
export function orchestratorTier(messages: number, specialists: number): ModelTier {
  return messages > LONG_THREAD && specialists > 0 ? "large" : "small";
}

/**
 * The rail behind "at most two specialists per message": past the first
 * `max` specialists a reply @mentions, the `@` is dropped, so the chat
 * service wakes nobody else. Names stay readable.
 */
export function capMentions(text: string, specialists: string[], max = MAX_DELEGATES): string {
  const known = new Set(specialists.map((handle) => handle.toLowerCase()));
  const kept = new Set<string>();
  return text.replace(/(^|[^a-z0-9_.@-])@([a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9_])?)/gi, (whole, before: string, handle: string) => {
    const key = handle.toLowerCase();
    if (!known.has(key)) return whole;
    if (kept.has(key) || kept.size < max) {
      kept.add(key);
      return whole;
    }
    return `${before}${handle}`;
  });
}

/** The friendly notice when @g1t has no model to run on. */
export const BUILTIN_NO_MODEL =
  "Hi, I'm g1t. I'd love to help, but this workspace doesn't have a model I can use yet. An owner can add AI credit under Billing, or connect the workspace's own model provider under Integrations, and I'll be ready.";
