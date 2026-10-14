/**
 * One answer from @g1t, from asking to its last word: what the channel's
 * room (src/room.ts) runs for a question in a direct message with g1t.
 * Everything it touches comes in as `AnswerDeps`, so it is tested without
 * a provider, a database or sockets (answer.test.ts).
 *
 * 1. Asks the integrations service what Ask answers with. Nothing chosen:
 *    g1t says where an owner chooses a provider, and that is the answer.
 *    Chosen but unusable: g1t says why.
 * 2. Asks, and reads the answer as it streams: the text so far goes to the
 *    room live at most every `SHOW_EVERY_MS`, and is saved every
 *    `SAVE_EVERY_MS`, so a reload mid-answer shows most of it.
 * 3. Ends it: the message is stored as a normal message with what came
 *    (or a short line saying why nothing did), and the person is notified.
 *
 * Stop, or a newer question, aborts `signal`: what came stays, marked
 * stopped.
 */
import type { AskSetup, ChatAnswer } from "@g1t/contracts";

import { AnswerReader, cannotAnswerText, finalBody, notSetUpText } from "./g1t.ts";

/** The shortest time between two live frames of an answer. */
export const SHOW_EVERY_MS = 120;
/** The shortest time between two saves of an answer still coming. */
export const SAVE_EVERY_MS = 3_000;

export type AnswerDeps = {
  slug: string;
  /** What Ask answers with; null when the integrations service did not say. */
  setup(): Promise<AskSetup | null>;
  /** The integrations service's `ask` answer, streamed. */
  ask(signal: AbortSignal): Promise<Response>;
  /** g1t is thinking: shown as typing. */
  typing(): void;
  /** The answer so far, live. */
  show(body: string, answer: ChatAnswer): void;
  /** Saves the answer so far, while it is still coming. */
  save(body: string, answer: ChatAnswer): Promise<void>;
  /** Stores the answer as it ended and tells the room and the person. */
  finish(body: string, answer: ChatAnswer): Promise<void>;
  now(): number;
};

export async function runAnswer(deps: AnswerDeps, signal: AbortSignal): Promise<void> {
  deps.typing();
  const setup = await deps.setup().catch(() => null);
  if (signal.aborted) {
    await deps.finish(finalBody("", { state: "stopped" }), { state: "stopped" });
    return;
  }
  if (setup?.problem) {
    if (!setup.provider_id) {
      await deps.finish(notSetUpText(deps.slug), { state: "done", setup: "missing" });
    } else {
      await deps.finish(cannotAnswerText(setup.problem), { state: "error", error: setup.problem });
    }
    return;
  }
  const reader = new AnswerReader();
  let shownAt = 0;
  let savedAt = deps.now();
  try {
    const response = await deps.ask(signal);
    if (!response.ok || !response.body) {
      reader.feed(`${JSON.stringify({ type: "error", message: "g1t's integrations did not answer. Try again in a moment." })}\n`);
    } else {
      const chunks = response.body.pipeThrough(new TextDecoderStream()).getReader();
      // Stop ends the read at once, not at the provider's next word.
      const stopped = () => void chunks.cancel().catch(() => {});
      signal.addEventListener("abort", stopped, { once: true });
      try {
        for (;;) {
          const { value, done } = await chunks.read();
          if (done || signal.aborted) break;
          if (!reader.feed(value)) continue;
          const now = deps.now();
          if (now - shownAt >= SHOW_EVERY_MS) {
            shownAt = now;
            deps.show(reader.body, reader.answer);
          }
          if (now - savedAt >= SAVE_EVERY_MS && !reader.over) {
            savedAt = now;
            await deps.save(reader.body, reader.answer).catch(() => {});
          }
          if (reader.over) break;
        }
      } finally {
        signal.removeEventListener("abort", stopped);
      }
    }
  } catch (error) {
    if (!signal.aborted) {
      console.error("g1t's answer broke off", error);
      reader.feed(`${JSON.stringify({ type: "error", message: "The answer broke off. Ask again." })}\n`);
    }
  }
  if (signal.aborted) reader.stop();
  else reader.finish();
  await deps.finish(finalBody(reader.body, reader.answer), reader.answer);
}
