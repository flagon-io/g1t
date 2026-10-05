import { renderToReadableStream } from "react-dom/server";
import { type EntryContext, ServerRouter } from "react-router";

/**
 * Renders the whole page before sending it. sudo ships no JavaScript, so
 * there is nothing to stream into and no inline script to allow.
 */
export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
) {
  let status = responseStatusCode;
  const body = await renderToReadableStream(<ServerRouter context={routerContext} url={request.url} />, {
    signal: request.signal,
    onError(error: unknown) {
      status = 500;
      console.error(error);
    },
  });
  await body.allReady;
  responseHeaders.set("content-type", "text/html; charset=utf-8");
  return new Response(body, { headers: responseHeaders, status });
}
