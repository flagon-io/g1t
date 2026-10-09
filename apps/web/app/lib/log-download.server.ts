/** Answers for the log downloads: a file to save, or why there is none. */

import { contentDisposition } from "./content-safety";

export function refused(status: number, message: string): Response {
  return new Response(`${message}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

export function attachment(body: BodyInit, type: string, file: string): Response {
  return new Response(body, {
    headers: {
      "content-type": type,
      "content-disposition": contentDisposition(file),
      "cache-control": "no-store",
    },
  });
}
