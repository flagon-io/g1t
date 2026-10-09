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
import type { DocEditTarget, FolioAgentEdit, FolioAgentEditResult, FolioAgentRead, FolioAudience, FolioKind, FolioPassage, FolioRef, User } from "@g1t/contracts";

import { FOLIO_KINDS, folioIdFrom, isFolioKind } from "../../../packages/contracts/src/folios.ts";
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
   * The workspace's artifacts (Artifacts mode), as the docs service lets
   * this agent use them for the person it acts for and everyone who will
   * read the answer. Absent where there is no docs service.
   */
  folios?: FoliosPorts;
}

/** A space as an agent sees it, with what it may do there for the person it acts for. */
export type FolioSpaceLine = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  kind: string;
  projects: string[];
  can: { read: boolean; suggest: boolean; edit: boolean };
};

/** Where a new artifact goes: a space, its asker's Private, or Private shared with the conversation's people. */
export type FolioWhere = { space_id: string } | "private" | { conversation: string[] };

/** A call's answer: the value, or the docs service's error code and sentence. */
export type FolioDone<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

/**
 * Artifacts, as an agent uses them. Every call names the person it acts
 * for, and the reads also who reads the answer; the docs service checks
 * both.
 */
export interface FoliosPorts {
  /** Spaces everyone here can read; null when the docs service couldn't answer. */
  spaces(viewer: User, audience: FolioAudience): Promise<FolioSpaceLine[] | null>;
  /** Passages closest in meaning to `query`; `spaces` (required reading) first. Null when the docs service couldn't answer. */
  recall(viewer: User, audience: FolioAudience, query: string, spaces: string[], kinds?: FolioKind[]): Promise<FolioPassage[] | null>;
  /** Artifacts matching `query` (words and meaning), as lines with links. */
  search(viewer: User, audience: FolioAudience, input: { query: string; kind: FolioKind | null; space_id: string | null; project: string | null }): Promise<string | null>;
  read(viewer: User, audience: FolioAudience, folioId: string): Promise<FolioDone<FolioAgentRead>>;
  /** Artifacts possibly out of date since code they cite changed. */
  stale(viewer: User, audience: FolioAudience, repo: string | null): Promise<string | null>;
  create(
    viewer: User,
    input: { kind: FolioKind; title: string; markdown: string | null; template_id: string | null; where: FolioWhere; parent_id: string | null; source: { title: string; href: string } | null },
  ): Promise<FolioDone<FolioRef>>;
  edit(viewer: User, folioId: string, edit: FolioAgentEdit): Promise<FolioDone<FolioAgentEditResult>>;
  /** `view` or `comment` for people already in this conversation. */
  share(viewer: User, audience: FolioAudience, folioId: string, userIds: string[], role: "view" | "comment"): Promise<FolioDone<null>>;
  /** Sends the asker a link directly, as a message from the agent in their DM with it; false when it couldn't. */
  sendLink(asker: User, link: { title: string; path: string }, note: string): Promise<boolean>;
}

/**
 * What an agent may do, beyond reading: remember, file an issue for the
 * person who asked, and start or shape work. Each is checked here before it
 * runs (the audience, the asker, the hop limit) and again by the service
 * that does it.
 */
export interface ActionPorts {
  /**
   * `onlyForAsker`: this turn read an artifact the whole workspace can't
   * read, so the fact is kept for the person who asked alone.
   */
  remember(body: string, scope: "workspace" | "channel" | "person" | null, onlyForAsker?: boolean): Promise<{ ok: boolean; message: string }>;
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
  /** From chat: a colleague takes the work on for the person who asked, here or in a group message. */
  handOff?(handle: string, brief: string): Promise<{ ok: boolean; message: string }>;
}

/** The most hand-offs one reply makes. */
export const MAX_HAND_OFFS = 2;

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
    "Ask a colleague agent a quick question, privately: their answer comes back to you alone, they do no work in the conversation, and the work stays yours. Use it when their role knows something yours doesn't. To give them the work itself, use hand_off.",
  input_schema: { type: "object", properties: { handle: { type: "string" }, question: { type: "string" } }, required: ["handle", "question"] },
};

const HAND_OFF: ToolDef = {
  name: "hand_off",
  description:
    "Hand work to a colleague agent, for the person who asked: they take it on and answer that person themselves, with that person's access. If they are a member of this conversation (a channel or group message), your brief is posted here; otherwise a group message opens (or is reused) with the person who asked, you and them, your brief goes there, and a card here links to it. It is the only way to get a colleague working: an @mention in your message wakes nobody. Give their handle and a complete brief written to them: what is wanted, why, what done looks like, and what they need from this conversation. For a quick question you answer with, use ask_colleague instead.",
  input_schema: { type: "object", properties: { handle: { type: "string" }, brief: { type: "string" } }, required: ["handle", "brief"] },
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

/** What every artifact tool's description starts from, so the model never mixes them up with workflow run artifacts. */
const ARTIFACTS =
  "Artifacts are the workspace's own documents, made and shared in its Artifacts section: docs now, and later slides, designs and dashboards. They are not a workflow run's build artifacts.";

const FOLIO_TOOLS: ToolDef[] = [
  {
    name: "search_artifacts",
    description: `${ARTIFACTS} Search the artifacts everyone in this conversation can read (specs, runbooks, policies, onboarding, decisions), by words and meaning, plus projects' docs. Optionally only one kind, one space (its name or id from list_spaces) or one project (\`workspace/name\`). Each result has its link and id. Look here first for how things work and what was decided.`,
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        kind: { type: "string", enum: [...FOLIO_KINDS] },
        space: { type: "string", description: "A space's name or id." },
        project: { type: "string", description: "A repository, `workspace/name`." },
      },
      required: ["query"],
    },
  },
  {
    name: "read_artifact",
    description: `${ARTIFACTS} Read one artifact by its id (fol_…) or its link (…/-/artifacts/<name>-fol_…). A doc comes back as Markdown with the ids of its top-level blocks (for edit_artifact), and says what you may do with it.`,
    input_schema: { type: "object", properties: { id: { type: "string", description: "Its id or link." } }, required: ["id"] },
  },
  {
    name: "list_spaces",
    description: `${ARTIFACTS} The spaces whose artifacts everyone in this conversation can read, with what you may do in each (read, suggest, edit).`,
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "stale_artifacts",
    description: `${ARTIFACTS} Artifacts possibly out of date because code they cite changed. Optionally only for one repository (\`workspace/name\`). Start here when keeping the docs current: read each, then bring it up to date with edit_artifact and marks_current.`,
    input_schema: { type: "object", properties: { repo: { type: "string" } } },
  },
];

const FOLIO_WRITE_TOOLS: ToolDef[] = [
  {
    name: "create_artifact",
    description: `${ARTIFACTS} Make a new artifact ("write this up"). Only kind "doc" can be made for now. Give a title and its content as Markdown (or a template id). where: a space (its name or id from list_spaces) as { "space": "..." }, "private" for the person who asked alone, or "conversation" for them plus view access for this conversation's people. Left out: shared with this conversation in a direct message or private channel, the General space in a public channel. It belongs to the person who asked, and you can keep editing it. When it comes from a conversation, set source to that thread's link.`,
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...FOLIO_KINDS] },
        title: { type: "string" },
        content: { type: "string", description: "Markdown." },
        template: { type: "string", description: "A template id, instead of content." },
        where: {
          description: '{ "space": "<name or id>" }, "private" or "conversation".',
          anyOf: [
            { type: "string", enum: ["private", "conversation"] },
            { type: "object", properties: { space: { type: "string" } }, required: ["space"] },
          ],
        },
        parent: { type: "string", description: "A doc to put it under: its id or link." },
        source: { type: "string", description: "The link of the thread it was written up from." },
      },
      required: ["kind", "title"],
    },
  },
  {
    name: "edit_artifact",
    description: `${ARTIFACTS} Change a doc: replace a section (by its heading), a range of top-level blocks (ids from read_artifact), the whole doc, or add to the end. Where you may edit, it applies at once and shows in its history as yours; elsewhere it becomes a suggestion people accept or reject inline. Read it first. Write Markdown. Only docs can be changed this way for now.`,
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Its id or link." },
        target: { type: "string", enum: ["append", "section", "blocks", "document"] },
        heading: { type: "string", description: "For target section: the heading's text." },
        from_block: { type: "string" },
        to_block: { type: "string" },
        markdown: { type: "string" },
        note: { type: "string", description: "Why, in a line, for the history or the suggestion." },
        marks_current: { type: "boolean", description: "This edit brings a doc marked possibly out of date up to date: it clears the mark when it applies or is accepted." },
        suggest_only: { type: "boolean", description: "Suggest even where you could edit." },
      },
      required: ["id", "target", "markdown"],
    },
  },
  {
    name: "share_artifact",
    description: `${ARTIFACTS} Let people in this conversation view or comment on an artifact, when the person who asked has full access to it. Only in a direct message or a private channel, and only with people already in it. You can't give edit or full access, or change who else can open it: for that, ask the person to use Share.`,
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Its id or link." },
        people: { type: "array", items: { type: "string" }, description: "Usernames of people in this conversation." },
        role: { type: "string", enum: ["view", "comment"] },
      },
      required: ["id", "people", "role"],
    },
  },
];

const FOLIO_NAMES = new Set([...FOLIO_TOOLS, ...FOLIO_WRITE_TOOLS].map((tool) => tool.name));

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
  /** Hand-offs made in this reply. */
  private handOffs = 0;
  /** Artifacts read or made in this turn that not everyone here can read: never named here. */
  private readonly notHere = new Set<string>();
  /**
   * Whether this turn read an artifact the whole workspace can't: then what
   * it remembers is kept for the person who asked alone
   * (docs/ARTIFACTS_MODE.md, section 4.3, rule 7).
   */
  private privateRead = false;

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
      // Artifacts are for everyone, Code or not: the docs service decides what this person and audience can read.
      ...(this.ports.folios && this.audience.asker ? FOLIO_TOOLS : []),
      ...(this.ports.folios && this.audience.asker && actions ? FOLIO_WRITE_TOOLS : []),
      ...(roomForHop ? [ASK_COLLEAGUE] : []),
      ...(actions ? [REMEMBER, FORGET] : []),
      ...(this.canFile() ? [DRAFT_ISSUE] : []),
      ...(this.canFile() && actions?.comment ? [COMMENT] : []),
      ...(this.canFile() && actions?.review ? [REVIEW_PULL] : []),
      ...(actions?.startSession && !this.context.session ? [START_SESSION] : []),
      ...(actions?.handOff && !this.context.session && roomForHop ? [HAND_OFF] : []),
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
    if (FOLIO_NAMES.has(name)) {
      if (!this.definitions().some((tool) => tool.name === name) || !asker || !this.ports.folios) return { text: `There is no tool called ${name} here.`, outcome: "refused" };
      return this.folios(name, input, asker, this.ports.folios);
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
   * What the workspace's artifacts say about `query`, for this person and
   * this audience, before the agent answers: no tool call, nothing counted
   * against its tools. Empty when there is no docs service or nothing
   * relevant.
   */
  async recall(query: string | null, spaces: string[]): Promise<FolioPassage[]> {
    const folios = this.ports.folios;
    const asker = this.audience.asker;
    if (!folios || !asker || !query) return [];
    try {
      return (await folios.recall(asker, this.folioAudience(), query, spaces)) ?? [];
    } catch (error) {
      console.error("agents: artifacts recall failed", String(error));
      return [];
    }
  }

  /** Who reads what an agent says here, as the docs service takes it. */
  private folioAudience(): FolioAudience {
    return this.audience.shared ? { kind: "workspace" } : { kind: "people", user_ids: this.audience.members.map((m) => m.id) };
  }

  /** Whether anyone besides the person who asked reads what is said here. */
  private othersHere(asker: User): boolean {
    return this.audience.shared || this.audience.members.some((m) => m.id !== asker.id);
  }

  private async folios(name: string, input: Record<string, unknown>, asker: User, folios: FoliosPorts): Promise<ToolResult> {
    const text = (key: string, max: number) => String(input[key] ?? "").trim().slice(0, max);
    const audience = this.folioAudience();
    switch (name) {
      case "list_spaces": {
        const spaces = await folios.spaces(asker, audience);
        if (spaces === null) return { text: "Spaces couldn't be listed just now.", outcome: "error" };
        if (!spaces.length) return { text: "There are no spaces everyone here can read.", outcome: "allowed" };
        return { text: untrusted("list_spaces", spaces.map(spaceLine).join("\n")), outcome: "allowed" };
      }
      case "search_artifacts": {
        const query = text("query", 200);
        if (query.length < 2) return { text: "Search for at least two characters.", outcome: "refused" };
        const kind = text("kind", 20) || null;
        if (kind && !isFolioKind(kind)) return { text: `There is no kind of artifact called ${kind}: it is doc, slides, design or dashboard.`, outcome: "refused" };
        let spaceId: string | null = null;
        if (text("space", 200)) {
          const space = findSpace((await folios.spaces(asker, audience)) ?? [], text("space", 200));
          if (!space) return this.withheld();
          spaceId = space.id;
        }
        const found = await folios.search(asker, audience, { query, kind: kind as FolioKind | null, space_id: spaceId, project: text("project", 200).toLowerCase() || null });
        if (found === null) return { text: "Search didn't work just now.", outcome: "error" };
        return { text: untrusted(`search_artifacts "${query}"`, found), outcome: "allowed" };
      }
      case "stale_artifacts": {
        const found = await folios.stale(asker, audience, text("repo", 200).toLowerCase() || null);
        if (found === null) return { text: "Out-of-date artifacts couldn't be listed just now.", outcome: "error" };
        return { text: untrusted("stale_artifacts", found), outcome: "allowed" };
      }
      case "read_artifact": {
        const id = folioRef(text("id", 500));
        if (!id) return { text: "Give the artifact's id (fol_…) or its link.", outcome: "refused" };
        const found = await folios.read(asker, audience, id);
        if (!found.ok) return found.code === "not_found" || found.code === "forbidden" ? this.withheld() : { text: found.message, outcome: "refused" };
        const read = found.value;
        if (!this.audience.shared || !read.audience_can_read) this.privateRead = true;
        if (!read.audience_can_read) return this.notForEveryone(asker, read.folio, folios, "found");
        return { text: untrusted(`read_artifact ${id}`, folioReadText(read)), outcome: "allowed" };
      }
      case "create_artifact": {
        const kind = text("kind", 20) || "doc";
        if (!isFolioKind(kind)) return { text: `There is no kind of artifact called ${kind}.`, outcome: "refused" };
        if (kind !== "doc") return { text: NOT_YET, outcome: "refused" };
        const title = text("title", 200);
        const template = text("template", 100) || null;
        const markdown = String(input.content ?? "").slice(0, 100_000);
        if (!title) return { text: "An artifact needs a title.", outcome: "refused" };
        if (!markdown.trim() && !template) return { text: "Give its content as Markdown, or a template.", outcome: "refused" };
        const parentGiven = text("parent", 500);
        const parent = parentGiven ? folioRef(parentGiven) : null;
        if (parentGiven && !parent) return { text: "Give the parent doc's id or link.", outcome: "refused" };
        const place = await this.whereFor(input.where, asker, folios);
        if (!place.ok) return { text: place.message, outcome: "refused" };
        const make = (where: FolioWhere) =>
          folios.create(asker, { kind, title, markdown: template ? null : markdown, template_id: template, where, parent_id: parent, source: sourceLink(text("source", 2000)) });
        let made = await make(place.where);
        // The General space by default, unless the person who asked can't add there: then their Private.
        if (!made.ok && place.fallback && made.code === "forbidden") made = await make("private");
        if (!made.ok) return { text: `It couldn't be made: ${made.message}`, outcome: "refused" };
        const ref = made.value;
        if (this.othersHere(asker)) {
          const check = await folios.read(asker, audience, ref.id).catch(() => null);
          if (!check?.ok || !check.value.audience_can_read) return this.notForEveryone(asker, ref, folios, "made");
        }
        return { text: `Wrote ${ref.title} (${ref.path}, id ${ref.id}). Link it.`, outcome: "allowed" };
      }
      case "edit_artifact": {
        const id = folioRef(text("id", 500));
        const markdown = String(input.markdown ?? "").slice(0, 100_000);
        if (!id || !markdown.trim()) return { text: "Give the artifact's id or link, and the Markdown.", outcome: "refused" };
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
        const edit: FolioAgentEdit = { kind: "doc", target, markdown, note: text("note", 300) || null, suggest_only: input.suggest_only === true, marks_current: input.marks_current === true };
        const done = await folios.edit(asker, id, edit);
        if (!done.ok) return { text: `That didn't work: ${done.message}`, outcome: "refused" };
        return { text: editMessage(done.value, !this.notHere.has(done.value.folio.id)), outcome: "allowed" };
      }
      case "share_artifact": {
        if (this.audience.shared) return { text: "You can share only in a direct message or a private channel. Ask the person to use Share on the artifact instead.", outcome: "refused" };
        const id = folioRef(text("id", 500));
        if (!id) return { text: "Give the artifact's id (fol_…) or its link.", outcome: "refused" };
        const role = input.role === "view" || input.role === "comment" ? input.role : null;
        if (!role) return { text: "You can share to view or comment only. For more, ask the person to use Share.", outcome: "refused" };
        const named = (Array.isArray(input.people) ? input.people : []).filter((p): p is string => typeof p === "string").map((p) => p.trim().replace(/^@/, "").toLowerCase()).filter(Boolean).slice(0, 50);
        const people = named.map((n) => this.audience.members.find((m) => m.username.toLowerCase() === n || m.id === n) ?? n);
        const outside = people.filter((p): p is string => typeof p === "string");
        if (outside.length) return { text: `${outside.map((n) => `@${n}`).join(", ")} ${outside.length === 1 ? "isn't" : "aren't"} in this conversation: you can share only with people in it.`, outcome: "refused" };
        const users = [...new Map((people as User[]).filter((u) => u.id !== asker.id).map((u) => [u.id, u])).values()];
        if (!users.length) return { text: "Name who to share it with: people in this conversation besides the person who asked.", outcome: "refused" };
        const done = await folios.share(asker, audience, id, users.map((u) => u.id), role);
        if (!done.ok) return { text: `It couldn't be shared: ${done.message}`, outcome: "refused" };
        return { text: `Shared with ${users.map((u) => `@${u.username}`).join(", ")}: they can ${role} it.`, outcome: "allowed" };
      }
      default:
        return { text: `There is no tool called ${name}.`, outcome: "refused" };
    }
  }

  /**
   * Where a new artifact goes (docs/ARTIFACTS_MODE.md, section 4.1):
   * - a space named by its name or id, among those everyone here can read;
   * - "private": the asker's Private;
   * - "conversation": Private, plus `view` for this conversation's people;
   * - nothing: the conversation in a DM or private channel, and in a public
   *   channel the General space if the asker can add there (`fallback`:
   *   their Private if the docs service says they can't).
   */
  private async whereFor(given: unknown, asker: User, folios: FoliosPorts): Promise<{ ok: true; where: FolioWhere; fallback: boolean } | { ok: false; message: string }> {
    const named = typeof given === "object" && given !== null ? (given as { space?: unknown }).space : given;
    const wanted = typeof named === "string" ? named.trim().slice(0, 200) : "";
    const others = this.audience.members.filter((m) => m.id !== asker.id).map((m) => m.id);
    const byDefault = async (): Promise<{ ok: true; where: FolioWhere; fallback: boolean }> => {
      if (!this.audience.shared) return { ok: true, where: others.length ? { conversation: this.audience.members.map((m) => m.id) } : "private", fallback: false };
      const spaces = (await folios.spaces(asker, this.folioAudience())) ?? [];
      const general = spaces.find((s) => s.slug === "general") ?? spaces.find((s) => s.name.toLowerCase() === "general");
      return general && general.can.suggest ? { ok: true, where: { space_id: general.id }, fallback: true } : { ok: true, where: "private", fallback: false };
    };
    if (!wanted) return byDefault();
    const lower = wanted.toLowerCase();
    if (typeof given === "string" && lower === "private") return { ok: true, where: "private", fallback: false };
    // A public channel has no list of people to share with: its default instead.
    if (typeof given === "string" && lower === "conversation") return byDefault();
    const space = findSpace((await folios.spaces(asker, this.folioAudience())) ?? [], wanted);
    if (space) return { ok: true, where: { space_id: space.id }, fallback: false };
    // An id the asker gave, for a space not everyone here can read: the docs service checks it.
    if (/^spc_[A-Za-z0-9]+$/.test(wanted)) return { ok: true, where: { space_id: wanted }, fallback: false };
    return { ok: false, message: `There's no space called ${wanted} that everyone here can read. Use list_spaces, or put it in "private" or "conversation".` };
  }

  /**
   * An artifact someone here can't read (docs/ARTIFACTS_MODE.md, section
   * 4.3, rule 2): the link goes to the asker directly, and the agent says
   * only that it found or made something, never what.
   */
  private async notForEveryone(asker: User, folio: FolioRef, folios: FoliosPorts, what: "found" | "made"): Promise<ToolResult> {
    this.notHere.add(folio.id);
    const who = `@${asker.username}`;
    const note =
      what === "made"
        ? "I made this for you. Not everyone in the conversation you asked from can open it, so here is the link:"
        : "Here is what you asked about. Not everyone in the conversation you asked from can open it, so here is the link:";
    const sent = await folios.sendLink(asker, { title: folio.title, path: folio.path }, note).catch(() => false);
    const lead = `Not everyone in this conversation can read this artifact, so ${what === "made" ? "it" : "its content"} isn't shown here. Don't quote it, name it or describe it here;`;
    const text = sent
      ? `${lead} say you ${what} it and that you've sent the link to ${who} directly.`
      : what === "made"
        ? `${lead} say you made it and that ${who} will find it under Artifacts, in their Private or shared with them.`
        : `${lead} say you found it but can't share it here, and ask ${who} to message you directly.`;
    return { text, outcome: what === "made" ? "allowed" : "withheld" };
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
        return said(await actions.remember(fact, scope, this.privateRead));
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
      case "hand_off": {
        const handle = text("handle", 60).replace(/^@/, "").toLowerCase();
        const brief = text("brief", 8000);
        if (!handle || !brief) return { text: "Name the colleague and give them a brief.", outcome: "refused" };
        if (this.context.notConsult.includes(handle)) {
          return { text: `You can't hand work to @${handle}: they sent you this work, or it is you. Answer with what you have.`, outcome: "refused" };
        }
        if (this.handOffs >= MAX_HAND_OFFS) return { text: `You've handed off to ${MAX_HAND_OFFS} colleagues from this message; hand off the rest later.`, outcome: "refused" };
        const done = await actions.handOff!(handle, brief);
        if (done.ok) this.handOffs++;
        return said(done);
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

/** What an agent hears when it asks for a kind that isn't built yet. */
const NOT_YET = "Slides, designs and dashboards aren't available yet: only docs can be made for now. Say so, and offer to write it as a doc instead.";

/**
 * A folio id from an id or any artifact link (`/acme/-/artifacts/runbook-fol_…`,
 * with or without the site and a query); null when there is none.
 */
export function folioRef(given: string): string | null {
  const last = given.trim().split(/[?#]/)[0].split("/").filter(Boolean).at(-1) ?? "";
  return folioIdFrom(last);
}

/** Where an artifact was written up from: a thread's link, cut to the site path the docs service keeps; null when it isn't one. */
export function sourceLink(given: string): { title: string; href: string } | null {
  let href = given.trim();
  if (!href) return null;
  if (/^https?:\/\//i.test(href)) {
    try {
      const url = new URL(href);
      href = `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return null;
    }
  }
  return href.startsWith("/") && !href.startsWith("//") ? { title: "A conversation", href } : null;
}

/** A space by its id, address or name (any case), among those given. */
function findSpace(spaces: FolioSpaceLine[], given: string): FolioSpaceLine | null {
  const wanted = given.trim().toLowerCase();
  return spaces.find((s) => s.id === given.trim()) ?? spaces.find((s) => s.slug.toLowerCase() === wanted) ?? spaces.find((s) => s.name.toLowerCase() === wanted) ?? null;
}

function spaceLine(s: FolioSpaceLine): string {
  const can = s.can.edit ? "you can edit" : s.can.suggest ? "you can suggest edits" : "read only";
  const projects = s.projects.length ? `; about ${s.projects.join(", ")}` : "";
  return `- ${s.name} (id ${s.id}, ${s.kind}; ${can}${projects})${s.description ? `: ${s.description}` : ""}`;
}

/** An artifact as the agent reads it: where it is, what it may do, and its content (a doc's Markdown, with its top-level block ids). */
export function folioReadText(read: FolioAgentRead): string {
  const f = read.folio;
  const can = read.can.edit ? "you can edit it" : read.can.suggest ? "you can suggest edits" : "you can only read it";
  const where = read.space ? `in the ${read.space.name} space` : "not in a space";
  const blocks = read.blocks?.length ? `\nTop-level blocks: ${read.blocks.map((b) => `${b.id} ${b.type}${b.level ? ` ${b.level}` : ""}`).join(", ")}` : "";
  return `# ${f.title} (${f.path}, id ${f.id})\nA ${f.kind}, ${where}; ${can}. Edited ${f.edited_at.slice(0, 16)}.${blocks}\n\n${read.content}`;
}

/** What an edit did, naming the artifact only where everyone here can read it. */
function editMessage(result: FolioAgentEditResult, name: boolean): string {
  const on = name ? ` on ${result.folio.title} (${result.folio.path})` : "";
  switch (result.mode) {
    case "applied":
      return `Changed${on}. It's in its history as yours.`;
    case "suggested":
      return `Suggested${on}: people accept or reject it there.${name ? " Link it so they can." : ""}`;
    case "proposed":
      return `Proposed a change${on}: a person previews and applies it.`;
  }
}

function messageLine(m: FoundMessage): string {
  const where = m.channel ? `#${m.channel}` : "a direct message";
  return `[${m.created_at.slice(0, 16)} in ${where}, channel ${m.channel_id}, message ${m.id}] @${m.author}: ${m.body}`;
}
