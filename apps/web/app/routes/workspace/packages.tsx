import { Box, Lock, Package, Search } from "lucide-react";
import { Form, Link, data } from "react-router";

import { ECOSYSTEMS, type Ecosystem, type PackageSummary } from "@g1t/contracts";

import type { Route } from "./+types/packages";
import { CopyLine, EmptyState, TimeAgo } from "../../components/ui";
import { Badge } from "../../components/ui/badge";
import { cn } from "../../lib/cn";
import { page } from "../../lib/meta";
import { ECOSYSTEM_LABEL, formatBytes } from "../../lib/packages";
import { packages } from "../../lib/services.server";
import { getViewer, roleIn, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Packages · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  // Members only for now; a workspace's public packages are found through
  // their repositories and search.
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const url = new URL(request.url);
  const asked = url.searchParams.get("type");
  const ecosystem = asked && (ECOSYSTEMS as readonly string[]).includes(asked) ? (asked as Ecosystem) : null;
  const query = url.searchParams.get("q")?.trim() || null;
  const list = unwrap(await packages.list(params.owner, viewer, { ecosystem, query }));
  return { list, ecosystem, query, workspace: params.owner.toLowerCase(), username: viewer?.username ?? "you" };
}

/** The packages a workspace publishes, by registry, with how to start one. */
export default function Packages({ loaderData }: Route.ComponentProps) {
  const { list, ecosystem, query, workspace, username } = loaderData;
  const filtered = ecosystem != null || query != null;
  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <a href="https://docs.g1t.sh/guides/packages/" className="text-sm text-muted hover:text-fg">
          How packages work
        </a>
      </div>

      <Form method="get" className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-0 grow">
          <span className="sr-only">Search packages</span>
          <Search size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
          <input
            name="q"
            defaultValue={query ?? ""}
            placeholder="Find a package"
            className="h-9 w-full rounded-lg border border-line bg-surface pr-3 pl-8 text-sm placeholder:text-faint focus:border-line-strong focus:outline-none"
          />
        </label>
        {ecosystem && <input type="hidden" name="type" value={ecosystem} />}
        <nav aria-label="Registry" className="flex flex-wrap gap-1 text-sm">
          {[null, ...ECOSYSTEMS].map((option) => {
            const params = new URLSearchParams();
            if (option) params.set("type", option);
            if (query) params.set("q", query);
            const href = `/${workspace}/-/packages${params.size ? `?${params}` : ""}`;
            return (
              <Link
                key={option ?? "all"}
                to={href}
                aria-current={ecosystem === option ? "page" : undefined}
                className={cn(
                  "rounded-md px-2.5 py-1.5 transition-colors",
                  ecosystem === option ? "bg-raised text-fg" : "text-muted hover:text-fg",
                )}
              >
                {option ? ECOSYSTEM_LABEL[option] : "All"}
              </Link>
            );
          })}
        </nav>
      </Form>

      {list.length === 0 ? (
        filtered ? (
          <EmptyState title="No packages match">Try another registry, or clear the search.</EmptyState>
        ) : (
          <FirstPackage workspace={workspace} username={username} />
        )
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
          {list.map((pkg) => (
            <PackageRow key={pkg.id} pkg={pkg} />
          ))}
        </ul>
      )}
    </div>
  );
}

function PackageRow({ pkg }: { pkg: PackageSummary }) {
  return (
    <li>
      <Link
        to={`/${pkg.workspace}/-/packages/${pkg.ecosystem}/${pkg.name}`}
        className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5 transition-colors hover:bg-raised/50"
      >
        <span className="text-faint">{pkg.visibility === "private" ? <Lock size={15} /> : <Package size={15} />}</span>
        <span className="min-w-0 grow">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{pkg.name}</span>
            <Badge>{ECOSYSTEM_LABEL[pkg.ecosystem]}</Badge>
            {pkg.visibility === "private" && <Badge>Private</Badge>}
          </span>
          <span className="mt-0.5 block truncate font-mono text-xs text-faint">{pkg.address}</span>
        </span>
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted tabular-nums">
          {pkg.repo && (
            <span className="inline-flex items-center gap-1">
              <Box size={12} />
              {pkg.repo.name}
            </span>
          )}
          {pkg.latest && <span className="font-mono">{pkg.latest}</span>}
          <span>
            {pkg.versions} {pkg.versions === 1 ? "version" : "versions"}
          </span>
          <span>{formatBytes(pkg.size)}</span>
          <span>
            Updated <TimeAgo at={pkg.updated_at} />
          </span>
        </span>
      </Link>
    </li>
  );
}

/** With no packages yet: how to push the first image. */
function FirstPackage({ workspace, username }: { workspace: string; username: string }) {
  return (
    <section className="rounded-xl border border-line bg-surface p-6">
      <h2 className="font-medium">Push the workspace's first image</h2>
      <p className="mt-1 text-sm text-muted">
        Log in with a token that may write packages, tag an image under the workspace, and push it. An image named after one of the
        workspace's repositories is linked to it and has its access.
      </p>
      <div className="mt-4 space-y-2">
        <CopyLine prompt text={`docker login g1t.sh -u ${username}`} />
        <CopyLine prompt text={`docker tag web g1t.sh/${workspace}/web:latest`} />
        <CopyLine prompt text={`docker push g1t.sh/${workspace}/web:latest`} />
      </div>
      <p className="mt-4 text-xs text-faint">
        In a workflow, log in with <code className="font-mono">G1T_TOKEN</code>. See{" "}
        <a href="https://docs.g1t.sh/guides/containers/" className="underline hover:text-fg">
          Containers
        </a>
        .
      </p>
    </section>
  );
}
