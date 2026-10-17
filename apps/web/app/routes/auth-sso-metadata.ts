import { ssoAddresses } from "@g1t/contracts";

import type { Route } from "./+types/auth-sso-metadata";
import { sso } from "../lib/sso.server";

/**
 * g1t's SAML service provider metadata for a workspace, for its identity
 * provider to read: the entity id (this address) and where to post the
 * response. The same for everyone; it says nothing about the workspace.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const addresses = ssoAddresses(new URL(request.url).origin, params.owner);
  const xml = await sso.metadata(addresses.entityId, addresses.acsUrl);
  return new Response(xml, {
    headers: {
      "content-type": "application/samlmetadata+xml; charset=utf-8",
      "cache-control": "public, max-age=3600",
      "content-disposition": `inline; filename="g1t-${params.owner.toLowerCase()}-metadata.xml"`,
    },
  });
}
