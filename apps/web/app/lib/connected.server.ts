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
import { githubApp } from "./github.server";
import { integrationsSection } from "./integration-sections";
import { integrations, webhooks } from "./services.server";

/** What the workspace `slug` has connected, as `viewer` may see it. Each source that does not answer counts as nothing connected. */
export async function connectedStates(slug: string, viewer: User): Promise<Record<string, ConnectedState>> {
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
  return connected;
}
