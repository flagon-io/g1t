/**
 * A project's place in the catalog, put together from what its files say
 * (see `./extract`) and what g1t knows about it already: its dependencies,
 * owners, deployments and integrations. Pure, so a rebuild from the same
 * inputs gives the same entities and relations, and writing them is
 * idempotent.
 */

import type { EntityKind, RelationKind } from "@g1t/contracts";

import type { FileFacts, Hint } from "./extract";
import { harvestable } from "./harvest.ts";

export type ProjectInput = {
  id: string;
  workspace: string;
  slug: string;
  name: string;
  description: string | null;
  private: boolean;
  repoId: string;
  repo: { namespace: string; name: string };
  rootDir: string;
  defaultBranch: string;
};

export type FileRecord = { path: string; facts: FileFacts };

export type Surroundings = {
  /** Members who own it: named in its files, or who wrote most of it. */
  owners: string[];
  dependsOn: { slug: string; as: string | null }[];
  deploy: {
    enabled: boolean;
    production: { url: string; commit: string; deployedAt: string } | null;
    previews: number;
    latest: { status: string; kind: string; error: string | null; createdAt: string } | null;
  } | null;
  integrations: { id: string; provider: string; name: string; kind: string; repo: string | null }[];
};

export type EntityDraft = {
  kind: EntityKind;
  key: string;
  name: string;
  summary: string | null;
  data: Record<string, unknown>;
  ref: string | null;
};

export type Ref = { kind: EntityKind; key: string };
export type RelationDraft = { from: Ref; kind: RelationKind; to: Ref };

export type Assembled = {
  entities: EntityDraft[];
  relations: RelationDraft[];
  /** Stack facts and doc hints, with the file each came from. */
  hints: (Hint & { path: string })[];
  /** Whether a workflow runs tests. */
  tests: boolean;
};

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/** The catalog entries for one project. */
export function assemble(project: ProjectInput, files: FileRecord[], around: Surroundings): Assembled {
  const me: Ref = { kind: "project", key: project.slug };
  const entities: EntityDraft[] = [];
  const relations: RelationDraft[] = [];
  const relate = (from: Ref, kind: RelationKind, to: Ref) => relations.push({ from, kind, to });

  const languages = unique(files.flatMap((file) => file.facts.languages));
  const packages = files.flatMap((file) => file.facts.packages.map((pkg) => ({ ...pkg, path: file.path })));
  const apis = files.flatMap((file) => file.facts.apis.map((api) => ({ ...api, path: file.path })));
  const docs = files.flatMap((file) => (file.facts.doc ? [file.facts.doc] : []));
  const tests = files.some((file) => file.facts.tests);
  const declaredOwners = unique(files.flatMap((file) => file.facts.owners));
  const owners = unique([...declaredOwners, ...around.owners]);

  const app: Ref = { kind: "app", key: project.slug };
  const hasApp = !!around.deploy?.enabled;
  entities.push({
    kind: "project",
    key: project.slug,
    name: project.name,
    summary:
      [
        project.description,
        languages.length ? `Written in ${languages.join(", ")}.` : null,
        packages.length ? `Packages: ${packages.map((pkg) => pkg.name).join(", ")}.` : null,
        around.dependsOn.length ? `Uses ${around.dependsOn.map((dep) => dep.slug).join(", ")}.` : null,
        owners.length ? `Owned by ${owners.join(", ")}.` : null,
      ]
        .filter(Boolean)
        .join(" ") || null,
    data: {
      repo: `${project.repo.namespace}/${project.repo.name}`,
      rootDir: project.rootDir,
      defaultBranch: project.defaultBranch,
      languages,
      owners,
      tests,
      testCommands: packages.flatMap((pkg) => (pkg.scripts?.test ? [`${pkg.ecosystem === "npm" ? "npm test" : pkg.scripts.test}`] : [])),
      productionUrl: around.deploy?.production?.url ?? null,
    },
    ref: `/${project.repo.namespace}/${project.repo.name}${project.rootDir ? `/tree/${project.defaultBranch}/${project.rootDir}` : ""}`,
  });

  for (const dep of around.dependsOn) {
    relate(me, "depends_on", { kind: "project", key: dep.slug });
  }
  for (const owner of owners) {
    entities.push({ kind: "owner", key: owner.toLowerCase(), name: owner, summary: null, data: {}, ref: `/u/${owner}` });
    relate(me, "owned_by", { kind: "owner", key: owner.toLowerCase() });
  }
  for (const language of languages) {
    entities.push({ kind: "language", key: language.toLowerCase(), name: language, summary: null, data: {}, ref: null });
    relate(me, "uses", { kind: "language", key: language.toLowerCase() });
  }
  for (const pkg of packages) {
    const key = `${pkg.ecosystem}:${pkg.name}`;
    entities.push({
      kind: "package",
      key,
      name: pkg.name,
      summary: `${pkg.ecosystem} package${pkg.version ? ` ${pkg.version}` : ""} in ${project.name}; depends on ${pkg.dependencies.length} packages.`,
      data: { ecosystem: pkg.ecosystem, version: pkg.version, dependencies: pkg.dependencies, scripts: pkg.scripts ?? {}, members: pkg.members ?? [], path: pkg.path },
      ref: `/${project.repo.namespace}/${project.repo.name}/blob/${project.defaultBranch}/${[project.rootDir, pkg.path].filter(Boolean).join("/")}`,
    });
    relate(me, "exposes", { kind: "package", key });
    // Within the workspace, a package using another is a dependency the
    // catalog can draw; ones from outside have no entity and are dropped
    // when read.
    for (const dependency of pkg.dependencies) {
      relate({ kind: "package", key }, "depends_on", { kind: "package", key: `${pkg.ecosystem}:${dependency}` });
    }
  }
  for (const api of apis) {
    const key = `${project.slug}:${api.kind}:${api.name}`;
    entities.push({
      kind: "api",
      key,
      name: api.name,
      summary: api.summary,
      data: { kind: api.kind, routes: api.routes, path: api.path },
      ref: `/${project.repo.namespace}/${project.repo.name}/blob/${project.defaultBranch}/${[project.rootDir, api.path].filter(Boolean).join("/")}`,
    });
    relate(me, "exposes", { kind: "api", key });
    if (hasApp && api.kind === "worker") relate(app, "exposes", { kind: "api", key });
  }
  for (const doc of docs) {
    const key = `${project.slug}:${doc.path}`;
    entities.push({
      kind: "doc",
      key,
      name: doc.title,
      summary: doc.summary,
      data: { path: doc.path, role: doc.role, chunks: doc.chunks.length },
      ref: `/${project.repo.namespace}/${project.repo.name}/blob/${project.defaultBranch}/${[project.rootDir, doc.path].filter(Boolean).join("/")}`,
    });
    relate(me, "documented_by", { kind: "doc", key });
  }
  if (hasApp && around.deploy) {
    const { production, previews, latest } = around.deploy;
    entities.push({
      kind: "app",
      key: project.slug,
      name: project.name,
      summary: production ? `Live at ${production.url}.` : "Deploys from its default branch; not live yet.",
      data: { productionUrl: production?.url ?? null, previews, latest },
      ref: `/${project.repo.namespace}/${project.repo.name}/deployments`,
    });
    relate(me, "exposes", app);
    entities.push({
      kind: "environment",
      key: `${project.slug}/production`,
      name: `${project.name} production`,
      summary: production ? `${production.url}, from ${production.commit.slice(0, 7)}` : "Not deployed yet",
      data: { url: production?.url ?? null, commit: production?.commit ?? null, deployedAt: production?.deployedAt ?? null, status: latest?.kind === "production" ? latest.status : production ? "ready" : null },
      ref: production?.url ?? null,
    });
    relate(app, "deploys_to", { kind: "environment", key: `${project.slug}/production` });
    if (previews > 0) {
      entities.push({
        kind: "environment",
        key: `${project.slug}/preview`,
        name: `${project.name} previews`,
        summary: `${previews} preview${previews === 1 ? "" : "s"} up, one per open pull request`,
        data: { previews },
        ref: `/${project.repo.namespace}/${project.repo.name}/deployments`,
      });
      relate(app, "deploys_to", { kind: "environment", key: `${project.slug}/preview` });
    }
  }
  const repoPath = `${project.repo.namespace}/${project.repo.name}`.toLowerCase();
  for (const integration of around.integrations) {
    if (integration.repo?.toLowerCase() === repoPath) relate(me, "uses", { kind: "integration", key: integration.id });
  }

  // A doc is a source of memory only when it says how to work here (see
  // ./harvest), or project.yml says it is.
  const memory = files.find((file) => file.facts.memory)?.facts.memory ?? null;
  const hints = files
    .filter((file) => !file.facts.doc || harvestable(file.path, file.facts.doc.role, memory))
    .flatMap((file) => file.facts.hints.map((hint) => ({ ...hint, path: file.path })));
  return { entities, relations, hints, tests };
}

/** A workspace's integrations, as catalog entries of their own. */
export function integrationEntities(integrations: Surroundings["integrations"]): EntityDraft[] {
  return integrations.map((integration) => ({
    kind: "integration",
    key: integration.id,
    name: integration.name,
    summary: `${integration.provider} (${integration.kind})${integration.repo ? `, opens issues on ${integration.repo}` : ""}`,
    data: { provider: integration.provider, kind: integration.kind, repo: integration.repo },
    ref: null,
  }));
}

/**
 * The members who wrote most of a project, from its recent commits: those
 * with at least a fifth of them, at most three. A commit's author is a
 * member when its name or its email's local part is their username.
 */
export function authorsOf(commits: { author: { name: string; email: string } }[], members: string[]): string[] {
  const byName = new Map(members.map((member) => [member.toLowerCase(), member]));
  const counts = new Map<string, number>();
  for (const commit of commits) {
    const name = commit.author.name.toLowerCase();
    const local = commit.author.email.split("@")[0]?.toLowerCase() ?? "";
    const member = byName.get(name) ?? byName.get(local);
    if (member) counts.set(member, (counts.get(member) ?? 0) + 1);
  }
  const total = commits.length || 1;
  return [...counts.entries()]
    .filter(([, count]) => count / total >= 0.2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([member]) => member);
}
