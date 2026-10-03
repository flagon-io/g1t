import type { Route } from "./+types/actions-artifact";
import { readArtifact } from "../../lib/artifacts.server";
import { actions } from "../../lib/services.server";
import { getViewer } from "../../lib/session.server";

/** One artifact of a run, for anyone who can see the run. */
export async function loader({ params, context }: Route.LoaderArgs) {
  const seen = await actions.run({ namespace: params.owner, name: params.repo }, getViewer(context), params.id);
  if (!seen.ok) throw new Response("Not found.", { status: 404 });
  const bytes = await readArtifact(params.id, params.name);
  if (!bytes) throw new Response("That artifact is gone: they are kept for 14 days.", { status: 404 });
  return new Response(bytes.buffer as ArrayBuffer, {
    headers: {
      "content-type": "application/gzip",
      "content-disposition": `attachment; filename="${params.name.replace(/"/g, "")}.tar.gz"`,
    },
  });
}
