import type { ServiceBinding } from "@g1t/contracts";

declare global {
  namespace Cloudflare {
    interface Env {
      BILLING: ServiceBinding;
      IDENTITY: ServiceBinding;
      EVENTS: ServiceBinding;
      /** Actions: a workspace's self-hosted runners (admin_runners, admin_remove_runners). */
      ACTIONS: ServiceBinding;
      /** Projects: a workspace's projects, read as the workspace. */
      PROJECTS: ServiceBinding;
      /** Telemetry: projects' ingest tokens, to see and revoke. */
      TELEMETRY: ServiceBinding;
      /** apps/status's `StatusAdmin` entrypoint: see `StatusAdminApi`. */
      STATUS: Fetcher;
      /** services/models's `Discovery` entrypoint: see `ModelDiscoveryApi`. */
      MODELS: Fetcher;
      ASSETS: Fetcher;
      ACCESS_TEAM_DOMAIN: string;
      ACCESS_AUD: string;
      STAFF_EMAILS: string;
      STAFF_SERVICE_TOKENS?: string;
    }
  }
  interface Env extends Cloudflare.Env {}
}
