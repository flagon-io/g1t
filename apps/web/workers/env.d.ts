import type { RunnerApi, ServiceBinding } from "@g1t/contracts";

declare global {
  namespace Cloudflare {
    interface Env {
      IDENTITY: ServiceBinding;
      /** Also serves git over HTTPS through `fetch`. */
      REPOS: ServiceBinding & { fetch(request: Request): Promise<Response> };
      /** Also serves the container registry (`/v2/`) through `fetch`. */
      PACKAGES: ServiceBinding & { fetch(request: Request): Promise<Response> };
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
        image(input: { host: string; commit: string; since?: string }): Promise<{
          body: ArrayBuffer;
          contentType: string;
          commit: string;
          capturedAt: string;
        } | null>;
      };
      BLOBS: KVNamespace;
      /** Uploaded avatars by SHA-256, with `{ contentType }`; written by identity. */
      AVATARS: KVNamespace;
      /** The self-hosted runner's releases (scripts/runner-release.mjs). Absent when self-hosted. */
      DOWNLOADS?: R2Bucket;
      /** The site's own origin. Unset on g1t.sh, which is https://g1t.sh (app/lib/addresses.server.ts). */
      SITE_URL?: string;
      /** The REST API's origin, which is also the OAuth issuer. Unset on g1t.sh. */
      API_URL?: string;
      /** The MCP server's URL, as agents are told to add it. Unset on g1t.sh. */
      MCP_URL?: string;
      /** The social-card image service; an empty string for none. Unset on g1t.sh. */
      OG_URL?: string;
      /**
       * Where repository files and avatars are served (app/lib/usercontent.ts).
       * Unset on g1t.sh, which is https://g1tusercontent.com; unset on another
       * site, `<SITE_URL>/-/usercontent`.
       */
      USERCONTENT_URL?: string;
      /** Signs the short-lived addresses of private repositories' files. A secret. */
      USERCONTENT_KEY?: string;
    }
  }
  interface Env extends Cloudflare.Env {}
}
