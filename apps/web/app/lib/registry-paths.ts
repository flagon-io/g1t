/**
 * Which requests to g1t.sh belong to a service other than the site: git
 * over HTTPS (the repos service) and the package registries (the packages
 * service). `workers/app.ts` hands each to its binding as it is.
 */

const GIT_PATH = /\/(info\/refs|git-upload-pack|git-receive-pack)$/;
/** The container registry: OCI Distribution's `/v2/`, and its token endpoint at `/v2/token`. */
const REGISTRY_PATH = /^\/v2(?:\/|$)/;
/** The npm registry: `/-/npm/`, which `.npmrc` names for a workspace's scope. */
const NPM_PATH = /^\/-\/npm(?:\/|$)/;
/** The Composer registries: `/-/composer/<workspace>/`, one per workspace. */
const COMPOSER_PATH = /^\/-\/composer\//;
/** The Cargo registries: `/-/cargo/<workspace>/`, a sparse index and its web API, one per workspace. */
const CARGO_PATH = /^\/-\/cargo\//;

export type ServicePath = "git" | "packages" | null;

export function servicePath(pathname: string): ServicePath {
  if (REGISTRY_PATH.test(pathname) || NPM_PATH.test(pathname) || COMPOSER_PATH.test(pathname) || CARGO_PATH.test(pathname)) return "packages";
  if (GIT_PATH.test(pathname)) return "git";
  return null;
}
