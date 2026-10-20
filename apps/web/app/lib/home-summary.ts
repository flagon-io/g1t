/**
 * Home's Summarize card (components/home-summary.tsx), its pure parts:
 * what one request to chat's `ask_g1t` (routes/workspace/chat/api.ts)
 * leaves the card showing.
 */
import type { Result } from "@g1t/contracts";

/** What the card shows: asking, the answer to one question, or why there is none. */
export type SummaryState =
  | { step: "asking" }
  | { step: "answering"; channelId: string; questionId: string }
  | { step: "problem"; message: string; setup: boolean; owner: boolean };

/** What `ask_g1t` answers: the question asked, or why Ask cannot answer yet and whether the viewer can fix that. */
export type AskedG1t = { channel_id: string; question_id: string } | { problem: string; owner: boolean };

/** The card after `ask_g1t` answered; null when it could not be reached. */
export function summaryAsked(answer: Result<AskedG1t> | null): SummaryState {
  if (!answer) return { step: "problem", message: "Ask could not be reached. Try again in a moment.", setup: false, owner: false };
  if (!answer.ok) return { step: "problem", message: answer.error.message, setup: false, owner: false };
  if ("problem" in answer.value) return { step: "problem", message: answer.value.problem, setup: true, owner: answer.value.owner };
  return { step: "answering", channelId: answer.value.channel_id, questionId: answer.value.question_id };
}
