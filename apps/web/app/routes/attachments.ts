/**
 * An image pasted, dropped or chosen in a comment box (components/attach-images.tsx):
 * `POST /-/attachments?repo=<owner>/<name>&name=<file name>`, or
 * `?workspace=<slug>&number=<n>` for a work item, with the file as the
 * body. The work service checks the viewer may comment there and keeps it
 * (`upload_attachment`); the answer is its address on the usercontent
 * origin, where it is served, never on the site. An attachment's address is
 * 256 random bits, so a private repository's is seen only by whoever is
 * given its Markdown.
 */
import type { Route } from "./+types/attachments";
import { addresses } from "../lib/addresses.server";
import { MAX_ATTACHMENT_BYTES, imageMarkdown } from "../lib/attachments";
import { sniffImage, toBase64 } from "../lib/avatar-upload";
import { work } from "../lib/services.server";
import { assertSameOrigin, getViewer } from "../lib/session.server";

type Answer = { ok: true; url: string; markdown: string; name: string } | { ok: false; error: { code: string; message: string } };

const refused = (code: string, message: string, status: number) =>
  Response.json({ ok: false, error: { code, message } } satisfies Answer, { status, headers: { "cache-control": "no-store" } });

export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  // A fetch, not a page: an answer to say, never the sign-in page.
  const user = getViewer(context);
  if (!user) return refused("unauthenticated", "Sign in to attach images.", 401);
  const url = new URL(request.url);
  const repo = (url.searchParams.get("repo") ?? "").split("/");
  const workspace = url.searchParams.get("workspace") ?? "";
  const number = Number(url.searchParams.get("number"));
  const scope =
    repo.length === 2 && repo[0] && repo[1]
      ? { repo: { namespace: repo[0], name: repo[1] } }
      : workspace && Number.isInteger(number) && number > 0
        ? { workspace: workspace.toLowerCase(), number }
        : null;
  if (!scope) return refused("invalid", "Say which repository or work item it is for.", 400);
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_ATTACHMENT_BYTES) return refused("too_large", "An attachment can be at most 10 MB.", 413);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) return refused("invalid", "The file is empty.", 400);
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) return refused("too_large", "An attachment can be at most 10 MB.", 413);
  // The service reads the type from the bytes again and is the one that decides.
  if (!sniffImage(bytes)) return refused("unsupported_type", "An attachment must be a PNG, JPEG, GIF or WebP image.", 415);
  const name = url.searchParams.get("name") || "image.png";
  try {
    const kept = await work.uploadAttachment(user, scope, { name, data: toBase64(bytes) });
    if (!kept.ok) {
      const status = kept.error.code === "too_large" ? 413 : kept.error.code === "unsupported_type" ? 415 : kept.error.code === "not_found" ? 404 : 403;
      return refused(kept.error.code, kept.error.message, status);
    }
    const at = `${addresses().usercontent}${kept.value.path}`;
    return Response.json({ ok: true, url: at, markdown: imageMarkdown(kept.value.name, at), name: kept.value.name } satisfies Answer, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    console.error("attachments: upload", error);
    return refused("unavailable", "The image didn't upload. Try again in a moment.", 503);
  }
}
