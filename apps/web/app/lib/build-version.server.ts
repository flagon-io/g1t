import { redirectDocument, type MiddlewareFunction } from "react-router";
import { BUILD_HEADER, needsBuildRefresh } from "./build-version";
import { pageOf } from "./confirm-gate";

export const buildVersionMiddleware: MiddlewareFunction<Response> = async ({ request }, next) => {
  if (needsBuildRefresh(request, import.meta.env.G1T_BUILD_ID)) {
    const url = new URL(request.url);
    url.searchParams.delete("_routes");
    throw redirectDocument(pageOf(url.pathname) + url.search, { headers: { "cache-control": "no-store" } });
  }
  const response = await next();
  // Which build answered, so a tab running an older one knows it is out of
  // date even from a background refresh (lib/resilient-fetch.ts).
  if (new URL(request.url).pathname.endsWith(".data")) {
    try {
      response.headers.set(BUILD_HEADER, import.meta.env.G1T_BUILD_ID);
    } catch {
      // A redirect's headers cannot be changed; it says nothing about the build.
    }
  }
  return response;
};
