/**
 * Integrations in the Marketplace, by who builds them: every connector is
 * g1t's own (Official), so that section holds the ones connected, the ones
 * a workspace can connect today, any this g1t can't connect (with why),
 * those each person connects for themselves, and the ones the catalog
 * lists as coming; Verified, Community and Internal are sections too,
 * empty and saying so. Search, and filters by tier and availability, kept
 * in the address. Each workspace one is set up on its own page under
 * Workspace → Integrations; owners connect, anyone else asks.
 */
import { Search } from "lucide-react";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";

import { CONNECTORS, connectorView, connectorsFor } from "@g1t/contracts/connectors";

import type { Route } from "./+types/integrations";
import { IntegrationCard, IntegrationRow, ListingFilterBar, ListingLegend, SectionHead, TierBadge, TierEmpty, filterCounts } from "../../../components/marketplace";
import { type IntegrationListing, comingListings, integrationListings, integrationMatches, passes, personalListings, readFilters, tiersShown } from "../../../lib/marketplace";
import { loadConnected } from "../../../lib/marketplace.server";
import { requireUser, roleIn } from "../../../lib/session.server";
import { useMarketplace } from "./layout";

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  if (!roleIn(viewer, slug)) throw new Response(null, { status: 404 });
  return await loadConnected(slug, viewer);
}

const HEADINGS = { official: "From g1t", verified: "From verified publishers", community: "From the community", internal: "Built in this workspace" } as const;

export default function MarketplaceIntegrations({ loaderData }: Route.ComponentProps) {
  const { slug, owner, username, requests } = useMarketplace();
  const [query, setQuery] = useState("");
  const [params] = useSearchParams();
  const filters = readFilters(params);
  const views = connectorsFor("workspace");
  const personalViews = CONNECTORS.map((c) => connectorView(c, "personal")).filter((view) => view != null);
  const workspace = integrationListings(views, loaderData.connected, requests?.requests ?? [], username, slug, loaderData.unavailable);
  // What each person connects for themselves, today; and what is coming, for either.
  const yours = personalListings(personalViews, slug, loaderData.unavailable);
  const coming = comingListings(
    views,
    personalViews.filter((view) => !CONNECTORS.find((c) => c.id === view.id)?.scopes.includes("workspace")),
    slug,
  );
  const everything = [...workspace, ...yours, ...coming];
  const wanted = query.trim().toLowerCase();
  const keep = (listing: IntegrationListing) => integrationMatches(listing, query) && passes(listing, filters);
  // A search or an availability filter can empty a tier; the tier filter alone only picks one.
  const filtered = wanted !== "" || filters.availability !== "all";
  // A plain function, not a component made each render: that would remount the cards (and close a request's dialog).
  const grid = (items: IntegrationListing[]) => (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((listing) => (
        <IntegrationCard key={`${listing.scope}:${listing.ref}`} listing={listing} slug={slug} owner={owner} />
      ))}
    </div>
  );
  return (
    <div className="space-y-10">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex h-9 w-full max-w-sm items-center gap-2 rounded-lg border border-line bg-surface px-2.5 text-sm focus-within:border-line-strong">
            <Search size={15} className="shrink-0 text-faint" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find an integration"
              aria-label="Find an integration"
              autoComplete="off"
              className="min-w-0 grow bg-transparent outline-none placeholder:text-faint"
            />
          </label>
          <Link to={`/${slug}/-/integrations`} className="text-[0.8125rem] text-muted hover:text-fg">
            Workspace integrations settings
          </Link>
        </div>
        <ListingFilterBar kind="integration" filters={filters} counts={filterCounts(everything)} />
      </div>

      {tiersShown(filters).map((tier) => {
        const connected = workspace.filter((l) => l.tier === tier && l.availability === "added" && keep(l));
        const available = workspace.filter((l) => l.tier === tier && l.availability === "available" && keep(l));
        const blocked = workspace.filter((l) => l.tier === tier && l.availability === "unavailable" && keep(l));
        const own = yours.filter((l) => l.tier === tier && keep(l));
        const soon = coming.filter((l) => l.tier === tier && keep(l));
        const count = connected.length + available.length + blocked.length + own.length + soon.length;
        return (
          <section key={tier} aria-labelledby={`tier-${tier}`} className="space-y-8">
            <SectionHead
              id={`tier-${tier}`}
              title={
                <>
                  <TierBadge tier={tier} />
                  {HEADINGS[tier]}
                </>
              }
              aside={`${count}`}
            >
              {tier === "official" && count > 0 ? "Every connector in the catalog is built and supported by g1t. Each says what it lets agents do." : null}
            </SectionHead>
            {count === 0 && <TierEmpty tier={tier} kind="integration" filtered={filtered} />}
            {connected.length > 0 && (
              <div>
                <SectionHead sub id={`${tier}-connected`} title="Connected" aside={`${connected.length}`} />
                {grid(connected)}
              </div>
            )}
            {available.length > 0 && (
              <div>
                <SectionHead sub id={`${tier}-available`} title="Available to connect" aside={`${available.length}`}>
                  Connected once for the whole workspace by an owner.
                </SectionHead>
                {grid(available)}
              </div>
            )}
            {blocked.length > 0 && (
              <div>
                <SectionHead sub id={`${tier}-unavailable`} title="Not available here" aside={`${blocked.length}`}>
                  This g1t lacks something these need. Each says what.
                </SectionHead>
                {grid(blocked)}
              </div>
            )}
            {own.length > 0 && (
              <div>
                <SectionHead sub id={`${tier}-yours`} title="Connected by each person" aside={`${own.length}`}>
                  Each person connects these for themselves, and agents use them only when that person asks.
                </SectionHead>
                {grid(own)}
              </div>
            )}
            {soon.length > 0 && (
              <div>
                <SectionHead sub id={`${tier}-soon`} title="Soon" aside={`${soon.length}`}>
                  Planned, not built. Nobody can connect these yet.
                </SectionHead>
                <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {soon.map((listing) => (
                    <IntegrationRow key={listing.ref} listing={listing} />
                  ))}
                </ul>
              </div>
            )}
          </section>
        );
      })}
      <ListingLegend kind="integration" />
    </div>
  );
}
