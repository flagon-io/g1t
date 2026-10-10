/**
 * The Marketplace's front page: featured extensions, integrations
 * (connected first), starter kits, and connected systems. Every listing is
 * real: integrations a workspace can connect today, with their real state,
 * and g1t's own extensions marked Soon until their first release.
 */
import { Link } from "react-router";

import { type ExtensionManifest, FIRST_PARTY_EXTENSIONS, extensionById } from "@g1t/contracts/marketplace";
import { connectorsFor } from "@g1t/contracts/connectors";

import type { Route } from "./+types/discover";
import { ComingBadge, ExtensionCard, ExtensionMark, IntegrationCard, SectionHead, SeeAll, StarterKitCard, TierBadge } from "../../../components/marketplace";
import { STARTER_KITS, extensionListings, extensionPath, integrationListings, isConnectedSystem, marketplacePath } from "../../../lib/marketplace";
import { loadConnected } from "../../../lib/marketplace.server";
import { requireUser, roleIn } from "../../../lib/session.server";
import { useMarketplace } from "./layout";

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  if (!roleIn(viewer, slug)) throw new Response(null, { status: 404 });
  return { connected: await loadConnected(slug, viewer) };
}

/** How many integrations the front page shows before "All". */
const INTEGRATIONS_SHOWN = 6;
/** The extensions the front page leads with: the first the largest. */
const FEATURED = ["mail", "support", "crm"];

export default function MarketplaceDiscover({ loaderData }: Route.ComponentProps) {
  const { slug, owner, username, requests, installs } = useMarketplace();
  const asked = requests?.requests ?? [];
  const integrations = integrationListings(connectorsFor("workspace"), loaderData.connected, asked, username, slug);
  const extensions = extensionListings(FIRST_PARTY_EXTENSIONS, installs, asked, username);
  const featured = FEATURED.map((id) => extensionById(id)).filter((manifest) => manifest != null);
  const bridges = extensions.filter((listing) => isConnectedSystem(listing.manifest));
  return (
    <div className="space-y-12">
      <section aria-labelledby="featured">
        <h2 id="featured" className="sr-only">
          Featured extensions
        </h2>
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          {featured[0] && <Feature manifest={featured[0]} slug={slug} large />}
          <div className="grid gap-3">
            {featured.slice(1).map((manifest) => (
              <Feature key={manifest.id} manifest={manifest} slug={slug} />
            ))}
          </div>
        </div>
      </section>

      <section aria-labelledby="integrations">
        <SectionHead id="integrations" title="Integrations" aside={<SeeAll to={marketplacePath(slug, "integrations")}>All integrations</SeeAll>}>
          Connect what your team already uses, so agents can read it and act in it. Each lists, in plain words, what it lets agents do.
        </SectionHead>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {integrations.slice(0, INTEGRATIONS_SHOWN).map((listing) => (
            <IntegrationCard key={listing.ref} listing={listing} slug={slug} owner={owner} />
          ))}
        </div>
      </section>

      <section aria-labelledby="kits">
        <SectionHead id="kits" title="Starter kits" aside="Several extensions, one install">
          A set of extensions for one kind of team, installed together.
        </SectionHead>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {STARTER_KITS.map((kit) => (
            <StarterKitCard key={kit.id} kit={kit} slug={slug} extensions={kit.extensions.map((id) => extensionById(id)).filter((manifest) => manifest != null)} />
          ))}
        </div>
      </section>

      <section aria-labelledby="systems">
        <SectionHead id="systems" title="Connected systems" aside={<SeeAll to={marketplacePath(slug, "extensions")}>All extensions</SeeAll>}>
          Extensions that bridge a helpdesk, CRM or ERP you already run, so agents work across it and g1t together.
        </SectionHead>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {bridges.map((listing) => (
            <ExtensionCard key={listing.ref} listing={listing} slug={slug} owner={owner} />
          ))}
        </div>
      </section>
    </div>
  );
}

/** A featured extension: its mark, name and tagline, and the pages it adds. */
function Feature({ manifest, slug, large = false }: { manifest: ExtensionManifest; slug: string; large?: boolean }) {
  return (
    <Link
      to={extensionPath(slug, manifest.id)}
      prefetch="intent"
      className={`group relative flex flex-col justify-end overflow-hidden rounded-2xl border border-line bg-surface transition-colors hover:border-line-strong ${large ? "min-h-64 p-6" : "min-h-36 p-4"}`}
    >
      {/* A wash of the accent, from the corner. */}
      <span aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_120%_at_100%_0%,var(--color-accent)_0%,transparent_55%)] opacity-[0.12]" />
      <div className="relative flex items-center gap-2">
        <ExtensionMark manifest={manifest} size={large ? 36 : 28} />
        <TierBadge tier={manifest.publisher.tier} />
        {manifest.status !== "available" && <ComingBadge />}
      </div>
      <h3 className={`relative mt-3 font-semibold tracking-tight ${large ? "text-2xl" : "text-base"}`}>{manifest.name}</h3>
      <p className={`relative mt-1 max-w-xl text-muted ${large ? "text-[0.9375rem]" : "line-clamp-2 text-[0.8125rem]"}`}>{large ? manifest.description : manifest.tagline}</p>
      {large && (
        <ul className="relative mt-4 flex flex-wrap gap-1.5" aria-label="Pages it adds">
          {manifest.adds.pages.map((name) => (
            <li key={name} className="rounded-full border border-line bg-bg/60 px-2.5 py-0.5 text-xs text-fg-soft">
              {name}
            </li>
          ))}
        </ul>
      )}
    </Link>
  );
}
