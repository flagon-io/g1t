import { renderToReadableStream } from "react-dom/server";
import { type EntryContext, ServerRouter } from "react-router";

import { makeNonce, pagePolicy } from "./lib/guard";

/**
 * Renders the whole page before sending it, then the browser hydrates it.
 * The page runs only sudo's own scripts: React Router writes its inline
 * scripts and preloads with this page's nonce (ServerRouter hands it to
 * <Links>, <Scripts> and <ScrollRestoration>), and the page's policy
 * names that nonce and nothing else (lib/guard.ts). workers/app.ts keeps
 * the policy set here.
 */
export default async function handleRequest(request: Request, responseStatusCode: number, responseHeaders: Headers, routerContext: EntryContext) {
  let status = responseStatusCode;
  const nonce = makeNonce();
  const body = await renderToReadableStream(<ServerRouter context={routerContext} url={request.url} nonce={nonce} />, {
    nonce,
    signal: request.signal,
    onError(error: unknown) {
      status = 500;
      console.error(error);
    },
  });
  await body.allReady;
  responseHeaders.set("content-type", "text/html; charset=utf-8");
  responseHeaders.set("content-security-policy", pagePolicy(nonce));
  return new Response(body, { headers: responseHeaders, status });
}
