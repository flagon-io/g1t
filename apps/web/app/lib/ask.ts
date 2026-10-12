/**
 * Ask g1t's conversation, as the composer keeps it (components/ask-composer):
 * where the person is, the turns so far, and reading the answer as it
 * streams. Pure, so it is tested on its own.
 *
 * A conversation lives in the browser tab for now (the composer keeps it in
 * session storage); keeping conversations on the server comes later.
 */
import type { AskEvent, AskMessage, AskPage } from "@g1t/contracts";

/** First path segments that are g1t's own pages, never a workspace. */
const RESERVED = new Set([
  "settings", "u", "auth", "oauth", "integrations", "new", "invite", "workspaces", "device", "verify",
  "confirm-email", "login", "register", "logout", "forgot", "reset", "search", "status", "avatars", "docs", "-",
]);

/** Where the person is: the page, and the repository, issue or pull request on it. */
export function askPage(pathname: string): AskPage {
  const path = pathname.split(/[?#]/)[0] ?? "";
  const parts = path.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  const page: AskPage = { path: path || "/" };
  const [owner, name, section, number] = parts;
  if (!owner || !name || RESERVED.has(owner.toLowerCase()) || name === "-") return page;
  page.repo = { namespace: owner.toLowerCase(), name };
  const numbered = number && /^\d+$/.test(number) ? Number(number) : null;
  if (numbered != null && section === "issues") page.issue = numbered;
  if (numbered != null && section === "pull") page.pull = numbered;
  return page;
}

export type TurnStatus = "streaming" | "done" | "stopped" | "error";

export type Turn = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: TurnStatus;
  /** Who answered: the provider's name and the model. */
  provider?: string;
  model?: string;
  /** What went wrong, for an answer that did not come. */
  error?: string;
  /** `max_tokens`, `length`: the answer was cut off at its limit. */
  stopReason?: string | null;
};

export type AskState = { turns: Turn[]; busy: boolean };

export const EMPTY_ASK: AskState = { turns: [], busy: false };

export type AskAction =
  | { type: "ask"; question: string; id: string }
  | { type: "event"; event: AskEvent }
  | { type: "stop" }
  | { type: "failed"; message: string }
  | { type: "reset" }
  | { type: "restore"; state: AskState };

/** The answer being written, if one is. */
function answering(state: AskState): Turn | null {
  const last = state.turns.at(-1);
  return last?.role === "assistant" && last.status === "streaming" ? last : null;
}

function withLast(state: AskState, change: (turn: Turn) => Turn, busy: boolean): AskState {
  const last = answering(state);
  if (!last) return state;
  return { turns: [...state.turns.slice(0, -1), change(last)], busy };
}

export function askReducer(state: AskState, action: AskAction): AskState {
  switch (action.type) {
    case "ask": {
      const question = action.question.trim();
      if (state.busy || !question) return state;
      return {
        busy: true,
        turns: [
          ...state.turns,
          { id: `${action.id}-q`, role: "user", content: question, status: "done" },
          { id: `${action.id}-a`, role: "assistant", content: "", status: "streaming" },
        ],
      };
    }
    case "event": {
      const { event } = action;
      switch (event.type) {
        case "meta":
          return withLast(state, (turn) => ({ ...turn, provider: event.provider_label, model: event.model }), true);
        case "text":
          return withLast(state, (turn) => ({ ...turn, content: turn.content + event.text }), true);
        case "done":
          return withLast(state, (turn) => ({ ...turn, status: "done", stopReason: event.stop_reason }), false);
        case "error":
          return withLast(state, (turn) => ({ ...turn, status: "error", error: event.message }), false);
      }
      return state;
    }
    case "stop":
      return withLast(state, (turn) => ({ ...turn, status: "stopped" }), false);
    case "failed":
      return withLast(state, (turn) => ({ ...turn, status: "error", error: action.message }), false);
    case "reset":
      return EMPTY_ASK;
    case "restore":
      return restorable(action.state);
  }
}

/**
 * A conversation kept in the tab, made safe to show again: an answer that
 * was still coming when the page went away is marked stopped.
 */
export function restorable(state: unknown): AskState {
  if (!state || typeof state !== "object" || !Array.isArray((state as AskState).turns)) return EMPTY_ASK;
  const turns = (state as AskState).turns
    .filter((turn) => turn && (turn.role === "user" || turn.role === "assistant") && typeof turn.content === "string")
    .map((turn) => (turn.status === "streaming" ? { ...turn, status: "stopped" as const } : turn));
  return { turns, busy: false };
}

/**
 * What to send with a new question: every question that got an answer, and
 * the answer (as far as it got, if it was stopped), then the new question.
 * A question whose answer failed or never started is left out, so the turns
 * alternate.
 */
export function history(turns: Turn[], question: string): AskMessage[] {
  const messages: AskMessage[] = [];
  for (let at = 0; at < turns.length; at++) {
    const turn = turns[at]!;
    const next = turns[at + 1];
    if (turn.role !== "user") continue;
    if (next?.role === "assistant" && next.status !== "error" && next.content.trim()) {
      messages.push({ role: "user", content: turn.content }, { role: "assistant", content: next.content });
      at++;
    }
  }
  messages.push({ role: "user", content: question.trim() });
  return messages;
}

/**
 * Reads newline-delimited JSON as it arrives: each whole line's event, and
 * what is left of a line still coming. Lines that are not events are
 * skipped.
 */
export function readLines(pending: string, chunk: string): { events: AskEvent[]; rest: string } {
  const text = pending + chunk;
  const lines = text.split("\n");
  const rest = lines.pop() ?? "";
  const events: AskEvent[] = [];
  for (const line of lines) {
    const event = parseEvent(line);
    if (event) events.push(event);
  }
  return { events, rest };
}

export function parseEvent(line: string): AskEvent | null {
  if (!line.trim()) return null;
  try {
    const event = JSON.parse(line) as AskEvent;
    return event && typeof event === "object" && ["meta", "text", "done", "error"].includes(event.type) ? event : null;
  } catch {
    return null;
  }
}

/** Whether an answer was cut off at its length limit. */
export function cutOff(turn: Turn): boolean {
  return turn.stopReason === "max_tokens" || turn.stopReason === "length";
}
