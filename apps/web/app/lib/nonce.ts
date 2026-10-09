import { createContext, useContext } from "react";

/**
 * The nonce the page's inline scripts carry, which its Content-Security-Policy
 * names (lib/page-headers.ts). Given by entry.server.tsx; in the browser
 * there is none, and none is needed: the scripts have already run.
 */
export const NonceContext = createContext<string | undefined>(undefined);

export function useNonce(): string | undefined {
  return useContext(NonceContext);
}
