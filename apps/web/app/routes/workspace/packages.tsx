import { ArrowUpRight, Box, Check, ChevronDown, Download, Lock, RotateCcw, Search, Trash2 } from "lucide-react";
import { Form, Link, data, redirect } from "react-router";

import { ECOSYSTEMS, type Ecosystem, PACKAGE_RESTORE_DAYS, type PackageSummary } from "@g1t/contracts";

import type { Route } from "./+types/packages";
import { PackageIcon } from "../../components/package-icon";
import { CopyLine, EmptyState, ErrorText, SubmitButton, TimeAgo } from "../../components/ui";
import { Badge } from "../../components/ui/badge";
import { Card } from "../../components/ui/card";
import { Hint } from "../../components/ui/hint";
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
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../lib/session.server";

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
  const view = url.searchParams.get("view") === "deleted" ? "deleted" : "active";
  // Deleted packages are listed for those who administer them, and only
  // then is there a Deleted packages view.
  const [found, deletedFound] = await Promise.all([
    packages.list(params.owner, viewer, { ecosystem, query }),
    packages.deleted(params.owner, viewer),
  ]);
  const listed = unwrap(found);
  const deleted = deletedFound.ok ? deletedFound.value : [];
  // Whether the workspace has any at all decides between a filtered-out
  // list and the first-package page.
  const any = listed.length > 0 || deleted.length > 0 || ecosystem != null || query != null;
  return {
    list: arrange(listed, visibility, sort),
    deleted,
    view,
    any,
    ecosystem,
    query,
    visibility,
    sort,
    workspace: params.owner.toLowerCase(),
  };
}

type Outcome = { error: string | null; message: string | null };

/** Restoring a deleted package, from the Deleted packages view. */
export async function action({ request, params, context }: Route.ActionArgs): Promise<Outcome | Response> {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  if (form.get("intent") !== "restore") return { error: "That is not something this page does.", message: null };
  const type = String(form.get("ecosystem") ?? "");
  const name = String(form.get("name") ?? "");
  if (!(ECOSYSTEMS as readonly string[]).includes(type) || !name) return { error: "Name the package to restore.", message: null };
  const restored = await packages.restorePackage(user, params.owner, type as Ecosystem, name, "web");
  if (!restored.ok) return { error: restored.error.message, message: null };
  return redirect(`/${params.owner}/-/packages/${type}/${name}`);
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
export default function Packages({ loaderData, actionData }: Route.ComponentProps) {
  const { list, deleted, view, any, ecosystem, query, visibility, sort, workspace } = loaderData;
  if (!any) return <ChooseRegistry workspace={workspace} />;
  if (view === "deleted") return <DeletedPackages workspace={workspace} deleted={deleted} outcome={actionData as Outcome | undefined} />;
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

      <Card asChild className="overflow-hidden">
        <section>
          <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5 text-sm">
            <span className="font-medium">
              {list.length} {list.length === 1 ? "package" : "packages"}
              {filtered && (
                <Link to={`/${workspace}/-/packages`} className="ml-3 text-xs font-normal text-muted hover:text-fg">
                  Clear filters
                </Link>
              )}
            </span>
            <span className="flex items-center gap-4">
              {deleted.length > 0 && (
                <Link to={`/${workspace}/-/packages?view=deleted`} className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
                  <Trash2 size={12} />
                  Deleted packages <span className="rounded-full bg-raised px-1.5 text-faint tabular-nums">{deleted.length}</span>
                </Link>
              )}
              <a href={`${DOCS}/guides/packages/`} className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
                How packages work <ArrowUpRight size={12} />
              </a>
            </span>
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
      </Card>
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
          <Hint label={`${pkg.downloads.toLocaleString("en-US")} downloads`}>
            <span className="inline-flex w-14 items-center justify-end gap-1">
              <Download size={12} />
              {shortCount(pkg.downloads)}
              <span className="sr-only"> downloads</span>
            </span>
          </Hint>
        </span>
      </Link>
    </li>
  );
}

/** Deleted packages that can still be restored, for those who administer them. */
function DeletedPackages({ workspace, deleted, outcome }: { workspace: string; deleted: PackageSummary[]; outcome: Outcome | undefined }) {
  return (
    <div className="space-y-4">
      <Link to={`/${workspace}/-/packages`} className="text-sm text-muted hover:text-fg">
        Packages
      </Link>
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold tracking-tight">Deleted packages</h2>
        <p className="mt-1 text-sm text-muted">
          Packages deleted in the last {PACKAGE_RESTORE_DAYS} days, with every version they had. Restore one to bring it back as it was;
          until it is purged, nobody else can publish a package of its name.
        </p>
      </div>
      {outcome?.error && <ErrorText>{outcome.error}</ErrorText>}
      {deleted.length === 0 ? (
        <EmptyState title="No deleted packages">Packages you delete stay here, restorable, for {PACKAGE_RESTORE_DAYS} days.</EmptyState>
      ) : (
        <Card asChild divided className="overflow-hidden">
          <ul>
            {deleted.map((pkg) => (
              <li key={pkg.id} className="flex flex-wrap items-center gap-x-3.5 gap-y-2 px-4 py-3.5">
                <PackageIcon ecosystem={pkg.ecosystem} />
                <span className="min-w-0 grow basis-48">
                  <span className="block truncate font-medium">{pkg.name}</span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
                    <span>{ECOSYSTEM_LABEL[pkg.ecosystem]}</span>
                    <span className="text-faint">·</span>
                    <span>
                      {pkg.versions} {pkg.versions === 1 ? "version" : "versions"}
                    </span>
                    {pkg.deleted_at && (
                      <>
                        <span className="text-faint">·</span>
                        <span>
                          Deleted {pkg.deleted_by ? `by ${pkg.deleted_by} ` : ""}
                          <TimeAgo at={pkg.deleted_at} />
                        </span>
                      </>
                    )}
                    {pkg.purge_at && (
                      <>
                        <span className="text-faint">·</span>
                        <span>Purged {new Date(pkg.purge_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                      </>
                    )}
                  </span>
                </span>
                <Form method="post">
                  <input type="hidden" name="intent" value="restore" />
                  <input type="hidden" name="ecosystem" value={pkg.ecosystem} />
                  <input type="hidden" name="name" value={pkg.name} />
                  <SubmitButton variant="outline" match={{ intent: "restore", name: pkg.name }} pending="Restoring…">
                    <RotateCcw size={14} />
                    Restore
                  </SubmitButton>
                </Form>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
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
          <Card asChild key={registry.ecosystem} className="flex flex-col p-4">
            <li>
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
          </Card>
        ))}
      </ul>
    </div>
  );
}
