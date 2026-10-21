/**
 * Answering a hosted session from the web: the calls it waits on someone
 * to allow or deny, and messages sent to it while it runs
 * (routes/workspace/work/sessions/session.tsx, components/session-answer.tsx,
 * and Needs attention in Chat's sidebar). The integrations service decides
 * who may answer and refuses an answer that came too late; these read the
 * forms and say how long a call has left.
 * No Workers or React imports, so it can be tested under Node.
 */
import type { AgentApproval, ApprovalAnswer, InboxItem } from "@g1t/contracts";

/**
 * The most characters of a message: `MAX_SESSION_MESSAGE_CHARS` in
 * @g1t/contracts, written out because Node's test runner reads only its
 * types. The service checks it again.
 */
const MAX_SESSION_MESSAGE_CHARS = 4000;

/** What an Allow or Deny form asks, or what is wrong with it. */
export type AnswerForm = { toolUseId: string; answer: ApprovalAnswer; note?: string } | { error: string };

/** Reads an Allow or Deny form: the call it answers, the answer, and with a denial, why. */
export function readAnswer(form: FormData): AnswerForm {
  const toolUseId = String(form.get("toolUseId") ?? "").trim();
  const answer = String(form.get("answer") ?? "");
  if (!toolUseId) return { error: "Say which call to answer." };
  if (answer !== "allow" && answer !== "deny") return { error: "Answer with Allow or Deny." };
  const note = String(form.get("note") ?? "").trim();
  return answer === "deny" && note ? { toolUseId, answer, note: note.slice(0, 1000) } : { toolUseId, answer };
}

/**
 * Reads a message for a running session, or what is wrong with it; with
 * `max`, a longer limit: a follow-up that starts a new session (`MAX_PROMPT_CHARS`).
 */
export function readMessage(form: FormData, max = MAX_SESSION_MESSAGE_CHARS): { text: string } | { error: string } {
  const text = String(form.get("text") ?? "").trim();
  if (!text) return { error: "Write a message to send." };
  if ([...text].length > max) return { error: `A message is at most ${max} characters.` };
  return { text };
}

/** How long a call has left before g1t declines it: "9 min left", "under a minute left", or "declining now". */
export function timeLeft(expiresAt: string, now: number): string {
  const left = Date.parse(expiresAt) - now;
  if (!Number.isFinite(left) || left <= 0) return "declining now";
  if (left < 60_000) return "under a minute left";
  return `${Math.ceil(left / 60_000)} min left`;
}

/** The tool a call uses, as a person reads it: `g1t:work_item` is g1t's work_item. */
export function toolName(tool: string): string {
  const [server, name] = tool.includes(":") ? tool.split(":", 2) : [null, tool];
  return server ? `${name} (${server})` : tool;
}

/** What a call wants to do, without its tool's name in front when the summary starts with it. */
export function approvalWhat(approval: Pick<AgentApproval, "tool" | "summary">): string {
  const prefix = `${approval.tool}: `;
  return approval.summary.startsWith(prefix) ? approval.summary.slice(prefix.length) : approval.summary;
}

/**
 * The inbox event that tells whoever started a hosted session that one of
 * its calls waits (`APPROVAL_REQUESTED` in the Rust contracts). Written out,
 * as above, for Node's test runner.
 */
const APPROVAL_REQUESTED = "agent_session.approval_requested";

/**
 * The call an inbox item tells of, when it is a hosted session's call
 * waiting for approval: its link is the session's page at the call's card
 * (`/acme/-/chat/sessions/ses_1#approval-sevt_3`).
 */
export function approvalOfItem(item: Pick<InboxItem, "event" | "url">): { sessionId: string; toolUseId: string } | null {
  if (item.event !== APPROVAL_REQUESTED) return null;
  const match = /\/-\/chat\/sessions\/([^/?#]+)[^#]*#approval-(.+)$/.exec(item.url);
  return match ? { sessionId: decodeURIComponent(match[1]!), toolUseId: decodeURIComponent(match[2]!) } : null;
}

/** One row of Needs attention: a notification, or a call waiting on the viewer's answer. */
export type AttentionEntry = { kind: "inbox"; at: number; item: InboxItem } | { kind: "approval"; at: number; approval: AgentApproval };

/** A waiting call's key, in Needs attention and once it is answered there. */
export function approvalKey(approval: Pick<AgentApproval, "sessionId" | "toolUseId">): string {
  return `approval:${approval.sessionId}:${approval.toolUseId}`;
}

/**
 * Notifications and waiting calls in one list, newest first. A call past
 * its time is left out: g1t declines it at its next look, and an answer
 * would be refused. So is a call answered here (`gone`, by `approvalKey`).
 *
 * A call shows once. Its starter is also told of it in their inbox, and
 * the waiting calls (`approvals`) are what can be answered, so a
 * notification about a call gives way to the call, and one about a call no
 * longer waiting (answered elsewhere, declined, ended) is left out rather
 * than linger until the inbox settles it. Only while the calls could not
 * be read (`approvals` null) do those notifications show, as links.
 */
export function attentionEntries(items: InboxItem[], approvals: AgentApproval[] | null, now: number, gone: ReadonlySet<string> = new Set()): AttentionEntry[] {
  const entries: AttentionEntry[] = [
    ...items
      .filter((item) => {
        const call = approvalOfItem(item);
        return call == null || (approvals == null && !gone.has(approvalKey(call)));
      })
      .map((item): AttentionEntry => ({ kind: "inbox", at: Date.parse(item.updatedAt) || 0, item })),
    ...(approvals ?? [])
      .filter((approval) => approval.status === "waiting" && Date.parse(approval.expiresAt) > now && !gone.has(approvalKey(approval)))
      .map((approval): AttentionEntry => ({ kind: "approval", at: Date.parse(approval.askedAt) || 0, approval })),
  ];
  return entries.sort((a, b) => b.at - a.at);
}

/** A row's key in the list. */
export function attentionKey(entry: AttentionEntry): string {
  return entry.kind === "inbox" ? entry.item.id : approvalKey(entry.approval);
}

/** Which call an answer from Needs attention is for: its session's repository and the session, besides the answer itself. */
export type ApprovalTarget = { repo: { namespace: string; name: string }; sessionId: string };

/** Reads which call a Needs attention card answers, or what is wrong with the form. */
export function readApprovalTarget(form: FormData): ApprovalTarget | { error: string } {
  const [namespace, name, ...rest] = String(form.get("repo") ?? "")
    .trim()
    .split("/");
  const sessionId = String(form.get("sessionId") ?? "").trim();
  if (!namespace || !name || rest.length > 0) return { error: "Say which repository the session runs in." };
  if (!sessionId) return { error: "Say which session to answer." };
  return { repo: { namespace, name }, sessionId };
}

/** What answering a call from Needs attention comes to. */
export type AnswerOutcome = { answered: true } | { error: string; refused: boolean };

/**
 * Whether a refused answer means the call is gone for good: answered by
 * someone else, declined, its session ended, or not theirs to answer. Its
 * card says why, then leaves. Anything else (g1t did not answer, the
 * provider did not take it) may be tried again, and the card stays.
 */
export function refusedForGood(code: string): boolean {
  return code === "conflict" || code === "not_found" || code === "forbidden";
}

/** The window event an answer from anywhere sends, so what shows the call (Needs attention, Recents) reads again. */
export const APPROVAL_ANSWERED_EVENT = "g1t:approval-answered";
