/**
 * Customize → Plugins (docs.g1t.sh/guides/customize/, "Plugins"). Yours:
 * the plugins the workspace installed, each saying what it brought (skills,
 * agents, connectors, and what only Claude Code on a runner uses), whether
 * it is on, and whether its marketplace has moved on. Discover: every
 * plugin in every marketplace the workspace reads, searched and narrowed by
 * category and marketplace, grouped by marketplace or sorted by name, each
 * saying whether it can be installed here and why not when it can't.
 */
import { ArrowUpCircle, EllipsisVertical, Plus, Store, Trash2 } from "lucide-react";
import { Link, data, useFetcher, useSearchParams } from "react-router";

import type { PluginInstall, PluginListing } from "@g1t/contracts";
import { customizePath } from "@g1t/contracts/customize";

import type { Route } from "./+types/plugins";
import { useCustomize } from "./layout";
import { agentsAction, answer, readOrNull } from "../../../components/agents/actions.server";
import { type ActionResult, Confirm } from "../../../components/agents/dialogs";
import { AvailabilityBadge, Chips, FeaturedBanner, FilterMenu, ListingCard, ListingGrid, ListingMark, NoAnswer, RequestButton, SectionHead, Waiting } from "../../../components/customize";
import { ButtonLink, EmptyState, SubmitButton } from "../../../components/ui";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import { Hint } from "../../../components/ui/hint";
import { Switch } from "../../../components/ui/switch";
import { type PluginSort, categoriesOf, claudeCodeOnly, componentChips, filterPlugins, groupByMarketplace, matches, nextParams, pluginListingRef, pluginPath, readPluginFilters, readQuery, readView, requestedBy, waitingFor, withParams } from "../../../lib/customize";
import { page } from "../../../lib/meta";
import { workspaceAgents } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

export { shouldRevalidate } from "../../../lib/customize-revalidate";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Plugins · Customize · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs): Promise<{ installs: PluginInstall[] | null; discover: PluginListing[] | null | undefined }> {
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  if (!roleIn(viewer, slug)) throw data(null, { status: 404 });
  const discovering = readView(new URL(request.url).searchParams) === "discover";
  const [installs, discover] = await Promise.all([
    readOrNull(workspaceAgents.pluginInstalls(slug, viewer)),
    // Only Discover reads the marketplaces; undefined says it wasn't asked for.
    discovering ? readOrNull(workspaceAgents.discover(slug, viewer)).then((found) => found?.plugins ?? null) : Promise.resolve(undefined),
  ]);
  return { installs, discover };
}

/** Install a plugin, update it to its marketplace's current version, switch it on or off, or uninstall it. */
export async function action({ params, context, request }: Route.ActionArgs): Promise<ActionResult> {
  const { viewer, slug, form } = await agentsAction(request, context, params.owner);
  const intent = String(form.get("intent") ?? "");
  const ref = String(form.get("plugin") ?? "");
  switch (intent) {
    case "install":
      return answer(intent, workspaceAgents.installPlugin(slug, viewer, ref));
    case "update":
      return answer(intent, workspaceAgents.updatePlugin(slug, viewer, ref));
    case "switch":
      return answer(intent, workspaceAgents.setPluginEnabled(slug, viewer, ref, form.get("enabled") === "on"));
    case "uninstall":
      return answer(intent, workspaceAgents.uninstallPlugin(slug, viewer, ref));
    default:
      return { ok: false, intent, error: "Unknown request." };
  }
}

export default function CustomizePlugins({ loaderData }: Route.ComponentProps) {
  const [params] = useSearchParams();
  return readView(params) === "discover" ? <Discover listings={loaderData.discover ?? null} /> : <Yours installs={loaderData.installs} />;
}

// ── Yours ────────────────────────────────────────────────────────────────

function Yours({ installs }: { installs: PluginInstall[] | null }) {
  const { slug, owner } = useCustomize();
  const [params] = useSearchParams();
  const query = readQuery(params);
  if (!installs) return <NoAnswer what="Installed plugins" />;
  const shown = installs.filter((install) => matches([install.name, install.display_name, install.description, install.marketplace, ...install.components.skills.map((s) => s.name), ...install.components.agents.map((a) => a.name)], query));
  const updates = installs.filter((install) => install.update).length;
  return (
    <section aria-labelledby="installed">
      <SectionHead id="installed" title="Installed" aside={updates > 0 ? <span className="text-warn">{updates === 1 ? "1 update available" : `${updates} updates available`}</span> : `${installs.length}`}>
        Each brought its skills to the library, its agents to Templates and its remote servers to Connectors, pinned to the commit it was read at. Everything else in it reaches Claude Code when it runs on a runner.
      </SectionHead>
      {shown.length === 0 ? (
        <EmptyState title={query ? "No plugin matches" : "No plugins yet"}>
          {query ? (
            "Try another word, or look in Discover."
          ) : (
            <>
              Find one in{" "}
              <Link to={withParams(customizePath("plugins", slug), params, { view: "discover" })} className="text-accent hover:underline">
                Discover
              </Link>
              : public skills, agents and connectors in the open plugin format, from any marketplace.
            </>
          )}
        </EmptyState>
      ) : (
        <ListingGrid>
          {shown.map((install) => (
            <InstallCard key={install.id} install={install} slug={slug} owner={owner} />
          ))}
        </ListingGrid>
      )}
    </section>
  );
}

/** An installed plugin: what it brought, whether it is on, and the update, when there is one. */
function InstallCard({ install, slug, owner }: { install: PluginInstall; slug: string; owner: boolean }) {
  const fetcher = useFetcher<ActionResult>({ key: `install-${install.id}` });
  const error = fetcher.state === "idle" && fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;
  const pending = fetcher.formData?.get("intent") === "switch" ? fetcher.formData.get("enabled") === "on" : null;
  const on = pending ?? install.enabled;
  const name = install.display_name ?? install.name;
  const runner = claudeCodeOnly(install.components);
  return (
    <ListingCard
      mark={<ListingMark id={install.ref} name={name} />}
      title={name}
      to={pluginPath(slug, install.ref)}
      description={install.description}
      muted={!on}
      badge={
        <>
          {install.update && (
            <Hint label={`The marketplace lists ${install.update.version ?? "a newer commit"}; this workspace has ${install.version ?? install.sha?.slice(0, 7) ?? "an older one"}.`}>
              <span tabIndex={0} className="inline-flex rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                <Badge tone="warn">Update available{install.update.version ? `: ${install.update.version}` : ""}</Badge>
              </span>
            </Hint>
          )}
          {!on && !install.update && <Badge>Switched off</Badge>}
          {owner && <InstallMenu install={install} fetcher={fetcher} />}
        </>
      }
      meta={`${install.version ? `v${install.version}` : (install.sha?.slice(0, 7) ?? "")} · ${install.marketplace} · by @${install.installed_by}`}
      action={
        owner ? (
          <Hint label={on ? `Switch ${name} off: its skills, agents and connectors stop reaching agents` : `Switch ${name} on`}>
            <span className="inline-flex">
              <Switch checked={on} disabled={fetcher.state !== "idle"} aria-label={`${name} on`} onCheckedChange={(next) => fetcher.submit({ intent: "switch", plugin: install.ref, enabled: next ? "on" : "off" }, { method: "post" })} />
            </span>
          </Hint>
        ) : (
          <Badge tone={on ? "success" : "neutral"}>{on ? "On" : "Off"}</Badge>
        )
      }
    >
      <div className="space-y-1.5">
        <Chips items={componentChips(install.components)} label="What it brought" />
        {runner.length > 0 && <Chips items={[`Claude Code only: ${runner.join(" · ")}`]} muted label="For Claude Code on a runner" />}
        {install.problems.length > 0 && <p className="text-xs text-warn">{install.problems.length === 1 ? "1 problem" : `${install.problems.length} problems`} when it was read</p>}
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
    </ListingCard>
  );
}

/** Update an install, or uninstall it (asked twice). */
function InstallMenu({ install, fetcher }: { install: PluginInstall; fetcher: ReturnType<typeof useFetcher<ActionResult>> }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon-xs" aria-label={`What to do with ${install.display_name ?? install.name}`} disabled={fetcher.state !== "idle"}>
          <EllipsisVertical size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {install.update && (
          <>
            <DropdownMenuItem onSelect={() => fetcher.submit({ intent: "update", plugin: install.ref }, { method: "post" })}>
              <ArrowUpCircle />
              Update{install.update.version ? ` to ${install.update.version}` : ""}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <Confirm
          title={`Uninstall ${install.display_name ?? install.name}?`}
          confirm="Uninstall"
          fields={{ intent: "uninstall", plugin: install.ref }}
          fetcherKey={`uninstall-${install.id}`}
          trigger={
            <DropdownMenuItem onSelect={(event) => event.preventDefault()} className="text-danger data-highlighted:text-danger [&_svg]:text-danger">
              <Trash2 />
              Uninstall
            </DropdownMenuItem>
          }
        >
          Its skills leave the library, its agents leave Templates and its connectors are removed, at once. Agents hired from it stay as they are.
        </Confirm>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Discover ─────────────────────────────────────────────────────────────

function Discover({ listings }: { listings: PluginListing[] | null }) {
  const { slug, owner, username, requests } = useCustomize();
  const [params, setParams] = useSearchParams();
  if (!listings) return <NoAnswer what="Public plugins" />;
  const filters = readPluginFilters(params);
  const shown = filterPlugins(listings, filters);
  const categories = categoriesOf(listings);
  const marketplaces = [...new Set(listings.map((listing) => listing.marketplace))].sort();
  const asked = requests?.requests ?? [];
  const set = (changes: Record<string, string | null>) => setParams(nextParams(params, changes), { replace: true, preventScrollReset: true });
  const card = (listing: PluginListing) => (
    <PluginCard key={listing.ref} listing={listing} slug={slug} owner={owner} requested={requestedBy(asked, pluginListingRef(listing), username)} waiting={owner ? waitingFor(asked, pluginListingRef(listing)) : 0} />
  );
  return (
    <div className="space-y-8">
      <FeaturedBanner
        title="Install public plugins as they are"
        action={
          <ButtonLink to={customizePath("marketplaces", slug)} variant="outline" size="sm">
            <Store size={14} />
            {marketplaces.length} {marketplaces.length === 1 ? "marketplace" : "marketplaces"}
          </ButtonLink>
        }
      >
        Every plugin in the marketplaces this workspace reads, in the open plugin format: skills, agents and connectors for g1t&apos;s agents, and everything else for Claude Code on a runner. Owners add marketplaces by address.
      </FeaturedBanner>
      <div className="flex flex-wrap items-center gap-2">
        {categories.length > 0 && <FilterMenu label="Category" all="All" value={filters.category} options={categories.map((c) => ({ value: c, label: c }))} onChange={(next) => set({ category: next })} />}
        <FilterMenu label="Marketplace" all="All" value={filters.marketplace} options={marketplaces.map((m) => ({ value: m, label: m }))} onChange={(next) => set({ marketplace: next })} />
        <FilterMenu label="Sort" all="By marketplace" value={filters.sort === "name" ? "name" : null} options={[{ value: "name", label: "By name" }]} onChange={(next) => set({ sort: (next as PluginSort | null) ?? null })} />
        <span className="text-xs text-faint">
          {shown.length} of {listings.length}
        </span>
      </div>
      {shown.length === 0 ? (
        <EmptyState title="No plugin matches">Try another word, category or marketplace, or add a marketplace that lists it.</EmptyState>
      ) : filters.sort === "name" ? (
        <ListingGrid>{shown.map(card)}</ListingGrid>
      ) : (
        groupByMarketplace(shown).map((group) => (
          <section key={group.marketplace} aria-labelledby={`from-${group.marketplace}`}>
            <SectionHead id={`from-${group.marketplace}`} title={`From ${group.marketplace}`} aside={`${group.items.length}`} />
            <ListingGrid>{group.items.map(card)}</ListingGrid>
          </section>
        ))
      )}
    </div>
  );
}

/** A plugin in Discover: what it is and who made it, whether it can be installed here, and Install or Request. */
function PluginCard({ listing, slug, owner, requested, waiting }: { listing: PluginListing; slug: string; owner: boolean; requested: boolean; waiting: number }) {
  const fetcher = useFetcher<ActionResult>({ key: `discover-plugin-${listing.ref}` });
  const error = fetcher.state === "idle" && fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;
  const name = listing.display_name ?? listing.name;
  const available = listing.availability.kind === "available";
  const action = !available ? null : owner ? (
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value="install" />
      <input type="hidden" name="plugin" value={listing.ref} />
      <SubmitButton size="xs" fetcher={fetcher} match={{ intent: "install", plugin: listing.ref }} pending="Installing…">
        <Plus size={13} />
        Install
      </SubmitButton>
    </fetcher.Form>
  ) : (
    <RequestButton slug={slug} listing={pluginListingRef(listing)} name={name} requested={requested} size="xs" />
  );
  return (
    <ListingCard
      mark={<ListingMark id={listing.ref} name={name} />}
      title={name}
      to={pluginPath(slug, listing.ref)}
      description={listing.description}
      muted={listing.availability.kind === "soon" || listing.availability.kind === "unavailable"}
      badge={available ? null : <AvailabilityBadge availability={listing.availability} />}
      meta={
        <>
          {listing.author ? `by ${listing.author} · ` : ""}
          {listing.marketplace}
          {listing.version ? ` · v${listing.version}` : ""}
          {waiting > 0 && (
            <>
              {" · "}
              <Waiting slug={slug} count={waiting} />
            </>
          )}
        </>
      }
      action={action}
    >
      {(listing.skills.length > 0 || listing.category) && (
        <Chips items={[...(listing.category ? [listing.category] : []), ...listing.skills.slice(0, 4), ...(listing.skills.length > 4 ? [`+${listing.skills.length - 4} more`] : [])]} muted={!available} label="What it brings" />
      )}
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </ListingCard>
  );
}
