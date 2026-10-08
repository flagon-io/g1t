import { redirect } from "react-router";

import type { Route } from "./+types/actions-artifact";
import { addresses } from "../../lib/addresses.server";
import { readArtifact } from "../../lib/artifacts.server";
import { actions } from "../../lib/services.server";
import { getViewer } from "../../lib/session.server";

/**
 * One artifact of a run, for anyone who can see the run: a redirect to a
 * link the API signed for a few minutes, or, for one an older runner kept
 * in KV, its bytes.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const repo = { namespace: params.owner, name: params.repo };
  const viewer = getViewer(context);
  const found = await actions.artifactDownload(repo, viewer, { run: params.id, name: params.name });
  if (found.ok && found.value.blob) {
    throw redirect(`${addresses().api}/actions/toolkit/blobs/${found.value.blob}`);
  }
  const seen = await actions.run(repo, viewer, params.id);
  if (!seen.ok) throw new Response("Not found.", { status: 404 });
  const bytes = await readArtifact(params.id, params.name);
  if (!bytes) throw new Response("That artifact is gone: it expired or was deleted.", { status: 404 });
  return new Response(bytes.buffer as ArrayBuffer, {
    headers: {
      "content-type": "application/gzip",
      "content-disposition": `attachment; filename="${params.name.replace(/"/g, "")}.tar.gz"`,
    },
  });
}
