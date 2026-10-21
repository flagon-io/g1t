/**
 * How a kept card shows. Pure, so it is tested apart from the service.
 *
 * Cards were posted by workspace agents, which g1t no longer has. Old ones
 * still show; only their links can be pressed, since the actions they
 * offered had an agent to answer them.
 */
import type { MessageCard } from "@g1t/contracts";

/**
 * A kept card as it goes out: its links kept, actions nobody answers any
 * more dropped. g1t's own card for a hosted session started from a
 * conversation with it (src/g1t.ts `startedSessionCard`: no owner, linked
 * to the session's page) keeps its session id, which the site follows live.
 */
export function shownCard(card: MessageCard): MessageCard {
  const { owner, ref, actions, ...rest } = card;
  const links = (actions ?? []).filter((action) => !!action?.href);
  const followed = !owner && card.kind === "session" && /^ses_[0-9a-z]+$/.test(ref ?? "") && /^\/[^/]+\/-\/chat\/sessions\//.test(card.href ?? "");
  const shown: MessageCard = followed ? { ...rest, ref } : rest;
  return links.length ? { ...shown, actions: links } : shown;
}
