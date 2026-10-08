/**
 * The dependency graph as an SPDX 2.3 JSON document, downloaded as a file:
 * `<owner>-<repo>.spdx.json`. Write and up, as the Security pages.
 */
import type { Route } from "./+types/security-sbom";
import { requireInsider } from "../../lib/access.server";
import { securitySuite } from "../../lib/services.server";
import { getViewer, requireUser, unwrap } from "../../lib/session.server";

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context) ?? requireUser(context, request);
  await requireInsider(context, params, "push");
  const document = unwrap(await securitySuite.sbom({ namespace: params.owner, name: params.repo }, viewer));
  return new Response(`${JSON.stringify(document, null, 2)}\n`, {
    headers: {
      "content-type": "application/spdx+json; charset=utf-8",
      "content-disposition": `attachment; filename="${params.owner}-${params.repo}.spdx.json"`,
      "cache-control": "private, no-store",
    },
  });
}
