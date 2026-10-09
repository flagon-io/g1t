import { env } from "cloudflare:workers";

import { type Addresses, addressesFor } from "./addresses";

/** This g1t's addresses, from the Worker's settings (SITE_URL, API_URL, MCP_URL, OG_URL, USERCONTENT_URL). */
export function addresses(): Addresses {
  return addressesFor(env);
}
