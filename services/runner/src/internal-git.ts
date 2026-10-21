/**
 * A workflow job's clones and fetches from g1t.sh, taken over g1t's own
 * network rather than the public internet. The job runs the real
 * `actions/checkout`, and its git talks to https://g1t.sh as it would
 * anywhere: the remote, and the credential the action keeps in
 * `http.https://g1t.sh/.extraheader`, are the action's own. The sandbox's
 * HTTPS to g1t.sh passes this Worker (`git`, or `egress` for a job whose
 * requests all pass it; guard.ts), and a fetch is handed to the repos
 * service over its binding, as the website's front door hands it one
 * (apps/web workers/app.ts `proxyGit`). The repos service authorizes it
 * as any git request and answers it the way it answers every clone (from
 * the repository's git edge, or its store), and the answer streams back
 * as it comes: it is never read whole, as `forward` reads a replayable
 * answer of up to 8 MB.
 *
 * Only a fetch takes this path: git's smart HTTP for one repository, for
 * `git-upload-pack`, with credentials. Anything else to g1t.sh (a push, an
 * anonymous clone, which the front door counts by address, a page or a
 * package) goes on as it did. So does a fetch the repos service could not
 * answer (it could not be reached, or answered 5xx): it is sent again the
 * public way, so the internal path never fails a checkout that would
 * otherwise have worked.
 */

import { normalizeHost } from "./egress.ts";

/** The host whose git takes the internal path: the one jobs clone from. */
export const GIT_PUBLIC_HOST = "g1t.sh";

/** Whether `host` is g1t's own git host. */
export function isGitHost(host: string): boolean {
  return normalizeHost(host) === GIT_PUBLIC_HOST;
}

/** git's smart HTTP service a request is for, or null when it is not one. */
export type GitService = "git-upload-pack" | "git-receive-pack";

/**
 * Which smart HTTP service `url` is a request of, for one repository:
 * `/<namespace>/<name>[.git]/info/refs?service=git-upload-pack|git-receive-pack`,
 * `…/git-upload-pack` or `…/git-receive-pack`, as the repos service parses
 * it (git_http.rs). Null for anything else.
 */
export function gitService(url: URL): GitService | null {
  const parts = url.pathname.split("/").slice(1);
  const endpoint = parts.slice(-2).join("/") === "info/refs" ? "info/refs" : (parts.at(-1) ?? "");
  const repo = parts.slice(0, parts.length - endpoint.split("/").length);
  if (repo.length !== 2 || repo.some((part) => part === "" || part === "." || part === "..")) return null;
  const service = endpoint === "info/refs" ? url.searchParams.get("service") : endpoint;
  return service === "git-upload-pack" || service === "git-receive-pack" ? service : null;
}

/** Whether `request` takes the internal path: a signed-in fetch from g1t.sh. */
export function takesInternalPath(request: Request): boolean {
  const url = new URL(request.url);
  return isGitHost(url.host) && gitService(url) === "git-upload-pack" && request.headers.has("authorization");
}

/** The repos service's binding, which takes a request as it is (body and all). */
type Repos = { fetch(request: Request): Promise<Response> };

/**
 * Sends a job's request to g1t.sh on: a signed-in fetch to the repos
 * service over its binding, its answer (redirects too, which git follows
 * itself) streamed back; everything else, and a fetch the repos service
 * could not answer, with `onward`, the way it went before. Never throws
 * where `onward` does not.
 */
export async function viaRepos(request: Request, env: { REPOS?: object }, onward: (request: Request) => Promise<Response>): Promise<Response> {
  const repos = env.REPOS as Repos | undefined;
  if (!repos || !takesInternalPath(request)) return onward(request);
  // Held, so the request can be sent again the public way: a fetch's own
  // body is its wants and haves, small beside the pack it is answered with.
  const body = request.body === null ? null : await request.arrayBuffer();
  const again = () => new Request(request.url, { method: request.method, headers: request.headers, body, redirect: "manual" });
  const path = new URL(request.url).pathname;
  try {
    const answer = await repos.fetch(again());
    if (answer.status < 500) return answer;
    await answer.body?.cancel().catch(() => {});
    console.log("internal git answered", answer.status, request.method, path, "sent the public way");
  } catch (error) {
    console.log("internal git failed", request.method, path, "sent the public way", String(error));
  }
  return onward(again());
}
