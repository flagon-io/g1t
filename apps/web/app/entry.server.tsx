import type { EntryContext, RouterContextProvider, ServerInstrumentation } from "react-router";
import { ServerRouter } from "react-router";
import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";

import { NonceContext } from "./lib/nonce";
import { makeNonce, pagePolicy } from "./lib/page-headers";
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

  // The page's inline scripts carry this nonce, and its policy allows only
  // them (lib/page-headers.ts). Not in development, where Vite adds its own.
  const nonce = import.meta.env.DEV ? undefined : makeNonce();
  const body = await renderToReadableStream(
    <NonceContext value={nonce}>
      <ServerRouter context={routerContext} url={request.url} nonce={nonce} />
    </NonceContext>,
    {
      nonce,
      signal: AbortSignal.timeout(streamTimeout + 1000),
      onError(error: unknown) {
        responseStatusCode = 500;
        // Errors while streaming after the shell; those in the shell reject
        // and are logged by React Router.
        if (shellRendered) {
          console.error(error);
        }
      },
    },
  );
  shellRendered = true;

  // Crawlers get the whole page at once, deferred panels included.
  if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) {
    await body.allReady;
  }

  responseHeaders.set("Content-Type", "text/html");
  if (nonce) responseHeaders.set("Content-Security-Policy", pagePolicy(nonce));
  return new Response(body, {
    headers: responseHeaders,
    status: responseStatusCode,
  });
}
