/**
 * Asking g1t in Chat: your direct message with @g1t, where g1t answers on
 * the AI provider an owner chose for the workspace, on its own key. Chat's
 * New with no repository (components/chat/agent-composer.tsx) and the top
 * bar's Ask (components/ask-button.tsx, and the pages that ask through
 * lib/ask.ts) send the question there and open it, so the answer streams
 * in Chat, where the conversation carries on. Browser-only.
 */
import type { AskPage, Result } from "@g1t/contracts";

import { browserTimeZone } from "./time-zone";

async function chatApi<T>(slug: string, body: Record<string, unknown>): Promise<Result<T>> {
  try {
    const response = await fetch(`/${slug}/-/chat/api`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await response.json()) as Result<T>;
  } catch {
    return { ok: false, error: { code: "conflict", message: "g1t could not be reached. Check your connection and try again." } };
  }
}

/**
 * Opens your direct message with g1t; with `fresh`, on a new conversation
 * (g1t reads only what comes next); with `text`, asks it that, telling g1t
 * the page it was asked from. Answers where the conversation is.
 */
export async function askInChat(
  slug: string,
  { text, page, fresh = false }: { text?: string; page?: AskPage | null; fresh?: boolean },
): Promise<{ to: string } | { error: string }> {
  const opened = await chatApi<{ channel: { id: string }; to: string }>(slug, { intent: "g1t_dm" });
  if (!opened.ok) return { error: opened.error.message };
  const channel_id = opened.value.channel.id;
  if (fresh) await chatApi(slug, { intent: "g1t_reset", channel_id });
  const body = text?.trim();
  if (body) {
    const posted = await chatApi(slug, { intent: "post", channel_id, body, page: { ...(page ?? {}), time_zone: browserTimeZone() } });
    if (!posted.ok) return { error: posted.error.message };
  }
  return { to: opened.value.to };
}
