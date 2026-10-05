import type { ServiceBinding } from "@g1t/contracts";

declare global {
  namespace Cloudflare {
    interface Env {
      BILLING: ServiceBinding;
      ASSETS: Fetcher;
      ACCESS_TEAM_DOMAIN: string;
      ACCESS_AUD: string;
      STAFF_EMAILS: string;
    }
  }
  interface Env extends Cloudflare.Env {}
}
