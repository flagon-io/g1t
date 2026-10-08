/**
 * Words and links for a project that is a library or a tool rather than an
 * app: which of its repository's packages to show, and how to publish a
 * first one. Whether a project is one is decided by the projects service
 * (`Project.kind`); this only says it on the pages.
 */
import type {
  Ecosystem,
  PackageSummary,
  Project,
  ProjectChanges,
  ProjectEcosystem,
  ProjectKind,
  ProjectLinks,
  ProjectRuns,
  ProjectSetting,
} from "@g1t/contracts";

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

/** One choice of what a project is, as its settings and overview offer it. */
export type KindChoice = "auto" | "g1t" | "elsewhere" | "library" | "tool" | "docs" | "other";

/** What each choice sets: a kind and where it runs, `auto` for what is left to detection. */
export const KIND_CHOICE_SETS: Record<KindChoice, { kind: ProjectKind | "auto"; runs: ProjectRuns | "auto" }> = {
  auto: { kind: "auto", runs: "auto" },
  g1t: { kind: "app", runs: "g1t" },
  elsewhere: { kind: "app", runs: "elsewhere" },
  library: { kind: "library", runs: "auto" },
  tool: { kind: "tool", runs: "auto" },
  docs: { kind: "docs", runs: "auto" },
  other: { kind: "other", runs: "auto" },
};

/** The choices for "What it is" in a project's settings, in order. */
export const KIND_CHOICES: { value: KindChoice; label: string; hint: string }[] = [
  { value: "auto", label: "Detect automatically", hint: "From whether Deployments are on, the packages it publishes and the files at its root." },
  { value: "g1t", label: "App or site, deployed on g1t", hint: "g1t builds it: production on g1t.page from the default branch, and a preview for every pull request." },
  {
    value: "elsewhere",
    label: "App or site, deployed elsewhere",
    hint: "Your own pipeline deploys it. Its overview shows production at the address you give.",
  },
  { value: "library", label: "Library or package", hint: "Installed by other code: its overview shows its packages and releases." },
  { value: "tool", label: "Tool or CLI", hint: "Installed and run by people: its overview shows its releases and packages." },
  { value: "docs", label: "Documentation", hint: "Docs or site content: its overview shows where they are read." },
  { value: "other", label: "Something else", hint: "Configuration, research, notes: its overview shows its links and its work." },
];

/** The choice a project's setting is; null when it is one no choice makes (set through the API). */
export function choiceOf(setting: ProjectSetting): KindChoice | null {
  if (!setting.kind && !setting.runs) return "auto";
  if (setting.kind && setting.kind !== "app") return setting.kind;
  if (setting.runs) return setting.runs;
  return null;
}

/** Whether it is set to be something that never deploys: a library, a tool or other. */
export function neverDeploys(project: Pick<Project, "setting">): boolean {
  const kind = project.setting?.kind;
  return kind != null && kind !== "app" && kind !== "docs";
}

/** What a project is, in a word or three, for its badge. */
export function kindLabel(project: Pick<Project, "kind" | "runs">): string {
  switch (project.kind) {
    case "app":
      return project.runs === "g1t" ? "App on g1t" : project.runs === "elsewhere" ? "App, deployed elsewhere" : "App";
    case "library":
      return "Library";
    case "tool":
      return "Tool";
    case "docs":
      return project.runs === "g1t" ? "Docs on g1t" : "Docs";
    default:
      return "Project";
  }
}

/** A link as pages list it: what it is, its label and address. */
export type ShownLink = { key: string; type: "homepage" | "docs" | "production" | "custom"; label: string; url: string };

/** An address without its scheme, or a trailing slash: `g1t.sh/docs`. */
export function bare(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

/**
 * A project's links in the order pages show them: its homepage, its docs,
 * then the rest. An address already shown elsewhere on the page (such as
 * production's) is given in `shown` and left out, so nothing is listed twice.
 */
export function linksToShow(links: ProjectLinks, shown: (string | null | undefined)[] = []): ShownLink[] {
  const seen = new Set(shown.filter((url): url is string => !!url).map((url) => bare(url).toLowerCase()));
  const out: ShownLink[] = [];
  const add = (link: ShownLink) => {
    const key = bare(link.url).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(link);
  };
  if (links.homepage) add({ key: "homepage", type: "homepage", label: bare(links.homepage), url: links.homepage });
  if (links.docs) add({ key: "docs", type: "docs", label: "Docs", url: links.docs });
  links.custom.forEach((link, index) => add({ key: `custom:${index}`, type: "custom", label: link.label, url: link.url }));
  return out;
}

/**
 * The one address a project's card or row shows: production as g1t
 * serves it (`live`, from Deployments), production deployed elsewhere,
 * then its homepage, then its docs. Null when it has none.
 */
export function primaryLink(project: Pick<Project, "runs" | "productionUrl" | "links">, live: string | null | undefined): string | null {
  if (project.runs === "g1t" && live) return live;
  if (project.runs === "elsewhere" && project.productionUrl) return project.productionUrl;
  return live ?? project.links?.homepage ?? project.links?.docs ?? null;
}

/**
 * The change a form on the overview asks for: only the fields it carries.
 * `choice` sets what it is and where it runs; `links` says its rows are the
 * whole list of other links, so a form with every row removed clears them.
 */
export function projectChanges(form: Pick<FormData, "get" | "getAll" | "has">): ProjectChanges {
  const changes: ProjectChanges = {};
  const choice = form.get("choice");
  if (typeof choice === "string" && choice in KIND_CHOICE_SETS) Object.assign(changes, KIND_CHOICE_SETS[choice as KindChoice]);
  const text = (name: string) => (form.has(name) ? String(form.get(name) ?? "") : undefined);
  const fields = { description: text("description"), productionUrl: text("productionUrl"), homepage: text("homepage"), docsUrl: text("docsUrl") };
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) (changes as Record<string, unknown>)[key] = value;
  if (form.has("links")) changes.links = linksFromForm(form);
  return changes;
}

/** A repository's newest tag, by its commit's date: its latest release. */
export function latestTag(tags: { name: string; commit: { authoredAt: string } | null }[]): { name: string; at: string | null } | null {
  const dated = tags.filter((tag) => tag.commit).sort((a, b) => b.commit!.authoredAt.localeCompare(a.commit!.authoredAt));
  const newest = dated[0] ?? tags[0];
  return newest ? { name: newest.name, at: newest.commit?.authoredAt ?? null } : null;
}

/** The custom links a form gives, as rows of `linkLabel` and `linkUrl` fields, in order. */
export function linksFromForm(form: Pick<FormData, "getAll">): { label: string; url: string }[] {
  const labels = form.getAll("linkLabel").map(String);
  const urls = form.getAll("linkUrl").map(String);
  return urls.map((url, index) => ({ label: labels[index] ?? "", url })).filter((link) => link.label.trim() || link.url.trim());
}

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
