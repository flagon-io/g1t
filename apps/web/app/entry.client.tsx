import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";

// Product analytics, started before the app (lib/analytics.client.ts).
import "./lib/analytics.client";

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
