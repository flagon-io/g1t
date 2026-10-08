import { Download } from "lucide-react";
import { Link, useSearchParams } from "react-router";

import type { Route } from "./+types/security-graph";
import { page } from "../../lib/meta";
import { CARD, FilterSelect, SectionHeader } from "../../components/security-suite";
import { Badge } from "../../components/ui/badge";
import { securitySuite } from "../../lib/services.server";
import { getViewer, requireUser, unwrap } from "../../lib/session.server";
import { requireInsider } from "../../lib/access.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Dependency graph · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context) ?? requireUser(context, request);
  await requireInsider(context, params, "security_alerts");
  return { graph: unwrap(await securitySuite.dependencyGraph({ namespace: params.owner, name: params.repo }, viewer)) };
}

/** Rows shown at once; the SBOM has them all. */
const SHOWN = 500;

export default function DependencyGraph({ loaderData, params }: Route.ComponentProps) {
  const { graph } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const [search, setSearch] = useSearchParams();
  const manifest = search.get("manifest") ?? "all";
  const relationship = search.get("relationship") ?? "all";
  const query = (search.get("q") ?? "").toLowerCase();
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(search);
    if (value === "all" || !value) next.delete(key);
    else next.set(key, value);
    setSearch(next, { replace: true, preventScrollReset: true });
  };
  const shown = graph.dependencies.filter(
    (dep) =>
      (manifest === "all" || dep.manifest === manifest) &&
      (relationship === "all" || dep.relationship === relationship) &&
      (!query || dep.name.toLowerCase().includes(query)),
  );
  return (
    <div className="max-w-5xl space-y-6">
      <SectionHeader
        title="Dependency graph"
        about="Every package the lockfiles on the default branch resolve: direct or transitive where the lockfile says, for development or not, and its license where the lockfile records one. Read again on every push to the default branch, and daily."
        actions={
          graph.dependencies.length > 0 ? (
            <a href={`${base}/security/dependency-graph/sbom.json`} download className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm hover:border-line-strong">
              <Download size={14} /> Export SBOM (SPDX)
            </a>
          ) : null
        }
      />
      {graph.manifests.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-6 text-sm text-muted">
          No lockfiles on the default branch. g1t reads package-lock.json, pnpm-lock.yaml, yarn.lock, Cargo.lock, go.mod, go.sum,
          requirements.txt and poetry.lock.
        </p>
      ) : (
        <>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {graph.manifests.map((item) => (
              <li key={item.path} className={`${CARD} p-3`}>
                <p className="truncate font-mono text-sm">{item.path}</p>
                <p className="mt-1 text-xs text-muted">
                  {item.ecosystem} · {item.dependencies} packages{item.direct ? `, ${item.direct} direct` : ""}
                </p>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-0 grow flex-col gap-1 text-xs text-muted sm:max-w-xs">
              Package
              <input
                defaultValue={search.get("q") ?? ""}
                onChange={(event) => set("q", event.target.value)}
                placeholder="Filter by name"
                className="h-8 rounded-md border border-line bg-bg px-2.5 text-[0.8125rem] text-fg outline-none hover:border-line-strong focus:border-accent-dim"
              />
            </label>
            <FilterSelect label="Lockfile" value={manifest} options={[["all", "Every lockfile"], ...graph.manifests.map((item): [string, string] => [item.path, item.path])]} onChange={(value) => set("manifest", value)} />
            <FilterSelect
              label="Relationship"
              value={relationship}
              options={[["all", "Any"], ["direct", "Direct"], ["transitive", "Transitive"], ["unknown", "Not said"]]}
              onChange={(value) => set("relationship", value)}
            />
          </div>
          <div className={`${CARD} overflow-x-auto`}>
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="text-left text-xs text-muted">
                <tr className="border-b border-line">
                  <th className="px-4 py-2 font-medium">Package</th>
                  <th className="px-3 py-2 font-medium">Version</th>
                  <th className="px-3 py-2 font-medium">Relationship</th>
                  <th className="px-3 py-2 font-medium">License</th>
                  <th className="px-3 py-2 font-medium">Lockfile</th>
                </tr>
              </thead>
              <tbody>
                {shown.slice(0, SHOWN).map((dep) => (
                  <tr key={`${dep.manifest}:${dep.name}@${dep.version}`} className="border-b border-line last:border-0">
                    <td className="px-4 py-2">
                      <span className="font-mono text-xs">{dep.name}</span>
                      {dep.vulnerabilities > 0 && (
                        <Link to={`${base}/security/vulnerabilities`} className="ml-2">
                          <Badge tone="danger">
                            {dep.vulnerabilities} {dep.vulnerabilities === 1 ? "vulnerability" : "vulnerabilities"}
                          </Badge>
                        </Link>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{dep.version}</td>
                    <td className="px-3 py-2 text-xs text-muted">
                      {dep.relationship === "unknown" ? "not said" : dep.relationship}
                      {dep.development ? ", dev" : ""}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted">{dep.license ?? "—"}</td>
                    <td className="px-3 py-2 font-mono text-xs text-faint">{dep.manifest}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-faint">
            {shown.length > SHOWN ? `The first ${SHOWN} of ${shown.length} shown; the SBOM has every package.` : `${shown.length} packages.`}
            {graph.commit && <> Read at {graph.commit.slice(0, 7)}.</>}
          </p>
        </>
      )}
    </div>
  );
}
