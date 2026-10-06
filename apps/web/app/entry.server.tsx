import type { EntryContext, RouterContextProvider, ServerInstrumentation } from "react-router";
import { ServerRouter } from "react-router";
import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";

import { recordHandler } from "./lib/perf.server";

// React Router's own server entry, plus the timing of every loader and
// action for the Server-Timing header (lib/perf.server.ts).

export const streamTimeout = 5_000;

export const instrumentations: ServerInstrumentation[] = [
  {
    route(route) {
      route.instrument({
        async loader(handle) {
          const started = Date.now();
          await handle();
          recordHandler(route.id, "loader", Date.now() - started);
        },
        async action(handle) {
          const started = Date.now();
          await handle();
          recordHandler(route.id, "action", Date.now() - started);
        },
      });
    },
  },
];

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  _loadContext: RouterContextProvider,
) {
  // https://httpwg.org/specs/rfc9110.html#HEAD
  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, {
      status: responseStatusCode,
      headers: responseHeaders,
    });
  }

  let shellRendered = false;
  const userAgent = request.headers.get("user-agent");

  const body = await renderToReadableStream(<ServerRouter context={routerContext} url={request.url} />, {
    signal: AbortSignal.timeout(streamTimeout + 1000),
    onError(error: unknown) {
      responseStatusCode = 500;
      // Errors while streaming after the shell; those in the shell reject
      // and are logged by React Router.
      if (shellRendered) {
        console.error(error);
      }
    },
  });
  shellRendered = true;

  // Crawlers get the whole page at once, deferred panels included.
  if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) {
    await body.allReady;
  }

  responseHeaders.set("Content-Type", "text/html");
  return new Response(body, {
    headers: responseHeaders,
    status: responseStatusCode,
  });
}
