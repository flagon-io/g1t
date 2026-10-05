import { RouterContextProvider, createRequestHandler } from "react-router";

import { authorize, isSameOrigin, readSettings } from "../app/lib/access";
import { denied, secure } from "../app/lib/guard";
import { staffContext } from "../app/lib/staff";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

/** Files the build emits for the pages; still behind the same check. */
const ASSET = /^\/(?:assets\/[\w.-]+|favicon\.svg)$/;

/**
 * Every request, assets included, passes the same gate before anything
 * is served:
 *
 * 1. sudo is configured, or nothing is served at all;
 * 2. Cloudflare Access's token verifies (signature, audience, issuer, time);
 * 3. its email is on the staff list;
 * 4. a change is a POST from sudo's own pages.
 */
async function handle(request: Request, env: Env): Promise<Response> {
  const settings = readSettings(env);
  if (!settings) {
    return denied(
      403,
      "sudo is not configured",
      "ACCESS_TEAM_DOMAIN, ACCESS_AUD and STAFF_EMAILS must all be set before sudo will answer. See apps/sudo/README.md.",
    );
  }

  const auth = await authorize(request, settings);
  if (!auth.ok) {
    console.warn(JSON.stringify({ event: "sudo.denied", reason: auth.reason, email: auth.email ?? null, path: new URL(request.url).pathname }));
    return auth.reason === "not staff"
      ? denied(403, "Not staff", `${auth.email} is signed in, but is not on sudo's staff list.`)
      : denied(403, "Not allowed", "sudo is for g1t staff, signed in through Cloudflare Access.");
  }

  const { method } = request;
  if (method !== "GET" && method !== "HEAD" && method !== "POST") {
    return denied(405, "Method not allowed", "sudo takes GET and POST only.");
  }
  if (method === "POST" && !isSameOrigin(request)) {
    console.warn(JSON.stringify({ event: "sudo.cross_site", email: auth.email, origin: request.headers.get("origin") }));
    return denied(403, "Refused", "Changes are only accepted from sudo's own pages.");
  }

  const { pathname } = new URL(request.url);
  if (method !== "POST" && ASSET.test(pathname)) {
    return env.ASSETS.fetch(request);
  }

  if (method === "POST") {
    console.log(JSON.stringify({ event: "sudo.change", email: auth.email, path: pathname }));
  }
  const context = new RouterContextProvider();
  context.set(staffContext, { email: auth.email });
  return requestHandler(request, context);
}

export default {
  async fetch(request, env) {
    return secure(await handle(request, env));
  },
} satisfies ExportedHandler<Env>;
