import { redirectDocument, type MiddlewareFunction } from "react-router";
import { needsBuildRefresh } from "./build-version";
import { pageOf } from "./confirm-gate";

export const buildVersionMiddleware: MiddlewareFunction<Response> = async ({ request }, next) => {
  if (needsBuildRefresh(request, import.meta.env.G1T_BUILD_ID)) {
    const url = new URL(request.url);
    url.searchParams.delete("_routes");
    throw redirectDocument(pageOf(url.pathname) + url.search, { headers: { "cache-control": "no-store" } });
  }
  return next();
};
