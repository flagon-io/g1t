import { ArrowUpRight, Box, Check, ChevronDown, Download, Lock, Search } from "lucide-react";
import { Form, Link, data } from "react-router";

import { ECOSYSTEMS, type Ecosystem, type PackageSummary } from "@g1t/contracts";

import type { Route } from "./+types/packages";
import { PackageIcon } from "../../components/package-icon";
import { CopyLine, EmptyState, TimeAgo } from "../../components/ui";
import { Badge } from "../../components/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/ui/dropdown-menu";
import { cn } from "../../lib/cn";
import { page } from "../../lib/meta";
import {
  ECOSYSTEM_LABEL,
  type PackageSort,
  REGISTRIES,
  SORT_LABEL,
  VISIBILITY_LABEL,
  type VisibilityFilter,
  arrange,
  formatBytes,
  shortCount,
} from "../../lib/packages";
import { packages } from "../../lib/services.server";
import { getViewer, roleIn, unwrap } from "../../lib/session.server";

const DOCS = "https://docs.g1t.sh";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Packages · ${params.owner} · g1t` });
}

function pick<T extends string>(value: string | null, options: readonly T[], fallback: T): T {
  return value && (options as readonly string[]).includes(value) ? (value as T) : fallback;
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  // Members only for now; a workspace's public packages are found through
  // their repositories and search.
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const url = new URL(request.url);
  const type = url.searchParams.get("type");
  const ecosystem = type && (ECOSYSTEMS as readonly string[]).includes(type) ? (type as Ecosystem) : null;
  const query = url.searchParams.get("q")?.trim() || null;
  const visibility = pick<VisibilityFilter>(url.searchParams.get("visibility"), ["all", "public", "private"], "all");
  const sort = pick<PackageSort>(url.searchParams.get("sort"), ["updated", "downloads", "name"], "updated");
  const found = unwrap(await packages.list(params.owner, viewer, { ecosystem, query }));
  // Whether the workspace has any at all decides between a filtered-out
  // list and the first-package page.
  const any = found.length > 0 || ecosystem != null || query != null;
  return {
    list: arrange(found, visibility, sort),
    any,
    ecosystem,
    query,
    visibility,
    sort,
    workspace: params.owner.toLowerCase(),
  };
}

type Filters = { type: string | null; q: string | null; visibility: VisibilityFilter; sort: PackageSort };

/** The page's address with one filter changed, defaults left out. */
function hrefWith(workspace: string, current: Filters, change: Partial<Filters>): string {
  const next = { ...current, ...change };
  const params = new URLSearchParams();
  if (next.type) params.set("type", next.type);
  if (next.q) params.set("q", next.q);
  if (next.visibility !== "all") params.set("visibility", next.visibility);
  if (next.sort !== "updated") params.set("sort", next.sort);
  return `/${workspace}/-/packages${params.size ? `?${params}` : ""}`;
}

/** The packages a workspace publishes: filtered, sorted, or, with none yet, how to start. */
export default function Packages({ loaderData }: Route.ComponentProps) {
  const { list, any, ecosystem, query, visibility, sort, workspace } = loaderData;
  if (!any) return <ChooseRegistry workspace={workspace} />;
  const filters: Filters = { type: ecosystem, q: query, visibility, sort };
  const filtered = ecosystem != null || query != null || visibility !== "all";
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <FilterMenu
          label="Type"
          value={ecosystem ? ECOSYSTEM_LABEL[ecosystem] : "All"}
          options={[null, ...ECOSYSTEMS].map((option) => ({
            label: option ? ECOSYSTEM_LABEL[option] : "All",
            to: hrefWith(workspace, filters, { type: option }),
            current: ecosystem === option,
          }))}
        />
        <Form method="get" className="relative min-w-48 grow">
          <label className="sr-only" htmlFor="package-search">
            Search packages
          </label>
          <Search size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
          <input
            id="package-search"
            name="q"
            defaultValue={query ?? ""}
            placeholder="Search packages"
            className="h-9 w-full rounded-lg border border-line bg-surface pr-3 pl-8 text-sm placeholder:text-faint focus:border-line-strong focus:outline-none"
          />
          {ecosystem && <input type="hidden" name="type" value={ecosystem} />}
          {visibility !== "all" && <input type="hidden" name="visibility" value={visibility} />}
          {sort !== "updated" && <input type="hidden" name="sort" value={sort} />}
        </Form>
        <FilterMenu
          label="Visibility"
          value={VISIBILITY_LABEL[visibility]}
          options={(["all", "public", "private"] as const).map((option) => ({
            label: VISIBILITY_LABEL[option],
            to: hrefWith(workspace, filters, { visibility: option }),
            current: visibility === option,
          }))}
        />
        <FilterMenu
          label="Sort"
          value={SORT_LABEL[sort]}
          options={(["updated", "downloads", "name"] as const).map((option) => ({
            label: SORT_LABEL[option],
            to: hrefWith(workspace, filters, { sort: option }),
            current: sort === option,
          }))}
        />
      </div>

      <section className="overflow-hidden rounded-xl border border-line bg-surface">
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5 text-sm">
          <span className="font-medium">
            {list.length} {list.length === 1 ? "package" : "packages"}
            {filtered && (
              <Link to={`/${workspace}/-/packages`} className="ml-3 text-xs font-normal text-muted hover:text-fg">
                Clear filters
              </Link>
            )}
          </span>
          <a href={`${DOCS}/guides/packages/`} className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
            How packages work <ArrowUpRight size={12} />
          </a>
        </header>
        {list.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No packages match">Try another type or visibility, or clear the search.</EmptyState>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {list.map((pkg) => (
              <PackageRow key={pkg.id} pkg={pkg} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** A filter as a button that opens its choices; each choice is a link, so the address says the view. */
function FilterMenu({ label, value, options }: { label: string; value: string; options: { label: string; to: string; current: boolean }[] }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-sm transition-colors hover:border-line-strong data-[state=open]:border-line-strong">
        <span className="text-muted">{label}:</span>
        <span className="font-medium">{value}</span>
        <ChevronDown size={13} className="text-faint" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        {options.map((option) => (
          <DropdownMenuItem key={option.label} asChild>
            <Link to={option.to} preventScrollReset>
              <Check size={14} className={cn(!option.current && "invisible")} />
              {option.label}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PackageRow({ pkg }: { pkg: PackageSummary }) {
  return (
    <li>
      <Link
        to={`/${pkg.workspace}/-/packages/${pkg.ecosystem}/${pkg.name}`}
        className="flex items-center gap-3.5 px-4 py-3.5 transition-colors hover:bg-raised/50"
      >
        <PackageIcon ecosystem={pkg.ecosystem} />
        <span className="min-w-0 grow">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{pkg.name}</span>
            {pkg.visibility === "private" && (
              <Badge>
                <Lock size={10} />
                Private
              </Badge>
            )}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
            <span>{ECOSYSTEM_LABEL[pkg.ecosystem]}</span>
            <span className="text-faint">·</span>
            <span>
              Updated <TimeAgo at={pkg.updated_at} />
            </span>
            {pkg.repo && (
              <>
                <span className="text-faint">·</span>
                <span className="inline-flex items-center gap-1">
                  <Box size={11} />
                  {pkg.repo.name}
                </span>
              </>
            )}
            {pkg.description && (
              <>
                <span className="text-faint">·</span>
                <span className="max-w-md truncate">{pkg.description}</span>
              </>
            )}
          </span>
        </span>
        <span className="hidden shrink-0 items-center gap-5 text-xs text-muted tabular-nums sm:flex">
          {pkg.latest && <span className="max-w-32 truncate font-mono text-fg-soft">{pkg.latest}</span>}
          <span className="w-16 text-right">{formatBytes(pkg.size)}</span>
          <span className="inline-flex w-14 items-center justify-end gap-1" title={`${pkg.downloads.toLocaleString("en-US")} downloads`}>
            <Download size={12} />
            {shortCount(pkg.downloads)}
          </span>
        </span>
      </Link>
    </li>
  );
}

/** With no packages yet: every registry, what it is for, and the first step. */
function ChooseRegistry({ workspace }: { workspace: string }) {
  return (
    <div className="space-y-6">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold tracking-tight">Choose a registry</h2>
        <p className="mt-1 text-sm text-muted">
          Packages live beside the code that makes them, with the same members, roles and tokens. Workflows publish with{" "}
          <code className="font-mono text-xs">G1T_TOKEN</code>.
        </p>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {REGISTRIES.map((registry) => (
          <li key={registry.ecosystem} className="flex flex-col rounded-xl border border-line bg-surface p-4">
            <div className="flex items-center gap-2.5">
              <PackageIcon ecosystem={registry.ecosystem} />
              <span className="font-medium">{ECOSYSTEM_LABEL[registry.ecosystem]}</span>
              {!registry.ready && <Badge>Soon</Badge>}
            </div>
            <p className="mt-2.5 grow text-sm text-muted">{registry.blurb}</p>
            {registry.ready && (
              <div className="mt-3">
                <CopyLine prompt text={registry.start.replaceAll("<workspace>", workspace)} />
              </div>
            )}
            <a
              href={`${DOCS}${registry.guide}`}
              className="mt-3 inline-flex items-center gap-1 self-start text-sm text-fg-soft hover:text-fg"
            >
              {registry.ready ? "Set it up" : "What's planned"} <ArrowUpRight size={13} />
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
