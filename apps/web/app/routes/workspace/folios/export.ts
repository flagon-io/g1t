import { data } from "react-router";

import type { Route } from "./+types/export";
import { folios } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

/**
 * An artifact as a file: `?folio=<id>` downloads a doc as `<title>.md`
 * (`&format=json` for its agent form). `&inline=1` answers the text
 * itself, for "Copy as Markdown". Only what the viewer can read.
 */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const url = new URL(request.url);
  const id = url.searchParams.get("folio");
  if (!id) throw data("Which artifact?", { status: 400 });
  const format = url.searchParams.get("format") === "json" ? "json" : null;
  const found = await folios.export(params.owner.toLowerCase(), viewer, id, format);
  if (!found.ok) throw data(found.error.message, { status: found.error.code === "not_found" ? 404 : found.error.code === "forbidden" ? 403 : 422 });
  const inline = url.searchParams.get("inline") === "1";
  return new Response(found.value.body, {
    headers: {
      "content-type": found.value.content_type,
      ...(inline ? {} : { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(found.value.filename)}` }),
      "cache-control": "no-store",
    },
  });
}
