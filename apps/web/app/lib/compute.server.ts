/**
 * The note shown before someone starts compute their workspace's plan would
 * refuse (`computeNote` in `@g1t/contracts` compute.ts). Members only: the
 * routes that call it decide who sees it.
 */
import { type ComputeKind, computeNote, readEntitlements } from "@g1t/contracts";

import { billing } from "./services.server";

/** Null when the plan would let it start, or billing cannot say. */
export async function computeNoteFor(workspace: string, kind: ComputeKind, isPublic = false): Promise<string | null> {
  const ent = readEntitlements(await billing.entitlements(workspace.toLowerCase()).catch(() => null));
  return ent ? computeNote(ent, kind, isPublic, workspace) : null;
}
