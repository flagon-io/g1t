/**
 * Product analytics (HeyCatch), on g1t.sh only: pageviews, clicks and
 * route changes, captured from the first page. Every event passes through
 * lib/analytics-scrub.ts first, so inside the app names, text and titles
 * never leave the browser, and recordings are never sent. A signed-in
 * person is known by their account id alone (`identify` below).
 *
 * Imported once, statically, by entry.client.tsx, so it runs before the
 * app does. A self-hosted g1t sends nothing.
 */
import { analytics } from "@heycatch/sdk";

import { scrubEvent } from "./analytics-scrub";

/** The one installation analytics runs on. */
const HOSTED = "g1t.sh";

const enabled = window.location.hostname === HOSTED;

if (enabled) {
  analytics.init({
    projectKey: "hck_pk_EsF6nrWNZ0tOM4cmDKA6tKBzdTr-GEW3",
    install: { framework: "react", frameworkVersion: "19", agent: "claude-code" },
    respectDnt: true,
    beforeSend: (event) => scrubEvent(event, window.location.pathname, window.location.origin),
  });
}

/** Who is signed in, by account id only; null after signing out. */
export function identify(userId: string | null, previous: string | null) {
  if (!enabled) return;
  if (userId) analytics.setIdentity(userId);
  else if (previous) analytics.resetIdentity();
}
