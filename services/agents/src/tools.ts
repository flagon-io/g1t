/**
 * What an agent can read while it replies: code, issues, pull requests,
 * chat, the roster, and its colleagues (docs/WORKSPACE.md, "What an agent
 * can and can't know", "Agents know each other").
 *
 * Every tool goes through the reply's `Audience` before it reads
 * anything, and the check is here, in code:
 * - code tools are offered only when the audience may read code at all,
 *   and a repository is used only when it is on the audience's allow-list;
 * - chat tools ask the chat service, which works out the audience from the
 *   conversation itself;
 * - what the audience may not see comes back as one neutral line,
 *   `WITHHELD`, the same for a thing that is private and a thing that does
 *   not exist, and never names it.
 *
 * Whatever a tool returns is wrapped as untrusted data: text in files,
 * issues and messages is never an instruction to the agent.
 *
 * Pure apart from its ports, so the rules are tested adversarially.
 */
import type { User } from "@g1t/contracts";

import { type Audience, type RepoRef, WITHHELD } from "./audience.ts";

/** One tool, as the Messages API takes it. */
export type ToolDef = { name: string; description: string; input_schema: Record<string, unknown> };

export type FoundMessage = { channel: string | null; channel_id: string; id: string; author: string; body: string; created_at: string };

/** What the tools reach outside this module. */
export interface ToolPorts {
  readFile(repo: RepoRef, viewer: User, ref: string, path: string): Promise<{ text: string | null; size: number } | null>;
  searchCode(viewer: User, query: string, repo: RepoRef | null): Promise<{ repo: string; path: string; snippet: string }[]>;
  listIssues(repo: RepoRef, viewer: User, state: "open" | "closed"): Promise<{ number: number; title: string; state: string; labels: string[] }[] | null>;
  getIssue(repo: RepoRef, number: number, viewer: User): Promise<{ number: number; title: string; state: string; body: string; comments: { author: string; body: string }[] } | null>;
  getPull(repo: RepoRef, number: number, viewer: User): Promise<{ number: number; title: string; status: string; body: string; checks: string | null } | null>;
  recentPulls(repos: RepoRef[], viewer: User): Promise<{ repo: string; number: number; title: string; status: string; updated_at: string }[]>;
  /** Chat's own audience rule applies; null when the search failed. */
  searchMessages(query: string): Promise<FoundMessage[] | null>;
  /** Null when the audience may not read it (or it does not exist). */
  readThread(channelId: string, id: string): Promise<FoundMessage[] | null>;
  roster(viewer: User | null): Promise<string>;
  consult(handle: string, question: string): Promise<{ ok: true; colleague: string; answer: string } | { ok: false; message: string }>;
}

/**
 * What an agent may do, beyond reading: remember, file an issue for the
 * person who asked, and start or shape work. Each is checked here before it
 * runs (the audience, the asker, the hop limit) and again by the service
 * that does it.
 */
export interface ActionPorts {
  remember(body: string, scope: "workspace" | "channel" | "person" | null): Promise<{ ok: boolean; message: string }>;
  forget(id: string): Promise<{ ok: boolean; message: string }>;
  /** Opens an issue as the person who asked; they must be able to read the repository. */
  fileIssue(repo: RepoRef, asker: User, input: { title: string; body: string; labels: string[] }): Promise<{ ok: true; number: number; url: string } | { ok: false; message: string }>;
  /** From chat: spins off a session for real work. */
  startSession?(title: string, goal: string): Promise<{ ok: boolean; message: string }>;
  /** In a session: a short progress note in its thread. */
  postUpdate?(text: string): Promise<{ ok: boolean; message: string }>;
  /** In a session: one of the agent's own subagents takes part of the work. */
  useSubagent?(name: string, brief: string): Promise<{ ok: boolean; message: string }>;
  /** In a session: a colleague works on part of it, paid from this session's budget. */
  bringIn?(handle: string, brief: string): Promise<{ ok: boolean; message: string }>;
}

/** The most tool calls one reply makes. */
export const MAX_TOOL_CALLS = 8;
/** The most tool calls one step of a session makes. */
export const MAX_SESSION_TOOL_CALLS = 24;
/** The most of a file or result an answer is given, in characters. */
const MAX_RESULT = 20_000;

export type ToolCall = {
  tool: string;
  /** Its arguments, with long text cut, as recorded. */
  args: string;
  outcome: "allowed" | "withheld" | "refused" | "error";
  bytes: number;
};

export type ToolResult = { text: string; outcome: ToolCall["outcome"] };

/**
 * Text a tool read, marked as data. Anything in it that looks like the
 * closing mark is defused, so content can't end the block early.
 */
export function untrusted(source: string, content: string): string {
  const safe = (text: string) => text.replace(/<\/?untrusted/gi, (mark) => mark.replace("<", "&lt;"));
  const body = content.length > MAX_RESULT ? `${content.slice(0, MAX_RESULT)}\n[cut: ${content.length - MAX_RESULT} more characters]` : content;
  return `<untrusted source="${safe(source).replace(/"/g, "'")}">\n${safe(body)}\n</untrusted>`;
}

/** Arguments as recorded: every string cut to 120 characters. */
export function redact(args: unknown): string {
  const cut = (value: unknown): unknown => {
    if (typeof value === "string") return value.length > 120 ? `${value.slice(0, 120)}…` : value;
    if (Array.isArray(value)) return value.slice(0, 10).map(cut);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 10).map(([k, v]) => [k, cut(v)]));
    return value;
  };
  return JSON.stringify(cut(args ?? {})).slice(0, 1000);
}

const CODE_TOOLS: ToolDef[] = [
  {
    name: "list_repositories",
    description: "The workspace's repositories everyone in this conversation can read. Start here to know what you can look at.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "search_code",
    description: "Search code on default branches. Optionally only in one repository (`name` or `workspace/name`).",
    input_schema: { type: "object", properties: { query: { type: "string" }, repo: { type: "string" } }, required: ["query"] },
  },
  {
    name: "read_file",
    description: "Read a file from a repository, at its default branch or a ref.",
    input_schema: { type: "object", properties: { repo: { type: "string" }, path: { type: "string" }, ref: { type: "string" } }, required: ["repo", "path"] },
  },
  {
    name: "list_issues",
    description: "A repository's newest issues, open by default.",
    input_schema: { type: "object", properties: { repo: { type: "string" }, state: { type: "string", enum: ["open", "closed"] } }, required: ["repo"] },
  },
  {
    name: "get_issue",
    description: "One issue with its comments.",
    input_schema: { type: "object", properties: { repo: { type: "string" }, number: { type: "integer" } }, required: ["repo", "number"] },
  },
  {
    name: "get_pull",
    description: "One pull request: what it changes, its status and checks.",
    input_schema: { type: "object", properties: { repo: { type: "string" }, number: { type: "integer" } }, required: ["repo", "number"] },
  },
  {
    name: "recent_activity",
    description: "Recently merged and open pull requests, in one repository or across those you can read.",
    input_schema: { type: "object", properties: { repo: { type: "string" } } },
  },
];

const CHAT_TOOLS: ToolDef[] = [
  {
    name: "search_messages",
    description: "Search chat messages this conversation's people can all read.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "read_thread",
    description: "Read a chat thread by its channel id and a message id in it (from search_messages).",
    input_schema: { type: "object", properties: { channel: { type: "string" }, id: { type: "string" } }, required: ["channel", "id"] },
  },
  {
    name: "workspace_roster",
    description: "The workspace's people and agents: names, teams, titles and roles.",
    input_schema: { type: "object", properties: {} },
  },
];

const ASK_COLLEAGUE: ToolDef = {
  name: "ask_colleague",
  description:
    "Ask another agent of the workspace a question and get their answer here, without handing the work over. Use it when their role knows something yours doesn't.",
  input_schema: { type: "object", properties: { handle: { type: "string" }, question: { type: "string" } }, required: ["handle", "question"] },
};

const REMEMBER: ToolDef = {
  name: "remember",
  description:
    "Keep a short fact for later work: a preference, a decision, who owns what, how something works here. One fact per call, in your own words. It is kept where this conversation allows (this person, this conversation, or the workspace from a public channel), with this conversation as its source. Never keep secrets, credentials or customers' personal data.",
  input_schema: {
    type: "object",
    properties: { fact: { type: "string" }, scope: { type: "string", enum: ["workspace", "channel", "person"] } },
    required: ["fact"],
  },
};

const FORGET: ToolDef = {
  name: "forget",
  description: "Forget one of the notes under 'What you remember', by its id, when it is wrong or out of date.",
  input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
};

const FILE_ISSUE: ToolDef = {
  name: "file_issue",
  description:
    "File an issue (a bug report or a feature request) in a repository, as the person who asked, with what you found. Only after you showed them a draft and they said yes. Write it for the team that will fix it: what happens, what should happen, steps or evidence, and where in the code it likely is.",
  input_schema: {
    type: "object",
    properties: {
      repo: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
      labels: { type: "array", items: { type: "string" } },
    },
    required: ["repo", "title", "body"],
  },
};

const START_SESSION: ToolDef = {
  name: "start_session",
  description:
    "Spin off a session for work that needs more than a quick answer: investigating, reading a lot of code, writing something long, or anything that takes several steps. It runs on its own with its own context, shows a live card here, and reports back in this conversation when done. Give it a short title and a complete brief: the goal, what done looks like, and everything it needs from this conversation.",
  input_schema: { type: "object", properties: { title: { type: "string" }, goal: { type: "string" } }, required: ["title", "goal"] },
};

const POST_UPDATE: ToolDef = {
  name: "post_update",
  description: "Post a short progress note in your session's thread, for the people following it. Use it for real milestones or a question, not for every step.",
  input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
};

const USE_SUBAGENT: ToolDef = {
  name: "use_subagent",
  description:
    "Hand a well-defined part of this session to one of your subagents (listed under Subagents). It works in its own session, paid from this one, and its result comes back to you before you go on. Give a complete brief.",
  input_schema: { type: "object", properties: { name: { type: "string" }, brief: { type: "string" } }, required: ["name", "brief"] },
};

const BRING_IN: ToolDef = {
  name: "bring_in",
  description:
    "Bring a colleague in on part of this session when their role owns it. They work in their own session, paid from this one, and their result comes back to you before you go on. Give a complete brief.",
  input_schema: { type: "object", properties: { handle: { type: "string" }, brief: { type: "string" } }, required: ["handle", "brief"] },
};

const CODE_NAMES = new Set(CODE_TOOLS.map((tool) => tool.name));

export type ToolContext = {
  /** The agent replying. */
  agentId: string;
  /** Handles nobody may consult from here: the agent itself, and whoever sent it the work. */
  notConsult: string[];
  /** Hops so far: a consult is one more, and none is offered at the limit. */
  hops: number;
  maxHops: number;
  /** Whether this is a session's step (more calls, session tools) or a reply. */
  session?: boolean;
  /** Told of every call as it is made, for a session's transcript. */
  onCall?: (call: ToolCall) => void;
};

export class ToolBox {
  /** Every call this reply made, shared with the tool boxes of colleagues it consults: one budget for the reply. */
  readonly calls: ToolCall[];
  private readonly audience: Audience;
  private readonly ports: ToolPorts;
  private readonly context: ToolContext;

  private readonly actions: ActionPorts | null;
  /** Updates posted in this step. */
  private updates = 0;

  constructor(audience: Audience, ports: ToolPorts, context: ToolContext, calls: ToolCall[] = [], actions: ActionPorts | null = null) {
    this.audience = audience;
    this.ports = ports;
    this.context = context;
    this.calls = calls;
    this.actions = actions;
  }

  /** A colleague's tool box for a consult: the same audience, the same budget, one hop further, reading only. */
  forColleague(ports: ToolPorts, context: ToolContext): ToolBox {
    return new ToolBox(this.audience, ports, context, this.calls);
  }

  /** The most calls this box makes. */
  get maxCalls(): number {
    return this.context.session ? MAX_SESSION_TOOL_CALLS : MAX_TOOL_CALLS;
  }

  /** Whether the person who asked can be acted for: resolved, and able to read code here. */
  private canFile(): boolean {
    return !!this.actions && !!this.audience.asker && this.audience.codeAllowed();
  }

  /**
   * The tools offered: no code tools for an audience that can't read code,
   * no consults or hand-offs at the hop limit, session tools only in a
   * session, and a spin-off only from chat.
   */
  definitions(): ToolDef[] {
    const roomForHop = this.context.hops + 1 <= this.context.maxHops;
    const actions = this.actions;
    return [
      ...(this.audience.codeAllowed() ? CODE_TOOLS : []),
      ...CHAT_TOOLS,
      ...(roomForHop ? [ASK_COLLEAGUE] : []),
      ...(actions ? [REMEMBER, FORGET] : []),
      ...(this.canFile() ? [FILE_ISSUE] : []),
      ...(actions?.startSession && !this.context.session ? [START_SESSION] : []),
      ...(actions?.postUpdate && this.context.session ? [POST_UPDATE] : []),
      ...(actions?.useSubagent && this.context.session && roomForHop ? [USE_SUBAGENT] : []),
      ...(actions?.bringIn && this.context.session && roomForHop ? [BRING_IN] : []),
    ];
  }

  /** Whether another call may be made. */
  get spent(): boolean {
    return this.calls.length >= this.maxCalls;
  }

  async run(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    const result = await this.attempt(name, input);
    const call: ToolCall = { tool: name, args: redact(input), outcome: result.outcome, bytes: result.text.length };
    this.calls.push(call);
    this.context.onCall?.(call);
    return result;
  }

  private async attempt(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    let result: ToolResult;
    const what = this.context.session ? "step" : "reply";
    if (this.spent) result = { text: `No more tool calls in this ${what} (at most ${this.maxCalls}). Answer with what you have.`, outcome: "refused" };
    else {
      try {
        result = await this.dispatch(name, input ?? {});
      } catch (error) {
        console.error("agents: a tool failed", name, String(error));
        result = { text: "That didn't work just now. Answer with what you have.", outcome: "error" };
      }
    }
    return result;
  }

  private withheld(): ToolResult {
    return { text: WITHHELD, outcome: "withheld" };
  }

  private async dispatch(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    const asker = this.audience.asker;
    if (CODE_NAMES.has(name)) {
      // Not offered, and refused if asked for anyway: the check is here, not in the prompt.
      if (!this.audience.codeAllowed() || !asker) return this.withheld();
      return this.code(name, input, asker);
    }
    switch (name) {
      case "search_messages": {
        const query = String(input.query ?? "").trim();
        if (query.length < 2) return { text: "Search for at least two characters.", outcome: "refused" };
        const found = await this.ports.searchMessages(query);
        if (found === null) return { text: "Search didn't work just now.", outcome: "error" };
        if (!found.length) return { text: "No messages found.", outcome: "allowed" };
        return { text: untrusted(`search_messages "${query}"`, found.map(messageLine).join("\n")), outcome: "allowed" };
      }
      case "read_thread": {
        const thread = await this.ports.readThread(String(input.channel ?? ""), String(input.id ?? ""));
        if (!thread || !thread.length) return this.withheld();
        return { text: untrusted("read_thread", thread.map(messageLine).join("\n")), outcome: "allowed" };
      }
      case "workspace_roster":
        return { text: untrusted("workspace_roster", await this.ports.roster(asker)), outcome: "allowed" };
      case "ask_colleague": {
        const handle = String(input.handle ?? "").trim().replace(/^@/, "").toLowerCase();
        const question = String(input.question ?? "").trim();
        if (!handle || !question) return { text: "Name the colleague and the question.", outcome: "refused" };
        if (this.context.hops + 1 > this.context.maxHops) return { text: "This request has been passed along too many times; answer with what you have.", outcome: "refused" };
        if (this.context.notConsult.includes(handle)) {
          return { text: `You can't consult @${handle} here: they sent you this work, or it is you. Answer with what you have.`, outcome: "refused" };
        }
        const answer = await this.ports.consult(handle, question.slice(0, 2000));
        if (!answer.ok) return { text: answer.message, outcome: "refused" };
        return { text: untrusted(`@${answer.colleague}'s answer`, answer.answer), outcome: "allowed" };
      }
      default:
        return this.act(name, input);
    }
  }

  /** Doing, not reading: memory, issues, sessions. Each refused unless offered. */
  private async act(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    const actions = this.actions;
    const offered = this.definitions().some((tool) => tool.name === name);
    if (!actions || !offered) return { text: `There is no tool called ${name} here.`, outcome: "refused" };
    const said = (answer: { ok: boolean; message: string }): ToolResult => ({ text: answer.message, outcome: answer.ok ? "allowed" : "refused" });
    const text = (key: string, max: number) => String(input[key] ?? "").trim().slice(0, max);
    switch (name) {
      case "remember": {
        const fact = text("fact", 2000);
        if (!fact) return { text: "Say what to remember.", outcome: "refused" };
        const scope = input.scope === "workspace" || input.scope === "channel" || input.scope === "person" ? input.scope : null;
        return said(await actions.remember(fact, scope));
      }
      case "forget":
        return said(await actions.forget(text("id", 100)));
      case "file_issue": {
        const asker = this.audience.asker;
        if (!asker || !this.audience.codeAllowed()) return this.withheld();
        const repo = await this.audience.repo(input.repo);
        if (!repo) return this.withheld();
        const title = text("title", 200);
        const body = text("body", 20_000);
        if (!title || !body) return { text: "An issue needs a title and a body.", outcome: "refused" };
        const labels = Array.isArray(input.labels)
          ? input.labels.filter((l): l is string => typeof l === "string").map((l) => l.trim()).filter(Boolean).slice(0, 5)
          : [];
        const filed = await actions.fileIssue(repo, asker, { title, body, labels });
        if (!filed.ok) return { text: filed.message, outcome: "refused" };
        return { text: `Filed ${repo.namespace}/${repo.name}#${filed.number}: ${filed.url}`, outcome: "allowed" };
      }
      case "start_session": {
        const title = text("title", 120);
        const goal = text("goal", 8000);
        if (!title || !goal) return { text: "A session needs a title and a goal.", outcome: "refused" };
        return said(await actions.startSession!(title, goal));
      }
      case "post_update": {
        const note = text("text", 2000);
        if (!note) return { text: "Say what to post.", outcome: "refused" };
        if (this.updates >= 3) return { text: "You've posted enough updates for this step; carry on with the work.", outcome: "refused" };
        this.updates++;
        return said(await actions.postUpdate!(note));
      }
      case "use_subagent": {
        const helper = text("name", 60).toLowerCase();
        const brief = text("brief", 8000);
        if (!helper || !brief) return { text: "Name the subagent and give it a brief.", outcome: "refused" };
        return said(await actions.useSubagent!(helper, brief));
      }
      case "bring_in": {
        const handle = text("handle", 60).replace(/^@/, "").toLowerCase();
        const brief = text("brief", 8000);
        if (!handle || !brief) return { text: "Name the colleague and give them a brief.", outcome: "refused" };
        if (this.context.notConsult.includes(handle)) return { text: `You can't bring in @${handle} here: they sent you this work, or it is you.`, outcome: "refused" };
        return said(await actions.bringIn!(handle, brief));
      }
      default:
        return { text: `There is no tool called ${name}.`, outcome: "refused" };
    }
  }

  private async code(name: string, input: Record<string, unknown>, viewer: User): Promise<ToolResult> {
    if (name === "list_repositories") {
      const repos = [...(await this.audience.repos()).values()];
      if (!repos.length) return { text: "There are no repositories everyone here can read.", outcome: "allowed" };
      return { text: untrusted("list_repositories", repos.map((repo) => `${repo.namespace}/${repo.name}${repo.isPrivate ? " (private)" : ""}`).join("\n")), outcome: "allowed" };
    }
    if (name === "search_code") {
      const query = String(input.query ?? "").trim();
      if (query.length < 2) return { text: "Search for at least two characters.", outcome: "refused" };
      const only = input.repo === undefined || input.repo === null || input.repo === "" ? null : await this.audience.repo(input.repo);
      if (input.repo && !only) return this.withheld();
      const allowed = await this.audience.repos();
      // Whatever search returns, only hits in allowed repositories come through.
      const hits = (await this.ports.searchCode(viewer, query, only)).filter((hit) => allowed.has(hit.repo.toLowerCase()) && (!only || hit.repo.toLowerCase() === `${only.namespace}/${only.name}`.toLowerCase()));
      if (!hits.length) return { text: "No code found.", outcome: "allowed" };
      return { text: untrusted(`search_code "${query}"`, hits.slice(0, 10).map((hit) => `${hit.repo}:${hit.path}\n${hit.snippet}`).join("\n\n")), outcome: "allowed" };
    }
    if (name === "recent_activity") {
      const one = input.repo ? await this.audience.repo(input.repo) : null;
      if (input.repo && !one) return this.withheld();
      const repos = one ? [one] : [...(await this.audience.repos()).values()].slice(0, 20);
      if (!repos.length) return { text: "There are no repositories everyone here can read.", outcome: "allowed" };
      const pulls = await this.ports.recentPulls(repos, viewer);
      if (!pulls.length) return { text: "No recent pull requests.", outcome: "allowed" };
      return { text: untrusted("recent_activity", pulls.map((p) => `${p.repo}#${p.number} ${p.status}: ${p.title} (${p.updated_at})`).join("\n")), outcome: "allowed" };
    }
    // The rest name one repository; it must be on the allow-list.
    const repo = await this.audience.repo(input.repo);
    if (!repo) return this.withheld();
    const full = `${repo.namespace}/${repo.name}`;
    switch (name) {
      case "read_file": {
        const path = String(input.path ?? "").trim().replace(/^\/+/, "");
        if (!path || path.split("/").some((part) => part === "..")) return { text: "Give a path inside the repository.", outcome: "refused" };
        const ref = typeof input.ref === "string" && input.ref.trim() ? input.ref.trim() : repo.defaultBranch;
        const file = await this.ports.readFile(repo, viewer, ref, path);
        if (!file) return { text: `No file ${path} at ${ref} in ${full}.`, outcome: "allowed" };
        if (file.text === null) return { text: `${full}:${path} is binary or too large to read (${file.size} bytes).`, outcome: "allowed" };
        return { text: untrusted(`${full}:${path}@${ref}`, file.text), outcome: "allowed" };
      }
      case "list_issues": {
        const state = input.state === "closed" ? "closed" : "open";
        const issues = await this.ports.listIssues(repo, viewer, state);
        if (!issues) return this.withheld();
        if (!issues.length) return { text: `No ${state} issues in ${full}.`, outcome: "allowed" };
        return { text: untrusted(`list_issues ${full}`, issues.slice(0, 30).map((i) => `#${i.number} [${i.state}] ${i.title}${i.labels.length ? ` (${i.labels.join(", ")})` : ""}`).join("\n")), outcome: "allowed" };
      }
      case "get_issue": {
        const issue = await this.ports.getIssue(repo, Math.floor(Number(input.number)), viewer);
        if (!issue) return { text: `No such issue in ${full}.`, outcome: "allowed" };
        const comments = issue.comments.map((c) => `@${c.author}: ${c.body}`).join("\n\n");
        return { text: untrusted(`${full}#${issue.number}`, `#${issue.number} [${issue.state}] ${issue.title}\n\n${issue.body}${comments ? `\n\nComments:\n\n${comments}` : ""}`), outcome: "allowed" };
      }
      case "get_pull": {
        const pull = await this.ports.getPull(repo, Math.floor(Number(input.number)), viewer);
        if (!pull) return { text: `No such pull request in ${full}.`, outcome: "allowed" };
        return { text: untrusted(`${full}#${pull.number}`, `#${pull.number} [${pull.status}] ${pull.title}\n\n${pull.body}${pull.checks ? `\n\nChecks: ${pull.checks}` : ""}`), outcome: "allowed" };
      }
      default:
        return { text: `There is no tool called ${name}.`, outcome: "refused" };
    }
  }
}

function messageLine(m: FoundMessage): string {
  const where = m.channel ? `#${m.channel}` : "a direct message";
  return `[${m.created_at.slice(0, 16)} in ${where}, channel ${m.channel_id}, message ${m.id}] @${m.author}: ${m.body}`;
}
