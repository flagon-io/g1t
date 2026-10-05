import { data } from "react-router";

import type { MissingKind } from "./not-found";

/**
 * The 404 a loader throws when the viewer cannot see what the address
 * names. It carries only the kind of thing, never whether it exists, and is
 * thrown the same way for something private and something missing.
 */
export function notFound(kind: MissingKind) {
  return data({ kind }, { status: 404 });
}
