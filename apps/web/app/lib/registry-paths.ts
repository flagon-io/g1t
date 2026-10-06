/**
 * Which requests to g1t.sh belong to a service other than the site: git
 * over HTTPS (the repos service) and the package registries (the packages
 * service). `workers/app.ts` hands each to its binding as it is.
 */

const GIT_PATH = /\/(info\/refs|git-upload-pack|git-receive-pack)$/;
/** The container registry: OCI Distribution's `/v2/`, and its token endpoint at `/v2/token`. */
const REGISTRY_PATH = /^\/v2(?:\/|$)/;

export type ServicePath = "git" | "packages" | null;

export function servicePath(pathname: string): ServicePath {
  if (REGISTRY_PATH.test(pathname)) return "packages";
  if (GIT_PATH.test(pathname)) return "git";
  return null;
}
