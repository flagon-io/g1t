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
/** The Maven repositories: `/-/maven/<workspace>/`, in the standard layout, one per workspace. */
const MAVEN_PATH = /^\/-\/maven\//;
/** The NuGet feeds: `/-/nuget/<workspace>/v3/index.json` and what it names, one per workspace. */
const NUGET_PATH = /^\/-\/nuget\//;
/** The RubyGems registries: `/-/rubygems/<workspace>/`, the compact index and `gem push`, one per workspace. */
const RUBYGEMS_PATH = /^\/-\/rubygems\//;

const REGISTRY_PATHS = [REGISTRY_PATH, NPM_PATH, COMPOSER_PATH, CARGO_PATH, MAVEN_PATH, NUGET_PATH, RUBYGEMS_PATH];

export type ServicePath = "git" | "packages" | null;

export function servicePath(pathname: string): ServicePath {
  if (REGISTRY_PATHS.some((path) => path.test(pathname))) return "packages";
  if (GIT_PATH.test(pathname)) return "git";
  return null;
}

/**
 * The workspace a registry request names, and `under`, the same path under
 * another workspace: `/-/cargo/<workspace>/…` and the other per-workspace
 * registries, npm's `@<workspace>` scope, and a container image's first
 * segment. Null for a path that names none, such as `/v2/token`.
 */
export type RegistryWorkspace = { slug: string; under: (slug: string) => string };

const WORKSPACE_IN_PATH = [
  /^(\/-\/(?:composer|cargo|maven|nuget|rubygems)\/)([^/]+)(\/.*)?$/,
  /^(\/-\/npm\/(?:-\/package\/)?@)([^/%]+)((?:\/|%2[fF]).*)$/,
  /^(\/v2\/)([^/]+)(\/.+)$/,
];

export function registryWorkspace(pathname: string): RegistryWorkspace | null {
  for (const pattern of WORKSPACE_IN_PATH) {
    const match = pattern.exec(pathname);
    if (!match) continue;
    const [, before, slug, after = ""] = match;
    return { slug: slug!.toLowerCase(), under: (to) => `${before}${to}${after}` };
  }
  return null;
}
