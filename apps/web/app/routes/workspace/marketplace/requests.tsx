/**
 * Install requests: for an owner, everything members asked the workspace
 * to add, with the way to add it, mark it added or turn it down; for
 * anyone else, their own and how each was answered. Every Marketplace form
 * posts here: asking, answering, and installing, switching off or removing
 * an extension.
 */
import { Link, data } from "react-router";

import { connectorsFor } from "@g1t/contracts/connectors";

import type { Route } from "./+types/requests";
import { RequestRow, SectionHead } from "../../../components/marketplace";
import { EmptyState } from "../../../components/ui";
import { addPath, marketplaceForm, marketplacePath, openRequests } from "../../../lib/marketplace";
import { workspaceAgents } from "../../../lib/services.server";
import { assertSameOrigin, requireUser, roleIn } from "../../../lib/session.server";
import { useMarketplace } from "./layout";

export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  if (!roleIn(viewer, slug)) throw data(null, { status: 404 });
  const asked = marketplaceForm(await request.formData());
  if (!asked) return data({ error: "Nothing to do." }, { status: 400 });
  const call = (): Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }> => {
    switch (asked.intent) {
      case "request":
        return workspaceAgents.requestInstall(slug, viewer, asked.listing, asked.note);
      case "resolve":
        return workspaceAgents.resolveInstallRequest(slug, viewer, asked.id, asked.status);
      case "install":
        return workspaceAgents.installExtension(slug, viewer, asked.extension);
      case "switch":
        return workspaceAgents.setExtensionEnabled(slug, viewer, asked.listing, asked.enabled);
      case "uninstall":
        return workspaceAgents.uninstallExtension(slug, viewer, asked.listing);
    }
  };
  const result = await call().catch(() => null);
  if (!result) return data({ error: "The request didn't go through. Try again in a moment." }, { status: 503 });
  if (!result.ok) return data({ error: result.error.message }, { status: result.error.code === "conflict" ? 409 : 422 });
  return { error: null };
}

export default function MarketplaceRequests() {
  const { slug, owner, requests } = useMarketplace();
  if (!requests) {
    return <EmptyState title="Requests can't be shown right now">The agents service didn't answer. Reload in a minute.</EmptyState>;
  }
  const views = connectorsFor("workspace");
  const waiting = openRequests(requests.requests);
  const answered = requests.requests.filter((request) => request.status !== "open");
  if (requests.requests.length === 0) {
    return owner ? (
      <EmptyState title="No requests">When a member asks for an extension or an integration, it shows here, and you're notified.</EmptyState>
    ) : (
      <EmptyState title="You haven't asked for anything">
        Find an extension or an integration and choose <b>Request</b>. The workspace's owners are notified, and you hear back when one answers.
      </EmptyState>
    );
  }
  return (
    <div className="space-y-10">
      <section aria-labelledby="waiting">
        <SectionHead id="waiting" title={owner ? "Waiting on an owner" : "Waiting"} aside={`${waiting.length}`}>
          {owner
            ? "Installing an extension answers every request for it. After connecting an integration, mark its requests added."
            : "Your requests the workspace's owners haven't answered yet."}
        </SectionHead>
        {waiting.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">Nothing is waiting.</p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {waiting.map((request) => (
              <RequestRow key={request.id} request={request} slug={slug} owner={owner} addTo={owner ? addPath(request, slug, views) : null} />
            ))}
          </ul>
        )}
      </section>
      {answered.length > 0 && (
        <section aria-labelledby="answered">
          <SectionHead id="answered" title="Answered" aside="Last 30 days" />
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {answered.map((request) => (
              <RequestRow key={request.id} request={request} slug={slug} owner={owner} addTo={null} />
            ))}
          </ul>
        </section>
      )}
      {!owner && (
        <p className="text-sm text-muted">
          Looking for something else? <Link to={marketplacePath(slug)} className="text-accent hover:underline">Browse the Marketplace</Link>.
        </p>
      )}
    </div>
  );
}
