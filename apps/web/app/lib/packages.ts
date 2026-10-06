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
export function installCommands(pkg: Pick<PackageSummary, "ecosystem" | "address" | "name" | "workspace">, version: string | null, you: string): { login: string; install: string } {
  const host = registryHost(pkg.address);
  switch (pkg.ecosystem) {
    case "container":
      return {
        login: `docker login ${host} -u ${you}`,
        install: `docker pull ${pkg.address}${version ? `:${version}` : ""}`,
      };
    case "npm":
      return {
        login: `npm config set @${pkg.workspace}:registry https://${host}/-/npm/`,
        install: `npm install @${pkg.workspace}/${pkg.name}${version ? `@${version}` : ""}`,
      };
    case "composer":
      return {
        login: `composer config repositories.${pkg.workspace} composer https://${host}/-/composer/${pkg.workspace}/`,
        install: `composer require ${pkg.name}${version ? `:${version}` : ""}`,
      };
    case "cargo":
      return {
        login: `cargo login --registry ${pkg.workspace}`,
        install: `cargo add ${pkg.name} --registry ${pkg.workspace}${version ? ` --vers ${version}` : ""}`,
      };
    case "go":
      return {
        login: `go env -w GOPRIVATE=${host}/${pkg.workspace}`,
        install: `go get ${pkg.address}${version ? `@${version}` : ""}`,
      };
  }
}
