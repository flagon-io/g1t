/**
 * What a workspace has connected, by connector id (@g1t/contracts/connectors):
 * its provider connections from the integrations service, the GitHub App's
 * installations and its own webhooks, each with how it is doing. The
 * Integrations directory and the Marketplace both read it.
 */
import type { User } from "@g1t/contracts";
import { PROVIDERS } from "@g1t/contracts";
import { CONNECTORS } from "@g1t/contracts/connectors";

import type { ConnectedState } from "./connectors";
import { githubConnected } from "./github";
import { githubApp } from "./github.server";
import { integrationsSection } from "./integration-sections";
import { integrations, webhooks } from "./services.server";

/** What the workspace `slug` has connected, as `viewer` may see it. Each source that does not answer counts as nothing connected. */
export async function connectedStates(slug: string, viewer: User): Promise<Record<string, ConnectedState>> {
  return (await workspaceConnections(slug, viewer)).connected;
}

/**
 * What the workspace `slug` has connected, and the connectors this g1t
 * can't connect at all, by id, each with why: GitHub when no GitHub App is
 * set up (as on a self-hosted g1t that hasn't added one).
 */
export async function workspaceConnections(slug: string, viewer: User): Promise<{ connected: Record<string, ConnectedState>; unavailable: Record<string, string> }> {
  const [connections, github, hooks] = await Promise.all([
    integrations.list(slug, viewer).catch(() => null),
    githubApp.status(viewer, slug).catch(() => null),
    webhooks.list(viewer, { workspace: slug }).catch(() => null),
  ]);

  const connected: Record<string, ConnectedState> = {};
  if (connections?.ok) {
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
  const fromGithub = github?.ok ? githubConnected(github.value.installations) : null;
  if (fromGithub) connected.github = fromGithub;
  const ours = hooks?.ok ? hooks.value.filter((hook) => hook.scope === "workspace") : [];
  if (ours.length > 0) {
    const failing = ours.filter((hook) => hook.lastStatus === "failed");
    connected.webhooks = {
      detail: ours.length === 1 ? ours[0]!.url : `${ours.length} webhooks`,
      problem: failing.length > 0 ? `The last delivery to ${failing[0]!.url} failed.` : null,
      manage: null,
    };
  }
  const unavailable: Record<string, string> = {};
  if (github?.ok && !github.value.configured) unavailable.github = "This g1t has no GitHub App set up. Whoever runs it adds one first.";
  return { connected, unavailable };
}
