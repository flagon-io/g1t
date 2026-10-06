import type { RunnerApi, ServiceBinding } from "@g1t/contracts";

declare global {
  namespace Cloudflare {
    interface Env {
      IDENTITY: ServiceBinding;
      /** Also serves git over HTTPS through `fetch`. */
      REPOS: ServiceBinding & { fetch(request: Request): Promise<Response> };
      WORK: ServiceBinding;
      RUNNER: RunnerApi;
      BILLING: ServiceBinding;
      EVENTS: ServiceBinding;
      INTEGRATIONS: ServiceBinding;
      WEBHOOKS: ServiceBinding;
      ACTIONS: ServiceBinding;
      DEPLOYMENTS: ServiceBinding;
      PROJECTS: ServiceBinding;
      SECURITY: ServiceBinding;
      /** The context hub: catalog, search and scorecards. */
      CONTEXT: ServiceBinding;
      /** Search across all of g1t, and Explore. */
      SEARCH: ServiceBinding;
      /** Production screenshots, from the og service's `Screenshots` entrypoint. */
      SCREENSHOTS?: {
        image(input: { host: string; commit: string }): Promise<{
          body: ArrayBuffer;
          contentType: string;
          commit: string;
          capturedAt: string;
        } | null>;
      };
      BLOBS: KVNamespace;
      /** Uploaded avatars by SHA-256, with `{ contentType }`; written by identity. */
      AVATARS: KVNamespace;
    }
  }
  interface Env extends Cloudflare.Env {}
}
