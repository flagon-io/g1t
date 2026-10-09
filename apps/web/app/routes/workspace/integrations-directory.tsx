import { redirect } from "react-router";

import { type Provider, PROVIDERS } from "@g1t/contracts";
import { CONNECTORS, connectorsFor } from "@g1t/contracts/connectors";

import type { Route } from "./+types/integrations-directory";
import { ConnectorDirectory, ScopeNote } from "../../components/connectors";
import type { ConnectedState } from "../../lib/connectors";
import { githubApp } from "../../lib/github.server";
import { integrationsSection } from "../../lib/integration-sections";
import { page } from "../../lib/meta";
import { integrations, webhooks } from "../../lib/services.server";
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

  const [connections, github, hooks] = await Promise.all([
    integrations.list(slug, viewer),
    githubApp.status(viewer, slug).catch(() => null),
    webhooks.list(viewer, { workspace: slug }).catch(() => null),
  ]);

  const connected: Record<string, ConnectedState> = {};
  if (connections.ok) {
    for (const connector of CONNECTORS) {
      if (!connector.provider) continue;
      const mine = connections.value.filter((connection) => connection.provider === connector.provider);
      if (mine.length === 0) continue;
      const broken = mine.find((connection) => connection.lastError);
      connected[connector.id] = {
        detail: mine.length === 1 ? mine[0]!.name : `${mine.length} connections: ${mine.map((c) => c.name).join(", ")}`,
        problem: broken ? `${broken.name}: ${broken.lastError}` : null,
        manage: `/${slug}/-/integrations/${integrationsSection(PROVIDERS[connector.provider].kind)}`,
      };
    }
  }
  if (github?.ok && github.value.installations.length > 0) {
    const suspended = github.value.installations.find((installation) => installation.suspended);
    connected.github = {
      detail: `On ${github.value.installations.map((installation) => installation.account).join(", ")}`,
      problem: suspended ? `The installation on ${suspended.account} is suspended on GitHub.` : null,
      manage: null,
    };
  }
  const ours = hooks?.ok ? hooks.value.filter((hook) => hook.scope === "workspace") : [];
  if (ours.length > 0) {
    const failing = ours.filter((hook) => hook.lastStatus === "failed");
    connected.webhooks = {
      detail: ours.length === 1 ? ours[0]!.url : `${ours.length} webhooks`,
      problem: failing.length > 0 ? `The last delivery to ${failing[0]!.url} failed.` : null,
      manage: null,
    };
  }

  return { slug, owner: role === "owner", connected };
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
