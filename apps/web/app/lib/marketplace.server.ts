/**
 * What the Marketplace's pages read besides the layout's: what the
 * workspace has connected (lib/connected.server.ts).
 */
import type { User } from "@g1t/contracts";

import type { ConnectedState } from "./connectors";
import { connectedStates } from "./connected.server";

export async function loadConnected(slug: string, viewer: User): Promise<Record<string, ConnectedState>> {
  return connectedStates(slug, viewer);
}
