/**
 * Extensions in the Marketplace: every listed extension, from its
 * manifest (@g1t/contracts marketplace.ts), published ones first, with what
 * the workspace installed; then how extensions are published and who
 * stands behind each tier.
 */
import { FIRST_PARTY_EXTENSIONS, LISTING_TIERS } from "@g1t/contracts/marketplace";

import { ExtensionCard, SectionHead, TierBadge } from "../../../components/marketplace";
import { TIERS, extensionListings } from "../../../lib/marketplace";
import { useMarketplace } from "./layout";

export default function MarketplaceExtensions() {
  const { slug, owner, username, requests, installs } = useMarketplace();
  const listings = extensionListings(FIRST_PARTY_EXTENSIONS, installs, requests?.requests ?? [], username);
  const published = listings.filter((l) => l.manifest.status === "available");
  const coming = listings.filter((l) => l.manifest.status !== "available");
  return (
    <div className="space-y-12">
      {published.length > 0 && (
        <section aria-labelledby="published">
          <SectionHead id="published" title="Ready to install" aside={`${published.length}`} />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {published.map((listing) => (
              <ExtensionCard key={listing.ref} listing={listing} slug={slug} owner={owner} />
            ))}
          </div>
        </section>
      )}
      <section aria-labelledby="soon">
        <SectionHead id="soon" title={published.length > 0 ? "Coming" : "Coming from g1t"} aside={`${coming.length}`}>
          Extensions add pages, data, cards and agent roles for what your team does besides code. These are g1t's own, listed before their first release; each can be installed once it is published.
        </SectionHead>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {coming.map((listing) => (
            <ExtensionCard key={listing.ref} listing={listing} slug={slug} owner={owner} />
          ))}
        </div>
      </section>
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
        <ul className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {LISTING_TIERS.map((tier) => (
            <li key={tier} className="rounded-xl border border-line bg-bg p-4">
              <TierBadge tier={tier} />
              <p className="mt-2.5 text-[0.8125rem] leading-snug text-muted">{TIERS[tier].about}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
