/**
 * Live sockets for a page opened with an access token (lib/website-token.ts).
 *
 * A browser cannot put an `Authorization` header on a WebSocket, so a page
 * a token opened has no way to sign its sockets in: there is no session
 * cookie. Instead, just before it opens one, the page asks
 * `GET /-/live/ticket?path=<socket path>` (a normal request, which carries
 * the token like any other) for a socket ticket, and adds it to the
 * socket's address as `?ticket=`. Sessions never ask: their sockets carry
 * the cookie as they always have.
 *
 * A ticket:
 * - is good for {@link TICKET_SECONDS} seconds, and for one socket path
 *   alone (`/-/live`, `/<workspace>/-/chat/live` or
 *   `/<workspace>/-/artifacts/live`);
 * - is read only by those sockets' upgrade, never by a page, a data
 *   request, a form post or the API ({@link ticketViewer} ignores any
 *   request that is not a WebSocket upgrade);
 * - holds the token itself, encrypted and authenticated (AES-GCM) under a
 *   key only the site has, so the upgrade checks the token exactly as a
 *   page request does: deleted, expired, revoked by a workspace or with
 *   "Use the website as you" turned off, it opens nothing, even inside the
 *   ticket's minute;
 * - is never stored, logged or passed on: the socket handlers build the
 *   service's address afresh, without it.
 *
 * No Workers imports, so it is tested under Node.
 */

import type { User } from "@g1t/contracts";

/** How long a ticket is good for. */
export const TICKET_SECONDS = 60;

/** The query parameter a socket's address carries a ticket in. */
export const TICKET_PARAM = "ticket";

/** Where a page asks for one. */
export const TICKET_ROUTE = "/-/live/ticket";

const PREFIX = "st1.";

/**
 * A socket path as the routes match it (any case, no doubled or trailing
 * slashes), when it is one of the site's live sockets; else null.
 */
export function socketPath(pathname: string): { path: string; workspace: string | null } | null {
  let path = pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  path = path.toLowerCase().replace(/\/{2,}/g, "/");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  if (path === "/-/live") return { path, workspace: null };
  const match = /^\/([^/]+)\/-\/(?:chat|artifacts)\/live$/.exec(path);
  if (!match || match[1] === "-") return null;
  return { path, workspace: match[1]! };
}

const keys = new Map<string, Promise<CryptoKey>>();

/**
 * The ticket key, derived from the site's secret for this one use (so it
 * never doubles as the key the secret is otherwise for).
 */
function ticketKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle
      .importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveKey"])
      .then((base) =>
        crypto.subtle.deriveKey(
          { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("g1t"), info: new TextEncoder().encode("socket ticket v1") },
          base,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        ),
      );
    keys.set(secret, key);
  }
  return key;
}

/** Binds the ciphertext to the path, so a ticket opens nowhere else. */
function bound(path: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`g1t socket ticket\n${path}`);
}

function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const raw = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

type Sealed = { t: string; u: string; p: string; e: number };

/**
 * A ticket for one socket path, for the token a page request carried and
 * the person it resolved to. `path` is a {@link socketPath}.
 */
export async function issueTicket(
  secret: string,
  input: { token: string; userId: string; path: string },
  nowMs = Date.now(),
): Promise<{ ticket: string; expires_at: string }> {
  const expires = Math.floor(nowMs / 1000) + TICKET_SECONDS;
  const sealed: Sealed = { t: input.token, u: input.userId, p: input.path, e: expires };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: bound(input.path) },
    await ticketKey(secret),
    new TextEncoder().encode(JSON.stringify(sealed)),
  );
  const out = new Uint8Array(iv.length + body.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(body), iv.length);
  return { ticket: PREFIX + base64url(out), expires_at: new Date(expires * 1000).toISOString() };
}

/**
 * The token and person a ticket was made for, when it is genuine, for
 * this socket path, and not past its minute; else null.
 */
export async function openTicket(
  secret: string,
  ticket: string,
  path: string,
  nowMs = Date.now(),
): Promise<{ token: string; userId: string } | null> {
  if (!ticket.startsWith(PREFIX) || ticket.length > 2048) return null;
  const bytes = fromBase64url(ticket.slice(PREFIX.length));
  if (!bytes || bytes.length <= 12 + 16) return null;
  let sealed: Sealed;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: bound(path) },
      await ticketKey(secret),
      bytes.slice(12),
    );
    sealed = JSON.parse(new TextDecoder().decode(plain)) as Sealed;
  } catch {
    // Tampered with, made for another path, or under another key.
    return null;
  }
  if (typeof sealed?.t !== "string" || typeof sealed.u !== "string" || sealed.p !== path || typeof sealed.e !== "number") return null;
  if (sealed.e * 1000 <= nowMs) return null;
  return { token: sealed.t, userId: sealed.u };
}

/**
 * The person a socket's ticket signs in, checked as a page request with
 * the token would be: `lookup` is identity's `user_for_access_token`
 * narrowed by lib/website-token.ts's `websiteUser`.
 * Null for anything but a WebSocket upgrade to the socket the ticket was
 * made for, and for a ticket that is not genuine, has expired, or whose
 * token no longer may use the website.
 */
export async function ticketViewer(
  request: Request,
  secret: string,
  lookup: (token: string) => Promise<User | null>,
  nowMs = Date.now(),
): Promise<User | null> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return null;
  const url = new URL(request.url);
  const ticket = url.searchParams.get(TICKET_PARAM);
  if (!ticket) return null;
  const socket = socketPath(url.pathname);
  if (!socket) return null;
  const opened = await openTicket(secret, ticket, socket.path, nowMs);
  if (!opened || !opened.token.startsWith("g1t_")) return null;
  const user = await lookup(opened.token);
  return user && user.id === opened.userId ? user : null;
}
