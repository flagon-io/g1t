import { useRouteLoaderData } from "react-router";

/**
 * Where this g1t lives: the site, the REST API, the MCP server and the
 * social-card service. g1t.sh uses the defaults below; a self-hosted g1t
 * sets its own (app/lib/addresses.server.ts reads them), and the root
 * loader hands them to every page.
 */
export type Addresses = {
  /** The site's origin, such as `https://g1t.sh`. Git remotes are under it. */
  site: string;
  /** The REST API's origin, which is also the OAuth issuer. */
  api: string;
  /** The MCP server's URL, as agents are told to add it. */
  mcp: string;
  /** The social-card image service's origin, or null when there is none. */
  og: string | null;
  /**
   * Where bytes people supplied are served (repository files, avatars), on
   * an origin of its own that never sees the site's cookies. Self-hosted
   * without a host of its own, a path on the site (`<site>/-/usercontent`).
   */
  usercontent: string;
};

export const HOSTED_ADDRESSES: Addresses = {
  site: "https://g1t.sh",
  api: "https://api.g1t.sh",
  mcp: "https://mcp.g1t.sh",
  og: "https://og.g1t.sh",
  usercontent: "https://g1tusercontent.com",
};

/** The Worker settings the addresses come from; every one optional. */
export type AddressSettings = { SITE_URL?: string; API_URL?: string; MCP_URL?: string; OG_URL?: string; USERCONTENT_URL?: string };

const trim = (value: string) => value.trim().replace(/\/+$/, "");

/**
 * The addresses from the Worker's settings. An unset or empty setting is
 * g1t.sh's address, except `OG_URL`: set to an empty string, it means there
 * is no card service, and pages carry no image tags. `USERCONTENT_URL`
 * unset is g1tusercontent.com on g1t.sh, and a path on the site wherever
 * `SITE_URL` names another.
 */
export function addressesFor(settings: AddressSettings): Addresses {
  const pick = (value: string | undefined, fallback: string) => (value ? trim(value) : "") || fallback;
  const site = pick(settings.SITE_URL, HOSTED_ADDRESSES.site);
  const ownSite = site === HOSTED_ADDRESSES.site;
  return {
    site,
    usercontent: usercontentOf(pick(settings.USERCONTENT_URL, ownSite ? HOSTED_ADDRESSES.usercontent : `${site}/-/usercontent`), site),
    api: pick(settings.API_URL, HOSTED_ADDRESSES.api),
    mcp: pick(settings.MCP_URL, HOSTED_ADDRESSES.mcp),
    og: settings.OG_URL === undefined ? HOSTED_ADDRESSES.og : trim(settings.OG_URL) || null,
  };
}

/**
 * Where uploaded avatars and repository files are served, from the root
 * loader's data; the site's own paths when it has none (they redirect).
 */
export function usercontentFrom(rootData: unknown): string {
  return (rootData as { addresses?: Addresses } | null | undefined)?.addresses?.usercontent ?? "";
}

/** The site's own origin is never the usercontent origin: a path on it is. */
function usercontentOf(address: string, site: string): string {
  return address === site ? `${site}/-/usercontent` : address;
}

/** The addresses in the root loader's data, or g1t.sh's when it has none. */
export function addressesFrom(rootData: unknown): Addresses {
  return (rootData as { addresses?: Addresses } | null | undefined)?.addresses ?? HOSTED_ADDRESSES;
}

/** This g1t's addresses, from the root loader. */
export function useAddresses(): Addresses {
  return addressesFrom(useRouteLoaderData("root"));
}

/** The SSH clone address of a repository (`git@host:owner/name.git`), from its `owner/name`. */
export function sshUrl(addresses: Pick<Addresses, "site">, path: string): string {
  return `git@${new URL(addresses.site).hostname}:${path.replace(/^\/+/, "")}.git`;
}

/** The HTTPS clone address of a repository, from its `owner/name`. */
export function cloneUrl(addresses: Pick<Addresses, "site">, path: string): string {
  return `${addresses.site}/${path.replace(/^\/+/, "")}.git`;
}
