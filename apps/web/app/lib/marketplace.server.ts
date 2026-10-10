/**
 * What the Marketplace's pages read besides the layout's: what the
 * workspace has connected, and what this g1t can't connect, with why
 * (lib/connected.server.ts).
 */
import type { User } from "@g1t/contracts";

import type { ConnectedState } from "./connectors";
import { workspaceConnections } from "./connected.server";

export async function loadConnected(slug: string, viewer: User): Promise<{ connected: Record<string, ConnectedState>; unavailable: Record<string, string> }> {
  return workspaceConnections(slug, viewer);
}
