import { redirect } from "react-router";

import { isAiProvider, type Provider, PROVIDERS } from "@g1t/contracts";
import { connectorsFor } from "@g1t/contracts/connectors";

import type { Route } from "./+types/integrations-directory";
import { ConnectorDirectory, ScopeNote } from "../../components/connectors";
import { connectedStates } from "../../lib/connected.server";
import { aiPagePath, providerPage } from "../../lib/integration-sections";
import { page } from "../../lib/meta";
import { requireUser, roleIn } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Integrations · ${params.owner} · g1t` });
}

/**
 * The workspace's integrations: every connector g1t has or will have, by
 * category, with what this workspace has connected first. Each one is set
 * up on its own page (the alerts and trackers pages, the GitHub import,
 * webhooks); this page only finds them. AI providers are not integrations:
 * they are the workspace's AI settings, at `-/ai`.
 */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  // Signed out, sign in first (as Chat and Docs do), rather than a 404.
  const viewer = requireUser(context, request);
  const role = roleIn(viewer, params.owner);
  if (!role || !viewer) throw new Response(null, { status: 404 });
  const slug = params.owner.toLowerCase();

  // An older link to one provider's form (`?add=sentry`): its own page
  // now, and the AI page for an AI provider (`?add=anthropic`).
  const add = new URL(request.url).searchParams.get("add");
  if (add && isAiProvider(add)) throw redirect(aiPagePath(slug, `?add=${add}`));
  if (add && add in PROVIDERS) throw redirect(`/${slug}/-/${providerPage(PROVIDERS[add as Provider].kind)}?add=${add}#add`);

  return { slug, owner: role === "owner", connected: await connectedStates(slug, viewer) };
}

export default function WorkspaceIntegrationsDirectory({ loaderData }: Route.ComponentProps) {
  const { slug, owner, connected } = loaderData;
  return (
    <div>
      <ScopeNote scope="workspace" workspace={slug} />
      <ConnectorDirectory scope="workspace" views={connectorsFor("workspace")} connected={connected} workspace={slug} canManage={owner} />
    </div>
  );
}
