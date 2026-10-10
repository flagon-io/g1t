/**
 * The Marketplace's front page: what comes with every workspace, roles
 * from the agent catalog, integrations (connected first) and extensions.
 * Every listing is real: what can be added today with its real state, or
 * g1t's own extensions marked Soon until their first release.
 */
import { Rocket } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { connectorsFor } from "@g1t/contracts/connectors";

import type { Route } from "./+types/discover";
import { appIcon } from "../../../components/apps";
import { AgentCard, ExtensionCard, IntegrationCard, SectionHead, SeeAll } from "../../../components/marketplace";
import { G1tMark } from "../../../components/orchestrator";
import { EmptyState } from "../../../components/ui";
import { appOf } from "../../../lib/apps";
import { FIRST_PARTY_EXTENSIONS } from "@g1t/contracts/marketplace";
import { agentListings, extensionListings, integrationListings, marketplacePath } from "../../../lib/marketplace";
import { loadCatalog, loadConnected } from "../../../lib/marketplace.server";
import { requireUser, roleIn } from "../../../lib/session.server";
import { useMarketplace } from "./layout";

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  if (!roleIn(viewer, slug)) throw new Response(null, { status: 404 });
  const [catalog, connected] = await Promise.all([loadCatalog(slug, viewer), loadConnected(slug, viewer)]);
  return { ...catalog, connected };
}

/** How many of each kind of listing the front page shows before "All". */
const AGENTS_SHOWN = 5;
const INTEGRATIONS_SHOWN = 6;

export default function MarketplaceDiscover({ loaderData }: Route.ComponentProps) {
  const { slug, owner, username, requests, installs } = useMarketplace();
  const asked = requests?.requests ?? [];
  const agents = agentListings(loaderData.templates ?? [], loaderData.agents, asked, username);
  const integrations = integrationListings(connectorsFor("workspace"), loaderData.connected, asked, username, slug);
  const extensions = extensionListings(FIRST_PARTY_EXTENSIONS, installs, asked, username);
  const builtIn: { name: string; to: string; icon: ReactNode }[] = [
    ...(["code", "chat", "agents", "artifacts"] as const).map((key) => ({ name: appOf(key).name, to: appOf(key).path(slug), icon: appIcon(key, 15) })),
    { name: "Deployments", to: `/${slug}/-/projects`, icon: <Rocket size={15} /> },
  ];
  return (
    <div className="space-y-12">
      <section aria-labelledby="included" className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="included" className="text-base font-semibold tracking-tight">
            In every workspace
          </h2>
          <span className="text-xs text-faint">Nothing to add</span>
        </div>
        <p className="mt-1 max-w-2xl text-sm text-muted">Code and Deployments are built in, because what agents make has to be reviewed, tested and shipped. So are Chat, Agents and Artifacts.</p>
        <ul className="mt-4 flex flex-wrap gap-2">
          {builtIn.map(({ name, to, icon }) => (
            <li key={name}>
              <Link to={to} className="flex h-9 items-center gap-2 rounded-full border border-line bg-bg pr-3.5 pl-2.5 text-sm transition-colors hover:border-line-strong">
                <span className="text-muted">{icon}</span>
                {name}
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="agents">
        <SectionHead id="agents" title="Agents" aside={agents.length > 0 && <SeeAll to={marketplacePath(slug, "agents")}>All {agents.length} roles</SeeAll>}>
          Each role brings responsibilities, a voice and the helpers it works with. Add one and rename it, or keep to g1t, which brings in whoever fits.
        </SectionHead>
        {loaderData.templates == null ? (
          <EmptyState title="The agent catalog can't be shown right now">The agents service didn't answer. Reload in a minute.</EmptyState>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Link
              to={`/${slug}/-/agents`}
              className="flex flex-col rounded-xl border border-accent/30 bg-accent/[0.06] p-4 transition-colors hover:border-accent/60"
            >
              <div className="flex items-center gap-3">
                <G1tMark size={44} />
                <div className="min-w-0">
                  <p className="text-sm font-semibold">g1t</p>
                  <p className="text-xs text-muted">Orchestrator · in every workspace</p>
                </div>
              </div>
              <p className="mt-3 grow text-[0.8125rem] leading-snug text-muted">Ask g1t anything. It answers itself or hands the work to the agent that fits, and you see the hand-off.</p>
              <p className="mt-4 border-t border-accent/20 pt-3 text-xs text-accent">Already here</p>
            </Link>
            {agents.slice(0, AGENTS_SHOWN).map((listing) => (
              <AgentCard key={listing.ref} listing={listing} slug={slug} owner={owner} />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="integrations">
        <SectionHead id="integrations" title="Integrations" aside={<SeeAll to={marketplacePath(slug, "integrations")}>All {integrations.length}</SeeAll>}>
          Integrations connect what you already use and give agents new abilities, without adding pages.
        </SectionHead>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {integrations.slice(0, INTEGRATIONS_SHOWN).map((listing) => (
            <IntegrationCard key={listing.ref} listing={listing} slug={slug} owner={owner} />
          ))}
        </div>
      </section>

      <section aria-labelledby="extensions">
        <SectionHead id="extensions" title="Extensions" aside={<SeeAll to={marketplacePath(slug, "extensions")}>All extensions</SeeAll>}>
          Extensions add pages, data, cards and agent roles for what your team does besides code. Each is shared from a public repository, and the install screen lists every permission and every domain its data goes to.
        </SectionHead>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {extensions.map((listing) => (
            <ExtensionCard key={listing.ref} listing={listing} slug={slug} owner={owner} />
          ))}
        </div>
      </section>
    </div>
  );
}
