/**
 * How a g1t says where its parts are: `GET <site>/.well-known/g1t.json`.
 * The phone app reads it when someone points it at their own g1t, so they
 * type only the site's address and the app finds the API (the OAuth
 * issuer), wherever that g1t put it. g1t.sh answers it too.
 *
 * Public and the same for everyone: no account, nothing about a person.
 * No imports, so the site and the phone share it.
 */

/** Where the document is served, under a site's origin. */
export const DISCOVERY_PATH = "/.well-known/g1t.json";

export type G1tDiscovery = {
  /** Always "g1t", so a stray JSON file at the address is not mistaken for one. */
  name: "g1t";
  /** The site's origin: where people sign in and approve applications. */
  site: string;
  /** The REST API's origin, which is also the OAuth issuer. */
  api: string;
  /** The MCP server's URL. */
  mcp: string;
  /** Whether this is g1t.sh, rather than a g1t someone runs themselves. */
  hosted: boolean;
  /**
   * What the phone app can use here: `chat`, Chat with the app's own
   * sign-in (the `chat:*` scopes); `push`, notifications on the phone. A g1t
   * from before the phone app has no document at all.
   */
  phone: { chat: boolean; push: boolean };
};

function origin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** A discovery document as read, checked; null when it is not one. */
export function parseDiscovery(value: unknown): G1tDiscovery | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.name !== "g1t") return null;
  const site = origin(v.site);
  const api = origin(v.api);
  if (!site || !api) return null;
  const mcp = typeof v.mcp === "string" ? v.mcp.trim().replace(/\/+$/, "") : "";
  const phone = (v.phone && typeof v.phone === "object" ? v.phone : {}) as Record<string, unknown>;
  return {
    name: "g1t",
    site,
    api,
    mcp,
    hosted: v.hosted === true,
    phone: { chat: phone.chat === true, push: phone.push === true },
  };
}

/**
 * A link that opens the phone app pointed at a g1t: `g1t://connect?server=<site>`.
 * A self-hosted g1t shows it, and its QR code, so its people need not type
 * the address.
 */
export function connectLink(site: string): string {
  return `g1t://connect?server=${encodeURIComponent(site)}`;
}
