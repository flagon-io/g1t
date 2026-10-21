import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";

import { installResilientFetch } from "./lib/resilient-fetch";

// The router's reads outlast a moment offline (lib/resilient-fetch.ts).
installResilientFetch(import.meta.env.G1T_BUILD_ID);

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>,
    {
      // React recovers from a page the server rendered differently by
      // rendering it again here; say where, so it can be fixed.
      onRecoverableError(error, info) {
        console.error("g1t: recovered from", error, info.componentStack);
      },
    },
  );
});
