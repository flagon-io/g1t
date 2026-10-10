/**
 * The agent catalog: every role an agent can be hired into, by
 * department, with who in the workspace was hired into each. Owners add
 * one through the new-agent form with the role chosen; anyone else asks.
 */
import type { Route } from "./+types/agents";
import { AgentCard } from "../../../components/marketplace";
import { G1tMark } from "../../../components/orchestrator";
import { EmptyState } from "../../../components/ui";
import { agentListings } from "../../../lib/marketplace";
import { loadCatalog } from "../../../lib/marketplace.server";
import { requireUser, roleIn } from "../../../lib/session.server";
import { useMarketplace } from "./layout";

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  if (!roleIn(viewer, slug)) throw new Response(null, { status: 404 });
  return loadCatalog(slug, viewer);
}

export default function AgentCatalog({ loaderData }: Route.ComponentProps) {
  const { slug, owner, username, requests } = useMarketplace();
  if (loaderData.templates == null) {
    return <EmptyState title="The agent catalog can't be shown right now">The agents service didn't answer. Reload in a minute.</EmptyState>;
  }
  const listings = agentListings(loaderData.templates, loaderData.agents, requests?.requests ?? [], username);
  // By department, in the order the catalog lists them.
  const departments = new Map<string, typeof listings>();
  for (const listing of listings) {
    const key = listing.template.department || "Other";
    departments.set(key, [...(departments.get(key) ?? []), listing]);
  }
  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-start gap-4 rounded-2xl border border-line bg-surface p-5">
        <G1tMark size={40} />
        <div className="min-w-0 grow basis-72">
          <p className="text-sm font-semibold">Start with g1t, add specialists as the work grows</p>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            g1t, the orchestrator, is in every workspace and knows every agent in it. Each role below is a starting point: pick a name, a team and a budget when you add it, and change anything after. Every agent works with the access of the person asking, never more, and starts with the workspace's default budget.
          </p>
        </div>
        <p className="shrink-0 text-xs text-faint">
          {listings.length} {listings.length === 1 ? "role" : "roles"}, built by g1t
        </p>
      </div>
      {[...departments].map(([department, list]) => (
        <section key={department} aria-label={department}>
          <h2 className="mb-3 text-xs font-semibold tracking-wide text-faint uppercase">{department}</h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {list.map((listing) => (
              <AgentCard key={listing.ref} listing={listing} slug={slug} owner={owner} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
