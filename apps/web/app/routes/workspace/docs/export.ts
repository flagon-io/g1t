import { data } from "react-router";

import type { Route } from "./+types/export";
import { docs } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";
import { zip } from "../../../lib/zip";

/**
 * Docs as Markdown files: `?page=<id>` downloads a page as `<title>.md`;
 * `?space=<id>` downloads a space as a zip of its pages, in folders that
 * follow its tree. Only what the viewer can read.
 */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  const url = new URL(request.url);
  const page = url.searchParams.get("page");
  const space = url.searchParams.get("space");
  if (page) {
    const found = await docs.exportPage(slug, page, viewer);
    if (!found.ok) throw data(found.error.message, { status: found.error.code === "not_found" ? 404 : 403 });
    return new Response(found.value.markdown, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(found.value.filename)}`,
        "cache-control": "no-store",
      },
    });
  }
  if (space) {
    const found = await docs.exportSpace(slug, space, viewer);
    if (!found.ok) throw data(found.error.message, { status: found.error.code === "not_found" ? 404 : 403 });
    const encoder = new TextEncoder();
    const bytes = await zip(found.value.files.map((f) => ({ path: `${found.value.name}/${f.path}`, data: encoder.encode(f.markdown) })));
    return new Response(bytes, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${found.value.name}.zip"`,
        "cache-control": "no-store",
      },
    });
  }
  throw data("Which page or space?", { status: 400 });
}
