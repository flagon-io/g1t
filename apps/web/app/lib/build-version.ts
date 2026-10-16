export const BUILD_HEADER = "x-g1t-build";

/** Only safe route reads can switch builds automatically; never replay writes. */
export function needsBuildRefresh(request: Request, build: string): boolean {
  const requested = request.headers.get(BUILD_HEADER);
  return request.method === "GET" && new URL(request.url).pathname.endsWith(".data") && requested !== null && requested !== build;
}
