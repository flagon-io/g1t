/**
 * Email subscribers: double opt-in and one-click leaving. Only hashes are
 * kept. A confirmation token is random and stored as its SHA-256; an
 * unsubscribe link is the subscriber's id signed with STATUS_SECRET, so it
 * is never stored at all and a copy of the database cannot unsubscribe
 * anyone. Web Crypto only, so it is tested under Node.
 */

/** How long a confirmation link works. */
export const CONFIRM_TTL_MS = 24 * 60 * 60 * 1000;
/** No second confirmation email to one address sooner than this. */
export const RESEND_AFTER_MS = 10 * 60 * 1000;

const EMAIL = /^[^\s@<>"(),;:]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,}$/;

/** An address as kept: trimmed and lowercased; null when it is not one. */
export function normalizeEmail(raw: unknown): string | null {
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}

function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A new random token, as it goes in a link. */
export function newToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** What is kept of a token: its SHA-256, hex. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message))));
}

/** The token in a subscriber's unsubscribe link: `<id>.<signature>`. */
export async function unsubscribeToken(secret: string, id: string): Promise<string> {
  return `${id}.${await hmac(secret, `unsubscribe:${id}`)}`;
}

/** The subscriber an unsubscribe token is for, or null when it is not genuine. */
export async function readUnsubscribeToken(secret: string, token: string): Promise<string | null> {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const id = token.slice(0, dot);
  const expected = await unsubscribeToken(secret, id);
  if (expected.length !== token.length) return null;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0 ? id : null;
}

/** A subscriber's parts: null for everything. */
export function parseParts(json: string | null): string[] | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json);
    return Array.isArray(value) && value.length ? value.map(String) : null;
  } catch {
    return null;
  }
}

/** Whether a subscriber wants news about these parts. */
export function wants(parts: string[] | null, about: string[]): boolean {
  return parts == null || about.length === 0 || about.some((key) => parts.includes(key));
}

/** The parts chosen in the form, known ones only; null (everything) when none or all are. */
export function chosenParts(raw: string[], known: string[]): string[] | null {
  const parts = [...new Set(raw.filter((key) => known.includes(key)))];
  return parts.length === 0 || parts.length === known.length ? null : parts;
}
