/**
 * One integration's page: who builds it, whether this workspace can
 * connect it (or has), and exactly what it lets agents and people do
 * today and what is still Soon, from the connector catalog
 * (@g1t/contracts/connectors) for each way it is connected: for the
 * whole workspace, and for each person.
 */
import { ArrowLeft, Clock, ShieldCheck, Users } from "lucide-react";
import { Link, data } from "react-router";

import { connectorById, connectorView } from "@g1t/contracts/connectors";

import type { Route } from "./+types/integration";
import { ConnectorMark } from "../../../components/connectors";
import { AvailabilityBadge, IntegrationAction, ListingFacts } from "../../../components/marketplace";
import { cn } from "../../../lib/cn";
import { type IntegrationUse, TIERS, categoryTitle, comingListings, integrationListings, integrationUses, marketplacePath, personalListings } from "../../../lib/marketplace";
import { loadConnected } from "../../../lib/marketplace.server";
import { page } from "../../../lib/meta";
import { requireUser, roleIn } from "../../../lib/session.server";
import { useMarketplace } from "./layout";
import { Card } from "../../../components/ui/card";

export function meta({ params, ...args }: Route.MetaArgs) {
  const connector = connectorById(params.integration);
  return page(args, { title: `${connector?.name ?? "Integration"} · Marketplace · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  if (!roleIn(viewer, slug)) throw data(null, { status: 404 });
  if (!connectorById(params.integration)) throw data(null, { status: 404 });
  return await loadConnected(slug, viewer);
}

export default function MarketplaceIntegration({ params, loaderData }: Route.ComponentProps) {
  const { slug, owner, username, requests } = useMarketplace();
  const connector = connectorById(params.integration)!;
  const workspaceView = connectorView(connector, "workspace");
  const personalView = connectorView(connector, "personal");
  // The listing this page acts on: the workspace's, or each person's when it is only theirs.
  const listing = workspaceView
    ? workspaceView.status === "available"
      ? integrationListings([workspaceView], loaderData.connected, requests?.requests ?? [], username, slug, loaderData.unavailable)[0]!
      : comingListings([workspaceView], [], slug)[0]!
    : personalView!.status === "available" && personalView!.href
      ? personalListings([personalView!], slug, loaderData.unavailable)[0]!
      : comingListings([], [personalView!], slug)[0]!;
  const uses = integrationUses(connector);
  const tier = TIERS[listing.tier];
  return (
    <div>
      <Link to={marketplacePath(slug, "integrations")} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} />
        All integrations
      </Link>
      <header className="mt-5 flex flex-wrap items-center gap-4">
        <span className={cn("shrink-0", (listing.availability === "soon" || listing.availability === "unavailable") && "opacity-60 grayscale")}>
          <ConnectorMark view={listing.view} size={64} />
        </span>
        <div className="min-w-0 grow basis-60">
          <h2 className="text-xl font-semibold tracking-tight">{connector.name}</h2>
          <ListingFacts tier={listing.tier} publisher={listing.publisher} category={categoryTitle(connector.category)}>
            <AvailabilityBadge
              availability={listing.availability}
              kind="integration"
              why={listing.why}
              hint={listing.availability === "available" && !owner && listing.scope === "workspace" ? "An owner connects it for everyone. Ask one with Request." : undefined}
            />
          </ListingFacts>
        </div>
        <IntegrationAction listing={listing} slug={slug} owner={owner} className="h-9 px-4 text-sm" />
      </header>
      {listing.availability === "unavailable" && listing.why && (
        <p className="mt-5 max-w-3xl rounded-lg border border-dashed border-line-strong px-4 py-3 text-sm text-muted">
          <span className="font-medium text-fg-soft">Not available here.</span> {listing.why}
        </p>
      )}
      {listing.availability === "soon" && (
        <p className="mt-5 max-w-3xl rounded-lg border border-dashed border-line-strong px-4 py-3 text-sm text-muted">
          Planned, not built yet: nobody can connect it. This page shows what it will do.
        </p>
      )}
      <p className="mt-6 max-w-3xl text-[0.9375rem] leading-relaxed text-fg-soft">{listing.view.description}</p>

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section aria-labelledby="does" className="min-w-0">
          <h3 id="does" className="text-sm font-semibold">
            What it lets agents and people do
          </h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <h4 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-success">
                <ShieldCheck size={13} />
                {listing.availability === "unavailable" ? "Once it can be connected here" : "Today"}
              </h4>
              {uses.today.length === 0 ? (
                <Card asChild tone="plain" className="border-dashed px-4 py-4 text-sm text-muted">
                  <p>Nothing yet. It can't be connected until it is built.</p>
                </Card>
              ) : (
                <div className="space-y-3">
                  {uses.today.map((use) => (
                    <Use key={use.scope} use={use} said={listing.view.description} />
                  ))}
                </div>
              )}
            </div>
            <div>
              <h4 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted">
                <Clock size={13} />
                Soon
              </h4>
              {uses.soon.length === 0 ? (
                <Card asChild tone="plain" className="border-dashed px-4 py-4 text-sm text-muted">
                  <p>Nothing more is planned for it yet.</p>
                </Card>
              ) : (
                <div className="space-y-3">
                  {uses.soon.map((use) => (
                    <Use key={use.scope} use={use} said={listing.view.description} soon />
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>

        <aside className="text-sm">
          <Card asChild className="space-y-3 p-4">
            <dl>
              <div>
                <dt className="text-xs text-faint">Publisher</dt>
                <dd className="mt-0.5">
                  {listing.publisher} · {tier.label}
                  <span className="block text-xs text-muted">{tier.about}</span>
                </dd>
              </div>
              <div>
                <dt className="flex items-center gap-1.5 text-xs text-faint">
                  <Users size={12} />
                  Who connects it
                </dt>
                <dd className="mt-0.5">
                  {connector.scopes.includes("workspace") && connector.scopes.includes("personal")
                    ? "An owner, once for the whole workspace; and each person, for their own account."
                    : connector.scopes.includes("workspace")
                      ? "An owner, once for the whole workspace."
                      : "Each person, for their own account. Agents use it only when that person asks."}
                </dd>
              </div>
              {listing.connected && (
                <div>
                  <dt className="text-xs text-faint">Connected</dt>
                  <dd className="mt-0.5 break-words">{listing.connected.detail}</dd>
                  {listing.connected.problem && <dd className="mt-1 text-warn">{listing.connected.problem}</dd>}
                </div>
              )}
            </dl>
          </Card>
        </aside>
      </div>
    </div>
  );
}

/** One way it is connected: who connects it, what it does that way, and its capabilities. */
function Use({ use, said, soon = false }: { use: IntegrationUse; said: string; soon?: boolean }) {
  return (
    <div className={cn("rounded-xl border p-4", soon ? "border-dashed border-line-strong/70" : "border-line bg-surface")}>
      <p className="text-xs text-faint">{use.who}</p>
      {use.description !== said && <p className={cn("mt-1 text-sm", soon ? "text-muted" : "text-fg-soft")}>{use.description}</p>}
      {use.capabilities.length > 0 && (
        <ul className="mt-2.5 flex flex-wrap gap-1.5" aria-label={soon ? "What it will do" : "What it does"}>
          {use.capabilities.map((capability) => (
            <li key={capability} className={cn("rounded-full px-2 py-px text-[0.6875rem]", soon ? "border border-dashed border-line text-faint" : "bg-raised text-fg-soft")}>
              {capability}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
