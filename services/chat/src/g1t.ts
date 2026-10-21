/**
 * @g1t in chat (docs.g1t.sh/guides/ask/): every member has a direct message
 * with g1t, and a person writing in it starts an answer from the
 * workspace's own AI provider, through the integrations service's `ask`.
 * The top bar's Ask is the same conversation.
 *
 * What is decided here is pure, so it is tested on its own (g1t.test.ts):
 * which direct messages are with g1t, which messages start an answer, the
 * conversation an answer reads, what g1t says when Ask is not set up, and
 * reading the answer as it streams. The room (src/room.ts) runs answers;
 * src/index.ts writes the messages.
 */
// The modules themselves, not the package's index, so the tests load them.
import { G1T_KEY, type AskProposalState, type ChatAnswer, type MemberProfile, type MessageCard } from "@g1t/contracts/chat";
import { ASK_MAX_MESSAGES, ASK_MAX_MESSAGE_CHARS, ASK_MAX_TOTAL_CHARS, type AskMessage, type AskPage } from "@g1t/contracts/ai";

/** How @g1t shows in chat: the g1t mark, never a person. */
export const G1T_PROFILE: MemberProfile = {
  kind: "system",
  id: "g1t",
  name: "g1t",
  display_name: "g1t",
  avatar: null,
  role: "Answers with your workspace's own AI provider",
  title: null,
  avatar_seed: null,
};

/** The most steps (tool calls and the like) one answer keeps. */
export const MAX_STEPS = 50;
/** The longest one step may be, as JSON; longer ones keep their type and a note. */
const MAX_STEP_BYTES = 8_192;
/** The most answers one direct message with g1t starts in a minute: one person asking. */
export const ANSWERS_PER_MINUTE = 20;

/** What the `meta` column keeps (migration 0005): on an answer, a question from a page, or a new-conversation mark. */
export type MessageMeta = {
  answer?: ChatAnswer;
  page?: AskPage;
  reset?: true;
  /** On g1t's card for a hosted session started from the conversation: its g1t session id. */
  session?: string;
};

/** A hosted session started from a conversation with g1t (Chat's New with a repository). */
export type StartedSession = { id: string; title: string; repo: string };

/**
 * g1t's card for a hosted session started from its conversation: what it
 * works on, in which repository, linked to its page, where it streams. Its
 * state is where it started (Working); the site shows it live. Null for a
 * session id g1t did not make, or a repository outside the workspace.
 */
export function startedSessionCard(workspace: string, session: StartedSession): MessageCard | null {
  const id = String(session?.id ?? "");
  const repo = String(session?.repo ?? "").trim();
  const [namespace, name, extra] = repo.split("/");
  const slug = workspace.toLowerCase();
  if (!/^ses_[0-9a-z]+$/.test(id) || !namespace || !name || extra !== undefined || namespace.toLowerCase() !== slug) return null;
  const title =
    String(session.title ?? "")
      .trim()
      .slice(0, 200) || "Hosted session";
  return {
    kind: "session",
    title,
    detail: "Hosted session",
    state: "Working",
    href: `/${slug}/-/chat/sessions/${id}`,
    fields: [{ label: "Repository", value: repo }],
    ref: id,
  };
}

/** What g1t's card for a started session says as text: in notifications, search, and to g1t when it reads the conversation back. */
export function startedSessionText(card: MessageCard): string {
  const repo = card.fields?.find((field) => field.label === "Repository")?.value ?? "the repository";
  return `I started a hosted session on this in ${repo}: “${card.title}”. It works there on its own; follow it, steer it or stop it at ${card.href}.`;
}

export function parseMeta(text: string | null | undefined): MessageMeta {
  if (!text) return {};
  try {
    const meta = JSON.parse(text) as unknown;
    return meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as MessageMeta) : {};
  } catch {
    return {};
  }
}

/** What a proposal's card has done so far, kept on the answer as a `proposal_state` step. */
export type ProposalState = AskProposalState;

const PROPOSAL_TEXT = ["production_url", "deploy_error", "session_url", "provider_session_url"] as const;

/**
 * An answer with what its proposal `id`'s card did merged into it: one
 * `proposal_state` step per proposal, made the first time, merged after.
 * Only the known fields are kept, texts cut to 500 characters. Null when
 * the answer has no such proposal.
 */
export function withProposalState(answer: ChatAnswer, change: ProposalState): { answer: ChatAnswer; state: ProposalState } | null {
  const steps = answer.steps ?? [];
  if (!steps.some((step) => step.type === "proposal" && step.id === change.id)) return null;
  const at = steps.findIndex((step) => step.type === "proposal_state" && step.id === change.id);
  const state: ProposalState = { ...(at === -1 ? {} : (steps[at] as unknown as ProposalState)), id: change.id };
  for (const key of PROPOSAL_TEXT) {
    const value = change[key];
    if (value === null) state[key] = null;
    else if (typeof value === "string") state[key] = value.slice(0, 500);
  }
  if (typeof change.repo_url === "string") state.repo_url = change.repo_url.slice(0, 500);
  if (typeof change.default_branch === "string") state.default_branch = change.default_branch.slice(0, 200);
  if (Number.isInteger(change.item) && change.item! > 0) state.item = change.item;
  if (typeof change.starting_at === "number") state.starting_at = change.starting_at;
  if (change.started === true) state.started = true;
  const step = { type: "proposal_state", ...state } as Record<string, unknown>;
  const next = at === -1 ? [...steps, step] : steps.map((kept, index) => (index === at ? step : kept));
  return { answer: { ...answer, steps: next }, state };
}

export function metaColumn(meta: MessageMeta): string | null {
  return meta.answer || meta.page || meta.reset ? JSON.stringify(meta) : null;
}

/**
 * The person in a direct message with g1t: one person and g1t, no one
 * else. Null for any other conversation.
 */
export function g1tDmPerson(members: readonly string[]): string | null {
  if (members.length !== 2 || !members.includes(G1T_KEY)) return null;
  const person = members.find((member) => member !== G1T_KEY)!;
  return person.startsWith("user:") ? person : null;
}

/**
 * Whether a message just written starts an answer: a person's own words,
 * at the top of a direct message with g1t. g1t's own messages, cards and
 * thread replies never do; nor does anything anywhere else (mentioning
 * @g1t in a channel does not, yet).
 */
export function startsAnswer(input: {
  channelKind: "channel" | "dm";
  members: readonly string[];
  author: string;
  threadRoot: string | null;
  card: boolean;
  body: string;
}): boolean {
  if (input.channelKind !== "dm" || input.threadRoot || input.card || !input.body.trim()) return false;
  const person = g1tDmPerson(input.members);
  return person != null && input.author === person;
}

/** A message as the conversation reads it: oldest first. */
export type SaidRow = { id: string; author: string; kind: "text" | "card"; body: string; meta: string | null; deleted_at: string | null };

/** The longest note of an earlier answer's reads, in characters. */
const READS_NOTE_CHARS = 800;

/**
 * What an earlier answer read in g1t, as a line put before its text when
 * it is read back: a provider is given only the words of past answers, so
 * without it the model takes an answer made from tool reads for one made
 * up, and takes it back. Null when the answer read nothing.
 */
export function readsNote(steps: ChatAnswer["steps"]): string | null {
  const tools = (steps ?? []).filter((step) => step.type === "tool" && typeof step.label === "string");
  if (tools.length === 0) return null;
  const parts = tools.map((step) => {
    const label = String(step.label).trim();
    const summary = typeof step.summary === "string" ? step.summary.trim() : "";
    if (step.status === "failed") return `${label} (failed${summary ? `: ${summary}` : ""})`;
    if (step.status === "refused") return `${label} (not run)`;
    return summary ? `${label}: ${summary}` : label;
  });
  let note = `[g1t's tool reads for this answer: ${parts.join("; ")}]`;
  if (note.length > READS_NOTE_CHARS) note = `${note.slice(0, READS_NOTE_CHARS - 2)}…]`;
  return note;
}

/**
 * What an answer reads: the direct message's messages after the latest
 * "New conversation" mark, the person's as `user` and g1t's answers as
 * `assistant`, oldest first, alternating, starting and ending with the
 * person, within Ask's limits (the newest kept). Answers that failed, the
 * set-up note and the answer being written are left out; several messages
 * in a row from one side are read as one, and each answer starts with what
 * it read in g1t ([`readsNote`]). Empty when there is nothing to answer.
 */
export function conversation(rows: readonly SaidRow[], answering: string | null = null): AskMessage[] {
  let start = 0;
  rows.forEach((row, index) => {
    if (row.author === G1T_KEY && parseMeta(row.meta).reset) start = index + 1;
  });
  const turns: AskMessage[] = [];
  for (const row of rows.slice(start)) {
    if (row.deleted_at || row.id === answering) continue;
    // Of cards, only g1t's for a session started here: g1t reads back that it started it.
    const startedHere = row.kind === "card" && row.author === G1T_KEY && Boolean(parseMeta(row.meta).session);
    if (row.kind !== "text" && !startedHere) continue;
    let text = row.body.trim();
    if (!text) continue;
    let role: AskMessage["role"];
    if (startedHere) {
      role = "assistant";
    } else if (row.author === G1T_KEY) {
      const answer = parseMeta(row.meta).answer;
      if (!answer || answer.setup || answer.state === "error" || answer.state === "thinking" || answer.state === "streaming") continue;
      role = "assistant";
      // First, so cutting a long answer short keeps it.
      const reads = readsNote(answer.steps);
      if (reads) text = `${reads}\n\n${text}`;
    } else if (row.author.startsWith("user:")) {
      role = "user";
    } else continue;
    const last = turns.at(-1);
    if (last?.role === role) last.content = `${last.content}\n\n${text}`;
    else turns.push({ role, content: text });
  }
  for (const turn of turns) {
    if (turn.content.length > ASK_MAX_MESSAGE_CHARS) {
      // The person's newest words matter most: keep the end of a long question, the start of a long answer.
      turn.content = turn.role === "user" ? turn.content.slice(-ASK_MAX_MESSAGE_CHARS) : turn.content.slice(0, ASK_MAX_MESSAGE_CHARS);
    }
  }
  // The latest word is g1t's: already answered.
  if (turns.at(-1)?.role !== "user") return [];
  let kept = turns.slice(-ASK_MAX_MESSAGES);
  let total = kept.reduce((sum, turn) => sum + turn.content.length, 0);
  while (kept.length && (kept[0]!.role !== "user" || total > ASK_MAX_TOTAL_CHARS)) {
    total -= kept[0]!.content.length;
    kept = kept.slice(1);
  }
  return kept;
}

/** The page the newest question was asked from, if it was asked from one. */
export function latestPage(rows: readonly SaidRow[]): AskPage | null {
  for (let at = rows.length - 1; at >= 0; at--) {
    const row = rows[at]!;
    if (row.author.startsWith("user:") && !row.deleted_at) return parseMeta(row.meta).page ?? null;
  }
  return null;
}

/**
 * The id of the question an answer is for: the person's newest message.
 * Clearing the conversation deletes it, which is how the room knows an
 * answer it was handed read what is gone (src/room.ts).
 */
export function latestQuestion(rows: readonly SaidRow[]): string | null {
  for (let at = rows.length - 1; at >= 0; at--) {
    const row = rows[at]!;
    if (row.author.startsWith("user:") && !row.deleted_at) return row.id;
  }
  return null;
}

/**
 * A page as a person's message may carry it: only what Ask reads, of the
 * shapes it reads. Null when nothing of it is usable.
 */
export function pageFrom(value: unknown): AskPage | null {
  if (!value || typeof value !== "object") return null;
  const sent = value as Record<string, unknown>;
  const number = (n: unknown) => (typeof n === "number" && Number.isInteger(n) && n > 0 && n < 2 ** 31 ? n : null);
  const repo = sent.repo as { namespace?: unknown; name?: unknown } | null | undefined;
  const page: AskPage = {
    path: typeof sent.path === "string" && sent.path.startsWith("/") ? sent.path.slice(0, 500) : null,
    repo:
      repo && typeof repo.namespace === "string" && typeof repo.name === "string" && repo.namespace && repo.name
        ? { namespace: repo.namespace.slice(0, 100), name: repo.name.slice(0, 100) }
        : null,
    workspace: typeof sent.workspace === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(sent.workspace) ? sent.workspace : null,
    item: number(sent.item),
    pull: number(sent.pull),
    time_zone:
      typeof sent.time_zone === "string" && /^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+){0,2}$/.test(sent.time_zone) && sent.time_zone.length <= 64
        ? sent.time_zone
        : null,
  };
  return page.path || page.repo || page.workspace || page.time_zone ? page : null;
}

/** What g1t says when nobody chose an AI provider for Ask yet: once, and where to choose one. */
export function notSetUpText(slug: string): string {
  return [
    "I answer with an AI provider your workspace connects, on its own key, and none is chosen for me yet.",
    "",
    `An owner can choose one under [Settings → AI → Ask g1t](/${slug}/-/ai#ask). If you're not an owner, ask one of them to.`,
  ].join("\n");
}

/** What g1t says when Ask is set up but cannot answer now: the reason, short. */
export function cannotAnswerText(problem: string): string {
  return `I couldn't answer that: ${problem.trim() || "something went wrong."}`;
}

/**
 * An answer as it streams in: the integrations service's newline-delimited
 * events, read as they come. Events it does not know (a newer service's
 * tool steps, say) are kept as steps, never shown as text, and never
 * break the answer.
 */
export class AnswerReader {
  body = "";
  answer: ChatAnswer = { state: "thinking" };
  private rest = "";
  private ended = false;

  /** Reads a chunk; true when something shown changed. */
  feed(chunk: string): boolean {
    const lines = (this.rest + chunk).split("\n");
    this.rest = lines.pop() ?? "";
    let changed = false;
    for (const line of lines) changed = this.line(line) || changed;
    return changed;
  }

  /** The stream ended: whatever is left of a line, and an answer that never said it was done. */
  finish(): void {
    if (this.rest) this.line(this.rest);
    this.rest = "";
    if (!this.ended) {
      this.ended = true;
      if (this.body.trim()) this.answer = { ...this.answer, state: "error", error: "The answer broke off." };
      else this.answer = { ...this.answer, state: "error", error: this.answer.error ?? "No answer came." };
    }
  }

  /** Stopped (Stop, or a newer question): what came stays. */
  stop(): void {
    if (this.ended) return;
    this.ended = true;
    this.answer = { ...this.answer, state: "stopped" };
  }

  get over(): boolean {
    return this.ended;
  }

  private line(line: string): boolean {
    if (!line.trim() || this.ended) return false;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return false;
    }
    if (!event || typeof event !== "object" || typeof event.type !== "string") return false;
    switch (event.type) {
      case "meta":
        this.answer = {
          ...this.answer,
          provider_label: typeof event.provider_label === "string" ? event.provider_label : null,
          model: typeof event.model === "string" ? event.model : null,
          ...(event.auto === true ? { auto: true } : {}),
        };
        return true;
      case "text":
        if (typeof event.text !== "string" || !event.text) return false;
        this.body += event.text;
        this.answer = { ...this.answer, state: "streaming" };
        return true;
      case "done":
        this.ended = true;
        this.answer = { ...this.answer, state: "done", stop_reason: typeof event.stop_reason === "string" ? event.stop_reason : null };
        return true;
      case "error":
        this.ended = true;
        this.answer = { ...this.answer, state: "error", error: typeof event.message === "string" ? event.message : "Something went wrong." };
        return true;
      default: {
        const steps = this.answer.steps ?? [];
        const json = JSON.stringify(event);
        const step = json.length > MAX_STEP_BYTES ? { type: event.type, id: event.id, truncated: true } : event;
        // A tool step comes again with its id when it ends, and sources come
        // whole: each replaces the line it updates, so a step is kept once.
        const at = steps.findIndex((kept) =>
          event.type === "sources"
            ? kept.type === "sources"
            : event.type === "tool" && typeof event.id === "string" && kept.type === "tool" && kept.id === event.id,
        );
        if (at !== -1) {
          this.answer = { ...this.answer, steps: steps.map((kept, index) => (index === at ? step : kept)) };
          return true;
        }
        if (steps.length >= MAX_STEPS) return false;
        this.answer = { ...this.answer, steps: [...steps, step] };
        return true;
      }
    }
  }
}

/**
 * The text an answer is stored with at its end: what came, or, when nothing
 * did, a short line saying why, so g1t never answers with silence.
 */
export function finalBody(body: string, answer: ChatAnswer): string {
  if (body.trim()) return body;
  if (answer.state === "error") return cannotAnswerText(answer.error ?? "");
  if (answer.state === "stopped") return "_Stopped before answering._";
  return "_No answer came._";
}

/** Whether `times` (ms, oldest first) leave room for another answer now; and the times to keep. */
export function answerAllowed(times: readonly number[], now: number): { ok: boolean; times: number[] } {
  const recent = times.filter((at) => now - at < 60_000);
  if (recent.length >= ANSWERS_PER_MINUTE) return { ok: false, times: recent };
  return { ok: true, times: [...recent, now] };
}

/**
 * An answer older than this that still says it is being written was cut
 * off (the room that wrote it went away): it shows as stopped.
 */
export const STALE_ANSWER_MS = 16 * 60_000;

export function shownAnswer(answer: ChatAnswer | undefined, createdAt: string, now: number): ChatAnswer | null {
  if (!answer) return null;
  if ((answer.state === "thinking" || answer.state === "streaming") && now - Date.parse(createdAt) > STALE_ANSWER_MS) {
    return { ...answer, state: "stopped" };
  }
  return answer;
}
