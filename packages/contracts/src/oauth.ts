/**
 * OAuth clients. A client is not stored anywhere: its id is its name and
 * redirect addresses, encoded. Registering one therefore writes nothing,
 * and anyone holding a client id can read what it claims to be.
 *
 * That is safe because a public client has no secret to protect: what
 * stops a stolen authorization code being used is PKCE, and what a person
 * approves is the redirect address shown to them.
 */
export type OAuthClient = {
  /** Shown to the person approving, e.g. "Claude Code". */
  name: string;
  redirectUris: string[];
};

const PREFIX = "g1c_";
const MAX_NAME_CHARS = 80;
const MAX_REDIRECTS = 5;
const MAX_URI_CHARS = 500;
/** Schemes that run or expose content instead of opening an application. */
const FORBIDDEN_SCHEMES = new Set(["javascript:", "data:", "file:", "blob:", "vbscript:", "about:"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(encoded: string): string {
  const binary = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

function parse(uri: string): URL | null {
  try {
    return new URL(uri);
  } catch {
    return null;
  }
}

function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * Whether an application may ask to be redirected here: an https address,
 * http on this machine only, or an application's own scheme.
 */
export function isValidRedirectUri(uri: string): boolean {
  const url = parse(uri);
  if (!url || uri.length > MAX_URI_CHARS || url.hash) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return isLoopback(url);
  return !FORBIDDEN_SCHEMES.has(url.protocol);
}

/** The client id for a client, or null if what it asks for is not allowed. */
export function encodeOAuthClient(client: OAuthClient): string | null {
  const name = client.name.trim().slice(0, MAX_NAME_CHARS) || "An application";
  const { redirectUris } = client;
  if (
    redirectUris.length === 0 ||
    redirectUris.length > MAX_REDIRECTS ||
    !redirectUris.every(isValidRedirectUri)
  ) {
    return null;
  }
  return PREFIX + toBase64Url(JSON.stringify({ n: name, r: redirectUris }));
}

export function decodeOAuthClient(clientId: string): OAuthClient | null {
  if (!clientId.startsWith(PREFIX)) return null;
  try {
    const { n, r } = JSON.parse(fromBase64Url(clientId.slice(PREFIX.length)));
    if (typeof n !== "string" || !Array.isArray(r)) return null;
    const client = { name: n, redirectUris: r.map(String) };
    // Decoding applies the same rules as encoding, so a hand-made id gains nothing.
    return encodeOAuthClient(client) ? client : null;
  } catch {
    return null;
  }
}

/**
 * Whether `uri` is one of the client's redirect addresses. Addresses must
 * match exactly, except that an application listening on this machine may
 * use any port, since it cannot know which will be free.
 */
export function isRegisteredRedirect(client: OAuthClient, uri: string): boolean {
  const asked = parse(uri);
  if (!asked) return false;
  return client.redirectUris.some((registered) => {
    if (registered === uri) return true;
    const known = parse(registered);
    return (
      known !== null &&
      isLoopback(known) &&
      isLoopback(asked) &&
      known.hostname === asked.hostname &&
      known.pathname === asked.pathname &&
      known.search === asked.search
    );
  });
}
