import {
  type GitService,
  type IdentityApi,
  type RepoPath,
  type ReposApi,
  type Viewer,
  httpStatus,
} from "@g1t/contracts";

const GIT_ROUTE =
  /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const FORWARDED_HEADERS = [
  "accept",
  "content-encoding",
  "content-type",
  "git-protocol",
  "user-agent",
];

async function viewerFromBasicAuth(
  request: Request,
  identity: IdentityApi,
): Promise<Viewer> {
  const [scheme, encoded] = (request.headers.get("authorization") ?? "").split(" ");
  if (scheme?.toLowerCase() !== "basic" || !encoded) return null;
  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    return null;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return null;
  return identity.userForGitCredentials(
    decoded.slice(0, separator),
    decoded.slice(separator + 1),
  );
}

/**
 * Smart HTTP git remote at `/<namespace>/<repo>.git`, proxied to the git
 * store with a short-lived token. Returns null for requests that are not git.
 */
export async function handleGitHttp(
  request: Request,
  identity: IdentityApi,
  repos: Pick<ReposApi, "gitAccess">,
  onPush: (path: RepoPath) => void,
): Promise<Response | null> {
  const url = new URL(request.url);
  const match = GIT_ROUTE.exec(url.pathname);
  if (!match) return null;
  const [, namespace, name, endpoint] = match;
  const service =
    endpoint === "info/refs" ? url.searchParams.get("service") : endpoint;
  if (service !== "git-upload-pack" && service !== "git-receive-pack") {
    return null;
  }

  const viewer = await viewerFromBasicAuth(request, identity);
  const access = await repos.gitAccess(
    { namespace, name },
    viewer,
    service as GitService,
  );
  if (!access.ok) {
    const status = httpStatus(access.error);
    return new Response(`${access.error.message}\n`, {
      status,
      headers: status === 401 ? { "www-authenticate": 'Basic realm="g1t"' } : {},
    });
  }

  const headers = new Headers({ authorization: `Bearer ${access.value.token}` });
  for (const header of FORWARDED_HEADERS) {
    const value = request.headers.get(header);
    if (value) headers.set(header, value);
  }
  const response = await fetch(`${access.value.remote}/${endpoint}${url.search}`, {
    method: request.method,
    headers,
    body: request.body,
  });
  if (endpoint === "git-receive-pack" && response.ok) {
    onPush({ namespace, name });
  }
  return response;
}
