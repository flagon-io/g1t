/**
 * A chat thread's link, to copy and to cite. Pure, so it is tested on its
 * own.
 */

/** A thread's link, to cite and to share: the conversation's path (lib/chat.ts `channelPath`) with `?thread=`. */
export function threadLink(origin: string, conversationPath: string, rootId: string): string {
  return `${origin.replace(/\/+$/, "")}${conversationPath}?thread=${encodeURIComponent(rootId)}`;
}
