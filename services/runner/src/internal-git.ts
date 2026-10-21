/**
 * Git from inside a workflow job's sandbox, without the public internet:
 * the runner's native `actions/checkout` (crates/runner actions/checkout.rs)
 * fetches from `GIT_INTERNAL_URL`, and the sandbox's outbound handler for
 * `GIT_HOST` hands the request to the repos service over its binding, as
 * the website's front door hands it a clone from g1t.sh. The repos service
 * authorizes it as any git request and answers it the way it answers
 * every clone (from the repository's git edge, or its store). The answer
 * streams back as it comes: it is never read whole, as `forward` reads a
 * replayable answer of up to 8 MB.
 *
 * Only git's smart HTTP reaches it, and only with credentials: an
 * anonymous clone goes through the front door, which counts it by address.
 */

import { normalizeHost } from "./egress.ts";

/** The host a sandbox's git reaches the repos service at. It never leaves the machine. */
export const GIT_HOST = "git.g1t.internal";
/** The base the runner fetches from (`G1T_GIT_INTERNAL`): plain HTTP, as nothing it carries leaves Cloudflare. */
export const GIT_INTERNAL_URL = `http://${GIT_HOST}`;

/** What the runner is told when its sandbox's git can take the internal path. */
export const GIT_INTERNAL_ENV: Record<string, string> = { G1T_GIT_INTERNAL: GIT_INTERNAL_URL };

/** Whether `host` is the internal git host. */
export function isGitHost(host: string): boolean {
  return normalizeHost(host) === GIT_HOST;
}

/**
 * Whether `url` is a request of git's smart HTTP for one repository:
 * `/<namespace>/<name>[.git]/info/refs?service=git-upload-pack|git-receive-pack`,
 * `…/git-upload-pack` or `…/git-receive-pack`, as the repos service
 * parses it (git_http.rs).
 */
export function isGitRequest(url: URL): boolean {
  const parts = url.pathname.split("/").slice(1);
  const endpoint = parts.slice(-2).join("/") === "info/refs" ? "info/refs" : (parts.at(-1) ?? "");
  const repo = parts.slice(0, parts.length - endpoint.split("/").length);
  if (repo.length !== 2 || repo.some((part) => part === "" || part === "." || part === "..")) return false;
  if (endpoint === "info/refs") {
    const service = url.searchParams.get("service");
    return service === "git-upload-pack" || service === "git-receive-pack";
  }
  return endpoint === "git-upload-pack" || endpoint === "git-receive-pack";
}

/** A plain-text refusal, which git shows the job's log. */
function refuse(status: number, message: string): Response {
  return new Response(`g1t: ${message}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "x-g1t-egress": "internal-git" },
  });
}

/**
 * The outbound handler for `GIT_HOST`: a sandbox's git request, handed to
 * the repos service as it came (its redirects too, which git follows
 * itself) and its answer streamed back. Anything else at that host is
 * refused; the runner then fetches from g1t.sh instead. Never throws.
 */
export async function internalGit(request: Request, env: { REPOS?: object }): Promise<Response> {
  const url = new URL(request.url);
  // The binding is a Fetcher, which takes the request as it is (body and all).
  const repos = env.REPOS as { fetch(request: Request): Promise<Response> } | undefined;
  if (!repos) return refuse(503, "git over the internal path is not set up here.");
  if (!isGitRequest(url)) return refuse(404, `${url.pathname} is not a git request.`);
  if (!request.headers.has("authorization")) return refuse(401, "git over the internal path needs the job's token.");
  try {
    return await repos.fetch(new Request(request, { redirect: "manual" }));
  } catch (error) {
    console.log("internal git failed", request.method, url.pathname, String(error));
    return refuse(502, `the repos service could not be reached: ${error instanceof Error ? error.message : String(error)}`);
  }
}
