/**
 * `-/approvals`: allows or denies a hosted session's call from Needs
 * attention in Chat's sidebar (components/needs-attention.tsx), on any
 * page. The card's fetcher posts the call (its repository, session and
 * `toolUseId`) and the answer; the integrations service's
 * `answer_agent_session` decides who may answer and refuses an answer that
 * came too late or after someone else's, as it does from the session's
 * page. Answers `AnswerOutcome` (lib/session-approvals.ts): a refusal for
 * good says why, and the card then leaves; any other failure may be tried
 * again.
 */
import type { Route } from "./+types/approvals";
import { agentSessions } from "../../lib/services.server";
import { type AnswerOutcome, readAnswer, readApprovalTarget, refusedForGood } from "../../lib/session-approvals";
import { assertSameOrigin, requireUser } from "../../lib/session.server";

export async function action({ request, context }: Route.ActionArgs): Promise<AnswerOutcome> {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const target = readApprovalTarget(form);
  if ("error" in target) return { error: target.error, refused: false };
  const read = readAnswer(form);
  if ("error" in read) return { error: read.error, refused: false };
  const answered = await agentSessions.answer(user, target.repo, target.sessionId, read.toolUseId, read.answer, read.note).catch(() => null);
  if (!answered) return { error: "The answer could not be sent. Try again in a moment.", refused: false };
  return answered.ok ? { answered: true } : { error: answered.error.message, refused: refusedForGood(answered.error.code) };
}
