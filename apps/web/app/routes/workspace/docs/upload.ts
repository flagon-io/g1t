import { env } from "cloudflare:workers";
import { data } from "react-router";

import { DOCS_VIEWER_HEADER, DOC_MAX_FILE_BYTES } from "@g1t/contracts";

import type { Route } from "./+types/upload";
import { assertSameOrigin, requireUser, roleIn } from "../../../lib/session.server";

/**
 * A file put in a page (an image, a PDF, an attachment):
 * `POST <site>/<workspace>/-/docs/upload?page=<id>&name=<file name>` with
 * the file as the body. The docs service checks the viewer can edit the
 * page, keeps the file, and answers with its address on the usercontent
 * origin, where it is served, never on the site.
 */
export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const url = new URL(request.url);
  const length = Number(request.headers.get("content-length") ?? "0");
  if (!length || length > DOC_MAX_FILE_BYTES) {
    return Response.json({ ok: false, error: { code: "invalid", message: `Files can be up to ${DOC_MAX_FILE_BYTES / 1024 / 1024} MB.` } });
  }
  const target = new URL("https://docs/files");
  target.searchParams.set("workspace", params.owner.toLowerCase());
  target.searchParams.set("page", url.searchParams.get("page") ?? "");
  target.searchParams.set("name", url.searchParams.get("name") ?? "file");
  try {
    const answer = await env.DOCS.fetch(target.toString(), {
      method: "PUT",
      headers: {
        "content-type": request.headers.get("content-type") ?? "application/octet-stream",
        "content-length": String(length),
        [DOCS_VIEWER_HEADER]: JSON.stringify(viewer),
      },
      body: request.body,
    });
    return new Response(answer.body, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch (error) {
    console.error("docs: upload", error);
    return Response.json({ ok: false, error: { code: "conflict", message: "Docs didn't answer. Try again." } });
  }
}
