/**
 * Words and links for a project that is a library or a tool rather than an
 * app: which of its repository's packages to show, and how to publish a
 * first one. Whether a project is one is decided by the projects service
 * (`Project.kind`); this only says it on the pages.
 */
import type { DeploysSetting, Ecosystem, PackageSummary, ProjectEcosystem } from "@g1t/contracts";

/** As lib/packages.ts names each registry; repeated so this module stands alone in tests. */
const REGISTRY: Record<Ecosystem, string> = {
  container: "Container",
  npm: "npm",
  composer: "Composer",
  cargo: "Cargo",
  go: "Go",
  maven: "Maven",
  nuget: "NuGet",
  rubygems: "RubyGems",
};

const DOCS = "https://docs.g1t.sh";

/** The choices for "Deployments for this project" in a project's settings. */
export const DEPLOYS_CHOICES: { value: DeploysSetting; label: string; hint: string }[] = [
  { value: "auto", label: "Detect automatically", hint: "From whether Deployments are on, the packages it publishes and the files at its root." },
  { value: "yes", label: "Deploys", hint: "An app: its overview shows production, previews and domains." },
  { value: "no", label: "Doesn't deploy", hint: "A library or a tool: its overview shows its packages and releases, and offers no deploying." },
];

/** A registry's guide, and the command that publishes a first version there. */
export type PublishGuide = { label: string; guide: string; start: string | null };

/** The registries with a guide, for a library whose files do not say which it is. */
export const PUBLISH_GUIDES: PublishGuide[] = [
  { label: "Composer", guide: `${DOCS}/guides/composer/`, start: "git tag v1.0.0 && git push --tags" },
  { label: "npm", guide: `${DOCS}/guides/npm/`, start: "npm publish" },
  { label: "Go", guide: `${DOCS}/guides/go/`, start: "git tag v1.0.0 && git push --tags" },
  { label: "Containers", guide: `${DOCS}/guides/containers/`, start: null },
];

/** How a library of `ecosystem` publishes its first version; null when its files do not say. */
export function publishGuide(ecosystem: ProjectEcosystem | null): PublishGuide | null {
  switch (ecosystem) {
    case "composer":
      return PUBLISH_GUIDES[0]!;
    case "npm":
      return PUBLISH_GUIDES[1]!;
    case "go":
      return PUBLISH_GUIDES[2]!;
    case "cargo":
      return { label: "Cargo", guide: `${DOCS}/guides/packages/`, start: null };
    case "python":
      return { label: "Python", guide: `${DOCS}/guides/packages/`, start: null };
    default:
      return null;
  }
}

/** A package as its own tool names it: `@acme/ui` for npm, the name otherwise. */
export function packageName(pkg: Pick<PackageSummary, "ecosystem" | "name" | "workspace">): string {
  return pkg.ecosystem === "npm" ? `@${pkg.workspace}/${pkg.name}` : pkg.name;
}

/** `Composer · psr/log 3.0.2`, for a project's card. */
export function packageLine(pkg: Pick<PackageSummary, "ecosystem" | "name" | "workspace" | "latest">): string {
  return `${REGISTRY[pkg.ecosystem]} · ${packageName(pkg)}${pkg.latest ? ` ${pkg.latest}` : ""}`;
}

/** The package's page. */
export function packagePath(pkg: Pick<PackageSummary, "ecosystem" | "name" | "workspace">): string {
  return `/${pkg.workspace}/-/packages/${pkg.ecosystem}/${pkg.name}`;
}

/**
 * The packages a library's overview shows, from its repository's: what it
 * publishes for others to install first, a container image last, as an
 * image is how apps ship too.
 */
export function libraryPackages<T extends Pick<PackageSummary, "ecosystem" | "versions" | "updated_at">>(list: T[]): T[] {
  return [...list].sort(
    (a, b) =>
      Number(a.ecosystem === "container") - Number(b.ecosystem === "container") ||
      Number(b.versions > 0) - Number(a.versions > 0) ||
      b.updated_at.localeCompare(a.updated_at),
  );
}

/** Whether any of the packages has a version: a release is out. */
export function hasRelease(list: Pick<PackageSummary, "versions">[]): boolean {
  return list.some((pkg) => pkg.versions > 0);
}
