import type { ServiceBinding } from "@g1t/contracts";

declare global {
  namespace Cloudflare {
    interface Env {
      BILLING: ServiceBinding;
      IDENTITY: ServiceBinding;
      EVENTS: ServiceBinding;
      /** apps/status's `StatusAdmin` entrypoint: see `StatusAdminApi`. */
      STATUS: Fetcher;
      /** services/models's `Discovery` entrypoint: see `ModelDiscoveryApi`. */
      MODELS: Fetcher;
      ASSETS: Fetcher;
      ACCESS_TEAM_DOMAIN: string;
      ACCESS_AUD: string;
      STAFF_EMAILS: string;
    }
  }
  interface Env extends Cloudflare.Env {}
}
