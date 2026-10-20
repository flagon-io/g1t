/**
 * The cache's key for a session (lib/session.server.ts): a hash of its
 * token, never the token, so nothing the cache holds signs anyone in.
 */
export async function sessionKey(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `session:${hex}`;
}
