/**
 * /.well-known/g1t.json: where this g1t's parts are (packages/contracts
 * src/discovery.ts). The phone app reads it when someone points it at their
 * own g1t, so they type only the site's address. The same for everyone and
 * public, so any origin may read it.
 */
import { env } from "cloudflare:workers";

import type { G1tDiscovery } from "@g1t/contracts/discovery";

import type { Route } from "./+types/well-known-g1t";
import { HOSTED_ADDRESSES } from "../lib/addresses";
import { addresses } from "../lib/addresses.server";

export function loader(_: Route.LoaderArgs) {
  const { site, api, mcp } = addresses();
  const settings = env as { PHONE_PUSH?: string };
  const body: G1tDiscovery = {
    name: "g1t",
    site,
    api,
    mcp,
    hosted: site === HOSTED_ADDRESSES.site,
    // Phone pushes go through Expo's push service unless this g1t turned them off (PHONE_PUSH=off).
    phone: { chat: true, push: settings.PHONE_PUSH !== "off" },
  };
  return Response.json(body, {
    headers: { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" },
  });
}
