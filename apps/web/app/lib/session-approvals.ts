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

/** Reads a message for a running session, or what is wrong with it. */
export function readMessage(form: FormData): { text: string } | { error: string } {
  const text = String(form.get("text") ?? "").trim();
  if (!text) return { error: "Write a message to send." };
  if ([...text].length > MAX_SESSION_MESSAGE_CHARS) return { error: `A message is at most ${MAX_SESSION_MESSAGE_CHARS} characters.` };
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

/** One row of Needs attention: a notification, or a call waiting on the viewer's answer. */
export type AttentionEntry = { kind: "inbox"; at: number; item: InboxItem } | { kind: "approval"; at: number; approval: AgentApproval };

/**
 * Notifications and waiting calls in one list, newest first. A call past
 * its time is left out: g1t declines it at its next look, and an answer
 * would be refused.
 */
export function attentionEntries(items: InboxItem[], approvals: AgentApproval[], now: number): AttentionEntry[] {
  const entries: AttentionEntry[] = [
    ...items.map((item): AttentionEntry => ({ kind: "inbox", at: Date.parse(item.updatedAt) || 0, item })),
    ...approvals
      .filter((approval) => approval.status === "waiting" && Date.parse(approval.expiresAt) > now)
      .map((approval): AttentionEntry => ({ kind: "approval", at: Date.parse(approval.askedAt) || 0, approval })),
  ];
  return entries.sort((a, b) => b.at - a.at);
}

/** A row's key in the list. */
export function attentionKey(entry: AttentionEntry): string {
  return entry.kind === "inbox" ? entry.item.id : `approval:${entry.approval.sessionId}:${entry.approval.toolUseId}`;
}
