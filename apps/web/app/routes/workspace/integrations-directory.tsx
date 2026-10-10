import { redirect } from "react-router";

import { type Provider, PROVIDERS } from "@g1t/contracts";
import { connectorsFor } from "@g1t/contracts/connectors";

import type { Route } from "./+types/integrations-directory";
import { ConnectorDirectory, ScopeNote } from "../../components/connectors";
import { connectedStates } from "../../lib/connected.server";
import { integrationsSection } from "../../lib/integration-sections";
import { page } from "../../lib/meta";
import { requireUser, roleIn } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Integrations · ${params.owner} · g1t` });
}

/**
 * The workspace's integrations: every connector g1t has or will have, by
 * category, with what this workspace has connected first. Each one is set
 * up on its own page (the model providers, alerts and trackers pages, the
 * GitHub import, webhooks); this page only finds them.
 */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  // Signed out, sign in first (as Chat and Docs do), rather than a 404.
  const viewer = requireUser(context, request);
  const role = roleIn(viewer, params.owner);
  if (!role || !viewer) throw new Response(null, { status: 404 });
  const slug = params.owner.toLowerCase();

  // An older link to one provider's form (`?add=sentry`): its own page now.
  const add = new URL(request.url).searchParams.get("add");
  if (add && add in PROVIDERS) {
    throw redirect(`/${slug}/-/integrations/${integrationsSection(PROVIDERS[add as Provider].kind)}?add=${add}#add`);
  }

  return { slug, owner: role === "owner", connected: await connectedStates(slug, viewer) };
}

export default function WorkspaceIntegrationsDirectory({ loaderData }: Route.ComponentProps) {
  const { slug, owner, connected } = loaderData;
  return (
    <div>
      <ScopeNote scope="workspace" workspace={slug} />
      <ConnectorDirectory
        scope="workspace"
        views={connectorsFor("workspace")}
        connected={connected}
        workspace={slug}
        canManage={owner}
      />
    </div>
  );
}
