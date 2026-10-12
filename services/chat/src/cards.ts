/**
 * How a kept card shows. Pure, so it is tested apart from the service.
 *
 * Cards were posted by workspace agents, which g1t no longer has. Old ones
 * still show; only their links can be pressed, since the actions they
 * offered had an agent to answer them.
 */
import type { MessageCard } from "@g1t/contracts";

/** A kept card as it goes out: its links kept, actions nobody answers any more dropped. */
export function shownCard(card: MessageCard): MessageCard {
  const { owner: _owner, ref: _ref, actions, ...rest } = card;
  const links = (actions ?? []).filter((action) => !!action?.href);
  return links.length ? { ...rest, actions: links } : rest;
}
