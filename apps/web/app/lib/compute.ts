/**
 * How the site shows what the compute gate says (`@g1t/contracts`
 * compute.ts): its messages name the page to act on, such as
 * `/acme/-/billing`, which is shown as a link. Pure, so it can be tested.
 */

/** A message in pieces: plain text, and g1t paths to link. */
export type Piece = { text: string; href?: string };

/** A workspace page path, such as `/acme/-/billing` or `/acme/-/settings`. */
const PATH = /(?<![\w/])(\/[a-z0-9][a-z0-9-]*\/-\/[a-z0-9][a-z0-9/#-]*)/gi;

/** Splits a message so the g1t pages it names can be links. */
export function linkPaths(message: string): Piece[] {
  const pieces: Piece[] = [];
  let at = 0;
  for (const match of message.matchAll(PATH)) {
    // A sentence's full stop is not part of the path.
    const path = match[1].replace(/[.#/-]+$/, "");
    const start = match.index ?? 0;
    if (start > at) pieces.push({ text: message.slice(at, start) });
    pieces.push({ text: path, href: path });
    at = start + path.length;
  }
  if (at < message.length) pieces.push({ text: message.slice(at) });
  return pieces;
}

/** How a run waiting for a free agent slot says so (`WAITING_PREFIX`). */
export function isWaitingMessage(message: string): boolean {
  return message.startsWith("Waiting for a free slot");
}
