/**
 * Product analytics (HeyCatch), on g1t.sh only: pageviews, clicks and
 * route changes. Every event passes through lib/analytics-scrub.ts first,
 * so inside the app names, text and titles never leave the browser, and
 * recordings are never sent. A signed-in person is known by their account
 * id alone (`identify` below).
 *
 * The SDK is fetched once the page has loaded and the browser is idle, so
 * it never slows a page down; where a visitor is asked first
 * (lib/analytics-consent.ts) it is not fetched at all until they agree.
 * Imported by entry.client.tsx. A self-hosted g1t sends nothing.
 */
import type { analytics as Analytics } from "@heycatch/sdk";

import { allowed, analyticsHere, choice, consentRequired, onChoice } from "./analytics-consent";
import { scrubEvent } from "./analytics-scrub";

let sdk: Promise<typeof Analytics> | null = null;
/** Who is signed in, kept for when the SDK arrives. */
let signedIn: string | null = null;

function load(): Promise<typeof Analytics> {
  sdk ??= import("@heycatch/sdk").then(({ analytics }) => {
    analytics.init({
      projectKey: "hck_pk_EsF6nrWNZ0tOM4cmDKA6tKBzdTr-GEW3",
      install: { framework: "react", frameworkVersion: "19", agent: "claude-code" },
      respectDnt: true,
      beforeSend: (event) => scrubEvent(event, window.location.pathname, window.location.origin),
    });
    if (signedIn) analytics.setIdentity(signedIn);
    return analytics;
  });
  return sdk;
}

/** After the page has loaded, when the browser has a moment. */
function whenIdle(run: () => void) {
  // Safari has no requestIdleCallback.
  const idle = () => (typeof window.requestIdleCallback === "function" ? window.requestIdleCallback(run, { timeout: 4000 }) : setTimeout(run, 1500));
  if (document.readyState === "complete") idle();
  else window.addEventListener("load", idle, { once: true });
}

if (analyticsHere()) {
  if (allowed()) whenIdle(() => void load());
  // A choice made on the banner, or changed from the footer.
  onChoice(() => {
    if (!consentRequired()) return;
    if (choice() === "yes") void load().then((analytics) => analytics.optInCapturing());
    else if (sdk) void sdk.then((analytics) => analytics.optOutCapturing());
  });
}

/** Who is signed in, by account id only; null after signing out. */
export function identify(userId: string | null, previous: string | null) {
  signedIn = userId;
  if (!sdk) return;
  void sdk.then((analytics) => {
    if (userId) analytics.setIdentity(userId);
    else if (previous) analytics.resetIdentity();
  });
}
