/**
 * Words and commands for the Packages pages: sizes, digests, and how each
 * registry's own tool logs in and installs.
 */
import type { Ecosystem, PackageSummary } from "@g1t/contracts";

/** What each registry is called on the pages. */
export const ECOSYSTEM_LABEL: Record<Ecosystem, string> = {
  container: "Container",
  npm: "npm",
  composer: "Composer",
  cargo: "Cargo",
  go: "Go",
};

/**
 * Each registry as the Packages page introduces it: what it is for, the
 * command that starts one, its guide, and whether it is open yet.
 */
export const REGISTRIES: { ecosystem: Ecosystem; blurb: string; start: string; guide: string; ready: boolean }[] = [
  {
    ecosystem: "container",
    blurb: "Docker and OCI images, signatures and attestations, pulled by anyone the image's repository lets read it.",
    start: "docker push g1t.sh/<workspace>/<name>:<tag>",
    guide: "/guides/containers/",
    ready: true,
  },
  {
    ecosystem: "npm",
    blurb: "JavaScript and TypeScript packages under the workspace's scope, installed with npm, pnpm or yarn.",
    start: "npm publish",
    guide: "/guides/npm/",
    ready: true,
  },
  {
    ecosystem: "composer",
    blurb: "PHP packages straight from the workspace's repositories: each tag is a version, nothing to upload.",
    start: "git tag v1.0.0 && git push --tags",
    guide: "/guides/composer/",
    ready: true,
  },
  {
    ecosystem: "cargo",
    blurb: "Rust crates in a sparse registry of the workspace's own, published with cargo publish and added with cargo add.",
    start: "cargo publish --registry <workspace>",
    guide: "/guides/cargo/",
    ready: true,
  },
  {
    ecosystem: "go",
    blurb: "Go modules fetched from the repositories themselves with go get, private ones with a token.",
    start: "go get g1t.sh/<workspace>/<repo>",
    guide: "/guides/go/",
    ready: true,
  },
];

export type PackageSort = "updated" | "downloads" | "name";
export type VisibilityFilter = "all" | "public" | "private";

export const SORT_LABEL: Record<PackageSort, string> = {
  updated: "Recently updated",
  downloads: "Most downloads",
  name: "Name",
};

export const VISIBILITY_LABEL: Record<VisibilityFilter, string> = { all: "All", public: "Public", private: "Private" };

/** The packages to list: those of the visibility asked for, in the order asked for. */
export function arrange<T extends Pick<PackageSummary, "visibility" | "updated_at" | "downloads" | "name">>(
  list: T[],
  visibility: VisibilityFilter,
  sort: PackageSort,
): T[] {
  const shown = visibility === "all" ? [...list] : list.filter((pkg) => pkg.visibility === visibility);
  const byName = (a: T, b: T) => a.name.localeCompare(b.name);
  if (sort === "name") return shown.sort(byName);
  if (sort === "downloads") return shown.sort((a, b) => b.downloads - a.downloads || byName(a, b));
  return shown.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || byName(a, b));
}

/** "940", "16.1k", "2.3M": download counts, short. */
export function shortCount(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`;
  if (n >= 1_000) return `${Number((n / 1_000).toFixed(1))}k`;
  return String(Math.max(0, Math.round(n)));
}

/** "0 B", "812 KB", "12.3 MB", "1.4 GB", in powers of 1,000 as registries show them. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  const shown = unit === 0 || value >= 100 ? Math.round(value) : Number(value.toFixed(1));
  return `${shown} ${units[unit]}`;
}

/** `sha256:3f2a…` shortened to `3f2a9c1b7d0e` for lists. */
export function shortDigest(digest: string): string {
  return digest.replace(/^sha256:/, "").slice(0, 12);
}

/** The host packages are published to and installed from. */
export function registryHost(address: string): string {
  return address.split("/")[0] || "g1t.sh";
}

/**
 * How to log in and install `pkg` at `version` (a tag or version) with its
 * tool. `you` stands in the username a login takes.
 */
export function installCommands(
  pkg: Pick<PackageSummary, "ecosystem" | "address" | "name" | "workspace">,
  version: string | null,
  you: string,
): { login: string; install: string; registry?: string } {
  const host = registryHost(pkg.address);
  switch (pkg.ecosystem) {
    case "container":
      return {
        login: `docker login ${host} -u ${you}`,
        install: `docker pull ${pkg.address}${version ? `:${version}` : ""}`,
      };
    case "npm":
      // The scope's registry (in .npmrc, needed for any install), then the
      // token a private package also needs.
      return {
        registry: `npm config set @${pkg.workspace}:registry=https://${host}/-/npm/`,
        login: `npm config set //${host}/-/npm/:_authToken=YOUR_TOKEN`,
        install: `npm install @${pkg.workspace}/${pkg.name}${version ? `@${version}` : ""}`,
      };
    case "composer":
      // The workspace's repository (in composer.json, needed for any
      // install), then the credentials a private package also needs.
      return {
        registry: `composer config repositories.${pkg.workspace} composer https://${host}/-/composer/${pkg.workspace}/`,
        login: `composer config --global --auth http-basic.${host} ${you} YOUR_TOKEN`,
        install: `composer require ${pkg.name}${version ? `:${version}` : ""}`,
      };
    case "cargo":
      // The workspace's registry (in .cargo/config.toml, needed for any
      // install), then the token a private crate also needs, which cargo
      // login asks for.
      return {
        registry: `mkdir -p .cargo && printf '[registries.${pkg.workspace}]\\nindex = "sparse+https://${host}/-/cargo/${pkg.workspace}/index/"\\ncredential-provider = "cargo:token"\\n' >> .cargo/config.toml`,
        login: `cargo login --registry ${pkg.workspace}`,
        install: `cargo add ${pkg.name}${version ? `@${version}` : ""} --registry ${pkg.workspace}`,
      };
    case "go":
      return {
        login: `go env -w GOPRIVATE=${host}/${pkg.workspace}`,
        install: `go get ${pkg.address}${version ? `@${version}` : ""}`,
      };
  }
}
