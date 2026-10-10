/**
 * Integrations in the Marketplace: every connector a workspace can connect
 * today, connected ones first; those each person connects for themselves;
 * then the ones the catalog lists as coming. Each workspace one is set up
 * on its own page under Workspace → Integrations; owners connect, anyone
 * else asks.
 */
import { Search } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";

import { type ConnectorView, connectorView, connectorsFor, CONNECTORS } from "@g1t/contracts/connectors";

import type { Route } from "./+types/integrations";
import { ConnectorMark } from "../../../components/connectors";
import { ComingBadge, IntegrationCard, SectionHead } from "../../../components/marketplace";
import { comingIntegrations, integrationListings, integrationMatches } from "../../../lib/marketplace";
import { loadConnected } from "../../../lib/marketplace.server";
import { requireUser, roleIn } from "../../../lib/session.server";
import { useMarketplace } from "./layout";

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  if (!roleIn(viewer, slug)) throw new Response(null, { status: 404 });
  return { connected: await loadConnected(slug, viewer) };
}

export default function MarketplaceIntegrations({ loaderData }: Route.ComponentProps) {
  const { slug, owner, username, requests } = useMarketplace();
  const [query, setQuery] = useState("");
  const views = connectorsFor("workspace");
  const all = integrationListings(views, loaderData.connected, requests?.requests ?? [], username, slug);
  const shown = all.filter((listing) => integrationMatches(listing, query));
  const connected = shown.filter((listing) => listing.connected);
  const available = shown.filter((listing) => !listing.connected);
  const wanted = query.trim().toLowerCase();
  const personal = CONNECTORS.filter((c) => !c.scopes.includes("workspace")).map((c) => connectorView(c, "personal")).filter((view) => view != null);
  // What each person connects for themselves, today.
  const yours = CONNECTORS.map((c) => connectorView(c, "personal")).filter((view): view is ConnectorView & { href: string } => view != null && view.status === "available" && view.href != null && (!wanted || [view.name, view.description, ...view.keywords].some((w) => w.toLowerCase().includes(wanted))));
  const coming = comingIntegrations(views, personal).filter((view) => !wanted || [view.name, view.description, ...view.keywords].some((w) => w.toLowerCase().includes(wanted)));
  return (
    <div className="space-y-10">
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

      {connected.length > 0 && (
        <section aria-labelledby="connected">
          <SectionHead id="connected" title="Connected" aside={`${connected.length}`} />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {connected.map((listing) => (
              <IntegrationCard key={listing.ref} listing={listing} slug={slug} owner={owner} />
            ))}
          </div>
        </section>
      )}

      <section aria-labelledby="available">
        <SectionHead id="available" title={connected.length > 0 ? "Available" : "Available to connect"} aside={`${available.length}`}>
          Connected once for the whole workspace by an owner. Each says what it lets agents do.
        </SectionHead>
        {available.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">{wanted ? "No integration you can connect matches." : "Everything available is connected."}</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {available.map((listing) => (
              <IntegrationCard key={listing.ref} listing={listing} slug={slug} owner={owner} />
            ))}
          </div>
        )}
      </section>

      {yours.length > 0 && (
        <section aria-labelledby="yours">
          <SectionHead id="yours" title="Connected by each person" aside={`${yours.length}`}>
            Each person connects these for themselves, and agents use them only when that person asks.
          </SectionHead>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {yours.map((view) => (
              <li key={view.id} className="flex flex-col rounded-xl border border-line bg-surface p-4">
                <div className="flex grow items-start gap-3">
                  <ConnectorMark view={view} size={40} />
                  <div className="min-w-0 grow">
                    <h3 className="truncate text-sm font-semibold">{view.name}</h3>
                    <p className="mt-0.5 line-clamp-2 text-[0.8125rem] leading-snug text-muted">{view.description}</p>
                  </div>
                </div>
                <div className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-3">
                  <span className="truncate text-xs text-faint">Each person's own</span>
                  <Link to={view.href} className="inline-flex h-8 shrink-0 items-center rounded-md border border-line px-3 text-[0.8125rem] font-medium text-fg/85 hover:border-line-strong hover:bg-raised hover:text-fg">
                    Connect yours
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {coming.length > 0 && (
        <section aria-labelledby="coming">
          <SectionHead id="coming" title="Coming" aside={<ComingBadge />}>
            Planned, not built. Nobody can connect these yet.
          </SectionHead>
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {coming.map((view) => (
              <li key={view.id} className="flex items-center gap-3 rounded-lg border border-dashed border-line px-3 py-2.5">
                <ConnectorMark view={view} size={28} />
                <span className="min-w-0">
                  <span className="block truncate text-sm">{view.name}</span>
                  <span className="block truncate text-xs text-faint">{view.description}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
