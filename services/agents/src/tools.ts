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
import type { DocAudience, DocEditTarget, DocPassage, User } from "@g1t/contracts";

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
  /**
   * The workspace's Docs, as the docs service lets this agent use them for
   * the person it acts for and everyone who will read the answer. Absent
   * where there is no docs service.
   */
  docs?: DocsPorts;
}

/** Docs, as an agent uses them. Every call names the person it acts for and who reads the answer; the docs service checks both. */
export interface DocsPorts {
  spaces(viewer: User, audience: DocAudience): Promise<string | null>;
  /** Passages closest in meaning to `query`; `spaces` (required reading) first. Null when Docs couldn't answer. */
  recall(viewer: User, audience: DocAudience, query: string, spaces: string[]): Promise<DocPassage[] | null>;
  search(viewer: User, audience: DocAudience, query: string, project: string | null): Promise<string | null>;
  read(viewer: User, audience: DocAudience, pageId: string): Promise<string | null>;
  /** Pages possibly out of date since code they cite changed, with the change. */
  stale(viewer: User, audience: DocAudience, repo: string | null): Promise<string | null>;
  edit(viewer: User, pageId: string, edit: { target: DocEditTarget; markdown: string; note: string | null; marks_current: boolean }, suggestOnly: boolean): Promise<{ ok: boolean; message: string }>;
  create(viewer: User, input: { space_id: string | null; parent_id: string | null; title: string; markdown: string; source: { title: string; href: string } | null }): Promise<{ ok: boolean; message: string }>;
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
  /**
   * Posts a draft issue as a card in the conversation, with File issue and
   * Discard: whoever presses File files it as themselves, if they can read
   * the repository. Nothing is filed by the agent.
   */
  draftIssue(repo: RepoRef, input: { title: string; body: string; labels: string[] }): Promise<{ ok: boolean; message: string }>;
  /**
   * Comments on an issue or pull request, or reviews a pull request, as the
   * agent on behalf of the person who asked. Reviews are advisory: they
   * never count toward required approvals.
   */
  comment?(repo: RepoRef, asker: User, number: number, body: string): Promise<{ ok: boolean; message: string }>;
  review?(repo: RepoRef, asker: User, number: number, verdict: "comment" | "approve" | "request_changes", body: string): Promise<{ ok: boolean; message: string }>;
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

const DRAFT_ISSUE: ToolDef = {
  name: "draft_issue",
  description:
    "Draft an issue (a bug report or a feature request) for a repository with what you found. It appears in the conversation as a card with File issue and Discard buttons: the person files it themselves with one press, so don't ask them to confirm in words. Write it for the team that will fix it: what happens, what should happen, steps or evidence, and where in the code it likely is.",
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

const COMMENT: ToolDef = {
  name: "comment",
  description:
    "Comment on an issue or pull request, as yourself on behalf of the person you're working for. Use it when the comment belongs on the issue or pull request (findings, a test plan, a question for its author), not for chatting.",
  input_schema: {
    type: "object",
    properties: { repo: { type: "string" }, number: { type: "integer" }, body: { type: "string" } },
    required: ["repo", "number", "body"],
  },
};

const REVIEW_PULL: ToolDef = {
  name: "review_pull",
  description:
    "Review a pull request on the pull request itself, as yourself on behalf of the person you're working for: approve, request changes, or just comment, with your review in the body. Your review is advisory: people still give the approvals a merge needs. Read the change first.",
  input_schema: {
    type: "object",
    properties: {
      repo: { type: "string" },
      number: { type: "integer" },
      verdict: { type: "string", enum: ["comment", "approve", "request_changes"] },
      body: { type: "string" },
    },
    required: ["repo", "number", "verdict", "body"],
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

const DOCS_TOOLS: ToolDef[] = [
  {
    name: "search_docs",
    description:
      "Search the workspace's Docs (specs, runbooks, policies, onboarding, decisions) that everyone in this conversation can read. Optionally only pages about one project (`workspace/name`). Look here first for how things work and what was decided.",
    input_schema: { type: "object", properties: { query: { type: "string" }, project: { type: "string" } }, required: ["query"] },
  },
  {
    name: "read_page",
    description: "Read a Docs page as Markdown, with the ids of its top-level blocks (for editing), by its id from search_docs or a link.",
    input_schema: { type: "object", properties: { page: { type: "string" } }, required: ["page"] },
  },
  {
    name: "stale_pages",
    description:
      "Docs pages possibly out of date because code they cite changed, each with the change (pull request or commit) and the paths. Optionally only for one repository (`workspace/name`). Start here when keeping the docs current.",
    input_schema: { type: "object", properties: { repo: { type: "string" } } },
  },
  {
    name: "list_doc_spaces",
    description: "The Docs spaces you can read here, with what you may do in each (read, suggest, edit).",
    input_schema: { type: "object", properties: {} },
  },
];

const DOCS_WRITE_TOOLS: ToolDef[] = [
  {
    name: "edit_page",
    description:
      "Change a Docs page: replace a section (by its heading), a range of top-level blocks (ids from read_page), the whole page, or add to the end. Where the space lets agents edit, it applies at once and shows in the page's history as yours; elsewhere it becomes a suggestion people accept or reject inline. Read the page first. Write Markdown.",
    input_schema: {
      type: "object",
      properties: {
        page: { type: "string" },
        target: { type: "string", enum: ["append", "section", "blocks", "document"] },
        heading: { type: "string", description: "For target section: the heading's text." },
        from_block: { type: "string" },
        to_block: { type: "string" },
        markdown: { type: "string" },
        note: { type: "string", description: "Why, in a line, for the history or the suggestion." },
        marks_current: { type: "boolean", description: "This edit brings a page marked possibly out of date up to date: it clears the mark when it applies or is accepted." },
        suggest_only: { type: "boolean", description: "Suggest even where you could edit." },
      },
      required: ["page", "target", "markdown"],
    },
  },
  {
    name: "create_page",
    description:
      "Write a new Docs page (\"write this up\"): a title and Markdown, in a space (its id from list_doc_spaces; the General space when left out), optionally under a parent page. Link where it came from when it came from a conversation.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        markdown: { type: "string" },
        space: { type: "string" },
        parent: { type: "string" },
        source_title: { type: "string" },
        source_href: { type: "string" },
      },
      required: ["title", "markdown"],
    },
  },
];

const DOCS_NAMES = new Set([...DOCS_TOOLS, ...DOCS_WRITE_TOOLS].map((tool) => tool.name));

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
      // Docs are for everyone, Code or not: the docs service decides what this person and audience can read.
      ...(this.ports.docs && this.audience.asker ? DOCS_TOOLS : []),
      ...(this.ports.docs && this.audience.asker && actions ? DOCS_WRITE_TOOLS : []),
      ...(roomForHop ? [ASK_COLLEAGUE] : []),
      ...(actions ? [REMEMBER, FORGET] : []),
      ...(this.canFile() ? [DRAFT_ISSUE] : []),
      ...(this.canFile() && actions?.comment ? [COMMENT] : []),
      ...(this.canFile() && actions?.review ? [REVIEW_PULL] : []),
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
    if (DOCS_NAMES.has(name)) {
      if (!this.definitions().some((tool) => tool.name === name) || !asker || !this.ports.docs) return { text: `There is no tool called ${name} here.`, outcome: "refused" };
      return this.docs(name, input, asker, this.ports.docs);
    }
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

  /**
   * What Docs say about `query`, for this person and this audience, before
   * the agent answers: no tool call, nothing counted against its tools.
   * Empty when there is no docs service or nothing relevant.
   */
  async recall(query: string | null, spaces: string[]): Promise<DocPassage[]> {
    const docs = this.ports.docs;
    const asker = this.audience.asker;
    if (!docs || !asker || !query) return [];
    try {
      return (await docs.recall(asker, this.docAudience(), query, spaces)) ?? [];
    } catch (error) {
      console.error("agents: docs recall failed", String(error));
      return [];
    }
  }

  /** Who reads what an agent says here, as the docs service takes it. */
  private docAudience(): DocAudience {
    return this.audience.shared ? { kind: "workspace" } : { kind: "people", user_ids: this.audience.members.map((m) => m.id) };
  }

  private async docs(name: string, input: Record<string, unknown>, asker: User, docs: DocsPorts): Promise<ToolResult> {
    const text = (key: string, max: number) => String(input[key] ?? "").trim().slice(0, max);
    const audience = this.docAudience();
    const read = (source: string, found: string | null): ToolResult => (found === null ? this.withheld() : { text: untrusted(source, found), outcome: "allowed" });
    switch (name) {
      case "list_doc_spaces":
        return read("list_doc_spaces", await docs.spaces(asker, audience));
      case "search_docs": {
        const query = text("query", 200);
        if (query.length < 2) return { text: "Search for at least two characters.", outcome: "refused" };
        const project = text("project", 200).toLowerCase() || null;
        return read(`search_docs "${query}"`, await docs.search(asker, audience, query, project));
      }
      case "stale_pages":
        return read("stale_pages", await docs.stale(asker, audience, text("repo", 200).toLowerCase() || null));
      case "read_page": {
        const page = pageId(text("page", 300));
        if (!page) return { text: "Give the page's id or link.", outcome: "refused" };
        return read(`read_page ${page}`, await docs.read(asker, audience, page));
      }
      case "edit_page": {
        const page = pageId(text("page", 300));
        const markdown = String(input.markdown ?? "").slice(0, 100_000);
        if (!page || !markdown.trim()) return { text: "Give the page and the Markdown.", outcome: "refused" };
        const kind = text("target", 20);
        const target: DocEditTarget | null =
          kind === "append"
            ? { kind: "append" }
            : kind === "document"
              ? { kind: "document" }
              : kind === "section" && text("heading", 300)
                ? { kind: "section", heading: text("heading", 300) }
                : kind === "blocks" && text("from_block", 100) && text("to_block", 100)
                  ? { kind: "blocks", from_block: text("from_block", 100), to_block: text("to_block", 100) }
                  : null;
        if (!target) return { text: "Say what to change: append, a section by its heading, blocks by their ids, or the whole document.", outcome: "refused" };
        const done = await docs.edit(asker, page, { target, markdown, note: text("note", 300) || null, marks_current: input.marks_current === true }, input.suggest_only === true);
        return { text: done.message, outcome: done.ok ? "allowed" : "refused" };
      }
      case "create_page": {
        const title = text("title", 200);
        const markdown = String(input.markdown ?? "").slice(0, 100_000);
        if (!title || !markdown.trim()) return { text: "A page needs a title and its Markdown.", outcome: "refused" };
        const href = text("source_href", 2000);
        const done = await docs.create(asker, {
          space_id: text("space", 100) || null,
          parent_id: pageId(text("parent", 300)),
          title,
          markdown,
          source: href.startsWith("/") ? { title: text("source_title", 200) || "Where this came from", href } : null,
        });
        return { text: done.message, outcome: done.ok ? "allowed" : "refused" };
      }
      default:
        return { text: `There is no tool called ${name}.`, outcome: "refused" };
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
      case "draft_issue": {
        if (!this.audience.asker || !this.audience.codeAllowed()) return this.withheld();
        const repo = await this.audience.repo(input.repo);
        if (!repo) return this.withheld();
        const title = text("title", 200);
        const body = text("body", 20_000);
        if (!title || !body) return { text: "An issue needs a title and a body.", outcome: "refused" };
        const labels = Array.isArray(input.labels)
          ? input.labels.filter((l): l is string => typeof l === "string").map((l) => l.trim()).filter(Boolean).slice(0, 5)
          : [];
        return said(await actions.draftIssue(repo, { title, body, labels }));
      }
      case "comment":
      case "review_pull": {
        const asker = this.audience.asker;
        if (!asker || !this.audience.codeAllowed()) return this.withheld();
        const repo = await this.audience.repo(input.repo);
        if (!repo) return this.withheld();
        const number = Math.floor(Number(input.number));
        if (!Number.isFinite(number) || number < 1) return { text: "Give the issue or pull request's number.", outcome: "refused" };
        const body = text("body", 20_000);
        if (name === "comment") {
          if (!body) return { text: "Say what to comment.", outcome: "refused" };
          return said(await actions.comment!(repo, asker, number, body));
        }
        const verdict = input.verdict === "approve" || input.verdict === "request_changes" ? input.verdict : "comment";
        if (!body && verdict !== "approve") return { text: "A review needs its text.", outcome: "refused" };
        return said(await actions.review!(repo, asker, number, verdict, body));
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

/** A page id from an id or a Docs link (`/acme/-/docs/general/runbook-pg_123`); null when there is none. */
export function pageId(given: string): string | null {
  const text = given.trim();
  if (!text) return null;
  const last = text.split(/[?#]/)[0].split("/").filter(Boolean).at(-1) ?? text;
  const match = last.match(/(?:^|-)([a-z]{2,4}_[A-Za-z0-9]+)$/);
  return match ? match[1] : /^[A-Za-z0-9_-]{3,80}$/.test(last) ? last : null;
}

function messageLine(m: FoundMessage): string {
  const where = m.channel ? `#${m.channel}` : "a direct message";
  return `[${m.created_at.slice(0, 16)} in ${where}, channel ${m.channel_id}, message ${m.id}] @${m.author}: ${m.body}`;
}
