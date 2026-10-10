/**
 * Extensions in the Marketplace: every listed extension, from its
 * manifest (@g1t/contracts marketplace.ts), by who builds it (Official,
 * Verified, Community, Internal), each tier a section even while it has
 * nothing, so it is plain what is whose. Filters by tier and availability
 * live in the address. Then how extensions are shared, and the legend.
 */
import { useSearchParams } from "react-router";

import type { ListingTier } from "@g1t/contracts";
import { FIRST_PARTY_EXTENSIONS } from "@g1t/contracts/marketplace";

import { ExtensionCard, ListingFilterBar, ListingLegend, SectionHead, TierBadge, TierEmpty, filterCounts } from "../../../components/marketplace";
import { type ExtensionListing, extensionListings, isConnectedSystem, passes, readFilters, tiersShown } from "../../../lib/marketplace";
import { useMarketplace } from "./layout";

/** Each tier's section heading on the Extensions tab. */
const HEADINGS: Record<ListingTier, string> = {
  official: "From g1t",
  verified: "From verified publishers",
  community: "From the community",
  internal: "Built in this workspace",
};

export default function MarketplaceExtensions() {
  const { slug, owner, username, requests, installs } = useMarketplace();
  const [params] = useSearchParams();
  const filters = readFilters(params);
  // A search or an availability filter can empty a tier; the tier filter alone only picks one.
  const filtered = filters.availability !== "all";
  const listings = extensionListings(FIRST_PARTY_EXTENSIONS, installs, requests?.requests ?? [], username);
  const shown = listings.filter((listing) => passes(listing, filters));
  const grid = (items: ExtensionListing[]) => (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((listing) => (
        <ExtensionCard key={listing.ref} listing={listing} slug={slug} owner={owner} />
      ))}
    </div>
  );
  return (
    <div className="space-y-10">
      <ListingFilterBar kind="extension" filters={filters} counts={filterCounts(listings)} />
      {tiersShown(filters).map((tier) => {
        const mine = shown.filter((listing) => listing.tier === tier);
        const apps = mine.filter((listing) => !isConnectedSystem(listing.manifest));
        const systems = mine.filter((listing) => isConnectedSystem(listing.manifest));
        return (
          <section key={tier} aria-labelledby={`tier-${tier}`}>
            <SectionHead
              id={`tier-${tier}`}
              title={
                <>
                  <TierBadge tier={tier} />
                  {HEADINGS[tier]}
                </>
              }
              aside={`${mine.length}`}
            >
              {tier === "official" && mine.length > 0
                ? "g1t's own, listed before their first release so you can see what each adds and may do. Each can be installed once it is published."
                : null}
            </SectionHead>
            {mine.length === 0 ? (
              <TierEmpty tier={tier} kind="extension" filtered={filtered} />
            ) : (
              <div className="space-y-6">
                {apps.length > 0 && grid(apps)}
                {systems.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold">Connected systems</h3>
                    <p className="mt-0.5 mb-3 max-w-2xl text-sm text-muted">
                      Extensions that bridge a system your team already runs, so agents work across it and g1t together. Each page names where its data goes.
                    </p>
                    {grid(systems)}
                  </div>
                )}
              </div>
            )}
          </section>
        );
      })}
      <section aria-labelledby="how" className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
        <h2 id="how" className="text-base font-semibold tracking-tight">
          How extensions are shared
        </h2>
        <ul className="mt-3 max-w-3xl space-y-2 text-sm text-muted">
          <li>An extension is a public repository on g1t with a manifest. Tagging a release publishes a version.</li>
          <li>An install keeps the version it was installed at. Updates are offered to owners, never forced.</li>
          <li>Before anything is added, the install screen lists every permission, and says which domains outside g1t its data goes to.</li>
          <li>Its pages load in a sandboxed frame from g1t's user-content domain, and reach g1t only through what it was allowed.</li>
          <li>Every call it makes is in the audit log. Owners can cap what it spends, and switch it off at once.</li>
        </ul>
      </section>
      <ListingLegend kind="extension" />
    </div>
  );
}
