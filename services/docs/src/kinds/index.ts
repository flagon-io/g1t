/**
 * The kinds the room knows, one line each (docs/ARTIFACTS_MODE.md,
 * section 3). A kind without a line here can't be made yet: the service
 * says it is coming. Append only; never reformat (parallel phases each
 * add their line).
 */
import type { FolioKind } from "@g1t/contracts";

import { doc } from "./doc/index.ts";
import type { KindModel } from "./types.ts";

export const KINDS: Partial<Record<FolioKind, KindModel>> = {
  doc,
};

/** The kind's model, or null when it isn't built yet. */
export function kindModel(kind: string | null | undefined): KindModel | null {
  return (KINDS as Record<string, KindModel | undefined>)[String(kind ?? "")] ?? null;
}
